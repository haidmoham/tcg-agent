// Fixed paired schedule over the frozen native boundary. No optimizer or promotion.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { identityHash, scheduleMatches, summarizeNativeLadder } from '../src/native-ladder.mjs';
import { hashFile, readJson } from '../environment/frozen-runtime.mjs';

const [manifestPath, output] = process.argv.slice(2);
if (!manifestPath || !output || process.argv.length !== 4) throw Error('usage: run-native-ladder <private-manifest.json> <fresh-private-output>');
const sourcePins = Object.fromEntries([new URL(import.meta.url), new URL('../src/native-ladder.mjs', import.meta.url)]
  .map(file => [file.href, hashFile(file)]));
const manifest = readJson(manifestPath), config = readJson(manifest.environmentConfig), root = path.resolve(output);
const maximumGames = manifest.maximumGames ?? 128;
const analysisAlpha = manifest.analysisAlpha ?? .05;
if (manifest.schema !== 'native-ladder-run/1' || !['development', 'confirmation'].includes(manifest.split) || manifest.promotion !== false
  || !Number.isFinite(analysisAlpha) || analysisAlpha <= 0 || analysisAlpha >= 1
  || !Number.isSafeInteger(manifest.workers) || manifest.workers < 1 || manifest.workers > 8
  || !Number.isSafeInteger(maximumGames) || maximumGames < 2 || maximumGames > 4096
  || !Number.isSafeInteger(manifest.maximumWallSeconds) || manifest.maximumWallSeconds < 1 || manifest.maximumWallSeconds > 86400
  || !Number.isSafeInteger(manifest.maximumGameSeconds) || manifest.maximumGameSeconds < 1 || manifest.maximumGameSeconds > 240
  || !Number.isSafeInteger(manifest.maximumGameCommands) || manifest.maximumGameCommands < 1 || manifest.maximumGameCommands > 1500)
  throw Error('bounded predeclared native run required');
if (manifest.split === 'confirmation' && (!manifest.strengthPlan?.effect || !manifest.strengthPlan?.independentUnit
  || !manifest.strengthPlan?.uncertainty || !manifest.strengthPlan?.sampleJustification))
  throw Error('confirmation requires a decision-relevant sample justification');
if (fs.existsSync(root)) throw Error('fresh output required');
const load = file => import(pathToFileURL(path.join(config.runtimeRoot, file)));
const [{ verifyFrozenRuntime }, { runNativeGame }, { AgentBundle }, { EntityPpoModelClient },
  { Model6ModelClient }, features, choices, { createAgentPultTeacher }] = await Promise.all([
  load('environment/frozen-runtime.mjs'), load('environment/native-game.mjs'), load('integrations/local-worker/agent-bundle.mjs'),
  load('integrations/local-worker/entity-ppo-model.mjs'), load('integrations/local-worker/model6-model.mjs'),
  load('learning/model6-features.mjs'), load('integrations/local-worker/card-action-policy.mjs'), load('learning/agentpult-teacher.mjs')]);
verifyFrozenRuntime(config);
const manifestSha256 = hashFile(manifestPath), configSha256 = hashFile(manifest.environmentConfig);
const native = readJson(config.nativeConfig), registry = { schema: 'native-ladder-registry/1', anchor: manifest.anchor, entrants: [] };
const behavior = { bundle: config.filePins[path.join(config.runtimeRoot, 'integrations/local-worker/agent-bundle.mjs')],
  history: 'complete-game', deterministic: true };
