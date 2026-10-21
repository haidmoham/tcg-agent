import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export async function proposeWithoutSearch(agent, view, { validate } = {}) {
  if (view.status !== 'playing' || !view.prompts.length && view.turn !== 'you')
    return { source: agent.route(view), decisions: null };
  let root;
  try { root = await agent.evaluate({ view, toPlay: 'human', validate }); }
  catch (error) {
    if (error.code !== 'UNSUPPORTED_SEARCH_DOMAIN') throw error;
    const proposal = agent.fallback(view, error.message);
    proposal.decisions = await proposal.decisions;
    return proposal;
  }
  if (root.forcedDecision) return { source: 'alphazero-forced-empty', decisions: [root.forcedDecision] };
  if (root.encoded.legalMask.filter(Boolean).length === 1)
    return { source: 'alphazero-forced', decisions: [root.commands[root.encoded.legalMask.indexOf(true)]] };
  const proposal = agent.fallback(view, 'policy-only-control', root);
  proposal.decisions = await proposal.decisions;
  return proposal;
}

export function preserveBaselinePromptRoutes(searchAgent, baselineAgent) {
  const observe = searchAgent.observe.bind(searchAgent), accepted = searchAgent.accepted.bind(searchAgent);
  const propose = searchAgent.propose.bind(searchAgent);
  searchAgent.observe = view => {
    const contextual = observe(view), baselineContextual = baselineAgent.observe(view);
    const { deckKnowledge, ...comparable } = contextual;
    if (!isDeepStrictEqual(comparable, baselineContextual)) throw Error('search and reference public history differ');
    return contextual;
  };
  searchAgent.accepted = (view, decision) => { accepted(view, decision); baselineAgent.accepted(view, decision); };
  searchAgent.propose = (view, context) => baselineAgent.route(view) === 'ordinary'
    ? propose(view, context) : baselineAgent.propose(view, context);
  return searchAgent;
}

export async function openSearchAblationPlayer(options) {
  const expected = {
    'initial-baseline-routes-search': 'b91885409acfb5c0e427d86a784f537cc3308292f053128dafc5bce42d813e21',
    'final-deployed-routes-prior': '0dbbf400c5aaabf06340a2e8d6c20a6c099d6128f79485c5caa421c41393fc1d',
  };
  if (!expected[options.ablation] || options.checkpointSha256 !== expected[options.ablation])
    throw Error('exact frozen ablation checkpoint and mode required');
  const { openSearchDistillationPlayer } = await import(pathToFileURL(path.join(options.runtimeRoot, 'agents/alphazero-agent.mjs')));
  const search = await openSearchDistillationPlayer(options);
  let baseline;
  try {
    if (options.ablation === 'initial-baseline-routes-search') {
      const environment = JSON.parse(fs.readFileSync(options.environmentConfig, 'utf8'));
      const { openFirstBaseline } = await import(pathToFileURL(path.join(environment.runtimeRoot, 'agents/first-baseline.mjs')));
      baseline = await openFirstBaseline(environment);
    }
    return {
      async verify() { return { search: await search.verify(), reference: baseline?.verified, ablation: options.ablation }; },
      newGame(gameOptions) {
        const agent = search.newGame(gameOptions);
        if (baseline) return preserveBaselinePromptRoutes(agent, baseline.newGame());
        agent.propose = (view, context) => proposeWithoutSearch(agent, view, context);
        return agent;
      },
      async shutdown() { await Promise.all([search.shutdown(), baseline?.shutdown()]); },
    };
  } catch (error) { await Promise.all([search.shutdown(), baseline?.shutdown()]); throw error; }
}
