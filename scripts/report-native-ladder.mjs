// Read-only ingestion. Receipts and model files are never modified.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { identityHash, importPairedBlocks, summarizeNativeLadder } from '../src/native-ladder.mjs';
import { hashFile, readJson } from '../environment/frozen-runtime.mjs';

export async function reportNativeLadder(manifest) {
  const registry = { schema: 'native-ladder-registry/1', anchor: manifest.anchor, entrants: [] };
  const blocks = [], sources = [], byId = new Map();
  function register(id, pins, description) {
    const entrant = { id, agentSha256: identityHash(pins), description, pins };
    if (byId.has(id) && byId.get(id).agentSha256 !== entrant.agentSha256) throw Error(`entrant changed: ${id}`);
    if (!byId.has(id)) { byId.set(id, entrant); registry.entrants.push(entrant); }
    return entrant.agentSha256;
  }
  for (const source of manifest.sources) {
    const receiptSha256 = hashFile(source.receipt), receipt = readJson(source.receipt);
    if (source.sha256 && receiptSha256 !== source.sha256) throw Error('receipt changed');
    if (source.type === 'paired-comparator') {
      if (receipt.schema !== 'bootstrap-mirror-status/1' || receipt.state !== 'completed') throw Error('completed comparator receipt required');
      const p = receipt.protocol;
      if (!['model7-outcome-pilot-confirmation/1', 'bootstrap-mirror-evaluation/1'].includes(p.schema)) throw Error('unsupported comparator contract');
      const digests = [p.nativeWorkerSha256, p.helperSha256, p.bundleManifestSha256, p.catalogSha256,
        p.contractSha256, ...Object.values(receipt.pins), ...Object.values(p.runtimeSourceHashes ?? {})];
      if (!p.runtimeSourceHashes || !Object.keys(p.runtimeSourceHashes).length
        || digests.some(value => !/^[a-f0-9]{64}$/.test(value ?? ''))) throw Error('incomplete comparator provenance');
      if (identityHash(p) !== identityHash(readJson(source.protocol))) throw Error('protocol differs from receipt');
      if (hashFile(source.protocol) !== receipt.pins.protocol || receipt.pins.baselineOrdinary !== p.baseline.ordinarySha256
        || receipt.pins.baselineSelection !== p.baseline.selectionSha256) throw Error('protocol/player pin mismatch');
      const behavior = { routing: 'ordinary-singleton-ppo-ranking-selector/1', history: 'comparator-context/1', deterministic: true };
      const agentHashes = {
        [source.a]: register(source.a, { ordinary: receipt.pins.candidateOrdinary, selection: receipt.pins.candidateSelection,
          catalog: p.catalogSha256, ...behavior }, source.description),
        [source.b]: register(source.b, { ordinary: receipt.pins.baselineOrdinary, selection: receipt.pins.baselineSelection,
          catalog: p.catalogSha256, ...behavior }, 'Frozen reference through archived paired comparator'),
      };
      const environmentSha256 = identityHash({ sources: Object.entries(p.runtimeSourceHashes).sort(),
        worker: p.nativeWorkerSha256, helper: p.helperSha256, bundle: p.bundleManifestSha256,
        catalog: p.catalogSha256, contract: p.contractSha256, comparatorSha256: receipt.pins.runner });
      blocks.push(...importPairedBlocks(receipt.blocks.filter(b => b.outcomes?.length), {
        a: source.a, b: source.b, agentHashes, environmentSha256,
        scenarioSha256: identityHash({ deck: p.deckSha256, mirrored: p.bothSeatsSameSixty, seats: p.seatCases }),
        protocolSha256: receipt.pins.protocol, receiptSha256, split: 'consumed-confirmation',
        failureContract: identityHash({ semantics: 'policy-forfeit-command-cap-draw-shared-invalid/1',
          maxCommands: p.limits.maximumGameCommands, maxSeconds: p.limits.maximumGameSeconds }), fixedEndpoint: true,
      }));
    } else if (source.type === 'training-snapshots') {
      if (receipt.schema !== 'training-strength-curve/1') throw Error('strength curve required');
      const protocol = readJson(source.protocol), pins = readJson(source.pins), config = readJson(protocol.environmentConfig);
      if (receipt.manifestSha256 !== hashFile(source.protocol) || pins.manifestSha256 !== receipt.manifestSha256
        || pins.configSha256 !== hashFile(protocol.environmentConfig) || receipt.environmentLockSha256 !== config.lockSha256)
        throw Error('snapshot provenance mismatch');
      const { verifyFrozenRuntime } = await import(pathToFileURL(path.join(config.runtimeRoot, 'environment/frozen-runtime.mjs')));
      verifyFrozenRuntime(config);
      const behavior = { bundle: config.filePins[path.join(config.runtimeRoot, 'integrations/local-worker/agent-bundle.mjs')],
        history: 'complete-game', deterministic: true };
      const b = source.b ?? 'first-baseline';
      const baseHash = register(b, { ordinary: config.agent.ordinarySha256, selection: config.agent.selectionSha256,
        catalog: config.agent.catalogSha256, ...behavior }, 'Frozen environment-v1 first-baseline');
      for (const snapshot of protocol.snapshots) {
        const point = receipt.points.find(p => p.id === snapshot.id), a = `${source.prefix ?? 'ppo'}.${snapshot.id}`;
        if (hashFile(snapshot.checkpoint) !== snapshot.sha256 || point && point.checkpointSha256 !== snapshot.sha256)
          throw Error('snapshot identity changed');
        const candidateHash = register(a, { ordinary: snapshot.sha256, selection: config.agent.selectionSha256,
          catalog: config.agent.catalogSha256, ...behavior }, `PPO after ${snapshot.trainingGames} training games / ${snapshot.optimizerSteps} steps`);
        if (!point) continue;
        blocks.push(...importPairedBlocks(point.blocks, { a, b, agentHashes: { [a]: candidateHash, [b]: baseHash },
          environmentSha256: identityHash({ lock: config.lockSha256, platform: config.platform }),
          scenarioSha256: identityHash(config.scenario), split: 'development',
          protocolSha256: receipt.manifestSha256, receiptSha256,
          failureContract: identityHash({ semantics: 'policy-forfeit-command-cap-draw-shared-invalid/1',
            maxCommands: protocol.maximumGameCommands, maxSeconds: protocol.maximumGameSeconds }),
          fixedEndpoint: receipt.state === 'completed' && point.state === 'completed' && point.blocks.length === protocol.seeds.length }));
      }
    } else if (source.type === 'native-ladder') {
      for (const entrant of receipt.registry.entrants) {
        const sha = register(entrant.id, entrant.pins, entrant.description);
        if (sha !== entrant.agentSha256) throw Error('registry digest mismatch');
      }
      blocks.push(...receipt.blocks.map(block => ({ ...block, receiptSha256 })));
    } else throw Error('unknown receipt adapter');
    sources.push({ type: source.type, receiptSha256, state: receipt.state, elapsedSeconds: receipt.elapsedSeconds });
  }
  return { ...summarizeNativeLadder(registry, blocks), sources,
    interpretation: 'Missing edges are unmeasured. Running panels are operational previews, not fixed-endpoint evidence. Consumed confirmation is historical development evidence. Promotion always requires a predeclared fresh confirmation and user approval.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifest, output] = process.argv.slice(2);
  if (!manifest || !output || process.argv.length !== 4) throw Error('usage: report-native-ladder <private-inputs.json> <fresh-report.json>');
  const report = await reportNativeLadder(readJson(manifest));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ pools: report.pools.length, entrants: report.entrants.length,
    pairs: report.pools.reduce((s, p) => s + p.cells.reduce((n, c) => n + c.independentPairs, 0) / 2, 0), promotion: false }));
}
