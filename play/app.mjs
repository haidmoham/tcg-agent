import { promptAnswer } from './prompt-answer.mjs';

const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const inspection = document.querySelector('#inspection');
const state = { catalog: null, game: null, busy: false, source: null, selection: [], amounts: new Map(), preview: null, modelId: null, deck: 1 };

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined && text !== null) result.textContent = String(text);
  if (className) result.className = className;
  return result;
}

function button(text, action, className) {
  const result = node('button', text, className);
  result.type = 'button';
  result.disabled = state.busy;
  result.addEventListener('click', action);
  return result;
}

async function request(path, payload) {
  const response = await fetch(path, payload === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? body.error ?? body.message ?? `Request failed (${response.status})`);
  return body;
}

function accept(body) {
  const previous = state.game;
  state.game = body.game;
  if (state.game && previous?.id !== state.game.id) {
    state.modelId = state.game.model.id;
    state.deck = state.game.humanDeck;
  }
  if (previous?.id !== state.game?.id || previous?.view.revision !== state.game?.view.revision) {
    state.source = null;
    state.selection = [];
    state.amounts.clear();
    state.preview = null;
  }
}

async function perform(path, extra = {}) {
  if (state.busy) return;
  const game = state.game;
  const payload = { requestId: crypto.randomUUID(), ...extra };
  if (path !== '/api/new') Object.assign(payload, { gameId: game.id, revision: game.view.revision });
  state.busy = true;
  notice.textContent = path === '/api/new' ? 'Loading checkpoint and starting the native game…' : 'Waiting for the native rules and opponent…';
  render();
  try {
    const body = await request(path, payload);
    if (path === '/api/preview') state.preview = body;
    else accept(body);
    notice.textContent = path === '/api/preview' ? (body.valid ? 'The native engine accepts this selection.' : body.message ?? 'The native engine does not accept this selection.') : '';
  } catch (error) {
    notice.textContent = error.message;
    try { accept(await request('/api/state')); } catch { notice.textContent += ' State could not be refreshed. Restart the local server if it stopped.'; }
  } finally {
    state.busy = false;
    render();
  }
}

function printingImage(card, large = false) {
  const wrap = node('span', null, `card-face${large ? ' large' : ''}`);
  const image = node('img');
  image.src = `/art/${encodeURIComponent(card.printingId)}.png`;
  image.alt = `${card.name ?? card.printingId} (${card.printingId})`;
  image.loading = large ? 'eager' : 'lazy';
  image.addEventListener('error', () => { image.remove(); wrap.classList.add('missing-art'); });
  wrap.append(image, node('span', card.name ?? card.printingId, 'card-fallback-name'), node('small', card.printingId, 'card-fallback-printing'));
  return wrap;
}

function showCards(title, cards) {
  const content = document.querySelector('#inspection-content');
  content.replaceChildren(node('h2', title));
  if (!cards.length) content.append(node('p', 'This public zone is empty.'));
  const gallery = node('div', null, 'inspection-gallery');
  for (const card of cards) {
    const item = node('section');
    item.append(printingImage(card, true), node('p', `${card.name ?? card.printingId} · ${card.printingId}`));
    if (card.hp !== undefined) item.append(node('p', `${Math.max(0, card.hp - card.damage)} / ${card.hp} HP · ${card.providedEnergy} Energy · ${card.currentRetreat} retreat`));
    if (card.conditions?.length) item.append(node('p', card.conditions.join(', ')));
    for (const [kind, attachments] of Object.entries(card.publicCards ?? {})) {
      if (attachments.length) item.append(node('p', `${kind}: ${attachments.map(value => value.name ?? value.printingId).join(', ')}`));
    }
    gallery.append(item);
  }
  content.append(gallery);
  inspection.showModal();
}

document.querySelector('#close-inspection').addEventListener('click', () => inspection.close());
inspection.addEventListener('click', event => { if (event.target === inspection) inspection.close(); });

