import { verifyFrozenRuntime } from '../environment/frozen-runtime.mjs';
import { AgentBundle } from '../integrations/local-worker/agent-bundle.mjs';
import { EntityPpoModelClient } from '../integrations/local-worker/entity-ppo-model.mjs';
import { Model6ModelClient } from '../integrations/local-worker/model6-model.mjs';
import { encodeModel6Decision } from '../learning/model6-features.mjs';
import { supportsCardSelection, rankedPromptAnswers } from '../integrations/local-worker/card-action-policy.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const firstBaseline = Object.freeze({
  id: 'first-baseline', version: '1', historicalName: 'Model6 update23',
  ordinarySha256: 'c175603c04df29723998efcd02dc7dc18ae9c1c2ad9953fae520adf0e7c515d9',
  selectionSha256: '2b245d6c1d3f91f9cb5d3b6c36663dca717f586581175e7d22588e24f20e6a3d',
  catalogSha256: '65398de4f776573bdb2b9d50e9441d27be5fe109b05d5122be961fb20c245f04',
});
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// Owns model services; each game/seat gets its own history, never its own weights.
export async function openFirstBaseline(config) {
  verifyFrozenRuntime(config);
  for (const [file, expected] of [[config.ordinary.checkpoint, firstBaseline.ordinarySha256],
    [config.selection.checkpoint, firstBaseline.selectionSha256],
    [config.ordinary.catalogPath, firstBaseline.catalogSha256], [config.selection.catalogPath, firstBaseline.catalogSha256]]) {
    if (hash(file) !== expected) throw Error('first-baseline artifact identity mismatch');
  }
  let ordinary, selection;
  try {
    ordinary = new EntityPpoModelClient({ ...config.ordinary, device: 'cpu',
      catalogSha256: firstBaseline.catalogSha256, frozenSelectionSha256: firstBaseline.selectionSha256 });
    selection = new Model6ModelClient({ ...config.selection, device: 'cpu', catalogSha256: firstBaseline.catalogSha256 });
    const verified = await Promise.all([ordinary.verify(), selection.verify()]);
    let closed = false;
    return {
      identity: firstBaseline, verified,
      newGame() {
        if (closed) throw Error('first-baseline services are closed');
        return new AgentBundle({ ordinary, selection, catalog: ordinary.catalog, encode: encodeModel6Decision,
          supportsCardSelection, rankedPromptAnswers, pins: firstBaseline, historyMode: 'complete-game', deterministic: true });
      },
      async shutdown() { closed = true; await Promise.all([ordinary.shutdown(), selection.shutdown()]); },
    };
  } catch (error) {
    await Promise.all([ordinary?.shutdown(), selection?.shutdown()]);
    throw error;
  }
}
