const actionKinds = new Set(['play', 'attack', 'ability', 'retreat', 'pass', 'concede']);
const promptKinds = new Set(['select', 'confirm', 'cards', 'pokemon', 'prizes', 'order', 'acknowledge', 'allocation', 'unsupported']);
const statuses = new Set(['waiting', 'setup', 'playing', 'finished', 'failed']);
const fail = message => { throw new Error(`Policy view: ${message}`); };
const string = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : fail('invalid string');
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : fail('invalid count');
const boolean = value => typeof value === 'boolean' ? value : fail('invalid boolean');
const list = value => Array.isArray(value) ? value : fail('invalid list');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('invalid object');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const optional = (target, source, key, parse) => {
  if (source[key] != null) target[key] = parse(source[key]);
};

// Each instance belongs to one seat in one game. This is an accidental-disclosure
// boundary for a trusted strategy, not a sandbox for hostile code.
export class PolicyView {
  #aliases = new Map();
  #offers = null;
  #revision = -1;

  project(rawView) {
    this.#offers = null;
    const raw = object(rawView);
    if (raw.source !== 'live-matchlogic' || !statuses.has(raw.status)) fail('unsupported source or status');
    const revision = integer(raw.revision);
    if (revision < this.#revision) fail('revision moved backwards');
    if (!['you', 'opponent'].includes(raw.turn)) fail('invalid turn');
    const aliases = new Map(this.#aliases);
    const visible = new Map();
    const identify = rawId => {
      string(rawId);
      if (!aliases.has(rawId)) aliases.set(rawId, `card-${aliases.size + 1}`);
      visible.set(rawId, aliases.get(rawId));
      return aliases.get(rawId);
    };
    const card = input => {
      object(input);
      return { instanceId: identify(input.instanceId), printingId: string(input.printingId), category: string(input.category) };
    };
    const creature = (input, owner) => {
      if (input === null) return null;
      object(input);
      if (input.owner !== owner) fail('incorrect creature owner');
      const result = { instanceId: identify(input.instanceId), owner,
        printingId: string(input.printingId), definitionId: string(input.definitionId),
        hp: integer(input.hp), damage: integer(input.damage), providedEnergy: integer(input.providedEnergy),
        currentRetreat: integer(input.currentRetreat), printedRetreat: integer(input.printedRetreat),
        conditions: list(input.conditions).map(string) };
      optional(result, input, 'providedEnergyTypes', value => list(value).map(string));
      if (input.publicCards != null) {
        object(input.publicCards);
        result.publicCards = Object.fromEntries(['energy', 'tools', 'evolutions'].map(key => [key, list(input.publicCards[key]).map(card)]));
      }
      return result;
    };
    const side = (input, owner) => {
      object(input);
      return { active: creature(input.active, owner), bench: list(input.bench).map(value => creature(value, owner)),
        prizes: integer(input.prizes), deckCount: integer(input.deckCount), handCount: integer(input.handCount),
        discard: list(input.discard).map(card) };
    };
    const hand = list(raw.hand).map(card);
    const you = side(raw.you, 'you');
    const opponent = side(raw.opponent, 'opponent');
    const stadium = raw.stadium === undefined || raw.stadium === null ? null : card(raw.stadium);
    const offers = { actions: new Map(), prompts: new Map() };
    const token = (kind, index) => `r${revision}/${kind}/${index}`;
    const prompts = list(raw.prompts).map((input, promptIndex) => {
      object(input);
      if (!promptKinds.has(input.kind)) fail('unsupported prompt kind');
      const id = token('prompt', promptIndex);
      const groups = new Map();
      const projectedGroups = list(input.groups).map((group, index) => {
        object(group); string(group.id);
        if (groups.has(group.id)) fail('duplicate group');
        const groupId = `${id}/group/${index}`;
        groups.set(group.id, groupId);
        const min = integer(group.min), max = integer(group.max);
        if (min > max) fail('invalid group bounds');
        return { id: groupId, min, max };
      });
      const choices = new Map();
      const projectedChoices = list(input.choices).map((choice, index) => {
        object(choice); string(choice.id);
        if ([...choices.values()].includes(choice.id)) fail('duplicate choice');
        const choiceId = `${id}/choice/${index}`;
        choices.set(choiceId, choice.id);
        const result = { id: choiceId };
        if (choice.card != null) result.card = card(choice.card);
        if (choice.instanceId != null) {
          string(choice.instanceId);
          if (result.card && choice.card.instanceId !== choice.instanceId) fail('inconsistent choice card');
          if (visible.has(choice.instanceId)) result.instanceId = visible.get(choice.instanceId);
        }
        if (choice.group != null) {
          if (!groups.has(choice.group)) fail('unknown choice group');
          result.group = groups.get(choice.group);
        }
        for (const key of ['minAmount', 'maxAmount', 'initialAmount']) optional(result, choice, key, integer);
        if (result.minAmount !== undefined && result.maxAmount !== undefined && result.minAmount > result.maxAmount) fail('invalid amount bounds');
        return result;
      });
      const min = integer(input.min), max = integer(input.max);
      if (min > max) fail('invalid prompt bounds');
      const result = { id, kind: input.kind, min, max, cancelable: boolean(input.cancelable),
        ordered: boolean(input.ordered), groups: projectedGroups, choices: projectedChoices };
      optional(result, input, 'allocationUnit', integer);
      optional(result, input, 'requiresPreview', boolean);
      if (input.allocationMode != null) {
        if (!['add', 'final'].includes(input.allocationMode)) fail('unsupported allocation mode');
        result.allocationMode = input.allocationMode;
      }
      if (input.revealedCards != null) result.revealedCards = list(input.revealedCards).map(card);
      string(input.id);
      if ([...offers.prompts.values()].some(prompt => prompt.rawId === input.id)) fail('duplicate prompt');
      offers.prompts.set(id, { rawId: input.id, choices });
      return result;
    });
    const visibleDefinitions = new Set([you.active, ...you.bench, opponent.active, ...opponent.bench]
      .filter(Boolean).map(value => value.definitionId));
    const actions = list(raw.actions).map((input, index) => {
      object(input); string(input.id);
      if (!actionKinds.has(input.kind)) fail('unsupported action kind');
      if ([...offers.actions.values()].includes(input.id)) fail('duplicate action');
      const id = token('action', index);
      offers.actions.set(id, input.id);
      const result = { id, kind: input.kind };
      for (const key of ['sourceCardId', 'actorId', 'targetId']) {
        if (input[key] != null) {
          if (!visible.has(input[key])) fail('action references unseen card');
          result[key] = visible.get(input[key]);
        }
      }
      optional(result, input, 'attackName', string);
      if (input.actionKey != null) {
        const key = string(input.actionKey);
        if (visibleDefinitions.has(key.split('/')[0])) result.actionKey = key;
      }
      return result;
    });
    const terminal = raw.status === 'finished' || raw.status === 'failed' || raw.result != null;
    if (terminal) { offers.actions.clear(); offers.prompts.clear(); }
    const result = freeze({ source: raw.source, status: raw.status, result: null, revision,
      turn: raw.turn, turnNumber: integer(raw.turnNumber), hand, you, opponent, stadium,
      actions: terminal ? [] : actions, prompts: terminal ? [] : prompts });
    this.#aliases = aliases;
    this.#revision = revision;
    this.#offers = offers;
    return result;
  }

  resolve(input) {
    const decision = object(input);
    if (!this.#offers) fail('no current offers');
    const allowed = new Set(['actionId', 'promptId', 'choiceIds', 'cancel', 'amounts']);
    if (Object.keys(decision).some(key => !allowed.has(key))) fail('unknown decision field');
    if (decision.actionId !== undefined) {
      if (Object.keys(decision).length !== 1 || !this.#offers.actions.has(decision.actionId)) fail('stale or foreign action');
      return { actionId: this.#offers.actions.get(decision.actionId) };
    }
    const prompt = this.#offers.prompts.get(decision.promptId);
    if (!prompt) fail('stale or foreign prompt');
    const choiceId = id => prompt.choices.has(id) ? prompt.choices.get(id) : fail('stale or foreign choice');
    const ids = list(decision.choiceIds ?? []);
    if (new Set(ids).size !== ids.length) fail('duplicate selected choice');
    const result = { promptId: prompt.rawId, choiceIds: ids.map(choiceId) };
    optional(result, decision, 'cancel', boolean);
    if (decision.amounts !== undefined) {
      const amounts = list(decision.amounts);
      if (new Set(amounts.map(value => value.choiceId)).size !== amounts.length) fail('duplicate amount choice');
      result.amounts = amounts.map(value => {
        object(value);
        if (Object.keys(value).some(key => !['choiceId', 'count'].includes(key))) fail('unknown amount field');
        return { choiceId: choiceId(value.choiceId), count: integer(value.count) };
      });
    }
    return result;
  }
}