function metadata(model) {
  const details = node('details', null, 'model-details');
  details.append(node('summary', `${model.name} · ${model.version}`));
  details.append(node('p', model.objective));
  const list = node('dl', null, 'metadata');
  for (const [label, value] of [
    ['Version', model.version], ['Checkpoint SHA-256', model.sha256],
    ['Training', typeof model.training === 'string' ? model.training : JSON.stringify(model.training)],
    ['Supported decks', Array.isArray(model.decks) ? model.decks.map(value => typeof value === 'string' ? value : value.name ?? value.id).join(' / ') : model.decks],
    ['Mechanics', Array.isArray(model.mechanics) ? model.mechanics.join('; ') : model.mechanics],
  ]) {
    list.append(node('dt', label), node('dd', value ?? 'Not reported'));
  }
  details.append(list);
  return details;
}

function controls() {
  const panel = node('section', null, 'session-controls');
  const modelLabel = node('label', 'Saved checkpoint');
  const models = node('select');
  models.setAttribute('aria-label', 'Saved checkpoint');
  models.disabled = state.busy;
  for (const model of state.catalog.models) {
    const option = node('option', `${model.name} · ${model.version}`);
    option.value = model.id;
    models.append(option);
  }
  models.value = state.modelId;
  models.addEventListener('change', () => { state.modelId = models.value; render(); });
  modelLabel.append(models);
  const deckLabel = node('label', 'Your deck');
  const decks = node('select');
  decks.setAttribute('aria-label', 'Your deck');
  decks.disabled = state.busy;
  for (const deck of state.catalog.decks) {
    const option = node('option', deck.name);
    option.value = String(deck.id);
    decks.append(option);
  }
  decks.value = String(state.deck);
  decks.addEventListener('change', () => { state.deck = Number(decks.value); });
  deckLabel.append(decks);
  panel.append(modelLabel, deckLabel, button(state.game ? 'Restart game' : 'Start game', () => perform('/api/new', { modelId: state.modelId, deck: state.deck }), 'primary'));
  return panel;
}

function visibleCards(view) {
  const values = [view.you.active, ...view.you.bench, view.opponent.active, ...view.opponent.bench, ...view.hand, ...view.you.discard, ...view.opponent.discard, view.stadium].filter(Boolean);
  for (const card of [...values]) values.push(...Object.values(card.publicCards ?? {}).flat());
  return new Map(values.map(card => [card.instanceId, card]));
}

function cardTile(card, owner, bench = false) {
  const tile = node('article', null, `board-card${bench ? ' bench-card' : ''}${state.source === card.instanceId ? ' selected' : ''}`);
  const selectable = owner === 'you' && state.game.view.actions.some(action => (action.sourceCardId ?? action.actorId) === card.instanceId);
  const select = button('', () => {
    if (selectable) { state.source = state.source === card.instanceId ? null : card.instanceId; render(); }
    else showCards(card.name ?? card.printingId, [card]);
  }, 'card-art-button');
  select.setAttribute('aria-label', `${selectable ? 'Choose actions for' : 'Inspect'} ${card.name ?? card.printingId}`);
  select.append(printingImage(card));
  if (selectable) select.classList.add('has-actions');
  tile.append(select);
  const info = node('div', null, 'card-state');
  info.append(node('strong', card.name ?? card.printingId));
  if (card.hp !== undefined) {
    info.append(node('span', `${Math.max(0, card.hp - card.damage)} / ${card.hp} HP`, 'hp'));
    const bar = node('meter');
    bar.min = 0; bar.max = card.hp; bar.value = Math.max(0, card.hp - card.damage);
    bar.setAttribute('aria-label', `${card.name ?? card.printingId} remaining HP`);
    info.append(bar, node('small', `${card.providedEnergy} Energy · ${card.damage} damage`));
  }
  if (card.conditions?.length) info.append(node('small', card.conditions.join(', '), 'conditions'));
  info.append(button('Inspect', () => showCards(card.name ?? card.printingId, [card]), 'inspect-link'));
  tile.append(info);
  return tile;
}

function counters(side, owner) {
  const panel = node('section', null, `player-bar ${owner}`);
  panel.append(node('strong', owner === 'you' ? 'You' : 'Checkpoint opponent'));
  const dl = node('dl', null, 'battle-counters');
  for (const [name, value] of [['Prizes', side.prizes], ['Deck', side.deckCount], ['Hand', side.handCount], ['Discard', side.discard.length]]) {
    const count = node('div');
    const label = node('dt');
    if (name === 'Discard') label.append(button(name, () => showCards(`${owner === 'you' ? 'Your' : 'Opponent'} discard`, side.discard), 'text-button'));
    else label.textContent = name;
    count.append(label, node('dd', value)); dl.append(count);
  }
  panel.append(dl);
  const prizes = node('span', null, 'prize-pips');
  prizes.setAttribute('aria-label', `${side.prizes} face-down prizes`);
  for (let index = 0; index < 6; index++) prizes.append(node('i', null, index < side.prizes ? 'remaining' : 'taken'));
  panel.append(prizes);
  return panel;
}

