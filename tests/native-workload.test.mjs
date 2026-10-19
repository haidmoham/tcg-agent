import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { benchmarkDeckOrder } from '../integrations/local-worker/benchmark.mjs';
import { validateGauntlet } from '../integrations/local-worker/gauntlet.mjs';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('benchmark follows recorded deck seats and rejects foreign or duplicate decks', () => {
  const decks = [['a', 'b'], ['c', 'd']];
  assert.deepEqual(benchmarkDeckOrder(decks, { deckHashes: decks.map(hash).reverse() }), decks.toReversed());
  assert.throws(() => benchmarkDeckOrder(decks, { deckHashes: [hash(decks[0]), hash(decks[0])] }));
  assert.throws(() => benchmarkDeckOrder(decks, { deckHashes: [hash(decks[0]), 'unknown'] }));
});

test('frozen gauntlet admits balanced fixtures and rejects invented metagame weights', () => {
  const manifest = JSON.parse(readFileSync(new URL('../experiments/native-gauntlet-v1.json', import.meta.url)));
  validateGauntlet(manifest);
  assert.throws(() => validateGauntlet({ ...manifest, observedMetagameCoverage: 1 }));
  assert.throws(() => validateGauntlet({ ...manifest, maxGames: 3 }));
  assert.throws(() => validateGauntlet({ ...manifest, concurrency: 2 }));
});
