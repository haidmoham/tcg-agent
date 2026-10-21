import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveBaselinePromptRoutes, proposeWithoutSearch } from '../agents/search-ablation-player.mjs';

test('prior-only control preserves native-validated forced transitions without constructing search', async () => {
  const view = { status: 'playing', turn: 'you', prompts: [{}] };
  const decision = { promptId: 'empty', choiceIds: [] };
  const agent = { evaluate: async () => ({ forcedDecision: decision }),
    providerFactory: () => assert.fail('prior control must never construct a search worker') };
  assert.deepEqual((await proposeWithoutSearch(agent, view)).decisions, [decision]);
});

test('prior-only uses the deployed root scorer and same fallback route for unsupported prompts', async () => {
  const root = { encoded: { legalMask: [true, true] }, commands: [{ actionId: 'a' }, { actionId: 'b' }], logits: [1, 2] };
  const view = { status: 'playing', turn: 'you', prompts: [] };
  const agent = { evaluate: async () => root, fallback: (observed, reason, scored) => {
    assert.equal(observed, view); assert.equal(scored, root);
    return { decisions: [root.commands[1]], source: reason };
  } };
  assert.deepEqual((await proposeWithoutSearch(agent, view)).decisions, [{ actionId: 'b' }]);
  agent.evaluate = async () => { throw Object.assign(Error('unsupported prompt'), { code: 'UNSUPPORTED_SEARCH_DOMAIN' }); };
  agent.fallback = (observed, reason, scored) => {
    assert.equal(scored, undefined); assert.equal(reason, 'unsupported prompt'); return { decisions: Promise.resolve([{ choiceIds: ['ranked'] }]) };
  };
  assert.deepEqual((await proposeWithoutSearch(agent, { ...view, prompts: [{}] })).decisions, [{ choiceIds: ['ranked'] }]);
  agent.evaluate = async () => { throw Error('unexpected encoding failure'); };
  await assert.rejects(proposeWithoutSearch(agent, view), /unexpected encoding failure/);
});

test('initial-search control preserves reference singleton decisions and both observed histories', async () => {
  let acceptedSearch = 0, acceptedBaseline = 0;
  const contextual = { revision: 0, turnNumber: 0 };
  const search = { observe: () => ({ ...contextual, deckKnowledge: {} }), accepted: () => acceptedSearch++,
    propose: async () => 'search-ordinary' };
  const baseline = { observe: () => contextual, accepted: () => acceptedBaseline++, route: view => view.route,
    propose: async view => `baseline-${view.route}` };
  const player = preserveBaselinePromptRoutes(search, baseline);
  player.observe({}); player.accepted({}, {});
  assert.equal(acceptedSearch, 1); assert.equal(acceptedBaseline, 1);
  assert.equal(await player.propose({ route: 'ordinary' }), 'search-ordinary');
  for (const route of ['singleton', 'ranking', 'helper', 'waiting'])
    assert.equal(await player.propose({ route }), `baseline-${route}`);
  baseline.observe = () => ({ revision: 1 });
  assert.throws(() => player.observe({}), /public history differ/);
});
