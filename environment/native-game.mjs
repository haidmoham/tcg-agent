import { PolicyView } from '../integrations/local-worker/model6-policy-view.mjs';
import { runTrainingEpisode } from '../integrations/local-worker/model6-training-episode.mjs';
import { isDeepStrictEqual } from 'node:util';

const seats = ['human', 'opponent'];

// Agents receive only their own safe observation and a current prompt validator.
// The existing native runner owns rules, helper fallback, budgets, audit and reap.
export async function runNativeGame(native, { agents, onObservation = () => {}, onDecision = () => {},
  onFrame = () => {}, runEpisode = runTrainingEpisode, ...options }) {
  if (seats.some(seat => !agents?.[seat])) throw Error('one fresh agent per seat required');
  if (agents.human === agents.opponent) throw Error('agent history must be owned by one seat');
  const projectors = Object.fromEntries(seats.map(seat => [seat, new PolicyView()]));
  const views = {}, pending = {};
  const counts = Object.fromEntries(seats.map(seat => [seat, {}]));
  const propose = async (seat, view, validate) => {
    if (views[seat]?.revision !== view.revision) throw Error('agent observation revision differs');
    const proposal = await agents[seat].propose(views[seat], { validate });
    const offered = [];
    pending[seat] = { ...proposal, offered };
    if (proposal.decisions == null) return null;
    return (function* () {
      for (const decision of proposal.decisions) { offered.push(structuredClone(decision)); yield decision; }
    })();
  };
  const result = await runEpisode(native, { ...options,
    async onFrame(event) {
      for (const seat of seats) {
        views[seat] = agents[seat].observe(projectors[seat].project(event.frame.views[seat]));
        pending[seat] = null;
        await onObservation({ seat, view: views[seat] });
      }
      await onFrame(event);
    },
    async decideOrdinary({ seat, view }) {
      const decisions = [...await propose(seat, view)];
      if (!Array.isArray(decisions) || decisions.length !== 1) throw Error('one ordinary decision required');
      return decisions[0];
    },
    decidePrompt: ({ seat, view, validate }) => propose(seat, view, validate),
    async onAcceptedDecision({ seat, decision }) {
      const proposal = pending[seat];
      const source = proposal?.decisions == null ? 'helper' : proposal.source;
      if (proposal?.decisions && !proposal.offered.some(value => isDeepStrictEqual(value, decision)))
        throw Error('accepted command differs from agent proposal');
      agents[seat].accepted(views[seat], decision);
      counts[seat][source] = (counts[seat][source] ?? 0) + 1;
      await onDecision({ seat, view: views[seat], decision, source, sample: proposal?.sample, encoded: proposal?.encoded });
    },
  });
  return { ...result, agents: Object.fromEntries(seats.map(seat => [seat, agents[seat].pins])), routes: counts };
}