for (const entrant of manifest.entrants) {
  if (!['baseline', 'ppo', 'teacher', 'prepared'].includes(entrant.kind)) throw Error('unsupported agent kind');
  let pins;
  if (entrant.kind === 'prepared') {
    if (hashFile(entrant.checkpoint) !== entrant.sha256 || hashFile(entrant.factoryModule) !== entrant.factorySha256
      || !Object.keys(entrant.sourcePins ?? {}).length || entrant.pins?.ordinary !== entrant.sha256
      || entrant.pins?.selection !== config.agent.selectionSha256 || entrant.pins?.catalog !== config.agent.catalogSha256)
      throw Error('prepared player needs complete checkpoint, source and behavior pins');
    for (const [file, digest] of Object.entries(entrant.sourcePins)) if (hashFile(file) !== digest) throw Error('prepared player source changed');
    pins = { ...entrant.pins, factory: entrant.factorySha256, factoryExport: entrant.factoryExport ?? 'openJointChoicePlayer',
      privateSourceManifestSha256: identityHash(Object.entries(entrant.sourcePins).sort(([a], [b]) => a.localeCompare(b))) };
  } else if (entrant.kind === 'teacher') {
    if (hashFile(entrant.catalogPath) !== entrant.catalogSha256) throw Error('teacher catalog changed');
    pins = { teacher: config.filePins[path.join(config.runtimeRoot, 'learning/agentpult-teacher.mjs')],
      catalog: entrant.catalogSha256, adapter: 'native-ladder-teacher/1', ...behavior };
  } else {
    if (entrant.kind === 'ppo' && hashFile(entrant.checkpoint) !== entrant.sha256) throw Error('candidate checkpoint changed');
    pins = { ordinary: entrant.kind === 'baseline' ? config.agent.ordinarySha256 : entrant.sha256,
      selection: config.agent.selectionSha256, catalog: config.agent.catalogSha256, ...behavior };
  }
  registry.entrants.push({ id: entrant.id, description: entrant.description, pins, agentSha256: identityHash(pins) });
}
const matchSchedule = scheduleMatches(registry, manifest.pairs, manifest.seeds);
if (matchSchedule.length * 2 > maximumGames) throw Error('schedule exceeds declared game budget');
const assertFrozenInputs = () => {
  for (const [file, digest] of Object.entries(sourcePins)) if (hashFile(new URL(file)) !== digest) throw Error('evaluation source changed');
  if (hashFile(manifestPath) !== manifestSha256 || hashFile(manifest.environmentConfig) !== configSha256) throw Error('run inputs changed');
  verifyFrozenRuntime(config);
  for (const e of manifest.entrants) {
    if (['ppo', 'prepared'].includes(e.kind) && hashFile(e.checkpoint) !== e.sha256) throw Error('candidate changed');
    if (e.kind === 'teacher' && hashFile(e.catalogPath) !== e.catalogSha256) throw Error('teacher changed');
    if (e.kind === 'prepared') {
      if (hashFile(e.factoryModule) !== e.factorySha256) throw Error('candidate factory changed');
      for (const [file, digest] of Object.entries(e.sourcePins)) if (hashFile(file) !== digest) throw Error('candidate source changed');
    }
  }
};
fs.mkdirSync(root, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
const append = (name, value) => fs.appendFileSync(path.join(root, name), JSON.stringify(value) + '\n');
save('protocol.json', manifest);
const blocks = [], started = Date.now(), abort = new AbortController();
let next = 0, stopReason = null;
const stop = reason => { stopReason ??= reason; abort.abort(); };
const interrupted = () => stop('operator-interrupted');
process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
const timer = setTimeout(() => stop('global-wall-budget'), manifest.maximumWallSeconds * 1000);
const common = { schema: 'native-ladder-block/1', environmentSha256: identityHash({ lock: config.lockSha256, platform: config.platform }),
  scenarioSha256: identityHash(config.scenario), split: manifest.split, protocolSha256: manifestSha256,
  failureContract: identityHash({ semantics: 'policy-forfeit-command-cap-draw-shared-invalid/1',
    maxCommands: manifest.maximumGameCommands, maxSeconds: manifest.maximumGameSeconds }), receiptSha256: manifestSha256 };
function report(final = false) {
  const complete = final && !stopReason && blocks.length === matchSchedule.length;
  const result = { schema: 'native-ladder-run-receipt/1', state: complete ? 'completed' : final ? 'incomplete' : 'running',
    at: new Date().toISOString(), processId: process.pid,
    registry, blocks: blocks.map(b => ({ ...b, fixedEndpoint: complete })), manifestSha256, configSha256, analysisAlpha,
    runnerSha256: sourcePins[import.meta.url], sourcePins, plannedPairs: matchSchedule.length, workers: manifest.workers,
    elapsedSeconds: (Date.now() - started) / 1000, stopReason, promotion: false };
  save('receipt.json', result); save('report.json', summarizeNativeLadder(registry, result.blocks, { alpha: analysisAlpha }));
  return result;
}
async function lane(index) {
  const clients = [];
  try {
    const ordinary = new EntityPpoModelClient(config.ordinary), selection = new Model6ModelClient(config.selection);
    clients.push(ordinary, selection);
    const models = new Map(), preparedPlayers = new Map();
    for (const e of manifest.entrants.filter(e => e.kind === 'ppo')) {
      const model = new EntityPpoModelClient({ ...config.ordinary, checkpoint: e.checkpoint, modelRoot: path.dirname(e.checkpoint) });
      clients.push(model); models.set(e.id, model);
    }
    for (const entrant of manifest.entrants.filter(entrant => entrant.kind === 'prepared')) {
      const factory = await import(pathToFileURL(entrant.factoryModule));
      const openPlayer = factory[entrant.factoryExport ?? 'openJointChoicePlayer'];
      if (typeof openPlayer !== 'function') throw Error('prepared player factory export missing');
      const service = await openPlayer({ ...entrant.factoryOptions,
        environmentConfig: manifest.environmentConfig, checkpoint: entrant.checkpoint, checkpointSha256: entrant.sha256,
        selectionClient: selection, catalog: ordinary.catalog });
      if (typeof service.verify !== 'function' || typeof service.newGame !== 'function' || typeof service.shutdown !== 'function')
        throw Error('prepared player service contract incomplete');
      clients.push(service); preparedPlayers.set(entrant.id, service);
    }
    save(`lane-${index}-verified.json`, await Promise.all(clients.map(c => c.verify())));
    function createEntrantAgent(id, searchSeed) {
      const e = manifest.entrants.find(e => e.id === id), pins = registry.entrants.find(e => e.id === id).pins;
      if (e.kind === 'prepared') return preparedPlayers.get(id).newGame({ searchSeed });
      const agent = new AgentBundle({ ordinary: models.get(id) ?? ordinary, selection, catalog: ordinary.catalog,
        encode: features.encodeModel6Decision, supportsCardSelection: choices.supportsCardSelection,
        rankedPromptAnswers: choices.rankedPromptAnswers, pins, historyMode: 'complete-game', deterministic: true });
      if (e.kind === 'teacher') {
        const teacher = createAgentPultTeacher(readJson(e.catalogPath));
        agent.propose = async view => {
          if (view.status !== 'playing') return { source: 'helper', decisions: null };
          const offered = teacher(view);
          return { source: 'teacher', decisions: view.prompts.length ? offered : [offered.next().value] };
        };
      }
      return agent;
    }
    while (!stopReason) {
      const slot = next++; if (slot >= matchSchedule.length) break;
      const task = matchSchedule[slot], block = { ...common, a: task.a, b: task.b, seed: task.seed,
        agentHashes: Object.fromEntries([task.a, task.b].map(id => [id, registry.entrants.find(e => e.id === id).agentSha256])), outcomes: [] };
      assertFrozenInputs(); blocks.push(block);
      for (const aSeat of task.seats) {
        if (stopReason) break;
        const begin = Date.now(), label = `pair-${slot}-${aSeat}`;
        const searchSeed = manifest.searchSeeds?.[manifest.seeds.indexOf(task.seed)]?.[aSeat];
        const agents = Object.fromEntries(['human', 'opponent'].map(seat => [seat, createEntrantAgent(seat === aSeat ? task.a : task.b, searchSeed)]));
        let policySeat = null;
        for (const [seat, agent] of Object.entries(agents)) {
          const propose = agent.propose.bind(agent);
          agent.propose = async (...args) => {
            try {
              const proposal = await propose(...args), decisions = proposal.decisions;
              if (decisions != null) proposal.decisions = (function* () {
                try { yield* decisions; } catch (error) { policySeat = seat; throw error; }
              })();
              return proposal;
            } catch (error) { policySeat = seat; throw error; }
          };
        }
        let outcome;
        try {
          const game = await runNativeGame(native, { seed: task.seed, seatOrder: [0, 1], agents,
            maxCommands: manifest.maximumGameCommands, maxSeconds: manifest.maximumGameSeconds, auditEvery: 32, signal: abort.signal,
            onFrame: ({ entry }) => append(`${label}-progress.jsonl`, entry) });
          if (!game.summary.completedNaturally || game.summary.rejected !== 0 || game.summary.privacyChecks < 2)
            throw Error('natural completion admission failed');
          save(`${label}-journal.json`, game.journal);
          outcome = { aSeat, status: 'natural', score: game.summary.winnerSeat === null ? .5 : game.summary.winnerSeat === aSeat ? 1 : 0,
            summary: game.summary, routes: game.routes, seconds: (Date.now() - begin) / 1000 };
        } catch (error) {
          if (stopReason) break;
          const cap = error.code === 'NATIVE_EPISODE_COMMAND_BUDGET';
          outcome = { aSeat, status: policySeat ? 'policy-forfeit' : cap ? 'command-cap-draw' : 'shared-invalid',
            score: policySeat ? policySeat === aSeat ? 0 : 1 : cap ? .5 : null,
            reason: error.message, seconds: (Date.now() - begin) / 1000 };
        }
        block.outcomes.push(outcome); save(`${label}-outcome.json`, outcome); report();
        if (outcome.status === 'shared-invalid') { stop('shared-harness-failure'); break; }
      }
      assertFrozenInputs(); save(`pair-${slot}.json`, block);
      block.receiptSha256 = hashFile(path.join(root, `pair-${slot}.json`));
      append('blocks.jsonl', block); report();
      console.log(JSON.stringify({ pair: slot, completedGames: block.outcomes.length, elapsedSeconds: (Date.now() - started) / 1000 }));
    }
  } catch (error) { append('events.jsonl', { lane: index, reason: error.message }); stop('model-or-pin-failure'); }
  finally {
    save(`lane-${index}-inference.json`, clients.map(client => ({ device: client.device,
      requests: client.requests, inferenceMilliseconds: client.inferenceMilliseconds })));
    await Promise.all(clients.map(c => c.shutdown().catch(() => {})));
  }
}
try { report(); await Promise.all(Array.from({ length: manifest.workers }, (_, i) => lane(i))); assertFrozenInputs(); }
catch (error) { append('events.jsonl', { reason: error.message }); stop('preflight-or-pin-failure'); }
finally { clearTimeout(timer); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
const final = report(true);
console.log(JSON.stringify({ state: final.state, pairs: blocks.length, elapsedSeconds: final.elapsedSeconds, stopReason }));
if (final.state !== 'completed') process.exitCode = 2;
