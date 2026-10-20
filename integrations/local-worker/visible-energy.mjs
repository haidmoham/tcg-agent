import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const units = text => typeof text === 'string' && /^(?:\{[GRWLPFDMYCN]\})*$/.test(text)
  ? [...text.matchAll(/\{([A-Z])\}/g)].map(match => match[1]) : null;

// A narrow, hot local rules oracle. No model, client or simulator imports.
export class VisibleEnergyClient {
  constructor({ executable, service, serviceSha256, rulesSha256, runtimeAssembly }) {
    if (![executable, service].every(isAbsolute) || ![serviceSha256, rulesSha256].every(value => /^[a-f0-9]{64}$/.test(value))
        || hash(readFileSync(service)) !== serviceSha256) throw new Error('pinned-visible-rules-service-required');
    if (runtimeAssembly !== undefined && (!isAbsolute(runtimeAssembly) || hash(readFileSync(runtimeAssembly)) !== rulesSha256))
      throw new Error('visible-client-and-shared-rules-dll-mismatch');
    this.rulesSha256 = rulesSha256; this.pending = new Map(); this.sequence = 0; this.buffer = ''; this.closed = false;
    this.child = spawn(executable, [service, rulesSha256], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.read(chunk));
    this.child.stderr.on('data', () => {});
    this.child.once('error', () => this.close(new Error('visible-rules-service-unavailable')));
    this.child.once('exit', () => this.close(new Error('visible-rules-service-ended')));
    this.child.stdin.on('error', () => this.close(new Error('visible-rules-input-ended')));
  }
  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) return this.close(new Error('visible-rules-reply-bound'));
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      let response;
      try { response = JSON.parse(this.buffer.slice(0, end)); } catch { return this.close(new Error('visible-rules-invalid-reply')); }
      this.buffer = this.buffer.slice(end + 1);
      const task = this.pending.get(response.id);
      if (!task || typeof response.ok !== 'boolean') return this.close(new Error('visible-rules-uncorrelated-reply'));
      this.pending.delete(response.id); clearTimeout(task.timer);
      if (response.ok && response.schema === 'visible-energy-service/1' && response.rulesSha256 === this.rulesSha256) task.accept(response);
      else task.reject(new Error('visible-rules-rejected-or-pin-mismatch'));
    }
  }
  request(op, input) {
    if (this.closed || this.pending.size) return Promise.reject(new Error('idle-visible-rules-service-required'));
    const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => this.close(new Error('visible-rules-timeout')), 10000);
      this.pending.set(id, { accept, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...(input ? { input } : {}) }) + '\n');
    });
  }
  verify() { return this.request('ping'); }
  async derive(input) { return (await this.request('derive', input)).facts; }
  close(error = new Error('visible-rules-closed')) {
    if (this.closed) return; this.closed = true;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear(); if (this.child.exitCode === null) this.child.kill();
  }
  async shutdown() { try { if (!this.closed) await this.request('close'); } finally { this.close(); } }
}

