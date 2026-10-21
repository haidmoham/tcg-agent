const clone = value => structuredClone(value);
const face = card => card?.instanceId && card?.definitionId
  ? { instanceId: card.instanceId, definitionId: card.definitionId } : null;
const actionKey = action => action?.actionKey ?? '';
const RECON = 'me2-5_159/-134723435';
const RUN_AWAY = 'sv5_129/762374807';
const CRISPIN = 'sv7_133/-1794941515';
const SHUFFLE_SEARCH = new Set(['me1_131/1987503775', 'me3_81/-1324786418',
  'sv5_144/1816903788', 'me2-5_184/1816903788']);

function ownPublicCards(view) {
  const cards = new Map();
  function visit(card) {
    const known = face(card);
    if (!known) return;
    cards.set(known.instanceId, known);
    for (const group of Object.values(card.publicCards ?? {}))
      if (Array.isArray(group)) group.forEach(visit);
  }
  [...(view.hand ?? []), view.you?.active, ...(view.you?.bench ?? []),
    ...(view.you?.discard ?? [])].forEach(visit);
  if (view.stadium?.owner === 'you') visit(view.stadium);
  return cards;
}

function allPublicCards(view) {
  const cards = ownPublicCards(view);
  function visit(card) {
    const known = face(card);
    if (!known) return;
    cards.set(known.instanceId, known);
    for (const group of Object.values(card.publicCards ?? {})) if (Array.isArray(group)) group.forEach(visit);
  }
  [view.opponent?.active, ...(view.opponent?.bench ?? []), ...(view.opponent?.discard ?? []), view.stadium].forEach(visit);
  return cards;
}

/** One instance per actor/game. observe every actor-visible revision; accepted gets the pre-command view. */
export class ActorDeckKnowledgeTracker {
  constructor() { this.reset(); }

  reset() {
    this.matchId = null;
    this.previous = null;
    this.started = false;
    this.known = new Map();
    this.top = [];
    this.bottomBlocks = [];
    this.effect = null;
    this.complete = true;
    this.issues = new Map();
    this.lastRevision = null;
    this.ownNativeBenchOrder = [];
    this.opponentNativeBenchOrder = [];
  }

  issue(code, detail) {
    this.complete = false;
    const previous = this.issues.get(code);
    this.issues.set(code, { code, count: (previous?.count ?? 0) + 1, detail });
  }

  remember(cards) {
    for (const card of cards) {
      const known = face(card);
      if (known) this.known.set(known.instanceId, known);
    }
  }

  clearOrder() { this.top = []; this.bottomBlocks = []; }

  appendBottom(cards, ordered) {
    const unique = [...new Map(cards.map(card => [card.instanceId, card])).values()];
    const moved = new Set(unique.map(card => card.instanceId));
    this.top = this.top.filter(card => !moved.has(card.instanceId));
    this.bottomBlocks = this.bottomBlocks.map(block => ({ ...block,
      cards: block.cards.filter(card => !moved.has(card.instanceId)) })).filter(block => block.cards.length);
    if (unique.length) this.bottomBlocks.push({ ordered, cards: unique });
    this.remember(unique);
  }

