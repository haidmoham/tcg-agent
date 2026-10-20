import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAuditedEpisode } from '../integrations/local-worker/audit-runner.mjs';
import { runTrainingEpisode } from '../integrations/local-worker/training-episode.mjs';

// Explicit opt-in: prepared private inputs stay outside the repository. The
// caller must reserve two native process slots and apply desktop CPU limits.
const configPath = process.env.TCG_TRAINING_REGRESSION_CONFIG;
test('sampled runner reproduces full native trajectories for both deck roles', { skip: !configPath, timeout: 500_000 }, async t => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const scenario of [{ seed: 93401, seatOrder: [0, 1] }, { seed: 93402, seatOrder: [1, 0] }]) {
    const options = { ...scenario, maxCommands: 2000, maxSeconds: 240, strictCommands: true };
    const [full, fast] = await Promise.all([
      runAuditedEpisode(config, { ...options, boundaryEvery: 1 }),
      runTrainingEpisode(config, options),
    ]);
    assert.deepEqual(fast.journal.header, full.journal.header);
    assert.deepEqual(fast.journal.commands, full.journal.commands);
    assert.deepEqual(fast.journal.frames.map(({ revision, actorHashes }) => ({ revision, actorHashes })), full.journal.frames.map(({ revision, actorHashes }) => ({ revision, actorHashes })));
    assert.equal(fast.summary.winnerSeat, full.summary.winnerSeat);
    assert.equal(fast.summary.terminalStateHash, full.summary.terminalStateHash);
    assert.deepEqual(fast.journal.emittedSeeds, full.journal.frames.at(-1).emittedSeeds);
    t.diagnostic(JSON.stringify({ ...scenario, commands: fast.summary.commands, frames: fast.summary.frames, nativeSeedCalls: fast.summary.nativeSeedCalls, fastElapsedMilliseconds: fast.summary.elapsedMs, fullElapsedMilliseconds: full.summary.elapsedMs, fastPrivacyChecks: fast.summary.privacyChecks, fullPrivacyChecks: full.summary.boundaryChecks.filter(check => check.seat && !check.decisionDomain).length, timingScope: 'one diagnostic paired trajectory per role, not a throughput benchmark' }));
  }
});
