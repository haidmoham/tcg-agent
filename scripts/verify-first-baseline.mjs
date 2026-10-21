// Verify the frozen copy; optional retained traces are replay checks, not new trials.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readJson, hashFile, verifyFrozenRuntime } from '../environment/frozen-runtime.mjs';

const [configPath, auditPath, receiptPath, ...extra] = process.argv.slice(2);
if (!configPath || extra.length || (auditPath && !receiptPath))
  throw Error('Usage: verify-first-baseline <prepared-config.json> [retained-traces.json fresh-receipt.json]');
if (receiptPath && fs.existsSync(receiptPath)) throw Error('fresh verification receipt required');
const config = readJson(configPath), lock = verifyFrozenRuntime(config);
const load = file => import(pathToFileURL(path.join(config.runtimeRoot, file)));
const { openFirstBaseline } = await load('agents/first-baseline.mjs');
const { runNativeGame } = await load('environment/native-game.mjs');
const native = readJson(config.nativeConfig);
const service = await openFirstBaseline(config);
const receipt = { schema: 'first-baseline-preservation/1', environmentVersion: lock.version,
  lockSha256: config.lockSha256, agent: service.identity, recordedGames: [], recordedContexts: [], newExperiments: 0, trainingUpdates: 0 };
try {
  const audit = auditPath ? readJson(auditPath) : {};
  for (const file of audit.humanJournals ?? []) {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const agent = service.newGame(), offers = new Map(), submissions = new Map();
    let offered = 0, accepted = 0;
    for (const row of rows) {
      if (row.type === 'human-visible-after-command') agent.observe(row.presentation);
      if (row.type === 'human-decision-offered') {
        const actual = agent.observe({ ...row.projectedObservation, decisionContext: undefined });
        assert.deepEqual(actual.decisionContext, row.projectedObservation.decisionContext);
        offers.set(row.decisionId, row); offered++;
      }
      if (row.type === 'human-submitted') submissions.set(row.submissionId, row);
      if (row.type === 'decision-result' && row.actor === 'human' && row.acceptance === 'accepted') {
        const submitted = submissions.get(row.submissionId), offer = offers.get(submitted.decisionId);
        agent.accepted(offer.projectedObservation, submitted.selectedSemanticAction); accepted++;
      }
    }
    receipt.recordedContexts.push({ eventsSha256: hashFile(file), offered, accepted, contextExact: true });
  }
  for (const retained of audit.recordedGames ?? []) {
    const rows = fs.readFileSync(retained.decisionsPath, 'utf8').trim().split('\n').map(JSON.parse);
    const frames = fs.readFileSync(retained.progressPath, 'utf8').trim().split('\n').map(JSON.parse);
    const expectedOutcome = readJson(retained.outcomePath);
    let accepted = 0, observed = 0;
    const recordedAgent = {
      pins: { id: 'retained-opponent-trace', decisionsSha256: hashFile(retained.decisionsPath) },
      observe(view) { return view; },
      async propose(view) {
        const row = rows[accepted];
        assert.equal(row.seat, retained.baselineSeat === 'human' ? 'opponent' : 'human');
        assert.equal(row.revision, view.revision);
        return { source: 'retained-trace', decisions: [row.decision] };
      },
      accepted() {},
    };
    const agent = service.newGame();
    const agents = retained.baselineSeat === 'human' ? { human: agent, opponent: recordedAgent } : { human: recordedAgent, opponent: agent };
    const result = await runNativeGame(native, { agents, seed: retained.seed, seatOrder: retained.seatOrder,
      maxCommands: 2000, maxSeconds: 360, auditEvery: 32,
      onFrame({ entry }) {
        const expected = frames[observed++];
        assert.equal(entry.revision, expected.revision);
        assert.deepEqual(entry.actorHashes, expected.actorHashes);
        if (expected.snapshotHash) assert.equal(entry.snapshotHash, expected.snapshotHash);
      },
      onDecision({ seat, view, decision }) {
        const row = rows[accepted++];
        assert.equal(seat, row.seat); assert.equal(view.revision, row.revision); assert.deepEqual(decision, row.decision);
      },
    });
    assert.equal(accepted, rows.length); assert.equal(observed, frames.length);
    for (const key of ['winnerSeat', 'terminalStateHash', 'commands', 'frames', 'nativeSeedCalls'])
      assert.deepEqual(result.summary[key], expectedOutcome.summary[key]);
    receipt.recordedGames.push({ seed: retained.seed, baselineSeat: retained.baselineSeat,
      decisionsSha256: hashFile(retained.decisionsPath), progressSha256: hashFile(retained.progressPath),
      outcomeSha256: hashFile(retained.outcomePath), commands: accepted, frames: observed, routes: result.routes,
      actorProjectionsExact: true, decisionsExact: true, terminalExact: true, nativeSeedCalls: result.summary.nativeSeedCalls,
      privacyChecks: result.summary.privacyChecks });
  }
  verifyFrozenRuntime(config);
  receipt.verified = true;
} finally { await service.shutdown(); }
receipt.servicesExited = true;
if (receiptPath) fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt));
