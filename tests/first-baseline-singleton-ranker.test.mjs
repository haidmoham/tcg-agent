import test from 'node:test';
import assert from 'node:assert/strict';
import { useRankerForMandatorySingletons } from '../agents/first-baseline-singleton-ranker.mjs';

test('routing treatment changes only mandatory singleton routing and preserves agent ownership', () => {
  const history = { turn: 3 };
  const agent = { history, route(view) { assert.equal(this.history, history); return view.route; } };
  assert.equal(useRankerForMandatorySingletons(agent), agent);
  for (const route of ['ordinary', 'ranking', 'helper', 'waiting', 'terminal', 'singleton'])
    assert.equal(agent.route({ route }), route === 'singleton' ? 'ranking' : route);
  assert.equal(agent.history, history);
});
