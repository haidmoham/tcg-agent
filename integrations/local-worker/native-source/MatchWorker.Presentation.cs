using MatchLogic;
using Newtonsoft.Json.Linq;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private const int PresentationHistoryLimit = 120;
    private readonly Dictionary<string, List<JObject>> presentation = new(StringComparer.Ordinal)
    {
        ["human"] = [], ["opponent"] = [],
    };
    private readonly Dictionary<string, int> presentationSequence = new(StringComparer.Ordinal)
    {
        ["human"] = 0, ["opponent"] = 0,
    };
    private MatchOperation? presentationOperation;
    private readonly Dictionary<string, HashSet<ActionModification>> presentedModifications = new(StringComparer.Ordinal)
    {
        ["human"] = new(ReferenceEqualityComparer.Instance), ["opponent"] = new(ReferenceEqualityComparer.Instance),
    };
    private readonly Dictionary<string, Dictionary<string, JObject>> publicDamageTargets = new(StringComparer.Ordinal)
    {
        ["human"] = new(StringComparer.Ordinal), ["opponent"] = new(StringComparer.Ordinal),
    };
    private readonly Dictionary<string, HashSet<string>> presentedKnockouts = new(StringComparer.Ordinal)
    {
        ["human"] = new(StringComparer.Ordinal), ["opponent"] = new(StringComparer.Ordinal),
    };

    private JArray PresentationEvents(string seat) =>
        new(presentation[seat].Select(entry => entry.DeepClone()));

    private JArray PresentationLog(string seat) =>
        new(presentation[seat].Select(entry => new JObject
        {
            ["id"] = entry["id"]!.DeepClone(),
            ["message"] = entry["message"]!.DeepClone(),
        }));

    private void RecordPresentation(string commandId, JObject beforeFrame,
        string submittingSeat, JObject? acceptedOffer, bool acceptedTrainerUse, bool acceptedEvolution)
    {
        // Commands are serialized. Copy list membership, then read the completed
        // modifiers without advancing or mutating native authority. Native phases
        // can remove earlier modifiers and append a new final damage modifier;
        // list length is therefore not an event cursor.
        var modifications = authority!.actionModifications.ToArray();
        if (!ReferenceEquals(presentationOperation, authority))
        {
            presentationOperation = authority;
            foreach (var seat in new[] { "human", "opponent" })
            {
                presentedModifications[seat].Clear();
                publicDamageTargets[seat].Clear();
                presentedKnockouts[seat].Clear();
            }
        }

        foreach (var seat in new[] { "human", "opponent" })
        {
            try
            {
                var before = (JObject)beforeFrame["views"]![seat]!;
                var after = (JObject)frame!["views"]![seat]!;
                var visible = VisiblePresentationCards(before, after);
                // Only public in-play Pokémon survive across this operation's
                // prompts. This history is used for damage/KO facts, never to
                // identify a card played or attached from a hidden zone.
                foreach (var view in new[] { before, after })
                    foreach (var sideName in new[] { "you", "opponent" })
                        foreach (var card in new[] { view[sideName]?["active"] }
                            .Concat(view[sideName]?["bench"]?.Children() ?? []).OfType<JObject>())
                            if (card.Value<string>("instanceId") is { Length: > 0 } id && id != "PRIVATE")
                                publicDamageTargets[seat][id] = (JObject)card.DeepClone();
                if (acceptedEvolution && acceptedOffer?.Value<string>("sourceCardId") is { Length: > 0 } evolvedId &&
                    VisiblePresentationCards(after).TryGetValue(evolvedId, out var evolved) &&
                    evolved["hp"] != null && evolved["evolutionStack"] is JArray evolution && evolution.Count > 0)
                    AddPresentation(seat, commandId, "evolve",
                        OwnerText(seat, submittingSeat) + " evolved into " + evolved.Value<string>("name"),
                        submittingSeat, evolvedId, [], null, evolved, null, null);
                if (acceptedOffer != null &&
                    acceptedOffer.Value<string>("kind") is "attack" or "ability")
                {
                    var actorId = acceptedOffer.Value<string>("sourceCardId");
                    if (actorId != null && visible.ContainsKey(actorId))
                    {
                        var kind = acceptedOffer.Value<string>("kind")!;
                        var actionName = acceptedOffer.Value<string>("attackName");
                        var label = acceptedOffer.Value<string>("label");
                        var prefix = visible[actorId].Value<string>("name") + ": ";
                        if (actionName == null && label?.StartsWith(prefix, StringComparison.Ordinal) == true)
                            actionName = label[prefix.Length..];
                        var detail = actionName is { Length: > 0 } ? " used " + actionName
                            : kind == "attack" ? " used an attack" : " used an ability";
                        AddPresentation(seat, commandId, kind,
                            visible[actorId].Value<string>("name") + detail,
                            submittingSeat, actorId, [], null, visible[actorId], null, null);
                    }
                }
                if (acceptedTrainerUse && acceptedOffer?.Value<string>("sourceCardId") is { Length: > 0 } trainerId)
                {
                    // OperationType.Use and the submitting seat's projected
                    // trainer hand establish the play. The opposing view may
                    // still lack a face while native selection is pending.
                    var publicCard = visible.GetValueOrDefault(trainerId);
                    var name = publicCard?.Value<string>("name");
                    AddPresentation(seat, commandId, "play",
                        OwnerText(seat, submittingSeat) + " played " + (name ?? "a card"),
                        submittingSeat, publicCard == null ? null : trainerId, [],
                        null, publicCard, null, null);
                }

                foreach (var modification in modifications)
                {
                    if (!presentedModifications[seat].Add(modification)) continue;
                    try
                    {
                        RecordModification(seat, commandId, modification, visible,
                            publicDamageTargets[seat], presentedKnockouts[seat]);
                    }
                    catch (Exception)
                    {
                        // An unknown or changed native subtype is not a gameplay
                        // failure and must not turn a partial prompt into one.
                    }
                }

                if (before.Value<int>("turnNumber") != after.Value<int>("turnNumber") ||
                    before.Value<string>("turn") != after.Value<string>("turn"))
                {
                    var turnOwner = after.Value<string>("turn") == "you" ? seat : OtherSeat(seat);
                    AddPresentation(seat, commandId, "turn", turnOwner == seat ? "your turn" : "opponent's turn",
                        turnOwner, null, [], null, null, null, null,
                        after.Value<int>("turnNumber"));
                }
                after["events"] = PresentationEvents(seat);
                after["log"] = PresentationLog(seat);
            }
            catch (Exception)
            {
                // Preserve the accepted projection if optional presentation fails.
            }
        }
    }

    private void RecordModification(string seat, string commandId, ActionModification modification,
        Dictionary<string, JObject> visible, Dictionary<string, JObject> damageTargets, HashSet<string> knockoutTargets)
    {
        if (modification is SwapCardsModification swaps)
        {
            foreach (var swap in swaps.swapCardDeltas)
            {
                var from = swap.fromCardAddress;
                var to = swap.toCardAddress;
                var owner = PositionOwner(to.pos);
                if (Zone(from.pos) != "bench" || Zone(to.pos) != "active" || owner == null ||
                    PositionOwner(from.pos) != owner || !visible.TryGetValue(to.entityID, out var card) ||
                    card["hp"] == null) continue;
                AddPresentation(seat, commandId, "switch",
                    OwnerText(seat, owner) + " made " + card.Value<string>("name") + " active",
                    owner, to.entityID, [], null, card, "bench", "active");
            }
            return;
        }
        if (modification is AttachCardsModification attachments)
        {
            foreach (var attachment in attachments.attachCardDeltas)
            {
                var address = attachment.toCardAddress;
                var id = address.entityID;
                var parentId = address.parentEntityID;
                var owner = PositionOwner(address.pos);
                if (id == null || parentId == null || owner == null ||
                    !visible.TryGetValue(parentId, out var parent)) continue;
                var card = visible.GetValueOrDefault(id);
                // Evolution stacks are not an Energy/Tool attachment cue.
                if (card?.Value<string>("category") == "pokemon") continue;
                AddPresentation(seat, commandId, "attach",
                    OwnerText(seat, owner) + " attached " +
                    (card?.Value<string>("name") ?? "a card") + " to " + parent.Value<string>("name"),
                    owner, card == null ? null : id, [parentId], null, card,
                    Zone(attachment.fromCardAddress.pos), Zone(address.pos));
            }
            return;
        }
        if (modification is ShuffleCardsModification shuffle)
        {
            var owner = PositionOwner(shuffle.shuffledPos);
            if (owner != null && Zone(shuffle.shuffledPos) == "deck")
                AddPresentation(seat, commandId, "shuffle", OwnerText(seat, owner) + " shuffled the deck",
                    owner, null, [], null, null, "deck", "deck");
            return;
        }
        if (modification is ApplyDamageModification damage)
        {
            if (!damage.isFinal) return;
            foreach (var hit in damage.appliedDamageDeltas.Where(hit => hit.damageAmount > 0))
            {
                var address = hit.cardAddress;
                var id = address?.entityID;
                if (id == null || !damageTargets.TryGetValue(id, out var card)) continue;
                var owner = PositionOwner(address!.pos);
                AddPresentation(seat, commandId, "damage",
                    card.Value<string>("name") + " took " + hit.damageAmount + " damage",
                    owner, null, [id], hit.damageAmount, card, null, null);
            }
            return;
        }
        if (modification is KnockOutModification knockOut)
        {
            foreach (var knocked in knockOut.knockOutDeltas)
            {
                var address = knocked.cardAddress;
                var id = address?.entityID;
                if (id == null || !damageTargets.TryGetValue(id, out var card) || !knockoutTargets.Add(id)) continue;
                AddPresentation(seat, commandId, "ko", card.Value<string>("name") + " was knocked out",
                    PositionOwner(address!.pos), null, [id], null, card, null, null);
            }
            return;
        }
        if (modification is CreateUITriggerModification trigger &&
            trigger.uiTriggerDelta.triggerKey == ClientTrigger.Knockout)
        {
            // ResolveKnockOut emits this public trigger for ordinary damage KOs.
            // Its body is a native entity ID, never client copy by itself.
            var id = trigger.uiTriggerDelta.body;
            if (damageTargets.TryGetValue(id, out var card) && knockoutTargets.Add(id))
                AddPresentation(seat, commandId, "ko", card.Value<string>("name") + " was knocked out",
                    null, null, [id], null, card, null, null);
            return;
        }
        if (modification is not MoveCardsModification moves) return;

        var cardsAddedFromDeck = new Dictionary<string, int>(StringComparer.Ordinal);
        var prizes = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var move in moves.moveCardDeltas)
        {
            var from = move.fromCardAddress.pos;
            var to = move.toCardAddress.pos;
            var owner = PositionOwner(to) ?? PositionOwner(from);
            if (owner == null) continue;
            if (Zone(from) == "deck" && Zone(to) == "hand" && PositionOwner(from) == owner)
            {
                cardsAddedFromDeck[owner] = cardsAddedFromDeck.GetValueOrDefault(owner) + 1;
                continue;
            }
            if (Zone(from) == "prizes" && Zone(to) == "hand" && PositionOwner(from) == owner)
            {
                prizes[owner] = prizes.GetValueOrDefault(owner) + 1;
                continue;
            }

            var id = move.toCardAddress.entityID;
            if (id == "PRIVATE" || !visible.TryGetValue(id, out var card)) continue;
            var sourceZone = Zone(from);
            var targetZone = Zone(to);
            string? kind = null;
            string? verb = null;
            if (sourceZone == "bench" && targetZone == "active" &&
                PositionOwner(from) == PositionOwner(to))
            {
                AddPresentation(seat, commandId, "switch",
                    OwnerText(seat, owner) + " made " + card.Value<string>("name") + " active",
                    owner, id, [], null, card, "bench", "active");
                continue;
            }
            if (sourceZone == "hand" && targetZone is "active" or "bench" &&
                move.toCardAddress.parentEntityID is { Length: > 0 } parent &&
                visible.ContainsKey(parent) && card.Value<string>("category") is "energy" or "trainer")
            {
                kind = "attach"; verb = "attached";
            }
            else if (targetZone == "stadium" && sourceZone != "stadium")
            {
                kind = "stadium"; verb = "played";
            }
            else if (targetZone is "active" or "bench" && sourceZone is not ("active" or "bench") &&
                card["hp"] != null)
            {
                kind = card["evolutionStack"] is JArray stack && stack.Count > 0 ? "evolve" : "play";
                verb = kind == "evolve" ? "evolved into" : "played";
            }
            if (kind == null) continue;
            AddPresentation(seat, commandId, kind,
                OwnerText(seat, owner) + " " + verb + " " + card.Value<string>("name"),
                owner, id, [], null, card, sourceZone, targetZone);
        }
        foreach (var (owner, count) in cardsAddedFromDeck)
            AddPresentation(seat, commandId, "hand",
                OwnerText(seat, owner) + " added " + count +
                    (count == 1 ? " card" : " cards") + " from deck to hand",
                owner, null, [], count, null, "deck", "hand");
        foreach (var (owner, count) in prizes)
            AddPresentation(seat, commandId, "prize",
                OwnerText(seat, owner) + " took " + count + (count == 1 ? " prize" : " prizes"),
                owner, null, [], count, null, "prizes", "hand");
    }

    private void AddPresentation(string seat, string commandId, string kind, string message,
        string? ownerSeat, string? actorId, string[] targetIds, int? amount, JObject? card,
        string? sourceZone, string? targetZone, int? turnNumber = null)
    {
        // A completed native Evolve and a movement delta can describe the same
        // public evolution. Keep one fact without suppressing later damage.
        if (kind == "evolve" && presentation[seat].Any(entry =>
            entry.Value<string>("causalCommandId") == commandId &&
            entry.Value<string>("kind") == kind && entry.Value<string>("actorId") == actorId)) return;
        var sequence = ++presentationSequence[seat];
        var entry = new JObject
        {
            ["id"] = commandId + ":" + seat + ":" + sequence,
            ["sequence"] = sequence, ["revision"] = revision,
            ["causalCommandId"] = commandId, ["kind"] = kind, ["message"] = message,
            ["targetIds"] = new JArray(targetIds),
        };
        if (ownerSeat != null) entry["owner"] = ownerSeat == seat ? "you" : "opponent";
        if (actorId != null) entry["actorId"] = actorId;
        if (amount != null) entry["amount"] = amount.Value;
        if (turnNumber != null) entry["turnNumber"] = turnNumber.Value;
        if (card != null) entry["card"] = new JObject
        {
            ["printingId"] = card["printingId"]?.DeepClone(),
            ["name"] = card["name"]?.DeepClone(),
        };
        if (sourceZone != null) entry["sourceZone"] = sourceZone;
        if (targetZone != null) entry["targetZone"] = targetZone;
        var history = presentation[seat];
        history.Add(entry);
        if (history.Count > PresentationHistoryLimit)
            history.RemoveRange(0, history.Count - PresentationHistoryLimit);
    }

    private static Dictionary<string, JObject> VisiblePresentationCards(params JObject[] views)
    {
        var visible = new Dictionary<string, JObject>(StringComparer.Ordinal);
        foreach (var view in views)
        {
            void Add(JToken? card)
            {
                if (card is not JObject objectCard) return;
                var id = objectCard.Value<string>("instanceId");
                if (id is { Length: > 0 } && id != "PRIVATE" &&
                    objectCard.Value<string>("name") is { Length: > 0 } &&
                    objectCard.Value<string>("printingId") is { Length: > 0 })
                    visible[id] = objectCard;
            }
            foreach (var hand in view["hand"]?.Children() ?? []) Add(hand);
            Add(view["stadium"]);
            foreach (var sideName in new[] { "you", "opponent" })
            {
                var side = view[sideName];
                Add(side?["active"]);
                foreach (var bench in side?["bench"]?.Children() ?? []) Add(bench);
                foreach (var discard in side?["discard"]?.Children() ?? []) Add(discard);
                foreach (var creature in new[] { side?["active"] }.Concat(side?["bench"]?.Children() ?? []).OfType<JObject>())
                    foreach (var group in new[] { "energy", "tools", "evolutions" })
                        foreach (var attached in creature?["publicCards"]?[group]?.Children() ?? []) Add(attached);
            }
        }
        return visible;
    }

    private static string OtherSeat(string seat) => seat == "human" ? "opponent" : "human";
    private static string OwnerText(string viewer, string owner) => owner == viewer ? "you" : "opponent";
    private static string? PositionOwner(BoardPos pos) => pos.ToString() switch
    {
        var name when name.StartsWith("Player1", StringComparison.Ordinal) => "human",
        var name when name.StartsWith("Player2", StringComparison.Ordinal) => "opponent",
        _ => null,
    };
    private static string? Zone(BoardPos pos) => pos switch
    {
        BoardPos.Player1Hand or BoardPos.Player2Hand => "hand",
        BoardPos.Player1Deck or BoardPos.Player2Deck => "deck",
        BoardPos.Player1Discard or BoardPos.Player2Discard => "discard",
        BoardPos.Player1Active or BoardPos.Player2Active => "active",
        BoardPos.Player1Bench or BoardPos.Player2Bench => "bench",
        BoardPos.Player1Prize or BoardPos.Player2Prize => "prizes",
        BoardPos.BoardStadium => "stadium",
        _ => null,
    };
}
