import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectModel5Runtime } from './model5.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const model6SourceFiles = Object.freeze(['learning/entity_ppo.py', 'learning/entity_ppo_runtime.py',
  'learning/model6_torch.py', 'learning/train_model6.py', 'learning/model6-contract.json', 'learning/model6-features.mjs',
  'learning/entity_torch.py', 'learning/entity-contract.json', 'learning/entity-features.mjs', 'learning/masked_ppo.py',
  'learning/card_action_torch.py', 'integrations/local-worker/entity-ppo-model.mjs',
  'integrations/local-worker/model6-model.mjs', 'integrations/local-worker/model6-policy-view.mjs',
  'integrations/local-worker/policy-view.mjs', 'integrations/local-worker/card-action-policy.mjs']);
export async function loadModel6Bridge(path) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const pilot = manifest.schema === 'official-client-model6/1' && manifest.arm === 'control' && manifest.update === 4;
  const handoff = manifest.schema === 'official-client-model6/2' && /^[a-z0-9-]{1,64}$/.test(manifest.arm ?? '')
    && Number.isSafeInteger(manifest.optimizerUpdates) && manifest.optimizerUpdates > 0
    && manifest.update === manifest.optimizerUpdates && /^[a-f0-9]{64}$/.test(manifest.handoffSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(manifest.checkpointSha256 ?? '') && /^[a-z0-9-]+$/.test(manifest.policyId ?? '');
  if ((!pilot && !handoff) || !isAbsolute(manifest.sourceRoot ?? '') || manifest.stage !== 'post-PPO'
      || model6SourceFiles.some(file => !/^[a-f0-9]{64}$/.test(manifest.sourceSha256?.[file] ?? '')))
    throw new Error('model6-complete-frozen-handoff-required');
  for (const [file, digest] of Object.entries(manifest.sourceSha256)) {
    if (file.includes('..') || isAbsolute(file) || sha(await readFile(join(manifest.sourceRoot, file))) !== digest)
      throw new Error('model6-source-freeze-mismatch:' + file);
  }
  for (const config of [manifest.modelConfig, manifest.selectionConfig]) {
    if (config.device !== 'cpu' || sha(await readFile(config.catalogPath)) !== config.catalogSha256)
      throw new Error('model6-cpu-catalog-required');
  }
  if (sha(await readFile(manifest.modelConfig.checkpoint)) !== manifest.checkpointSha256
      || sha(await readFile(manifest.selectionConfig.checkpoint)) !== manifest.modelConfig.frozenSelectionSha256)
    throw new Error('model6-checkpoint-pin-mismatch');
  for (const [key, file] of Object.entries(manifest.inputFiles))
    if (!isAbsolute(file) || sha(await readFile(file)) !== manifest.inputSha256[key]) throw new Error('model6-input-pin-mismatch:' + key);
  const module = file => import(pathToFileURL(join(manifest.sourceRoot, file)).href);
  const [ppo, bc, projection, features, policies] = await Promise.all([
    module('integrations/local-worker/entity-ppo-model.mjs'), module('integrations/local-worker/model6-model.mjs'),
    module('integrations/local-worker/model6-policy-view.mjs'), module('learning/model6-features.mjs'),
    module('integrations/local-worker/card-action-policy.mjs')]);
  if (features.model6ContractSha256 !== manifest.contractSha256) throw new Error('model6-contract-mismatch');
  return { manifest, config: manifest.modelConfig, selectionConfig: manifest.selectionConfig,
    EntityModelClient: ppo.EntityPpoModelClient, SelectionModelClient: bc.Model6ModelClient, PolicyView: projection.PolicyView,
    entityFeatureContract: features.model6FeatureContract, entityContractSha256: features.model6ContractSha256,
    encodeEntityDecision: features.encodeModel6Decision,
    encodeEntityChoiceDecision: (view, prompt, options) => {
      if (prompt !== view.prompts[0]) throw new Error('model6-first-prompt-required');
      return features.encodeModel6Decision(view, options);
    }, supportsCardSelection: policies.supportsCardSelection, rankedPromptAnswers: policies.rankedPromptAnswers };
}

// Printed facts come from the pinned local card corpus; supply comes from the
// rendered CardInfo energy string. Effective costs, counterfactual payments and
// non-offered legality stay unknown: the Live adapter has no simulator oracle.
export function projectModel6Runtime(observation, sources, revision, mapping) {
  const raw = projectModel5Runtime(observation, sources, revision, mapping);
  const units = text => typeof text === 'string' && /^(?:\{[GRWLPFDMYCN]\})*$/.test(text)
    ? [...text.matchAll(/\{([A-Z])\}/g)].map(match => match[1]) : null;
  const creatures = [];
  for (const owner of ['you', 'opponent']) for (const visible of [...observation.match[owner].active, ...observation.match[owner].bench]) {
    const program = sources.get(visible.source) ?? sources.get(visible.source.replace(/_(?:m?ph)\d*$/, ''));
    if (!program || !Array.isArray(program.useActions)) throw new Error('model6-visible-attack-program-unavailable');
    const suppliedUnits = units(visible.energy);
    creatures.push({ instanceId: visible.instanceId, suppliedKnown: suppliedUnits !== null, suppliedUnits: suppliedUnits ?? [],
      attacks: program.useActions.filter(action => action.actionType === 1).map(action => {
        const printed = units(action.energyCost ?? '');
        const actionKey = mapping.definition(program.cardSourceID) + '/' + action.actionSourceID;
        const offered = raw.actions.some(offer => offer.kind === 'attack' && offer.sourceCardId === visible.instanceId && offer.actionKey === actionKey);
        return { actionKey, printedKnown: printed !== null, printedUnits: printed ?? [], effectiveKnown: false, alternatives: [],
          energyKnown: false, energyPayable: null, attackLegalKnown: offered, attackLegal: offered ? true : null };
      }), retreat: { known: false, cost: null, missing: null, payable: null } });
  }
  raw.energyFacts = { schema: 'model6-energy/1', creatures, attachmentOptions: [] };
  return raw;
}
