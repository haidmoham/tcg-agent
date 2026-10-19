import { mkdirSync, writeFileSync } from 'node:fs';
import { Environment } from '../src/environment.mjs';
import { greedyPolicy, randomPolicy, runEpisode } from '../src/policies.mjs';
import { Random } from '../src/rng.mjs';

const pairs = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 10000) throw new TypeError('pairs must be 1..10000');
const pairScores = [], totals = { wins: 0, losses: 0, draws: 0, truncations: 0, errors: 0 }, reasons = {};
for (let pair = 0; pair < pairs; pair++) {
  let score = 0;
  for (let seat = 0; seat < 2; seat++) {
    const policies = [randomPolicy(900001 + pair), randomPolicy(900001 + pair)];
    policies[seat] = greedyPolicy;
    const env = new Environment({ seed: 100001 + pair, record: false });
    const result = runEpisode(env, policies);
    reasons[result.reason ?? 'truncated'] = (reasons[result.reason ?? 'truncated'] ?? 0) + 1;
    if (result.truncated) { totals.truncations++; continue; }
    if (result.winner === null) { totals.draws++; score += 0.5; }
    else if (result.winner === seat) { totals.wins++; score++; }
    else totals.losses++;
  }
  pairScores.push(score / 2);
}
if (totals.truncations) throw new Error('evaluation contains truncations; do not report a win rate');
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const rng = new Random(876512);
const resamples = Array.from({ length: 1000 }, () => mean(Array.from({ length: pairs }, () => pairScores[rng.int(pairs)]))).sort((a, b) => a - b);
const report = {
  schema: 'evaluation-v1', profile: 'basic-duel-v1', engine: '0.1.0', policies: ['greedy-v1', 'legal-random-v1'], pairs, games: pairs * 2,
  seedStart: 100001, seatSwaps: true, totals, terminalReasons: reasons, meanPairScore: mean(pairScores),
  pairBootstrap95: [resamples[25], resamples[974]], bootstrapResamples: 1000, pairScores,
  interpretation: 'restricted-profile baseline check; paired-seed uncertainty only, no deck/population shift uncertainty, no learned agent, no Live rating estimate',
};
mkdirSync('runs', { recursive: true });
writeFileSync('runs/evaluation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, pairScores: undefined }, null, 2));
