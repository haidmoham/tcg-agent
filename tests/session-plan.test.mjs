import test from 'node:test';
import assert from 'node:assert/strict';
import { supervisedSessionPlan } from '../src/session-plan.mjs';
test('plans default to supervision, single-match pacing and no fabricated realized timings', () => {
  const plan = supervisedSessionPlan({ seed: 99 });
  assert.equal(plan.supervision, 'supervised');
  assert.equal(plan.maxConcurrentMatches, 1);
  assert.equal(plan.execution, 'plan-only-no-live-adapter');
  assert.equal(plan.unattendedReady, false);
  assert.ok(plan.pauses.every(p => p.plannedMs >= 15000 && p.plannedMs <= 30000 && p.realizedMs === null));
  assert.deepEqual(plan, supervisedSessionPlan({ seed: 99 }));
  assert.throws(() => supervisedSessionPlan({ supervision: 'unattended' }), /blocked/);
  assert.throws(() => supervisedSessionPlan({ maxMatches: 100000 }), /budget/);
});
