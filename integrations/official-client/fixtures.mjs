export function ordinaryFixture(at = 10000) {
  const card = { instanceId: 'fixture-energy', printingId: 'MEE-2', category: 'energy' };
  const active = { instanceId: 'fixture-active', owner: 'you', printingId: 'ASC-160', definitionId: 'synthetic-dragapult',
    hp: 320, damage: 0, providedEnergy: 1, currentRetreat: 1, printedRetreat: 1, conditions: [] };
  const side = { active: null, bench: [], prizes: 6, deckCount: 45, handCount: 1, discard: [] };
  return {
    schema: 'official-client-observation/1', id: 'authored-ordinary-1', capturedAt: at, source: 'fixture',
    window: { id: 1, app: 'synthetic-pokemon-client', visible: true, focused: false }, deckDisplayName: 'AgentPult',
    screen: 'playing', unknowns: [], compatibility: { exactDeckVerified: true, cardsVerified: true },
    policyView: { source: 'live-matchlogic', status: 'playing', revision: 1, turn: 'you', turnNumber: 2,
      hand: [card], you: { ...side, active }, opponent: { ...side, handCount: 4 }, stadium: null,
      actions: [{ id: 'fixture-attach', kind: 'play', sourceCardId: card.instanceId, targetId: active.instanceId }], prompts: [] },
    mappings: [{ actionId: 'fixture-attach', target: { elementId: 'fixture-attach-control', label: 'Attach visible Fire Energy to your active Dragapult ex' },
      expected: { screen: 'playing', revision: 2 } }]
  };
}

export function reportedLobbyFixture(at = 10000) {
  return { schema: 'official-client-observation/1', id: 'reported-agent-pult-lobby', capturedAt: at,
    source: 'fixture', window: { id: 1, app: 'synthetic-pokemon-client', visible: true, focused: false },
    deckDisplayName: 'AgentPult', screen: 'lobby', policyView: null, mappings: [],
    compatibility: { exactDeckVerified: false, cardsVerified: false },
    unknowns: ['current-native-window', 'current-pixels', 'loaded-exact-printings', 'turn', 'hand', 'board', 'legal-candidates', 'prompt', 'target-controls'] };
}
