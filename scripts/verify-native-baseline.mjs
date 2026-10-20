import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LocalWorker, verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';

let worker;
try {
  assert.equal(process.argv.length, 3, 'one private native config required');
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const inputs = verifyLocalInputs(config);
  assert.equal(config.offlineAuditVersion, 'indigo-offline-audit/1');
  worker = new LocalWorker(config, { timeoutMs: 15000 });
  const frame = await worker.request('create', {
    bundle: { id: inputs.manifest.bundleId, cardsHash: inputs.pins.get('cardData.json'),
      rulesHash: inputs.pins.get('gameData.json'), runtimeHash: inputs.pins.get('MatchLogic.dll') },
    seats: Object.fromEntries(['human', 'opponent'].map((seat, index) => [seat,
      { accountId: `baseline-smoke-${seat}`, name: seat, cards: inputs.selected[index] }])),
    offline: { seed: 1729, projectionCopyMode: inputs.copyMode },
  });
  assert.equal(frame.revision, 0);
  for (const seat of ['human', 'opponent']) {
    const view = await worker.request('view', { seat });
    assert.deepEqual(view, frame.views[seat]);
    const projected = new PolicyView().project(view);
    assert.notEqual(projected.status, 'failed');
    assert.equal(projected.opponent.hand, undefined);
  }
  const audit = await worker.request('audit', {});
  assert.equal(audit.schema, 'indigo-offline-audit/1');
  assert.equal(audit.seed, 1729);
  assert.equal(audit.fixedClock, '2026-10-11T00:00:00Z');
  assert.equal(audit.readChanceAttempts, 0);
  assert.equal(audit.projectionCopyMode, inputs.copyMode);
  await worker.request('abort', { commandId: randomUUID(), expectedRevision: 0 });
  console.log(JSON.stringify({ schema: 'native-baseline-smoke/1', passed: true, seed: 1729,
    revision: 0, seatReadChecks: 2, acceptedGameplayCommands: 0, aborted: true,
    completedNaturally: false, winner: null, workerSha256: config.workerSha256 }));
} catch {
  console.error('native-baseline-smoke-failed; retain private worker diagnostics locally');
  process.exitCode = 1;
} finally { worker?.close(); }
