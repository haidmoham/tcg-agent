using MatchLogic;
using Newtonsoft.Json.Linq;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private void AddActions(string seat, JArray output)
    {
        var board = authority!.workingBoard;
        bool one = seat == "human";
        var player = one ? board.player1 : board.player2;
        var hand = one ? board.p1Hand : board.p2Hand;
        var active = one ? board.p1Active : board.p2Active;
        var bench = one ? board.p1Bench : board.p2Bench;
        var activePosition = one ? BoardPos.Player1Active : BoardPos.Player2Active;
        var benchPosition = one ? BoardPos.Player1Bench : BoardPos.Player2Bench;

        void Offer(OperationType operationType, CardEntity? origin, string actionGuid,
            CardEntity? target, BoardPos position, string kind, string label,
            string? actionKey = null, string? attackName = null)
        {
            if (origin == null) return;
            var operation = new PlayerOperation(operationType, matchId!, origin.entityID,
                actionGuid, target?.entityID ?? "", position, player.ownerPlayerId);
            if (!CanPerform(operation)) return;
            var id = Guid.NewGuid().ToString("N");
            actions.Add(id, new OfferedAction(seat, revision, operation));
            output.Add(new JObject
            {
                ["id"] = id, ["label"] = label, ["kind"] = kind,
                ["sourceCardId"] = origin.entityID, ["actorId"] = origin.entityID,
                ["targetId"] = target?.entityID, ["attackName"] = attackName,
                ["actionKey"] = actionKey,
            });
        }

        foreach (var card in hand)
        {
            var source = CardCache.Get(card.cardSourceID);
            if (source.cardFormat == CardFormat.Pokemon)
            {
                if (source.cardStage == CardStage.Basic)
                {
                    if (active == null) Offer(OperationType.Place, card, "", null, activePosition,
                        "play", "place " + source.cardName + " active");
                    Offer(OperationType.Place, card, "", null, benchPosition,
                        "play", "bench " + source.cardName);
                }
                else foreach (var target in bench.Prepend(active).Where(x => x != null))
                    Offer(OperationType.Evolve, card, "", target, BoardPos.Board,
                        "play", "evolve " + target!.cardName + " into " + source.cardName);
            }
            else if (source.cardFormat is CardFormat.BasicEnergy or CardFormat.SpecialEnergy or CardFormat.TrainerTool)
            {
                foreach (var target in bench.Prepend(active).Where(x => x != null))
                    Offer(OperationType.Attach, card, "", target, BoardPos.Board,
                        "play", "attach " + source.cardName + " to " + target!.cardName);
            }
            else if (source.cardFormat == CardFormat.TrainerStadium)
                Offer(OperationType.Place, card, "", null, BoardPos.BoardStadium,
                    "play", "place " + source.cardName + " stadium");
            foreach (var action in card.GetUseActions(onlyActionsOnEntity: true))
                Offer(OperationType.Use, card, action.actionGuid, null, BoardPos.Board,
                    action.actionType == ActionType.Attack ? "attack" : action.actionType == ActionType.Ability ? "ability" : "play",
                    source.cardName + ": " + action.actionName,
                    source.cardSourceID + "/" + action.actionSourceID,
                    action.actionType == ActionType.Attack ? action.actionName : null);
        }

        foreach (var card in bench.Prepend(active).Where(x => x != null))
        {
            foreach (var action in card!.GetUseActions(onlyActionsOnEntity: false))
            {
                var source = CardCache.Get(card.cardSourceID);
                Offer(OperationType.Use, card, action.actionGuid, null, BoardPos.Board,
                    action.actionType == ActionType.Attack ? "attack" : "ability",
                    source.cardName + ": " + action.actionName,
                    source.cardSourceID + "/" + action.actionSourceID,
                    action.actionType == ActionType.Attack ? action.actionName : null);
            }
        }
        if (active != null)
            Offer(OperationType.Retreat, active, "", null, BoardPos.Board, "retreat", "retreat active pokémon");
        var end = new PlayerOperation(OperationType.End, matchId!, player.entityID, "", "", BoardPos.Board, player.ownerPlayerId);
        if (CanPerform(end))
        {
            var id = Guid.NewGuid().ToString("N");
            actions.Add(id, new OfferedAction(seat, revision, end));
            output.Add(new JObject { ["id"] = id, ["label"] = "end turn", ["kind"] = "pass" });
        }
    }

    private void AddPrompt(string seat, JArray output)
    {
        var selection = authority!.GetPreviousSelection();
        if (selection == null || selection.isComplete || selection.selectingPlayerID != seatAccounts[seat]
            || selection.matchID != matchId || selection.operationID != authority.operationID)
            return;
        var promptId = Guid.NewGuid().ToString("N");
        promptOffers.Add(promptId, new OfferedPrompt(seat, revision, selection.selectionID, selection.operationID));
        var promptChoices = new JArray();
        var groups = new JArray();
        int minimum = 1, maximum = 1;
        string kind;
        var variable = selection.variableSelection;
        var ordered = variable is EntitySelection sequence
            && sequence.variableSelectionSettings is EntitySelectionSettings settings && settings.orderedPlacement;
        switch (variable)
        {
            case TextSelection text:
                kind = "select";
                for (int index = 0; index < text.options.Count; index++)
                {
                    if (text.options[index] == "REMOVED_OPTION") continue;
                    AddChoice(index, -1, text.options[index], IsStartingTurnChoice(text)
                        ? index == 0 ? "go first" : "go second"
                        : HumanOption(text.options[index]));
                }
                break;
            case ActionSelection action:
                kind = "select";
                for (int index = 0; index < action.options.Count; index++)
                {
                    var option = action.options[index];
                    if (!option.isSelectable) continue;
                    var nativeAction = authority.workingBoard.GetActionByGUID(option.actionGUID);
                    var label = nativeAction?.actionName ?? "action " + (index + 1);
                    var choice = AddChoice(index, -1, option.actionGUID, label);
                    var entity = authority.workingBoard.GetEntityByID(option.parentEntityID) as CardEntity;
                    if (entity != null)
                        choice["actionKey"] = entity.cardSourceID + "/" + option.actionSourceID;
                }
                break;
            case EntitySelection entity:
                kind = entity.selectionMethod switch
                {
                    VariableSelectionSettings.SelectionMethod.Prize => "prizes",
                    VariableSelectionSettings.SelectionMethod.Board or VariableSelectionSettings.SelectionMethod.DragActive => "pokemon",
                    VariableSelectionSettings.SelectionMethod.ReparentDamage => "allocation",
                    _ => "cards",
                };
                minimum = entity.totalMinAmount; maximum = entity.totalMaxAmount;
                for (int group = 0; group < entity.selectionGroups.Count; group++)
                {
                    var nativeGroup = entity.selectionGroups[group];
                    var groupId = Guid.NewGuid().ToString("N");
                    groups.Add(new JObject
                    {
                        ["id"] = groupId, ["label"] = "group " + (group + 1),
                        ["min"] = nativeGroup.minAmount, ["max"] = nativeGroup.maxAmount,
                    });
                    for (int index = 0; index < nativeGroup.validOptions.Count; index++)
                    {
                        var option = nativeGroup.validOptions[index];
                        var choice = AddChoice(index, group, option.entityID,
                            SafeOptionLabel(option.cardAddress, group, index));
                        choice["group"] = groupId;
                        var visible = SafeOptionCard(option.cardAddress);
                        if (visible != null)
                        {
                            choice["card"] = visible;
                            choice["instanceId"] = visible["instanceId"]?.DeepClone();
                        }
                        if (entity.selectionMethod == VariableSelectionSettings.SelectionMethod.ReparentDamage)
                            choice["maxAmount"] = Math.Max(0, Math.Min(entity.totalMaxAmount,
                                nativeGroup.maxAmount < 0 ? entity.totalMaxAmount : nativeGroup.maxAmount));
                    }
                    if (nativeGroup.validOptions.Any(option => option.cardAddress.pos is BoardPos.Player1Deck or BoardPos.Player2Deck))
                    {
                        // Answer IDs retain their native indexes privately. A
                        // searchable deck must not disclose its relative order.
                        var canonical = promptChoices.Children<JObject>().Where(choice => choice.Value<string>("group") == groupId)
                            .OrderBy(choice => choice["card"]?.Value<string>("printingId") ?? "", StringComparer.Ordinal)
                            .ThenBy(choice => choice["card"]?.Value<string>("name") ?? "", StringComparer.Ordinal)
                            .ThenBy(choice => choice["card"]?.Value<string>("instanceId") ?? choice.Value<string>("id"), StringComparer.Ordinal)
                            .ToList();
                        foreach (var choice in canonical) choice.Remove();
                        foreach (var choice in canonical) promptChoices.Add(choice);
                    }
                }
                break;
            case ReparentSelection reparent:
                kind = "cards";
                minimum = reparent.minReparentedOptions;
                maximum = reparent.maxReparentedOptions < 0 ? reparent.reparentOptions.Count : reparent.maxReparentedOptions;
                for (int sourceIndex = 0; sourceIndex < reparent.reparentOptions.Count; sourceIndex++)
                {
                    var item = reparent.reparentOptions[sourceIndex];
                    var groupId = Guid.NewGuid().ToString("N");
                    var source = authority.workingBoard.GetEntityByID(item.entityID) as CardEntity;
                    var sourceLabel = source == null ? "attachment " + (sourceIndex + 1) :
                        SafeOptionCard(new CardAddress(source))?.Value<string>("name") ?? "attachment " + (sourceIndex + 1);
                    groups.Add(new JObject { ["id"] = groupId, ["label"] = sourceLabel, ["min"] = 0, ["max"] = 1 });
                    foreach (var targetId in reparent.toParents)
                    {
                        var target = authority.workingBoard.GetEntityByID(targetId) as CardEntity;
                        var visible = target == null ? null : SafeOptionCard(new CardAddress(target));
                        var targetLabel = target == null || visible == null ? "target" : BoardOptionLabel(target, visible);
                        var choice = AddChoice(sourceIndex, sourceIndex, item.entityID, sourceLabel + " → " + targetLabel, targetId);
                        choice["group"] = groupId;
                        if (visible != null)
                        {
                            choice["card"] = visible;
                            choice["instanceId"] = visible["instanceId"]?.DeepClone();
                        }
                    }
                }
                break;
            case DamageSelection damage:
                kind = "allocation";
                minimum = damage.minMovableDamageTotal;
                maximum = damage.maxMovableDamageTotal;
                var fromIds = damage.fromDamageSelections.Select(x => x.entityID).ToHashSet(StringComparer.Ordinal);
                var toIds = damage.toDamageSelections.Select(x => x.entityID).ToHashSet(StringComparer.Ordinal);
                var sourceGroup = Guid.NewGuid().ToString("N");
                var targetGroup = Guid.NewGuid().ToString("N");
                var bothGroup = Guid.NewGuid().ToString("N");
                groups.Add(new JObject { ["id"] = sourceGroup, ["label"] = "move from",
                    ["min"] = damage.minSourceSelectionCount, ["max"] = damage.maxSourceSelectionCount });
                groups.Add(new JObject { ["id"] = targetGroup, ["label"] = "move to",
                    ["min"] = damage.minTargetSelectionCount, ["max"] = damage.maxTargetSelectionCount });
                for (int index = 0; index < damage.finalDamageSelections.Count; index++)
                {
                    var entry = damage.finalDamageSelections[index];
                    var card = authority.workingBoard.GetEntityByID(entry.entityID) as CardEntity;
                    var visible = card == null ? null : SafeOptionCard(new CardAddress(card));
                    var label = (visible == null || card == null ? "pokémon " + (index + 1) : BoardOptionLabel(card, visible))
                        + $" — {entry.currentDamageCounters} damage counters now";
                    var inFrom = fromIds.Contains(entry.entityID);
                    var inTo = toIds.Contains(entry.entityID);
                    var group = inFrom && inTo ? 2 : inFrom ? 0 : 1;
                    var choice = AddChoice(index, group, entry.entityID, label);
                    choice["group"] = group switch { 0 => sourceGroup, 1 => targetGroup, _ => bothGroup };
                    choice["initialAmount"] = entry.currentDamageCounters;
                    var globalLimit = Math.Max(0, damage.maxMovableDamageTotal);
                    var sendLimit = damage.maxSendDamageSingle < 0
                        ? entry.currentDamageCounters : Math.Max(0, damage.maxSendDamageSingle);
                    var receiveLimit = damage.maxRecvDamageSingle < 0
                        ? globalLimit : Math.Max(0, damage.maxRecvDamageSingle);
                    choice["minAmount"] = inFrom
                        ? Math.Max(0, entry.currentDamageCounters - Math.Min(globalLimit, sendLimit))
                        : entry.currentDamageCounters;
                    choice["maxAmount"] = inTo
                        ? (int)Math.Min(int.MaxValue, (long)entry.currentDamageCounters + Math.Min(globalLimit, receiveLimit))
                        : entry.currentDamageCounters;
                    if (visible != null) choice["card"] = visible;
                }
                if (damage.finalDamageSelections.Any(x => fromIds.Contains(x.entityID) && toIds.Contains(x.entityID)))
                    groups.Add(new JObject { ["id"] = bothGroup, ["label"] = "move from or to", ["min"] = 0,
                        ["max"] = damage.finalDamageSelections.Count });
                break;
            default:
                throw new InvalidOperationException("unsupported native selection: " + variable.GetType().Name);
        }
        output.Add(new JObject
        {
            ["id"] = promptId, ["kind"] = kind,
            ["title"] = ContextTitle(selection, variable),
            ["detail"] = PromptDetail(variable),
            ["confirmLabel"] = PromptConfirmLabel(variable),
            ["min"] = minimum, ["max"] = maximum,
            ["cancelable"] = false, ["choices"] = promptChoices, ["groups"] = groups,
            ["ordered"] = ordered, ["allocationUnit"] = kind == "allocation" ? 10 : null,
            ["allocationMode"] = variable is DamageSelection ? "final" : kind == "allocation" ? "add" : null,
            ["requiresPreview"] = true,
        });

        JObject AddChoice(int index, int group, string nativeIdentity, string label, string? target = null)
        {
            var id = Guid.NewGuid().ToString("N");
            choices.Add(id, new OfferedChoice(id, seat, revision, promptId, group, index, nativeIdentity, target));
            var choice = new JObject { ["id"] = id, ["label"] = label };
            promptChoices.Add(choice);
            return choice;
        }
    }

    private string ContextTitle(PlayerSelection selection, VariableSelection variable)
    {
        var title = PromptTitle(variable);
        var source = authority!.workingBoard.GetEntityByID(selection.originCardEntityID) as CardEntity;
        if (source?.currentGamePos is BoardPos.Player1Deck or BoardPos.Player2Deck)
            return title;
        var visible = source == null ? null : SafeOptionCard(new CardAddress(source));
        if (visible != null && variable is TextSelection text && text.GetLocId() == "optional_action"
            && text.options.SequenceEqual(["option1_yes", "option2_no"]))
        {
            var action = source!.GetActionByGUID(selection.originActionRefID);
            if (action?.actionType == ActionType.Ability && !string.IsNullOrWhiteSpace(action.actionName))
            {
                const string abilityPrefix = "[Ability] ";
                var abilityName = action.actionName.StartsWith(abilityPrefix, StringComparison.Ordinal)
                    ? action.actionName[abilityPrefix.Length..] : action.actionName;
                return visible.Value<string>("name") + ": use " + abilityName + "?";
            }
        }
        return visible == null ? title : visible.Value<string>("name") + ": " + title;
    }

    private string SafeOptionLabel(CardAddress address, int group, int index)
    {
        var visible = SafeOptionCard(address);
        var card = authority!.workingBoard.GetEntityByID(address.entityID) as CardEntity;
        return visible == null || card == null ? $"card {index + 1} in group {group + 1}" : BoardOptionLabel(card, visible);
    }

    private string BoardOptionLabel(CardEntity card, JObject visible)
    {
        var name = visible.Value<string>("name")!;
        var selectingOne = authority!.GetPreviousSelection().selectingPlayerID == seatAccounts["human"];
        var position = card.currentGamePos;
        var sideOne = position is BoardPos.Player1Active or BoardPos.Player1Bench;
        if (position is not (BoardPos.Player1Active or BoardPos.Player2Active or BoardPos.Player1Bench or BoardPos.Player2Bench))
            return name;
        var owner = sideOne == selectingOne ? "your" : "opponent’s";
        if (position is BoardPos.Player1Active or BoardPos.Player2Active)
            return name + " · " + owner + " active";
        // Use the same stable public layout as the table, rather than native
        // insertion order, which changes when a Pokémon evolves.
        var bench = benchDisplayOrder.GetValueOrDefault(sideOne ? "human" : "opponent");
        var index = bench?.IndexOf(card.entityID) ?? -1;
        return name + " · " + owner + " bench" + (index < 0 ? "" : " " + (index + 1));
    }

    private JObject? SafeOptionCard(CardAddress address)
    {
        var pos = address.pos;
        if (pos is BoardPos.Player1Prize or BoardPos.Player2Prize
            or BoardPos.Player1HiddenPending or BoardPos.Player2HiddenPending)
            return null;
        // Selection options are sent only to their selecting seat. Opponent hand
        // identities are withheld even if a native option references that zone.
        var selectingOne = authority!.GetPreviousSelection().selectingPlayerID == seatAccounts["human"];
        if ((selectingOne && pos == BoardPos.Player2Deck) || (!selectingOne && pos == BoardPos.Player1Deck))
            return null;
        if ((selectingOne && pos == BoardPos.Player2Hand) || (!selectingOne && pos == BoardPos.Player1Hand))
            return null;
        var card = authority.workingBoard.GetEntityByID(address.entityID) as CardEntity;
        return card == null || card.cardSourceID == "PRIVATE" ? null : VisibleCard(card);
    }

    private static string HumanOption(string option) => option switch
    {
        "option_heads" => "heads", "option_tails" => "tails",
        "match_coin_flip_result_heads" => "heads", "match_coin_flip_result_tails" => "tails",
        "option1_yes" => "yes", "option2_no" => "no",
        "option_yes" => "yes", "option_no" => "no",
        "option_rock" => "rock", "option_paper" => "paper", "option_scissors" => "scissors",
        _ => option.Replace('_', ' '),
    };

    private static bool IsStartingTurnChoice(TextSelection text) =>
        text.GetLocId() == "pl_calling_turn" && text.options.SequenceEqual(["option1_yes", "option2_no"]);

    private static bool IsActivePromotion(EntitySelection entity) =>
        entity.GetLocId() == "select_active" &&
        entity.selectionMethod == VariableSelectionSettings.SelectionMethod.Board;

    private static string PromptDetail(VariableSelection selection) => selection switch
    {
        EntitySelection entity when IsActivePromotion(entity) =>
            "choose a benched pokémon to move into the active spot",
        TextSelection text when IsStartingTurnChoice(text) => "choose whether to take the first turn",
        TextSelection text when text.GetLocId() == "pl_calling_starting_coin" => "call heads or tails",
        TextSelection text when text.GetLocId() == "mulligan_how_many" =>
            "your opponent mulliganed. choose how many bonus cards to draw.",
        DamageSelection => "set final damage counters for each pokémon; one counter is 10 damage",
        ReparentSelection => "choose each attachment and its destination",
        EntitySelection entity when entity.selectionMethod == VariableSelectionSettings.SelectionMethod.Prize =>
            "choose the prize cards to take",
        _ => "choose from the current options",
    };

    private static string? PromptConfirmLabel(VariableSelection selection) => selection switch
    {
        EntitySelection entity when IsActivePromotion(entity) => "make active",
        TextSelection text when IsStartingTurnChoice(text) => "confirm turn order",
        DamageSelection damage when damage.fromDamageSelections.Count == 0 => "place counters",
        DamageSelection => "move counters",
        EntitySelection entity when entity.selectionMethod == VariableSelectionSettings.SelectionMethod.Prize =>
            "take prize cards",
        _ => null,
    };

    private static string PromptTitle(VariableSelection selection) => selection.GetLocId() switch
    {
        "select_active" when selection is EntitySelection entity && IsActivePromotion(entity) =>
            "choose your next active pokémon",
        "mulligan_how_many" => "draw bonus cards",
        "pl_calling_starting_coin" => "call the coin flip",
        "pl_calling_turn" when selection is TextSelection text && IsStartingTurnChoice(text) =>
            "choose who goes first",
        _ => SelectionTitle(selection),
    };

    private static string SelectionTitle(VariableSelection selection) => selection switch
    {
        EntitySelection => "choose cards",
        ReparentSelection => "move attachments",
        DamageSelection damage when damage.fromDamageSelections.Count == 0 => "place damage counters",
        DamageSelection => "move damage counters",
        ActionSelection => "choose an action",
        TextSelection => "choose an option",
        _ => "choose",
    };
}
