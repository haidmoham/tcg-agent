using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using MatchLogic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private readonly Dictionary<string, MatchWorker> searchBranches = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JObject> searchContexts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> searchContextTurns = new(StringComparer.Ordinal);

    private JObject SearchDispatch(string method, JObject input)
    {
        if (method == "search-begin")
        {
            try
            {
                var branch = ReconstructSearchRoot(input);
                var handle = Guid.NewGuid().ToString("N");
                searchBranches.Add(handle, branch);
                return new JObject { ["handle"] = handle, ["supported"] = true,
                    ["qualification"] = "public-root-reconstruction-and-isolation-checks" };
            }
            catch (Exception error)
            {
                return new JObject { ["supported"] = false, ["unsupported"] = true,
                    ["code"] = "UNSUPPORTED_SEARCH_DOMAIN", ["reason"] = error.GetBaseException().Message };
            }
        }
        var key = RequiredString(input, "handle");
        if (!searchBranches.TryGetValue(key, out var parent)) throw new InvalidDataException("unknown search handle");
        if (method == "search-close") return new JObject { ["closed"] = searchBranches.Remove(key) };
        if (method == "search-observe") return parent.SearchObservation();
        if (method == "search-audit")
        {
            var audit = new JObject {
                ["authoritySha256"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(parent.authority, SerializeResolver.settings)))),
                ["randomCalls"] = parent.offlineRng!.Emitted.Count };
            if (input.Value<bool?>("includeHypothesis") == true)
            {
                JArray Zone(IEnumerable<CardEntity> cards) => new(cards.Where(card => card != null).Select(card => new JObject {
                    ["instanceId"] = card.entityID, ["definitionId"] = card.cardSourceID }));
                var board = parent.authority!.workingBoard;
                audit["hypotheticalOwnDeck"] = Zone(board.p1Deck);
                audit["hypotheticalOwnPrizes"] = Zone(board.p1Prize);
                audit["zoneCardCounts"] = new JArray(board.AllEntityList().OfType<CardEntity>().Count(card => card.isPlayer1),
                    board.AllEntityList().OfType<CardEntity>().Count(card => !card.isPlayer1));
            }
            return audit;
        }
        var command = parent.ResolveSearchCommand(RequireObject(input["semanticCommand"]));
        if (method == "search-validate") return new JObject { ["valid"] = parent.ValidateSearchCommand(command) };
        if (method != "search-step") throw new InvalidDataException("unknown search method");
        var child = parent.CopySearchBranch();
        var childCommand = child.ResolveSearchCommand(RequireObject(input["semanticCommand"]));
        var seat = child.SearchToPlay();
        child.RecordSearchAcceptance(seat, childCommand);
        childCommand["commandId"] = Guid.NewGuid().ToString("N");
        childCommand["expectedRevision"] = child.revision;
        var reply = child.Command(new JObject { ["seat"] = seat, ["command"] = childCommand });
        if (reply["receipt"]!.Value<string>("status") != "accepted")
            throw new InvalidDataException("search step rejected: " + reply["receipt"]!.Value<string>("reason"));
        var childHandle = Guid.NewGuid().ToString("N");
        searchBranches.Add(childHandle, child);
        return new JObject { ["handle"] = childHandle };
    }

    private string SearchToPlay()
    {
        foreach (var seat in new[] { "human", "opponent" })
        {
            var view = frame!["views"]![seat]!;
            if (((JArray)view["prompts"]!).Count > 0 || ((JArray)view["actions"]!).Count > 0) return seat;
        }
        return authority!.workingBoard.boardEntity.GetMetaData<int>(MetaDataKey.GameCurrentPlayer) == 1 ? "human" : "opponent";
    }

    private JObject SearchObservation()
    {
        var seat = SearchToPlay();
        var view = (JObject)frame!["views"]![seat]!.DeepClone();
        var substitutions = new Dictionary<string, string>(StringComparer.Ordinal);
        var visibleActions = (JArray)view["actions"]!;
        for (var index = 0; index < visibleActions.Count; index++)
            substitutions.Add(visibleActions[index]!.Value<string>("id")!, $"r{revision}/action/{index}");
        var visiblePrompts = (JArray)view["prompts"]!;
        for (var index = 0; index < visiblePrompts.Count; index++)
        {
            var prompt = visiblePrompts[index]!;
            var token = $"r{revision}/prompt/{index}";
            substitutions.Add(prompt.Value<string>("id")!, token);
            var offeredChoices = (JArray)prompt["choices"]!;
            for (var choice = 0; choice < offeredChoices.Count; choice++)
                substitutions.Add(offeredChoices[choice]!.Value<string>("id")!, token + "/choice/" + choice);
            var groups = (JArray)prompt["groups"]!;
            for (var group = 0; group < groups.Count; group++)
                substitutions.Add(groups[group]!.Value<string>("id")!, token + "/group/" + group);
        }
        foreach (var value in view.Descendants().OfType<JValue>().Where(value => value.Type == JTokenType.String).ToArray())
            if (value.Value<string>() is string original && substitutions.TryGetValue(original, out var replacement)) value.Value = replacement;
        view["decisionContext"] = SearchContext(seat, view).DeepClone();
        return new JObject { ["safeView"] = view,
            ["toPlay"] = seat, ["result"] = Terminal() };
    }

    private JObject SearchContext(string seat, JObject view)
    {
        var turn = view.Value<int>("turnNumber");
        if (!searchContexts.ContainsKey(seat) || searchContextTurns.GetValueOrDefault(seat, -1) != turn)
        {
            searchContexts[seat] = new JObject { ["originAction"] = null, ["originCard"] = null,
                ["usage"] = new JObject(new[] { "energyPlayed", "supporterPlayed", "retreated" }.Select(name =>
                    new JProperty(name, new JObject { ["known"] = true, ["value"] = false }))), ["entityUsage"] = new JObject() };
            searchContextTurns[seat] = turn;
        }
        var context = searchContexts[seat];
        foreach (var card in new[] { view["you"]!["active"] }.Concat(((JArray)view["you"]!["bench"]!).ToArray()).OfType<JObject>())
            if (context["entityUsage"]![card.Value<string>("instanceId")!] == null)
                context["entityUsage"]![card.Value<string>("instanceId")!] = new JObject { ["abilityUsed"] = new JObject { ["known"] = true, ["value"] = false } };
        return context;
    }

    private void RecordSearchAcceptance(string seat, JObject command)
    {
        if (command.Value<string>("actionId") is not string actionId) return;
        var view = (JObject)frame!["views"]![seat]!;
        var context = SearchContext(seat, view);
        var offers = ((JArray)view["actions"]!).Children<JObject>().ToArray();
        var index = Array.FindIndex(offers, action => action.Value<string>("id") == actionId);
        var action = (JObject)offers[index].DeepClone();
        action["id"] = $"r{revision}/action/{index}";
        context["originAction"] = action;
        var sourceId = action.Value<string>("sourceCardId");
        var face = view.SelectTokens("$..instanceId").OfType<JValue>().FirstOrDefault(value => value.Value<string>() == sourceId)?.Parent?.Parent;
        context["originCard"] = face?.DeepClone();
        if (action.Value<string>("kind") == "retreat") context["usage"]!["retreated"]!["value"] = true;
        if (sourceId != null && authority!.workingBoard.GetEntityByID(sourceId) is CardEntity card)
        {
            var source = CardCache.Get(card.cardSourceID);
            if (action.Value<string>("kind") == "play" && source.cardFormat is CardFormat.BasicEnergy or CardFormat.SpecialEnergy)
                context["usage"]!["energyPlayed"]!["value"] = true;
            if (action.Value<string>("kind") == "play" && source.cardFormat == CardFormat.TrainerSupporter)
                context["usage"]!["supporterPlayed"]!["value"] = true;
            if (action.Value<string>("kind") == "ability") context["entityUsage"]![sourceId] = new JObject { ["abilityUsed"] = new JObject { ["known"] = true, ["value"] = true } };
        }
    }

    private JObject ResolveSearchCommand(JObject semantic)
    {
        var result = (JObject)semantic.DeepClone();
        var view = frame!["views"]![SearchToPlay()]!;
        string Resolve(string token, JArray rows, string kind)
        {
            var parts = token.Split('/');
            if (parts.Length >= 3 && parts[^2] == kind && int.TryParse(parts[^1], out var index))
                return rows[index]!.Value<string>("id")!;
            return token;
        }
        if (result.Value<string>("actionId") is string action)
            result["actionId"] = Resolve(action, (JArray)view["actions"]!, "action");
        if (result.Value<string>("promptId") is string prompt)
        {
            var prompts = (JArray)view["prompts"]!;
            var resolved = Resolve(prompt, prompts, "prompt");
            result["promptId"] = resolved;
            var row = prompts.Children<JObject>().Single(value => value.Value<string>("id") == resolved);
            if (result["choiceIds"] is JArray selected)
                result["choiceIds"] = new JArray(selected.Values<string>().Select(id => Resolve(id!, (JArray)row["choices"]!, "choice")));
            if (result["amounts"] is JArray amounts)
                foreach (var amount in amounts.Children<JObject>())
                    amount["choiceId"] = Resolve(RequiredString(amount, "choiceId"), (JArray)row["choices"]!, "choice");
        }
        return result;
    }

    private bool ValidateSearchCommand(JObject command)
    {
        var seat = SearchToPlay();
        if (command.Value<string>("actionId") is string action)
            return actions.TryGetValue(action, out var offer) && offer.Seat == seat && CanPerform(offer.Operation);
        return command.Value<string>("promptId") is string prompt && ValidateSelection(seat, command, prompt).Valid;
    }

    private MatchWorker CopySearchBranch()
    {
        var rng = new OfflineSeeds(offlineRng!.Seed);
        rng.Emitted.AddRange(offlineRng.Emitted);
        var copy = NativeStateCopier.TryCopy(authority!, out var direct) ? direct : authority!.CopyOperation();
        typeof(MatchOperation).GetField("_randomSeedGenerator", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(copy, rng);
        var child = new MatchWorker(bundle) { authority = copy, matchId = matchId, epoch = epoch,
            revision = revision, offlineRng = rng, offlineCopyMode = offlineCopyMode,
            offlineTurnProfileAdmitted = offlineTurnProfileAdmitted };
        foreach (var entry in seatAccounts) child.seatAccounts.Add(entry.Key, entry.Value);
        foreach (var entry in seatNames) child.seatNames.Add(entry.Key, entry.Value);
        foreach (var entry in offlineIdentities) child.offlineIdentities.Add(entry.Key, entry.Value);
        foreach (var entry in benchDisplayOrder) child.benchDisplayOrder.Add(entry.Key, entry.Value.ToList());
        foreach (var entry in searchContexts) child.searchContexts.Add(entry.Key, (JObject)entry.Value.DeepClone());
        foreach (var entry in searchContextTurns) child.searchContextTurns.Add(entry.Key, entry.Value);
        child.RebuildFrame();
        return child;
    }

    private static void SearchMeta(MatchEntity entity, MetaDataKey key, object value, StateInformation? state = null,
        PlayerDuration duration = PlayerDuration.UntilCanceled)
        => typeof(MatchEntity).GetMethod("SetMetaData", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(entity, [key, value, entity.isPlayer1, state, duration]);

    private MatchWorker ReconstructSearchRoot(JObject input)
    {
        var view = RequireObject(input["rootView"]);
        if (view.Value<string>("status") != "playing" || view.Value<string>("turn") != "you"
            || (view["prompts"] as JArray)?.Count != 0)
            throw new InvalidDataException("root requires a settled ordinary actor decision; pending selection queue is not present in rootView");
        var seed = checked((uint)(input.Value<long?>("seed") ?? throw new InvalidDataException("independent seed required")));
        var decks = RequireObject(input["knownDecks"]);
        var knowledge = RequireObject(view["deckKnowledge"]);
        if (knowledge.Value<string>("schema") != "actor-deck-knowledge/1" || knowledge.Value<bool?>("complete") != true)
            throw new InvalidDataException("complete actor-visible deck-knowledge ledger required");
        var random = new Random(unchecked((int)seed));
        var branch = new MatchWorker(bundle) { matchId = "information-search", epoch = "information-search",
            offlineRng = new OfflineSeeds(seed), offlineCopyMode = "projection-turn-v1", revision = view.Value<int>("revision") };
        if (view["decisionContext"] is JObject rootContext)
        {
            branch.searchContexts.Add("human", (JObject)rootContext.DeepClone());
            branch.searchContextTurns.Add("human", view.Value<int>("turnNumber"));
        }
        branch.ConfigureOfflineTurnPreflight(false);
        branch.seatAccounts.Add("human", "search-human"); branch.seatAccounts.Add("opponent", "search-opponent");
        branch.seatNames.Add("human", "hypothetical actor"); branch.seatNames.Add("opponent", "hypothetical opponent");
        var board = new MatchBoard(branch.matchId, GameMode.Standard, "search-human", "actor", "search-opponent", "opponent", false);
        var turn = view.Value<int>("turnNumber");
        SearchMeta(board.boardEntity, MetaDataKey.TotalTurnCount, turn);
        SearchMeta(board.boardEntity, MetaDataKey.GameCurrentPlayer, 1);
        SearchMeta(board.boardEntity, MetaDataKey.GameNextPlayer, 2);
        SearchMeta(board.boardEntity, MetaDataKey.GameFirstPlayer, turn % 2 == 1 ? 1 : 2);
        var version = new DateBasedVersion(new DateTime(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc));
        var turnFlags = new List<(CardEntity Card, bool Entered, bool Evolved)>();
        var publicConditions = new List<(CardEntity Card, string Condition)>();
        int freshIdentity = 0;
        string NewIdentity() => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{seed}/{freshIdentity++}")))[..32];
        foreach (var one in new[] { true, false })
        {
            var seat = one ? "human" : "opponent";
            var side = RequireObject(view[one ? "you" : "opponent"]);
            var remaining = ((JArray?)decks[seat] ?? throw new InvalidDataException("knownDecks needs human and opponent source lists")).Values<string>().Select(id => id!).ToList();
            if (remaining.Count != 60) throw new InvalidDataException("declared deck must contain 60 cards");
            CardEntity Make(JObject face, BoardPos position, string? parent = null)
            {
                var source = face.Value<string>("definitionId") ?? throw new InvalidDataException("visible card definition missing");
                if (!remaining.Remove(source)) throw new InvalidDataException("visible cards do not conserve declared deck: " + source);
                var card = new CardEntity(source, branch.seatAccounts[seat], one, position, version, board)
                    { entityID = face.Value<string>("instanceId") ?? NewIdentity(), currentParentEntityID = parent ?? "" };
                card.damageCounters = face.Value<int?>("damage") is int damage ? damage / 10 : 0;
                turnFlags.Add((card, face.Value<bool?>("enteredPlayThisTurn") == true, face.Value<bool?>("evolvedThisTurn") == true));
                if (face["conditions"] is JArray conditions)
                    publicConditions.AddRange(conditions.Values<string>().Select(condition => (card, condition!)));
                if (face["publicCards"] is JObject attached)
                {
                    card.attachedEnergy.AddRange(((JArray)attached["energy"]!).Children<JObject>().Select(child => Make(child, position, card.entityID)));
                    card.attachedTools.AddRange(((JArray)attached["tools"]!).Children<JObject>().Select(child => Make(child, position, card.entityID)));
                    card.attachedPokemon.AddRange(((JArray)attached["evolutions"]!).Children<JObject>().Select(child => Make(child, position, card.entityID)));
                }
                return card;
            }
            var activePos = one ? BoardPos.Player1Active : BoardPos.Player2Active;
            var benchPos = one ? BoardPos.Player1Bench : BoardPos.Player2Bench;
            var active = side["active"] is JObject face ? Make(face, activePos) : null;
            var bench = ((JArray)side["bench"]!).Children<JObject>().Select(face => Make(face, benchPos)).ToList();
            var discard = ((JArray)side["discard"]!).Children<JObject>().Select(face => Make(face, one ? BoardPos.Player1Discard : BoardPos.Player2Discard)).ToList();
            if (one) { board.p1Active = active; board.p1Bench = bench; board.p1Discard = discard;
                board.p1Hand = ((JArray)view["hand"]!).Children<JObject>().Select(face => Make(face, BoardPos.Player1Hand)).ToList(); }
            else { board.p2Active = active; board.p2Bench = bench; board.p2Discard = discard; }
            if (view["stadium"] is JObject stadium && (stadium.Value<string>("owner") == (one ? "you" : "opponent"))) board.stadium = Make(stadium, BoardPos.BoardStadium);
            var reserved = new Dictionary<string, CardEntity>(StringComparer.Ordinal);
            var top = one ? (JArray?)knowledge["ownDeck"]?["top"] ?? new JArray() : new JArray();
            var bottomBlocks = one ? (JArray?)knowledge["ownDeck"]?["bottomBlocks"] ?? new JArray() : new JArray();
            if (one)
            {
                board.RebuildEntityList();
                var visibleIds = board.AllEntityList().OfType<CardEntity>().Select(card => card.entityID).ToHashSet(StringComparer.Ordinal);
                var cards = ((JArray?)knowledge["ownDeck"]?["knownCards"] ?? new JArray()).Children<JObject>()
                    .Concat(top.Children<JObject>()).Concat(bottomBlocks.Children<JObject>().SelectMany(block => ((JArray)block["cards"]!).Children<JObject>()));
                foreach (var knownCard in cards)
                {
                    var id = RequiredString(knownCard, "instanceId");
                    if (visibleIds.Contains(id)) throw new InvalidDataException("deck knowledge contradicts currently visible card: " + id);
                    if (reserved.TryGetValue(id, out var previous))
                    {
                        if (previous.cardSourceID != knownCard.Value<string>("definitionId")) throw new InvalidDataException("inconsistent known physical card definition");
                        continue;
                    }
                    reserved.Add(id, Make(knownCard, BoardPos.Player1Deck));
                }
            }
            for (var index = remaining.Count - 1; index > 0; index--) { var other = random.Next(index + 1); (remaining[index], remaining[other]) = (remaining[other], remaining[index]); }
            CardEntity Sample(BoardPos position)
            {
                if (remaining.Count == 0) throw new InvalidDataException("unknown-zone counts exceed remaining deck multiset");
                var source = remaining[^1]; remaining.RemoveAt(remaining.Count - 1);
                return new CardEntity(source, branch.seatAccounts[seat], one, position, version, board) { entityID = NewIdentity() };
            }
            if (!one) board.p2Hand = Enumerable.Range(0, side.Value<int>("handCount")).Select(_ => Sample(BoardPos.Player2Hand)).ToList();
            var prizes = Enumerable.Range(0, side.Value<int>("prizes")).Select(_ => Sample(one ? BoardPos.Player1Prize : BoardPos.Player2Prize)).ToList();
            while (prizes.Count < 6) prizes.Add(null!);
            var unknownDeckCount = side.Value<int>("deckCount") - reserved.Count;
            if (unknownDeckCount < 0) throw new InvalidDataException("known deck cards exceed observed deck size");
            var deck = Enumerable.Range(0, unknownDeckCount).Select(_ => Sample(one ? BoardPos.Player1Deck : BoardPos.Player2Deck)).Concat(reserved.Values).ToList();
            for (var index = deck.Count - 1; index > 0; index--) { var other = random.Next(index + 1); (deck[index], deck[other]) = (deck[other], deck[index]); }
            if (one)
            {
                var positioned = new HashSet<string>(StringComparer.Ordinal);
                CardEntity Position(JObject face)
                {
                    var id = RequiredString(face, "instanceId");
                    if (!positioned.Add(id)) throw new InvalidDataException("known card has contradictory deck positions: " + id);
                    var card = reserved[id];
                    if (!deck.Remove(card)) throw new InvalidDataException("known deck card missing during positioning");
                    return card;
                }
                var topCards = top.Children<JObject>().Select(Position).ToList();
                var bottomCards = new List<CardEntity>();
                foreach (var block in bottomBlocks.Children<JObject>())
                {
                    var blockCards = ((JArray)block["cards"]!).Children<JObject>().Select(Position).ToList();
                    if (block.Value<bool?>("ordered") != true)
                        for (var index = blockCards.Count - 1; index > 0; index--) { var other = random.Next(index + 1); (blockCards[index], blockCards[other]) = (blockCards[other], blockCards[index]); }
                    bottomCards.AddRange(blockCards);
                }
                deck = topCards.Concat(deck).Concat(bottomCards).ToList();
            }
            if (remaining.Count != 0) throw new InvalidDataException("unrepresented public zones: " + remaining.Count + " cards; rootView must include lost-zone and visible pending cards");
            if (one) { board.p1Prize = prizes; board.p1Deck = deck; } else { board.p2Prize = prizes; board.p2Deck = deck; }
        }
        board.RebuildEntityList();
        branch.authority = new MatchOperation(board, true, randomSeedGenerator: branch.offlineRng)
            { status = OperationStatus.Finished, matchStarted = true };
        typeof(MatchOperation).GetField("cardCacheVersion", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!.SetValue(branch.authority, version);
        var state = new StateInformation(branch.authority, null, null);
        foreach (var (card, entered, evolved) in turnFlags)
        {
            if (entered) SearchMeta(card, MetaDataKey.CardCameIntoPlayThisTurn, 1, state, PlayerDuration.UntilBeforeEndOfMyTurn);
            if (evolved) SearchMeta(card, MetaDataKey.CardEvolveThisTurn,
                card.attachedPokemon.Count > 0 ? CardCache.Get(card.attachedPokemon[0].cardSourceID).cardName : "unknown prior evolution",
                state, PlayerDuration.UntilBeforeEndOfMyTurn);
        }
        foreach (var (card, condition) in publicConditions)
        {
            var tag = condition switch { "poisoned" => SpecialConditionEffect.EffectTag.Poison,
                "burned" => SpecialConditionEffect.EffectTag.Burn, "paralyzed" => SpecialConditionEffect.EffectTag.Paralyze,
                "confused" => SpecialConditionEffect.EffectTag.Confuse, "asleep" => SpecialConditionEffect.EffectTag.Sleep,
                _ => throw new InvalidDataException("unknown public special condition: " + condition) };
            var allowedSources = decks.Properties().SelectMany(property => ((JArray)property.Value).Values<string>()).ToHashSet();
            var effects = bundle.Programs.Cards.Where(source => allowedSources.Contains(source.cardSourceID))
                .SelectMany(source => source.useActions).SelectMany(action => action.subActions.OfType<ApplyStatusEffect>())
                .Select(apply => apply.statusEffect).OfType<SpecialConditionEffect>().Where(effect => effect.effectTag == tag).ToArray();
            if (effects.Length == 0) throw new InvalidDataException("declared card programs lack observed condition source: " + condition);
            var specifications = effects.Select(effect => JsonConvert.SerializeObject(effect, SerializeResolver.settings)).Distinct().ToArray();
            if (specifications.Length != 1) throw new InvalidDataException("public condition magnitude/source ambiguous: " + condition);
            var effect = new AppliedStatusEffect(card, card, effects[0], effects[0].duration, state,
                "public-condition-" + card.entityID + "-" + condition, "public condition", "", ActionType.Attack) { activated = true };
            typeof(MatchEntity).GetMethod("AddStatusEffect", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(card, [effect]);
            board.specialConditionValueTracker.Add(effect.effectID, effect.intVal);
        }
        if (view["decisionContext"]?["entityUsage"] is JObject entityUsage)
        foreach (var property in entityUsage.Properties())
        {
            if (property.Value["abilityUsed"]?.Value<bool?>("value") != true
                || board.GetEntityByID(property.Name) is not CardEntity origin) continue;
            foreach (var action in CardCache.Get(origin.cardSourceID).useActions.Where(action => action.actionType == ActionType.Ability))
            {
                if (((JArray)view["actions"]!).Children<JObject>().Any(offer => offer.Value<string>("sourceCardId") == origin.entityID
                    && offer.Value<string>("actionKey") == origin.cardSourceID + "/" + action.actionSourceID)) continue;
                foreach (var apply in action.subActions.OfType<ApplyStatusEffect>().Where(apply => apply.statusEffect is BlockCardActions))
                foreach (var target in apply.target.GetEntities(origin, state))
                {
                    var effect = new AppliedStatusEffect { effectID = "public-used-" + origin.entityID + "-" + action.actionSourceID,
                        applicationID = action.actionName, appliedByEntityID = origin.entityID, appliedToEntityID = target.entityID,
                        statusEffect = apply.statusEffect, remainingDuration = apply.statusEffect.duration,
                        actionType = ActionType.Ability, actionName = action.actionName, actionSourceID = action.actionSourceID,
                        strVal = action.actionName, activated = true, turnApplied = turn, appliedByPlayer1 = true };
                    typeof(MatchEntity).GetMethod("AddStatusEffect", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(target, [effect]);
                }
            }
        }
        SearchMeta(board.player1, MetaDataKey.PlayerTurnCount, (turn + 1) / 2);
        SearchMeta(board.player2, MetaDataKey.PlayerTurnCount, turn / 2);
        SearchMeta(board.player1, MetaDataKey.PlayerPrizesTakenTotal, 6 - view["you"]!.Value<int>("prizes"));
        SearchMeta(board.player2, MetaDataKey.PlayerPrizesTakenTotal, 6 - view["opponent"]!.Value<int>("prizes"));
        foreach (var (name, key) in new[] { ("energyPlayed", MetaDataKey.PlayerPlayedFromHandEnergyCard),
            ("supporterPlayed", MetaDataKey.PlayerPlayedFromHandSupporterCard), ("retreated", MetaDataKey.PlayerRetreatPlay) })
            if (view["decisionContext"]?["usage"]?[name]?.Value<bool?>("value") == true)
                SearchMeta(board.player1, key, 1, state, PlayerDuration.UntilEndOfThisTurn);
        if (view["publicContext"]?["knockoutDrawEligible"]?["you"]?.Value<bool?>("value") == true)
        {
            var candidates = board.p1Discard.Where(card => CardCache.Get(card.cardSourceID).cardFormat == CardFormat.Pokemon).ToArray();
            if (candidates.Length == 0) throw new InvalidDataException("public knockout eligibility has no represented prior Pokemon identity to sample");
            var chosen = candidates[random.Next(candidates.Length)];
            var hypotheticalPrior = new CardEntity(chosen.cardSourceID, "search-human", true, BoardPos.Player1Active, version, board)
                { entityID = chosen.entityID, damageCounters = CardCache.Get(chosen.cardSourceID).hp / 10 };
            SearchMeta(board.player1, MetaDataKey.PlayerLastTurnKOPokemonStates, CardEntity.SerializeCard(hypotheticalPrior), state,
                PlayerDuration.UntilBeforeEndOfMyNextTurn);
            var metadata = (Dictionary<MetaDataKey, List<MetaData>>)typeof(MatchEntity).GetField("entityMetaData", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(board.player1)!;
            metadata[MetaDataKey.PlayerLastTurnKOPokemonStates][^1].turnApplied = turn - 1;
        }
        foreach (var one in new[] { true, false })
        {
            var context = view["publicContext"]?["itemLock"]?[one ? "you" : "opponent"];
            if (context?.Value<bool?>("known") != true) throw new InvalidDataException("item-lock public state unknown");
            if (context.Value<bool?>("value") != true) continue;
            var source = bundle.Programs.Cards.First(card => card.useActions.Any(action => action.actionSourceID == "-855686478"));
            var attack = source.useActions.Single(action => action.actionSourceID == "-855686478");
            var apply = attack.subActions.OfType<ApplyStatusEffect>().Single(effect => effect.statusEffect is BlockCardPlay);
            var target = one ? board.player1 : board.player2;
            var origin = new CardEntity(source.cardSourceID, one ? "search-opponent" : "search-human", !one,
                one ? BoardPos.Player2Discard : BoardPos.Player1Discard, version, board) { entityID = "public-previous-itchy-pollen" };
            var effect = new AppliedStatusEffect(origin, target, apply.statusEffect, apply.statusEffect.duration,
                state, "public-item-lock-" + one, attack.actionName, attack.actionSourceID, ActionType.Attack,
                overrideTurnApplied: turn - 1) { activated = true };
            typeof(MatchEntity).GetMethod("AddStatusEffect", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(target, [effect]);
        }
        branch.RegisterOfflineIdentities();
        branch.RebuildFrame();
        string Signature(JToken action) => new JArray(action.Value<string>("kind"),
            action.Value<string>("sourceCardId"), action.Value<string>("targetId"), action.Value<string>("actionKey")).ToString(Formatting.None);
        var expected = ((JArray)view["actions"]!).Select(Signature).ToArray();
        var actual = ((JArray)branch.frame!["views"]!["human"]!["actions"]!).Select(Signature).ToArray();
        if (!expected.SequenceEqual(actual))
            throw new InvalidDataException("reconstructed legal domain differs: extra=" + string.Join(";", actual.Except(expected))
                + ";missing=" + string.Join(";", expected.Except(actual)) + ";ordered=" + expected.Order().SequenceEqual(actual.Order()));
        var observed = branch.SearchObservation()["safeView"]!;
        void ComparePublicFacts(JToken? expectedValue, JToken? actualValue, string path)
        {
            if (expectedValue is JObject expectedObject)
            {
                if (actualValue is not JObject actualObject) throw new InvalidDataException("public root object differs at " + path);
                foreach (var property in expectedObject.Properties()) ComparePublicFacts(property.Value, actualObject[property.Name], path + "/" + property.Name);
            }
            else if (expectedValue is JArray expectedArray)
            {
                if (actualValue is not JArray actualArray || expectedArray.Count != actualArray.Count)
                    throw new InvalidDataException("public root array differs at " + path);
                if (path == "energyFacts/creatures")
                {
                    foreach (var expectedCreature in expectedArray)
                        ComparePublicFacts(expectedCreature, actualArray.SingleOrDefault(creature =>
                            creature.Value<string>("instanceId") == expectedCreature.Value<string>("instanceId")), path + "/" + expectedCreature.Value<string>("instanceId"));
                }
                else if (path == "energyFacts/attachmentOptions")
                {
                    string Key(JToken option) => new JArray(option["sourceCardId"], option["targetId"], option["actionId"], option["promptId"], option["choiceId"]).ToString(Formatting.None);
                    foreach (var expectedOption in expectedArray)
                        ComparePublicFacts(expectedOption, actualArray.SingleOrDefault(option => Key(option) == Key(expectedOption)), path + "/" + Key(expectedOption));
                }
                else for (var index = 0; index < expectedArray.Count; index++) ComparePublicFacts(expectedArray[index], actualArray[index], path + "/" + index);
            }
            else if (!JToken.DeepEquals(expectedValue, actualValue)) throw new InvalidDataException("public root fact differs at " + path);
        }
        foreach (var key in new[] { "status", "revision", "turn", "turnNumber", "hand", "you", "opponent", "stadium", "publicContext", "actions", "prompts", "energyFacts", "decisionContext" })
            if (view[key] != null) ComparePublicFacts(view[key], observed[key], key);
        return branch;
    }
}

