import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hashFile, readJson } from '../environment/frozen-runtime.mjs';
import { identityHash, summarizeNativeLadder } from '../src/native-ladder.mjs';

const [directory, designPath, resultPath, ladderPath] = process.argv.slice(2);
assert(directory && designPath && resultPath && ladderPath && process.argv.length === 6,
  'usage: export-strength-monitor <completed-private-panel> <design.json> <public-result.json> <public-ladder.json>');
const read = name => readJson(path.join(directory, name));
const receipt = read('receipt.json'), manifest = read('protocol.json'), design = readJson(designPath);
assert.equal(receipt.state, 'completed');
assert.equal(receipt.stopReason, null);
assert.equal(manifest.split, 'development');
assert.equal(manifest.analysisAlpha, .025);
assert.equal(receipt.analysisAlpha, .025);
assert.equal(receipt.manifestSha256, hashFile(path.join(directory, 'protocol.json')));
assert.deepEqual(manifest.seeds, design.monitoring.seeds);
assert.deepEqual(manifest.searchSeeds, design.monitoring.searchSeeds);
assert.equal(receipt.blocks.length, design.monitoring.independentPairsPerSnapshot);
assert.equal(receipt.plannedPairs, design.monitoring.independentPairsPerSnapshot);
const candidate = manifest.entrants.find(entrant => entrant.kind === 'prepared');
assert(candidate);
const monitorIndex = Number(candidate.id.match(/\.monitor-(\d+)$/)?.[1]);
assert([1, 2].includes(monitorIndex));
const snapshotOffsetSeconds = design.monitoring.snapshotOffsetsSeconds[monitorIndex - 1];
const snapshotCutoffUtc = new Date(Date.parse(design.training.startUtc) + snapshotOffsetSeconds * 1000).toISOString();
assert(Date.parse(manifest.nomination.completedAtUtc) <= Date.parse(snapshotCutoffUtc));
assert.equal(hashFile(candidate.checkpoint), candidate.sha256);
assert.equal(hashFile(candidate.factoryModule), candidate.factorySha256);
for (const [file, digest] of Object.entries(candidate.sourcePins)) assert.equal(hashFile(file), digest);
const seen = new Set();
const blocks = receipt.blocks.map(block => {
  assert.equal(block.a, candidate.id);
  assert.equal(block.b, 'first-baseline');
  assert.equal(block.fixedEndpoint, true);
  assert(!seen.has(block.seed)); seen.add(block.seed);
  const slot = manifest.seeds.indexOf(block.seed);
  assert(slot >= 0);
  assert.equal(block.outcomes.length, 2);
  assert.deepEqual(new Set(block.outcomes.map(game => game.aSeat)), new Set(['human', 'opponent']));
  const journals = [];
  for (const game of block.outcomes) {
    assert.equal(game.status, 'natural');
    assert.equal(game.summary.completedNaturally, true);
    assert.equal(game.summary.rejected, 0);
    assert(game.summary.privacyChecks >= 2);
    const journal = read(`pair-${slot}-${game.aSeat}-journal.json`);
    assert.equal(journal.header.seed, block.seed);
    assert.equal(journal.commands.length, game.summary.commands);
    assert.equal(journal.frames.length, game.summary.frames);
    assert.equal(journal.frames.at(-1).snapshotHash, game.summary.terminalStateHash);
    assert.equal(game.score, game.summary.winnerSeat === null ? .5 : game.summary.winnerSeat === game.aSeat ? 1 : 0);
    journals.push(journal);
  }
  assert.deepEqual(journals[0].header, journals[1].header);
  assert.deepEqual(journals[0].frames[0], journals[1].frames[0]);
  assert.equal(hashFile(path.join(directory, `pair-${slot}.json`)), block.receiptSha256);
  return { seed: block.seed, score: block.outcomes.reduce((total, game) => total + game.score, 0) / 2,
    pairReceiptSha256: block.receiptSha256 };
});
const report = summarizeNativeLadder(receipt.registry, receipt.blocks, { alpha: .025 });
assert.deepEqual(report, read('report.json'));
assert.equal(report.pools.length, 1);
const comparison = report.pools[0].cells.find(cell => cell.a === candidate.id && cell.b === 'first-baseline');
assert.equal(comparison.games, design.monitoring.gamesPerSnapshot);
const routes = {};
const games = receipt.blocks.flatMap(block => block.outcomes);
for (const game of games) for (const [source, count] of Object.entries(game.routes[game.aSeat])) {
  const category = source.split(':')[0]; routes[category] = (routes[category] ?? 0) + count;
}
const result = {
  schema: 'model7-strength-monitor-result/1', status: 'completed', at: receipt.at,
  monitorIndex, snapshotOffsetSeconds, snapshotCutoffUtc,
  dataRole: 'predeclared development monitor; independent final confirmation remains untouched',
  designSha256: hashFile(designPath), privateManifestSha256: receipt.manifestSha256,
  privateReceiptSha256: hashFile(path.join(directory, 'receipt.json')), runnerSha256: receipt.runnerSha256,
  exporterSha256: hashFile(new URL(import.meta.url)), candidate: receipt.registry.entrants.find(entrant => entrant.id === candidate.id),
  nomination: manifest.nomination, nativeImplementation: receipt.nativeImplementation,
  comparison, plannedMonitorCount: 2, pointwiseConfidence: .975, simultaneousMonitorConfidence: .95,
  uncertainty: 'Two-sided97.5% Hoeffding over64 independent seed pairs; Bonferroni simultaneous95% across two planned monitors.',
  demonstratesRegressionAtThisCheckpoint: comparison.interval[1] < .5,
  scope: 'This complete nominated checkpoint/player versus first-baseline in the fixed mirrored native scenario; not the final candidate or a component ablation.',
  naturalGames: games.length, privacyChecks: games.reduce((total, game) => total + game.summary.privacyChecks, 0),
  candidateDecisionRoutes: routes,
  actualCost: { wallSeconds: receipt.elapsedSeconds, summedGameSeconds: report.pools[0].gameSeconds,
    workers: receipt.workers, device: 'CPU', cpuCoreSeconds: null, fittingUpdates: 0 },
  blocks, promotion: false,
};
const ladder = { ...report, sources: [{ type: 'native-ladder', receiptSha256: result.privateReceiptSha256,
  state: receipt.state, elapsedSeconds: receipt.elapsedSeconds }], plannedMonitorFamilyConfidence: .95,
  interpretation: 'Completed development evidence. Preserve the97.5% per-monitor interval; no outcome-based stopping, checkpoint selection or final-confirmation reuse.' };
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(ladderPath, JSON.stringify(ladder, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ candidate: candidate.id, games: comparison.games, score: comparison.score,
  interval: comparison.interval, verifiedPairedInitialStates: seen.size, registrySha256: identityHash(receipt.registry), promotion: false }));
