// Snapshot a verified checkpoint/runtime handoff. No client imports or access.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { model6SourceFiles } from '../integrations/official-client/model6.mjs';

const [handoffPath, priorManifest, ...extra] = process.argv.slice(2);
if (!priorManifest || extra.length) throw new Error('usage: prepare-model6-handoff <verified-handoff-json> <prior-private-input-manifest>');
const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const hash = value => createHash('sha256').update(value).digest('hex');
const handoffBytes = await readFile(handoffPath), h = JSON.parse(handoffBytes.toString('utf8').replace(/^\uFEFF/, ''));
const old = await read(priorManifest), config = await read(h.ordinaryConfig), selectionConfig = await read(h.selectionConfig);
if (h.schema !== 'model6-immutable-viewing-handoff/1' || !h.cpuServicePingVerified || !h.sourceGuardEnforced
    || !Number.isSafeInteger(h.optimizerUpdates) || h.optimizerUpdates < 1 || !/^[a-z0-9-]{1,64}$/.test(h.id ?? '')
    || !isAbsolute(h.frozenSourceRoot ?? '') || !['model6-energy-residual/1', 'model6-energy-residual/2'].includes(h.actorArchitecture)
    || config.device !== 'cpu' || selectionConfig.device !== 'cpu' || resolve(config.checkpoint) !== resolve(h.checkpoint)
    || h.expectedSha256 !== undefined && h.expectedSha256 !== h.checkpointSha256
    || config.catalogSha256 !== selectionConfig.catalogSha256 || config.frozenSelectionSha256 !== h.selectionCheckpointSha256)
  throw new Error('verified-complete-cpu-viewing-handoff-required');
for (const [file, digest] of [[h.checkpoint, h.checkpointSha256], [selectionConfig.checkpoint, h.selectionCheckpointSha256],
  [config.catalogPath, config.catalogSha256], [selectionConfig.catalogPath, selectionConfig.catalogSha256]])
  if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(digest ?? '') || hash(await readFile(file)) !== digest) throw new Error('handoff-artifact-pin-mismatch');
const root = resolve(import.meta.dirname, '..'), snapshot = join(root, '.cache', `model6-source-${randomUUID()}`), sourceSha256 = {};
for (const file of model6SourceFiles) {
  const bytes = await readFile(join(h.frozenSourceRoot, file)), digest = hash(bytes);
  // The Python service checks these 12 files against checkpoint metadata itself.
  if (model6SourceFiles.indexOf(file) < 12 && h.sourceHashes?.[file] !== digest) throw new Error('handoff-source-freeze-mismatch:' + file);
  await mkdir(dirname(join(snapshot, file)), { recursive: true });
  await writeFile(join(snapshot, file), bytes, { flag: 'wx' }); sourceSha256[file] = digest;
}
for (const file of model6SourceFiles)
  if (hash(await readFile(join(h.frozenSourceRoot, file))) !== sourceSha256[file]) throw new Error('handoff-source-changed-during-snapshot');
const catalogBytes = await readFile(config.catalogPath), catalogPath = join(snapshot, 'private-public-catalog.json');
if (hash(catalogBytes) !== config.catalogSha256) throw new Error('handoff-catalog-changed-during-snapshot');
await writeFile(catalogPath, catalogBytes, { flag: 'wx' });
config.catalogPath = catalogPath; selectionConfig.catalogPath = catalogPath;
const inputFiles = old.inputFiles, inputSha256 = {};
for (const [key, file] of Object.entries(inputFiles)) {
  inputSha256[key] = hash(await readFile(file));
  if (inputSha256[key] !== old.inputSha256[key]) throw new Error('prior-player-visible-input-pin-changed');
}
const manifest = { schema: 'official-client-model6/2', arm: h.id, update: h.optimizerUpdates, optimizerUpdates: h.optimizerUpdates,
  cohortStageUpdate: h.updates ?? null, stage: 'post-PPO', expectedActorArchitecture: h.actorArchitecture,
  policyId: `model6-${h.id}-ppo-updates-${h.optimizerUpdates}-${h.checkpointSha256.slice(0, 12)}`,
  selectionStatus: h.role ?? 'provisional diagnostic candidate; no strength winner claim',
  sourceRoot: snapshot, sourceRevision: 'immutable raw-byte snapshot of verified handoff', sourceSha256,
  handoffSha256: hash(handoffBytes), checkpointSha256: h.checkpointSha256, contractSha256: h.contractSha256,
  modelConfig: config, selectionConfig, inputFiles, inputSha256, clientInputEnabled: false,
  nativeToLiveFeatureParity: 'partial; previous explicit masks retained; unverified Energy helper disabled',
  appliedExposure: { games: h.totalCohortNaturalGames ?? null, transitions: h.totalCohortTransitions ?? null, byDeck: h.cohortAppliedExposure ?? null },
  selectionPolicy: 'PPO client-validated singleton choices; pinned BC multiselect/reparent; attributed existing helpers',
  clientAuthorization: 'preparation only; no client attach/input or game authorized by this manifest' };
await writeFile(join(root, '.cache', 'official-client-model6.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
for (const marker of ['official-client-input.kill', 'official-client-runtime.kill'])
  await writeFile(join(root, '.cache', marker), 'model6-handoff-preparation-only\n', { flag: 'wx' });
await writeFile(join(root, '.cache', 'model6-handoff-frozen.json'), handoffBytes, { flag: 'wx' });
console.log(JSON.stringify({ prepared: true, policyId: manifest.policyId, checkpointSha256: manifest.checkpointSha256,
  optimizerUpdates: manifest.optimizerUpdates, stageUpdates: manifest.cohortStageUpdate,
  sourceFiles: model6SourceFiles.length, clientAttached: false, inputEnabled: false, rulesHelperEnabled: false }));
