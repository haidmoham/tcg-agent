import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const take = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, copy(value[key])]));

// The runtime owns the actor-visibility boundary. This second whitelist keeps
// screen/navigation/transport metadata out of the retained game observation.
// Opponent hand faces and deck/prize containers are never accepted.
export function recordedActorObservation(runtime) {
  const match = runtime?.match;
  if (!match) return null;
  const card = value => {
    const result = take(value, ['instanceId', 'source', 'category', 'name', 'hp', 'damage', 'energy', 'currentRetreat', 'conditions', 'usableActions']);
    if (value.publicCards) result.publicCards = Object.fromEntries(['energy', 'tools', 'evolutions'].map(key => [key, value.publicCards[key].map(card)]));
    return result;
  };
  const side = (value, own) => {
    if (!own && value.hand != null) throw new Error('recording-opponent-hand-faces-rejected');
    for (const key of ['deck', 'prize', 'deckOrder', 'prizeOrder']) if (value[key] != null) throw new Error('recording-hidden-container-rejected');
    if (['handCount', 'deckCount', 'prizes'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) throw new Error('recording-hidden-zones-require-counts');
    return { ...take(value, ['handCount', 'deckCount', 'prizes']),
      ...(own ? { hand: value.hand.map(card) } : {}),
      ...Object.fromEntries(['active', 'bench', 'discard', 'stadium'].map(key => [key, value[key].map(card)])) };
  };
  return { schema: 'official-client-actor-observation/1',
    ...take(match, ['state', 'isMyTurn', 'turnNumber', 'gameOver', 'winner', 'finalReason']),
    you: side(match.you, true), opponent: side(match.opponent, false),
    actions: copy(match.actions), prompt: copy(match.prompt),
    uncertainty: {
      opponentHand: 'count-only', deckAndPrizes: 'counts-only; blind prompt slots have no identities',
      coverage: 'All fields and offers emitted by this source-pinned adapter; not a claim of complete client rule coverage.',
      unprojected: ['card text/mechanics require the pinned static corpus join', 'unexposed per-turn flags and modifiers remain unknown'],
    } };
}

// One single-writer, append-only journal per process session, including resumes. Proposals and
// dispatches are synced before input. A missing result after dispatch is an
// uncertain execution, never an implicit failure or a replay instruction.
export async function createDecisionRecording(folder, { gameId, candidate, pins }) {
  const sessionId = randomUUID(), journal = await open(join(folder, `private-decisions-${sessionId}.jsonl`), 'wx', 0o600);
  let sequence = 0, previous = null, observationSequence = 0, decisionSequence = 0, closed = false;
  const emit = async (event, payload) => {
    if (closed) throw new Error('decision-recording-closed');
    const value = { schema: 'official-client-decision-event/1', gameId, sessionId, sequence: ++sequence,
      at: Date.now(), previousRecordSha256: previous, event, ...copy(payload) };
    const recordSha256 = hash(value);
    await journal.appendFile(JSON.stringify({ ...value, recordSha256 }) + '\n');
    await journal.sync();
    previous = recordSha256;
    return value;
  };
  await emit('session', { candidate, pins, resumedSession: 'May follow another journal for the same local gameId; never fills missing historical decisions.' });
  return {
    sessionId,
    async observe(response, { revision, afterDecisionId = null } = {}) {
      const observationId = `${sessionId}/observation/${++observationSequence}`;
      await emit('observation', { observationId, revision, runtimeSnapshotHash: response.snapshotHash,
        actor: recordedActorObservation(response.result), afterDecisionId,
        terminalUi: copy(response.result?.terminalReason ?? null),
        driverContext: take(response.result?.match, ['menu', 'operationProcessing', 'acknowledgement', 'uiTransitionPending']) });
      return observationId;
    },
    async propose({ preObservationId, attribution, kind, policyInput, encodedInput = null, decision, resolvedDecision, ranking = null, offered }) {
      if (!preObservationId || !attribution?.id || !kind || !decision || !resolvedDecision) throw new Error('decision-recording-proposal-incomplete');
      const decisionId = `${sessionId}/decision/${++decisionSequence}`;
      await emit('proposal', { decisionId, preObservationId, attribution, kind,
        policyInput, encodedInput, decision, resolvedDecision, ranking, offered,
        pinsRef: sessionId, trainingEligible: false, trainingEligibilityReason: 'Requires verified semantic execution and explicit downstream dataset admission.' });
      return decisionId;
    },
    dispatch: (decisionId, request) => emit('dispatch', { decisionId, request }),
    result: (decisionId, result) => emit('execution-result', { decisionId, ...result }),
    link: (decisionId, observationId, status) => emit('observation-link', { decisionId, observationId, status,
      evidence: 'Observed subsequent state; state change alone does not prove the intended semantic action.', trainingEligible: false }),
    terminal: value => emit('terminal', value),
    note: value => emit('session-metadata', value),
    async close() { if (!closed) { closed = true; try { await journal.sync(); } finally { await journal.close(); } } },
  };
}
