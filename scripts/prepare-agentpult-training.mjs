import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const specification = () => read(join(root, 'learning/agentpult-deck.json'));
const experiment = () => read(join(root, 'learning/model-three-plan.json'));

function privateOutput(value) {
  const output = resolve(value), path = relative(root, output).replaceAll('\\', '/');
  if (!/^(runs|\.cache)\/.+/.test(path) || isAbsolute(path) || existsSync(output)) throw new Error('fresh private runs or .cache directory required');
  mkdirSync(output, { recursive: true });
  if (realpathSync(output) !== output) throw new Error('private output must not be redirected');
  return output;
}

export function teacherCatalog(cards, joins, aliases = {}) {
  const bySource = new Map(cards.map(card => [card.cardSourceID, card]));
  const sourceByPrinting = {}, actions = {};
  for (const row of joins) {
    if (row.status !== 'joined' || !bySource.has(row.cardSourceID)) continue;
    if (sourceByPrinting[row.printingId] && sourceByPrinting[row.printingId] !== row.cardSourceID) throw new Error('ambiguous printing join');
    sourceByPrinting[row.printingId] = row.cardSourceID;
    actions[row.printingId] = {};
    for (const action of bySource.get(row.cardSourceID).useActions ?? []) {
      if (typeof action.actionName !== 'string' || action.actionSourceID == null) throw new Error('action metadata is incomplete');
      if (actions[row.printingId][action.actionName]) throw new Error('ambiguous action name within printing');
      actions[row.printingId][action.actionName] = `${row.cardSourceID}/${action.actionSourceID}`;
    }
  }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!sourceByPrinting[canonical]) throw new Error('mechanical alias has no verified source');
    sourceByPrinting[alias] = sourceByPrinting[canonical]; actions[alias] = actions[canonical];
  }
  return { schema: 'agentpult-teacher-catalog/1', sourceByPrinting, actions };
}

export function prepareAgentPultTraining(sourceConfigPath, destination) {
  const supplied = read(sourceConfigPath), source = { ...supplied };
  delete source.policyModule; delete source.policySha256;
  if (source.buildConfiguration !== 'Release') throw new Error('explicitly prepared Release native worker required');
  const checked = verifyLocalInputs(source), requested = specification(), plan = experiment();
  const cards = read(join(checked.root, 'cardData.json')), joins = read(join(checked.root, 'printing-joins.json')).joins;
  if (cards.length !== 39 || !Array.isArray(joins) || requested.cards.length !== 24) throw new Error('verified 39-program extension and exact deck specification required');
  const catalog = teacherCatalog(cards, joins, requested.mechanicalAliases);
  const rows = requested.cards.map(card => {
    const requestedPrintingId = `${card.set}-${card.number}`, printingId = requested.mechanicalAliases[requestedPrintingId] ?? requestedPrintingId;
    const cardSourceID = catalog.sourceByPrinting[printingId];
    if (!cardSourceID) throw new Error(`requested printing is missing: ${requestedPrintingId}`);
    return { printingId, requestedPrintingId, cardSourceID, quantity: card.count,
      equivalence: requestedPrintingId === printingId ? 'exact-printing-program' : 'audited-identical-captured-mechanics' };
  });
  const ordered = rows.flatMap(row => Array(row.quantity).fill(row.cardSourceID)), decks = read(join(checked.root, 'decks.json'));
  if (ordered.length !== 60 || hash(JSON.stringify(ordered)) !== plan.deck.orderedMechanicsSha256
      || hash(JSON.stringify(decks.zoroarkDeckRows.orderedSourceIDs)) !== plan.deck.opponentDeckSha256
      || !catalog.sourceByPrinting['JTG-120']) throw new Error('exact deck or opponent identity mismatch');
  const output = privateOutput(destination), bundleRoot = join(output, 'bundle'); mkdirSync(bundleRoot);
  for (const entry of checked.manifest.files) copyFileSync(join(checked.root, entry.path), join(bundleRoot, entry.path));
  decks.realDeckRows = { sourceRows: rows, orderedSourceIDs: ordered, cards: 60, orderPreservedFromSource: true,
    requestedDeckId: requested.id, capturedMechanicsMatchRequestedDeck: true, exactHistoricalPrintings: false };
  writeFileSync(join(bundleRoot, 'decks.json'), JSON.stringify(decks, null, 2) + '\n');
  const files = checked.manifest.files.map(entry => {
    const bytes = readFileSync(join(bundleRoot, entry.path));
    return { ...entry, sha256: hash(bytes), bytes: bytes.length };
  });
  const contentIdentitySha256 = hash(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))));
  save(join(bundleRoot, 'manifest.json'), { ...checked.manifest, bundleId: `agentpult-training-${contentIdentitySha256.slice(0, 16)}`,
    contentIdentitySha256, files, parentBundle: { bundleId: checked.manifest.bundleId, manifestSha256: source.manifestSha256 } });
  save(join(output, 'teacher-catalog.json'), catalog);
  const teacher = join(output, 'teacher.mjs'), teacherSource = readFileSync(join(root, 'learning/agentpult-teacher.mjs'), 'utf8');
  writeFileSync(teacher, `${teacherSource}\nconst catalog=${JSON.stringify(catalog)};\nexport const livePracticeDecisions=createAgentPultTeacher(catalog);\n`, { flag: 'wx' });
  const config = { schema: source.schema, executable: source.executable, worker: source.worker, bundleRoot,
    executableSha256: source.executableSha256, workerSha256: source.workerSha256,
    manifestSha256: hash(readFileSync(join(bundleRoot, 'manifest.json'))), policyModule: teacher, policySha256: hash(readFileSync(teacher)),
    maxCommands: 500, maxSeconds: 180, projectionCopyMode: 'projection-turn-v1', buildConfiguration: 'Release', offlineAuditVersion: 'indigo-offline-audit/1' };
  verifyLocalInputs(config);
  save(join(output, 'native-config.json'), config);
  save(join(output, 'preparation-receipt.json'), { schema: 'agentpult-training-preparation/1', cards: 60, cardTypes: rows.length,
    programs: cards.length, sourceManifestSha256: source.manifestSha256, manifestSha256: config.manifestSha256,
    deckSha256: hash(JSON.stringify(ordered)), opponentDeckSha256: plan.deck.opponentDeckSha256,
    deckSpecificationSha256: hash(readFileSync(join(root, 'learning/agentpult-deck.json'))),
    teacherModuleSha256: hash(readFileSync(join(root, 'learning/agentpult-teacher.mjs'))),
    teacherCatalogSha256: hash(readFileSync(join(output, 'teacher-catalog.json'))), teacherWrapperSha256: config.policySha256,
    nativeGamesRun: 0, gameplayStrengthClaim: false, fullStandardClaim: false });
  return { output, config: join(output, 'native-config.json') };
}

