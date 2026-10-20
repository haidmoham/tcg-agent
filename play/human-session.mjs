import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PlaySession, humanPresentation } from './session.mjs';
import { DemonstrationJournal, digest, recoverInterrupted, ownRecordsRoot } from './demonstration-records.mjs';

const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const offered = view => view.prompts.length || view.actions.length;
export const humanDecks = [{ id: 0, name: 'Hammerpult · exact cohort 60' }, { id: 1, name: 'Hydrapple · Model6 opponent' }];

// The browser submits a semantic decision plus an immutable observation digest.
// Native authority stays in the inherited worker/resolve/preview boundary.
export class HumanSession extends PlaySession {
  constructor(config) {
    super(config, [{ id: 'model6-pinned', name: 'Model6', version: config.version, sha256: config.checkpointSha256,
      objective: 'Frozen CPU opponent; no training in this interface.', training: 'Completed cohort update; strength unverified.',
      decks: ['Human: exact Hammerpult 60', 'Opponent: exact Hydrapple 60'],
      mechanics: ['Model6 ordinary actions and legal singleton card prompts; frozen selection model for other supported card prompts; attributed helper for remaining setup and prompts.'] }]);
    if (config.schema !== 'hammerpult-human-local/1') fail('Prepared local demonstration configuration required.');
    this.verifyPins();
    this.artAliases = read(config.model.catalogPath).printingAliases;
    if (digest(this.inputs.selected[0]) !== config.deckSha256.learner || digest(this.inputs.selected[1]) !== config.deckSha256.opponent)
      fail('Exact Hammerpult/Hydrapple sixty-card deck identities differ.');
    this.releaseRecords = ownRecordsRoot(config.recordsRoot);
    recoverInterrupted(config.recordsRoot);
    this.runtime = Promise.all(['integrations/local-worker/probe.mjs', 'integrations/local-worker/model6-policy-view.mjs',
      'integrations/local-worker/entity-ppo-model.mjs', 'integrations/local-worker/model6-model.mjs',
      'learning/model6-features.mjs', 'integrations/local-worker/card-action-policy.mjs', 'learning/model5-teacher.mjs']
      .map(name => import(pathToFileURL(path.join(config.runtimeRoot, name)))));
  }

  verifyPins() {
    for (const [relative, sha] of Object.entries(this.config.pins))
      if (digest(fs.readFileSync(path.join(this.config.pinRoot, relative))) !== sha) fail(`Pinned private input changed: ${relative}`, 409);
  }

  state() {
    const result = super.state(), g = this.game;
    if (g) Object.assign(result.game, { observationHash: g.humanOffer?.observationHash, decisionId: g.humanOffer?.decisionId,
      nativePublicLog: (g.frame.views.human.log ?? []).map(entry => String(entry.message ?? '').slice(0, 2048)),
      recording: { status: g.journal.ended ? (g.frame.terminal ? 'completed' : 'interrupted') : 'recording',
        humanDecisions: g.humanDecisions, provenance: g.provenance, gameId: g.id }, publicHistory: g.publicHistory });
    return result;
  }