function bench(side, owner) {
  const rail = node('section', null, `bench-target-rail ${owner}`);
  const heading = node('header');
  heading.append(node('strong', owner === 'you' ? 'Your bench' : 'Opponent bench'), node('small', `${side.bench.length} in play`));
  const row = node('div', null, 'bench-cards');
  for (const card of side.bench) row.append(cardTile(card, owner, true));
  if (!side.bench.length) row.append(node('span', 'Empty bench', 'empty-zone'));
  rail.append(heading, row);
  return rail;
}

function board(view) {
  const table = node('section', null, 'battle arena-board-layout');
  table.setAttribute('aria-label', 'Game board');
  table.append(counters(view.opponent, 'opponent'), bench(view.opponent, 'opponent'));
  const field = node('div', null, 'arena physical-table expanded-bench');
  const hiddenHand = node('div', null, 'hidden-hand');
  hiddenHand.setAttribute('aria-label', `Opponent hand: ${view.opponent.handCount} hidden cards`);
  for (let index = 0; index < Math.min(view.opponent.handCount, 14); index++) {
    const back = node('img'); back.src = '/art/cardback.png'; back.alt = ''; hiddenHand.append(back);
  }
  hiddenHand.append(node('small', `${view.opponent.handCount} hidden cards`));
  field.append(hiddenHand);
  for (const [owner, label] of [['opponent', 'Opponent Active'], ['you', 'Your Active']]) {
    const active = node('section', null, `active-slot ${owner}`);
    active.append(node('h3', label));
    active.append(view[owner].active ? cardTile(view[owner].active, owner) : node('div', 'No Active Pokémon', 'empty-active'));
    field.append(active);
  }
  const middle = node('aside', null, 'table-center');
  middle.append(node('small', `TURN ${view.turnNumber}`), node('strong', view.turn === 'you' ? 'Your turn' : 'Opponent turn'));
  if (view.stadium) middle.append(button(`Stadium · ${view.stadium.name ?? view.stadium.printingId}`, () => showCards('Stadium', [view.stadium]), 'stadium'));
  field.append(middle);
  table.append(field, bench(view.you, 'you'), counters(view.you, 'you'));
  const hand = node('section', null, 'hand-zone');
  hand.append(node('h2', `Your hand · ${view.hand.length}`));
  const cards = node('div', null, 'hand-cards');
  for (const card of view.hand) cards.append(cardTile(card, 'you', true));
  if (!view.hand.length) cards.append(node('p', 'Your hand is empty.'));
  hand.append(cards);
  table.append(hand);
  return table;
}

function actionLabel(action, cards) {
  let label = action.label ?? action.attackName ?? action.kind;
  const source = cards.get(action.sourceCardId ?? action.actorId);
  const target = cards.get(action.targetId);
  if (source && !label.includes(source.name ?? source.printingId)) label = `${source.name ?? source.printingId} · ${label}`;
  if (target) label += ` → ${target.name ?? target.printingId}`;
  return label;
}

function promptDecision(prompt) {
  return promptAnswer(prompt, state.selection, state.amounts);
}

