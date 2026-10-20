import { NativeModelClient } from './learning-model.mjs';
import { encodeOrdinaryDecision } from './learning-features.mjs';

export function nativeShadowPolicy({ executable, seed = 1729, checkpointId, supportedProfiles, supportedCards, project }) {
  if (typeof project !== 'function') throw new Error('an audited actor-observation projector is required');
  return {
    schema: 'shadow-policy/1', observationSchema: 'shadow-observation/1',
    policyId: 'native-ordinary-features/1', checkpointId, supportedProfiles, supportedCards,
    async create({ checkpoint }) {
      const client = new NativeModelClient({ executable, checkpoint, seed, device: 'cpu' });
      try { await client.verify(); }
      catch (error) { await client.shutdown(); throw error; }
      return {
        async decide(input) {
          const view = await project(input);
          encodeOrdinaryDecision(view);
          if (view.actions.length !== input.candidates.length
              || view.actions.some((action, index) => action.id !== input.candidates[index].id)) {
            throw new Error('projected native offers must preserve benchmark candidate identity and order');
          }
          return client.decide({ view });
        },
        close: () => client.shutdown(),
      };
    },
  };
}