  observe(view) {
    if (!view || typeof view !== 'object') throw new TypeError('actor PolicyView required');
    if (this.matchId !== null && view.id !== this.matchId) this.reset();
    this.matchId = view.id;
    if (this.lastRevision === null && view.revision !== 0)
      this.issue('history-started-after-creation', 'First actor observation must be creation revision 0.');
    if (this.lastRevision !== null && view.revision !== this.lastRevision && view.revision !== this.lastRevision + 1)
      this.issue('observation-revision-gap', `${this.lastRevision} -> ${view.revision}`);
    if (this.lastRevision === view.revision) return this.snapshot();
    this.lastRevision = view.revision;
    const updateBenchOrder = (previousOrder, bench) => {
      const visibleIds = (bench ?? []).map(card => card.instanceId).filter(Boolean);
      const visible = new Set(visibleIds);
      const retained = previousOrder.filter(id => visible.has(id));
      return [...retained, ...visibleIds.filter(id => !retained.includes(id))];
    };
    // Native InsertCardEntity appends bench arrivals, including evolved successors and outgoing actives.
    this.ownNativeBenchOrder = updateBenchOrder(this.ownNativeBenchOrder, view.you?.bench);
    this.opponentNativeBenchOrder = updateBenchOrder(this.opponentNativeBenchOrder, view.opponent?.bench);
    if (view.status !== 'playing' && !this.started) {
      this.previous = clone(view);
      return this.snapshot();
    }
    if (!this.started) {
      this.started = true;
    }
    const previous = this.previous;
    const visible = ownPublicCards(view);
    const allVisible = allPublicCards(view);
    // The native SafeOptionCard boundary exposes no opponent hidden cards, prizes or hidden-pending cards.
    const offeredDeckCards = (view.prompts ?? []).flatMap(prompt => (prompt.choices ?? [])
      .flatMap(choice => [face(choice.card), face(choice.sourceCard)]).filter(Boolean))
      .filter(card => !allVisible.has(card.instanceId));
    this.remember(offeredDeckCards);
    const priorVisible = previous ? ownPublicCards(previous) : new Map();
    if (previous?.status === 'playing') {
      const previousDiscard = new Set((previous.opponent?.discard ?? []).map(card => card.instanceId));
      const newOpponentDiscard = (view.opponent?.discard ?? []).filter(card => !previousDiscard.has(card.instanceId));
      const redCards = newOpponentDiscard.filter(card => card.definitionId === 'me4_82');
      const stamps = newOpponentDiscard.filter(card => card.definitionId === 'sv6_165');
      if (redCards.length + stamps.length > 1)
        this.issue('multiple-hand-disruptions-between-observations', 'Observe every revision to retain effect order.');
      if (redCards.length) this.appendBottom((previous.hand ?? []).map(face).filter(Boolean), false);
      if (stamps.length) {
        this.remember((previous.hand ?? []).map(face).filter(Boolean));
        this.clearOrder();
      }
    }
    if (this.effect) {
      const prompts = view.prompts ?? [];
      const promptFaces = prompts.flatMap(prompt => (prompt.choices ?? []).map(choice => face(choice.card))).filter(Boolean);
      if (this.effect.kind === 'recon' && promptFaces.length) {
        this.effect.offered = promptFaces;
        this.remember(promptFaces);
      } else if (['search', 'crispin', 'meowth'].includes(this.effect.kind)) {
        const deckFaces = promptFaces.filter(card => !visible.has(card.instanceId));
        this.remember(deckFaces);
        if (deckFaces.length && this.effect.kind === 'meowth') this.effect.deckPromptSeen = true;
      }
      if (!prompts.length) {
        if (this.effect.kind === 'return') {
          this.remember(this.effect.returning);
          this.clearOrder();
        }
        if (this.effect.kind === 'stamp') {
          this.remember(this.effect.returning);
          this.clearOrder();
        }
        if (this.effect.kind === 'search' || this.effect.kind === 'meowth' && this.effect.deckPromptSeen)
          this.clearOrder();
        if (this.effect.kind === 'crispin' && this.effect.firstSelectionCount !== null) {
          if (this.effect.firstSelectionCount !== 1) this.clearOrder();
        }
        if (this.effect.kind === 'crispin' && this.effect.firstSelectionCount === null)
          this.issue('crispin-selection-not-observed', 'Cannot determine whether the early hand-only path skipped its shuffle.');
        if (this.effect.kind === 'recon' && this.effect.offered && !this.effect.selectionRecorded)
          this.issue('recon-selection-not-observed', 'Top-two prompt was observed without its accepted selection.');
        this.effect = null;
      }
    }
    const disappeared = [...priorVisible.values()].filter(card => !visible.has(card.instanceId));
    for (const card of disappeared) {
      const accountedFor = this.known.has(card.instanceId);
      if (!accountedFor && !(view.prompts ?? []).length && previous?.status === 'playing')
        this.issue('unattributed-own-card-disappearance', card.instanceId + '/' + card.definitionId);
    }
    for (const id of visible.keys()) this.known.delete(id);
    this.top = this.top.filter(card => this.known.has(card.instanceId));
    this.bottomBlocks = this.bottomBlocks.map(block => ({ ...block,
      cards: block.cards.filter(card => this.known.has(card.instanceId)) })).filter(block => block.cards.length);
    if (this.known.size > (view.you?.deckCount ?? Infinity))
      this.issue('known-deck-count-exceeds-deck', `${this.known.size} > ${view.you.deckCount}`);
    this.previous = clone(view);
    return this.snapshot();
  }

