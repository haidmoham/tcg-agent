using MatchLogic;
using Newtonsoft.Json.Linq;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private const string OfflineTurnProfile = "private-two-deck-2026-10-11/is-turn-v1";
    private bool offlineTurnProfileAdmitted;
    private bool offlineVerifyTurnPreflight;
    private long offlineValidationProposals;
    private readonly Dictionary<OperationType, long> offlineValidationByOperation = new();
    private long offlineTurnRejections;
    private long offlineTurnVerifiedRejections;

    private JObject OfflineTurnStatistics()
    {
        if (authority == null) throw new InvalidOperationException("offline authority missing");
        return new JObject
        {
            ["profile"] = offlineTurnProfileAdmitted ? OfflineTurnProfile : null,
            ["verifyTurnPreflight"] = offlineVerifyTurnPreflight,
            ["validationProposals"] = offlineValidationProposals,
            ["turnPreflightRejections"] = offlineTurnRejections,
            ["turnPreflightVerifiedRejections"] = offlineTurnVerifiedRejections,
        };
    }

    private void ConfigureOfflineTurnPreflight(bool verify)
    {
        offlineTurnProfileAdmitted = offlineCopyMode == "projection-turn-v1"
            && HashEquals(bundle.RuntimeHash, "01e936b0ed9d886e7d3f9b8405653be81ba2371a0f33b5638fe134c8fc7154f5")
            && (HashEquals(bundle.CardsHash, "c0921867b46497adf2ea5773ca579e3e5cb002df65a905b1221cf14c180febe2") || HashEquals(bundle.CardsHash, "3b7e00e4c023a35f62d129a26ba8f00f0fc6ae9374b7b66e4ff57d8a4df8e15f"))
            && HashEquals(bundle.RulesHash, "c01fb0470f1105354f11e5a268a213ab9dbc7bfc01a8fd3e64e3313b998681e5");
        offlineVerifyTurnPreflight = offlineCopyMode == "projection-turn-v1" && verify;
    }

    private bool CanPerform(PlayerOperation operation)
    {
        offlineValidationProposals++;
        offlineValidationByOperation.TryGetValue(operation.operationType, out var proposals);
        offlineValidationByOperation[operation.operationType] = proposals + 1;
        if (!OfflineRejectsTurn(operation)) return NativeCanPerform(operation);
        offlineTurnRejections++;
        if (offlineVerifyTurnPreflight)
        {
            if (NativeCanPerform(operation))
                throw new InvalidOperationException("offline turn preflight rejected a native legal operation");
            offlineTurnVerifiedRejections++;
        }
        return false;
    }

    private bool OfflineRejectsTurn(PlayerOperation operation)
    {
        if (!offlineTurnProfileAdmitted || authority == null
            || !Enum.IsDefined(operation.operationType)
            || operation.operationType is OperationType.Quit or OperationType.TimeoutForceQuit
            || string.IsNullOrEmpty(operation.accountID) || string.IsNullOrEmpty(operation.originEntityID)) return false;
        var board = authority.workingBoard;
        if (board.boardEntity is not { gameMode: GameMode.Standard, debug: false } root
            || board.player1 is not { isPlayer1: true } one || board.player2 is not { isPlayer1: false } two
            || string.IsNullOrEmpty(one.ownerPlayerId) || string.IsNullOrEmpty(two.ownerPlayerId)
            || one.ownerPlayerId == two.ownerPlayerId
            || operation.accountID != one.ownerPlayerId && operation.accountID != two.ownerPlayerId) return false;
        var origin = board.GetEntityByID(operation.originEntityID);
        if (origin == null || origin is BoardEntity || ReferenceEquals(origin, root)) return false;
        var actor = operation.accountID == one.ownerPlayerId ? one : two;
        if (!actor.HasMetaData(MetaDataKey.PlayerSetupState) || !root.HasMetaData(MetaDataKey.GameCurrentPlayer)
            || actor.GetMetaData<int>(MetaDataKey.PlayerSetupState) <= 0) return false;
        var current = root.GetMetaData<int>(MetaDataKey.GameCurrentPlayer);
        return (current is 1 or 2) && current != (actor.isPlayer1 ? 1 : 2);
    }
}
