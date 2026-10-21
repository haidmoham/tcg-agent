import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hashFile, readJson } from '../environment/frozen-runtime.mjs';
import { summarizeNativeLadder } from '../src/native-ladder.mjs';

const [evaluationDirectory, publicProtocolPath, outputPath] = process.argv.slice(2);
assert(evaluationDirectory && publicProtocolPath && outputPath && process.argv.length === 5,
  'usage: export-strength-confirmation <completed-private-directory> <public-protocol.json> <public-result.json>');
const read = name => readJson(path.join(evaluationDirectory, name));
const receipt = read('receipt.json'), manifest = read('protocol.json'), protocol = readJson(publicProtocolPath);
assert.equal(receipt.state, 'completed');
assert.equal(receipt.stopReason, null);
assert.equal(manifest.split, 'confirmation');
assert.equal(receipt.manifestSha256, hashFile(path.join(evaluationDirectory, 'protocol.json')));
assert.equal(manifest.nomination.publicProtocolSha256, hashFile(publicProtocolPath));
assert.deepEqual(manifest.seeds, protocol.seeds);
assert.equal(receipt.blocks.length, protocol.independentSeedPairs);
assert.equal(receipt.plannedPairs, protocol.independentSeedPairs);
const candidate = manifest.entrants.find(entrant => entrant.kind === 'ppo');
assert(candidate);
const seenSeeds = new Set();
const blocks = receipt.blocks.map(block => {
  assert.equal(block.a, candidate.id);
  assert.equal(block.b, 'first-baseline');
  assert.equal(block.fixedEndpoint, true);
  assert(!seenSeeds.has(block.seed));
  seenSeeds.add(block.seed);
  const slot = protocol.seeds.indexOf(block.seed);
  assert(slot >= 0);
  assert.equal(block.outcomes.length, 2);
  assert.deepEqual(new Set(block.outcomes.map(game => game.aSeat)), new Set(['human', 'opponent']));
  const natural = block.outcomes.filter(game => game.status === 'natural');
  for (const game of natural) {
    assert.equal(game.summary.completedNaturally, true);
    assert.equal(game.summary.rejected, 0);
    assert(game.summary.privacyChecks >= 2);
    const journal = read(`pair-${slot}-${game.aSeat}-journal.json`);
    assert.equal(journal.header.seed, block.seed);
    assert.equal(journal.frames.at(-1).snapshotHash, game.summary.terminalStateHash);
    assert.equal(journal.commands.length, game.summary.commands);
    assert.equal(journal.frames.length, game.summary.frames);
    assert.equal(game.score, game.summary.winnerSeat === null ? .5 : game.summary.winnerSeat === game.aSeat ? 1 : 0);
  }
  if (natural.length === 2) {
    const first = read(`pair-${slot}-human-journal.json`), second = read(`pair-${slot}-opponent-journal.json`);
    assert.deepEqual(first.header, second.header);
    assert.deepEqual(first.frames[0], second.frames[0]);
  }
  return { seed: block.seed, score: block.outcomes.reduce((total, game) => total + game.score, 0) / 2,
    statuses: block.outcomes.map(game => game.status), pairReceiptSha256: block.receiptSha256 };
});
const report = summarizeNativeLadder(receipt.registry, receipt.blocks);
assert.equal(report.pools.length, 1);
const comparison = report.pools[0].cells.find(cell => cell.a === candidate.id && cell.b === 'first-baseline');
assert.equal(comparison.games, protocol.games);
assert.equal(comparison.independentPairs, protocol.independentSeedPairs);
const games = receipt.blocks.flatMap(block => block.outcomes);
const result = {
  schema: 'ppo-checkpoint-confirmation-result/1', status: 'completed', at: receipt.at,
  environmentVersion: protocol.environmentVersion, environmentLockSha256: protocol.environmentLockSha256,
  protocolSha256: hashFile(publicProtocolPath), privateManifestSha256: receipt.manifestSha256,
  privateReceiptSha256: hashFile(path.join(evaluationDirectory, 'receipt.json')), runnerSha256: receipt.runnerSha256,
  candidate: { id: candidate.id, ordinarySha256: candidate.sha256,
    selectionSha256: receipt.registry.entrants.find(entrant => entrant.id === candidate.id).pins.selection },
  nomination: manifest.nomination, comparison, strengthPlan: protocol.strengthPlan,
  demonstratesImprovement: comparison.interval[0] > .5,
  rulesOutTargetedTenPointGain: comparison.interval[1] < .6,
  naturalGames: games.filter(game => game.status === 'natural').length,
  privacyChecks: games.reduce((total, game) => total + (game.summary?.privacyChecks ?? 0), 0),
  actualCost: { wallSeconds: receipt.elapsedSeconds, summedGameSeconds: report.pools[0].gameSeconds,
    workers: receipt.workers, device: 'CPU', cpuCoreSeconds: null, trainingUpdates: 0 },
  blocks, promotion: false,
};
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ candidate: candidate.id, games: comparison.games, score: comparison.score,
  interval: comparison.interval, demonstratesImprovement: result.demonstratesImprovement,
  rulesOutTargetedTenPointGain: result.rulesOutTargetedTenPointGain }));
