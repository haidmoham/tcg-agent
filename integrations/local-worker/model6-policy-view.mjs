import { PolicyView as Model5PolicyView } from './policy-view.mjs';

const fail = message => { throw new Error(`Model6 Energy view: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('invalid object');
const list = value => Array.isArray(value) ? value : fail('invalid list');
const boolean = value => typeof value === 'boolean' ? value : fail('invalid boolean');
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : fail('invalid count');
const string = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : fail('invalid string');
const units = value => list(value).map(unit => /^(?:[GRWLPFDMYCN]|\*)(?:\|[GRWLPFDMYCN])*$/.test(string(unit)) ? unit : fail('invalid Energy unit'));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export class PolicyView extends Model5PolicyView {
  project(raw) {
    const base = super.project(raw);
    if (raw.energyFacts == null) fail('native Energy facts required');
    const input = object(raw.energyFacts);
    if (input.schema !== 'model6-energy/1') fail('unsupported schema');
    const aliases = new Map();
    const pair = (native, projected) => {
      if (!native || !projected || typeof native !== 'object' || typeof projected !== 'object') return;
      if (native.instanceId != null && projected.instanceId != null) aliases.set(native.instanceId, projected.instanceId);
      for (const key of Object.keys(projected)) {
        if (Array.isArray(projected[key])) projected[key].forEach((value, index) => pair(native[key]?.[index], value));
        else if (projected[key] && typeof projected[key] === 'object') pair(native[key], projected[key]);
      }
    };
    pair(raw, base);
    const boards = new Map([base.you.active, ...base.you.bench, base.opponent.active, ...base.opponent.bench]
      .filter(Boolean).map(card => [card.instanceId, card]));
    const alias = id => aliases.get(string(id)) ?? fail('unadmitted card reference');
    const creature = entry => {
      object(entry);
      const instanceId = alias(entry.instanceId);
      const face = boards.get(instanceId) ?? fail('Energy creature is not on the visible board');
      const suppliedKnown = boolean(entry.suppliedKnown);
      const attacks = list(entry.attacks).map(attack => {
        object(attack);
        const actionKey = string(attack.actionKey);
        if (actionKey.split('/')[0] !== face.definitionId) fail('attack does not belong to visible creature');
        const printedKnown = boolean(attack.printedKnown), effectiveKnown = boolean(attack.effectiveKnown);
        const energyKnown = boolean(attack.energyKnown), attackLegalKnown = boolean(attack.attackLegalKnown);
        if (energyKnown && (!suppliedKnown || !effectiveKnown)) fail('inconsistent Energy known mask');
        return { actionKey, printedKnown, printedUnits: printedKnown ? units(attack.printedUnits) : [], effectiveKnown,
          alternatives: effectiveKnown ? list(attack.alternatives).map(cost => {
            object(cost);
            return { costUnits: units(cost.costUnits), missingUnits: energyKnown ? units(cost.missingUnits) : [],
              payable: energyKnown ? boolean(cost.payable) : null };
          }) : [], energyKnown, energyPayable: energyKnown ? boolean(attack.energyPayable) : null,
          attackLegalKnown, attackLegal: attackLegalKnown ? boolean(attack.attackLegal) : null };
      });
      const retreat = object(entry.retreat), known = boolean(retreat.known);
      if (known && !suppliedKnown) fail('inconsistent retreat known mask');
      return { instanceId, suppliedKnown, suppliedUnits: suppliedKnown ? units(entry.suppliedUnits) : [], attacks,
        retreat: { known, cost: known ? integer(retreat.cost) : null, missing: known ? integer(retreat.missing) : null,
          payable: known ? boolean(retreat.payable) : null } };
    };
    const actions = new Map(raw.actions.map((action, index) => [action.id, base.actions[index]]));
    const prompts = new Map(raw.prompts.map((prompt, index) => [prompt.id, { raw: prompt, projected: base.prompts[index] }]));
    const attachmentOptions = list(input.attachmentOptions).map(option => {
      object(option);
      const sourceCardId = alias(option.sourceCardId), targetId = alias(option.targetId);
      if (!boards.has(targetId)) fail('attachment target is not on the visible board');
      const result = { sourceCardId, targetId, known: boolean(option.known) };
      if (option.actionId != null) {
        const action = actions.get(string(option.actionId));
        if (!action || action.sourceCardId !== sourceCardId || action.targetId !== targetId) fail('attachment action binding changed');
        result.actionId = action.id;
      } else {
        const prompt = prompts.get(string(option.promptId));
        const index = prompt?.raw.choices.findIndex(choice => choice.id === option.choiceId) ?? -1;
        const choice = prompt?.projected?.choices[index];
        if (!choice || choice.sourceCardId !== sourceCardId || choice.targetId !== targetId) fail('attachment choice binding changed');
        result.promptId = prompt.projected.id; result.choiceId = choice.id;
      }
      result.after = result.known ? creature(option.after) : null;
      if (result.after && result.after.instanceId !== targetId) fail('hypothetical target changed');
      if (result.after?.attacks.some(attack => attack.attackLegalKnown)) fail('hypothetical attack legality is not a public fact');
      return result;
    });
    const creatures = list(input.creatures).map(creature);
    if (new Set(creatures.map(card => card.instanceId)).size !== creatures.length || creatures.length !== boards.size)
      fail('complete visible board Energy facts required');
    return freeze({ ...base, energyFacts: { schema: input.schema, creatures, attachmentOptions } });
  }
}
