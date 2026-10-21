import { AgentBundle } from '../integrations/local-worker/agent-bundle.mjs';
import { AlphaZeroModelClient } from '../integrations/local-worker/alphazero-model.mjs';
import { NativeSearchProvider } from '../integrations/local-worker/native-search-provider.mjs';
import { createSearchEvaluator, runInformationSetSearch } from '../learning/alphazero-search.mjs';
import { hashFile, readJson, verifyFrozenRuntime } from '../environment/frozen-runtime.mjs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export class SearchDistillationAgent extends AgentBundle {
  constructor({ providerFactory, evaluate, knownDecks, searchOptions, searchSeed, ...options }) {
    super(options);
    Object.assign(this, { providerFactory, evaluate, knownDecks, searchOptions, searchSeed });
    this.rootIndex = 0; this.publicHistory = []; this.provider = null; this.providerShutdown = null;
    this.searchCounts = { roots: 0, changedFromPrior: 0, forced: 0, fallbacks: {}, milliseconds: 0 };
  }

  observe(view) {
    const contextual = super.observe(view);
    if (this.publicHistory.at(-1)?.revision !== view.revision) {
      this.publicHistory.push({ revision: view.revision, turnNumber: view.turnNumber, turn: view.turn,
        hand: view.hand.map(card => ({ instanceId: card.instanceId, printingId: card.printingId })),
        usage: contextual.decisionContext.usage });
    }
    if (['finished', 'failed'].includes(view.status)) void this.shutdown();
    return contextual;
  }

  accepted(view, decision) {
    super.accepted(view, decision);
    this.publicHistory.push({ revision: view.revision, turnNumber: view.turnNumber, decision: structuredClone(decision) });
  }

  fallback(view, reason, root = null) {
    this.searchCounts.fallbacks[reason] = (this.searchCounts.fallbacks[reason] ?? 0) + 1;
    if (view.prompts.length) return { source: `alphazero-selector-fallback:${reason}`,
      decisions: this.supportsCardSelection(view)
        ? (async () => this.rankedPromptAnswers(view, await this.selection.rankChoices({ view })))() : null };
    if (!root) throw Error('ordinary fallback requires an actual actor-visible policy evaluation');
    const index = root.logits.indexOf(Math.max(...root.logits));
    return { source: `alphazero-policy-fallback:${reason}`, decisions: [root.commands[index]] };
  }

  async propose(view, { validate } = {}) {
    if (view.status !== 'playing' || !view.prompts.length && view.turn !== 'you')
      return { source: this.route(view), decisions: null };
    let root;
    try { root = await this.evaluate({ view, toPlay: 'human', validate }); }
    catch (error) {
      if (error.code !== 'UNSUPPORTED_SEARCH_DOMAIN') throw error;
      const result = this.fallback(view, error.message); result.decisions = await result.decisions; return result;
    }
    if (root.encoded.legalMask.filter(Boolean).length === 1) {
      this.searchCounts.forced++;
      return { source: 'alphazero-forced', decisions: [root.commands[root.encoded.legalMask.indexOf(true)]] };
    }
    this.provider ??= this.providerFactory();
    const started = performance.now();
    try {
      const result = await runInformationSetSearch({ ...this.searchOptions, provider: this.provider,
        rootView: view, publicHistory: this.publicHistory, knownDecks: this.knownDecks, rootPlayer: 'human',
        seed: (this.searchSeed + Math.imul(++this.rootIndex, 0x9e3779b9)) >>> 0, evaluate: this.evaluate });
      if (!isDeepStrictEqual(result.commands, root.commands) || !isDeepStrictEqual(result.encoded.legalMask, root.encoded.legalMask))
        throw Error('hypothetical root command domain differs from actual observed domain');
      this.searchCounts.roots++;
      if (result.selectedIndex !== root.logits.indexOf(Math.max(...root.logits))) this.searchCounts.changedFromPrior++;
      return { source: 'alphazero-search', decisions: [result.decision], encoded: root.encoded,
        sample: { searchVisits: result.visits, searchPolicy: result.policyTarget,
          selectedIndex: result.selectedIndex, diagnostics: result.diagnostics } };
    } catch (error) {
      if (error.code !== 'UNSUPPORTED_SEARCH_DOMAIN') throw error;
      const result = this.fallback(view, error.message, root); result.decisions = await result.decisions; return result;
    } finally { this.searchCounts.milliseconds += performance.now() - started; }
  }

  async shutdown() {
    if (!this.providerShutdown) {
      const provider = this.provider; this.provider = null;
      this.providerShutdown = provider ? provider.shutdown() : Promise.resolve();
    }
    await this.providerShutdown;
  }
}

