import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const foundationFiles = [
  'agents/first-baseline.mjs', 'environment/native-game.mjs', 'environment/frozen-runtime.mjs',
  'integrations/local-worker/agent-bundle.mjs',
  'scripts/prepare-first-baseline.mjs', 'scripts/verify-first-baseline.mjs',
];

// Keep the checkpoint's historical source guard intact, including raw line endings.
export function recordedSources(repo, spec) {
  const archive = path.join(repo, 'repro/model7-outcome-001');
  const overrides = readJson(path.join(archive, 'manifest.json'));
  return Object.entries(spec.runtimeSourceHashes).map(([file, sha256]) => {
    const override = overrides.files.find(row => row.path === file);
    let source = override ? path.join(archive, override.repositoryOverride) : path.join(repo, file);
    if (file.startsWith('integrations/local-worker/native-source/')) source = path.join(archive, 'native-source', path.basename(file));
    if (hashFile(source) !== sha256) throw Error(`Recorded source bytes differ: ${file}`);
    return { file, source, sha256 };
  });
}

export function verifyFrozenRuntime(config) {
  const lock = readJson(path.join(config.runtimeRoot, 'environment/first-baseline-v1.lock.json'));
  if (config.schema !== 'first-baseline-environment/1' || lock.version !== config.environmentVersion)
    throw Error('frozen environment version mismatch');
  if (hashFile(path.join(config.runtimeRoot, 'environment/first-baseline-v1.lock.json')) !== config.lockSha256)
    throw Error('frozen environment lock mismatch');
  for (const [name, sha256] of Object.entries({ ...lock.recordedSources, ...lock.foundationSources }))
    if (hashFile(path.join(config.runtimeRoot, name)) !== sha256) throw Error(`Frozen runtime changed: ${name}`);
  for (const [file, sha256] of Object.entries(config.filePins))
    if (hashFile(file) !== sha256) throw Error('Frozen private prerequisite changed');
  if (config.nativeConfig) verifyNativeVersion(readJson(config.nativeConfig), lock);
  return lock;
}

export function verifyNativeVersion(native, lock) {
  const inputs = verifyLocalInputs(native);
  for (const key of ['workerSha256', 'policySha256'])
    if (native[key] !== lock.nativePins[key]) throw Error(`Frozen native component changed: ${key}`);
  for (const [name, sha256] of Object.entries(lock.nativeBundleFiles))
    if (hashFile(path.join(native.bundleRoot, name)) !== sha256) throw Error(`Frozen native prerequisite changed: ${name}`);
  return inputs;
}