// Uses only the already-admitted policy entities and the corresponding visible
// UI records. Missing capture fields do not imply printed == effective.
export function visibleEnergyInput(raw, observation, definitions) {
  if (observation.match.opponent.hand != null) throw new Error('opponent-private-faces-rejected');
  const visible = new Map(), own = new Map();
  for (const owner of ['you', 'opponent']) for (const card of [...observation.match[owner].active, ...observation.match[owner].bench])
    visible.set(card.instanceId, card);
  const collect = card => { if (!card) return; own.set(card.instanceId, card); for (const child of card.publicCards?.energy ?? []) collect(child); };
  raw.hand.forEach(collect); collect(raw.you.active); raw.you.bench.forEach(collect); raw.you.discard.forEach(collect);
  const definition = card => definitions.get(card.definitionId ?? card.source);
  const basic = card => {
    const program = definition(card), values = program?.energyValues;
    return program?.cardFormat === 1 && values?.length === 1 && !(values[0].conditions?.length)
      && /^\{[GRWLPFDMYC]\}$/.test(values[0].value ?? '') ? values[0].value[1] : null;
  };
  const creatures = [];
  for (const owner of ['you', 'opponent']) for (const card of [raw[owner].active, ...raw[owner].bench].filter(Boolean)) {
    const face = visible.get(card.instanceId), program = definition(card);
    if (!face || !program || !Array.isArray(program.useActions)) throw new Error('complete-visible-energy-bindings-required');
    const supply = units(face.energy);
    const energyCards = card.publicCards?.energy;
    const suppliedKnown = supply !== null && Array.isArray(energyCards) && energyCards.every(child => basic(child) !== null);
    const captures = face.energyRules?.schema === 'visible-ui-energy-costs/1' ? face.energyRules.attacks : [];
    const attacks = program.useActions.filter(action => action.actionType === 1).map(action => {
      const printed = units(action.energyCost ?? '');
      const rows = captures.filter(row => row.source === action.actionSourceID);
      if (rows.length > 1) throw new Error('ambiguous-visible-attack-cost-binding');
      const capture = rows[0], effective = units(capture?.effectiveCost);
      // The SDK display appends rainbow-substitution text. Such modifiers are
      // excluded until their display/native semantics are explicitly admitted.
      const effectiveKnown = capture?.completePrimaryCost === true && effective !== null
        && !(action.conditionalEnergyCosts?.length) && capture.printedCost === (action.energyCost ?? '')
        && capture.effectiveCost === capture.printedCost;
      const actionKey = card.definitionId + '/' + action.actionSourceID;
      const offered = raw.actions.some(offer => offer.kind === 'attack' && offer.sourceCardId === card.instanceId && offer.actionKey === actionKey);
      return { actionKey, printedKnown: printed !== null, printedUnits: printed ?? [], effectiveKnown,
        costAlternatives: effectiveKnown ? [effective] : [], attackLegalKnown: offered, attackLegal: offered ? true : null };
    });
    creatures.push({ instanceId: card.instanceId, suppliedKnown, suppliedUnits: suppliedKnown ? supply : [], attacks,
      retreat: { costKnown: Number.isSafeInteger(face.currentRetreat) && face.currentRetreat >= 0, cost: face.currentRetreat ?? null } });
  }
  const boards = new Map(creatures.map(row => [row.instanceId, row]));
  const attachmentOptions = [];
  const add = (offer, binding) => {
    if (!offer.sourceCardId || !boards.has(offer.targetId)) return;
    const source = own.get(offer.sourceCardId) ?? offer.sourceCard;
    if (source?.category !== 'energy') return;
    const owned = own.has(offer.sourceCardId), unit = owned ? basic(source) : null;
    const target = [raw.you.active, ...raw.you.bench, raw.opponent.active, ...raw.opponent.bench].find(card => card?.instanceId === offer.targetId);
    attachmentOptions.push({ ...binding, sourceCardId: offer.sourceCardId, targetId: offer.targetId,
      basicUnitKnown: unit !== null && visible.get(offer.targetId)?.energyRules?.basicAttachmentSnapshotKnown === true, basicUnit: unit,
      alreadyAttached: target.publicCards?.energy?.some(card => card.instanceId === offer.sourceCardId) === true });
  };
  for (const offer of raw.actions) add(offer, { actionId: offer.id });
  for (const prompt of raw.prompts) for (const offer of prompt.choices) add(offer, { promptId: prompt.id, choiceId: offer.id });
  return { schema: 'visible-energy-input/1', creatures, attachmentOptions };
}

// Native callers can feed their already-visible cost/supply projection through
// the same class, recomputing payment with the same DLL and excluding legality
// from all after-attachment rows. Does not reconstruct or simulate a board.
export function nativeEnergyInput(facts, { basicUnits = new Map(), attachedEnergyIds = new Map() } = {}) {
  if (facts.schema !== 'model6-energy/1') throw new Error('native-visible-energy-schema-required');
  if (facts.attachmentOptions.some(option => option.known === true && !/^[GRWLPFDMYC]$/.test(basicUnits.get(option.sourceCardId) ?? '')))
    throw new Error('complete-admitted-native-basic-source-units-required');
  const creature = row => ({ instanceId: row.instanceId, suppliedKnown: row.suppliedKnown,
    suppliedUnits: clone(row.suppliedUnits), attacks: row.attacks.map(attack => ({ actionKey: attack.actionKey,
      printedKnown: attack.printedKnown, printedUnits: clone(attack.printedUnits), effectiveKnown: attack.effectiveKnown,
      costAlternatives: attack.effectiveKnown ? attack.alternatives.map(cost => clone(cost.costUnits)) : [],
      attackLegalKnown: attack.attackLegalKnown, attackLegal: attack.attackLegal })),
    retreat: { costKnown: row.retreat.known, cost: row.retreat.cost } });
  const attachmentOptions = facts.attachmentOptions.map(option => ({ sourceCardId: option.sourceCardId, targetId: option.targetId,
    ...(option.actionId ? { actionId: option.actionId } : { promptId: option.promptId, choiceId: option.choiceId }),
    basicUnitKnown: option.known === true && /^[GRWLPFDMYC]$/.test(basicUnits.get(option.sourceCardId) ?? ''),
    basicUnit: basicUnits.get(option.sourceCardId) ?? null,
    alreadyAttached: attachedEnergyIds.get(option.targetId)?.has(option.sourceCardId) === true }));
  return { schema: 'visible-energy-input/1', creatures: facts.creatures.map(creature), attachmentOptions };
}
