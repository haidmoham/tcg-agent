import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRuntimeMatch } from './runtime-policy.mjs';

export const model5CheckpointSha256 = 'e439671126e727344fb92fc2d304a967f85fe56d5ac1a4aaa9b0f12b8c9d9607';
export const model5SourceFiles = Object.freeze(['integrations/local-worker/entity-model.mjs',
  'integrations/local-worker/policy-view.mjs', 'integrations/local-worker/card-action-policy.mjs',
  'learning/entity-features.mjs', 'learning/entity-contract.json', 'learning/entity_torch.py', 'learning/card_action_torch.py']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));

// The immutable authored-source snapshot and catalog stay local. Loading this
// module does not attach to the client or create a model process.
export async function loadModel5Bridge(path) {
  const manifest = await read(path);
  if (manifest.schema !== 'official-client-model5/1' || manifest.checkpointSha256 !== model5CheckpointSha256
      || !isAbsolute(manifest.sourceRoot ?? '') || !/^[a-f0-9]{40}$/.test(manifest.sourceRevision ?? '')) throw new Error('model5-frozen-manifest-required');
  for (const file of model5SourceFiles) {
    if (sha(await readFile(join(manifest.sourceRoot, file))) !== manifest.sourceSha256?.[file]) throw new Error('model5-source-pin-mismatch:' + file);
  }
  const config = manifest.modelConfig;
  if (config?.device !== 'cpu' || sha(await readFile(config.checkpoint)) !== model5CheckpointSha256
      || sha(await readFile(config.catalogPath)) !== config.catalogSha256) throw new Error('model5-artifact-pin-mismatch');
  for (const [key, file] of Object.entries(manifest.inputFiles)) {
    if (!isAbsolute(file) || sha(await readFile(file)) !== manifest.inputSha256?.[key]) throw new Error('model5-input-pin-mismatch:' + key);
  }
  const module = file => import(pathToFileURL(join(manifest.sourceRoot, file)).href);
  const [{ EntityModelClient }, { PolicyView }, features, policies] = await Promise.all([
    module('integrations/local-worker/entity-model.mjs'), module('integrations/local-worker/policy-view.mjs'),
    module('learning/entity-features.mjs'), module('integrations/local-worker/card-action-policy.mjs')]);
  if (features.entityContractSha256 !== manifest.contractSha256) throw new Error('model5-feature-contract-mismatch');
  return { manifest, config, EntityModelClient, PolicyView, ...features,
    supportsCardSelection: policies.supportsCardSelection, rankedPromptAnswers: policies.rankedPromptAnswers };
}

const energyNames = { R: 'fire', P: 'psychic', D: 'darkness', W: 'water', G: 'grass', L: 'lightning',
  F: 'fighting', M: 'metal', C: 'colorless', Y: 'fairy', N: 'dragon' };
const conditionNames = { poison: 'poisoned', burn: 'burned', paralyze: 'paralyzed', confuse: 'confused', sleep: 'asleep' };

