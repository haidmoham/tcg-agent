const candidateLimit = 128;
// Original strategic preferences for the two pinned decks. These joins come from
// runtime-program-bundle-v1/printing-joins.json; no captured effect code is copied.
const sourceByPrinting = {
    "ASC-142": "me2-5_142", "ASC-155": "me2-5_155", "ASC-16": "me2-5_16", "ASC-196": "me2-5_196",
    "CRI-82": "me4_82", "DRI-180": "sv10_180", "JTG-116": "sv9_116", "JTG-143": "sv9_143",
    "JTG-152": "sv9_152", "JTG-153": "sv9_153", "JTG-97": "sv9_97", "JTG-98": "sv9_98",
    "MEE-10": "mee_10", "MEE-13": "mee_13", "MEE-15": "mee_15", "MEG-114": "me1_114",
    "MEG-119": "me1_119", "MEG-127": "me1_127", "MEG-131": "me1_131", "MEG-88": "me1_88",
    "PFL-14": "me2_14", "PFL-92": "me2_92", "POR-62": "me3_62", "POR-71": "me3_71",
    "POR-76": "me3_76", "POR-81": "me3_81", "POR-84": "me3_84", "SCR-133": "sv7_133",
    "SFA-39": "sv6-5_39", "SSP-170": "sv8_170", "TEF-128": "sv5_128", "TEF-129": "sv5_129",
    "TEF-144": "sv5_144", "TWM-128": "sv6_128", "TWM-129": "sv6_129", "TWM-130": "sv6_130",
    "TWM-165": "sv6_165", "TWM-95": "sv6_95",
};
const knownSources = new Set(Object.values(sourceByPrinting));
const pokemonWeight = {
    sv6_130: 40, sv9_98: 40, sv6_129: 30, sv6_128: 24, sv9_97: 24,
    "me2-5_155": 20, sv9_116: 19, sv6_95: 16, "sv6-5_39": 14,
    "me2-5_142": 12, me3_62: 10, me2_14: 8, sv5_129: 7, sv5_128: 6, "me2-5_16": 4,
};
const energyType = { mee_10: "fire", mee_13: "psychic", mee_15: "darkness" };
const dragonLine = new Set(["sv6_128", "sv6_129", "sv6_130"]);
const mainAttackers = new Set(["sv6_130", "sv9_98"]);
const drawAbilities = new Set([
    "sv6_129/-134723435", "sv9_98/982166169", "me2-5_142/644940326", "sv5_129/762374807",
]);
// Preferences, never damage predictions or native eligibility checks.
const attackWeight = {
    "sv6_130/-1693352082": 100,
    "sv9_98/-1407608621": 100,
    "me2-5_155/536910482": 90,
    "sv9_116/1026892762": 80,
    "me2-5_155/1029953413": 70,
    "sv9_116/-1561547811": 60,
    "sv6_130/-1702269540": 40, // Jet Headbutt
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
    if (source === "sv9_97" || source === "sv9_98")
        return provided.filter(type => type === "darkness").length < 2 ? ["darkness"] : [];
    return [];
}
function cardPriority(card, view) {
    const source = printingSource(card?.printingId);
    const board = ownPokemon(view).map(creatureSource);
    const wanted = wantedEnergy(preferredAttacker(view));
    if (wanted.includes(energyType[source]))
        return 80;
    if ((source === "sv6_129" && board.includes("sv6_128")) ||
        (source === "sv6_130" && board.includes("sv6_129")) ||
        (source === "sv9_98" && board.includes("sv9_97")))
        return 90;
    if (["sv6_128", "sv9_97"].includes(source) && !board.includes(source))
        return 85;
    if (source === "me1_119" && view.hand.length < 5)
        return 75;
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
        if (drawAbilities.has(action.actionKey ?? ""))
            return view.you.deckCount > 3 && view.hand.length < 8 ? 880 : -10;
        if (action.actionKey === "sv6_95/560609541")
            return 870;
        return 350;
    }
    if (action.kind !== "play")
        return -100;
    if (sourceCard?.category === "pokemon") {
        const copies = board.filter(card => creatureSource(card) === source).length;
        const desired = ["sv6_128", "sv6_129", "sv9_97"].includes(source) ? 2 : 1;
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
    if (["sv5_144", "me3_81", "me1_131", "sv8_170"].includes(source))
        return board.some(card => mainAttackers.has(creatureSource(card))) ? 400 : 890;
    if (source === "me1_119")
        return view.hand.length < 5 && view.you.deckCount > 5 ? 885 : -10;
    if (source === "me3_76")
        return view.hand.length < 3 && view.you.deckCount > 5 ? 885 : -10;
    if (["sv7_133", "sv9_153"].includes(source))
        return wantedEnergy(attacker).length > 0 ? 890 : 300;
    if (["sv9_143", "me3_71", "sv9_152"].includes(source))
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
    // A final-count prompt can also request new counters rather than a transfer.
    // Try additions using only offered bounds; native preview determines meaning.
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
        // Mandatory allocations still use the full native count, even after the
        // strategic first pass has covered every visible target's remaining HP.
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
        // A hand-cost preference is based on actual public instance membership, not
        // the English prompt. This chooses expendable cards; native validates intent.
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
export function* livePracticeDecisions(view) {
    if (view.source !== "live-matchlogic" || view.result || view.status === "failed")
        return;
    const prompt = view.prompts[0];
    if (prompt) {
        yield* promptCandidates(prompt, view);
        return;
    }
    // Every value is an existing opaque offer. The caller must natively validate
    // each candidate and dispatch at most one against this exact fresh revision.
    const actions = view.actions.filter(action => action.kind !== "concede")
        .sort((first, second) => actionPriority(second, view) - actionPriority(first, view));
    for (const action of actions.slice(0, candidateLimit))
        yield { actionId: action.id };
}
