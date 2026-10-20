import { createHash } from 'node:crypto';
import { PolicyView } from '../local-worker/policy-view.mjs';
import { encodeOrdinaryDecision } from '../local-worker/learning-features.mjs';
import { semanticPokemonAction, resolvePokemonAction, ActionExecutionLedger } from '../pokemon-action.mjs';

class BridgeError extends Error {}
const fail = code => { throw new BridgeError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value);
const identity = value => text(value) || (Number.isSafeInteger(value) && value >= 0);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function readObservation(input, window, now, maxAgeMs, ordinary) {
  if (!object(input) || input.schema !== 'official-client-observation/1' || !text(input.id)) fail('invalid-observation');
  if (!['fixture', 'supported-ui'].includes(input.source)) fail('unsupported-source');
  if (!integer(input.capturedAt) || input.capturedAt > now || now - input.capturedAt > maxAgeMs) fail('stale-observation');
  if (!object(input.window) || input.window.id !== window.id || input.window.app !== window.app) fail('window-mismatch');
  if (input.window.visible !== true) fail('window-not-visible');
  if (input.window.focused !== false) fail('background-window-required');
  if (input.deckDisplayName !== 'AgentPult') fail('deck-mismatch');
  if (!Array.isArray(input.unknowns) || input.unknowns.length !== 0) fail('unknown-state');
  if (!object(input.compatibility) || input.compatibility.exactDeckVerified !== true || input.compatibility.cardsVerified !== true) fail('compatibility-gap');
  if (input.screen !== 'playing') fail('unsupported-screen');
  let projector, view;
  try {
    projector = new PolicyView();
    view = projector.project(input.policyView);
  } catch { fail('invalid-policy-view'); }
  if (view.prompts.length !== 0) fail('unsupported-prompt');
  if (!Array.isArray(input.mappings) || input.mappings.length > 512) fail('invalid-mapping');
  const mappings = input.mappings.map(mapping => {
    if (!object(mapping) || !text(mapping.actionId) || !object(mapping.target)
        || !identity(mapping.target.elementId) || !text(mapping.target.label) || !object(mapping.expected)
        || mapping.expected.screen !== 'playing' || !integer(mapping.expected.revision)
        || mapping.expected.revision <= view.revision) fail('invalid-mapping');
    return { actionId: mapping.actionId, target: { elementId: mapping.target.elementId, label: mapping.target.label },
      expected: { screen: mapping.expected.screen, revision: mapping.expected.revision } };
  });
  const rawActions = input.policyView.actions;
  if (new Set(mappings.map(mapping => mapping.actionId)).size !== mappings.length
      || mappings.length !== rawActions.length
      || rawActions.some(action => !mappings.some(mapping => mapping.actionId === action.id))) fail('candidate-mapping-mismatch');
  if (ordinary) {
    try { encodeOrdinaryDecision(view); } catch { fail('unsupported-policy-state'); }
  }
  const normalized = { source: input.source, window: { id: window.id, app: window.app, visible: true, focused: false },
    deckDisplayName: 'AgentPult', screen: input.screen, policyView: view, mappings };
  return { id: input.id, capturedAt: input.capturedAt, source: input.source, view, projector,
    mappings, fingerprint: hash(normalized), screen: input.screen };
}

export class SupervisedBridge {
  #window;
  #now;
  #maxAgeMs;
  #minIntervalMs;
  #transitionTimeoutMs;
  #state = 'disarmed';
  #epoch = 0;
  #sequence = 0;
  #busy = false;
  #proposal = null;
  #pending = null;
  #lastStepAt = -Infinity;
  #lastRevision = -1;
  #timer = null;
  #audit = [];
  #decisions = new ActionExecutionLedger();

  constructor(options) {
    if (!object(options) || Object.keys(options).some(key => !['window', 'now', 'maxAgeMs', 'minIntervalMs', 'transitionTimeoutMs'].includes(key))) fail('invalid-config');
    const { window, now = Date.now, maxAgeMs = 2000, minIntervalMs = 1000, transitionTimeoutMs = 5000 } = options;
    if (!object(window) || !identity(window.id) || !text(window.app) || typeof now !== 'function'
        || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 2000
        || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 1000 || minIntervalMs > 60000
        || !Number.isSafeInteger(transitionTimeoutMs) || transitionTimeoutMs < 1 || transitionTimeoutMs > 5000) fail('invalid-config');
    this.#window = freeze({ id: window.id, app: window.app });
    this.#now = now;
    this.#maxAgeMs = maxAgeMs;
    this.#minIntervalMs = minIntervalMs;
    this.#transitionTimeoutMs = transitionTimeoutMs;
  }

  get status() { this.#checkTimeout(); return this.#state; }
  get audit() { return this.#audit.map(event => ({ ...event })); }
  get decisionCounts() { return this.#decisions.counts; }
  get decisionAudit() { return this.#decisions.audit; }

  #time() {
    const now = this.#now();
    if (!integer(now)) fail('invalid-clock');
    return now;
  }

  #record(event, observationHash) {
    this.#audit.push({ event, status: this.#state, ...(observationHash ? { observationHash } : {}) });
    if (this.#audit.length > 128) this.#audit.shift();
  }

  #invalidate(state, event) {
    const intent = this.#proposal?.intent ?? this.#pending?.intent;
    if (intent) this.#decisions.complete(intent.id, { kind: event === 'fixture-transition-observed' ? 'fixture-transition'
      : ['armed', 'paused', 'killed'].includes(event) ? 'cancelled' : 'driver-failure' });
    this.#epoch++;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#busy = false;
    this.#proposal = null;
    this.#pending = null;
    this.#state = state;
    this.#record(event);
  }

