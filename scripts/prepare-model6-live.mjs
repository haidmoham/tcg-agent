// Copies authored runtime source only. No client access, inference or training.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const [snapshot, receiptFile, cpuConfigFile, previousManifestFile, ...extra] = process.argv.slice(2);
if (!previousManifestFile || extra.length) throw new Error('usage: prepare-model6-live <matching-source-snapshot> <update-receipt> <frozen-selection-cpu-config> <prior-private-input-manifest>');
const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = await read(receiptFile), selectionConfig = await read(cpuConfigFile), previous = await read(previousManifestFile);
const checkpoint = join(dirname(resolve(receiptFile)), 'update-004.pt');
if (receipt.schema !== 'entity-masked-ppo-update/1' || receipt.updateCount !== 4
    || receipt.checkpointSha256 !== '391e5545c303317a81bd82b4ea355681aed657ae4950c58847a26b49155f70c1'
    || hash(await readFile(checkpoint)) !== receipt.checkpointSha256 || selectionConfig.device !== 'cpu'
    || hash(await readFile(selectionConfig.checkpoint)) !== receipt.frozenSelectionSha256) throw new Error('exact-control-pilot-update4-required');
const root = resolve(import.meta.dirname, '..'), sourceRoot = join(root, '.cache', `model6-source-${randomUUID()}`);
const extras = ['integrations/local-worker/model6-model.mjs', 'integrations/local-worker/model6-policy-view.mjs',
  'integrations/local-worker/policy-view.mjs', 'integrations/local-worker/card-action-policy.mjs'];
const sourceSha256 = {};
for (const file of new Set([...Object.keys(receipt.sourceHashes), ...extras])) {
  const bytes = await readFile(join(snapshot, file)), digest = hash(bytes);
  if (receipt.sourceHashes[file] && receipt.sourceHashes[file] !== digest) throw new Error('retained-runtime-pin-mismatch:' + file);
  await mkdir(dirname(join(sourceRoot, file)), { recursive: true });
  await writeFile(join(sourceRoot, file), bytes, { flag: 'wx' }); sourceSha256[file] = digest;
}
const inputFiles = previous.inputFiles, inputSha256 = {};
for (const [key, file] of Object.entries(inputFiles)) {
  inputSha256[key] = hash(await readFile(file));
  if (inputSha256[key] !== previous.inputSha256[key]) throw new Error('prior-visible-input-pin-changed');
}
const manifest = { schema: 'official-client-model6/1', arm: 'control', update: 4, stage: 'post-PPO',
  selectionStatus: 'unselected diagnostic viewing candidate', sourceRoot, sourceRevision: 'retained-source-snapshot; raw-byte pins authoritative',
  sourceSha256, checkpointSha256: receipt.checkpointSha256, contractSha256: receipt.contractSha256,
  sourceReceiptSha256: hash(await readFile(receiptFile)),
  modelConfig: { ...selectionConfig, checkpoint, frozenSelectionSha256: receipt.frozenSelectionSha256, seed: 81729 }, selectionConfig,
  inputFiles, inputSha256, clientInputEnabled: false,
  nativeToLiveFeatureParity: 'partial: rendered supply/printed costs; effective costs/retreat payment/attachment counterfactuals/usage unknown',
  selectionPolicy: 'PPO single-card prompts with complete client-menu Validate mask; frozen Model6 BC rankings otherwise; no alternative strategic override' };
await writeFile(join(root, '.cache/official-client-model6.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(root, '.cache/official-client-input.kill'), 'model6-viewing-preparation-only\n', { flag: 'wx' });
console.log(JSON.stringify({ prepared: true, arm: manifest.arm, update: 4, stage: manifest.stage,
  checkpointSha256: receipt.checkpointSha256, matchingFrozenSourceFiles: Object.keys(receipt.sourceHashes).length, clientAttached: false }));