function promptPanel(prompt) {
  const panel = node('section', null, 'prompt-panel');
  panel.append(node('span', 'HUMAN DECISION', 'eyebrow'), node('h2', prompt.message ?? `Choose ${prompt.kind}`));
  panel.append(node('p', prompt.kind === 'allocation'
    ? `Allocate ${prompt.min === prompt.max ? prompt.min : `${prompt.min}-${prompt.max}`} counters. Each counter is ${prompt.allocationUnit ?? 10} damage.${prompt.allocationMode === 'final' ? ' Enter the final counter counts.' : ' Enter counters to add; leave unused targets at zero.'}`
    : `Choose ${prompt.min === prompt.max ? prompt.min : `${prompt.min}-${prompt.max}`} option${prompt.max === 1 ? '' : 's'}.${prompt.ordered ? ' Selection order matters. Click in the desired order; click again to remove.' : ''}`));
  for (const group of prompt.groups) panel.append(node('small', `${group.label ?? 'Group'}: ${group.min}–${group.max} choices`, 'group-rule'));
  if (prompt.revealedCards?.length) panel.append(button(`Inspect ${prompt.revealedCards.length} revealed cards`, () => showCards('Authorized revealed cards', prompt.revealedCards), 'secondary'));
  const options = node('div', null, 'prompt-options');
  for (const [index, choice] of prompt.choices.entries()) {
    const group = prompt.groups.find(value => value.id === choice.group);
    const label = choice.label ?? choice.card?.name ?? choice.card?.printingId ?? `Option ${index + 1}`;
    const option = node('div', null, 'prompt-option');
    if (choice.card) {
      const art = button('', () => showCards(label, [choice.card]), 'choice-art');
      art.setAttribute('aria-label', `Inspect ${label}`); art.append(printingImage(choice.card)); option.append(art);
    }
    if (prompt.kind === 'allocation') {
      const inputLabel = node('label', label);
      const input = node('input'); input.type = 'number'; input.step = '1'; input.min = choice.minAmount ?? 0; input.max = choice.maxAmount ?? 1000;
      input.value = String(state.amounts.get(choice.id) ?? choice.initialAmount ?? choice.minAmount ?? 0); input.disabled = state.busy;
      input.setAttribute('aria-label', `Amount for ${label}`);
      input.addEventListener('input', () => { state.amounts.set(choice.id, Number(input.value)); state.preview = null; });
      inputLabel.append(input); option.append(inputLabel);
    } else {
      const selected = state.selection.indexOf(choice.id);
      const choose = button(`${selected >= 0 ? `${selected + 1}. ` : ''}${label}`, () => {
        if (selected >= 0) state.selection.splice(selected, 1);
        else if (prompt.max === 1 && !prompt.groups.length) state.selection = [choice.id];
        else state.selection.push(choice.id);
        state.preview = null; render();
      }, selected >= 0 ? 'choice selected' : 'choice');
      choose.setAttribute('aria-pressed', String(selected >= 0)); option.append(choose);
    }
    if (group) option.append(node('small', group.label ?? 'Group'));
    options.append(option);
  }
  panel.append(options);
  const tools = node('div', null, 'prompt-tools');
  tools.append(button('Check selection', () => perform('/api/preview', { decision: promptDecision(prompt) }), 'secondary'));
  tools.append(button('Submit selection', () => perform('/api/command', { decision: promptDecision(prompt) }), 'primary'));
  if (prompt.cancelable) tools.append(button('Cancel selection', () => perform('/api/command', { decision: { promptId: prompt.id, choiceIds: [], cancel: true } }), 'secondary'));
  panel.append(tools);
  if (state.preview) panel.append(node('p', state.preview.valid ? 'Native validation passed.' : state.preview.message ?? 'This selection is invalid.', state.preview.valid ? 'validation valid' : 'validation invalid'));
  panel.append(node('small', 'The native engine validates every selection and target.'));
  return panel;
}

