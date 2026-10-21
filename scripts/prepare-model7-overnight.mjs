import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {spawnSync} from 'node:child_process';

const [preparedPath, protocolPath] = process.argv.slice(2);
if (!preparedPath || !protocolPath || process.argv.length !== 4)
  throw Error('Usage: prepare-model7-overnight <archived-preparation-manifest> <predeclared-protocol>');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const prepared = read(preparedPath), protocol = read(protocolPath), directory = path.dirname(path.resolve(preparedPath));
if (prepared.schema !== 'model7-outcome-pilot/1' || protocol.schema !== 'model7-overnight-design/1'
    || protocol.oneTrainingTrajectory !== true || protocol.training.batchGames !== 64
    || protocol.training.workers !== 4 || protocol.training.maximumBatches !== 32
    || protocol.training.allocatedSeconds !== 21600
    || Date.parse(protocol.training.deadlineUtc) - Date.parse(protocol.training.startUtc) !== 21600000
    || prepared.initialCheckpointSha256 !== protocol.initialization.ordinarySha256
    || prepared.selectionCheckpointSha256 !== protocol.initialization.selectionSha256
    || !isDeepStrictEqual(prepared.reward, protocol.reward) || !isDeepStrictEqual(prepared.ppoConfig, protocol.ppoConfig))
  throw Error('Exact selected single-trajectory design and archived preparation required');
for (const [file, digest] of Object.entries(prepared.filePins))
  if (hash(file) !== digest) throw Error(`Prepared input changed: ${file}`);
const seeds = new Set();
for (const [index, batch] of protocol.training.batches.entries()) {
  if (batch.index !== index + 1 || batch.tasks.length !== 64) throw Error('Exact ordered 64-game batches required');
  for (const opponentPolicy of ['baseline', 'teacher']) for (const policySeat of ['human', 'opponent'])
    if (batch.tasks.filter(task => task.opponentPolicy === opponentPolicy && task.policySeat === policySeat).length !== 16)
      throw Error('Balanced fixed opponents and seats required');
  for (const task of batch.tasks) {
    if (!Number.isSafeInteger(task.seed) || seeds.has(task.seed)) throw Error('Unique predeclared training seeds required');
    seeds.add(task.seed);
  }
}
if (seeds.size !== 2048) throw Error('Exactly 2048 guarded training seeds required');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preflight=spawnSync(prepared.python,[path.join(repo,'scripts/preflight-model7-overnight.py'),preparedPath,protocolPath],
  {windowsHide:true,encoding:'utf8',env:{...process.env,PYTHONUNBUFFERED:'1'}});
if(preflight.status!==0) throw Error(`Checkpoint/optimizer/device preflight failed: ${preflight.stderr}`);
const preflightPath=path.join(directory,'execution-preflight.json');
fs.writeFileSync(preflightPath,JSON.stringify(JSON.parse(preflight.stdout),null,2)+'\n',{flag:'wx'});
const controller = path.join(prepared.runtimeRoot, 'scripts/run-model7-overnight.mjs');
fs.copyFileSync(path.join(repo, 'scripts/run-model7-overnight.mjs'), controller);
const localProtocol = path.join(directory, 'overnight-protocol.json');
fs.copyFileSync(protocolPath, localProtocol, fs.constants.COPYFILE_EXCL);
const manifest = {schema:'model7-overnight-execution/1', approval:'approved', at:new Date().toISOString(),
  preparedManifest:path.resolve(preparedPath), preparedManifestSha256:hash(preparedPath),
  protocol:localProtocol, protocolSha256:hash(localProtocol), runtimeRoot:prepared.runtimeRoot,
  python:prepared.python, modelDirectory:prepared.modelDirectory, catalog:prepared.catalog,
  nativeConfig:prepared.nativeConfig, ordinaryConfig:prepared.ordinaryConfig,
  collectionPlan:{...prepared.collectionPlan, workers:4},
  initialCheckpoint:prepared.initialCheckpoint, initialCheckpointSha256:prepared.initialCheckpointSha256,
  outputDirectory:path.join(directory, 'overnight-run'), controller,
  filePins:{...prepared.filePins, [path.resolve(preparedPath)]:hash(preparedPath),
    [localProtocol]:hash(localProtocol), [controller]:hash(controller), [preflightPath]:hash(preflightPath)}};
const manifestPath = path.join(directory, 'overnight-manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest,null,2)+'\n', {flag:'wx'});
console.log(JSON.stringify({manifest:manifestPath, manifestSha256:hash(manifestPath),
  protocolSha256:manifest.protocolSha256, controller, modelLoads:1, games:0, fits:0}));