  accepted(view, semanticDecision) {
    this.observe(view);
    const decision = semanticDecision?.command ?? semanticDecision;
    if (!decision) throw new TypeError('accepted semantic command required');
    const action = (view.actions ?? []).find(offer => offer.id === decision.actionId);
    if (action) {
      const key = actionKey(action);
      const publicCards = ownPublicCards(view);
      if (key === RECON) this.effect = { kind: 'recon', offered: null, selectionRecorded: false };
      else if (key === RUN_AWAY) {
        const source = [view.you?.active, ...(view.you?.bench ?? [])].find(card => card?.instanceId === action.sourceCardId);
        const ids = new Set();
        function gather(card) {
          if (!card) return;
          ids.add(card.instanceId);
          for (const group of Object.values(card.publicCards ?? {})) if (Array.isArray(group)) group.forEach(gather);
        }
        gather(source);
        this.effect = { kind: 'return', returning: [...ids].map(id => publicCards.get(id)).filter(Boolean) };
      } else if (key === CRISPIN) this.effect = { kind: 'crispin', firstSelectionCount: null };
      else if (SHUFFLE_SEARCH.has(key)) this.effect = { kind: 'search' };
      else if (key === 'sv6_165/541489165' || key === 'me1_119/189200867') this.effect = { kind: 'stamp',
        returning: (view.hand ?? []).filter(card => card.instanceId !== action.sourceCardId).map(face).filter(Boolean) };
      else if (action.kind === 'play' && publicCards.get(action.sourceCardId)?.definitionId === 'me3_62')
        this.effect = { kind: 'meowth', deckPromptSeen: false };
      return this.snapshot();
    }
    const prompt = (view.prompts ?? []).find(offer => offer.id === decision.promptId);
    if (!prompt) {
      this.issue('accepted-command-not-in-view', 'Use the exact pre-command PolicyView and semantic IDs.');
      return this.snapshot();
    }
    const selectedIds = new Set(decision.choiceIds ?? []);
    const selected = (prompt.choices ?? []).filter(choice => selectedIds.has(choice.id));
    if (this.effect?.kind === 'recon') {
      const offered = (prompt.choices ?? []).map(choice => face(choice.card)).filter(Boolean);
      const selectedCards = selected.map(choice => face(choice.card)).filter(Boolean);
      if (offered.length <= 2 && offered.length > 0 && selectedCards.length === 1) {
        this.appendBottom(offered.filter(card => card.instanceId !== selectedCards[0].instanceId), true);
        this.effect.selectionRecorded = true;
      } else this.issue('unrecognized-recon-selection', 'Expected one visible selected card from at most two visible deck cards.');
    }
    if (this.effect?.kind === 'crispin' && this.effect.firstSelectionCount === null)
      this.effect.firstSelectionCount = selected.filter(choice => face(choice.card)).length;
    return this.snapshot();
  }

  snapshot() {
    return clone({ schema: 'actor-deck-knowledge/1', complete: this.complete,
      ownDeck: { knownCards: [...this.known.values()], top: this.top, bottomBlocks: this.bottomBlocks },
      boardLayout: { ownNativeBenchOrder: this.ownNativeBenchOrder,
        opponentNativeBenchOrder: this.opponentNativeBenchOrder },
      diagnostics: [...this.issues.values()] });
  }
}

export const createActorDeckKnowledgeTracker = () => new ActorDeckKnowledgeTracker();
