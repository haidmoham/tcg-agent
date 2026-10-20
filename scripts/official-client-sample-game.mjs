import { spawn } from 'node:child_process';
import { readFile, appendFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { semanticPokemonAction, semanticActionHash, ActionExecutionLedger } from '../integrations/pokemon-action.mjs';
import { projectRuntimeMatch, chooseSetupAction, chooseTextPrompt, chooseEntityPrompt } from '../integrations/official-client/runtime-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(join(root, '.cache/client-ui-config.json')));
const modelConfig = JSON.parse(await readFile(join(root, '.cache/model2-cpu-config.json')));
const attempt = JSON.parse(await readFile(join(root, '.cache/official-client-test-game-attempt.json')));
if (process.argv.slice(2).join(' ') !== '--resume-sample --arm --step' || attempt.mode !== 'provided-ai') throw new Error('explicit-owned-sample-step-required');
if (typeof config.corpusPath !== 'string' || !config.corpusPath) throw new Error('explicit-local-corpus-path-required');
const corpusBytes = await readFile(config.corpusPath);
if (createHash('sha256').update(corpusBytes).digest('hex') !== 'afe7931aab5a6d4f77cdecbb7ae58502dd17fce4695986a348c2b27ebdd6c4ec') throw new Error('local-corpus-pin-mismatch');
const corpus = corpusBytes.toString('utf8');
const sources = new Map(corpus.split('\n').filter(Boolean).map(line => { const card = JSON.parse(line); return [card.cardSourceID, card]; }));
const checkpoint = await readFile(modelConfig.checkpoint);
if (createHash('sha256').update(checkpoint).digest('hex') !== '144180ba472cfe23e405eb7c47448e5c88e8148ac5440c5d38f37a54d7ad690b') throw new Error('frozen-checkpoint-mismatch');
const folder = join(root, '.cache', `sample-game-${attempt.id}`);
await mkdir(folder, { recursive: true });
const log = async event => { const value = { at: Date.now(), ...event }; await appendFile(join(folder, 'redacted-events.jsonl'), JSON.stringify(value) + '\n'); process.stdout.write(JSON.stringify(value) + '\n'); };
const child = spawn(config.python, [join(root, 'scripts/official-client-runtime.py'), '--pid', String(config.processId), '--window', String(config.windowId),
  '--permit-scoped-adapter', '--permit-input-probe', '--supervised-test-game', '--resume-owned-test-game',
  ...(config.fridaRoot ? ['--frida-root', config.fridaRoot] : [])],
  { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', waiting, counter = 0, readyAccept, readyReject;
const ready = new Promise((accept, reject) => { readyAccept = accept; readyReject = reject; });
child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {});
child.stdout.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 1000000) { child.kill(); waiting?.reject(new Error('runtime-response-budget')); return; }
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const value = JSON.parse(line);
      if (value.schema === 'official-client-runtime-ready/1') { readyAccept(value); continue; }
      if (value.ok !== true) throw new Error(`runtime-${value.stage}-${value.error}`);
      if (!waiting || value.id !== waiting.id) throw new Error('runtime-uncorrelated-reply');
      const pending = waiting; waiting = null; clearTimeout(pending.timer); pending.accept(value);
    } catch (error) { readyReject(error); waiting?.reject(error); }
  }
});
child.on('exit', () => { readyReject(new Error('runtime-ended')); waiting?.reject(new Error('runtime-ended')); });
child.on('error', () => { readyReject(new Error('runtime-unavailable')); waiting?.reject(new Error('runtime-unavailable')); });
function request(op, values = {}) {
  if (waiting) throw new Error('runtime-request-pending');
  return new Promise((accept, reject) => {
    const id = `sample-${++counter}`;
    const timer = setTimeout(() => { reject(new Error('runtime-reply-timeout-no-retry')); child.kill(); }, 10000);
    waiting = { id, accept, reject, timer };
    child.stdin.write(JSON.stringify({ id, op, ...values, ...(op !== 'observe' && op !== 'close' ? { armed: true, step: id } : {}) }) + '\n');
  });
}
const model = new NativeModelClient(modelConfig), projector = new PolicyView(), ledger = new ActionExecutionLedger();
let revision = 0, lastHash = null, pending = null, helpers = 0, recommendations = 0;
const started = Date.now();
let lastProgress = started;
const delay = () => new Promise(accept => setTimeout(accept, 2100));
try {
  await ready;
  await log({ event: 'sample-resumed', gameAttempts: 1, model: 'frozen-model2', checkpointChanged: false });
  while (Date.now() - started < 900000) {
    for (const marker of ['official-client-input.kill', 'official-client-runtime.kill', 'official-client.kill']) {
      try { await access(join(root, '.cache', marker)); throw new Error('sample-paused-by-kill-marker'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const observation = await request('observe');
    const value = observation.result;
    if (!value.match?.offline) throw new Error('sample-offline-match-not-present');
    if (observation.snapshotHash !== lastHash) { lastHash = observation.snapshotHash; lastProgress = Date.now(); revision++; }
    if (value.match.gameOver) { await log({ event: 'game-finished', winner: value.match.winner, ledger: ledger.counts, helpers }); break; }
    if (pending) {
      if (observation.snapshotHash !== pending.hash && (!value.match.operationProcessing || value.match.prompt)) {
        if (pending.modelId) ledger.complete(pending.modelId, { kind: 'verified-game-action', proof: {
          adapter: 'official-client', semanticHash: pending.semanticHash, fromRevision: pending.revision, toRevision: revision } });
        await log({ event: 'transition-observed', policy: pending.policy }); pending = null;
      } else { if (Date.now() - pending.at > 60000) throw new Error('sample-action-transition-timeout'); await delay(); continue; }
    }
    if (Date.now() - lastProgress > 60000) throw new Error('sample-no-progress-timeout');
    let op, data, policy, label, modelId, semanticHash;
    if (value.match.prompt) {
      const decision = value.match.prompt.kind === 'entities' ? chooseEntityPrompt(value.match.prompt) : chooseTextPrompt(value.match.prompt);
      op = value.match.prompt.kind === 'entities' ? 'answer_entities' : 'answer_text';
      data = decision.choiceIds ? { choiceIds: decision.choiceIds } : { choiceId: decision.choiceId }; policy = decision.attribution.id; helpers++;
      label = decision.choiceIds ? 'Select ' + decision.choiceIds.map(id => value.match.prompt.groups.flatMap(group => group.choices).find(choice => choice.id === id).name).join(', ')
        : value.match.prompt.choices.find(choice => choice.id === decision.choiceId).label;
    } else if (value.match.menu) throw new Error(`sample-unsupported-prompt:${value.match.menu}`);
    else if (value.match.operationProcessing || !value.match.actions.length) { await delay(); continue; }
    else {
      const raw = projectRuntimeMatch(value, sources, revision);
      let selected;
      if (raw.status === 'setup') { const decision = chooseSetupAction(raw); selected = raw.actions.find(action => action.id === decision.actionId); policy = decision.attribution.id; helpers++; }
      else {
        if (raw.turn !== 'you') { await delay(); continue; }
        const view = projector.project(raw);
        const decision = await model.decide({ view });
        const semantic = semanticPokemonAction(view, decision, { kind: 'model', id: 'model2' });
        selected = raw.actions.find(action => action.id === projector.resolve(decision).actionId);
        if (!selected) throw new Error('sample-illegal-model-choice');
        modelId = `decision-${++recommendations}`; ledger.propose(modelId, semantic); policy = 'model2';
        semanticHash = semanticActionHash(semantic);
      }
      op = 'act'; data = { actionId: selected.id }; label = selected.label;
    }
    await log({ event: 'proposed', policy, label });
    await request(op, { expected: observation.snapshotHash, data });
    pending = { hash: observation.snapshotHash, at: Date.now(), policy, modelId, semanticHash, revision };
    await delay();
  }
} catch (error) {
  if (pending?.modelId) ledger.complete(pending.modelId, { kind: 'driver-failure' });
  await log({ event: 'sample-paused', reason: error.message, ledger: ledger.counts, helpers, result: 'uncompleted', trainingEligible: false });
  process.exitCode = 2;
} finally {
  if (waiting) { clearTimeout(waiting.timer); waiting = null; }
  child.stdin.end();
  await model.shutdown();
  if (child.exitCode === null) child.kill();
}
