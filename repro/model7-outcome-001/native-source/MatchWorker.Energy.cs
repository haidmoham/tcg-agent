using MatchLogic;
using Newtonsoft.Json.Linq;
using System.Text.RegularExpressions;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private const string OriginalEnergyCardsHash = "931fca5ca0d1db49ad91818daf58a496ab69ba594cb5fd34be4878ab5ebb8cd5";
    // Exact union of the original 39 pinned programs and 77 reviewed cohort
    // printings. The bundle loader verifies this hash before deserializing.
    private const string CohortEnergyCardsHash = "3b7e00e4c023a35f62d129a26ba8f00f0fc6ae9374b7b66e4ff57d8a4df8e15f";
    private const string EnergyRulesHash = "c01fb0470f1105354f11e5a268a213ab9dbc7bfc01a8fd3e64e3313b998681e5";

    private JObject Model6EnergyFacts(MatchBoard actorBoard, bool viewerOne, JObject view)
    {
        var board = actorBoard.CopyMatchBoard();
        board.RebuildEntityList();
        var read = new MatchOperation(board);
        var state = new StateInformation(read, null, null);
        var bounded = (bundle.CardsHash.Equals(OriginalEnergyCardsHash, StringComparison.OrdinalIgnoreCase)
                || bundle.CardsHash.Equals(CohortEnergyCardsHash, StringComparison.OrdinalIgnoreCase))
            && bundle.RulesHash.Equals(EnergyRulesHash, StringComparison.OrdinalIgnoreCase);
        var boardCards = board.p1Bench.Concat(board.p2Bench)
            .Concat(new[] { board.p1Active, board.p2Active }.OfType<CardEntity>())
            .Where(KnownCard).ToDictionary(card => card.entityID, StringComparer.Ordinal);
        // Meganium's visible Wild Growth changes Basic Grass Energy from one
        // unit to two. The current engine total can be admitted only after it
        // matches the fully visible Basic attachments. A newly attached unit
        // cannot use the old single-unit counterfactual while this modifier is
        // present. Special Energy stays masked by BasicUnit below.
        var valueModifierVisible = boardCards.Values.Any(card => card.cardSourceID == "me1_10");
        var offered = ((JArray)view["actions"]!).Children<JObject>().ToArray();
        var prompts = ((JArray)view["prompts"]!).Children<JObject>().ToArray();
        var legalKnown = view.Value<string>("status") == "playing"
            && view.Value<string>("turn") == "you" && prompts.Length == 0;
        var facts = new JArray(boardCards.Values.Select(card => CreatureEnergy(card, null, false)));
        var attachments = new JArray();
        foreach (var offer in offered)
        {
            var sourceId = offer.Value<string>("sourceCardId");
            var targetId = offer.Value<string>("targetId");
            if (sourceId == null || targetId == null || !boardCards.TryGetValue(targetId, out var target)) continue;
            var source = (viewerOne ? board.p1Hand : board.p2Hand).FirstOrDefault(card => card.entityID == sourceId);
            if (source == null || CardCache.Get(source.cardSourceID).cardFormat is not (CardFormat.BasicEnergy or CardFormat.SpecialEnergy)) continue;
            var option = AttachmentEnergy(source, target);
            option["actionId"] = offer["id"]!.DeepClone();
            attachments.Add(option);
        }
        foreach (var prompt in prompts)
        foreach (var choice in ((JArray)prompt["choices"]!).Children<JObject>())
        {
            var sourceFace = choice["sourceCard"] as JObject;
            var sourceId = choice.Value<string>("sourceCardId");
            var targetId = choice.Value<string>("targetId");
            if (sourceFace == null || sourceId == null || targetId == null
                || !boardCards.TryGetValue(targetId, out var target)) continue;
            var definition = sourceFace.Value<string>("definitionId");
            var program = bundle.Programs.Cards.FirstOrDefault(card => card.cardSourceID == definition);
            if (program?.cardFormat is not (CardFormat.BasicEnergy or CardFormat.SpecialEnergy)) continue;
            var unit = "";
            var known = bounded && !valueModifierVisible && sourceFace.Value<string>("owner") == "you" && BasicUnit(program, out unit);
            var option = new JObject
            {
                ["sourceCardId"] = sourceId, ["targetId"] = targetId, ["known"] = known,
                ["after"] = known ? CreatureEnergy(target,
                    target.attachedEnergy.Any(energy => energy.entityID == sourceId) ? "" : unit, true) : null,
                ["promptId"] = prompt["id"]!.DeepClone(), ["choiceId"] = choice["id"]!.DeepClone(),
            };
            attachments.Add(option);
        }
        return new JObject { ["schema"] = "model6-energy/1", ["creatures"] = facts, ["attachmentOptions"] = attachments };

        JObject AttachmentEnergy(CardEntity source, CardEntity target)
        {
            var unit = "";
            var known = bounded && !valueModifierVisible && source.isPlayer1 == viewerOne && BasicUnit(CardCache.Get(source.cardSourceID), out unit);
            return new JObject
            {
                ["sourceCardId"] = source.entityID, ["targetId"] = target.entityID, ["known"] = known,
                ["after"] = known ? CreatureEnergy(target, unit, true) : null,
            };
        }

        JObject CreatureEnergy(CardEntity card, string? appendedUnit, bool hypothetical)
        {
            var attachedBasicsKnown = bounded && card.attachedEnergy.All(energy => KnownCard(energy)
                && BasicUnit(CardCache.Get(energy.cardSourceID), out _));
            var engineSupply = attachedBasicsKnown ? card.GetTotalEnergy(state) : "";
            var expectedBasicSupply = attachedBasicsKnown ? string.Concat(card.attachedEnergy.Select(energy =>
            {
                BasicUnit(CardCache.Get(energy.cardSourceID), out var unit);
                return unit;
            })) : "";
            // A native Energy-value effect, including Wild Growth, must never
            // be reported as if unmodified Basic attachments supplied it.
            var suppliedKnown = attachedBasicsKnown && SameUnits(engineSupply, expectedBasicSupply);
            var supplied = suppliedKnown ? engineSupply + (appendedUnit ?? "") : "";
            var attacks = new JArray();
            foreach (var attack in card.GetUseActions(onlyActionsOnEntity: true).OfType<CardAction>()
                .Where(action => action.actionType == ActionType.Attack))
            {
                var actionKey = card.cardSourceID + "/" + attack.actionSourceID;
                // Bloodmoon Ursaluna has a prize/history-sensitive cost
                // modifier. Other effective alternatives are admitted only
                // when the native cost equals this visible printed cost.
                var nativeCosts = bounded && attack.conditionalEnergyCosts.Count == 0
                    && card.cardSourceID != "sv6_141"
                    ? card.GetAllEnergyCostsForAction(state, attack, out _).ToArray() : [];
                var effectiveKnown = nativeCosts.Length > 0
                    && nativeCosts.All(cost => SameUnits(cost, attack.GetPrimaryEnergyCost()));
                var alternatives = new JArray();
                if (effectiveKnown)
                foreach (var cost in nativeCosts)
                {
                    var missing = new List<string>();
                    var payable = suppliedKnown && MatchUtils.EnergyValueContained(supplied, cost, missing);
                    alternatives.Add(new JObject
                    {
                        ["costUnits"] = Units(cost), ["missingUnits"] = new JArray(missing),
                        ["payable"] = suppliedKnown ? payable : (bool?)null,
                    });
                }
                var energyKnown = suppliedKnown && effectiveKnown;
                var attackLegalKnown = legalKnown && card.isPlayer1 == viewerOne && !hypothetical;
                attacks.Add(new JObject
                {
                    ["actionKey"] = actionKey, ["printedKnown"] = true, ["printedUnits"] = Units(attack.GetPrimaryEnergyCost()),
                    ["effectiveKnown"] = effectiveKnown, ["alternatives"] = alternatives,
                    ["energyKnown"] = energyKnown,
                    ["energyPayable"] = energyKnown ? alternatives.Children<JObject>().Any(cost => cost.Value<bool>("payable")) : (bool?)null,
                    ["attackLegalKnown"] = attackLegalKnown,
                    ["attackLegal"] = attackLegalKnown ? offered.Any(offer => offer.Value<string>("kind") == "attack"
                        && offer.Value<string>("sourceCardId") == card.entityID && offer.Value<string>("actionKey") == actionKey) : (bool?)null,
                });
            }
            // The cohort contains retreat-cost passives and temporary retreat
            // blocks (including Latias ex, Air Balloon and Clutch). Their
            // applicability has not been proved from this projection alone.
            // Keep cohort retreat arithmetic unknown until that review lands.
            var retreatKnown = suppliedKnown && bundle.CardsHash.Equals(OriginalEnergyCardsHash,
                StringComparison.OrdinalIgnoreCase);
            var retreatCost = retreatKnown ? card.GetRetreatCost(state) : 0;
            var retreatMissing = new List<string>();
            var retreatPayable = retreatKnown && MatchUtils.EnergyValueContained(supplied,
                string.Concat(Enumerable.Repeat("{C}", retreatCost)), retreatMissing);
            return new JObject
            {
                ["instanceId"] = card.entityID, ["suppliedKnown"] = suppliedKnown,
                ["suppliedUnits"] = suppliedKnown ? Units(supplied) : new JArray(), ["attacks"] = attacks,
                ["retreat"] = new JObject
                {
                    ["known"] = retreatKnown, ["cost"] = retreatKnown ? retreatCost : (int?)null,
                    ["missing"] = retreatKnown ? retreatMissing.Count : (int?)null,
                    ["payable"] = retreatKnown ? retreatPayable : (bool?)null,
                },
            };
        }
    }

    private static bool BasicUnit(CardSource program, out string unit)
    {
        unit = "";
        if (program.cardFormat != CardFormat.BasicEnergy || program.energyValues.Count != 1
            || program.energyValues[0].conditions.Count != 0) return false;
        unit = program.energyValues[0].value;
        return Regex.IsMatch(unit, @"^\{[GRWLPFDMYC]\}$");
    }

    private static JArray Units(string energy) => new(Regex.Matches(energy, @"\{([^}]+)\}")
        .Select(match => match.Groups[1].Value));

    private static bool SameUnits(string first, string second)
    {
        if (Regex.Replace(first, @"\{[^}]+\}", "").Length != 0
            || Regex.Replace(second, @"\{[^}]+\}", "").Length != 0) return false;
        static string[] Sorted(string energy) => Regex.Matches(energy, @"\{([^}]+)\}")
            .Select(match => match.Groups[1].Value).Order(StringComparer.Ordinal).ToArray();
        return Sorted(first).SequenceEqual(Sorted(second), StringComparer.Ordinal);
    }
}