export function prepareAgentPultPlans(profile, destination, models = {}) {
  const output = privateOutput(destination), plan = experiment(), requested = specification();
  const catalog = read(join(resolve(profile), 'teacher-catalog.json'));
  const source = (printing, name) => {
    const key = catalog.actions[printing]?.[name]; if (!key) throw new Error('diagnostic action metadata missing'); return key;
  };
  const base = { schema: 'native-card-action-rollout-plan/1', maximumGameCommands: 500, printingAliases: requested.mechanicalAliases,
    diagnostics: { evolutionPrintings: ['TWM-129', 'TWM-130'], reconActionKey: source('TWM-129', '[Ability] Recon Directive'),
      phantomDiveActionKey: source('TWM-130', 'Phantom Dive') } };
  const task = (seed, index, split) => ({ id: `seed-${seed}`, seed, split, seatOrder: index % 2 ? [1, 0] : [0, 1], policySeat: index % 2 ? 'opponent' : 'human' });
  const pairs = seeds => seeds.flatMap(seed => [0, 1].map(index => ({ ...task(seed, index, 'evaluation'), id: `${seed}-${index ? 'opponent' : 'human'}` })));
  save(join(output, 'qualification.json'), { ...base, mode: 'qualification', workers: 4, opponentPolicy: 'weak',
    maximumGameSeconds: plan.qualification.maximumGameSeconds, maximumWallSeconds: plan.qualification.maximumWallSeconds, tasks: pairs(plan.qualification.seeds) });
  save(join(output, 'bootstrap.json'), { ...base, mode: 'bootstrap', workers: 4, opponentPolicy: 'teacher',
    maximumGameSeconds: plan.bootstrap.maximumGameSeconds, maximumWallSeconds: plan.bootstrap.maximumWallSeconds,
    tasks: [...plan.bootstrap.trainingSeeds, ...plan.bootstrap.validationSeeds].map((seed, index) => task(seed, index, index < plan.bootstrap.trainingSeeds.length ? 'train' : 'validation')) });
  const cpuModel = (configPath, name) => {
    const config = read(configPath); config.device = 'cpu';
    if (!isAbsolute(config.executable ?? '') || !isAbsolute(config.checkpoint ?? '') || !existsSync(config.checkpoint)) throw new Error('existing absolute model runtime and checkpoint required');
    const path = join(output, `${name}-cpu.json`); save(path, config); return path;
  };
  if (models.bootstrap) save(join(output, 'dagger.json'), { ...base, mode: 'dagger', workers: 4, opponentPolicy: 'teacher',
    modelConfig: cpuModel(models.bootstrap, 'bootstrap'), teacherMix: plan.dagger.teacherMix,
    maximumGameSeconds: plan.dagger.maximumGameSeconds, maximumWallSeconds: plan.dagger.maximumWallSeconds,
    tasks: [...plan.dagger.trainingSeeds, ...plan.dagger.validationSeeds].map((seed, index) => task(seed, index, index < plan.dagger.trainingSeeds.length ? 'train' : 'validation')) });
  for (const [key, kind] of [['final', 'card-action'], ['baseline', 'native-v2']]) {
    if (!models[key]) continue;
    save(join(output, `${key}-evaluation.json`), { ...base, mode: 'evaluate', workers: 2, opponentPolicy: 'weak', teacherMix: 0,
      modelConfig: cpuModel(models[key], key), modelKind: kind, maximumGameSeconds: plan.finalEvaluation.maximumGameSeconds,
      maximumWallSeconds: plan.finalEvaluation.maximumWallSecondsPerCheckpoint, tasks: pairs(plan.finalEvaluation.seeds) });
  }
  return { output };
}