// Enrich only fields already emitted by the rendered UI boundary. Public
// modifiers, turn usage and entered/evolved flags stay unknown when unobserved.
export function projectModel5Runtime(observation, sources, revision, mapping) {
  const raw = projectRuntimeMatch(observation, sources, revision, mapping), match = observation.match;
  if (match.opponent.hand != null) throw new Error('model5-opponent-hand-faces-rejected');
  const visible = new Map();
  const add = (card, owner, zone) => {
    visible.set(card.instanceId, { ...card, owner, zone });
    for (const [group, cards] of Object.entries(card.publicCards ?? {})) for (const child of cards) add(child, owner, group);
  };
  for (const owner of ['you', 'opponent']) for (const zone of ['hand', 'active', 'bench', 'discard', 'stadium'])
    for (const card of match[owner][zone] ?? []) add(card, owner, zone);
  const enrichCard = (card, owner) => {
    const original = visible.get(card.instanceId);
    if (!original) throw new Error('model5-visible-source-binding-missing');
    return { ...card, owner, definitionId: mapping.definition(original.source) };
  };
  raw.hand = raw.hand.map(card => enrichCard(card, 'you'));
  for (const owner of ['you', 'opponent']) {
    const side = raw[owner];
    const enrichCreature = card => {
      if (!card) return null;
      const energy = visible.get(card.instanceId)?.energy;
      const tokens = typeof energy === 'string' && /^(?:\{[A-Z]\})*$/.test(energy) ? [...energy.matchAll(/\{([A-Z])\}/g)].map(match => match[1]) : null;
      return { ...card, conditions: card.conditions.filter(value => value !== 'none').map(value => conditionNames[value] ?? value),
        ...(tokens?.every(token => energyNames[token]) ? { providedEnergyTypes: tokens.map(token => energyNames[token]) } : {}),
        ...(card.publicCards ? { publicCards: Object.fromEntries(Object.entries(card.publicCards).map(([key, cards]) =>
          [key, cards.map(item => enrichCard(item, owner))])) } : {}) };
    };
    side.active = enrichCreature(side.active); side.bench = side.bench.map(enrichCreature);
    side.discard = side.discard.map(card => enrichCard(card, owner));
  }
  if (raw.stadium) raw.stadium = enrichCard(raw.stadium, visible.get(raw.stadium.instanceId).owner);
  raw.actions = raw.actions.map(action => {
    const target = visible.get(action.targetId);
    // Ordinary IDs encode admitted SDK commands, not arbitrary incoming code.
    const [command, , position] = JSON.parse(action.id);
    const zone = command === 'PlaceCard' ? ({ 2: 'stadium', 13: 'bench', 14: 'bench', 15: 'active', 16: 'active' })[position]
      : ['AttachCard', 'EvolveCard'].includes(command) ? target?.zone : null;
    return { ...action, ...(action.sourceCardId ? { actorId: action.sourceCardId } : {}),
      ...(['active', 'bench', 'stadium'].includes(zone) ? { destinationZone: zone } : {}) };
  });
  const unknown = () => ({ known: false, value: null });
  raw.publicContext = { itemLock: Object.fromEntries(['you', 'opponent'].map(owner => [owner, { ...unknown(), expiryKnown: false, remainingTurns: null }])),
    knockoutsDuringPreviousOpponentTurn: Object.fromEntries(['you', 'opponent'].map(owner => [owner, unknown()])),
    knockoutDrawEligible: Object.fromEntries(['you', 'opponent'].map(owner => [owner, unknown()])) };
  return raw;
}

export function model5PromptChoice(choice, mapping, sourceCard = null) {
  const card = value => ({ instanceId: value.instanceId ?? value.identity, printingId: mapping.printing(value),
    definitionId: mapping.definition(value.source), category: value.category });
  return { id: choice.id, group: choice.group, card: card(choice), instanceId: choice.identity,
    ...(sourceCard ? { sourceCard: card(sourceCard), sourceCardId: sourceCard.instanceId, targetId: choice.identity } : {}) };
}

// Track only an observed action origin. Unlike the native simulator's accepted
// command callbacks, a client state transition cannot establish turn-usage bits.
export function model5VisibleContext() {
  let turn = null, originAction = null, originCard = null;
  return {
    view(view) {
      if (turn !== view.turnNumber) { turn = view.turnNumber; originAction = null; originCard = null; }
      return { ...view, decisionContext: { originAction, originCard, usage: {}, entityUsage: {},
        originEvidence: 'last returned dispatch; semantic execution unverified', turnUsageEvidence: 'unknown' } };
    },
    dispatched(view, decision) {
      if (!decision.actionId) return;
      originAction = view.actions.find(action => action.id === decision.actionId) ?? null;
      const cards = [...view.hand, view.you.active, ...view.you.bench, ...view.you.discard].filter(Boolean);
      originCard = cards.find(card => card.instanceId === (originAction?.sourceCardId ?? originAction?.actorId)) ?? null;
    },
  };
}
