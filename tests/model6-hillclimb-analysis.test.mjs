import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedMeanInterval, compareHillclimbPanels } from '../src/model6-hillclimb-analysis.mjs';

const receipt = (count, a, b, score, offset = 0) => ({ state: 'completed', plannedPairs: count,
  blocks: Array.from({ length: count }, (_, seed) => ({ a, b, seed: seed + offset, fixedEndpoint: true,
    outcomes: [{ aSeat: 'human', score, status: 'natural' }, { aSeat: 'opponent', score, status: 'natural' }] })) });
const candidate = 'first-baseline-singleton-ranker';
const panels = () => ({ anchor: receipt(800, candidate, 'first-baseline', .5),
  candidateTeacher: receipt(400, candidate, 'teacher', .5, 800), incumbentTeacher: receipt(400, 'first-baseline', 'teacher', .5, 800),
  candidateArchived: receipt(400, candidate, 'archived', .5, 1200), incumbentArchived: receipt(400, 'first-baseline', 'archived', .5, 1200) });

test('mixture counts seed-block differences once and uses their actual range widths', () => {
  const result = compareHillclimbPanels(panels());
  assert.equal(result.endpoints.mixture.independentBlocks, 1600);
  assert.equal(result.endpoints.mixture.estimate, 0);
  assert.equal(result.endpoints.mixture.radius, Math.sqrt(Math.log(160) * 4000 / (2 * 1600 ** 2)));
  assert.equal(result.endpoints.anchor.radius, Math.sqrt(Math.log(200) / (2 * 800)));
  assert.equal(result.eligibleForFreshConfirmation, false);
  assert.equal(result.promotion, false);
});

test('incomplete endpoints and mismatched paired seeds cannot produce conclusions', () => {
  const incomplete = panels(); incomplete.anchor.state = 'running';
  assert.throws(() => compareHillclimbPanels(incomplete), /not complete/);
  const mismatch = panels(); mismatch.incumbentTeacher.blocks[0].seed = 999999;
  assert.throws(() => compareHillclimbPanels(mismatch), /seed blocks differ/);
});

test('planned precision supports the declared decision-relevant effect', () => {
  const { radius } = boundedMeanInterval(Array(1600).fill(0), [...Array(800).fill(1), ...Array(800).fill(2)], .0125);
  const powerLowerBound = 1 - Math.exp(-2 * 1600 ** 2 * (.1 - radius) ** 2 / 4000);
  assert.ok(radius < .064);
  assert.ok(powerLowerBound > .8);
});
