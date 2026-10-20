using MatchLogic;
using Newtonsoft.Json.Linq;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private readonly Dictionary<string, OfferedPrompt> promptOffers = new(StringComparer.Ordinal);
    private sealed record OfferedPrompt(string Seat, int Revision, string SelectionId, string OperationId);

    private SelectionValidation ValidateSelection(string seat, JObject request, string promptId)
    {
        if (authority!.status != OperationStatus.WaitingForInput ||
            !promptOffers.TryGetValue(promptId, out var prompt) ||
            prompt.Seat != seat || prompt.Revision != revision)
            return Invalid("selection is no longer offered");
        var native = authority.GetPreviousSelection();
        if (native == null || native.isComplete || native.selectionID != prompt.SelectionId
            || native.operationID != prompt.OperationId || native.operationID != authority.operationID
            || native.matchID != matchId || native.selectingPlayerID != seatAccounts[seat])
            return Invalid("selection is no longer current");
        if (request.Value<bool?>("cancel") == true)
            return Invalid("this selection cannot be canceled");
        var tokens = request["choiceIds"] as JArray;
        var amounts = request["amounts"] as JArray;
        if (tokens != null && tokens.Any(x => x.Type != JTokenType.String))
            return Invalid("invalid choices");
        if (amounts != null && amounts.Any(x => x is not JObject)) return Invalid("invalid allocation");
        var entries = amounts?.Children<JObject>().ToList() ?? [];
        var amountIds = entries.Select(x => x.Value<string>("choiceId")).ToList();
        if (amountIds.Any(x => string.IsNullOrEmpty(x)) || amountIds.Count != amountIds.Distinct(StringComparer.Ordinal).Count())
            return Invalid("duplicate allocation entry");
        // The public allocation command sends choiceIds:[] and carries the
        // selected IDs in amounts. An empty array is therefore not a request
        // to discard valid allocation entries.
        var ids = tokens is { Count: > 0 } ? tokens.Values<string>().ToList() : amountIds;
        if (ids.Count != ids.Distinct(StringComparer.Ordinal).Count())
            return Invalid("a card was chosen more than once");
        if (entries.Count > 0 && (ids.Count != amountIds.Count || ids.Except(amountIds).Any() ||
            entries.Any(x => x.Value<int?>("count") is null or < 0 or > 1000)))
            return Invalid("invalid allocation");
        var counts = entries.ToDictionary(x => x.Value<string>("choiceId")!, x => x.Value<int>("count"), StringComparer.Ordinal);
        var selected = new List<OfferedChoice>();
        foreach (var id in ids)
        {
            if (id == null || !choices.TryGetValue(id, out var offered)
                || offered.Seat != seat || offered.Revision != revision || offered.PromptId != promptId)
                return Invalid("choice is no longer offered");
            selected.Add(offered);
        }
        var answer = native.CopySelection();
        try
        {
            switch (answer.variableSelection)
            {
                case TextSelection text:
                    if (counts.Count > 0 || selected.Count != 1 || selected[0].Group != -1
                        || text.options.ElementAtOrDefault(selected[0].Index) != selected[0].NativeIdentity)
                        return Invalid("invalid option");
                    text.selectedIndex = selected[0].Index;
                    break;
                case ActionSelection action:
                    if (counts.Count > 0 || selected.Count != 1 || selected[0].Group != -1) return Invalid("invalid action");
                    var actionOption = action.options.ElementAtOrDefault(selected[0].Index);
                    if (actionOption == null || !actionOption.isSelectable
                        || actionOption.actionGUID != selected[0].NativeIdentity)
                        return Invalid("action is no longer offered");
                    action.selectedIndex = selected[0].Index;
                    break;
                case EntitySelection entity:
                    var isAllocation = entity.selectionMethod == VariableSelectionSettings.SelectionMethod.ReparentDamage;
                    for (int group = 0; group < entity.selectionGroups.Count; group++)
                    {
                        var nativeGroup = entity.selectionGroups[group];
                        nativeGroup.selectedOptions.Clear();
                        var fromGroup = selected.Where(x => x.Group == group).ToList();
                        if (fromGroup.Select(x => x.NativeIdentity).Distinct(StringComparer.Ordinal).Count() != fromGroup.Count)
                            return Invalid("a card was chosen more than once");
                        foreach (var chosen in fromGroup)
                        {
                            var option = nativeGroup.validOptions.ElementAtOrDefault(chosen.Index);
                            if (option == null || option.entityID != chosen.NativeIdentity)
                                return Invalid("card is no longer offered");
                            var count = counts.GetValueOrDefault(chosen.Id, 1);
                            if (count == 0) return Invalid("a selected card needs a positive amount");
                            if (count > 1 && !isAllocation) return Invalid("a physical card was chosen more than once");
                            for (int unit = 0; unit < count; unit++)
                                nativeGroup.AddToSelectedOptionsByEntityID(option.entityID);
                        }
                    }
                    if (selected.Any(x => x.Group < 0 || x.Group >= entity.selectionGroups.Count))
                        return Invalid("invalid choice group");
                    break;
                case ReparentSelection reparent:
                    if (counts.Count > 0) return Invalid("attachment moves use choices");
                    if (selected.Select(x => x.NativeIdentity).Distinct(StringComparer.Ordinal).Count() != selected.Count)
                        return Invalid("an attachment was assigned more than once");
                    foreach (var chosen in selected)
                    {
                        var option = reparent.reparentOptions.ElementAtOrDefault(chosen.Index);
                        if (option == null || option.entityID != chosen.NativeIdentity ||
                            chosen.Group != chosen.Index || chosen.NativeTargetId == null ||
                            !reparent.toParents.Contains(chosen.NativeTargetId))
                            return Invalid("attachment destination is no longer offered");
                        option.SetNewParentEntityID(chosen.NativeTargetId);
                    }
                    if (selected.Count < reparent.minReparentedOptions ||
                        (reparent.maxReparentedOptions >= 0 && selected.Count > reparent.maxReparentedOptions))
                        return Invalid("attachment move count is out of range");
                    break;
                case DamageSelection damage:
                    if (counts.Count != selected.Count)
                        return Invalid("set final counter totals for chosen pokémon");
                    var from = damage.fromDamageSelections.Select(x => x.entityID).ToHashSet(StringComparer.Ordinal);
                    var to = damage.toDamageSelections.Select(x => x.entityID).ToHashSet(StringComparer.Ordinal);
                    foreach (var chosen in selected)
                    {
                        var final = damage.finalDamageSelections.ElementAtOrDefault(chosen.Index);
                        var expectedGroup = from.Contains(chosen.NativeIdentity) && to.Contains(chosen.NativeIdentity) ? 2
                            : from.Contains(chosen.NativeIdentity) ? 0 : 1;
                        if (final == null || final.entityID != chosen.NativeIdentity || chosen.Group != expectedGroup)
                            return Invalid("pokémon is no longer offered");
                        var next = counts[chosen.Id];
                        if (next > final.currentDamageCounters + damage.maxMovableDamageTotal ||
                            next < final.currentDamageCounters - damage.maxMovableDamageTotal)
                            return Invalid("damage amount is out of range");
                        final.newDamageCounters = next;
                    }
                    int sent = 0, received = 0, sourceCount = 0, targetCount = 0;
                    foreach (var final in damage.finalDamageSelections)
                    {
                        var change = final.newDamageCounters - final.currentDamageCounters;
                        if (change < 0)
                        {
                            if (!from.Contains(final.entityID)) return Invalid("source pokémon is invalid");
                            sent -= change; sourceCount++;
                        }
                        if (change > 0)
                        {
                            if (!to.Contains(final.entityID)) return Invalid("target pokémon is invalid");
                            received += change; targetCount++;
                        }
                    }
                    if (from.Count > 0 && to.Count > 0 && sent != received)
                        return Invalid("moved damage must balance");
                    var moved = Math.Max(sent, received);
                    if (moved < damage.minMovableDamageTotal || moved > damage.maxMovableDamageTotal ||
                        sourceCount < damage.minSourceSelectionCount || sourceCount > damage.maxSourceSelectionCount ||
                        targetCount < damage.minTargetSelectionCount || targetCount > damage.maxTargetSelectionCount)
                        return Invalid("damage move does not satisfy the current limits");
                    break;
                default:
                    return Invalid("unsupported native selection");
            }
            return answer.ValidateSelection()
                ? new SelectionValidation(true, "", answer)
                : Invalid("selection does not satisfy the current rules");
        }
        catch
        {
            return Invalid("selection does not satisfy the current rules");
        }
    }

    private static SelectionValidation Invalid(string reason) => new(false, reason, null);
}
