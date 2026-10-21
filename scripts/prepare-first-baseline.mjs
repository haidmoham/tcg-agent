// File preparation only. No model service, worker, games or training.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstBaseline } from '../agents/first-baseline.mjs';
import { readJson, hashFile, recordedSources, foundationFiles, verifyNativeVersion } from '../environment/frozen-runtime.mjs';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const [inputPath, ...extra] = process.argv.slice(2);
if (!inputPath || extra.length) throw Error('Usage: prepare-first-baseline <private-inputs.json>');
const input = readJson(inputPath), output = path.resolve(input.outputRoot);
if (!path.isAbsolute(input.outputRoot) || fs.existsSync(output)) throw Error('fresh absolute outputRoot required');
const inside = path.relative(repo, output);
if (!path.isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${path.sep}`))
  throw Error('private runtime must be outside the source checkout');
const spec = readJson(path.join(repo, 'repro/model7-outcome-001/run-spec.json'));
const lockPath = path.join(repo, 'environment/first-baseline-v1.lock.json'), lock = readJson(lockPath);
const sources = recordedSources(repo, spec);
for (const name of foundationFiles) if (hashFile(path.join(repo, name)) !== lock.foundationSources[name])
  throw Error(`Foundation source differs from frozen version: ${name}`);
for (const [file, sha256] of [[input.ordinary.checkpoint, firstBaseline.ordinarySha256],
  [input.selection.checkpoint, firstBaseline.selectionSha256], [input.ordinary.catalogPath, firstBaseline.catalogSha256]])
  if (!path.isAbsolute(file) || hashFile(file) !== sha256) throw Error('first-baseline input mismatch');
if (!path.isAbsolute(input.ordinary.executable) || !fs.statSync(input.ordinary.executable).isFile()) throw Error('Python executable required');
const native = readJson(input.nativeConfig);
verifyNativeVersion(native, lock);
// This copies a chosen scenario. Deck recipes are recorded, not a new admission rule.
fs.mkdirSync(output, { recursive: true });
const runtime = path.join(output, 'runtime'), models = path.join(output, 'models');
fs.mkdirSync(models); fs.mkdirSync(path.join(runtime, 'runs'), { recursive: true });
for (const { file, source } of [...sources, ...foundationFiles.map(file => ({ file, source: path.join(repo, file) })),
  { file: 'environment/first-baseline-v1.lock.json', source: lockPath }]) {
  const dest = path.join(runtime, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest);
}
fs.cpSync(path.dirname(native.worker), path.join(output, 'native/bin'), { recursive: true });
fs.cpSync(path.join(repo, 'repro/model7-outcome-001/native-source'), path.join(output, 'native/source'), { recursive: true });
fs.cpSync(native.bundleRoot, path.join(output, 'bundle'), { recursive: true });
fs.copyFileSync(native.policyModule, path.join(output, 'helper.mjs'));
Object.assign(native, { worker: path.join(output, 'native/bin', path.basename(native.worker)), bundleRoot: path.join(output, 'bundle'),
  workerSourceRoot: path.join(output, 'native/source'), workerSourceSha256: spec.nativeSourceHashes, policyModule: path.join(output, 'helper.mjs') });
const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
save('native-config.json', native); verifyLocalInputs(native);
for (const [file, name] of [[input.ordinary.checkpoint, 'models/first-baseline.pt'],
  [input.selection.checkpoint, 'models/selection.pt'], [input.ordinary.catalogPath, 'catalog.json']]) fs.copyFileSync(file, path.join(output, name));
const common = { executable: input.ordinary.executable, modelRoot: models, catalogPath: path.join(output, 'catalog.json'),
  catalogSha256: firstBaseline.catalogSha256, device: 'cpu', seed: 81729 };
const filePins = {};
function pin(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  const file = path.join(dir, entry.name); if (entry.isDirectory()) pin(file); else filePins[file] = hashFile(file);
} }
pin(output); filePins[common.executable] = hashFile(common.executable); filePins[native.executable] = hashFile(native.executable);
const config = { schema: 'first-baseline-environment/1', environmentVersion: lock.version, agent: firstBaseline,
  runtimeRoot: runtime, lockSha256: hashFile(lockPath), nativeConfig: path.join(output, 'native-config.json'),
  ordinary: { ...common, checkpoint: path.join(models, 'first-baseline.pt'), frozenSelectionSha256: firstBaseline.selectionSha256 },
  selection: { ...common, checkpoint: path.join(models, 'selection.pt') }, filePins,
  platform: lock.platform, scenario: { deckRecipes: verifyLocalInputs(native).selected } };
save('first-baseline.json', config);
save('preparation.json', { environmentVersion: lock.version, lockSha256: config.lockSha256, agent: firstBaseline,
  sourcePins: sources.length + foundationFiles.length, filePins: Object.keys(filePins).length, modelLoads: 0, games: 0, fits: 0 });
console.log(JSON.stringify({ prepared: true, config: path.join(output, 'first-baseline.json'), modelLoads: 0, games: 0, fits: 0 }));
