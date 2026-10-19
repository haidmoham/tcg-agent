import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LocalWorker, verifyLocalInputs } from './probe.mjs';
import { SemanticState, staticProgramIds, verifySeedTranscript } from './semantic-state.mjs';
import { runAuditedEpisode } from './audit-runner.mjs';
import { benchmarkDeckOrder } from './benchmark.mjs';
import { PolicyView } from './policy-view.mjs';
import { randomUUID } from 'node:crypto';

export async function verifyNativeContracts(config, original) {
  const inputs = verifyLocalInputs(config);
  const seed = original.header.seed;
  const otherSeed = (seed + 1) >>> 0;
  const selected = benchmarkDeckOrder(inputs.selected, original.header);
  const seatOrder = selected.map(deck => inputs.selected.indexOf(deck));
  const known = staticProgramIds(...['cardData.json', 'gameData.json'].map(name => JSON.parse(readFileSync(join(inputs.root, name)))));
  const bundle = { id: inputs.manifest.bundleId, cardsHash: inputs.pins.get('cardData.json'), rulesHash: inputs.pins.get('gameData.json'), runtimeHash: inputs.pins.get('MatchLogic.dll') };
  const seats = Object.fromEntries(['human', 'opponent'].map((seat, index) => [seat, { accountId: `offline-${seat}`, name: `Offline ${seat}`, cards: selected[index] }]));
  assert.ok(original.frames[1]?.emittedSeeds.length > 0, 'first recorded command must request native chance');
  const begin = async (worker, rootSeed) => {
    const frame = await worker.request('create', { bundle, seats, offline: { seed: rootSeed, projectionCopyMode: inputs.copyMode } });
    const first = original.commands[0];
    const projector = new PolicyView(); projector.project(frame.views[first.seat]);
    const reply = await worker.request('command', { seat: first.seat, command: { ...projector.resolve(first.decision), commandId: randomUUID(), expectedRevision: 0 } });
    assert.equal(reply.receipt?.status, 'accepted');
    return worker.request('audit', {});
  };
  const a = new LocalWorker(config), b = new LocalWorker(config);
  let before;
  try {
    before = await begin(a, seed);
    const other = await begin(b, otherSeed);
    await a.request('view', { seat: 'human' }); await b.request('view', { seat: 'opponent' });
    assert.deepEqual(await a.request('audit', {}), before);
    assert.deepEqual(await b.request('audit', {}), other);
    verifySeedTranscript(seed, before.emittedSeeds); verifySeedTranscript(otherSeed, other.emittedSeeds);
    assert.notDeepEqual(before.emittedSeeds, other.emittedSeeds);
  } finally { a.close(); b.close(); }
  const c = new LocalWorker(config);
  try {
    const again = await begin(c, seed);
    assert.equal(new SemanticState(known).hash(before.authority), new SemanticState(known).hash(again.authority));
    assert.deepEqual(before.emittedSeeds, again.emittedSeeds);
  } finally { c.close(); }
  const control = await runAuditedEpisode(config, { seed, replay: original, seatOrder, maxSeconds: 180, extraReads: 1 });
  assert.equal(control.summary.replayVerified, true);
  const cases = [
    ['frame-tamper', value => { value.frames[0].stateHash = 'bad'; }, /diverged at revision 0/],
    ['seed-underflow', value => { value.frames[1].emittedSeeds.pop(); }, /diverged at revision 1/],
    ['seed-leftover', value => { value.frames[1].emittedSeeds.push(123); }, /diverged at revision 1/],
    ['commands-exhausted', value => { value.commands = []; }, /transcript exhausted/],
    ['wrong-pin', value => { value.header.workerSha256 = 'bad'; }, /pins or seed mismatch/],
  ];
  for (const [, mutate, expected] of cases) {
    const replay = structuredClone(original); mutate(replay);
    await assert.rejects(runAuditedEpisode(config, { seed, replay, seatOrder, maxSeconds: 30 }), expected);
  }
  return { schema: 'native-adversarial-receipt-v1', seed, otherSeed, baselineReplayVerified: true, baselineCommands: control.summary.commands, baselineFrames: control.summary.frames, interleavedIndependentProcesses: 2, sameSeedFreshProcessState: true, differentSeedTranscript: true, readMutation: false, rejectedCases: cases.map(([name]) => name) };
}
