import { createAgentPultTeacher } from './agentpult-teacher.mjs';

export function createModel5Teacher(catalog) {
  const original = createAgentPultTeacher(catalog);
  const source = printing => catalog.sourceByPrinting[printing?.replace(/-(\d+)$/, (_, number) => `-${Number(number)}`)] ?? '';
  const creatureSource = card => source(card?.printingId) || card?.definitionId || '';
  const key = (printing, name) => catalog.actions[printing]?.[name];
  const dragon = ['TWM-128', 'TWM-129', 'TWM-130'].map(source);
  const dark = ['JTG-97', 'JTG-98'].map(source);
  const developed = new Set([dragon[2], dark[1]]);
  const stages = new Map([[dragon[0], 1], [dragon[1], 2], [dragon[2], 3], [dark[0], 1], [dark[1], 3]]);
  const evolvesFrom = new Map([[dragon[1], dragon[0]], [dragon[2], dragon[1]], [dark[1], dark[0]],
    [source('TEF-129'), source('JTG-120')]]);
  const energy = new Map([['MEE-10', 'fire'], ['MEE-13', 'psychic'], ['MEE-15', 'darkness']]
    .map(([printing, type]) => [source(printing), type]));
  const recon = key('TWM-129', '[Ability] Recon Directive');
  const trade = key('JTG-98', '[Ability] Trade');
  const drawAbilities = new Set([recon, trade, key('ASC-142', '[Ability] Flip the Script'),
    key('TEF-129', '[Ability] Run Away Draw')].filter(Boolean));
  const drawCards = new Set(['MEG-119', 'POR-76'].map(source));
  const searchSources = new Set(['MEG-131', 'TEF-144', 'POR-81', 'POR-62', 'TWM-129', 'ASC-196',
    'SCR-133', 'POR-84'].map(source));
  const board = view => [view.you.active, ...view.you.bench].filter(Boolean);
  const missing = card => {
    if (!Array.isArray(card.providedEnergyTypes)) return null;
    const provided = card.providedEnergyTypes.map(type => type.toLowerCase());
    const species = creatureSource(card);
    if (dragon.includes(species)) return ['fire', 'psychic'].filter(type => !provided.includes(type));
    if (dark.includes(species)) return Array(Math.max(0, 2 - provided.filter(type => type === 'darkness').length)).fill('darkness');
    return null;
  };
  const readiness = card => {
    const needed = missing(card);
    return (stages.get(creatureSource(card)) ?? 0) * 100 + (needed === null ? 0 : (2 - needed.length) * 30)
      + Math.max(0, card.hp - card.damage) / Math.max(1, card.hp);
  };

  function ordinary(view, candidates) {
    const own = board(view), hand = new Map(view.hand.map(card => [card.instanceId, card]));
    const offers = new Map(view.actions.map(action => [action.id, action]));
    const ranks = new Map(candidates.map((decision, index) => [decision.actionId, index]));
    const endIndex = candidates.findIndex(decision => ['attack', 'pass'].includes(offers.get(decision.actionId)?.kind));
    const anchor = endIndex < 0 ? candidates.length : endIndex;
    const ready = own.filter(card => developed.has(creatureSource(card)) && missing(card)?.length === 0)
      .sort((first, second) => readiness(second) - readiness(first));
    const readyBench = ready.filter(card => card.instanceId !== view.you.active?.instanceId);
    const activeReady = ready.some(card => card.instanceId === view.you.active?.instanceId);
    const retreatPayment = view.you.active && !activeReady && readyBench.length
      && !view.actions.some(action => action.kind === 'attack')
      && view.you.active.currentRetreat - view.you.active.providedEnergy === 1;
    const bestEnergyTarget = new Map();
    for (const type of ['fire', 'psychic', 'darkness']) {
      const targets = own.filter(card => missing(card)?.includes(type))
        .sort((first, second) => readiness(second) - readiness(first));
      if (targets.length) bestEnergyTarget.set(type, targets[0].instanceId);
    }
    const energyRanks = candidates.flatMap((decision, index) => {
      const action = offers.get(decision.actionId), card = hand.get(action?.sourceCardId);
      const target = own.find(value => value.instanceId === action?.targetId);
      return action?.kind === 'play' && target && missing(target)?.includes(energy.get(creatureSource(card))) ? [index] : [];
    });
    const energyAnchor = Math.min(anchor, ...energyRanks);
    const priority = decision => {
      const action = offers.get(decision.actionId), initial = -(ranks.get(decision.actionId) ?? candidates.length);
      if (!action) return initial;
      const card = hand.get(action.sourceCardId), species = creatureSource(card);
      const isDraw = action.kind === 'ability' && drawAbilities.has(action.actionKey)
        || action.kind === 'play' && drawCards.has(species);
      if (isDraw && (view.you.deckCount <= 3 || view.hand.length >= 8)) return -candidates.length - 1;
      if (action.kind === 'play' && card?.category === 'pokemon') {
        const target = own.find(value => value.instanceId === action.targetId);
        if (target && evolvesFrom.get(species) === creatureSource(target))
          return Math.max(initial, -anchor + 0.6 + readiness(target) / 10000);
      }
      const type = energy.get(species);
      if (action.kind === 'play' && type) {
        const target = own.find(value => value.instanceId === action.targetId);
        if (retreatPayment && target?.instanceId === view.you.active.instanceId)
          return Math.max(initial, -energyAnchor + 0.7);
        if (target && missing(target)?.includes(type)) {
          const best = bestEnergyTarget.get(type) === target.instanceId;
          return -energyAnchor + (best ? 0.5 : 0.3) + readiness(target) / 10000;
        }
      }
      if (action.kind === 'retreat' && readyBench.length && !activeReady)
        return !action.targetId || readyBench.some(card => card.instanceId === action.targetId)
          ? Math.max(initial, -anchor + 0.8) : -candidates.length;
      return initial;
    };
    return candidates.map((decision, index) => ({ decision, index, score: priority(decision) }))
      .sort((first, second) => second.score - first.score || first.index - second.index).map(item => item.decision);
  }

  function selection(view, candidates) {
    const prompt = view.prompts[0];
    if (prompt.ordered || !['cards', 'pokemon', 'select'].includes(prompt.kind) || !candidates.length) return candidates;
    const own = board(view), hand = new Set(view.hand.map(card => card.instanceId));
    const visible = new Map([...view.hand, ...own, view.opponent.active, ...view.opponent.bench,
      ...view.you.discard, ...view.opponent.discard].filter(Boolean).map(card => [card.instanceId, card]));
    const bench = new Map(view.you.bench.map(card => [card.instanceId, card]));
    const ownPromotion = prompt.kind === 'pokemon' && prompt.min === 1 && prompt.max === 1
      && prompt.choices.length > 0
      && (!view.you.active || view.decisionContext?.originAction?.kind === 'retreat')
      && prompt.choices.every(choice => !choice.sourceCard && !choice.sourceCardId
        && choice.minAmount == null && choice.maxAmount == null && choice.initialAmount == null
        && bench.has(choice.instanceId ?? choice.card?.instanceId));
    if (ownPromotion) {
      const choices = new Map(prompt.choices.map(choice => [choice.id, bench.get(choice.instanceId ?? choice.card?.instanceId)]));
      return candidates.map((decision, index) => {
        const card = decision.choiceIds?.length === 1 ? choices.get(decision.choiceIds[0]) : null;
        const score = card && !decision.cancel ? readiness(card)
          + (developed.has(creatureSource(card)) && missing(card)?.length === 0 ? 10000 : 0) : -Infinity;
        return { decision, index, score };
      }).sort((first, second) => second.score - first.score || first.index - second.index).map(item => item.decision);
    }
    if (prompt.choices.some(choice => choice.sourceCard || choice.sourceCardId)) {
      const bindings = new Map(prompt.choices.map(choice => {
        const moved = choice.sourceCard ?? visible.get(choice.sourceCardId);
        const type = energy.get(creatureSource(moved));
        const destination = own.find(card => card.instanceId === (choice.targetId ?? choice.instanceId ?? choice.card?.instanceId));
        const needed = destination ? missing(destination) : null;
        return [choice.id, type && destination ? { destination, useful: needed?.includes(type) ?? false } : null];
      }));
      if ([...bindings.values()].some(binding => binding === null)) return candidates;
      const preferredCount = candidates[0].choiceIds?.length;
      return candidates.map((decision, index) => {
        const selected = (decision.choiceIds ?? []).map(id => bindings.get(id));
        const score = decision.cancel || selected.length !== preferredCount || selected.some(binding => !binding)
          ? -Infinity : selected.reduce((total, binding) => total
            + (binding.useful ? 1000 + readiness(binding.destination) : 0), 0);
        return { decision, index, score };
      }).sort((first, second) => second.score - first.score || first.index - second.index).map(item => item.decision);
    }
    if (!prompt.context && !view.decisionContext) return candidates;
    const context = view.decisionContext ?? {}, nativeContext = prompt.context ?? {};
    const origin = { ...context.originAction,
      ...(nativeContext.sourceCardId ? { sourceCardId: nativeContext.sourceCardId } : {}),
      ...(nativeContext.actionKey ? { actionKey: nativeContext.actionKey } : {}) };
    const originCard = nativeContext.originCard ?? visible.get(origin.sourceCardId ?? origin.actorId) ?? context.originCard;
    const originSource = creatureSource(originCard) || origin?.actionKey?.split('/')[0];
    const choices = new Map(prompt.choices.map(choice => [choice.id, choice]));
    const choiceCard = choice => visible.get(choice.instanceId ?? choice.card?.instanceId) ?? choice.card;
    const allHand = prompt.choices.length > 0 && prompt.choices.every(choice => hand.has(choiceCard(choice)?.instanceId));
    const discard = allHand && (originSource === source('MEG-131') || origin?.actionKey === trade);
    const search = !allHand && searchSources.has(originSource)
      && prompt.choices.every(choice => choiceCard(choice) && !own.some(card => card.instanceId === choiceCard(choice).instanceId));
    if (!discard && !search) return candidates;
    const need = card => {
      const species = creatureSource(card), held = view.hand.filter(value => value.instanceId !== card.instanceId);
      const heldCount = held.filter(value => creatureSource(value) === species).length;
      const predecessor = evolvesFrom.get(species);
      if (predecessor) {
        const targets = own.filter(value => creatureSource(value) === predecessor);
        if (targets.length > heldCount) return 120 + Math.max(...targets.map(readiness)) / 100;
        if (held.some(value => creatureSource(value) === predecessor) && !heldCount) return 90;
      }
      const type = energy.get(species);
      if (type) {
        const targets = own.filter(value => missing(value)?.includes(type));
        if (targets.length && heldCount === 0) return 110 + Math.max(...targets.map(readiness)) / 100;
        return heldCount ? 10 : 35;
      }
      if ([dragon[0], dark[0]].includes(species)) {
        const line = dragon.includes(species) ? dragon : dark;
        return own.filter(value => line.includes(creatureSource(value))).length + heldCount < 2 ? 100 : 15;
      }
      if (drawCards.has(species)) return view.hand.length < 5 && !heldCount && view.you.deckCount > 5 ? 75 : 15;
      return card.category === 'pokemon' ? 30 : 20;
    };
    const preferredCount = candidates[0].choiceIds?.length;
    const scored = candidates.map((decision, index) => {
      const selected = (decision.choiceIds ?? []).map(id => choices.get(id));
      if (decision.cancel || selected.length !== preferredCount || selected.some(choice => !choiceCard(choice)))
        return { decision, index, score: -Infinity };
      const value = selected.reduce((total, choice) => total + need(choiceCard(choice)), 0);
      return { decision, index, score: discard ? -value : value };
    });
    return scored.sort((first, second) => second.score - first.score || first.index - second.index).map(item => item.decision);
  }

  return function* model5Decisions(view) {
    const candidates = [...original(view)];
    if (!candidates.length) return;
    yield* view.prompts.length ? selection(view, candidates) : ordinary(view, candidates);
  };
}
