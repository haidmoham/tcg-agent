import { Random } from './rng.mjs';

export function supervisedSessionPlan({ seed = 1, maxMatches = 3, durationMinutes = 15, pauseMinMs = 15000, pauseMaxMs = 30000, supervision = 'supervised', gates = {} } = {}) {
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 10 || !Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 60) throw new TypeError('invalid bounded session budget');
  if (!Number.isSafeInteger(pauseMinMs) || !Number.isSafeInteger(pauseMaxMs) || pauseMinMs < 1000 || pauseMaxMs < pauseMinMs || pauseMaxMs > 300000) throw new TypeError('invalid pacing bounds');
  if (!['supervised', 'unattended'].includes(supervision)) throw new TypeError('invalid supervision mode');
  const requiredGates = ['rulesCoverageReviewed', 'observationIsolationPassed', 'heldOutEvaluationReviewed', 'reliabilityReviewed', 'accountSessionSelected', 'boundedRunPlanReviewed'];
  const unmetGates = requiredGates.filter(key => gates[key] !== true);
  if (supervision === 'unattended' && unmetGates.length) throw new Error(`unattended plan blocked by ${unmetGates.join(', ')}`);
  const rng = new Random(seed);
  return {
    schema: 'supervised-session-plan-v1', execution: 'plan-only-no-live-adapter', supervision, maxConcurrentMatches: 1,
    maxMatches, durationMinutes, seed, pacingPurpose: 'bounded rate control and UI readiness; no impersonation or detection evasion',
    pauses: Array.from({ length: Math.max(0, maxMatches - 1) }, (_, index) => ({ afterMatch: index + 1, plannedMs: pauseMinMs + rng.int(pauseMaxMs - pauseMinMs + 1), realizedMs: null })),
    stopOn: ['warning', 'unexpected-state', 'disconnect', 'budget-exhausted', 'supervisor-stop'],
    unattendedReady: unmetGates.length === 0, unmetGates,
  };
}
