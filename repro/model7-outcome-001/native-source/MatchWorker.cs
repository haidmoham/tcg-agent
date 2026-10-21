using System.Security.Cryptography;
using System.Text;
using MatchLogic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private readonly Bundle bundle;
    private MatchOperation? authority;
    private string? epoch;
    private string? matchId;
    private int revision;
    private JObject? frame;
    private readonly Dictionary<string, OfferedAction> actions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, OfferedChoice> choices = new(StringComparer.Ordinal);
    private readonly Dictionary<string, SettledCommand> commands = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> seatAccounts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> seatNames = new(StringComparer.Ordinal);
    private bool failed;

    internal bool IsStopped { get; private set; }

    internal MatchWorker(string bundleDirectory, string manifestHash)
    {
        FreezeOfflineClock();
        bundle = new Bundle(bundleDirectory, manifestHash);
        RainierServiceLogger.InitImmediateLogging((_, _) => { });
    }

    internal JToken Dispatch(string incomingEpoch, string incomingMatch, string? method, JToken? payload)
    {
        if (IsStopped) throw new InvalidOperationException("worker stopped");
        if (method == "create") return Create(incomingEpoch, incomingMatch, RequireObject(payload));
        if (epoch != incomingEpoch || matchId != incomingMatch || authority == null)
            throw new InvalidOperationException("worker identity mismatch");
        return method switch
        {
            "audit" => OfflineAudit(RequireObject(payload)),
            "audit-preflight" => OfflineTurnStatistics(),
            "audit-use" => OfflineUseAudit(RequireObject(payload)),
            "audit-privacy" => OfflinePrivacyProbe(RequireObject(payload)),
            "offline-batch" => OfflineBatch(RequireObject(payload)),
            "view" => View(RequireObject(payload)),
            "command" => Command(RequireObject(payload)),
            "preview" => Preview(RequireObject(payload)),
            "abort" => Abort(RequireObject(payload)),
            _ => throw new InvalidDataException("unknown worker method"),
        };
    }

    private JObject Create(string incomingEpoch, string incomingMatch, JObject input)
    {
        ConfigureOffline(input);
        if (authority != null || epoch != null) throw new InvalidOperationException("worker already has a match");
        var identity = RequireObject(input["bundle"]);
        if (identity.Value<string>("id") != bundle.Id ||
            !HashEquals(identity.Value<string>("cardsHash"), bundle.CardsHash) ||
            !HashEquals(identity.Value<string>("rulesHash"), bundle.RulesHash) ||
            !HashEquals(identity.Value<string>("runtimeHash"), bundle.RuntimeHash))
            throw new InvalidDataException("requested bundle identity mismatch");
        var seats = RequireObject(input["seats"]);
        var human = RequireObject(seats["human"]);
        var opponent = RequireObject(seats["opponent"]);
        string[] Cards(JObject seat)
        {
            var cards = ((JArray?)seat["cards"] ?? throw new InvalidDataException("deck missing"))
                .Values<string>().ToArray();
            if (cards.Length != 60 || cards.Any(card => card == null || !bundle.Programs.Cards.Any(source => source.cardSourceID == card)))
                throw new InvalidDataException("deck does not belong to selected program package");
            return cards!;
        }
        foreach (var (name, seat) in new[] { ("human", human), ("opponent", opponent) })
        {
            seatAccounts[name] = RequiredString(seat, "accountId");
            seatNames[name] = RequiredString(seat, "name");
        }
        if (seatAccounts["human"] == seatAccounts["opponent"])
            throw new InvalidDataException("seats must have distinct accounts");
        var p1 = Cards(human); var p2 = Cards(opponent);
        epoch = incomingEpoch; matchId = incomingMatch;
        authority = new MatchOperation(incomingMatch, GameMode.Standard, GameplayType.Offline,
            seatAccounts["human"], seatNames["human"], p1, 1200, false, false, false,
            seatAccounts["opponent"], seatNames["opponent"], p2, 1200, false, false, false,
            // The captured Standard programs and printing joins are an immutable
            // 2026-10-11 bundle. Wall time must not silently change its legality.
            new DateBasedVersion(new DateTime(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc)), randomSeedGenerator: offlineRng);
        authority.workingBoard.RebuildEntityList();
        RegisterOfflineIdentities();
        AdvanceCanonical();
        RebuildFrame();
        return (JObject)frame!.DeepClone();
    }

    private JObject View(JObject input)
    {
        var seat = Seat(input, "seat");
        return (JObject)frame!["views"]![seat]!.DeepClone();
    }

    private JObject Command(JObject input)
    {
        var seat = Seat(input, "seat");
        var command = RequireObject(input["command"]);
        var commandId = RequiredString(command, "commandId");
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            new JObject { ["seat"] = seat, ["command"] = command.DeepClone() }.ToString(Formatting.None))));
        if (commands.TryGetValue(commandId, out var previous))
        {
            if (previous.Fingerprint != fingerprint) return Reject(commandId, seat, "command id was already used");
            return (JObject)previous.Reply.DeepClone();
        }
        if (failed) return Reject(commandId, seat, "match engine failed", fingerprint);
        if (command.Value<int?>("expectedRevision") != revision)
            return Reject(commandId, seat, "match view is out of date", fingerprint);
        if (authority!.workingBoard.isGameOver) return Reject(commandId, seat, "match is finished", fingerprint);
        var actionId = command.Value<string>("actionId");
        var promptId = command.Value<string>("promptId");
        if ((actionId == null) == (promptId == null))
            return Reject(commandId, seat, "choose one action or prompt", fingerprint);
        PlayerOperation? nativeAction = null;
        PlayerSelection? answer = null;
        var previousFrame = (JObject)frame!.DeepClone();
        JObject? acceptedOffer = null;
        var acceptedTrainerUse = false;
        if (actionId != null)
        {
            if (authority.status != OperationStatus.Finished || !actions.TryGetValue(actionId, out var offer)
                || offer.Seat != seat || offer.Revision != revision)
                return Reject(commandId, seat, "action is no longer offered", fingerprint);
            nativeAction = offer.Operation;
            if (!CanPerform(nativeAction)) return Reject(commandId, seat, "action is no longer legal", fingerprint);
            acceptedOffer = ((JArray)previousFrame["views"]![seat]!["actions"]!).Children<JObject>()
                .FirstOrDefault(action => action.Value<string>("id") == actionId);
            acceptedTrainerUse = nativeAction.operationType == OperationType.Use &&
                acceptedOffer?.Value<string>("kind") == "play" &&
                !string.IsNullOrEmpty(acceptedOffer.Value<string>("actionKey")) &&
                ((JArray)previousFrame["views"]![seat]!["hand"]!).Children<JObject>()
                    .Any(card => card.Value<string>("instanceId") == acceptedOffer.Value<string>("sourceCardId") &&
                        card.Value<string>("category") == "trainer");
        }
        else
        {
            var validation = ValidateSelection(seat, command, promptId!);
            if (!validation.Valid) return Reject(commandId, seat, validation.Reason, fingerprint);
            answer = validation.Answer;
        }
        try
        {
            if (nativeAction != null)
            {
                // A completed native operation may start the next one. A waiting
                // operation must instead retain its live queue and parent links.
                authority = new MatchOperation(nativeAction, authority, randomSeedGenerator: offlineRng);
                AdvanceCanonical();
            }
            else
            {
                authority.UpdateSelectionAndMarkComplete(answer!);
                authority.Handle();
                if (authority.status == OperationStatus.Error)
                    throw new InvalidOperationException("native selection resolution failed");
            }
            revision++;
            RebuildFrame();
            try
            {
                if (!offlineBenchmarkMode) RecordPresentation(commandId, previousFrame, seat, acceptedOffer, acceptedTrainerUse,
                    nativeAction?.operationType == OperationType.Evolve);
            }
            catch (Exception)
            {
                // Presentation is optional. A supported move must remain accepted
                // even if a native modification cannot be classified safely.
            }
            var reply = new JObject
            {
                ["receipt"] = new JObject { ["status"] = "accepted", ["commandId"] = commandId,
                    ["view"] = frame!["views"]![seat]!.DeepClone() },
                ["frame"] = frame!.DeepClone(),
            };
            commands.Add(commandId, new SettledCommand(fingerprint, (JObject)reply.DeepClone()));
            return reply;
        }
        catch (Exception error)
        {
            failed = true;
            Console.Error.WriteLine("native match failure: " + error);
            // The state may have mutated. Never represent this as a harmless
            // prevalidation rejection or offer a rollback from a disposable copy.
            revision++;
            actions.Clear(); choices.Clear();
            frame = FailureFrame();
            var reply = new JObject
            {
                ["receipt"] = new JObject { ["status"] = "rejected", ["commandId"] = commandId,
                    ["reason"] = "match engine failed", ["view"] = frame["views"]![seat]!.DeepClone() },
                ["frame"] = frame.DeepClone(),
            };
            commands.Add(commandId, new SettledCommand(fingerprint, (JObject)reply.DeepClone()));
            return reply;
        }
    }

    private JObject Reject(string commandId, string seat, string reason, string? fingerprint = null)
    {
        var reply = new JObject
        {
            ["receipt"] = new JObject { ["status"] = "rejected", ["commandId"] = commandId,
                ["reason"] = reason, ["view"] = frame!["views"]![seat]!.DeepClone() },
            ["frame"] = frame!.DeepClone(),
        };
        if (fingerprint != null) commands.Add(commandId, new SettledCommand(fingerprint, (JObject)reply.DeepClone()));
        return reply;
    }

    private JObject Preview(JObject input)
    {
        var seat = Seat(input, "seat");
        var request = RequireObject(input["selection"]);
        var promptId = RequiredString(request, "promptId");
        var requestId = RequiredString(request, "requestId");
        var result = request.Value<int?>("expectedRevision") == revision && !failed
            ? ValidateSelection(seat, request, promptId)
            : new SelectionValidation(false, "match view is out of date", null);
        var response = new JObject
        {
            ["requestId"] = requestId, ["matchId"] = matchId, ["revision"] = revision,
            ["promptId"] = promptId, ["valid"] = result.Valid,
        };
        if (!result.Valid) response["reason"] = result.Reason;
        return response;
    }

    private JObject Abort(JObject input)
    {
        _ = RequiredString(input, "commandId");
        if (input.Value<int?>("expectedRevision") != revision)
            throw new InvalidDataException("abort revision mismatch");
        IsStopped = true;
        return new JObject { ["stopped"] = true };
    }

    private void AdvanceCanonical()
    {
        authority!.QueuePlayerOperation();
        if (authority.status == OperationStatus.Error)
            throw new InvalidOperationException("native operation queue failed");
        authority.Handle();
        if (authority.status == OperationStatus.Error)
            throw new InvalidOperationException("native operation failed");
    }

    private bool NativeCanPerform(PlayerOperation operation)
    {
        var copy = OfflineReadCopy();
        copy.workingBoard.RebuildEntityList();
        copy.SetPlayerOperation(operation);
        return copy.CanPerformOperation();
    }

    private static string Seat(JObject input, string key)
    {
        var value = RequiredString(input, key);
        if (value is not ("human" or "opponent")) throw new InvalidDataException("unknown seat");
        return value;
    }

    private static string RequiredString(JObject input, string key) =>
        input.Value<string>(key) is { Length: > 0 } value ? value : throw new InvalidDataException(key + " missing");
    private static JObject RequireObject(JToken? value) => value as JObject ?? throw new InvalidDataException("object required");
    private static bool HashEquals(string? a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    private sealed record OfferedAction(string Seat, int Revision, PlayerOperation Operation);
    private sealed record OfferedChoice(string Id, string Seat, int Revision, string PromptId, int Group, int Index,
        string NativeIdentity, string? NativeTargetId);
    private sealed record SettledCommand(string Fingerprint, JObject Reply);
    private sealed record SelectionValidation(bool Valid, string Reason, PlayerSelection? Answer);
}
