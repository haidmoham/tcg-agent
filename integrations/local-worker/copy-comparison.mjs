import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { verifyLocalInputs } from './probe.mjs';
import { benchmarkDeckOrder, benchmarkNative } from './benchmark.mjs';
import { runAuditedEpisode } from './audit-runner.mjs';

export function referenceForCopyMode(reference, baseline, candidate) {
  for (const key of ['executableSha256', 'manifestSha256', 'policySha256']) {
    if (typeof baseline[key] !== 'string' || reference.header[key] !== baseline[key] || candidate[key] !== baseline[key]) throw new Error(`copy comparison changes ${key}`);
  }
  if (reference.header.workerSha256 !== baseline.workerSha256 || (reference.header.projectionCopyMode ?? 'native') !== (baseline.projectionCopyMode ?? 'native')) throw new Error('copy comparison baseline pin mismatch');
  if (!['native', 'projection-snapshot-v1'].includes(candidate.projectionCopyMode)) throw new Error('explicit candidate copy mode required');
  const result = structuredClone(reference);
  result.header.workerSha256 = candidate.workerSha256;
  result.header.projectionCopyMode = candidate.projectionCopyMode;
  return result;
}

export async function compareNativeCopies(baseline, candidate, reference, { pairs = 5, onProof = () => {}, onRun = () => {} } = {}) {
  if (!Number.isSafeInteger(pairs) || pairs < 3 || pairs > 5) throw new TypeError('three through five bounded copy comparison pairs required');
  const before = verifyLocalInputs(baseline), after = verifyLocalInputs(candidate);
  if (!isDeepStrictEqual(before.selected, after.selected) || !isDeepStrictEqual([...before.pins], [...after.pins])) throw new Error('copy comparison changes private programs or decks');
  const expected = referenceForCopyMode(reference, baseline, candidate);
  const selected = benchmarkDeckOrder(after.selected, expected.header);
  const seatOrder = selected.map(deck => after.selected.indexOf(deck));
  const proof = await runAuditedEpisode(candidate, { seed: expected.header.seed, replay: expected, seatOrder, maxSeconds: 180, extraReads: 1, boundaryEvery: 25 });
  onProof(proof);
  const started = performance.now(), runs = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const side of pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const remaining = Math.min(180, Math.floor((900_000 - (performance.now() - started)) / 1000));
      if (remaining < 1) throw new Error('copy comparison time budget exhausted');
      const report = await benchmarkNative(side === 'baseline' ? baseline : candidate, side === 'baseline' ? reference : expected, { repeats: 1, maxSeconds: remaining });
      const run = { pair: pair + 1, side, ...report.runs[0] };
      runs.push(run); onRun(run);
    }
  }
  const median = values => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
  const summarize = side => {
    const values = runs.filter(run => run.side === side);
    return { games: values.length, medianMilliseconds: median(values.map(run => run.elapsedMs)), minMilliseconds: Math.min(...values.map(run => run.elapsedMs)), maxMilliseconds: Math.max(...values.map(run => run.elapsedMs)), medianGamesPerSecond: median(values.map(run => run.gamesPerSecond)), medianCommandsPerSecond: median(values.map(run => run.commandsPerSecond)) };
  };
  const base = summarize('baseline'), optimized = summarize('candidate');
  return { schema: 'native-copy-comparison-v1', timestamp: new Date().toISOString(), fullStandardClaim: false, pairs, concurrency: 1, order: 'AB, BA, AB, BA, AB; truncated to pair count', baselineWorkerSha256: baseline.workerSha256, candidateWorkerSha256: candidate.workerSha256, baselineCopyMode: before.copyMode, candidateCopyMode: after.copyMode, executableSha256: baseline.executableSha256, manifestSha256: baseline.manifestSha256, policySha256: baseline.policySha256, seed: reference.header.seed, deckHashes: reference.header.deckHashes, workloadSha256: createHash('sha256').update(JSON.stringify({ frames: reference.frames, commands: reference.commands })).digest('hex'), proof: proof.summary, baseline: base, candidate: optimized, speedup: base.medianMilliseconds / optimized.medianMilliseconds, runs };
}