  async mutate(operation, body) {
    return this.serialized(async () => {
      if (!body || typeof body.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(body.requestId)) fail('A UUID requestId is required.');
      const fingerprint = digest({ operation, body }), previous = this.requests.get(body.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.gameId !== this.game?.id) fail('Request belongs to a different command or game.', 409);
        return operation === 'preview' ? previous.result : this.state();
      }
      let result;
      if (operation === 'new') result = await this.start(body);
      else {
        const g = this.game;
        if (!g || g.id !== body.gameId || g.frame.revision !== body.revision) fail('Stale decision. Refresh the game.', 409);
        if (g.error || g.journal.ended) fail('This game has ended. Start a new game.', 409);
        if (operation === 'interrupt') {
          g.error = 'Game stopped by you. Records retained as interrupted.';
          await this.closeGame('human-stopped'); result = this.state();
        } else {
          if (body.observationHash !== g.humanOffer?.observationHash || body.decisionId !== g.humanOffer?.decisionId)
            fail('This command does not bind the displayed observation. Refresh before submitting.', 409);
          try {
            if (operation === 'preview') {
              result = await this.preview(body.decision);
              g.journal.event('human-preview', { decisionId: g.humanOffer.decisionId, decision: body.decision, ...result });
            } else if (operation === 'command') {
              g.journal.event('submit-boundary', { decisionId: g.humanOffer.decisionId, observationHash: body.observationHash,
                requestId: body.requestId, clientSubmittedAt: typeof body.clientSubmittedAt === 'string' ? body.clientSubmittedAt : null });
              await this.accept('human', body.decision, g.provenance === 'synthetic-smoke' ? 'Synthetic smoke' : 'Human', body.requestId);
              await this.drive(); result = this.state();
            } else fail('Human assistance is disabled in demonstration sessions.', 404);
          } catch (error) {
            if (!error.status) this.stopFailed(error.message);
            throw error;
          }
        }
      }
      this.requests.set(body.requestId, { fingerprint, gameId: this.game?.id, result: operation === 'preview' ? result : null });
      return result;
    });
  }

  async start(body) {
    if (body.deck !== 0 || body.modelId !== this.models[0].id) fail('This table pins Hammerpult for you and Hydrapple for Model6.');
    this.verifyPins();
    const [probe, projection, ppo, selection, features, choices, teacher] = await this.runtime;
    this.modules = { ...probe, PolicyView: projection.PolicyView, ...ppo, ...selection, ...features, ...choices };
    const client = new ppo.EntityPpoModelClient(this.config.model), selectionClient = new selection.Model6ModelClient(this.config.selection);
    let worker;
    try {
      await client.verify(); await selectionClient.verify();
      worker = new probe.LocalWorker(this.config.native, { timeoutMs: 30000 });
      const bundle = { id: this.inputs.manifest.bundleId, cardsHash: this.inputs.pins.get('cardData.json'),
        rulesHash: this.inputs.pins.get('gameData.json'), runtimeHash: this.inputs.pins.get('MatchLogic.dll') };
      const seats = Object.fromEntries(['human', 'opponent'].map((seat, index) => [seat, {
        accountId: `local-${seat}`, name: seat === 'human' ? 'You' : 'Model6', cards: this.inputs.selected[index] }]));
      const seed = Number.parseInt(randomUUID().slice(0, 8), 16);
      const frame = await worker.request('create', { bundle, seats, offline: { seed, projectionCopyMode: this.inputs.copyMode } });
      await this.closeGame('new-game');
      const id = randomUUID(), provenance = this.config.provenance === 'synthetic-smoke' ? 'synthetic-smoke' : 'human';
      const pins = { native: this.config.native, privateInputs: this.config.pins, version: this.config.version,
        checkpointSha256: this.config.checkpointSha256, selectionSha256: this.config.model.frozenSelectionSha256,
        deckSha256: this.config.deckSha256, seed, seatOrder: ['human', 'opponent'],
        featureContract: features.model6FeatureContract, contractSha256: features.model6ContractSha256,
        application: Object.fromEntries(['play/human-session.mjs', 'play/demonstration-records.mjs', 'play/app.mjs', 'play/prompt-answer.mjs',
          'play/session.mjs', 'play/style.css', 'play/index.html', 'scripts/play-checkpoint.mjs', 'scripts/play-human.mjs']
          .map(name => [name, digest(fs.readFileSync(new URL('../' + name, import.meta.url)))])) };
      this.game = { id, model: this.models[0], client, selectionClient, worker, humanDeck: 0, provenance,
        projectors: { human: new projection.PolicyView(), opponent: new projection.PolicyView() },
        contexts: {}, activity: ['Frozen Model6 on CPU. Your submitted choices are retained for later imitation learning.'],
        publicHistory: [], learnedDecisions: 0, helperDecisions: 0, commands: 0, humanDecisions: 0,
        policy: teacher.createModel5Teacher(read(this.config.teacherCatalog)),
        journal: new DemonstrationJournal(this.config.recordsRoot, id, pins, provenance) };
      this.update(frame); await this.drive(); return this.state();
    } catch (error) {
      worker?.close(); await client.shutdown(); await selectionClient.shutdown();
      if (this.game?.client === client) this.stopFailed(error.message);
      throw error;
    }
  }

  update(frame) {
    super.update(frame);
    const g = this.game;
    for (const seat of ['human', 'opponent']) {
      const view = g.views[seat];
      let context = g.contexts[seat];
      if (!context || context.turn !== view.turnNumber) context = g.contexts[seat] = { turn: view.turnNumber,
        originAction: null, originCard: null, usage: Object.fromEntries(['energyPlayed', 'supporterPlayed', 'retreated']
          .map(key => [key, { known: true, value: false }])), entityUsage: {} };
      for (const card of [view.you.active, ...view.you.bench].filter(Boolean))
        context.entityUsage[card.instanceId] ??= { abilityUsed: { known: true, value: false } };
      const { turn, ...decisionContext } = context;
      g.views[seat] = { ...view, decisionContext: structuredClone(decisionContext) };
    }
    g.humanOffer = offered(g.views.human) ? this.captureOffer('human') : null;
    if (frame.terminal) g.journal.end({ winner: frame.terminal.winner, reason: frame.terminal.reason }, 'native-terminal');
  }

  captureOffer(seat) {
    const g = this.game, view = g.views[seat], rawObservation = structuredClone(g.frame.views[seat]);
    // Model actions need attribution, not a second seat's private hand in the human dataset.
    if (seat === 'opponent') {
      const offer = { decisionId: randomUUID(), actor: seat, seat: 1, revision: view.revision,
        observationHash: digest(rawObservation), privateModelObservationRetained: false, eligibleForPpo: false };
      g.journal.event('model-decision-offered', offer); return offer;
    }
    if (Object.hasOwn(rawObservation.opponent, 'hand') || Object.hasOwn(rawObservation.opponent, 'deck'))
      throw new Error('Hidden opponent information in actor projection');
    const prompt = view.prompts[0], candidates = structuredClone(prompt?.choices ?? view.actions);
    let encoded = null, encodingError = null;
    try { encoded = this.modules.encodeModel6Decision(view, { catalog: g.client.catalog }); } catch (error) { encodingError = error.message; }
    const presentation = humanPresentation(view, rawObservation);
    const observationHash = digest({ rawObservation, view, presentation });
    const offer = { decisionId: randomUUID(), actor: seat, seat: seat === 'human' ? 0 : 1,
      revision: view.revision, observationHash, rawObservation, projectedObservation: view,
      playerVisiblePresentation: presentation, encodedInput: encoded, encodingError,
      encodedContract: { schema: this.modules.model6FeatureContract.schema, sha256: this.modules.model6ContractSha256 },
      orderedCandidates: candidates, candidateMask: candidates.map(() => prompt ? null : true),
      maskMeaning: prompt ? 'Choice-level joint legality unknown; native validates the submitted combination.' : 'Native offered legal ordinary actions.',
      promptContext: prompt ?? null, behaviorLogProbability: null, eligibleForPpo: false };
    g.journal.event(seat === 'human' ? 'human-decision-offered' : 'model-decision-offered', offer);
    return offer;
  }

  async accept(seat, decision, attribution, requestId = randomUUID()) {
    const g = this.game, view = g.views[seat], offer = seat === 'human' ? g.humanOffer : this.captureOffer(seat);
    const submissionId = randomUUID();
    let semanticAction = view.actions.find(action => action.id === decision?.actionId) ?? {
      kind: 'prompt-answer', promptId: decision?.promptId ?? null, ordered: view.prompts[0]?.ordered ?? null,
      selectedChoices: (Array.isArray(decision?.choiceIds) ? decision.choiceIds : []).map(id => view.prompts[0]?.choices.find(choice => choice.id === id) ?? { id, unknown: true }),
      amounts: decision?.amounts ?? null, cancel: decision?.cancel ?? false };
    if (seat === 'opponent' && semanticAction.kind === 'prompt-answer') semanticAction = {
      kind: 'prompt-answer', promptKind: view.prompts[0]?.kind, promptId: decision?.promptId,
      choiceIds: decision?.choiceIds ?? [], amounts: decision?.amounts ?? null, cancel: decision?.cancel ?? false };
    g.journal.event(seat === 'human' ? 'human-submitted' : 'model-submitted', { submissionId, requestId,
      decisionId: offer?.decisionId, observationHash: offer?.observationHash, actor: seat, attribution,
      selectedSemanticAction: decision, semanticAction, behaviorSource: seat === 'human' ? g.provenance : attribution,
      behaviorLogProbability: null, eligibleForPpo: false });
    let native, dispatched = false;
    try {
      native = this.resolve(seat, decision);
      if (native.promptId) {
        const check = await g.worker.request('preview', { seat, selection: { ...native, requestId: randomUUID(), expectedRevision: g.frame.revision } });
        if (check.valid !== true) fail('Native rules reject this selection. Your attempt was retained.');
      }
      g.journal.event('decision-resolved', { submissionId, actor: seat, resolvedArguments: native,
        commandRevision: g.frame.revision, commandId: requestId });
      dispatched = true;
      const reply = await g.worker.request('command', { seat, command: { ...native, commandId: requestId, expectedRevision: g.frame.revision } });
      if (reply.receipt?.status === 'rejected') fail('The native engine rejected this action. Your attempt was retained.');
      if (reply.receipt?.status !== 'accepted' || reply.frame?.revision !== g.frame.revision + 1)
        throw new Error('Native command outcome uncertain; no automatic retry');
      const action = view.actions.find(a => a.id === decision.actionId), prompt = view.prompts[0];
      const indices = action ? [view.actions.indexOf(action)] : (decision.choiceIds ?? []).map(id => prompt.choices.findIndex(c => c.id === id));
      g.journal.event('decision-result', { submissionId, actor: seat, acceptance: 'accepted', nativeReceipt: reply.receipt,
        selectedCandidateIndices: indices, resolvedArguments: native,
        rawSemanticLabelComplete: true, imitationLabelEligible: seat === 'human' && g.provenance === 'human',
        currentEncoderLabelEligible: !!offer.encodedInput && !decision.cancel && (!!action || indices.length === 1 && prompt?.min === 1 && prompt?.max === 1 && !prompt.ordered && !decision.amounts),
        behaviorLogProbability: null, eligibleForPpo: false });
      const context = g.contexts[seat];
      if (action) {
        context.originAction = action;
        context.originCard = [view.you.active, ...view.you.bench, ...view.hand, ...view.you.discard].find(c => c?.instanceId === (action.sourceCardId ?? action.actorId)) ?? null;
        if (action.kind === 'retreat') context.usage.retreated.value = true;
        if (action.kind === 'ability' && action.actorId) context.entityUsage[action.actorId] = { abilityUsed: { known: true, value: true } };
        if (action.kind === 'play' && context.originCard?.category === 'energy') context.usage.energyPlayed.value = true;
        const catalog = g.client.catalog, canonical = catalog.printingAliases[context.originCard?.printingId] ?? context.originCard?.printingId;
        const card = catalog.cards[catalog.cardIds[canonical] ?? 0], contract = this.modules.model6FeatureContract;
        const supporter = contract.entityFeatures.indexOf('card.format.supporter') - (contract.entityDimensions - contract.cardFactDimensions);
        if (action.kind === 'play' && card?.facts[supporter] === 1) context.usage.supporterPlayed.value = true;
      }
      g.commands++; if (seat === 'human') g.humanDecisions++;
      if (attribution.startsWith('Model6')) g.learnedDecisions++; else if (seat === 'opponent') g.helperDecisions++;
      // Opponent private prompt choices are never sent to the browser history.
      const presentation = humanPresentation(view, g.frame.views[seat]);
      const displayAction = presentation.actions.find(a => a.id === decision.actionId);
      const label = seat === 'human' ? displayAction?.label ?? action?.kind ?? presentation.prompts[0]?.message ?? prompt?.kind
        : action?.kind ?? 'prompt resolved';
      g.activity.push(`${attribution} · ${label} · revision ${reply.frame.revision}`);
      if (g.activity.length > 80) g.activity.shift();
      g.publicHistory.push({ revision: reply.frame.revision, turn: view.turnNumber, actor: seat,
        action: label, board: null });
      this.update(reply.frame);
      const human = humanPresentation(g.views.human, g.frame.views.human);
      g.publicHistory.at(-1).board = { you: human.you, opponent: human.opponent, stadium: human.stadium };
      g.journal.event('human-visible-after-command', { submissionId, revision: reply.frame.revision, presentation: human });
    } catch (error) {
      g.journal.event('decision-result', { submissionId, actor: seat, acceptance: error.status ? 'rejected' : dispatched ? 'uncertain' : 'not-dispatched',
        resolvedArguments: native ?? null, reason: error.message, rawSemanticLabelComplete: false,
        imitationLabelEligible: false, currentEncoderLabelEligible: false, eligibleForPpo: false });
      throw error;
    }
  }

  async drive() {
    const g = this.game, m = this.modules;
    for (let steps = 0; !g.frame.terminal; steps++) {
      if (steps >= 256 || g.commands >= 2000) throw new Error('Bounded game command limit reached');
      if (offered(g.views.human)) return;
      const view = g.views.opponent, prompt = view.prompts[0];
      if (view.status === 'playing' && !prompt && view.actions.length) {
        await this.accept('opponent', await g.client.decide({ view }), 'Model6 ordinary'); continue;
      }
      let candidates, attribution = 'Frozen helper';
      if (view.status === 'playing' && m.supportsCardSelection(view)) {
        if (prompt.min === 1 && prompt.max === 1 && !prompt.ordered && prompt.choices.every(c => c.minAmount == null && c.maxAmount == null && c.initialAmount == null)) {
          const encoded = m.encodeModel6Decision(view, { catalog: g.client.catalog });
          encoded.selectionCardinality = 1; encoded.legalMask = [];
          for (const choice of prompt.choices) {
            const native = this.resolve('opponent', { promptId: prompt.id, choiceIds: [choice.id] });
            const check = await g.worker.request('preview', { seat: 'opponent', selection: { ...native, requestId: randomUUID(), expectedRevision: g.frame.revision } });
            encoded.legalMask.push(check.valid === true);
          }
          if (!encoded.legalMask.some(Boolean)) throw new Error('No legal opponent singleton selection');
          const [sample] = await g.client.act([encoded], { deterministic: true });
          candidates = [{ promptId: prompt.id, choiceIds: [prompt.choices[sample.actionIndex].id] }]; attribution = 'Model6 singleton';
        } else { candidates = m.rankedPromptAnswers(view, await g.selectionClient.rankChoices({ view })); attribution = 'Frozen selection model'; }
      } else candidates = g.policy(view);
      let accepted = false, count = 0;
      for (const decision of candidates) {
        if (++count > 128) throw new Error('Opponent prompt search limit reached');
        if (decision.promptId) {
          const native = this.resolve('opponent', decision);
          const check = await g.worker.request('preview', { seat: 'opponent', selection: { ...native, requestId: randomUUID(), expectedRevision: g.frame.revision } });
          if (!check.valid) continue;
        }
        await this.accept('opponent', decision, attribution); accepted = true; break;
      }
      if (!accepted) throw new Error('No legal opponent action advances this game');
    }
  }

  stopFailed(reason = 'runtime-error') {
    if (!this.game) return;
    this.game.journal.end(null, reason); this.game.selectionClient.close(); super.stopFailed();
  }
  async closeGame(reason = 'server-stopped') {
    if (!this.game) return;
    this.game.journal.end(null, reason); this.game.worker.close();
    await this.game.selectionClient.shutdown(); await this.game.client.shutdown();
  }
  async close() {
    try { await super.close(); } finally { this.releaseRecords?.(); }
  }
}
