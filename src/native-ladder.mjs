import { createHash } from 'node:crypto';

export const identityHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (ok, message) => { if (!ok) throw Error(message); };
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const mean = values => values.reduce((sum, n) => sum + n, 0) / values.length;
const rating = p => p === 0 ? '-Infinity' : p === 1 ? 'Infinity' : 400 * Math.log10(p / (1 - p));

// The registry describes full players, not just weight filenames. Unknown edges stay unknown.
export function validateRegistry(registry) {
  check(registry.schema === 'native-ladder-registry/1', 'unsupported registry');
  check(Array.isArray(registry.entrants) && registry.entrants.length >= 2, 'two entrants required');
  const ids = new Set();
  for (const entrant of registry.entrants) {
    check(/^[a-z0-9][a-z0-9.-]{0,79}$/.test(entrant.id) && !ids.has(entrant.id), 'invalid or duplicate entrant');
    check(digest(entrant.agentSha256) && entrant.description?.length, 'full agent identity and description required');
    ids.add(entrant.id);
  }
  check(ids.has(registry.anchor), 'registered anchor required');
  return registry;
}

export function scheduleMatches(registry, pairs, seeds) {
  validateRegistry(registry);
  check(Array.isArray(seeds) && seeds.length > 0 && new Set(seeds).size === seeds.length
    && seeds.every(seed => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff), 'unique uint32 seeds required');
  const ids = registry.entrants.map(e => e.id), seen = new Set();
  return pairs.flatMap(([a, b]) => {
    check(a !== b && ids.includes(a) && ids.includes(b), 'unknown or identical opponents');
    const key = [a, b].sort().join('/');
    check(!seen.has(key), 'duplicate matchup'); seen.add(key);
    return seeds.map(seed => ({ a, b, seed, seats: ['human', 'opponent'] }));
  });
}

function scoreInterval(scores, alpha) {
  if (!scores.length) return { score: null, interval: null, rating: null, ratingInterval: null };
  const score = mean(scores), radius = Math.sqrt(Math.log(2 / alpha) / (2 * scores.length));
  const interval = [Math.max(0, score - radius), Math.min(1, score + radius)];
  return { score, interval, rating: rating(score), ratingInterval: interval.map(rating) };
}

