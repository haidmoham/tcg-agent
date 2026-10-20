export default {
  schema: 'shadow-policy/1',
  observationSchema: 'shadow-observation/1',
  policyId: 'synthetic-first-candidate/1',
  checkpointId: 'no-trained-weights-synthetic-only',
  supportedProfiles: ['synthetic-duel/1'],
  supportedCards: ['synthetic:creature', 'synthetic:energy'],
  async create() {
    return { decide: input => ({ actionId: input.candidates[0].id, ranking: input.candidates.map(item => item.id) }) };
  },
};
