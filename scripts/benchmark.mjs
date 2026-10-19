import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Environment } from '../src/environment.mjs';
import { greedyPolicy, delayedAttackPolicy, runEpisode } from '../src/policies.mjs';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid ${name}`);
  return value;
};
const games = argument('--games', 500), repeats = argument('--repeats', 5);
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? 'runs/benchmark.json' : process.argv[outputIndex + 1];
if (!output || output.startsWith('--')) throw new TypeError('--output needs a file path');
const shortGames = process.argv.includes('--short-games');
const policy = shortGames ? greedyPolicy : delayedAttackPolicy;
if (games > 10000 || repeats > 20) throw new RangeError('desktop budget is at most 10000 games per repeat and 20 repeats');

function trial(count, offset, record) {
  let actions = 0, turns = 0, truncated = 0, checksum = 0;
  const outcomes = { prizes: 0, no_pokemon: 0, deckout: 0 }, wins = [0, 0];
  const cpuStart = process.cpuUsage(), start = performance.now();
  for (let index = 0; index < count; index++) {
    const env = new Environment({ seed: offset + index, record });
    const result = runEpisode(env, [policy, policy]);
    actions += result.actions; turns += result.turns; truncated += Number(result.truncated);
    if (result.terminated) { outcomes[result.reason]++; wins[result.winner]++; }
    checksum = (checksum + result.actions * 17 + result.turns * 3 + (result.winner ?? 3)) >>> 0;
  }
  const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  if (truncated || Object.values(outcomes).reduce((a, b) => a + b, 0) !== count) throw new Error('benchmark contains incomplete games');
  return { games: count, elapsedMs, gamesPerSecond: count * 1000 / elapsedMs, actionsPerSecond: actions * 1000 / elapsedMs, actions, turns, errors: 0, truncated, outcomes, wins, checksum, cpuMs: (cpu.user + cpu.system) / 1000 };
}

trial(50, 100000, false);
const modes = { training: [], replay: [] };
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const mode of repeat % 2 === 0 ? ['training', 'replay'] : ['replay', 'training']) {
    modes[mode].push(trial(games, 1, mode === 'replay'));
  }
}
const summary = Object.fromEntries(Object.entries(modes).map(([mode, rows]) => {
  const sorted = rows.map(row => row.gamesPerSecond).sort((a, b) => a - b);
  return [mode, { medianGamesPerSecond: sorted[Math.floor(sorted.length / 2)], minGamesPerSecond: sorted[0], maxGamesPerSecond: sorted.at(-1), runs: rows.length }];
}));
const report = {
  schema: 'benchmark-v1', timestamp: new Date().toISOString(), profile: 'basic-duel-v1', engine: '0.1.0', node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
  concurrency: 1, seedStart: 1, warmupGames: 50, maxActions: 2000,
  workload: `60-card mirror decks, 4 Machop + 4 Rattata + 52 Fighting Energy; 6 prizes; ${shortGames ? 'greedy-v1' : 'greedy-v1 with attacks delayed until turn 50'} both seats`,
  includes: 'reset, shuffle and mulligans, masked observations, legal enumeration and validation, policy, complete terminal games; replay mode also stores events and actions',
  excludes: 'module import, process startup, disk output, replay verification, neural inference, real Standard card effects; no threads or GPU',
  modes, summary,
};
mkdirSync('runs', { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
