// Preparation only: immutable authored-source snapshot and private config.
// No client imports, model inference, simulation or client process discovery.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { model5CheckpointSha256, model5SourceFiles } from '../integrations/official-client/model5.mjs';

const [sourceRoot, freezeFile, configFile, inputsFile, ...extra] = process.argv.slice(2);
if (!inputsFile || extra.length) throw new Error('usage: node scripts/prepare-model5-live.mjs <trainer-root-or-bundled> <frozen-bc-json> <frozen-cpu-config> <private-input-files-json>');
const root = resolve(import.meta.dirname, '..'), run = promisify(execFile);
const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = await read(freezeFile), modelConfig = await read(configFile), inputFiles = await read(inputsFile);
const bundledRoot = join(root, 'integrations/official-client/model5-frozen-source');
const bundled = sourceRoot === 'bundled' ? await read(join(bundledRoot, 'manifest.json')) : null;
if (bundled && (bundled.schema !== 'official-client-model5-frozen-source/1' || bundled.sourceRevision !== freeze.sourceRevision
    || bundled.checkpointSha256 !== freeze.checkpointSha256 || bundled.contractSha256 !== freeze.contractSha256))
  throw new Error('bundled-model5-source-contract-mismatch');
if (freeze.schema !== 'frozen-bc-baseline/1' || freeze.model !== 'Model5' || freeze.stage !== 'pre-RL'
    || freeze.checkpointSha256 !== model5CheckpointSha256 || !/^[a-f0-9]{40}$/.test(freeze.sourceRevision)
    || freeze.checkpoint !== modelConfig.checkpoint || modelConfig.device !== 'cpu'
    || hash(await readFile(modelConfig.checkpoint)) !== model5CheckpointSha256
    || hash(await readFile(modelConfig.catalogPath)) !== modelConfig.catalogSha256) throw new Error('exact-frozen-model5-cpu-artifact-required');
const keys = ['frozenHelper', 'cardCorpus', 'deckBundle'];
if (Object.keys(inputFiles).length !== keys.length || keys.some(key => typeof inputFiles[key] !== 'string')) throw new Error('explicit-helper-corpus-deck-inputs-required');
const inputSha256 = Object.fromEntries(await Promise.all(keys.map(async key => [key, hash(await readFile(inputFiles[key]))])));
if (inputSha256.frozenHelper !== '40acf530ca787caaf446f515173b1ed0fd9cd6353e8313f44ac015d705d288b1') throw new Error('existing-helper-pin-required');
const privateRoot = join(root, '.cache'), snapshot = join(privateRoot, `model5-source-${randomUUID()}`), sourceSha256 = {};
await mkdir(snapshot, { recursive: true });
for (const file of model5SourceFiles) {
  const stdout = bundled ? await readFile(join(bundledRoot, file)) : (await run('git', ['-C', resolve(sourceRoot), 'show', `${freeze.sourceRevision}:${file}`],
    { encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout;
  if (bundled && hash(stdout) !== bundled.sourceSha256?.[file]) throw new Error('bundled-model5-source-pin-mismatch:' + file);
  const target = join(snapshot, file); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, stdout, { flag: 'wx' }); sourceSha256[file] = hash(stdout);
}
const manifest = { schema: 'official-client-model5/1', checkpointSha256: model5CheckpointSha256,
  sourceRevision: freeze.sourceRevision, sourceRoot: snapshot, sourceSha256, contractSha256: freeze.contractSha256,
  modelConfig, inputFiles, inputSha256, clientInputEnabled: false, requireFreshClientIdentity: true,
  nativeToLiveFeatureParity: 'unknown; source preparation without client observations',
  helperPolicy: 'existing attributed setup/text/prize/allocation/empty-selection helpers only; no ordinary override' };
const output = join(privateRoot, 'official-client-model5.json');
await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
for (const marker of ['official-client-input.kill', 'official-client-runtime.kill']) {
  try { await writeFile(join(privateRoot, marker), 'model5-viewing-preparation-only\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
console.log(JSON.stringify({ prepared: true, manifest: output, checkpointSha256: model5CheckpointSha256,
  sourceRevision: freeze.sourceRevision, clientAttached: false, inputsEnabled: false, testsRun: 0, gamesRun: 0 }));