export function summarizeNativeLadder(registry, blocks, { alpha = .05 } = {}) {
  validateRegistry(registry);
  check(alpha > 0 && alpha < 1, 'invalid alpha');
  const entrants = new Map(registry.entrants.map(e => [e.id, e])), pools = new Map(), seen = new Set();
  for (const block of blocks) {
    check(block.schema === 'native-ladder-block/1' && digest(block.environmentSha256)
      && digest(block.scenarioSha256) && digest(block.protocolSha256) && digest(block.receiptSha256), 'complete provenance required');
    check(['development', 'consumed-confirmation', 'confirmation'].includes(block.split), 'explicit data split required');
    check(block.a !== block.b && entrants.has(block.a) && entrants.has(block.b), 'unregistered matchup');
    for (const id of [block.a, block.b]) check(block.agentHashes?.[id] === entrants.get(id).agentSha256, 'player identity changed');
    check(Number.isSafeInteger(block.seed) && block.seed >= 0 && block.seed <= 0xffffffff, 'invalid seed');
    const poolKey = identityHash([block.environmentSha256, block.scenarioSha256, block.split, block.failureContract]);
    const duplicate = JSON.stringify([poolKey, ...[block.a, block.b].sort(), block.seed]);
    check(!seen.has(duplicate), 'duplicate seed/matchup cannot count as independent evidence'); seen.add(duplicate);
    check(Array.isArray(block.outcomes) && block.outcomes.length <= 2, 'invalid paired block');
    const seats = new Set();
    for (const outcome of block.outcomes) {
      check(['human', 'opponent'].includes(outcome.aSeat) && !seats.has(outcome.aSeat), 'duplicate or missing seat');
      seats.add(outcome.aSeat);
      check(['natural', 'policy-forfeit', 'command-cap-draw', 'shared-invalid'].includes(outcome.status), 'unknown outcome');
      check(outcome.status === 'shared-invalid' ? outcome.score === null : [0, .5, 1].includes(outcome.score), 'invalid score');
      check(Number.isFinite(outcome.seconds) && outcome.seconds >= 0, 'invalid latency');
      if (outcome.status === 'natural') check(outcome.summary?.completedNaturally === true
        && outcome.summary.rejected === 0, 'natural outcome needs acceptance evidence');
    }
    if (!pools.has(poolKey)) pools.set(poolKey, { environmentSha256: block.environmentSha256,
      scenarioSha256: block.scenarioSha256, split: block.split, failureContract: block.failureContract, blocks: [] });
    pools.get(poolKey).blocks.push(block);
  }
  return { schema: 'native-ladder-report/1', anchor: registry.anchor, promotion: false, entrants: registry.entrants,
    pointwiseConfidence: 1 - alpha, simultaneousAnchorConfidence: 1 - alpha,
    method: 'Anchor-relative 400*log10(score/(1-score)); pairwise scores retain nontransitivity. Two-sided Hoeffding bounds over independent seed pairs. Not Live Elo. No transitive global fit.',
    pools: [...pools.entries()].map(([id, pool]) => {
      const cells = [];
      for (const a of entrants.keys()) for (const b of entrants.keys()) {
        if (a === b) continue;
        const matches = pool.blocks.filter(v => [v.a, v.b].includes(a) && [v.a, v.b].includes(b));
        const complete = matches.filter(v => v.outcomes.length === 2 && v.outcomes.every(o => o.status !== 'shared-invalid'));
        const scores = complete.map(v => mean(v.outcomes.map(o => v.a === a ? o.score : 1 - o.score)));
        const games = matches.flatMap(v => v.outcomes.map(o => ({ ...o, score: o.score === null ? null : v.a === a ? o.score : 1 - o.score })));
        const countedGames = complete.flatMap(v => v.outcomes.map(o => v.a === a ? o.score : 1 - o.score));
        const estimate = scoreInterval(scores, alpha);
        const failures = Object.fromEntries(['policy-forfeit', 'command-cap-draw', 'shared-invalid'].map(s => [s, games.filter(o => o.status === s).length]));
        cells.push({ a, b, independentPairs: scores.length, attemptedPairs: matches.length, games: countedGames.length,
          attemptedGames: games.length,
          analysisStatus: !matches.length ? 'unmeasured' : matches.every(v => v.fixedEndpoint === true) ? 'fixed-endpoint' : 'preview',
          wins: countedGames.filter(s => s === 1).length, losses: countedGames.filter(s => s === 0).length,
          draws: countedGames.filter(s => s === .5).length, ...estimate, failures,
          failureRate: games.length ? games.filter(g => g.status !== 'natural').length / games.length : null,
          fixedEndpointDistinguishable: complete.length > 0 && matches.every(v => v.fixedEndpoint === true)
            && estimate.interval !== null && (estimate.interval[0] > .5 || estimate.interval[1] < .5) });
      }
      const outcomes = pool.blocks.flatMap(b => b.outcomes), gameSeconds = outcomes.reduce((s, g) => s + g.seconds, 0);
      // Simultaneous confidence for anchor comparisons; never interpret this as an anytime test.
      const comparisons = registry.entrants.length - 1;
      const ratings = registry.entrants.map(({ id: entrant }) => {
        if (entrant === registry.anchor) return { id: entrant, rating: 0, fixed: true };
        const matches = pool.blocks.filter(b => [b.a, b.b].includes(entrant) && [b.a, b.b].includes(registry.anchor)
          && b.outcomes.length === 2 && b.outcomes.every(o => o.status !== 'shared-invalid'));
        const scores = matches.map(b => mean(b.outcomes.map(o => b.a === entrant ? o.score : 1 - o.score)));
        const estimate = scoreInterval(scores, alpha / comparisons);
        return { id: entrant, independentPairs: scores.length, ...estimate,
          familywiseDistinguishable: matches.length > 0 && matches.every(v => v.fixedEndpoint === true)
            && estimate.interval !== null && (estimate.interval[0] > .5 || estimate.interval[1] < .5) };
      });
      const { blocks: ignored, ...identity } = pool;
      return { id, ...identity, cells, ratings, attemptedGames: outcomes.length, gameSeconds,
        naturalGames: outcomes.filter(o => o.status === 'natural').length,
        naturalGamesPerSummedGameHour: gameSeconds ? outcomes.filter(o => o.status === 'natural').length * 3600 / gameSeconds : null };
    }) };
}

// Translate existing paired receipts. The caller supplies verified full-player and pool identities.
export function importPairedBlocks(blocks, context) {
  return blocks.map(block => ({ schema: 'native-ladder-block/1', ...context, seed: block.seed,
    outcomes: block.outcomes.map(o => ({ aSeat: o.candidateSeat ?? o.role?.candidateSeat,
      status: o.status, score: o.score ?? null, seconds: o.seconds, summary: o.summary,
      reason: o.reason ?? null })) }));
}
