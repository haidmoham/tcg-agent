export function createAgentPultTeacher(catalog) {
  if (!catalog || catalog.schema !== 'agentpult-teacher-catalog/1') throw new Error('verified teacher catalog required');
  const programFor = printing => {
    const value = catalog.sourceByPrinting?.[printing];
    if (typeof value !== 'string' || !value) throw new Error('teacher catalog lacks required printing');
    return value;
  };
  const move = (printing, name) => {
    const value = catalog.actions?.[printing]?.[name];
    if (typeof value !== 'string' || !value) throw new Error('teacher catalog lacks required action');
    return value;
  };
  const candidateLimit = 128;
  const sourceByPrinting = catalog.sourceByPrinting;
  const knownSources = new Set(Object.values(sourceByPrinting));
  const pokemonWeight = {
      [programFor("TWM-130")]: 40, [programFor("JTG-98")]: 40, [programFor("TWM-129")]: 30, [programFor("TWM-128")]: 24, [programFor("JTG-97")]: 24,
      [programFor("ASC-155")]: 20, [programFor("JTG-116")]: 19, [programFor("TWM-95")]: 16, [programFor("SFA-39")]: 14,
      [programFor("ASC-142")]: 12, [programFor("POR-62")]: 10, [programFor("PFL-14")]: 8, [programFor("TEF-129")]: 7, [programFor("TEF-128")]: 6, [programFor("JTG-120")]: 6, [programFor("ASC-16")]: 4,
  };
  const energyType = { [programFor("MEE-10")]: "fire", [programFor("MEE-13")]: "psychic", [programFor("MEE-15")]: "darkness" };
  const dragonLine = new Set([programFor("TWM-128"), programFor("TWM-129"), programFor("TWM-130")]);
  const mainAttackers = new Set([programFor("TWM-130"), programFor("JTG-98")]);
  const drawAbilities = new Set([
      move("TWM-129", "[Ability] Recon Directive"), move("JTG-98", "[Ability] Trade"), move("ASC-142", "[Ability] Flip the Script"), move("TEF-129", "[Ability] Run Away Draw"),
  ]);
  const attackWeight = {
      [move("TWM-130", "Phantom Dive")]: 100,
      [move("JTG-98", "Night Joker")]: 100,
      [move("ASC-155", "Rampaging Thunder")]: 90,
      [move("JTG-116", "Virtuous Flame")]: 80,
      [move("ASC-155", "Shred")]: 70,
      [move("JTG-116", "Powerful Rage")]: 60,
      [move("TWM-130", "Jet Headbutt")]: 40,
  };
  function printingSource(printing) {
      if (!printing)
          return "";
      const normalized = printing.replace(/-(\d+)$/, (_, number) => `-${Number(number)}`);
      return sourceByPrinting[normalized] ?? "";
  }
  function creatureSource(creature) {
      return knownSources.has(creature.definitionId) ? creature.definitionId : printingSource(creature.printingId);
  }
  function ownPokemon(view) {
      return [view.you.active, ...view.you.bench].filter((card) => card !== null);
  }
  function preferredAttacker(view) {
      return [...ownPokemon(view)].sort((first, second) => (pokemonWeight[creatureSource(second)] ?? 0) - (pokemonWeight[creatureSource(first)] ?? 0))[0];
  }
  function wantedEnergy(attacker) {
      if (!attacker)
          return [];
      const source = creatureSource(attacker);
      const provided = (attacker.providedEnergyTypes ?? []).map(type => type.toLowerCase());
      if (dragonLine.has(source))
          return ["fire", "psychic"].filter(type => !provided.includes(type));
      if (source === programFor("JTG-97") || source === programFor("JTG-98"))
          return provided.filter(type => type === "darkness").length < 2 ? ["darkness"] : [];
      return [];
  }
  function cardPriority(card, view) {
      const source = printingSource(card?.printingId);
      const board = ownPokemon(view).map(creatureSource);
      const held = view.hand.filter(value => value.instanceId !== card?.instanceId).map(value => printingSource(value.printingId));
      const boardCount = value => board.filter(item => item === value).length;
      const handCount = value => held.filter(item => item === value).length;
      const missingStageOne = Math.max(0, boardCount(programFor("TWM-128")) - handCount(programFor("TWM-129")));
      const missingStageTwo = Math.max(0, boardCount(programFor("TWM-129")) - handCount(programFor("TWM-130")));
      if (source === programFor("TWM-129")) {
          if (missingStageOne > 0) return 115;
          if (!handCount(source) && handCount(programFor("TWM-128")) > 0) return 95;
          return 20;
      }
      if (source === programFor("TWM-130")) {
          if (missingStageTwo > 0) return 120;
          if (!handCount(source) && (boardCount(programFor("TWM-128")) > 0 || handCount(programFor("TWM-128")) > 0) && handCount(programFor("TWM-129")) > 0) return 110;
          return 20;
      }
      if (source === programFor("TWM-128")) {
          const developedLines = boardCount(programFor("TWM-128")) + boardCount(programFor("TWM-129")) + boardCount(programFor("TWM-130"));
          return developedLines + handCount(source) < 2 ? 100 : 20;
      }
      const wanted = wantedEnergy(preferredAttacker(view));
      if (wanted.includes(energyType[source])) return handCount(source) < 1 ? 90 : 35;
      if (source === programFor("JTG-98") && board.includes(programFor("JTG-97")) && !handCount(source)) return 90;
      if (source === programFor("JTG-97") && !board.includes(source) && !handCount(source)) return 85;
      if (source === programFor("MEG-119") && view.hand.length < 5) return 75;
      return pokemonWeight[source] ?? (source ? 15 : 0);
  }
  function choicePriority(choice, view) {
      const attack = choice.actionKey ? attackWeight[choice.actionKey] : undefined;
      if (attack !== undefined)
          return 200 + attack;
      const instanceId = choice.instanceId ?? choice.card?.instanceId;
      if (instanceId) {
          const target = ownPokemon(view).find(card => card.instanceId === instanceId);
          if (target)
              return pokemonWeight[creatureSource(target)] ?? 0;
      }
      return cardPriority(choice.card, view);
  }
  function actionPriority(action, view) {
      const board = ownPokemon(view);
      const attacker = preferredAttacker(view);
      const sourceCard = view.hand.find(card => card.instanceId === action.sourceCardId);
      const keySource = action.actionKey?.split("/")[0];
      const source = keySource && knownSources.has(keySource) ? keySource : printingSource(sourceCard?.printingId);
      const lowHand = view.hand.length < 5 && view.you.deckCount > 5;
      if (lowHand && action.kind === "play" && source === programFor("MEG-119")) return 1150;
      if (lowHand && action.kind === "ability" && action.actionKey === move("ASC-142", "[Ability] Flip the Script")) return 1120;
      const earlyRefill = lowHand && view.you.prizes > 2 && view.opponent.prizes > 2;
      if (earlyRefill && action.kind === "ability" && action.actionKey === move("TEF-129", "[Ability] Run Away Draw")) return 1100;
      if (earlyRefill && view.hand.length < 4 && action.kind === "play" && source === programFor("POR-62")
          && !view.hand.some(card => printingSource(card.printingId) === programFor("MEG-119"))
          && board.some(card => creatureSource(card) === programFor("TWM-129"))) return 1140;
      if (action.kind === "pass")
          return 0;
      if (action.kind === "attack")
          return 700 + (attackWeight[action.actionKey ?? ""] ?? 10);
      if (action.kind === "retreat") {
          const active = view.you.active;
          return active && attacker && active.instanceId !== attacker.instanceId &&
              mainAttackers.has(creatureSource(attacker)) && wantedEnergy(attacker).length === 0 ? 860 : -10;
      }
      if (action.kind === "ability") {
          if (action.actionKey === move("TWM-129", "[Ability] Recon Directive"))
              return view.you.deckCount > 1 ? 1050 : -10;
          if (drawAbilities.has(action.actionKey ?? ""))
              return view.you.deckCount > 3 && view.hand.length < 8 ? 880 : -10;
          if (action.actionKey === move("TWM-95", "[Ability] Adrena-Brain"))
              return 870;
          return 350;
      }
      if (action.kind !== "play")
          return -100;
      if (sourceCard?.category === "pokemon") {
          const copies = board.filter(card => creatureSource(card) === source).length;
          const desired = [programFor("TWM-128"), programFor("TWM-129"), programFor("JTG-97")].includes(source) ? 2 : 1;
          if (copies >= desired && !mainAttackers.has(source))
              return -10;
          return 950 + (pokemonWeight[source] ?? 0);
      }
      if (energyType[source]) {
          if (action.targetId === attacker?.instanceId && wantedEnergy(attacker).includes(energyType[source]))
              return 920;
          const active = view.you.active;
          if (active && attacker && active.instanceId !== attacker.instanceId &&
              mainAttackers.has(creatureSource(attacker)) && wantedEnergy(attacker).length === 0 &&
              active.providedEnergy < active.currentRetreat && action.targetId === active.instanceId)
              return 900;
          return -10;
      }
      if ([programFor("TEF-144"), programFor("POR-81"), programFor("MEG-131"), programFor("SSP-170")].includes(source))
          return board.some(card => mainAttackers.has(creatureSource(card))) ? 400 : 890;
      if (source === programFor("MEG-119"))
          return view.hand.length < 5 && view.you.deckCount > 5 ? 885 : -10;
      if (source === programFor("POR-76"))
          return view.hand.length < 3 && view.you.deckCount > 5 ? 885 : -10;
      if ([programFor("SCR-133"), programFor("JTG-153")].includes(source))
          return wantedEnergy(attacker).length > 0 ? 890 : 300;
      if ([programFor("JTG-143"), programFor("POR-71"), programFor("JTG-152")].includes(source))
          return 850;
      return 300;
  }
  function* combinations(choices, count, start = 0, selected = []) {
      if (count === 0) {
          yield selected;
          return;
      }
      for (let index = start; index <= choices.length - count; index++)
          yield* combinations(choices, count - 1, index + 1, [...selected, choices[index]]);
  }
  function* transferCandidates(prompt, view) {
      const board = [...ownPokemon(view), view.opponent.active, ...view.opponent.bench]
          .filter((card) => card !== null);
      const sources = prompt.choices.filter(choice => (choice.initialAmount ?? 0) > (choice.minAmount ?? 0))
          .sort((first, second) => (second.initialAmount ?? 0) - (first.initialAmount ?? 0));
      const destinations = prompt.choices.filter(choice => (choice.maxAmount ?? 0) > (choice.initialAmount ?? 0))
          .sort((first, second) => {
          const priority = (choice) => {
              const target = board.find(card => card.instanceId === (choice.instanceId ?? choice.card?.instanceId));
              return target?.owner === "opponent" ? 1000 - (target.hp - target.damage) : 0;
          };
          return priority(second) - priority(first);
      });
      let examined = 0;
      for (const source of sources) {
          for (const destination of destinations) {
              const sourceInstance = source.instanceId ?? source.card?.instanceId;
              const destinationInstance = destination.instanceId ?? destination.card?.instanceId;
              if (source.id === destination.id || (sourceInstance && sourceInstance === destinationInstance))
                  continue;
              const removable = (source.initialAmount ?? 0) - (source.minAmount ?? 0);
              const available = (destination.maxAmount ?? 0) - (destination.initialAmount ?? 0);
              for (let count = Math.min(removable, available); count > 0; count--) {
                  if (++examined >= candidateLimit - 1)
                      return;
                  const amounts = prompt.choices.map(choice => ({ choiceId: choice.id,
                      count: (choice.initialAmount ?? 0) + (choice.id === destination.id ? count : choice.id === source.id ? -count : 0) }));
                  yield { promptId: prompt.id, choiceIds: [], amounts };
              }
          }
      }
      const additionLimit = Math.min(prompt.max, destinations.reduce((total, choice) => total + (choice.maxAmount ?? 0) - (choice.initialAmount ?? 0), 0));
      for (let total = additionLimit; total > 0; total--) {
          for (let offset = 0; offset < destinations.length; offset++) {
              if (++examined >= candidateLimit - 1)
                  return;
              let remaining = total;
              const additions = new Map();
              const ordered = [...destinations.slice(offset), ...destinations.slice(0, offset)];
              for (const choice of ordered) {
                  const count = Math.min(remaining, (choice.maxAmount ?? 0) - (choice.initialAmount ?? 0));
                  if (count > 0) {
                      additions.set(choice.id, count);
                      remaining -= count;
                  }
              }
              if (remaining === 0)
                  yield { promptId: prompt.id, choiceIds: [], amounts: prompt.choices.map(choice => ({
                          choiceId: choice.id, count: (choice.initialAmount ?? 0) + (additions.get(choice.id) ?? 0),
                      })) };
          }
      }
      yield { promptId: prompt.id, choiceIds: [], amounts: prompt.choices.map(choice => ({
              choiceId: choice.id, count: choice.initialAmount ?? 0,
          })) };
  }
  function* allocationCandidates(prompt, view) {
      const targets = [view.opponent.active, ...view.opponent.bench].filter((card) => card !== null);
      const choices = [...prompt.choices].sort((first, second) => {
          const firstTarget = targets.find(card => card.instanceId === (first.instanceId ?? first.card?.instanceId));
          const secondTarget = targets.find(card => card.instanceId === (second.instanceId ?? second.card?.instanceId));
          return (firstTarget ? firstTarget.hp - firstTarget.damage : Infinity) -
              (secondTarget ? secondTarget.hp - secondTarget.damage : Infinity);
      });
      for (let offset = 0; offset < Math.max(choices.length, 1) && offset < candidateLimit - 1; offset++) {
          let remaining = prompt.min;
          const ordered = [...choices.slice(offset), ...choices.slice(0, offset)];
          const selected = new Map();
          for (const choice of ordered) {
              const target = targets.find(card => card.instanceId === (choice.instanceId ?? choice.card?.instanceId));
              const unit = prompt.allocationUnit;
              const preferred = target && unit && unit > 0
                  ? Math.max(1, Math.ceil((target.hp - target.damage) / unit)) : remaining;
              const count = Math.min(remaining, choice.maxAmount ?? 0, preferred);
              if (count > 0) {
                  selected.set(choice.id, count);
                  remaining -= count;
              }
          }
          for (const choice of ordered) {
              const current = selected.get(choice.id) ?? 0;
              const count = Math.min(remaining, Math.max(0, (choice.maxAmount ?? 0) - current));
              if (count > 0) {
                  selected.set(choice.id, current + count);
                  remaining -= count;
              }
          }
          const amounts = [...selected].map(([choiceId, count]) => ({ choiceId, count }));
          if (remaining === 0)
              yield { promptId: prompt.id, choiceIds: [], amounts };
      }
  }
  function* promptCandidates(prompt, view) {
      if (prompt.kind === "unsupported")
          return;
      if (prompt.kind === "allocation" && prompt.allocationMode === "final")
          yield* transferCandidates(prompt, view);
      else if (prompt.kind === "allocation")
          yield* allocationCandidates(prompt, view);
      else {
          const handCost = prompt.kind === "cards" && !prompt.ordered && prompt.choices.length > 0 &&
              prompt.choices.every(choice => choice.card && view.hand.some(card => card.instanceId === choice.card.instanceId));
          const choices = [...prompt.choices].sort((first, second) => (handCost ? -1 : 1) * (choicePriority(second, view) - choicePriority(first, view)));
          const preferred = handCost ? prompt.min : Math.min(prompt.max, choices.length, prompt.ordered ? 3 : prompt.max);
          let examined = 0;
          candidateCounts: for (let count = preferred; count >= prompt.min; count--) {
              for (const selected of combinations(choices, count)) {
                  if (++examined >= candidateLimit)
                      break candidateCounts;
                  const groupsValid = prompt.groups.every(group => {
                      const size = selected.filter(choice => choice.group === group.id).length;
                      return size >= group.min && size <= group.max;
                  });
                  if (groupsValid)
                      yield { promptId: prompt.id, choiceIds: selected.map(choice => choice.id) };
              }
          }
      }
      if (prompt.cancelable)
          yield { promptId: prompt.id, choiceIds: [], cancel: true };
  }
  function* livePracticeDecisions(view) {
      if (view.source !== "live-matchlogic" || view.result || view.status === "failed")
          return;
      const prompt = view.prompts[0];
      if (prompt) {
          yield* promptCandidates(prompt, view);
          return;
      }
      const actions = view.actions.filter(action => action.kind !== "concede")
          .sort((first, second) => actionPriority(second, view) - actionPriority(first, view));
      for (const action of actions.slice(0, candidateLimit))
          yield { actionId: action.id };
  }
  return livePracticeDecisions;
}
