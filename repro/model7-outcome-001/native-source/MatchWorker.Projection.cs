using MatchLogic;
using Newtonsoft.Json.Linq;
using System.Text.RegularExpressions;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private readonly Dictionary<string, List<string>> benchDisplayOrder = new(StringComparer.Ordinal);

    private void RebuildFrame()
    {
        actions.Clear(); choices.Clear(); promptOffers.Clear();
        var human = Project("human");
        var opponent = Project("opponent");
        frame = new JObject
        {
            ["revision"] = revision,
            ["views"] = new JObject { ["human"] = human, ["opponent"] = opponent },
            ["terminal"] = Terminal(),
        };
    }

    private JObject FailureFrame()
    {
        var copy = (JObject)frame!.DeepClone();
        copy["revision"] = revision;
        copy["terminal"] = null;
        foreach (var seat in new[] { "human", "opponent" })
        {
            var view = (JObject)copy["views"]![seat]!;
            view["revision"] = revision;
            view["status"] = "failed";
            view["actions"] = new JArray();
            view["prompts"] = new JArray();
            view["notice"] = "match engine stopped after an unexpected error";
        }
        return copy;
    }

    private JToken? Terminal()
    {
        var board = authority!.workingBoard;
        if (!board.isGameOver) return null;
        string? winner = board.IsPlayerWinner(true) ? "human" : board.IsPlayerWinner(false) ? "opponent" : null;
        return new JObject { ["winner"] = winner, ["reason"] = "native game outcome" };
    }

    private JObject Project(string seat)
    {
        using var offlineProjectionScope = BeginOfflineProjection();
        bool viewerOne = seat == "human";
        var read = OfflineReadCopy();
        read.workingBoard.RebuildEntityList();
        var board = read.workingBoard.CreatePrivatizedMatchBoardForPlayer(viewerOne);
        // Read the entire board through the native per-seat privacy transform.
        // Native MatchOperationResult changes message counters and ability lists;
        // it is intentionally absent from this whole-snapshot projection.
        var mine = Side(board, read, viewerOne, viewerOne, seat);
        var theirs = Side(board, read, !viewerOne, viewerOne, seat == "human" ? "opponent" : "human");
        var hand = viewerOne ? board.p1Hand : board.p2Hand;
        var status = failed ? "failed" : board.isGameOver ? "finished" :
            board.player1.GetMetaData<int>(MetaDataKey.PlayerSetupState) > 0
            && board.player2.GetMetaData<int>(MetaDataKey.PlayerSetupState) > 0 ? "playing" : "setup";
        var currentPlayer = board.boardEntity.GetMetaData<int>(MetaDataKey.GameCurrentPlayer);
        var offered = new JArray();
        var prompts = new JArray();
        if (!failed && !board.isGameOver)
        {
            if (authority.status == OperationStatus.WaitingForInput)
            {
                var visibleCardIds = mine.SelectTokens("$..instanceId").Concat(theirs.SelectTokens("$..instanceId"))
                    .Select(value => value.Value<string>()!).Concat(hand.Select(card => card.entityID)).ToHashSet(StringComparer.Ordinal);
                if (board.stadium != null && KnownCard(board.stadium)) visibleCardIds.Add(board.stadium.entityID);
                AddPrompt(seat, prompts, visibleCardIds);
            }
            else if (authority.status == OperationStatus.Finished)
                AddActions(seat, offered);
            else throw new InvalidOperationException("native operation did not settle for a viewer read");
        }
        var stadium = board.stadium == null ? null : VisibleCard(board.stadium);
        if (stadium != null) stadium["owner"] = board.stadium!.isPlayer1 == viewerOne ? "you" : "opponent";
        var view = new JObject
        {
            ["version"] = "indigo-live/1", ["id"] = matchId, ["revision"] = revision,
            ["sequence"] = revision, ["status"] = status, ["source"] = "live-matchlogic",
            ["programBundle"] = bundle.Id, ["profile"] = "indigo-private-alpha/1",
            ["turn"] = currentPlayer == (viewerOne ? 1 : 2) ? "you" : "opponent",
            ["turnNumber"] = Math.Max(0, board.boardEntity.GetMetaData<int>(MetaDataKey.TotalTurnCount)),
            ["you"] = mine, ["opponent"] = theirs,
            ["hand"] = new JArray(hand.Select(VisibleCard)),
            ["stadium"] = stadium,
            ["publicContext"] = PublicContext(board, viewerOne),
            ["prompts"] = prompts, ["actions"] = offered,
            ["log"] = PresentationLog(seat), ["events"] = PresentationEvents(seat), ["result"] = null,
            ["notice"] = status == "setup" ? "choose the next setup step" : "",
            ["cardDetails"] = offlineBenchmarkMode ? new JArray() : CardDetails(board, viewerOne, offered),
            ["activeDetails"] = offlineBenchmarkMode ? new JArray() : ActiveDetails(board, read, viewerOne, offered),
        };
        view["energyFacts"] = Model6EnergyFacts(board, viewerOne, view);
        return view;
    }

    private static JObject PublicContext(MatchBoard board, bool viewerOne)
    {
        var you = viewerOne ? board.player1 : board.player2;
        var opponent = viewerOne ? board.player2 : board.player1;
        JObject ItemLock(PlayerEntity player)
        {
            var effects = player.GetAllAppliedStatusEffects()
                .Where(effect => effect.statusEffect is BlockCardPlay && effect.IsEffectActive()).ToArray();
            var known = effects.All(effect => effect.actionType == ActionType.Attack
                && effect.actionSourceID == "-855686478"
                && effect.statusEffect.locID == "block_item_play_effectdrawer");
            var locked = known && effects.Length > 0;
            return new JObject
            {
                ["known"] = known, ["value"] = known ? locked : (bool?)null,
                ["expiryKnown"] = known && !locked, ["remainingTurns"] = known && !locked ? 0 : (int?)null,
            };
        }
        JObject DrawEligible(PlayerEntity player)
        {
            var currentPlayer = board.boardEntity.GetMetaData<int>(MetaDataKey.GameCurrentPlayer);
            var known = currentPlayer == (player.isPlayer1 ? 1 : 2);
            return new JObject
            {
                ["known"] = known,
                ["value"] = known ? player.HasMetaData(MetaDataKey.PlayerLastTurnKOPokemonStates) : (bool?)null,
            };
        }
        return new JObject
        {
            ["itemLock"] = new JObject { ["you"] = ItemLock(you), ["opponent"] = ItemLock(opponent) },
            ["knockoutsDuringPreviousOpponentTurn"] = new JObject
            {
                ["you"] = new JObject { ["known"] = false, ["value"] = null },
                ["opponent"] = new JObject { ["known"] = false, ["value"] = null },
            },
            ["knockoutDrawEligible"] = new JObject { ["you"] = DrawEligible(you), ["opponent"] = DrawEligible(opponent) },
        };
    }

    private JObject Side(MatchBoard board, MatchOperation read, bool sideOne, bool viewerOne, string identitySeat)
    {
        var active = sideOne ? board.p1Active : board.p2Active;
        var bench = sideOne ? board.p1Bench : board.p2Bench;
        var discard = sideOne ? board.p1Discard : board.p2Discard;
        return new JObject
        {
            ["accountId"] = seatAccounts[identitySeat], ["name"] = seatNames[identitySeat],
            ["active"] = active == null || !KnownCard(active) ? null : Creature(active, read, sideOne == viewerOne),
            ["bench"] = new JArray(StableBench(bench.Where(KnownCard).ToList(), identitySeat, sideOne == viewerOne)
                .Select(card => Creature(card, read, sideOne == viewerOne))),
            // Live retains the six physical slots and clears taken cards to
            // null. Occupied slots, including private placeholders, remain.
            ["prizes"] = (sideOne ? board.p1Prize : board.p2Prize).Count(card => card != null),
            ["deckCount"] = sideOne ? board.p1Deck.Count : board.p2Deck.Count,
            ["handCount"] = sideOne ? board.p1Hand.Count : board.p2Hand.Count,
            ["discard"] = new JArray(discard.Select(VisibleCard)), ["clockSeconds"] = 0,
        };
    }

    private List<CardEntity> StableBench(List<CardEntity> visible, string seat, bool ownerView)
    {
        var previous = benchDisplayOrder.GetValueOrDefault(seat) ?? [];
        var ordered = new List<CardEntity>();
        foreach (var priorId in previous)
        {
            // Native evolution removes the old entity and appends its successor.
            // The public table keeps that Pokémon's location using real ancestry.
            var successor = visible.FirstOrDefault(card => card.entityID == priorId
                || card.attachedPokemon.Any(ancestor => ancestor.entityID == priorId));
            if (successor != null && !ordered.Contains(successor)) ordered.Add(successor);
        }
        ordered.AddRange(visible.Where(card => !ordered.Contains(card)));
        // A hidden opposing setup view must not erase the owner's layout memory.
        if (ownerView || visible.Count > 0)
            benchDisplayOrder[seat] = ordered.Select(card => card.entityID).ToList();
        return ordered;
    }

    private JObject VisibleCard(CardEntity card)
    {
        if (!KnownCard(card)) throw new InvalidOperationException("private card reached a visible projection");
        var source = CardCache.Get(card.cardSourceID);
        return new JObject
        {
            ["instanceId"] = card.entityID, ["name"] = source.cardName,
            ["definitionId"] = card.cardSourceID,
            ["printingId"] = bundle.PrintingBySource.GetValueOrDefault(card.cardSourceID) ?? card.cardSourceID,
            ["category"] = source.cardFormat switch
            {
                CardFormat.Pokemon => "pokemon",
                CardFormat.BasicEnergy or CardFormat.SpecialEnergy => "energy",
                CardFormat.TrainerItem or CardFormat.TrainerSupporter or CardFormat.TrainerTool
                    or CardFormat.TrainerStadium or CardFormat.TrainerItemPokemon or CardFormat.AllTrainers => "trainer",
                _ => throw new InvalidOperationException("visible card has no supported category: " + source.cardFormat),
            },
        };
    }

    private JObject Creature(CardEntity card, MatchOperation read, bool isMine)
    {
        var source = CardCache.Get(card.cardSourceID);
        if (source == null) throw new InvalidOperationException("visible creature has no source: " + card.cardSourceID);
        var energy = card.attachedEnergy?.Select(x => x.entityID).ToArray() ?? [];
        var damage = card.GetTotalDamage();
        var nativeCard = read.workingBoard.GetEntityByID(card.entityID) as CardEntity
            ?? throw new InvalidOperationException("visible creature is missing from the copied native board");
        var nativeState = new StateInformation(read, null, null);
        var provided = Regex.Matches(nativeCard.GetTotalEnergy(nativeState), @"\{([^}]+)\}")
            .Select(match => EnergyName(match.Groups[1].Value)).ToArray();
        var attachedEnergy = card.attachedEnergy ?? [];
        var attachedTools = card.attachedTools ?? [];
        var attachedPokemon = card.attachedPokemon ?? [];
        var conditions = read.workingBoard.GetActiveStatusEffectsByType(typeof(SpecialConditionEffect), nativeCard, nativeState)
            .Select(effect => effect.statusEffect).OfType<SpecialConditionEffect>()
            .Select(effect => effect.effectTag switch
            {
                SpecialConditionEffect.EffectTag.Poison => "poisoned",
                SpecialConditionEffect.EffectTag.Burn => "burned",
                SpecialConditionEffect.EffectTag.Paralyze => "paralyzed",
                SpecialConditionEffect.EffectTag.Confuse => "confused",
                SpecialConditionEffect.EffectTag.Sleep => "asleep",
                _ => "",
            }).Where(condition => condition.Length > 0).Distinct().ToArray();
        var creature = new JObject
        {
            ["instanceId"] = card.entityID, ["owner"] = isMine ? "you" : "opponent",
            ["name"] = source.cardName,
            ["printingId"] = bundle.PrintingBySource.GetValueOrDefault(card.cardSourceID) ?? card.cardSourceID,
            ["definitionId"] = card.cardSourceID, ["kind"] = "unknown",
            ["hp"] = nativeCard.GetTotalHP(nativeState), ["damage"] = damage,
            ["energyCards"] = new JArray(energy), ["providedEnergy"] = provided.Length,
            ["providedEnergyTypes"] = new JArray(provided),
            ["conditions"] = new JArray(conditions),
            ["enteredPlayThisTurn"] = card.HasMetaData(MetaDataKey.CardCameIntoPlayThisTurn),
            ["evolvedThisTurn"] = card.HasMetaData(MetaDataKey.CardEvolveThisTurn),
            ["attachments"] = new JArray(card.attachedTools?.Select(x => x.entityID) ?? []),
            ["evolutionStack"] = new JArray(card.attachedPokemon?.Select(x => x.cardSourceID) ?? []),
            ["sprite"] = "unavailable", ["printedRetreat"] = source.retreatCost,
            ["currentRetreat"] = nativeCard.GetRetreatCost(nativeState),
        };
        // Attached faces come only from the per-viewer privatized card. If a
        // face is unavailable, omit this optional group instead of asserting
        // that its public stack is empty.
        if (attachedEnergy.All(KnownCard) && attachedTools.All(KnownCard) && attachedPokemon.All(KnownCard))
            creature["publicCards"] = new JObject
            {
                ["energy"] = new JArray(attachedEnergy.Select(VisibleCard)),
                ["tools"] = new JArray(attachedTools.Select(VisibleCard)),
                ["evolutions"] = new JArray(attachedPokemon.Select(VisibleCard)),
            };
        return creature;
    }

    private JArray ActiveDetails(MatchBoard board, MatchOperation read, bool viewerOne, JArray offered)
    {
        var details = new JArray();
        foreach (var card in new[] { viewerOne ? board.p1Active : board.p2Active,
                     viewerOne ? board.p2Active : board.p1Active }.Where(x => x != null && KnownCard(x)))
        {
            var attacks = new JArray();
            foreach (var action in card!.GetUseActions(onlyActionsOnEntity: true).Where(x => x.actionType == ActionType.Attack))
            {
                var offer = offered.Children<JObject>().FirstOrDefault(x => x.Value<string>("sourceCardId") == card.entityID
                    && x.Value<string>("actionKey") == card.cardSourceID + "/" + action.actionSourceID);
                attacks.Add(new JObject
                {
                    ["name"] = action.actionName,
                    ["cost"] = action is CardAction attack
                        ? new JArray(Regex.Matches(attack.GetPrimaryEnergyCost(), @"\{([^}]+)\}")
                            .Select(match => EnergyName(match.Groups[1].Value))) : null,
                    ["costKind"] = "printed", ["damage"] = null,
                    ["text"] = "", ["actionId"] = offer?.Value<string>("id"),
                });
            }
            details.Add(new JObject { ["creature"] = Creature(card, read, card == (viewerOne ? board.p1Active : board.p2Active)),
                ["attacks"] = attacks });
        }
        return details;
    }

    private JArray CardDetails(MatchBoard board, bool viewerOne, JArray offered)
    {
        var hand = viewerOne ? board.p1Hand : board.p2Hand;
        var active = viewerOne ? board.p1Active : board.p2Active;
        var bench = viewerOne ? board.p1Bench : board.p2Bench;
        var details = new JArray();
        foreach (var card in hand.Concat(bench).Prepend(active).Where(x => x != null && KnownCard(x)))
        {
            var abilities = new JArray();
            foreach (var action in card!.GetUseActions(onlyActionsOnEntity: true).Where(x => x.actionType == ActionType.Ability))
            {
                var offer = offered.Children<JObject>().FirstOrDefault(x => x.Value<string>("sourceCardId") == card.entityID
                    && x.Value<string>("actionKey") == card.cardSourceID + "/" + action.actionSourceID);
                abilities.Add(new JObject
                {
                    ["name"] = action.actionName, ["text"] = "", ["actionId"] = offer?.Value<string>("id"),
                });
            }
            details.Add(new JObject { ["instanceId"] = card.entityID, ["text"] = "", ["abilities"] = abilities });
        }
        return details;
    }

    private bool KnownCard(CardEntity card) =>
        !string.IsNullOrWhiteSpace(card.cardSourceID) && bundle.Programs.Cards.Any(x => x.cardSourceID == card.cardSourceID);

    private static string EnergyName(string symbol) => symbol switch
    {
        "R" => "fire", "P" => "psychic", "D" => "darkness", "W" => "water",
        "G" => "grass", "L" => "lightning", "F" => "fighting", "M" => "metal",
        "C" => "colorless", "Y" => "fairy", "N" => "dragon", "V" => "rainbow",
        _ => symbol.ToLowerInvariant(),
    };
}
