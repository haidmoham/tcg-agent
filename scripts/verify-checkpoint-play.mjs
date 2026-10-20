import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PlaySession, humanPresentation } from '../play/session.mjs';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node scripts/verify-checkpoint-play.mjs <private-play-config.json> [receipt.json]');
const session = new PlaySession(JSON.parse(readFileSync(configPath, 'utf8')));
const receipt = { schema: 'checkpoint-play-verification/1', completedNaturally: false, humanSeat: 'one-step frozen helper assistance', ordinaryOpponent: 'saved checkpoint on CPU', checks: [], humanAssists: 0, privacyChecks: 0 };
const request = game => ({ requestId: randomUUID(), gameId: game.id, revision: game.view.revision });
const privacy = async () => session.serialized(async () => {
  const g = session.game;
  const variant = await g.worker.request('audit-privacy', { seat: 'human' });
  const baseline = humanPresentation(new PolicyView().project(g.frame.views.human), g.frame.views.human);
  const permuted = humanPresentation(new PolicyView().project(variant.view), variant.view);
  assert.deepEqual(permuted, baseline, 'Human browser view changed under hidden-world permutation');
  receipt.privacyChecks++;
});
try {
  const start = { requestId: randomUUID(), modelId: session.models[0].id, deck: 1 };
  let state = await session.mutate('new', start);
  const initial = state.game;
  assert.equal(initial.error, null);
  assert.equal(initial.model.sha256.length, 64);
  assert.deepEqual(await session.mutate('new', start), state, 'Repeated start changed the game');
  receipt.checks.push('saved-checkpoint-loaded', 'repeated-start-idempotent');
  const beforeInvalid = session.state();
  await assert.rejects(session.mutate('command', { ...request(initial), decision: { actionId: 'foreign-action' } }), error => error.status === 400);
  assert.deepEqual(session.state(), beforeInvalid, 'Malformed user action stopped or changed the valid game');
  receipt.checks.push('invalid-user-action-preserves-game');
  await privacy();
  const prompt = initial.view.prompts.find(value => value.min > 0 && value.kind !== 'allocation');
  if (prompt) {
    const before = JSON.stringify(session.state());
    const preview = await session.mutate('preview', { ...request(initial), decision: { promptId: prompt.id, choiceIds: [] } });
    assert.equal(preview.valid, false);
    assert.equal(JSON.stringify(session.state()), before, 'Invalid preview changed browser state');
    receipt.checks.push('invalid-preview-is-nonmutating');
  } else receipt.checks.push('initial-invalid-preview-not-applicable');
  const first = request(initial);
  state = await session.mutate('assist', first);
  receipt.humanAssists++;
  assert.deepEqual(await session.mutate('assist', first), state, 'Repeated assistance advanced the game twice');
  await assert.rejects(session.mutate('assist', { ...first, requestId: randomUUID() }), error => error.status === 409);
  receipt.checks.push('duplicate-click-idempotent', 'stale-revision-rejected');
  const retainedOldGame = request(state.game);
  for (; !state.game.terminal && receipt.humanAssists < 400; receipt.humanAssists++) {
    state = await session.mutate('assist', request(state.game));
    assert.equal(state.game.error, null);
    assert.equal(state.game.view.opponent.hand, undefined);
    assert.equal(state.game.view.opponent.deck, undefined);
    if (receipt.humanAssists === 15 && !state.game.terminal) await privacy();
    if (receipt.humanAssists % 20 === 0) console.log(JSON.stringify({ humanAssists: receipt.humanAssists, revision: state.game.view.revision, learnedDecisions: state.game.learnedDecisions }));
  }
  assert.ok(state.game.terminal, 'Game did not complete within the bounded human assistance budget');
  assert.equal(state.game.view.status, 'finished');
  assert.ok(state.game.learnedDecisions > 0, 'Game never used the checkpoint');
  assert.ok(state.game.helperDecisions > 0, 'Helper attribution absent');
  assert.ok(state.game.activity.some(value => value.includes('Human helper assistance')));
  receipt.completedNaturally = true;
  receipt.terminal = state.game.terminal;
  receipt.revision = state.game.view.revision;
  receipt.learnedDecisions = state.game.learnedDecisions;
  receipt.helperDecisions = state.game.helperDecisions;
  receipt.checkpointSha256 = state.game.model.sha256;
  receipt.checks.push('complete-native-game', 'checkpoint-ordinary-decisions', 'helper-attribution', 'terminal-actions-cleared');
  assert.equal(state.game.view.actions.length, 0);
  assert.equal(state.game.view.prompts.length, 0);
  const restarted = await session.mutate('new', { ...start, requestId: randomUUID() });
  assert.notEqual(restarted.game.id, state.game.id);
  await assert.rejects(session.mutate('assist', retainedOldGame), error => error.status === 409);
  receipt.checks.push('fresh-reset', 'old-game-click-rejected');
  console.log(JSON.stringify(receipt, null, 2));
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
} finally { await session.close(); }
