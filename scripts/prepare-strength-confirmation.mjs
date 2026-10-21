import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hashFile, readJson } from '../environment/frozen-runtime.mjs';

const [curveDirectory, publicProtocolPath, outputPath] = process.argv.slice(2);
assert(curveDirectory && publicProtocolPath && outputPath && process.argv.length === 5,
  'usage: prepare-strength-confirmation <completed-curve-directory> <public-protocol.json> <fresh-private-manifest.json>');
assert(!fs.existsSync(outputPath), 'fresh manifest required');
const curvePath = path.join(curveDirectory, 'strength-curve.json');
const curve = readJson(curvePath), developmentProtocol = readJson(path.join(curveDirectory, 'protocol.json'));
const confirmation = readJson(publicProtocolPath);
assert.equal(curve.state, 'completed');
assert.equal(curve.stopReason, null);
assert.equal(confirmation.schema, 'ppo-selected-checkpoint-confirmation/1');
assert.equal(confirmation.seeds.length, confirmation.independentSeedPairs);
assert.equal(confirmation.candidateSelection, 'highest completed development score; ties choose fewer training games');
assert.equal(curve.points.length, developmentProtocol.snapshots.length);
for (const point of curve.points) {
  assert.equal(point.state, 'completed');
  assert.equal(point.blocks.length, developmentProtocol.seeds.length);
  assert(point.blocks.every(block => block.status === 'completed' && block.outcomes.length === 2));
}
const selected = [...curve.points].sort((a, b) => b.score - a.score || a.trainingGames - b.trainingGames)[0];
const snapshot = developmentProtocol.snapshots.find(snapshot => snapshot.id === selected.id);
assert.equal(hashFile(snapshot.checkpoint), snapshot.sha256);
assert.equal(curve.environmentLockSha256, confirmation.environmentLockSha256);
assert(confirmation.seeds.every(seed => !developmentProtocol.seeds.includes(seed)));
const manifest = {
  schema: 'native-ladder-run/1', environmentConfig: developmentProtocol.environmentConfig,
  anchor: 'first-baseline', split: 'confirmation', promotion: false,
  entrants: [
    { kind: 'baseline', id: 'first-baseline', description: 'Exact frozen environment-v1 reference' },
    { kind: 'ppo', id: `outcome-ppo.${selected.id}`, description: `Fresh confirmation of development nominee ${selected.id}`,
      checkpoint: snapshot.checkpoint, sha256: snapshot.sha256 },
  ],
  pairs: [[`outcome-ppo.${selected.id}`, 'first-baseline']], seeds: confirmation.seeds,
  workers: confirmation.workers, maximumGames: confirmation.games,
  maximumWallSeconds: confirmation.maximumWallSeconds,
  maximumGameSeconds: developmentProtocol.maximumGameSeconds,
  maximumGameCommands: developmentProtocol.maximumGameCommands,
  strengthPlan: confirmation.strengthPlan,
  nomination: { curveSha256: hashFile(curvePath), publicProtocolSha256: hashFile(publicProtocolPath),
    rule: confirmation.candidateSelection, checkpoint: selected.id, developmentScore: selected.score },
};
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ selected: selected.id, developmentScore: selected.score,
  pairs: manifest.seeds.length, games: manifest.maximumGames, manifestSha256: hashFile(outputPath) }));
