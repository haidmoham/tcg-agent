import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyLocalInputs } from './probe.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
verifyLocalInputs(config);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const buildId = config.auditBuildId ?? 'native-audit-v1';
if (!/^native-audit-[a-z0-9-]+$/.test(buildId)) throw new Error('invalid isolated build identity');
const project = resolve('.cache', buildId, 'project');
if (existsSync(project)) throw new Error('preserve existing isolated audit build; use a new task output directory');
if (typeof config.workerSourceRoot !== 'string' || !config.workerSourceSha256) throw new Error('pin original worker source before preparing');
const names = ['Indigo.Live.Engine.csproj', 'NuGet.Config', 'Program.cs', 'ProgramInputs.cs', 'MatchWorker.cs', 'MatchWorker.Offers.cs', 'MatchWorker.Projection.cs', 'MatchWorker.Presentation.cs', 'MatchWorker.Selections.cs'];
const files = new Map(names.map(name => {
  const bytes = readFileSync(join(config.workerSourceRoot, name));
  if (hash(bytes) !== config.workerSourceSha256[name]) throw new Error('original worker source pin mismatch');
  return [name, bytes.toString('utf8')];
}));
const replaceOnce = (name, before, after) => {
  const source = files.get(name);
  if (source.split(before).length !== 2) throw new Error(`isolated hook changed: ${name}`);
  files.set(name, source.replace(before, after));
};
replaceOnce('MatchWorker.cs', 'bundle = new Bundle(bundleDirectory, manifestHash);', 'FreezeOfflineClock();\n        bundle = new Bundle(bundleDirectory, manifestHash);');
replaceOnce('MatchWorker.cs', 'if (authority != null || epoch != null)', 'ConfigureOffline(input);\n        if (authority != null || epoch != null)');
replaceOnce('MatchWorker.cs', 'new DateBasedVersion(new DateTime(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc)));', 'new DateBasedVersion(new DateTime(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc)), randomSeedGenerator: offlineRng);');
replaceOnce('MatchWorker.cs', 'new MatchOperation(nativeAction, authority);', 'new MatchOperation(nativeAction, authority, randomSeedGenerator: offlineRng);');
replaceOnce('MatchWorker.cs', '"view" => View(RequireObject(payload)),', '"audit" => OfflineAudit(RequireObject(payload)),\n            "view" => View(RequireObject(payload)),');
replaceOnce('MatchWorker.cs', '"audit" => OfflineAudit(RequireObject(payload)),', '"audit" => OfflineAudit(RequireObject(payload)),\n            "audit-use" => OfflineUseAudit(RequireObject(payload)),\n            "audit-privacy" => OfflinePrivacyProbe(RequireObject(payload)),\n            "offline-batch" => OfflineBatch(RequireObject(payload)),');
replaceOnce('MatchWorker.cs', 'RecordPresentation(commandId, previousFrame, seat, acceptedOffer, acceptedTrainerUse,', 'if (!offlineBenchmarkMode) RecordPresentation(commandId, previousFrame, seat, acceptedOffer, acceptedTrainerUse,');
replaceOnce('MatchWorker.Projection.cs', 'bool viewerOne = seat == "human";', 'using var offlineProjectionScope = BeginOfflineProjection();\n        bool viewerOne = seat == "human";');
replaceOnce('MatchWorker.Projection.cs', '["cardDetails"] = CardDetails(board, viewerOne, offered),', '["cardDetails"] = offlineBenchmarkMode ? new JArray() : CardDetails(board, viewerOne, offered),');
replaceOnce('MatchWorker.Projection.cs', '["activeDetails"] = ActiveDetails(board, read, viewerOne, offered),', '["activeDetails"] = offlineBenchmarkMode ? new JArray() : ActiveDetails(board, read, viewerOne, offered),');
replaceOnce('MatchWorker.cs', 'authority.workingBoard.RebuildEntityList();', 'authority.workingBoard.RebuildEntityList();\n        RegisterOfflineIdentities();');
for (const name of ['MatchWorker.cs', 'MatchWorker.Projection.cs']) replaceOnce(name, 'authority!.CopyOperation()', 'OfflineReadCopy()');
replaceOnce('MatchWorker.Offers.cs', 'card.GetUseActions(onlyActionsOnEntity: true)', 'OfflineUseActions(card)');
replaceOnce('MatchWorker.Offers.cs', 'card!.GetUseActions(onlyActionsOnEntity: false)', 'OfflineUseActions(card!)');
if (files.get('MatchWorker.Offers.cs').split('.Where(x => x != null)').length !== 4) throw new Error('isolated card filtering hook changed');
files.set('MatchWorker.Offers.cs', files.get('MatchWorker.Offers.cs').replaceAll('.Where(x => x != null)', '.OfType<CardEntity>()'));
replaceOnce('MatchWorker.Offers.cs', 'if (source.cardFormat == CardFormat.Pokemon)', 'if (source.cardFormat is CardFormat.Pokemon or CardFormat.TrainerItemPokemon)');
replaceOnce('MatchWorker.Offers.cs', 'if (source.cardStage == CardStage.Basic)', 'if (source.cardStage == CardStage.Basic || source.cardFormat == CardFormat.TrainerItemPokemon)');
replaceOnce('MatchWorker.Offers.cs', '        if (active != null)\r\n', `        foreach (var extra in OfflineExtraOrigins(seat))
        foreach (var extraAction in OfflineUseActions(extra))
        {
            var extraSource = CardCache.Get(extra.cardSourceID);
            Offer(OperationType.Use, extra, extraAction.actionGuid, null, BoardPos.Board,
                extraAction.actionType == ActionType.Attack ? "attack" : "ability", "use visible action",
                extraSource.cardSourceID + "/" + extraAction.actionSourceID,
                extraAction.actionType == ActionType.Attack ? extraAction.actionName : null);
        }
        if (active != null)\r\n`);
replaceOnce('MatchWorker.Offers.cs', '.ThenBy(choice => choice["card"]?.Value<string>("instanceId") ?? choice.Value<string>("id"), StringComparer.Ordinal)', '.ThenBy(choice => OfflineIdentityOrder(choice["card"]?.Value<string>("instanceId") ?? choice.Value<string>("id")))');
mkdirSync(project, { recursive: true });
for (const [name, text] of files) writeFileSync(join(project, name), text);
writeFileSync(join(project, 'OfflineAudit.cs'), readFileSync(new URL('OfflineAudit.cs', import.meta.url)));
const output = resolve('.cache', buildId, 'bin');
const result = spawnSync(config.executable, ['build', 'Indigo.Live.Engine.csproj', '--configfile', 'NuGet.Config', `-p:LiveRuntimeRoot=${config.bundleRoot}`, '-o', output, '--nologo'], { cwd: project, windowsHide: true, timeout: 60000, encoding: 'utf8', env: { ...process.env, DOTNET_CLI_HOME: resolve('.cache/dotnet-home'), DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', NUGET_PACKAGES: resolve('.cache/nuget') } });
if (result.status !== 0) { console.error(result.stdout, result.stderr); process.exit(1); }
const worker = join(output, 'Indigo.Live.Engine.dll');
const next = { ...config, worker, workerSha256: hash(readFileSync(worker)), offlineAuditVersion: 'indigo-offline-audit/1' };
writeFileSync(resolve('runs/local-audit-config.json'), JSON.stringify(next, null, 2));
console.log('Original isolated offline audit worker built; private config saved under ignored runs.');
