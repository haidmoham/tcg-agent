import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';

// Rebuild only authored glue against user-supplied, hash-pinned private inputs.
// No downloads, client attachment, model loading, collection or training.
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const requireThat = (value, code) => { if (!value) throw new Error(code); };
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

try {
  const [configFile, flag, ...extra] = process.argv.slice(2);
  requireThat(configFile && (!flag || flag === '--verify-only') && !extra.length, 'usage: node scripts/setup-native-baseline.mjs runs/setup-native.json [--verify-only]');
  const config = read(resolve(configFile));
  requireThat(config.schema === 'native-baseline-setup/1' && isAbsolute(config.dotnet ?? '') && isAbsolute(config.bundleRoot ?? ''), 'explicit-local-prerequisites-required');
  const pins = read(join(root, 'integrations/local-worker/baseline-prerequisites.json'));
  const source = join(root, 'integrations/local-worker/native-source');
  for (const [name, digest] of Object.entries(pins.source.files)) {
    requireThat(hash(readFileSync(join(source, name))) === digest, 'authored-worker-source-pin-mismatch');
  }
  const teacher = join(root, pins.teacher.file);
  requireThat(hash(readFileSync(teacher)) === pins.teacher.sha256, 'teacher-pin-mismatch');
  const bundle = realpathSync(config.bundleRoot);
  requireThat(hash(readFileSync(config.dotnet)) === pins.executableSha256, 'dotnet-executable-pin-mismatch');
  requireThat(hash(readFileSync(join(bundle, 'manifest.json'))) === pins.manifestSha256, 'private-manifest-pin-mismatch');
  for (const entry of pins.privateInputs) {
    const bytes = readFileSync(join(bundle, entry.path));
    requireThat(bytes.length === entry.bytes && hash(bytes) === entry.sha256, 'private-bundle-input-pin-mismatch');
  }
  const decks = read(join(bundle, 'decks.json'));
  for (const deck of read(join(root, 'integrations/local-worker/baseline-decks.json')).decks) {
    requireThat(deck.orderedSourceIDs.length === 60 && JSON.stringify(decks[deck.bundleKey]?.orderedSourceIDs) === JSON.stringify(deck.orderedSourceIDs), 'baseline-deck-order-mismatch');
  }
  const environment = { ...process.env, DOTNET_CLI_HOME: join(root, '.cache/dotnet-home'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', NUGET_PACKAGES: join(root, '.cache/nuget') };
  const version = spawnSync(config.dotnet, ['--version'], { cwd: root, env: environment, encoding: 'utf8', timeout: 10000, windowsHide: true });
  requireThat(version.status === 0 && version.stdout.trim() === pins.versions.dotnetSdk, 'dotnet-sdk-version-mismatch');
  if (flag === '--verify-only') {
    console.log(JSON.stringify({ schema: 'native-baseline-setup-receipt/1', verified: true, built: false, privateInputs: pins.privateInputs.length, authoredSources: Object.keys(pins.source.files).length, teacherSha256: pins.teacher.sha256 }));
  } else {
    const buildId = config.buildId ?? 'native-audit-repro';
    requireThat(/^native-audit-[a-z0-9-]+$/.test(buildId), 'invalid-isolated-build-id');
    const buildRoot = join(root, '.cache', buildId + '-base');
    const nativeConfig = join(root, 'runs/local-audit-config.json');
    requireThat(!existsSync(buildRoot) && !existsSync(join(root, '.cache', buildId)) && !existsSync(nativeConfig), 'fresh-build-and-output-required');
    mkdirSync(buildRoot, { recursive: true });
    mkdirSync(join(root, 'runs'), { recursive: true });
    const build = spawnSync(config.dotnet, ['build', join(source, 'Indigo.Live.Engine.csproj'), '--configuration', 'Release', '--configfile', join(source, 'NuGet.Config'),
      `-p:LiveRuntimeRoot=${bundle}`, `-p:BaseIntermediateOutputPath=${join(buildRoot, 'obj')}/`, '-o', join(buildRoot, 'bin'), '--nologo'],
    { cwd: root, env: environment, encoding: 'utf8', timeout: 60000, windowsHide: true });
    writeFileSync(join(buildRoot, 'private-build.log'), (build.stdout ?? '') + (build.stderr ?? ''));
    requireThat(build.status === 0, 'baseline-worker-build-failed-see-private-log');
    const worker = join(buildRoot, 'bin/Indigo.Live.Engine.dll');
    const prepared = { schema: 'local-worker-probe-v1', executable: config.dotnet, executableSha256: pins.executableSha256,
      worker, workerSha256: hash(readFileSync(worker)), bundleRoot: bundle, manifestSha256: pins.manifestSha256,
      policyModule: teacher, policySha256: pins.teacher.sha256, workerSourceRoot: source, workerSourceSha256: pins.source.files,
      auditBuildId: buildId, buildConfiguration: 'Release', projectionCopyMode: 'projection-turn-v1', maxCommands: 0, maxSeconds: 90 };
    verifyLocalInputs(prepared);
    const baseConfig = join(buildRoot, 'private-base-config.json');
    save(baseConfig, prepared);
    const audit = spawnSync(process.execPath, [join(root, 'integrations/local-worker/prepare-audit.mjs'), baseConfig],
      { cwd: root, env: environment, encoding: 'utf8', timeout: 90000, windowsHide: true });
    writeFileSync(join(buildRoot, 'private-audit-build.log'), (audit.stdout ?? '') + (audit.stderr ?? ''));
    requireThat(audit.status === 0, 'audit-worker-build-failed-see-private-log');
    const finalConfig = read(nativeConfig);
    verifyLocalInputs(finalConfig);
    console.log(JSON.stringify({ schema: 'native-baseline-setup-receipt/1', verified: true, built: true,
      config: 'runs/local-audit-config.json', workerSha256: finalConfig.workerSha256,
      teacherSha256: pins.teacher.sha256, manifestSha256: pins.manifestSha256, gamesStarted: 0 }));
  }
} catch (error) {
  // Filesystem and build errors may contain private paths; retain those locally.
  console.error(error.code ? 'native-baseline-local-prerequisite-unavailable' : error.message);
  process.exitCode = 1;
}