export function aggregateAgentPultDatasets(first, second, destination) {
  const parents = [first, second].map(value => ({ root: resolve(value), receipt: read(join(resolve(value), 'receipt.json')) }));
  const baseline = parents[0].receipt;
  for (const { receipt } of parents) {
    if (receipt.schema !== 'native-card-action-dataset/1' || !receipt.complete || receipt.fatal) throw new Error('complete nonfatal parent dataset required');
    for (const key of ['featureContract', 'sourceHashes', 'pins', 'printingAliases', 'policyDeckHash', 'opponentDeckHash'])
      if (!isDeepStrictEqual(receipt[key], baseline[key])) throw new Error('parent datasets differ in frozen authority or features');
  }
  const identities = new Set(), seeds = new Set(), admitted = [];
  for (const parent of parents) for (const game of parent.receipt.games) {
    const path = resolve(parent.root, game.recordsPath), inside = relative(parent.root, path);
    if (isAbsolute(inside) || inside.startsWith('..') || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(game.id ?? '')
        || !Number.isSafeInteger(game.seed) || game.seed < 0 || game.seed > 0xffffffff
        || !Number.isSafeInteger(game.commands) || game.commands < 1 || !(game.realHandExchanges > 0)
        || !['train', 'validation'].includes(game.split) || !game.completedNaturally
        || game.rejected !== 0 || game.privacyChecks !== game.commands * 2 || game.realHandExchanges <= 0
        || identities.has(game.id) || seeds.has(game.seed) || hash(readFileSync(path)) !== game.recordsSha256) throw new Error('duplicate, incomplete or corrupt game');
    identities.add(game.id); seeds.add(game.seed); admitted.push({ parent, game, path });
  }
  const output = privateOutput(destination), games = [];
  for (const { parent, game, path } of admitted) {
    const directory = join(output, game.id); mkdirSync(directory);
    copyFileSync(path, join(directory, 'records.jsonl'));
    for (const name of ['case-receipt.json', 'journal.json', 'decisions.jsonl']) {
      const source = join(dirname(path), name); if (existsSync(source)) copyFileSync(source, join(directory, name));
    }
    games.push({ ...game, recordsPath: `${game.id}/records.jsonl`, sourceDatasetSha256: hash(readFileSync(join(parent.root, 'receipt.json'))) });
  }
  const parentReceipts = parents.map((parent, index) => {
    const name = `parent-${index + 1}-receipt.json`; copyFileSync(join(parent.root, 'receipt.json'), join(output, name));
    return { path: name, sha256: hash(readFileSync(join(output, name))) };
  });
  save(join(output, 'receipt.json'), { ...baseline, mode: 'aggregate-bootstrap-dagger', timestamp: new Date().toISOString(),
    games, parentReceipts, counts: { completed: games.length, train: games.filter(game => game.split === 'train').length,
      validation: games.filter(game => game.split === 'validation').length }, outcomes: parents.flatMap(parent => parent.receipt.outcomes),
    unattempted: parents.flatMap(parent => parent.receipt.unattempted), elapsedMilliseconds: null,
    interpretation: 'Each naturally completed parent game admitted once. Interrupted and timed-out games remain excluded and preserved in parent receipts.' });
  return { output, games: games.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    let result;
    if (operation === 'prepare' && args.length === 2) result = prepareAgentPultTraining(...args);
    else if (operation === 'plans' && args.length >= 2 && args.length <= 5) result = prepareAgentPultPlans(args[0], args[1], { bootstrap: args[2], final: args[3], baseline: args[4] });
    else if (operation === 'aggregate' && args.length === 3) result = aggregateAgentPultDatasets(...args);
    else throw new Error('Usage: prepare-agentpult-training.mjs prepare <private-native-config> <fresh-private-profile> | plans <profile> <fresh-plans> [bootstrap-model-config [final-model-config [baseline-model-config]]] | aggregate <bootstrap-dataset> <dagger-dataset> <fresh-dataset>');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
