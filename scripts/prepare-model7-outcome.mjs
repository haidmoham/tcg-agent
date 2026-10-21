// File preparation only: no models, native workers, games or optimizers are started.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const [configPath] = process.argv.slice(2);
if (!configPath || process.argv.length !== 3) throw Error('Usage: prepare-model7-outcome <private-inputs.json>');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.join(repo, 'repro/model7-outcome-001');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {flag:'wx'});
const check = (value, message) => { if (!value) throw Error(message); };
const config = read(configPath), spec = read(path.join(archive, 'run-spec.json'));
check(spec.schema === 'model7-outcome-reproduction/1', 'Unsupported reproduction spec');
check(path.isAbsolute(config.outputRoot ?? ''), 'Absolute, fresh private outputRoot required');
const prep = path.resolve(config.outputRoot), inside = path.relative(repo, prep);
check(path.isAbsolute(inside) || inside === '..' || inside.startsWith(`..${path.sep}`), 'Private output must be outside the Git checkout');
check(!fs.existsSync(prep), 'Fresh output required; inspect previous effects before retrying');
for (const file of [config.nativeConfig, config.teacherCatalogPath, config.ordinary?.executable,
  config.ordinary?.checkpoint, config.ordinary?.catalogPath, config.selection?.checkpoint])
  check(typeof file === 'string' && path.isAbsolute(file) && fs.statSync(file).isFile(), 'Explicit existing local inputs required');
check(hash(config.ordinary.checkpoint) === spec.baseline.ordinarySha256, 'Original Model6 baseline required');
check(hash(config.selection.checkpoint) === spec.baseline.selectionSha256, 'Original frozen selector required');
check(hash(config.ordinary.catalogPath) === spec.catalogSha256, 'Original catalog required');
check(hash(config.teacherCatalogPath) === spec.teacherCatalogSha256, 'Original heuristic catalog required');

const native = read(config.nativeConfig);
for (const [key, digest] of Object.entries(spec.nativePins)) check(native[key] === digest, `Native pin differs: ${key}`);
const originalProbe = await import(pathToFileURL(path.join(repo, 'integrations/local-worker/probe.mjs')));
const verified = originalProbe.verifyLocalInputs(native); // Hash validation, never spawns a worker.
const deckHash = deck => createHash('sha256').update(JSON.stringify(deck)).digest('hex');
check(verified.selected.every(deck => deckHash(deck) === spec.deckSha256), 'Original mirrored 60-card recipe required');

fs.mkdirSync(prep);
const runtime = path.join(prep, 'runtime'), models = path.join(prep, 'models');
fs.mkdirSync(path.join(runtime, 'runs'), {recursive:true});
fs.mkdirSync(models);
const overrides = read(path.join(archive, 'manifest.json'));
for (const [file, digest] of Object.entries(spec.runtimeSourceHashes)) {
  let source = path.join(repo, file);
  const override = overrides.files.find(row => row.path === file);
  if (override) source = path.join(archive, override.repositoryOverride);
  if (file.startsWith('integrations/local-worker/native-source/'))
    source = path.join(archive, 'native-source', path.basename(file));
  check(hash(source) === digest, `Recorded source bytes differ: ${file}`);
  const destination = path.join(runtime, file);
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  fs.copyFileSync(source, destination);
}
// Python namespace modules and .mjs files need no package install for this isolated runtime.
fs.cpSync(path.join(archive, 'native-source'), path.join(prep, 'native/source'), {recursive:true});
for (const [file, digest] of Object.entries(spec.nativeSourceHashes))
  check(hash(path.join(prep, 'native/source', file)) === digest, 'Native authored source differs');
