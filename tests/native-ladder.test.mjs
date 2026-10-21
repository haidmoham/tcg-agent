import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityHash, scheduleMatches, summarizeNativeLadder } from '../src/native-ladder.mjs';

const hash = identityHash('test');
const registry = { schema: 'native-ladder-registry/1', anchor: 'anchor', entrants: ['anchor', 'candidate', 'teacher'].map(id =>
  ({ id, agentSha256: hash, description: id })) };
const block = (seed, scores = [1, 1], extra = {}) => ({ schema: 'native-ladder-block/1', a: 'candidate', b: 'anchor', seed,
  agentHashes: { anchor: hash, candidate: hash }, environmentSha256: hash, scenarioSha256: hash,
  protocolSha256: hash, receiptSha256: hash, split: 'development', failureContract: 'test/1', fixedEndpoint: true,
  outcomes: scores.map((score, i) => ({ aSeat: i ? 'opponent' : 'human', status: 'natural', score, seconds: 30,
    summary: { completedNaturally: true, rejected: 0 } })), ...extra });

test('one seed is one uncertainty unit even though two seats are played', () => {
  const report = summarizeNativeLadder(registry, [block(1, [1, 0])]);
  const pool = report.pools[0], cell = pool.cells.find(c => c.a === 'candidate' && c.b === 'anchor');
  assert.equal(cell.independentPairs, 1); assert.equal(cell.games, 2); assert.equal(cell.score, .5);
  assert.deepEqual(cell.interval, [0, 1]); assert.equal(cell.rating, 0);
  assert.equal(pool.cells.find(c => c.a === 'teacher' && c.b === 'anchor').score, null);
  assert.equal(pool.naturalGamesPerSummedGameHour, 120);
});

test('compatibility, splits, player identities, and duplicate evidence are enforced', () => {
  assert.equal(summarizeNativeLadder(registry, [block(1), block(2, [0, 0], { scenarioSha256: identityHash('other deck') })]).pools.length, 2);
  assert.equal(summarizeNativeLadder(registry, [block(1), block(1, [0, 0], { split: 'consumed-confirmation' })]).pools.length, 2);
  assert.throws(() => summarizeNativeLadder(registry, [block(1), block(1)]), /duplicate seed/);
  assert.throws(() => summarizeNativeLadder(registry, [block(1, [1, 1], { agentHashes: { anchor: hash, candidate: identityHash('changed') } })]), /identity changed/);
  const reversed = block(1, [0, 0], { a: 'anchor', b: 'candidate' });
  assert.throws(() => summarizeNativeLadder(registry, [block(1), reversed]), /duplicate seed/);
});

test('failures remain visible and a partial pair contributes no strength score', () => {
  const failed = block(1); failed.outcomes[1] = { aSeat: 'opponent', status: 'shared-invalid', score: null, seconds: 20 };
  const cell = summarizeNativeLadder(registry, [failed]).pools[0].cells.find(c => c.a === 'candidate' && c.b === 'anchor');
  assert.equal(cell.score, null); assert.equal(cell.failureRate, .5); assert.equal(cell.failures['shared-invalid'], 1);
  const cap = block(2); cap.outcomes[1] = { aSeat: 'opponent', status: 'command-cap-draw', score: .5, seconds: 20 };
  assert.equal(summarizeNativeLadder(registry, [cap]).pools[0].cells.find(c => c.a === 'candidate' && c.b === 'anchor').score, .75);
});

test('distinguishability requires fixed endpoint and correct sample size', () => {
  const blocks = Array.from({ length: 100 }, (_, i) => block(i));
  const pool = summarizeNativeLadder(registry, blocks).pools[0];
  assert.equal(pool.ratings.find(r => r.id === 'candidate').familywiseDistinguishable, true);
  assert.equal(pool.ratings.find(r => r.id === 'candidate').rating, 'Infinity');
  const preview = blocks.map(b => ({ ...b, fixedEndpoint: false }));
  assert.equal(summarizeNativeLadder(registry, preview).pools[0].ratings.find(r => r.id === 'candidate').familywiseDistinguishable, false);
  assert.equal(summarizeNativeLadder(registry, preview).promotion, false);
});

test('simple fixed scheduling rejects repeat matchups and seeds', () => {
  assert.equal(scheduleMatches(registry, [['candidate', 'anchor'], ['teacher', 'anchor']], [1, 2]).length, 4);
  assert.throws(() => scheduleMatches(registry, [['candidate', 'anchor'], ['anchor', 'candidate']], [1]), /duplicate matchup/);
  assert.throws(() => scheduleMatches(registry, [['candidate', 'anchor']], [1, 1]), /unique uint32/);
});
