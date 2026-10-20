import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTrainingEpisode } from '../integrations/local-worker/training-episode.mjs';
import { runAuditedEpisode } from '../integrations/local-worker/audit-runner.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, { terminalAt = 3, reject = false, revisionJump = false, mutatePreview = false, prompt = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'training-episode-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new Map(['MatchLogic.dll', 'CardDatabase.DataAccess.dll', 'Newtonsoft.Json.dll', 'TimeProvider.dll', 'cardData.json', 'gameData.json', 'printing-joins.json'].map(name => [name, '{}']));
  files.set('decks.json', JSON.stringify(Object.fromEntries(['realDeckRows', 'zoroarkDeckRows'].map(key => [key, { orderedSourceIDs: Array(60).fill('synthetic-card') }]))));
  for (const [name, content] of files) writeFileSync(join(root, name), content);
  const manifest = JSON.stringify({ schemaVersion: 1, bundleId: 'synthetic', files: [...files].map(([path, content]) => ({ path, sha256: hash(content) })) });
  writeFileSync(join(root, 'manifest.json'), manifest);
  const policy = 'export function* livePracticeDecisions(view) { if(view.prompts.length) yield {promptId:view.prompts[0].id,choiceIds:[]}; else if(view.turn === "you" && view.actions.length) yield {actionId:view.actions[0].id}; }';
  writeFileSync(join(root, 'policy.mjs'), policy);
  writeFileSync(join(root, 'worker'), 'synthetic');
  const config = { schema: 'local-worker-probe-v1', executable: join(root, 'worker'), worker: join(root, 'worker'), executableSha256: hash('synthetic'), workerSha256: hash('synthetic'), bundleRoot: root, manifestSha256: hash(manifest), policyModule: join(root, 'policy.mjs'), policySha256: hash(policy), offlineAuditVersion: 'indigo-offline-audit/1' };
  const side = { active: null, bench: [], prizes: 6, deckCount: 40, handCount: 7, discard: [] };
  let revision = 0, seed, mutated = false;
  const rawView = seat => ({ source: 'live-matchlogic', status: revision >= terminalAt ? 'finished' : 'playing', revision, turn: seat === 'human' ? 'you' : 'opponent', turnNumber: revision, hand: [], you: side, opponent: side, actions: prompt || seat !== 'human' ? [] : [{ id: 'native-pass', kind: 'pass' }], prompts: prompt && seat === 'human' && revision < terminalAt ? [{ id: 'native-prompt', kind: 'select', min: 0, max: 0, cancelable: false, ordered: false, groups: [], choices: [] }] : [] });
  const frame = () => ({ revision, views: Object.fromEntries(['human', 'opponent'].map(seat => [seat, rawView(seat)])), terminal: revision >= terminalAt ? { winner: 'human' } : null });
  const calls = [];
  const worker = {
    child: { pid: 0, exitCode: null, signalCode: null },
    closed: false,
    close() { this.closed = true; this.child.exitCode = 0; },
    async nextMatch(payload) { return this.request('create', payload); },
    async request(method, payload) {
      calls.push({ method, payload });
      if (method === 'create') { revision = 0; seed = payload.offline.seed; return frame(); }
      if (method === 'audit') return { schema: 'indigo-offline-audit/1', seed, fixedClock: '2026-10-11T00:00:00Z', readChanceAttempts: 0, emittedSeeds: [], authority: { revision, mutated } };
      if (method === 'audit-privacy') return { view: rawView(payload.seat), permutedSlots: 4, opponentHandExchanged: true };
      if (method === 'audit-use') return { checked: true, missing: [], extra: [] };
      if (method === 'preview') { if (mutatePreview) mutated = true; return { valid: true }; }
      if (method === 'command') { if (!reject) revision += revisionJump ? 2 : 1; return { receipt: { status: reject ? 'rejected' : 'accepted' }, frame: frame() }; }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { config, worker, calls, session: { worker } };
}

test('sampled training keeps every command and actor hash, with real privacy counts and terminal audit', async t => {
  const f = fixture(t);
  const actors = [];
  const first = await runTrainingEpisode(f.config, { session: f.session, auditEvery: 2, decideOrdinary: input => { actors.push(input); return { actionId: input.view.actions[0].id }; } });
  assert.equal(first.summary.commands, 3);
  assert.equal(first.journal.frames.length, 4);
  assert.deepEqual(first.summary.sampledRevisions, [0, 2, 3]);
  assert.equal(first.summary.privacyChecks, 4);
  assert.equal(first.summary.opponentHandExchanges, 4);
  assert.equal(first.summary.auditMode, 'sampled-native-training/1');
  assert.deepEqual(first.journal.emittedSeeds, []);
  assert.ok(first.journal.frames.every(entry => /^[a-f0-9]{64}$/.test(entry.actorHashes.human)));
  assert.ok(actors.every(input => Object.keys(input).sort().join(',') === 'seat,view' && Object.isFrozen(input.view)));
  assert.equal(f.calls.filter(call => call.method === 'audit-privacy').length, first.summary.privacyChecks);
  assert.equal(f.worker.closed, false);
  const second = await runTrainingEpisode(f.config, { session: f.session, auditEvery: 2 });
  assert.equal(second.summary.reusedProcess, true);
  assert.deepEqual(second.journal, first.journal);
});

test('rejected commands, revision jumps, and preview mutations fail and close the session', async t => {
  for (const settings of [{ reject: true }, { revisionJump: true }, { mutatePreview: true, prompt: true }]) {
    const f = fixture(t, settings);
    await assert.rejects(runTrainingEpisode(f.config, { session: f.session }));
    assert.equal(f.session.failed, true);
    assert.equal(f.session.busy, false);
    assert.equal(f.worker.closed, true);
  }
});

test('same synthetic native trajectory matches the full audit command, actor, terminal and RNG transcript', async t => {
  const full = fixture(t), fast = fixture(t);
  const expected = await runAuditedEpisode(full.config, { seed: 93401, session: full.session, boundaryEvery: 1, strictCommands: true });
  const actual = await runTrainingEpisode(fast.config, { seed: 93401, session: fast.session });
  assert.deepEqual(actual.journal.commands, expected.journal.commands);
  assert.deepEqual(actual.journal.frames.map(({ revision, actorHashes }) => ({ revision, actorHashes })), expected.journal.frames.map(({ revision, actorHashes }) => ({ revision, actorHashes })));
  assert.equal(actual.summary.terminalStateHash, expected.summary.terminalStateHash);
  assert.equal(actual.summary.winnerSeat, expected.summary.winnerSeat);
  assert.deepEqual(actual.journal.emittedSeeds, expected.journal.frames.at(-1).emittedSeeds);
});

test('prompt policy receives actor view and native read-only validation only', async t => {
  const f = fixture(t, { prompt: true, terminalAt: 1 });
  await runTrainingEpisode(f.config, { session: f.session, decidePrompt: async input => {
    assert.deepEqual(Object.keys(input).sort(), ['seat', 'validate', 'view']);
    const answer = { promptId: input.view.prompts[0].id, choiceIds: [] };
    assert.equal(await input.validate(answer), true);
    return [answer];
  } });
  assert.equal(f.calls.filter(call => call.method === 'preview').length, 2);
});

test('budget and cancellation terminate an uncooperative policy without counting a loss', async t => {
  const f = fixture(t, { terminalAt: 20 });
  await assert.rejects(runTrainingEpisode(f.config, { session: f.session, maxCommands: 1 }), { code: 'NATIVE_EPISODE_COMMAND_BUDGET' });
  assert.equal(f.worker.closed, true);
  for (const abort of [true, false]) {
    const g = fixture(t);
    const controller = new AbortController();
    const timer = abort ? setTimeout(() => controller.abort(), 20) : null;
    await assert.rejects(runTrainingEpisode(g.config, { session: g.session, maxSeconds: 1, signal: controller.signal, decideOrdinary: () => new Promise(() => {}) }), { code: abort ? 'NATIVE_TRAINING_CANCELLED' : 'NATIVE_EPISODE_TIME_BUDGET' });
    clearTimeout(timer);
    assert.equal(g.worker.closed, true);
  }
});

test('invalid budgets and pre-cancellation fail before reading local inputs', async () => {
  for (const options of [{ maxSeconds: 0 }, { maxCommands: 0 }, { auditEvery: 0 }, { seatOrder: [0, 0] }, { replay: {} }]) await assert.rejects(runTrainingEpisode({}, options), TypeError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runTrainingEpisode({}, { signal: controller.signal }), { code: 'NATIVE_TRAINING_CANCELLED' });
});
