import { createHash } from 'node:crypto';
import { Random } from '../../src/rng.mjs';
import { runAuditedEpisode } from './audit-runner.mjs';

export function validateGauntlet(manifest) {
  if (manifest?.schema !== 'native-gauntlet-v1' || manifest.fullStandardClaim !== false || manifest.concurrency !== 1 || manifest.weightSource !== 'designed-balanced-fixture' || manifest.observedMetagameCoverage !== null || manifest.decks?.length !== 2 || manifest.decks.some(deck => deck.weight !== 0.5 || deck.observedShare !== null) || manifest.policies?.length !== 1 || manifest.policies[0].weight !== 1) throw new TypeError('explicit balanced native fixture manifest required');
  if (!Array.isArray(manifest.seedPairs) || manifest.seedPairs.length < 1 || manifest.seedPairs.length > 5 || new Set(manifest.seedPairs).size !== manifest.seedPairs.length || manifest.seedPairs.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) || manifest.maxGames !== manifest.seedPairs.length * 2 || !Number.isSafeInteger(manifest.maxCommandsPerGame) || manifest.maxCommandsPerGame < 1 || manifest.maxCommandsPerGame > 2000 || !Number.isSafeInteger(manifest.maxSecondsPerGame) || manifest.maxSecondsPerGame < 1 || manifest.maxSecondsPerGame > 180) throw new TypeError('invalid native gauntlet budget');
  if (manifest.decks[0].bundleKey !== 'realDeckRows' || manifest.decks[1].bundleKey !== 'zoroarkDeckRows') throw new TypeError('unknown pinned native deck identity');
}

export async function runNativeGauntlet(config, manifest, { onGame = () => {} } = {}) {
  validateGauntlet(manifest);
  const games = [];
  seeds: for (const seed of manifest.seedPairs) for (const seatOrder of [[0, 1], [1, 0]]) {
    let game; let journal = null; let failure = null;
    try {
      const result = await runAuditedEpisode(config, { seed, seatOrder, maxCommands: manifest.maxCommandsPerGame, maxSeconds: manifest.maxSecondsPerGame });
      const dragapultSeat = seatOrder[0] === 0 ? 'human' : 'opponent';
      const score = result.summary.winnerSeat === null ? 0.5 : Number(result.summary.winnerSeat === dragapultSeat);
      game = { seed, seatOrder, scoreForDeck0: score, status: 'completed', ...result.summary, deckHashes: result.journal.header.deckHashes };
      journal = result.journal;
    } catch (error) {
      failure = error;
      game = { seed, seatOrder, status: ['NATIVE_EPISODE_TIME_BUDGET', 'NATIVE_EPISODE_COMMAND_BUDGET'].includes(error.code) ? 'truncated' : 'error', scoreForDeck0: null, errorName: error.name, errorCode: error.code ?? null };
    }
    games.push(game); onGame({ game, journal, failure, index: games.length - 1 });
    if (games.filter(value => value.status !== 'completed').length >= 2) break seeds;
  }
  const complete = games.length === manifest.maxGames && games.every(game => game.status === 'completed');
  let score = null; let interval = null;
  if (complete) {
    const pairs = manifest.seedPairs.map(seed => games.filter(game => game.seed === seed).reduce((sum, game) => sum + game.scoreForDeck0, 0) / 2);
    score = pairs.reduce((sum, value) => sum + value, 0) / pairs.length;
    const rng = new Random(8102), samples = [];
    for (let repeat = 0; repeat < 1000; repeat++) samples.push(pairs.reduce(sum => sum + pairs[rng.int(pairs.length)], 0) / pairs.length);
    samples.sort((a, b) => a - b); interval = [samples[25], samples[974]];
  }
  return { schema: 'native-gauntlet-receipt-v1', suite: manifest.id, manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), profile: manifest.executionProfile, fullStandardClaim: false, weightSource: manifest.weightSource, observedMetagameCoverage: null, policySha256: config.policySha256, workerSha256: config.workerSha256, complete, errors: games.filter(game => game.status === 'error').length, truncations: games.filter(game => game.status === 'truncated').length, games, scoreForDeck0: score, seedPairBootstrap95: interval, uncertainty: 'paired seed variation only; two exact decks and one frozen policy; no metagame or coverage uncertainty' };
}
