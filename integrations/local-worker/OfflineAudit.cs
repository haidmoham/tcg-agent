using System.Reflection;
using System.Diagnostics.CodeAnalysis;
using System.Diagnostics;
using MatchLogic;
using MatchLogic.Utils;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using TimeProvider.source;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private OfflineSeeds? offlineRng;
    private readonly OfflineReadSeeds offlineReadRng = new();
    private readonly Dictionary<string, int> offlineIdentities = new(StringComparer.Ordinal);
    private MatchOperation? offlineProjectionRead;
    private bool offlineBenchmarkMode;
    private long offlineCopyCalls;
    private double offlineCopyMilliseconds;

    private void BeginOfflineProjection() => offlineProjectionRead = null;

    private void RegisterOfflineIdentities()
    {
        foreach (var entity in authority!.workingBoard.AllEntityList())
            offlineIdentities.TryAdd(entity.entityID, offlineIdentities.Count);
    }

    private int OfflineIdentityOrder(string? id) => id != null && offlineIdentities.TryGetValue(id, out var order) ? order : int.MaxValue;

    private List<MatchAction> OfflineUseActions(CardEntity card)
    {
        var read = offlineProjectionRead ??= OfflineReadCopy();
        read.workingBoard.RebuildEntityList();
        var detached = read.workingBoard.GetEntityByID(card.entityID) as CardEntity;
        return detached?.GetUseActions(new StateInformation(read, null, null)) ?? [];
    }

    private IEnumerable<CardEntity> OfflineExtraOrigins(string seat)
    {
        var board = authority!.workingBoard;
        var one = seat == "human";
        var primary = (one ? board.p1Hand : board.p2Hand)
            .Concat(one ? board.p1Bench : board.p2Bench)
            .Append(one ? board.p1Active : board.p2Active).Where(card => card != null)
            .Select(card => card!.entityID).ToHashSet(StringComparer.Ordinal);
        var all = one ? board.GetPlayer1ActiveCards() : board.GetPlayer2ActiveCards();
        if (board.stadium != null) all.Add(board.stadium);
        return all.Where(card => !primary.Contains(card.entityID)).DistinctBy(card => card.entityID);
    }

    private static void FreezeOfflineClock()
    {
        var instant = new DateTime(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc);
        DateTimeProvider.Implementation = new CustomTimeProvider(instant, instant, true);
    }

    private void ConfigureOffline(JObject input)
    {
        if (offlineRng != null) throw new InvalidOperationException("offline seed already configured");
        var options = input["offline"] as JObject ?? throw new InvalidDataException("explicit offline seed required");
        var seed = options.Value<long?>("seed");
        if (seed is null or < 0 or > uint.MaxValue) throw new InvalidDataException("uint32 offline seed required");
        offlineRng = new OfflineSeeds((uint)seed.Value);
    }

    [MemberNotNull(nameof(authority))]
    private MatchOperation OfflineReadCopy()
    {
        if (authority == null) throw new InvalidOperationException("offline authority missing");
        var started = Stopwatch.GetTimestamp();
        var copy = authority.CopyOperation();
        typeof(MatchOperation).GetField("_randomSeedGenerator", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(copy, offlineReadRng);
        offlineCopyCalls++;
        offlineCopyMilliseconds += Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        return copy;
    }

    private JObject OfflineAudit(JObject input)
    {
        if (offlineRng == null) throw new InvalidOperationException("offline RNG missing");
        return new JObject
        {
            ["schema"] = "indigo-offline-audit/1", ["revision"] = revision,
            ["rngVersion"] = "counter-mix32/1", ["seed"] = offlineRng.Seed,
            ["emittedSeeds"] = new JArray(offlineRng.Emitted),
            ["readChanceAttempts"] = offlineReadRng.Attempts,
            ["fixedClock"] = "2026-10-11T00:00:00Z",
            ["authority"] = JToken.Parse(JsonConvert.SerializeObject(authority, SerializeResolver.settings)),
        };
    }

    private JObject OfflineUseAudit(JObject input)
    {
        if (authority!.status != OperationStatus.Finished)
            return new JObject { ["checked"] = false, ["reason"] = "pending native decision" };
        var read = OfflineReadCopy();
        read.workingBoard.RebuildEntityList();
        var state = new StateInformation(read, null, null);
        var expected = new HashSet<string>(StringComparer.Ordinal);
        var tested = 0;
        foreach (var card in read.workingBoard.AllEntityList().OfType<CardEntity>())
        foreach (var action in card.GetUseActions(state))
        foreach (var seat in new[] { "human", "opponent" })
        {
            if (card.ownerPlayerId != seatAccounts[seat] && card != read.workingBoard.stadium) continue;
            tested++;
            var operation = new PlayerOperation(OperationType.Use, matchId!, card.entityID,
                action.actionGuid, "", BoardPos.Board, seatAccounts[seat]);
            if (CanPerform(operation)) expected.Add(seat + "/" + card.entityID + "/" + action.actionGuid);
        }
        var offered = actions.Values.Where(value => value.Operation.operationType == OperationType.Use)
            .Select(value => value.Seat + "/" + value.Operation.originEntityID + "/" + value.Operation.actionGuid).ToHashSet(StringComparer.Ordinal);
        return new JObject
        {
            ["checked"] = true, ["tested"] = tested, ["legal"] = expected.Count, ["offered"] = offered.Count,
            ["missing"] = new JArray(expected.Except(offered).Order()),
            ["extra"] = new JArray(offered.Except(expected).Order()),
        };
    }

    private JObject OfflineBatch(JObject input)
    {
        var rows = input["commands"] as JArray ?? throw new InvalidDataException("offline commands required");
        if (rows.Count is < 1 or > 2000 || revision != 0) throw new InvalidDataException("bounded fresh offline batch required");
        offlineBenchmarkMode = true;
        var started = Stopwatch.GetTimestamp();
        var count = 0;
        foreach (var row in rows.Children<JObject>())
        {
            if (Terminal() != null) throw new InvalidDataException("unused commands after terminal");
            var seat = Seat(row, "seat");
            var decision = RequireObject(row["decision"]);
            var view = RequireObject(frame!["views"]![seat]);
            var command = new JObject { ["commandId"] = "offline-batch-" + count, ["expectedRevision"] = revision };
            int Index(string? token, string prefix, int length)
            {
                if (token == null || !token.StartsWith(prefix, StringComparison.Ordinal)
                    || !int.TryParse(token.AsSpan(prefix.Length), out var index) || index < 0 || index >= length
                    || token != prefix + index) throw new InvalidDataException("stale or foreign offline token");
                return index;
            }
            if (decision.Value<string>("actionId") is { } actionId)
            {
                var offered = (JArray)view["actions"]!;
                command["actionId"] = offered[Index(actionId, $"r{revision}/action/", offered.Count)]!["id"]!.DeepClone();
            }
            else
            {
                var prompts = (JArray)view["prompts"]!;
                var promptToken = decision.Value<string>("promptId");
                var prompt = (JObject)prompts[Index(promptToken, $"r{revision}/prompt/", prompts.Count)]!;
                var choices = (JArray)prompt["choices"]!;
                string Choice(string? token) => choices[Index(token, promptToken + "/choice/", choices.Count)]!.Value<string>("id")!;
                command["promptId"] = prompt["id"]!.DeepClone();
                command["choiceIds"] = new JArray(((JArray?)decision["choiceIds"] ?? []).Values<string>().Select(Choice));
                if (decision["amounts"] is JArray amounts)
                    command["amounts"] = new JArray(amounts.Children<JObject>().Select(amount => new JObject
                    { ["choiceId"] = Choice(amount.Value<string>("choiceId")), ["count"] = amount["count"]!.DeepClone() }));
                if (decision["cancel"] != null) command["cancel"] = decision["cancel"]!.DeepClone();
            }
            var reply = Command(new JObject { ["seat"] = seat, ["command"] = command });
            if (reply["receipt"]?.Value<string>("status") != "accepted") throw new InvalidDataException("offline batch command rejected");
            count++;
        }
        return new JObject
        {
            ["commands"] = count, ["revision"] = revision, ["terminal"] = Terminal(),
            ["nativeSeedCalls"] = offlineRng!.Emitted.Count,
            ["batchMilliseconds"] = Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            ["readCopyCalls"] = offlineCopyCalls, ["readCopyMilliseconds"] = offlineCopyMilliseconds,
        };
    }

    private JObject OfflinePrivacyProbe(JObject input)
    {
        var seat = Seat(input, "seat");
        var saved = authority;
        var savedActions = actions.ToArray(); var savedChoices = choices.ToArray();
        var savedPrompts = promptOffers.ToArray();
        var savedBench = benchDisplayOrder.ToDictionary(pair => pair.Key, pair => pair.Value.ToList());
        var swapped = false; var reversed = 0;
        try
        {
            authority = OfflineReadCopy();
            var board = authority.workingBoard;
            void Permute(List<CardEntity> cards)
            {
                var indexes = Enumerable.Range(0, cards.Count).Where(index => cards[index] != null && !cards[index].HasMetaData(MetaDataKey.CardIsRevealed)).ToArray();
                for (var index = 0; index < indexes.Length / 2; index++)
                {
                    var other = indexes.Length - 1 - index;
                    (cards[indexes[index]], cards[indexes[other]]) = (cards[indexes[other]], cards[indexes[index]]);
                    reversed += 2;
                }
            }
            Permute(board.p1Deck); Permute(board.p2Deck); Permute(board.p1Prize); Permute(board.p2Prize);
            var hand = seat == "human" ? board.p2Hand : board.p1Hand;
            var deck = seat == "human" ? board.p2Deck : board.p1Deck;
            var hiddenHand = hand.FindIndex(card => !card.HasMetaData(MetaDataKey.CardIsRevealed));
            var hiddenDeck = deck.FindIndex(card => !card.HasMetaData(MetaDataKey.CardIsRevealed)
                && hiddenHand >= 0 && card.cardSourceID != hand[hiddenHand].cardSourceID);
            if (hiddenHand >= 0 && hiddenDeck >= 0)
            {
                (hand[hiddenHand], deck[hiddenDeck]) = (deck[hiddenDeck], hand[hiddenHand]);
                var setPosition = typeof(CardEntity).GetMethod("SetCurrentPosition", BindingFlags.Instance | BindingFlags.NonPublic)!;
                setPosition.Invoke(hand[hiddenHand], [seat == "human" ? BoardPos.Player2Hand : BoardPos.Player1Hand]);
                setPosition.Invoke(deck[hiddenDeck], [seat == "human" ? BoardPos.Player2Deck : BoardPos.Player1Deck]);
                swapped = true;
            }
            board.RebuildEntityList();
            return new JObject { ["view"] = Project(seat), ["permutedSlots"] = reversed, ["opponentHandExchanged"] = swapped };
        }
        finally
        {
            authority = saved;
            actions.Clear(); foreach (var item in savedActions) actions.Add(item.Key, item.Value);
            choices.Clear(); foreach (var item in savedChoices) choices.Add(item.Key, item.Value);
            promptOffers.Clear(); foreach (var item in savedPrompts) promptOffers.Add(item.Key, item.Value);
            benchDisplayOrder.Clear(); foreach (var item in savedBench) benchDisplayOrder.Add(item.Key, item.Value);
        }
    }

    private sealed class OfflineReadSeeds : IRandomSeedGenerator
    {
        internal int Attempts { get; private set; }
        public int GetRandomSeed()
        {
            Attempts++;
            throw new InvalidOperationException("chance requested during offline read");
        }
    }

    private sealed class OfflineSeeds(uint seed) : IRandomSeedGenerator
    {
        internal uint Seed { get; } = seed;
        internal List<int> Emitted { get; } = [];
        public int GetRandomSeed()
        {
            uint mixed;
            unchecked
            {
                mixed = Seed + (uint)(Emitted.Count + 1) * 0x9e3779b9U;
                mixed = (mixed ^ (mixed >> 16)) * 0x21f0aaadU;
                mixed = (mixed ^ (mixed >> 15)) * 0x735a2d97U;
                mixed ^= mixed >> 15;
            }
            var value = (int)(mixed & 0x7fffffffU);
            Emitted.Add(value);
            return value;
        }
    }
}
