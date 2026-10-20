// The only operation is loading the trusted local checkpoint and pinging its
// metadata. This file cannot attach to or provide input to the official client.
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadModel5Bridge } from '../integrations/official-client/model5.mjs';

if (process.argv.length !== 2) throw new Error('usage: node scripts/official-client-model5-ready.mjs');
const root = resolve(import.meta.dirname, '..');
const bridge = await loadModel5Bridge(join(root, '.cache/official-client-model5.json'));
const model = new bridge.EntityModelClient(bridge.config);
try {
  const info = await model.verify();
  const receipt = { schema: 'official-client-model5-readiness/1', loaded: true, checkpointSha256: bridge.manifest.checkpointSha256,
    sourceRevision: bridge.manifest.sourceRevision, contractSha256: info.contractSha256, featureContract: info.featureContract,
    catalogSha256: info.catalogSha256, architecture: info.architecture, parameters: info.parameters, device: info.device,
    cardVocabularySize: info.cardVocabularySize, actionVocabularySize: info.actionVocabularySize,
    nativeToLiveFeatureParity: 'unknown', clientAttached: false, inputsEnabled: false,
    testsRun: 0, inferenceRequests: 0, simulationGames: 0, clientGames: 0 };
  await writeFile(join(root, '.cache/model5-readiness.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, featureContract: info.schema }));
} finally { await model.shutdown(); }
