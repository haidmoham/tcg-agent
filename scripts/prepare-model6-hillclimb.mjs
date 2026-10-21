import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const [outputArgument] = process.argv.slice(2);
if (!outputArgument || process.argv.length !== 3) throw Error('usage: prepare-model6-hillclimb <fresh-private-directory>');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(outputArgument);
if (fs.existsSync(output)) throw Error('fresh preparation directory required');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const protocolFile = path.join(repository, 'repro/model6-hillclimb-001/protocol-v2.json');
const protocol = read(protocolFile);
const prerequisite = path.join(repository, 'runs/model7-overnight-evaluation-003');
const priorManifest = read(path.join(prerequisite, 'confirmation-manifest.json'));
const environment = read(priorManifest.environmentConfig);
const archiveProtocol = path.join(repository, 'runs/ppo-strength-curve-001/evaluation-resume-002/protocol.json');
const archived = read(archiveProtocol).snapshots.find(snapshot => snapshot.id === 'update-2');
if (!archived || hash(archived.checkpoint) !== archived.sha256) throw Error('archived control identity mismatch');
fs.mkdirSync(output, { recursive: true });
const files = ['scripts/run-native-ladder.mjs', 'scripts/run-model6-hillclimb.mjs', 'scripts/model7-atomic-json.mjs',
  'src/native-ladder.mjs', 'src/model6-hillclimb-analysis.mjs', 'environment/frozen-runtime.mjs',
  'integrations/local-worker/probe.mjs', 'agents/first-baseline-singleton-ranker.mjs'];
const sourcePins = {};
for (const relative of files) {
  const target = path.join(output, 'runtime', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repository, relative), target);
  sourcePins[target] = hash(target);
}
const excludedSeeds = new Set(), seedAudit = [];
function collectSeeds(value, key = '') {
  if (Number.isSafeInteger(value) && /seed/i.test(key)) excludedSeeds.add(value);
  else if (Array.isArray(value)) for (const entry of value) collectSeeds(entry, key);
  else if (value && typeof value === 'object') for (const [name, entry] of Object.entries(value)) collectSeeds(entry, name);
}
function auditDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!['runtime', 'node_modules', '.git'].includes(entry.name)) auditDirectory(file); }
    else if (/\.json$/.test(entry.name) && /protocol|manifest|design|seed/.test(entry.name) && fs.statSync(file).size < 5000000) {
      try { collectSeeds(read(file)); seedAudit.push({ file, sha256: hash(file) }); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
}
for (const directory of ['runs', 'repro']) auditDirectory(path.join(repository, directory));
const trainingDesign = path.join(path.dirname(repository), '..', 'task-16', 'private', 'model7-overnight-001');
if (fs.existsSync(trainingDesign)) {
  for (const name of fs.readdirSync(trainingDesign).filter(name => /design|protocol|manifest/.test(name) && name.endsWith('.json'))) {
    const file = path.join(trainingDesign, name); collectSeeds(read(file)); seedAudit.push({ file, sha256: hash(file) });
  }
}
const seeds = [], namespace = 'tcg-agent/model6-hillclimb-001/development/v2';
for (let index = 0; seeds.length < 1600; index++) {
  const seed = createHash('sha256').update(`${namespace}:${index}`).digest().readUInt32BE(0);
  if (!excludedSeeds.has(seed)) { seeds.push(seed); excludedSeeds.add(seed); }
}
const baseline = { id: 'first-baseline', kind: 'baseline', description: 'Unchanged complete frozen first-baseline player' };
const candidate = { id: 'first-baseline-singleton-ranker', kind: 'prepared', description: 'Only mandatory-singleton routing uses the frozen selector',
  checkpoint: environment.ordinary.checkpoint, sha256: environment.agent.ordinarySha256,
  factoryModule: path.join(output, 'runtime/agents/first-baseline-singleton-ranker.mjs'),
  factoryExport: 'openSingletonRankerPlayer', sourcePins,
  pins: { ordinary: environment.agent.ordinarySha256, selection: environment.agent.selectionSha256,
    catalog: environment.agent.catalogSha256, history: 'complete-game', deterministic: true, routing: 'mandatory-singleton-to-frozen-ranker/1' } };
candidate.factorySha256 = hash(candidate.factoryModule);
const teacher = { id: 'scripted-teacher', kind: 'teacher', description: 'Existing AgentPult scripted teacher',
  catalogPath: environment.ordinary.catalogPath, catalogSha256: environment.agent.catalogSha256 };
const ppo = { id: 'outcome-ppo-update-2', kind: 'ppo', description: 'Archived 12-game outcome PPO update; no strength claim',
  checkpoint: archived.checkpoint, sha256: archived.sha256 };
const panels = [
  ...Array.from({ length: 25 }, (_, index) => [`anchor-${index + 1}`, candidate, baseline, seeds.slice(index * 32, (index + 1) * 32)]),
  ['candidateTeacher', candidate, teacher, seeds.slice(800, 1200)],
  ['incumbentTeacher', baseline, teacher, seeds.slice(800, 1200)],
  ['candidateArchived', candidate, ppo, seeds.slice(1200)],
  ['incumbentArchived', baseline, ppo, seeds.slice(1200)],
];
const panelEntries = [];
for (const [id, player, opponent, panelSeeds] of panels) {
  const manifest = { schema: 'native-ladder-run/1', environmentConfig: priorManifest.environmentConfig,
    anchor: player.id === baseline.id || opponent.id === baseline.id ? baseline.id : opponent.id,
    nativeConfigOverride: priorManifest.nativeConfigOverride, nativeQualification: priorManifest.nativeQualification,
    episodeRunner: priorManifest.episodeRunner, split: 'development', promotion: false,
    entrants: [player, opponent], pairs: [[player.id, opponent.id]], seeds: panelSeeds,
    workers: protocol.compute.workers, maximumGames: panelSeeds.length * 2,
    maximumWallSeconds: protocol.compute.maximumWallSecondsPerPanel,
    maximumGameSeconds: protocol.compute.maximumGameSeconds, maximumGameCommands: protocol.compute.maximumGameCommands,
    analysisAlpha: protocol.analysis.endpointAlpha, hillclimbProtocolSha256: hash(protocolFile) };
  const file = path.join(output, `${id}-manifest.json`); save(file, manifest);
  const spareLaneFile = path.join(output, `${id}-one-lane-manifest.json`); save(spareLaneFile, { ...manifest, workers: 1 });
  panelEntries.push({ id, manifest: file, sha256: hash(file), spareLaneManifest: spareLaneFile,
    spareLaneSha256: hash(spareLaneFile), output: path.join(output, id) });
}
fs.copyFileSync(protocolFile, path.join(output, 'protocol.json'));
save(path.join(output, 'seed-audit.json'), { namespace, auditedInputs: seedAudit, newIndependentSeeds: seeds, priorSeedCount: excludedSeeds.size - seeds.length });
save(path.join(output, 'campaign.json'), { schema: 'model6-hillclimb-campaign/1', createdAtUtc: new Date().toISOString(),
  protocolSha256: hash(protocolFile), prerequisite, sourcePins, panels: panelEntries, maximumCampaignSeconds: protocol.compute.maximumCampaignSeconds,
  anchorScreen: protocol.analysis.anchorScreen, allowSpareLane: protocol.compute.allowSpareLane,
  capacityReceipt: path.join(output, 'capacity.json') });
console.log(JSON.stringify({ prepared: output, panels: panelEntries.length, independentBlocks: seeds.length, games: 4800, state: 'prepared-not-started' }));