function decisions(game) {
  const panel = node('aside', null, 'decision-panel');
  const command = node('section', null, 'command-panel');
  if (game.error || game.view.status === 'failed') {
    command.append(node('span', 'GAME STOPPED', 'eyebrow'), node('h2', 'Restart required'));
    command.append(node('p', game.error ?? 'The native game could not continue.'));
    command.append(button('Start a new game', () => perform('/api/new', { modelId: state.modelId, deck: state.deck }), 'primary'));
  } else if (game.terminal) {
    const winner = game.terminal.winner;
    command.append(node('span', 'GAME FINISHED', 'eyebrow'), node('h2', winner === 'human' ? 'You won' : winner === 'opponent' ? 'Checkpoint wins' : 'Game drawn'));
    command.append(node('p', game.terminal.reason ?? 'Native game outcome'));
    command.append(button('Play again', () => perform('/api/new', { modelId: state.modelId, deck: state.deck }), 'primary'));
  } else if (game.view.prompts.length) command.append(promptPanel(game.view.prompts[0]));
  else {
    command.append(node('span', 'HUMAN DECISION', 'eyebrow'), node('h2', game.view.actions.length ? 'Choose your move' : 'Waiting for the opponent'));
    const cards = visibleCards(game.view);
    if (state.source) command.append(button('Show all legal actions', () => { state.source = null; render(); }, 'secondary'));
    else command.append(node('p', 'Select a card on the table or in your hand to see its actions. Each button names its target.'));
    const actions = node('div', null, 'legal-actions');
    const filtered = game.view.actions.filter(action => !state.source || (action.sourceCardId ?? action.actorId) === state.source);
    for (const action of filtered) actions.append(button(actionLabel(action, cards), () => perform('/api/command', { decision: { actionId: action.id } }), action.kind === 'pass' ? 'secondary' : action.kind === 'concede' ? 'concede' : 'legal-action'));
    if (!filtered.length) actions.append(node('p', 'No legal action is offered for this card.'));
    command.append(actions);
  }
  panel.append(command);
  const roles = node('section', null, 'roles');
  roles.append(node('h3', 'Who makes each decision?'), node('p', 'You choose your actions, setup, and prompts. The checkpoint scores the opponent’s ordinary legal actions. Its frozen helper handles setup and prompts.'));
  roles.append(node('p', `${game.learnedDecisions ?? 0} learned decisions · ${game.helperDecisions ?? 0} helper decisions total`, 'decision-counts'));
  if (!game.terminal && !game.error && game.view.status !== 'failed') roles.append(button('Use helper for my next choice', () => perform('/api/assist'), 'assist'));
  roles.append(node('small', 'Optional assistance advances one human decision and is labeled in the activity log.'));
  panel.append(roles);
  const log = node('details', null, 'activity');
  log.open = true;
  log.append(node('summary', 'Recent activity'));
  const items = node('ol');
  const activity = Array.isArray(game.activity) ? game.activity : game.activity ? [game.activity] : [];
  for (const item of activity.slice(-16)) items.append(node('li', typeof item === 'string' ? item : item.message ?? item.label ?? JSON.stringify(item)));
  if (!activity.length) items.append(node('li', 'Native game started.'));
  log.append(items); panel.append(log);
  return panel;
}

function render() {
  app.setAttribute('aria-busy', String(state.busy));
  app.replaceChildren();
  if (!state.catalog) { app.append(node('p', 'Reading saved checkpoints…', 'loading')); return; }
  app.append(controls());
  const selected = state.catalog.models.find(model => model.id === state.modelId);
  if (state.game) {
    const matchHeader = node('section', null, 'match-heading');
    const deckName = id => state.catalog.decks.find(deck => deck.id === id)?.name ?? 'Unknown deck';
    matchHeader.append(node('span', `${state.game.model.name} · ${state.game.model.version}`, 'model-name'),
      node('span', `You: ${deckName(state.game.humanDeck)} / Model: ${deckName(state.game.modelDeck)}`),
      node('span', `Revision ${state.game.view.revision} · ${state.game.view.status}`, 'revision'));
    app.append(matchHeader);
    const layout = node('div', null, 'battle-layout');
    layout.append(board(state.game.view), decisions(state.game)); app.append(layout);
    app.append(metadata(state.game.model));
  } else {
    const intro = node('section', null, 'welcome');
    intro.append(node('span', 'A SAVED CHECKPOINT, ACROSS THE TABLE', 'eyebrow'), node('h2', 'Take a seat.'), node('p', 'Choose a checkpoint and one of the two supported decks. Your opponent gets the other deck. Opponent hands, deck order, and face-down prizes stay hidden.'), node('p', 'This first checkpoint imitates a frozen heuristic. Its held-out teacher agreement measures imitation, not competitive strength.'));
    app.append(intro);
    if (selected) app.append(metadata(selected));
  }
}

try {
  state.catalog = await request('/api/catalog');
  state.modelId = state.catalog.models[0]?.id;
  if (!state.modelId) throw new Error('No saved checkpoint is configured. See the local launch instructions.');
  state.deck = Number(state.catalog.decks.find(deck => deck.id === 1)?.id ?? state.catalog.decks[0]?.id);
  accept(await request('/api/state'));
  render();
} catch (error) {
  app.setAttribute('aria-busy', 'false');
  app.replaceChildren(node('h2', 'The checkpoint table could not start'), node('p', error.message));
}
