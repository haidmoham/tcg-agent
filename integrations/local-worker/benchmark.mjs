import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { LocalWorker, verifyLocalInputs } from './probe.mjs';
import { SemanticState, staticProgramIds, verifySeedTranscript } from './semantic-state.mjs';

export function benchmarkDeckOrder(selected, header) {
  const hashes = selected.map(deck => createHash('sha256').update(JSON.stringify(deck)).digest('hex'));
  if (hashes.length !== 2 || hashes[0] === hashes[1] || !Array.isArray(header.deckHashes) || header.deckHashes.length !== 2 || new Set(header.deckHashes).size !== 2 || header.deckHashes.some(hash => !hashes.includes(hash))) throw new Error('benchmark requires both exact pinned decks');
  return header.deckHashes.map(hash => selected[hashes.indexOf(hash)]);
}

export async function benchmarkNative(config, journal, { repeats = 3, maxSeconds = 180, onRepeat = () => {} } = {}) {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5 || !Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 180) throw new TypeError('bounded native benchmark required');
  const inputs = verifyLocalInputs(config);
  if ((journal.header.projectionCopyMode ?? 'native') !== inputs.copyMode) throw new Error('benchmark copy mode differs from recorded execution');
  if (journal.header.workerSha256 !== config.workerSha256 || journal.header.manifestSha256 !== config.manifestSha256 || journal.header.executableSha256 !== config.executableSha256 || journal.header.policySha256 !== config.policySha256 || journal.header.normalization !== 'runtime-identity-minus-lastCheckedState/3' || journal.header.schema !== 'local-semantic-replay-v1' || journal.commands.length < 1 || journal.commands.length > 2000 || journal.frames.length !== journal.commands.length + 1) throw new Error('verified replay pins required for benchmark');
  const selected = benchmarkDeckOrder(inputs.selected, journal.header);
  const identity = { id: inputs.manifest.bundleId, cardsHash: inputs.pins.get('cardData.json'), rulesHash: inputs.pins.get('gameData.json'), runtimeHash: inputs.pins.get('MatchLogic.dll') };
  const knownIds = staticProgramIds(...['cardData.json', 'gameData.json'].map(name => JSON.parse(readFileSync(join(inputs.root, name)))));
  const runs = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const start = performance.now();
    const worker = new LocalWorker(config, { timeoutMs: maxSeconds * 1000 });
    const budget = setTimeout(() => worker.close(new Error('native benchmark budget exhausted')), maxSeconds * 1000);
    try {
      const seats = Object.fromEntries(['human', 'opponent'].map((seat, index) => [seat, { accountId: `offline-${seat}`, name: `Offline ${seat}`, cards: selected[index] }]));
      await worker.request('create', { bundle: identity, seats, offline: { seed: journal.header.seed, projectionCopyMode: inputs.copyMode } });
      const batch = await worker.request('offline-batch', { commands: journal.commands });
      const elapsedMs = performance.now() - start;
      if (!batch.terminal || batch.commands !== journal.commands.length || batch.revision !== journal.frames.at(-1).revision) throw new Error('benchmark did not complete the verified workload');
      const audit = await worker.request('audit', {});
      if (config.projectionCopyMode !== undefined && (audit.projectionCopyMode !== inputs.copyMode || batch.projectionCopyMode !== inputs.copyMode)) throw new Error('benchmark copy mode not honored');
      verifySeedTranscript(journal.header.seed, audit.emittedSeeds);
      if (audit.readChanceAttempts !== 0 || !isDeepStrictEqual(audit.emittedSeeds, journal.frames.at(-1).emittedSeeds) || new SemanticState(knownIds).hash(audit.authority) !== journal.frames.at(-1).snapshotHash) throw new Error('benchmark terminal state diverged from replay');
      const result = { repeat: repeat + 1, games: 1, elapsedMs, gamesPerSecond: 1000 / elapsedMs, commands: batch.commands, commandsPerSecond: batch.commands * 1000 / elapsedMs, batchMilliseconds: batch.batchMilliseconds, readCopyCalls: batch.readCopyCalls, readCopyMilliseconds: batch.readCopyMilliseconds, nativeSeedCalls: batch.nativeSeedCalls, terminalStateHash: journal.frames.at(-1).snapshotHash, errors: 0, truncations: 0 };
      if (batch.projectionCopyMode !== undefined) for (const key of ['projectionCopyMode', 'snapshotHits', 'serializationCalls', 'serializationMilliseconds', 'deserializationCalls', 'deserializationMilliseconds']) result[key] = batch[key];
      runs.push(result); onRepeat(result);
    } finally { clearTimeout(budget); worker.close(); }
  }
  const ordered = runs.map(run => run.gamesPerSecond).sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const medianGamesPerSecond = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  return { schema: 'native-benchmark-v1', timestamp: new Date().toISOString(), executionProfile: 'private-two-deck-2026-10-11', fullStandardClaim: false, node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, concurrency: 1, seed: journal.header.seed, workerSha256: config.workerSha256, executableSha256: config.executableSha256, manifestSha256: config.manifestSha256, includes: 'one fresh process and bundle load per game, reset, native seeded setup, complete accepted commands, legal action enumeration, compact seat projections, terminal resolution', excludes: 'GUI, browser, preview requests, policy inference, per-step audit snapshots, disk writes, post-timing terminal verification; optional presentation details disabled during batch', workload: 'same recorded legal decision trace replayed; fixed-deck regression, not policy throughput', medianGamesPerSecond, minGamesPerSecond: ordered[0], maxGamesPerSecond: ordered.at(-1), runs };
}
