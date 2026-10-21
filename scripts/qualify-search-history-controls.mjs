import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { preserveBaselinePromptRoutes } from '../agents/search-ablation-player.mjs';

const [inputsFile, output] = process.argv.slice(2);
if (!inputsFile || !output || process.argv.length !== 4 || fs.existsSync(output))
  throw Error('usage: qualify-search-history-controls <private-inputs.json> <fresh-receipt.json>');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = read(inputsFile), environment = read(inputs.environmentConfig);
const [reference, search, choices, features] = await Promise.all([
  import(pathToFileURL(path.join(environment.runtimeRoot, 'integrations/local-worker/agent-bundle.mjs'))),
  import(pathToFileURL(path.join(inputs.runtimeRoot, 'agents/alphazero-agent.mjs'))),
  import(pathToFileURL(path.join(environment.runtimeRoot, 'integrations/local-worker/card-action-policy.mjs'))),
  import(pathToFileURL(path.join(environment.runtimeRoot, 'learning/model6-features.mjs'))),
]);
const catalog = read(environment.ordinary.catalogPath), results = [];
for (const file of inputs.humanJournals) {
  const options = { ordinary: {}, selection: {}, catalog, encode: features.encodeModel6Decision,
    supportsCardSelection: choices.supportsCardSelection, rankedPromptAnswers: choices.rankedPromptAnswers,
    pins: environment.agent, historyMode: 'complete-game', deterministic: true };
  const baseline = new reference.AgentBundle(options);
  const agent = preserveBaselinePromptRoutes(new search.SearchDistillationAgent({ ...options,
    searchSeed: 81729, searchOptions: {}, providerFactory: () => assert.fail('history check must not start native search'),
    evaluate: () => assert.fail('history check must not call a model') }), baseline);
  const offers = new Map(), submissions = new Map(), routes = {};
  let offered = 0, accepted = 0;
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    if (row.type === 'human-visible-after-command') agent.observe(row.presentation);
    if (row.type === 'human-decision-offered') {
      const contextual = agent.observe({ ...row.projectedObservation, decisionContext: undefined });
      assert.deepEqual(contextual.decisionContext, row.projectedObservation.decisionContext);
      const route = baseline.route(contextual);
      assert.equal(agent.route(contextual), route);
      routes[route] = (routes[route] ?? 0) + 1;
      offers.set(row.decisionId, row); offered++;
    }
    if (row.type === 'human-submitted') submissions.set(row.submissionId, row);
    if (row.type === 'decision-result' && row.actor === 'human' && row.acceptance === 'accepted') {
      const submitted = submissions.get(row.submissionId), offer = offers.get(submitted.decisionId);
      agent.accepted(offer.projectedObservation, submitted.selectedSemanticAction); accepted++;
    }
  }
  await agent.shutdown();
  results.push({ sourceSha256: hash(file), offered, accepted, routes, contextAndRouteExact: true });
}
const receipt = { schema: 'search-history-control-qualification/1', completedAtUtc: new Date().toISOString(),
  classification: 'Non-strength retained-context preservation check', inputsSha256: hash(inputsFile),
  scriptSha256: hash(new URL(import.meta.url)), wrapperSha256: hash(new URL('../agents/search-ablation-player.mjs', import.meta.url)),
  referenceBundleSha256: hash(path.join(environment.runtimeRoot, 'integrations/local-worker/agent-bundle.mjs')),
  searchAgentSha256: hash(path.join(inputs.runtimeRoot, 'agents/alphazero-agent.mjs')),
  offered: results.reduce((sum, result) => sum + result.offered, 0),
  accepted: results.reduce((sum, result) => sum + result.accepted, 0), results,
  remaining: 'No native prompt proposal or natural-game smoke performed by this history check.', newGames: 0, modelLoads: 0, fits: 0, promotion: false };
fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