fs.cpSync(path.dirname(native.worker), path.join(prep, 'native/bin'), {recursive:true});
fs.cpSync(native.bundleRoot, path.join(prep, 'bundle'), {recursive:true});
fs.copyFileSync(native.policyModule, path.join(prep, 'helper.mjs'));
native.worker = path.join(prep, 'native/bin', path.basename(native.worker));
native.bundleRoot = path.join(prep, 'bundle'); native.policyModule = path.join(prep, 'helper.mjs');
native.workerSourceRoot = path.join(prep, 'native/source'); native.workerSourceSha256 = spec.nativeSourceHashes;
const nativePath = path.join(prep, 'native-config.json'); save(nativePath, native);
const localVerified = originalProbe.verifyLocalInputs(native);
check(localVerified.selected.every(deck => deckHash(deck) === spec.deckSha256), 'Copied input verification failed');
for (const [source, destination] of [[config.ordinary.checkpoint, 'models/baseline.pt'],
  [config.selection.checkpoint, 'models/selection.pt'], [config.ordinary.catalogPath, 'catalog.json'],
  [config.teacherCatalogPath, 'teacher-catalog.json']]) fs.copyFileSync(source, path.join(prep, destination));
const common = {executable:config.ordinary.executable, modelRoot:models, catalogPath:path.join(prep, 'catalog.json'),
  catalogSha256:spec.catalogSha256, device:'cpu', seed:81729};
const ordinary = {...common, checkpoint:path.join(models, 'baseline.pt'), frozenSelectionSha256:spec.baseline.selectionSha256};
const selection = {...common, checkpoint:path.join(models, 'selection.pt')};
const selectionPath = path.join(prep, 'selection.json'), opponentPath = path.join(prep, 'frozen-opponent.json');
save(selectionPath, selection); save(opponentPath, ordinary);
const confirmation = path.join(prep, 'confirmation'); fs.mkdirSync(confirmation);
const protocol = {...spec.confirmation, nativeConfigSha256:hash(nativePath)};
const protocolPath = path.join(confirmation, 'protocol.json'); save(protocolPath, protocol);
const executionPath = path.join(confirmation, 'private-execution-inputs.json');
save(executionPath, {nativeConfig:nativePath, runtimeRoot:runtime, ordinary, selection, protocolSha256:hash(protocolPath)});
const filePins = {};
const pinTree = directory => {
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) pinTree(file); else filePins[file] = hash(file);
  }
};
pinTree(prep);
const manifest = {schema:'model7-outcome-pilot/1', approval:config.approval === 'approved' ? 'approved' : 'not-approved',
  at:new Date().toISOString(), reward:spec.reward, runtimeRoot:runtime, python:common.executable,
  outputDirectory:path.join(prep, 'run'), modelDirectory:models, initialCheckpoint:ordinary.checkpoint,
  initialCheckpointSha256:spec.baseline.ordinarySha256, selectionCheckpoint:selection.checkpoint,
  selectionCheckpointSha256:spec.baseline.selectionSha256, catalog:common.catalogPath, ordinaryConfig:ordinary,
  nativeConfig:nativePath, collectionPlan:{schema:'entity-ppo-plan/1', mode:'collect', workers:2, seed:81729,
    maximumGameSeconds:240, maximumGameCommands:600, selectionConfig:selectionPath,
    baselineOpponentConfig:opponentPath, baselineOpponentKind:'ppo', baselineCheckpointSha256:spec.baseline.ordinarySha256,
    fixedDeckSha256:spec.deckSha256, teacherCatalogPath:path.join(prep, 'teacher-catalog.json')},
  batches:spec.batches, validationTasks:spec.validationTasks, confirmationProtocol:protocolPath,
  ppoConfig:spec.ppoConfig, initialOptimizer:'unchanged copied update23', baselineUpdateCount:23, filePins,
  reproduction:{specSha256:hash(path.join(archive, 'run-spec.json')), evaluationSeedsAlreadyConsumed:true}};
save(path.join(prep, 'manifest.json'), manifest);
save(path.join(prep, 'preflight.json'), {at:new Date().toISOString(), recordedRuntimeSourcePins:Object.keys(spec.runtimeSourceHashes).length,
  originalCheckpointCopyExact:hash(ordinary.checkpoint) === spec.baseline.ordinarySha256,
  originalSelectorCopyExact:hash(selection.checkpoint) === spec.baseline.selectionSha256,
  exactDecks:localVerified.selected.map(deckHash), manifestSha256:hash(path.join(prep, 'manifest.json')),
  modelLoads:0, games:0, fits:0, reproductionOnly:true});
console.log(JSON.stringify({manifest:path.join(prep, 'manifest.json'), prepared:true, modelLoads:0, games:0, fits:0}));
