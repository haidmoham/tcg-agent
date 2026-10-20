import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { LocalWorker, verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = value => typeof value === 'string' ? value.slice(0, 2048) : '';
const ordinary = view => view.status === 'playing' && view.turn === 'you' && !view.prompts.length && view.actions.length;
export const decks = [{ id: 0, name: 'Dragapult ex' }, { id: 1, name: "N’s Zoroark ex" }];

export function modelCatalog(config) {
  if (!Array.isArray(config.models) || !config.models.length) fail('Configure at least one saved checkpoint.');
  return config.models.map(entry => {
    const receipt = json(entry.receipt);
    const sha256 = hash(readFileSync(entry.model.checkpoint));
    if (sha256 !== receipt.training?.checkpointSha256 || receipt.featureSchema !== 'native-ordinary-features/1') fail('Checkpoint differs from its training receipt.');
    return { id: entry.id, name: entry.name, version: entry.version, sha256,
      objective: receipt.runtime.objective, parameters: receipt.runtime.parameters,
      training: { labels: receipt.training.records, updates: receipt.training.updates, heldoutDecisions: receipt.heldout.records, teacherAgreement: receipt.heldout.teacherAgreement },
      decks: ["Trained on Dragapult ex; native runtime also admits N's Zoroark ex. Playing the model with N's Zoroark ex is outside its training deck."],
      mechanics: ['Private pinned two-deck native profile only; full Standard support is unverified.', 'Learned ordinary legal actions. Frozen helper controls opponent setup and every prompt.', 'Human controls own setup, prompts, actions and targets. Optional one-step assistance is labeled.'],
    };
  });
}

export function humanPresentation(view, raw) {
  const out = structuredClone(view);
  const card = (safe, original) => {
    if (!safe || !original) return;
    safe.name = text(original.name);
    if (safe.publicCards) for (const key of ['energy', 'tools', 'evolutions']) safe.publicCards[key].forEach((value, i) => card(value, original.publicCards?.[key]?.[i]));
  };
  out.hand.forEach((value, i) => card(value, raw.hand[i]));
  for (const side of ['you', 'opponent']) {
    card(out[side].active, raw[side].active);
    out[side].bench.forEach((value, i) => card(value, raw[side].bench[i]));
    out[side].discard.forEach((value, i) => card(value, raw[side].discard[i]));
  }
  card(out.stadium, raw.stadium);
  out.actions.forEach((value, i) => { value.label = text(raw.actions[i].label); });
  out.prompts.forEach((prompt, i) => {
    const original = raw.prompts[i];
    prompt.message = [text(original.title), text(original.detail)].filter(Boolean).join(' · ');
    prompt.choices.forEach((choice, j) => { choice.label = text(original.choices[j].label); card(choice.card, original.choices[j].card); });
    prompt.groups.forEach((group, j) => { group.label = text(original.groups[j].label); });
    prompt.revealedCards?.forEach((value, j) => card(value, original.revealedCards[j]));
  });
  return out;
}

export class PlaySession {
  constructor(config) {
    this.config = config;
    this.inputs = verifyLocalInputs(config.native);
    this.models = modelCatalog(config);
    this.game = null;
    this.queue = Promise.resolve();
    this.requests = new Map();
  }

  serialized(action) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  state() {
    const g = this.game;
    if (!g) return { game: null };
    return { game: { id: g.id, model: g.model, view: humanPresentation(g.views.human, g.frame.views.human),
      terminal: g.frame.terminal ? { winner: g.frame.terminal.winner, reason: text(g.frame.terminal.reason) } : null,
      activity: g.activity.slice(-80), learnedDecisions: g.learnedDecisions, helperDecisions: g.helperDecisions,
      error: g.error ?? null, humanDeck: g.humanDeck, modelDeck: 1 - g.humanDeck } };
  }

  async mutate(operation, body) {
    return this.serialized(async () => {
      if (!body || typeof body.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(body.requestId)) fail('A UUID requestId is required.');
      const fingerprint = hash(JSON.stringify({ operation, body }));
      const previous = this.requests.get(body.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.gameId !== this.game?.id) fail('Request already belongs to another command or game.', 409);
        return operation === 'preview' ? previous.result : this.state();
      }
      let result;
      if (operation === 'new') result = await this.start(body);
      else {
        const g = this.game;
        if (!g || g.id !== body.gameId || g.frame.revision !== body.revision) fail('This choice is stale. Refresh the current game.', 409);
        if (g.error || g.frame.terminal) fail('This game has ended. Start a new game.', 409);
        if (operation === 'preview') {
          try { result = await this.preview(body.decision); }
          catch (error) { if (!error.status) this.stopFailed(); throw error; }
        }
        else if (operation === 'command' || operation === 'assist') {
          try {
            if (operation === 'assist') {
              if (!await this.helper('human', 'Human helper assistance')) fail('No human helper choice is available.', 409);
            } else await this.accept('human', body.decision, 'Human');
            await this.drive();
            result = this.state();
          } catch (error) {
            if (!error.status) this.stopFailed();
            throw error;
          }
        } else fail('Unknown operation.', 404);
      }
      this.requests.set(body.requestId, { fingerprint, gameId: this.game?.id, result: operation === 'preview' ? result : null });
      if (this.requests.size > 4096) this.requests.delete(this.requests.keys().next().value);
      return result;
    });
  }

  async start(body) {
    const model = this.models.find(value => value.id === body.modelId);
    if (!model || ![0, 1].includes(body.deck)) fail('Choose an available checkpoint and deck.');
    const entry = this.config.models.find(value => value.id === model.id);
    if (hash(readFileSync(entry.model.checkpoint)) !== model.sha256) fail('Checkpoint changed. Restart the interface to reload its catalog.', 409);
    const policy = (await import(pathToFileURL(this.inputs.decisions))).livePracticeDecisions;
    const client = new NativeModelClient({ ...entry.model, device: 'cpu' });
    let worker;
    try {
      const info = await client.verify();
      if (info.objective !== model.objective || info.parameters !== model.parameters) fail('Loaded checkpoint metadata differs from receipt.');
      worker = new LocalWorker(this.config.native, { timeoutMs: 30000 });
      const bundle = { id: this.inputs.manifest.bundleId, cardsHash: this.inputs.pins.get('cardData.json'), rulesHash: this.inputs.pins.get('gameData.json'), runtimeHash: this.inputs.pins.get('MatchLogic.dll') };
      const seats = Object.fromEntries(['human', 'opponent'].map((seat, i) => [seat, { accountId: `play-${seat}`, name: seat === 'human' ? 'You' : model.name, cards: this.inputs.selected[i === 0 ? body.deck : 1 - body.deck] }]));
      const frame = await worker.request('create', { bundle, seats, offline: { seed: Number.parseInt(randomUUID().slice(0, 8), 16), projectionCopyMode: this.inputs.copyMode } });
      await this.closeGame();
      this.game = { id: randomUUID(), model, client, worker, policy, humanDeck: body.deck, projectors: { human: new PolicyView(), opponent: new PolicyView() },
        activity: ['Loaded saved checkpoint on CPU. Opponent ordinary actions are learned; opponent setup and prompts use the frozen helper.'], learnedDecisions: 0, helperDecisions: 0, commands: 0 };
      this.update(frame);
      await this.drive();
      return this.state();
    } catch (error) {
      worker?.close();
      await client.shutdown();
      if (this.game?.client === client) this.stopFailed();
      throw error;
    }
  }

  update(frame) {
    const g = this.game;
    if (!Number.isSafeInteger(frame?.revision) || !frame.views?.human || !frame.views?.opponent) throw new Error('Invalid native frame.');
    if (frame.terminal && !['human', 'opponent', null].includes(frame.terminal.winner)) throw new Error('Invalid native result.');
    g.frame = frame;
    g.views = Object.fromEntries(['human', 'opponent'].map(seat => [seat, g.projectors[seat].project(frame.views[seat])]));
    if (Object.values(g.views).some(view => view.status === 'failed' || view.prompts.some(prompt => prompt.kind === 'unsupported'))) throw new Error('Native runtime reached an unsupported decision.');
  }

  async preview(decision) {
    const g = this.game;
    const native = this.resolve('human', decision);
    if (!native.promptId) fail('Only prompt selections need preview.');
    const reply = await g.worker.request('preview', { seat: 'human', selection: { ...native, requestId: randomUUID(), expectedRevision: g.frame.revision } });
    return { valid: reply.valid === true, message: reply.valid ? 'Native rules accept this selection.' : 'Native rules reject this selection.' };
  }

  async accept(seat, decision, attribution) {
    const g = this.game;
    const view = g.views[seat];
    const native = this.resolve(seat, decision);
    if (native.promptId) {
      const reply = await g.worker.request('preview', { seat, selection: { ...native, requestId: randomUUID(), expectedRevision: g.frame.revision } });
      if (!reply.valid) fail('Native rules reject this selection.');
    }
    const label = seat === 'human' ? (view.actions.find(value => value.id === decision.actionId)?.kind ?? view.prompts[0]?.kind) : (ordinary(view) ? 'ordinary action' : 'setup / prompt');
    const reply = await g.worker.request('command', { seat, command: { ...native, commandId: randomUUID(), expectedRevision: g.frame.revision } });
    if (reply.receipt?.status !== 'accepted' || reply.frame?.revision !== g.frame.revision + 1) throw new Error('Native command did not advance exactly once. Reset required.');
    g.commands++;
    g.activity.push(`${attribution} · ${label} · revision ${reply.frame.revision}`);
    if (g.activity.length > 80) g.activity.shift();
    if (attribution === 'Learned opponent') g.learnedDecisions++;
    if (attribution.includes('helper')) g.helperDecisions++;
    this.update(reply.frame);
  }

  async helper(seat, attribution) {
    const g = this.game;
    let checked = 0;
    for (const decision of g.policy(g.views[seat])) {
      if (++checked > 128) throw new Error('Helper choice budget exhausted.');
      if (decision.promptId) {
        const native = g.projectors[seat].resolve(decision);
        const reply = await g.worker.request('preview', { seat, selection: { ...native, requestId: randomUUID(), expectedRevision: g.frame.revision } });
        if (!reply.valid) continue;
      }
      await this.accept(seat, decision, attribution);
      return true;
    }
    return false;
  }

  resolve(seat, decision) {
    try { return this.game.projectors[seat].resolve(decision); }
    catch (error) {
      if (seat === 'human') fail('This action or selection is not currently offered.', 400);
      throw error;
    }
  }

  async drive() {
    const g = this.game;
    for (let steps = 0; !g.frame.terminal; steps++) {
      if (steps >= 256 || g.commands >= 2000) throw new Error('Local game action budget exhausted.');
      if (g.views.human.prompts.length || g.views.human.actions.length) return;
      if (ordinary(g.views.opponent)) await this.accept('opponent', await g.client.decide({ view: g.views.opponent }), 'Learned opponent');
      else if (!await this.helper('opponent', 'Opponent helper')) throw new Error('No native choice advances this game.');
    }
  }

  stopFailed() {
    if (!this.game) return;
    this.game.error = 'The local engine stopped. Start a new game; the last command will not be retried.';
    this.game.worker.close();
    this.game.client.close();
  }

  async closeGame() {
    if (!this.game) return;
    this.game.worker.close();
    await this.game.client.shutdown();
  }

  async close() { await this.serialized(() => this.closeGame()); }
}