  #stop(code) {
    if (this.#state !== 'killed') this.#invalidate('paused', code);
    fail(code);
  }

  #checkTimeout() {
    if (this.#pending && this.#time() >= this.#pending.deadline) this.#invalidate('paused', 'transition-timeout');
  }

  #read(input, ordinary) {
    try {
      const observation = readObservation(input, this.#window, this.#time(), this.#maxAgeMs, ordinary);
      if (observation.view.revision < this.#lastRevision) fail('stale-revision');
      this.#lastRevision = observation.view.revision;
      return observation;
    }
    catch (error) { this.#stop(error.message); }
  }

  arm() {
    this.#checkTimeout();
    if (!['disarmed', 'paused'].includes(this.#state)) fail(this.#state === 'killed' ? 'bridge-killed' : 'invalid-control-state');
    this.#invalidate('armed', 'armed');
    return this.#state;
  }

  async propose(input, model, attribution = { kind: 'model', id: 'model2' }) {
    this.#checkTimeout();
    if (this.#state !== 'armed' || this.#busy) fail('bridge-not-armed');
    const observation = this.#read(input, true);
    if (!model || typeof model.decide !== 'function') this.#stop('invalid-model');
    this.#busy = true;
    const epoch = ++this.#epoch;
    let timer;
    try {
      const decision = await Promise.race([
        Promise.resolve().then(() => model.decide({ view: observation.view })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('model-timeout')), this.#maxAgeMs); }),
      ]);
      if (epoch !== this.#epoch || this.#state !== 'armed') fail('proposal-cancelled');
      const age = this.#time() - observation.capturedAt;
      if (age < 0 || age > this.#maxAgeMs) this.#stop('stale-observation');
      let rawDecision, semanticAction;
      try {
        semanticAction = semanticPokemonAction(observation.view, decision, attribution);
        rawDecision = resolvePokemonAction(semanticAction, observation.view, observation.projector);
      } catch { this.#stop('illegal-model-choice'); }
      const action = observation.view.actions.find(candidate => candidate.id === decision.actionId);
      const mapping = observation.mappings.find(candidate => candidate.actionId === rawDecision.actionId);
      if (!action || !mapping) this.#stop('illegal-model-choice');
      const intent = freeze({ id: `proposal-${++this.#sequence}`, semanticAction, actionKind: action.kind, target: { ...mapping.target },
        expected: { ...mapping.expected }, observationHash: observation.fingerprint, mode: 'dry-run' });
      this.#decisions.propose(intent.id, semanticAction);
      this.#proposal = { intent, observation };
      this.#state = 'proposed';
      this.#record('proposed', observation.fingerprint);
      return intent;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (epoch !== this.#epoch) fail('proposal-cancelled');
      this.#stop(error.message === 'model-timeout' ? 'model-timeout' : 'model-failed');
    } finally {
      clearTimeout(timer);
      if (epoch === this.#epoch) this.#busy = false;
    }
  }

  step(proposalId, freshInput) {
    this.#checkTimeout();
    if (this.#state !== 'proposed' || !this.#proposal) fail('no-current-proposal');
    if (proposalId !== this.#proposal.intent.id) this.#stop('proposal-mismatch');
    const observation = this.#read(freshInput, true);
    const { intent, observation: previous } = this.#proposal;
    if (this.#time() - previous.capturedAt > this.#maxAgeMs) this.#stop('stale-proposal');
    if (observation.fingerprint !== intent.observationHash) this.#stop('state-changed');
    if (observation.id === previous.id || observation.capturedAt <= previous.capturedAt) this.#stop('fresh-capture-required');
    const now = this.#time();
    if (now - this.#lastStepAt < this.#minIntervalMs) this.#stop('action-rate-limited');
    this.#lastStepAt = now;
    this.#proposal = null;
    this.#state = 'awaiting-transition';
    this.#pending = { intent, observation, deadline: now + this.#transitionTimeoutMs };
    const epoch = this.#epoch;
    this.#timer = setTimeout(() => {
      if (epoch === this.#epoch && this.#state === 'awaiting-transition') this.#invalidate('paused', 'transition-timeout');
    }, this.#transitionTimeoutMs);
    this.#timer.unref?.();
    this.#record('dry-run-step', observation.fingerprint);
    return freeze({ ...intent, execution: 'not-sent' });
  }

  observe(input) {
    this.#checkTimeout();
    if (this.#state !== 'awaiting-transition' || !this.#pending) fail('no-pending-transition');
    const observation = this.#read(input, false);
    const { intent, observation: previous } = this.#pending;
    if (observation.source !== 'fixture') this.#stop('fixture-transition-required');
    if (observation.id === previous.id || observation.capturedAt <= previous.capturedAt) this.#stop('fresh-capture-required');
    if (observation.screen !== intent.expected.screen || observation.view.revision !== intent.expected.revision) this.#stop('transition-mismatch');
    this.#invalidate('armed', 'fixture-transition-observed');
    return { status: this.#state, observationHash: observation.fingerprint, mode: 'dry-run' };
  }

  pause() {
    if (this.#state !== 'killed') this.#invalidate('paused', 'paused');
    return this.#state;
  }

  kill() { this.#invalidate('killed', 'killed'); return this.#state; }
}
