import { isDeepStrictEqual } from 'node:util';
import { verifyLocalInputs } from './probe.mjs';
import { referenceForCopyMode } from './copy-comparison.mjs';
import { benchmarkNativeWarm, proveNativeWarm, validateWarmCases } from './warm-benchmark.mjs';
import { summarizeWarmSessions } from './warm-comparison.mjs';

const order = [
  ['native', 'previous', 'candidate'],
  ['previous', 'candidate', 'native'],
  ['candidate', 'native', 'previous'],
  ['native', 'previous', 'candidate'],
  ['previous', 'candidate', 'native'],
];

export function referencesForThreeModeComparison(native, previous, candidate, cases) {
  const configs = { native, previous, candidate };
  if (Object.values(configs).some(config => config?.buildConfiguration !== 'Release')) throw new Error('explicit Release builds required for all three modes');
  if (native.projectionCopyMode !== 'native' || typeof previous.projectionCopyMode !== 'string'
      || typeof candidate.projectionCopyMode !== 'string' || new Set(Object.values(configs).map(config => config.projectionCopyMode)).size !== 3) throw new Error('three distinct explicit copy modes required, starting with native');
  for (const key of ['workerSha256', 'executableSha256', 'manifestSha256', 'policySha256']) {
    if (typeof native[key] !== 'string' || !native[key] || Object.values(configs).some(config => config[key] !== native[key])) throw new Error(`three-mode comparison changes ${key}`);
  }
  if (!Array.isArray(cases) || cases.length !== 2) throw new TypeError('exactly two fixed primary workloads required');
  return Object.fromEntries(Object.entries(configs).map(([side, config]) => [side,
    cases.map(({ id, journal }) => ({ id, journal: referenceForCopyMode(journal, native, config) }))]));
}

export function summarizeThreeModeSessions(runs) {
  if (!Array.isArray(runs) || runs.length !== 15) throw new Error('fifteen complete three-mode sessions required');
  const workloads = runs[0]?.workloads;
  for (let pair = 1; pair <= 5; pair++) {
    for (const side of ['native', 'previous', 'candidate']) {
      const matches = runs.filter(run => run.pair === pair && run.side === side);
      if (matches.length !== 1 || !isDeepStrictEqual(matches[0].workloads, workloads)) throw new Error('complete identical three-mode workloads required');
    }
  }
  const contrast = baseline => summarizeWarmSessions(runs.filter(run => run.side === baseline || run.side === 'candidate')
    .map(run => ({ ...run, side: run.side === baseline ? 'baseline' : 'candidate' })), 5);
  return { incremental: contrast('previous'), fullCampaign: contrast('native') };
}

export async function compareNativeModes(native, previous, candidate, cases, { onProof = () => {}, onRun = () => {} } = {}) {
  const configs = { native, previous, candidate }, references = referencesForThreeModeComparison(native, previous, candidate, cases);
  const inputs = Object.fromEntries(Object.entries(configs).map(([side, config]) => [side, verifyLocalInputs(config)]));
  for (const side of ['native', 'previous', 'candidate']) {
    if (!isDeepStrictEqual(inputs.native.selected, inputs[side].selected) || !isDeepStrictEqual(inputs.native.pins, inputs[side].pins)) throw new Error('three-mode comparison changes private programs or decks');
    validateWarmCases(configs[side], references[side], inputs[side].selected);
  }
  const proof = await proveNativeWarm(candidate, references.candidate, { maxSeconds: 180, totalSeconds: 900 });
  await onProof(proof);
  const started = performance.now(), runs = [], blocks = [];
  for (const [index, pairs] of [[1, [1, 2, 3]], [2, [4, 5]]]) {
    const blockStarted = performance.now(), timestamp = new Date().toISOString();
    for (const pair of pairs) {
      for (const side of order[pair - 1]) {
        const remaining = Math.min(180, Math.floor((900_000 - (performance.now() - blockStarted)) / 1000));
        if (remaining < 1) throw new Error(`three-mode measurement block ${index} budget exhausted`);
        const report = await benchmarkNativeWarm(configs[side], references[side],
          { repeats: 1, warmups: 1, maxSeconds: remaining, totalSeconds: remaining });
        const run = { pair, side, block: index, ...report };
        runs.push(run); await onRun(run);
      }
    }
    blocks.push({ block: index, pairs, timestamp, budgetSeconds: 900, elapsedMilliseconds: performance.now() - blockStarted });
  }
  return { schema: 'native-three-mode-comparison-v1', timestamp: new Date().toISOString(), fullStandardClaim: false,
    pairs: 5, sessions: 15, concurrency: 1, order, blocks, buildConfiguration: 'Release', proofBudgetSeconds: 900, maxSecondsPerSession: 180,
    endpoint: 'both contrasts use the ratio of side medians of the same two-game warm suite; the same five candidate sessions appear in both contrasts',
    includes: 'each measured game includes fresh worker-object reset, seeded setup, all fixed commands, native legal enumeration and compact projections',
    excludes: 'timed suite excludes process startup, one verified warm-up game and terminal audit verification; raw receipts retain all session and warm-up costs; no policy inference or disk writes inside a game',
    limitation: 'fixed pinned two-deck traces only; no full Standard, agent strength or training throughput claim',
    workerSha256: native.workerSha256, executableSha256: native.executableSha256, manifestSha256: native.manifestSha256, policySha256: native.policySha256,
    copyModes: Object.fromEntries(Object.entries(inputs).map(([side, input]) => [side, input.copyMode])),
    workloads: runs[0].workloads, proof, ...summarizeThreeModeSessions(runs), measurementMilliseconds: performance.now() - started, runs };
}
