// Game-state adaptation and explicitly attributed setup policy. No UI calls.
export function projectRuntimeMatch(observation, sources, revision, { printing = card => card.source, definition = source => source } = {}) {
  const match = observation?.match;
  if (!match || !Number.isSafeInteger(revision) || match.operationProcessing || match.menu) throw new Error('runtime-match-not-settled');
  const program = card => {
    const value = sources.get(card.source) ?? sources.get(card.source.replace(/_(?:m?ph)\d*$/, ''));
    if (!value || value.cardName !== card.name) throw new Error('runtime-visible-card-source-unverified');
    return value;
  };
  const card = input => { program(input); return { instanceId: input.instanceId, printingId: printing(input), category: input.category }; };
  const creature = (input, owner) => {
    const source = program(input);
    const printedRetreat = source.retreatCost ?? 0; // CardSource's serialized int default.
    if (!Array.isArray(input.conditions) || typeof input.energy !== 'string' || !/^(?:\{[^}]+\})*$/.test(input.energy)
        || ![input.hp, input.damage, input.currentRetreat, printedRetreat].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('runtime-creature-fields-unverified');
    return { instanceId: input.instanceId, printingId: printing(input), definitionId: definition(source.cardSourceID), owner,
      hp: input.hp, damage: input.damage, providedEnergy: [...input.energy.matchAll(/\{([^}]+)\}/g)].length,
      currentRetreat: input.currentRetreat, printedRetreat, conditions: input.conditions,
      ...(input.publicCards ? { publicCards: Object.fromEntries(['energy', 'tools', 'evolutions'].map(key => [key, input.publicCards[key].map(card)])) } : {}) };
  };
  const side = (input, owner) => {
    if (input.active.length > 1 || ![input.prizes, input.deckCount, input.handCount].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('runtime-side-fields-unverified');
    return { active: input.active[0] ? creature(input.active[0], owner) : null,
      bench: input.bench.map(value => creature(value, owner)), discard: input.discard.map(card),
      prizes: input.prizes, deckCount: input.deckCount, handCount: input.handCount };
  };
  return { source: 'live-matchlogic', status: match.state === 1 ? 'setup' : 'playing', revision,
    turn: match.isMyTurn ? 'you' : 'opponent', turnNumber: match.turnNumber,
    you: side(match.you, 'you'), opponent: side(match.opponent, 'opponent'), hand: match.you.hand.map(card),
    stadium: [...match.you.stadium, ...match.opponent.stadium][0] ? card([...match.you.stadium, ...match.opponent.stadium][0]) : null,
    actions: match.actions.map(action => ({ ...action, ...(action.actionKey ? { actionKey: definition(action.actionKey.split('/')[0]) + '/' + action.actionKey.split('/').slice(1).join('/') } : {}) })), prompts: [] };
}

export function chooseSetupAction(raw) {
  if (raw.status !== 'setup') throw new Error('setup-helper-requires-setup');
  const placed = raw.actions.filter(action => action.label.startsWith('Place '));
  const preferred = placed.find(action => !raw.you.active && /Dreepy active$/.test(action.label))
    ?? placed.find(action => !raw.you.active && / active$/.test(action.label))
    ?? placed.find(action => /Dreepy bench$/.test(action.label))
    ?? placed.find(action => /Budew bench$/.test(action.label))
    ?? raw.actions.find(action => action.kind === 'pass');
  if (!preferred) throw new Error('setup-helper-no-admitted-action');
  return { actionId: preferred.id, attribution: { kind: 'helper', id: 'official-client-setup-v1', reason: 'setup' } };
}

export function chooseTextPrompt(prompt) {
  if (prompt?.kind !== 'text' || !Array.isArray(prompt.choices) || !prompt.choices.length) throw new Error('unsupported-text-helper-prompt');
  const numeric = prompt.choices.every(choice => /^\d+$/.test(choice.label));
  const known = prompt.choices.every(choice => /^(match_coin_flip_result_(heads|tails)|option[12]_(yes|no)|option_(rock|paper|scissors|heads|tails|first|second)|option[12]_(first|second))$/.test(choice.label));
  if (!known && !numeric) throw new Error('unknown-text-helper-options');
  const choice = numeric ? [...prompt.choices].sort((a, b) => Number(b.label) - Number(a.label))[0]
    : prompt.choices.find(choice => choice.label === 'option1_yes') ?? prompt.choices[0];
  return { choiceId: choice.id, attribution: { kind: 'helper', id: 'official-client-text-v1', reason: 'prompt' } };
}

export function chooseEntityPrompt(prompt) {
  if (prompt?.kind !== 'entities' || !Array.isArray(prompt.groups) || !Number.isInteger(prompt.max)) throw new Error('unsupported-entity-helper-prompt');
  const chosen = [], physical = new Set();
  const priority = name => name === "Lillie's Determination" ? 10 : name === 'Dreepy' ? 9 : name === 'Drakloak' ? 8 : name === 'Dragapult ex' ? 7 : name === 'Crispin' ? 6 : 0;
  for (const group of prompt.groups) {
    const candidates = [...group.choices].sort((a, b) => priority(b.name) - priority(a.name) || a.name.localeCompare(b.name));
    let count = 0;
    for (const choice of candidates) {
      if (count >= group.max || chosen.length >= prompt.max) break;
      if (physical.has(choice.identity)) continue;
      chosen.push(choice.id); physical.add(choice.identity); count++;
    }
    if (count < group.min) throw new Error('entity-helper-group-unsatisfied');
  }
  if (chosen.length < prompt.min) throw new Error('entity-helper-total-unsatisfied');
  return { choiceIds: chosen, attribution: { kind: 'helper', id: 'official-client-entity-v1', reason: 'prompt' } };
}
