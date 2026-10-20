// Trusted-checkpoint metadata inspection only. No client/controller imports.
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadModel6Bridge } from '../integrations/official-client/model6.mjs';

if (process.argv.length !== 2) throw new Error('usage: node scripts/official-client-model6-ready.mjs');
const root = resolve(import.meta.dirname, '..'), bridge = await loadModel6Bridge(join(root, '.cache/official-client-model6.json'));
const ordinary = new bridge.EntityModelClient(bridge.config), selection = new bridge.SelectionModelClient(bridge.selectionConfig);
try {
  const ppo = await ordinary.verify(), bc = await selection.verify(), manifest = bridge.manifest;
  if (ppo.updateCount !== (manifest.optimizerUpdates ?? manifest.update)
      || manifest.expectedActorArchitecture && (ppo.architecture?.schema !== manifest.expectedActorArchitecture
        || bc.architecture?.schema !== manifest.expectedActorArchitecture)) throw new Error('handoff-update-or-architecture-mismatch');
  const receipt = { schema: 'official-client-model6-readiness/1', loaded: true, policyId: manifest.policyId ?? 'model6-control-ppo-update-004',
    checkpointSha256: ppo.checkpointSha256, optimizerUpdates: ppo.updateCount, architecture: ppo.architecture,
    contractSha256: ppo.contractSha256, featureSchema: bridge.entityFeatureContract.schema,
    cardVocabularySize: ppo.cardVocabularySize, actionVocabularySize: ppo.actionVocabularySize,
    catalogSha256: ppo.catalogSha256, frozenSelectionSha256: ppo.frozenSelectionSha256,
    sourceGuardPassed: true, device: ppo.device, rulesHelperEnabled: false,
    nativeToLiveParity: manifest.nativeToLiveFeatureParity, clientAttached: false, inputEnabled: false,
    clientGames: 0, simulationGames: 0, inferenceRequests: 0, unitTestSuites: 0 };
  await writeFile(join(root, '.cache/model6-readiness.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, architecture: ppo.architecture?.schema }));
} finally { await Promise.allSettled([ordinary.shutdown(), selection.shutdown()]); }
