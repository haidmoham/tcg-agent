using MatchLogic;

namespace Indigo.Live.Engine;

internal sealed partial class MatchWorker
{
    private MatchWorker(Bundle sharedBundle)
    {
        FreezeOfflineClock();
        bundle = sharedBundle;
    }

    internal MatchWorker NextOfflineMatch(string incomingEpoch, string incomingMatch)
    {
        if (IsStopped || failed || authority == null || !authority.workingBoard.isGameOver
            || authority.status != OperationStatus.Finished || Terminal() == null)
            throw new InvalidOperationException("offline reset requires a successful terminal match");
        if (!Guid.TryParse(incomingEpoch, out _) || !Guid.TryParse(incomingMatch, out _)
            || incomingEpoch == epoch || incomingMatch == matchId)
            throw new InvalidDataException("offline reset requires fresh identities");
        return new MatchWorker(bundle);
    }
}
