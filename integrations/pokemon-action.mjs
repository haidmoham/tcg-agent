import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && /^[A-Za-z0-9._/-]{1,128}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const semanticActionHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function attribution(value) {
  if (!object(value) || !['model', 'helper'].includes(value.kind) || !text(value.id)
      || Object.keys(value).some(key => !['kind', 'id', 'reason'].includes(key))
      || (value.kind === 'model' && value.reason !== undefined)
      || (value.kind === 'helper' && !['setup', 'prompt', 'ordinary-fallback'].includes(value.reason))) throw new Error('invalid-policy-attribution');
  return { kind: value.kind, id: value.id, ...(value.kind === 'helper' ? { reason: value.reason } : {}) };
}

export function semanticPokemonAction(view, decision, origin) {
  if (!object(view) || !Number.isSafeInteger(view.revision) || view.revision < 0 || view.status !== 'playing'
      || !Array.isArray(view.actions) || !Array.isArray(view.prompts) || view.prompts.length !== 0
      || !object(decision) || Object.keys(decision).length !== 1 || !text(decision.actionId)) throw new Error('unsupported-semantic-decision');
  const candidates = view.actions.filter(action => action.id === decision.actionId);
  if (candidates.length !== 1) throw new Error('illegal-semantic-choice');
  const candidate = candidates[0];
  if (!['play', 'attack', 'ability', 'retreat', 'pass', 'concede'].includes(candidate.kind)
      || Object.keys(candidate).some(key => !['id', 'kind', 'sourceCardId', 'actorId', 'targetId', 'attackName', 'actionKey'].includes(key))) throw new Error('invalid-semantic-candidate');
  return freeze({ schema: 'pokemon-action/1', revision: view.revision, action: structuredClone(candidate), attribution: attribution(origin) });
}

export function resolvePokemonAction(semantic, currentView, projector) {
  if (!object(semantic) || semantic.schema !== 'pokemon-action/1'
      || Object.keys(semantic).some(key => !['schema', 'revision', 'action', 'attribution'].includes(key))
      || !object(semantic.action) || semantic.revision !== currentView?.revision) throw new Error('stale-semantic-action');
  const current = semanticPokemonAction(currentView, { actionId: semantic.action.id }, semantic.attribution);
  if (semanticActionHash(current) !== semanticActionHash(semantic)) throw new Error('changed-semantic-action');
  if (!projector || typeof projector.resolve !== 'function') throw new Error('semantic-resolver-required');
  return projector.resolve({ actionId: current.action.id });
}

export class ActionExecutionLedger {
  #pending = new Map();
  #events = [];
  #counts = { recommendations: 0, helperRecommendations: 0, policyDecisions: 0, helperDecisions: 0, driverFailures: 0, cancelled: 0, fixtureTransitions: 0 };

  get counts() { return { ...this.#counts }; }
  get audit() { return this.#events.map(event => ({ ...event })); }

  propose(id, semantic) {
    if (!text(id) || this.#pending.has(id) || this.#events.some(event => event.id === id)
        || this.#events.length + this.#pending.size >= 1024
        || semantic?.schema !== 'pokemon-action/1' || !Number.isSafeInteger(semantic.revision)) throw new Error('invalid-ledger-intent');
    const validated = semanticPokemonAction({ status: 'playing', revision: semantic.revision, actions: [semantic.action], prompts: [] },
      { actionId: semantic.action?.id }, semantic.attribution);
    if (semanticActionHash(validated) !== semanticActionHash(semantic)) throw new Error('invalid-ledger-intent');
    const origin = attribution(semantic.attribution), hash = semanticActionHash(semantic);
    this.#pending.set(id, { revision: semantic.revision, hash, origin });
    this.#counts[origin.kind === 'model' ? 'recommendations' : 'helperRecommendations']++;
    this.#events.push({ event: 'recommended', id, semanticHash: hash, policyKind: origin.kind, policyId: origin.id,
      ...(origin.reason ? { reason: origin.reason } : {}) });
  }

  complete(id, outcome) {
    const pending = this.#pending.get(id);
    if (!pending || !object(outcome) || !['verified-game-action', 'driver-failure', 'cancelled', 'fixture-transition'].includes(outcome.kind)) throw new Error('invalid-ledger-outcome');
    const verified = outcome.kind === 'verified-game-action';
    if (verified && (!object(outcome.proof) || !['native-simulator', 'local-ui', 'official-client'].includes(outcome.proof.adapter)
        || outcome.proof.semanticHash !== pending.hash || outcome.proof.fromRevision !== pending.revision
        || !Number.isSafeInteger(outcome.proof.toRevision) || outcome.proof.toRevision <= pending.revision)) throw new Error('verified-action-proof-required');
    const counter = verified ? pending.origin.kind === 'model' ? 'policyDecisions' : 'helperDecisions'
      : { 'driver-failure': 'driverFailures', cancelled: 'cancelled', 'fixture-transition': 'fixtureTransitions' }[outcome.kind];
    this.#counts[counter]++;
    this.#pending.delete(id);
    this.#events.push({ event: outcome.kind, id, semanticHash: pending.hash, policyKind: pending.origin.kind, policyId: pending.origin.id,
      ...(pending.origin.reason ? { reason: pending.origin.reason } : {}) });
    return { trainingEligible: verified && pending.origin.kind === 'model' };
  }
}