export async function openSearchDistillationPlayer({ environmentConfig, runtimeRoot, checkpoint, checkpointSha256,
  selectionClient, catalog, providerOptions, knownDecks, searchOptions = {}, seed = 81729 }) {
  if (![environmentConfig, runtimeRoot, checkpoint].every(value => isAbsolute(value ?? ''))
      || !/^[a-f0-9]{64}$/.test(checkpointSha256 ?? '') || hashFile(checkpoint) !== checkpointSha256)
    throw Error('explicit sealed AlphaZero player configuration required');
  const environment = readJson(environmentConfig); verifyFrozenRuntime(environment);
  const [{ Model6ModelClient }, choices] = await Promise.all([
    'integrations/local-worker/model6-model.mjs', 'integrations/local-worker/card-action-policy.mjs',
  ].map(file => import(pathToFileURL(join(environment.runtimeRoot, file)).href)));
  const model = new AlphaZeroModelClient({ ...environment.ordinary, runtimeRoot, checkpoint,
    modelRoot: dirname(checkpoint), seed, device: 'cpu' });
  const borrowed = selectionClient !== undefined, selection = selectionClient ?? new Model6ModelClient(environment.selection);
  if (catalog !== undefined && !isDeepStrictEqual(catalog, model.catalog)) {
    await model.shutdown(); if (!borrowed) await selection.shutdown(); throw Error('candidate catalog differs from borrowed baseline catalog');
  }
  const options = { determinizations: 2, simulations: 8, maxDepth: 8, cPuct: 1.25, temperature: 0, rootNoise: false, ...searchOptions };
  const pins = Object.freeze({ ordinary: checkpointSha256, selection: environment.agent.selectionSha256,
    catalog: environment.agent.catalogSha256, method: 'alphazero-search-outcome/1',
    approximation: 'declared-deck-information-set-puct/1', searchOptions: options, historyMode: 'complete-game' });
  const games = new Set(); let closed = false;
  return {
    identity: pins,
    async verify() {
      verifyFrozenRuntime(environment);
      if (closed || hashFile(checkpoint) !== checkpointSha256) throw Error('AlphaZero candidate identity changed');
      const verified = await model.verify(); if (!borrowed) await selection.verify();
      return { ...verified, pins };
    },
    newGame({ searchSeed = 81729 } = {}) {
      if (closed || !Number.isSafeInteger(searchSeed) || searchSeed < 0 || searchSeed > 0xffffffff)
        throw Error('open AlphaZero service and independent unsigned search seed required');
      const agent = new SearchDistillationAgent({ providerFactory: () => new NativeSearchProvider(providerOptions),
        evaluate: createSearchEvaluator({ model, catalog: catalog ?? model.catalog }), knownDecks,
        searchOptions: options, searchSeed, ordinary: model, selection, catalog: catalog ?? model.catalog,
        supportsCardSelection: choices.supportsCardSelection, rankedPromptAnswers: choices.rankedPromptAnswers,
        pins, historyMode: 'complete-game', deterministic: options.temperature === 0 });
      games.add(agent); return agent;
    },
    async shutdown() {
      closed = true;
      await Promise.all([...games].map(game => game.shutdown()));
      await model.shutdown(); if (!borrowed) await selection.shutdown();
    },
  };
}
