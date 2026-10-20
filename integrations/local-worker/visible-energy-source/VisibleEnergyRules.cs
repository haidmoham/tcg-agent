using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MatchLogic;

namespace Indigo.VisibleRules;

// Shared by the standalone Live feature service and an opt-in future native
// projection. No board, account, SDK, client, process, model or strategy access.
public static class VisibleEnergyRules
{
    private static JsonNode Required(JsonNode node, string key) => node[key] ?? throw new InvalidDataException("missing " + key);
    private static bool Flag(JsonNode node, string key) => Required(node, key).GetValue<bool>();
    private static string Id(JsonNode node, string key)
    {
        var value = Required(node, key).GetValue<string>();
        return value.Length is > 0 and <= 512 ? value : throw new InvalidDataException("bounded visible reference required");
    }
    private static JsonArray List(JsonNode node, string key, int maximum)
    {
        var values = Required(node, key).AsArray();
        return values.Count <= maximum && values.All(value => value != null) ? values : throw new InvalidDataException("complete bounded list required");
    }
    private static string[] Units(JsonNode node)
    {
        var values = node.AsArray();
        if (values.Count > 100) throw new InvalidDataException("Energy unit bound");
        return values.Select(value => value?.GetValue<string>() ?? "").Select(value =>
            Regex.IsMatch(value, @"^(?:[GRWLPFDMYCN]|\*)(?:\|[GRWLPFDMYCN])*$")
                ? value : throw new InvalidDataException("unsupported Energy unit")).ToArray();
    }
    private static JsonArray Array(IEnumerable<string> values) => new(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
    private static string Energy(IEnumerable<string> units) => string.Concat(units.Select(value => "{" + value + "}"));

    private static (bool payable, List<string> missing) Payment(string[] supplied, string[] cost)
    {
        var missing = new List<string>();
        // Exact same recovered engine function used by MatchWorker.Energy.cs.
        // No second matching algorithm and no fabricated simulator board.
        var payable = MatchUtils.EnergyValueContained(Energy(supplied), Energy(cost), missing);
        return (payable, missing);
    }

    private static JsonObject Creature(JsonNode input, string? addedUnit = null, bool hypothetical = false)
    {
        var suppliedKnown = Flag(input, "suppliedKnown");
        var supplied = suppliedKnown ? Units(Required(input, "suppliedUnits")) : System.Array.Empty<string>();
        if (suppliedKnown && addedUnit != null) supplied = [.. supplied, addedUnit];
        var attacks = new JsonArray();
        foreach (var row in List(input, "attacks", 32))
        {
            var attack = row!;
            var printedKnown = Flag(attack, "printedKnown");
            var effectiveKnown = Flag(attack, "effectiveKnown");
            var energyKnown = suppliedKnown && effectiveKnown;
            var alternatives = new JsonArray();
            if (effectiveKnown)
            {
                var costs = List(attack, "costAlternatives", 32);
                if (costs.Count == 0) throw new InvalidDataException("known cost needs complete alternatives");
                foreach (var cost in costs)
                {
                    var units = Units(cost!);
                    var payment = energyKnown ? Payment(supplied, units) : (false, new List<string>());
                    alternatives.Add(new JsonObject { ["costUnits"] = Array(units), ["missingUnits"] = Array(payment.Item2),
                        ["payable"] = energyKnown ? JsonValue.Create(payment.Item1) : null });
                }
            }
            var legalKnown = !hypothetical && Flag(attack, "attackLegalKnown");
            attacks.Add(new JsonObject { ["actionKey"] = Id(attack, "actionKey"), ["printedKnown"] = printedKnown,
                ["printedUnits"] = printedKnown ? Array(Units(Required(attack, "printedUnits"))) : new JsonArray(),
                ["effectiveKnown"] = effectiveKnown, ["alternatives"] = alternatives, ["energyKnown"] = energyKnown,
                ["energyPayable"] = energyKnown ? JsonValue.Create(alternatives.Any(cost => cost!["payable"]!.GetValue<bool>())) : null,
                ["attackLegalKnown"] = legalKnown, ["attackLegal"] = legalKnown ? Required(attack, "attackLegal").DeepClone() : null });
        }
        var retreat = Required(input, "retreat");
        var retreatKnown = Flag(retreat, "costKnown") && suppliedKnown;
        var costValue = retreatKnown ? Required(retreat, "cost").GetValue<int>() : 0;
        if (costValue is < 0 or > 100) throw new InvalidDataException("retreat bound");
        var retreatPayment = retreatKnown ? Payment(supplied, Enumerable.Repeat("C", costValue).ToArray()) : (false, new List<string>());
        return new JsonObject { ["instanceId"] = Id(input, "instanceId"), ["suppliedKnown"] = suppliedKnown,
            ["suppliedUnits"] = Array(supplied), ["attacks"] = attacks,
            ["retreat"] = new JsonObject { ["known"] = retreatKnown, ["cost"] = retreatKnown ? JsonValue.Create(costValue) : null,
                ["missing"] = retreatKnown ? JsonValue.Create(retreatPayment.Item2.Count) : null,
                ["payable"] = retreatKnown ? JsonValue.Create(retreatPayment.Item1) : null } };
    }

    public static JsonObject Derive(JsonNode input)
    {
        if (input["schema"]?.GetValue<string>() != "visible-energy-input/1") throw new InvalidDataException("visible input schema required");
        var creatures = List(input, "creatures", 12).ToDictionary(row => Id(row!, "instanceId"), row => row!);
        var output = new JsonArray(creatures.Values.Select(row => (JsonNode)Creature(row)).ToArray());
        var attachments = new JsonArray();
        foreach (var row in List(input, "attachmentOptions", 512))
        {
            var option = row!;
            var source = Id(option, "sourceCardId"); var target = Id(option, "targetId");
            if (source == target) throw new InvalidDataException("attachment source and target must differ");
            if (!creatures.TryGetValue(target, out var creature)) throw new InvalidDataException("invisible attachment target");
            var known = Flag(option, "basicUnitKnown");
            var unit = known ? Id(option, "basicUnit") : null;
            if (known && !Regex.IsMatch(unit!, @"^[GRWLPFDMYC]$")) throw new InvalidDataException("known Basic Energy unit required");
            var item = new JsonObject { ["sourceCardId"] = source, ["targetId"] = target, ["known"] = known,
                ["after"] = known ? Creature(creature, Flag(option, "alreadyAttached") ? null : unit, true) : null };
            if (option["actionId"] != null) item["actionId"] = Id(option, "actionId");
            else { item["promptId"] = Id(option, "promptId"); item["choiceId"] = Id(option, "choiceId"); }
            attachments.Add(item);
        }
        return new JsonObject { ["schema"] = "model6-energy/1", ["creatures"] = output, ["attachmentOptions"] = attachments };
    }
}
