import { isDeepStrictEqual } from 'node:util';
import { verifyLocalInputs } from './probe.mjs';
import { referenceForCopyMode } from './copy-comparison.mjs';
import { benchmarkNativeWarm, proveNativeWarm, validateWarmCases } from './warm-benchmark.mjs';

const median = values => {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

export function referencesForWarmComparison(baseline, candidate, cases) {
  if (baseline?.buildConfiguration !== 'Release' || candidate?.buildConfiguration !== 'Release') throw new Error('explicit Release builds required for both comparison sides');
  if (!Array.isArray(cases) || cases.length !== 2) throw new TypeError('exactly two fixed primary workloads required');
  return cases.map(({ id, journal }) => ({ id, journal: referenceForCopyMode(journal, baseline, candidate) }));
}

export function summarizeWarmSessions(runs, pairs) {
  if (!Number.isSafeInteger(pairs) || pairs < 3 || pairs > 5 || !Array.isArray(runs) || runs.length !== pairs * 2) throw new Error('complete paired warm sessions required');
  const workload = runs[0].workloads;
  if (!Array.isArray(workload) || workload.length !== 2) throw new Error('two-workload session receipts required');
  for (let pair = 1; pair <= pairs; pair++) {
    for (const side of ['baseline', 'candidate']) {
      const matches = runs.filter(run => run.pair === pair && run.side === side);
      const run = matches[0];
      if (matches.length !== 1 || run.complete !== true || run.errors !== 0 || run.truncations !== 0
          || run.repeats !== 1 || run.warmups !== 1 || run.games !== 2 || run.runs?.length !== 2 || run.warmupRuns?.length !== 1
          || !isDeepStrictEqual(run.workloads, workload) || !Number.isFinite(run.timedMilliseconds) || run.timedMilliseconds <= 0) throw new Error('incomplete or unequal warm comparison work');
    }
  }
  const summarize = side => {
    const sessions = runs.filter(run => run.side === side), values = sessions.map(run => run.timedMilliseconds);
    const medianTimedMilliseconds = median(values), commands = workload.reduce((sum, row) => sum + row.commands, 0);
    return { sessions: sessions.length, measuredGames: sessions.length * 2, warmupGames: sessions.length,
      gamesPerSession: 2, commandsPerSession: commands, medianTimedMilliseconds,
      minTimedMilliseconds: Math.min(...values), maxTimedMilliseconds: Math.max(...values),
      aggregateGamesPerSecond: 2 * 1000 / medianTimedMilliseconds, aggregateCommandsPerSecond: commands * 1000 / medianTimedMilliseconds };
  };
  const baseline = summarize('baseline'), candidate = summarize('candidate');
  return { baseline, candidate, speedup: baseline.medianTimedMilliseconds / candidate.medianTimedMilliseconds };
}

export async function compareNativeWarm(baseline, candidate, cases, { pairs = 5, onProof = () => {}, onRun = () => {} } = {}) {
  if (!Number.isSafeInteger(pairs) || pairs < 3 || pairs > 5) throw new TypeError('three through five bounded warm comparison pairs required');
  const expected = referencesForWarmComparison(baseline, candidate, cases);
  const before = verifyLocalInputs(baseline), after = verifyLocalInputs(candidate);
  if (!isDeepStrictEqual(before.selected, after.selected) || !isDeepStrictEqual(before.pins, after.pins)) throw new Error('warm comparison changes private programs or decks');
  validateWarmCases(baseline, cases, before.selected);
  validateWarmCases(candidate, expected, after.selected);
  const proof = await proveNativeWarm(candidate, expected, { maxSeconds: 180, totalSeconds: 900 });
  onProof(proof);
  const started = performance.now(), runs = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const side of pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const remaining = Math.floor((900_000 - (performance.now() - started)) / 1000);
      if (remaining < 1) throw new Error('warm comparison measurement budget exhausted');
      const report = await benchmarkNativeWarm(side === 'baseline' ? baseline : candidate, side === 'baseline' ? cases : expected,
        { repeats: 1, warmups: 1, maxSeconds: Math.min(180, remaining), totalSeconds: remaining });
      const run = { pair: pair + 1, side, ...report };
      runs.push(run); onRun(run);
    }
  }
  return { schema: 'native-warm-comparison-v1', timestamp: new Date().toISOString(), fullStandardClaim: false, pairs, concurrency: 1,
    order: 'AB, BA, AB, BA, AB; truncated to pair count', buildConfiguration: 'Release', measurementBudgetSeconds: 900, proofBudgetSeconds: 900,
    endpoint: 'ratio of side medians of the two-game warm suite; aggregate games per second equals 2000 divided by median timed suite milliseconds',
    includes: 'each measured game includes fresh worker-object reset, seeded setup, all fixed commands, native legal enumeration and compact projections',
    excludes: 'timed suite excludes process startup, one verified warm-up game and terminal audit verification; raw receipts retain all session and warm-up costs; no policy inference or disk writes inside a game',
    limitation: 'fixed pinned two-deck traces only; no full Standard, agent strength or training throughput claim',
    baselineWorkerSha256: baseline.workerSha256, candidateWorkerSha256: candidate.workerSha256,
    baselineCopyMode: before.copyMode, candidateCopyMode: after.copyMode,
    executableSha256: baseline.executableSha256, manifestSha256: baseline.manifestSha256, policySha256: baseline.policySha256,
    workloads: runs[0].workloads, proof, ...summarizeWarmSessions(runs, pairs),
    measurementMilliseconds: performance.now() - started, runs };
}
