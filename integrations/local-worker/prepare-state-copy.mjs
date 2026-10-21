import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyLocalInputs } from './probe.mjs';

const implementationVersion = 'native-state-copy/1.0.0';
const [referencePath, outputArgument, ...extra] = process.argv.slice(2);
if (!referencePath || !outputArgument || extra.length) throw Error('Usage: prepare-state-copy <reference-native-config.json> <fresh-private-output>');
const reference = JSON.parse(fs.readFileSync(referencePath, 'utf8').replace(/^\uFEFF/, ''));
verifyLocalInputs(reference);
const output = path.resolve(outputArgument);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const relativeOutput = path.relative(repository, output);
if (!path.isAbsolute(outputArgument) || fs.existsSync(output)
    || !path.isAbsolute(relativeOutput) && relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`))
  throw Error('Output must be a fresh absolute directory outside the source checkout');
if (!path.isAbsolute(reference.workerSourceRoot ?? '') || !reference.workerSourceSha256)
  throw Error('Reference worker source and exact source hashes required');
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const [name, expected] of Object.entries(reference.workerSourceSha256)) {
  if (path.basename(name) !== name || hashFile(path.join(reference.workerSourceRoot, name)) !== expected)
    throw Error(`Reference source changed: ${name}`);
}
const project = path.join(output, 'source');
fs.mkdirSync(project, { recursive: true });
for (const name of Object.keys(reference.workerSourceSha256))
  fs.copyFileSync(path.join(reference.workerSourceRoot, name), path.join(project, name));
fs.copyFileSync(new URL('NativeStateCopier.cs', import.meta.url), path.join(project, 'NativeStateCopier.cs'));
const auditPath = path.join(project, 'OfflineAudit.cs');
let auditSource = fs.readFileSync(auditPath, 'utf8');
const hook = '        if ((offlineCopyMode is "projection-snapshot-v1" or "projection-turn-v1") && offlineSnapshotAuthority != null)';
if (auditSource.split(hook).length !== 2) throw Error('Reference copy entry point changed');
auditSource = auditSource.replace(hook,
  '        if (NativeStateCopier.TryCopy(authority, out var directCopy)) copy = directCopy;\n        else ' + hook.trimStart());
const auditHeader = '["schema"] = "indigo-offline-audit/1", ["revision"] = revision,';
if (auditSource.split(auditHeader).length !== 2) throw Error('Reference copy audit changed');
auditSource = auditSource.replace(auditHeader,
  auditHeader + '\n            ["readCopyImplementation"] = NativeStateCopier.ImplementationVersion,');
fs.writeFileSync(auditPath, auditSource);
const statisticsPath = path.join(project, 'OfflineTurnPreflight.cs');
let statisticsSource = fs.readFileSync(statisticsPath, 'utf8');
const statisticsField = '["validationProposals"] = offlineValidationProposals,';
if (statisticsSource.split(statisticsField).length !== 2) throw Error('Reference statistics endpoint changed');
statisticsSource = statisticsSource.replace(statisticsField,
  statisticsField + '\n            ["readCopyRootFallbacks"] = NativeStateCopier.RootFallbackCount,\n            ["readCopySerializerSubtrees"] = NativeStateCopier.SerializerFallbackCount,');
fs.writeFileSync(statisticsPath, statisticsSource);

const buildArguments = ['build', path.join(project, 'Indigo.Live.Engine.csproj'), '-c', 'Release', '-o', path.join(output, 'bin'),
  '-m:1', '-p:UseSharedCompilation=false', `-p:LiveRuntimeRoot=${path.dirname(reference.worker)}`];
const build = spawnSync(reference.executable, buildArguments, { windowsHide: true, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, DOTNET_CLI_HOME: path.join(output, '.dotnet-home'), DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } });
fs.writeFileSync(path.join(output, 'build.log'), `${build.stdout ?? ''}\n${build.stderr ?? ''}`);
if (build.status !== 0) throw Error(`Native state-copy build failed; see ${path.join(output, 'build.log')}`);
const worker = path.join(output, 'bin', 'Indigo.Live.Engine.dll');
const configuration = { ...reference, worker, workerSha256: hashFile(worker), workerSourceRoot: project,
  workerSourceSha256: Object.fromEntries(fs.readdirSync(project).filter(name => /\.(cs|csproj)$/.test(name)).map(name => [name, hashFile(path.join(project, name))])),
  implementationVersion, referenceWorkerSha256: reference.workerSha256 };
verifyLocalInputs(configuration);
fs.writeFileSync(path.join(output, 'native-config.json'), JSON.stringify(configuration, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'build-receipt.json'), JSON.stringify({ schema: 'native-state-copy-build/1', at: new Date().toISOString(),
  implementationVersion, referenceConfigSha256: hashFile(referencePath), referenceWorkerSha256: reference.workerSha256,
  workerSha256: configuration.workerSha256, sourceSha256: configuration.workerSourceSha256, executableSha256: reference.executableSha256,
  buildArguments, referenceModified: false, semanticContract: 'Unchanged native rules and actor projection; independent state materialization with original serializer fallback.' }, null, 2) + '\n');
console.log(JSON.stringify({ implementationVersion, configuration: path.join(output, 'native-config.json'), workerSha256: configuration.workerSha256 }));
