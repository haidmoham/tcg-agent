import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeVisibleScreen } from '../integrations/official-client/recognize.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
const [configPath, command, ...flags] = process.argv.slice(2);
if (!['observe', 'decks', 'background-decks', 'verify-decks'].includes(command)) throw new Error('navigation-command-not-supported');
const sendsInput = ['decks', 'background-decks'].includes(command);
if (sendsInput ? flags.join(' ') !== '--arm --step' : flags.length !== 0) throw new Error('navigation-explicit-arm-step-required');
const inside = path => { const value = resolve(path), part = relative(cache, value); if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('private-cache-path-required'); return value; };
const config = JSON.parse(await readFile(inside(configPath)));
if (!isAbsolute(config.python ?? '') || !isAbsolute(config.powershell ?? '') || !Number.isSafeInteger(config.processId)
    || !Number.isSafeInteger(config.windowId) || config.mode !== 'built-in-ai' || config.deckDisplayName !== 'AgentPult') throw new Error('navigation-config-invalid');
const inputMode = config.inputMode ?? 'visible-window-only';
if (inputMode !== 'visible-window-only') throw new Error('navigation-background-visible-required');
if (sendsInput) {
  try { await access(join(cache, 'official-client-input.kill')); throw new Error('navigation-input-paused'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
async function checkKill() { try { await access(join(cache, 'official-client.kill')); } catch (error) { if (error.code === 'ENOENT') return; throw error; } throw new Error('navigation-killed'); }
async function runJson(executable, args) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('navigation-child-timeout-no-input-retry')); }, 20000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; if (output.length > 512000) child.kill(); });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('navigation-child-unavailable')); });
    child.once('close', code => { clearTimeout(timer); try { const result = JSON.parse(output.trim()); if (code !== 0 && result.status !== 'blocked') throw new Error(); accept(result); } catch { reject(new Error('navigation-child-rejected')); } });
  });
}

const ocr = spawn(config.python, [join(root, 'scripts/official-client-ocr.py'), '--serve'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', pending = null;
ocr.stdout.setEncoding('utf8');
ocr.stdout.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 512000) { pending?.reject(new Error('ocr-reply-too-large')); ocr.kill(); return; }
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try { const value = JSON.parse(line); if (value.schema === 'official-client-ocr-service/1' && value.ready === true) continue; if (!pending || pending.id !== value.id) throw new Error(); const waiter = pending; pending = null; clearTimeout(waiter.timer); value.ok ? waiter.accept(value) : waiter.reject(new Error('ocr-request-rejected')); }
    catch { pending?.reject(new Error('ocr-reply-invalid')); ocr.kill(); }
  }
});
ocr.stderr.on('data', () => {});
ocr.once('error', () => pending?.reject(new Error('ocr-process-unavailable')));
ocr.once('exit', () => pending?.reject(new Error('ocr-process-stopped')));
function request(op, values = {}) {
  if (pending) throw new Error('ocr-request-already-pending');
  const id = ++sequence;
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { pending = null; ocr.kill(); reject(new Error('ocr-timeout')); }, 15000);
    pending = { id, accept, reject, timer }; ocr.stdin.write(`${JSON.stringify({ id, op, ...values })}\n`);
  });
}
async function observe() {
  await checkKill();
  const directory = join(cache, `client-observation-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const receipt = await runJson(process.execPath, [join(root, 'scripts/official-client-capture.mjs'), config.powershell, String(config.processId), String(config.windowId), directory]);
  const response = await request('ocr', { directory });
  const result = response.result;
  await writeFile(join(directory, 'ocr.json'), JSON.stringify(result));
  const recognized = recognizeVisibleScreen(result);
  await writeFile(join(directory, 'recognized.json'), JSON.stringify(recognized, null, 2));
  await writeFile(join(cache, 'latest-client-observation.json'), JSON.stringify({ directory, receipt, recognized }, null, 2));
  emit({ observed: recognized.screen, selectedDeck: recognized.deckDisplayName, focused: receipt.window.focused,
    navigationControls: recognized.controls.map(control => control.id), unknowns: recognized.unknowns, directory });
  return { directory, receipt, recognized };
}
async function verify(previous, current) {
  const statePath = join(cache, 'official-client-input-state.json');
  const state = JSON.parse(await readFile(statePath));
  if (state.lastId !== previous.id || current.receipt.capturedAt <= state.lastActionAt
      || current.recognized.screen !== previous.expectedScreen || previous.transport !== 'window-message') throw new Error('navigation-transition-unverified');
  state.lastOutcome = 'transition-verified'; state.lastVerifiedImageSha256 = current.receipt.imageSha256;
  await writeFile(statePath, JSON.stringify(state));
  emit({ verified: previous.expectedScreen, inputId: previous.id });
}

try {
  await mkdir(cache, { recursive: true }); await checkKill(); await request('ping');
  const before = await observe();
  if (command === 'observe') process.exitCode = 0;
  else if (command.startsWith('verify-')) {
    const state = JSON.parse(await readFile(join(cache, 'official-client-input-state.json')));
    const proposal = JSON.parse(await readFile(join(cache, `navigation-${state.lastId}.json`)));
    if (proposal.action !== 'click' || proposal.targetLabel !== 'Decks' || proposal.id !== state.lastId || proposal.transport !== 'window-message') throw new Error('no-decks-transition-pending');
    const previous = { id: proposal.id, targetLabel: 'Decks', expectedScreen: 'decks', transport: proposal.transport };
    await verify(previous, before);
  } else {
    if (!['home-lobby', 'ranked-ladder'].includes(before.recognized.screen)
        || (before.recognized.screen === 'home-lobby' && before.recognized.deckDisplayName !== 'AgentPult')) throw new Error('navigation-layout-or-deck-unverified');
    const target = before.recognized.controls.find(control => control.id === 'navigation.decks');
    if (!target) throw new Error('navigation-target-unavailable');
    const [left, top, right, bottom] = target.target.bounds;
    const id = randomUUID();
    const proposal = { schema: 'official-client-input/1', id, processId: config.processId, windowId: config.windowId,
      createdAt: Date.now(), action: 'click', x: Math.round(target.target.x), y: Math.round(target.target.y),
      targetLabel: 'Decks', expectedScreen: before.recognized.screen === 'home-lobby' ? 'home' : before.recognized.screen, armed: true, disarmed: false, humanReviewed: true,
      transport: 'window-message',
      evidence: { captureDirectory: before.directory, ...before.recognized.capture,
        targetBox: { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) } } };
    const proposalPath = join(cache, `navigation-${id}.json`);
    await writeFile(proposalPath, JSON.stringify(proposal));
    const previous = { id, targetLabel: proposal.targetLabel, transport: proposal.transport, expectedScreen: 'decks' };
    emit({ proposed: { id, action: proposal.action, target: proposal.targetLabel, coordinates: [proposal.x, proposal.y], scope: 'navigation-only' } });
    await checkKill();
    let result;
    try { result = await runJson(process.execPath, [join(root, 'scripts/official-client-input.mjs'), config.powershell, proposalPath, '--step', id]); }
    catch {
      await appendFile(join(cache, 'navigation-actions.jsonl'), `${JSON.stringify({ at: Date.now(), id, command, policyDecision: false, result: { status: 'uncertain', error: 'input-wrapper-unavailable-no-retry' } })}\n`);
      throw new Error('navigation-input-outcome-uncertain-no-retry');
    }
    await appendFile(join(cache, 'navigation-actions.jsonl'), `${JSON.stringify({ at: Date.now(), id, command, policyDecision: false, result, beforeImageSha256: before.receipt.imageSha256 })}\n`);
    emit({ input: result });
    if (result.status === 'blocked') throw new Error(result.error);
    await writeFile(join(cache, 'last-navigation-action.json'), JSON.stringify(previous));
    let after;
    for (let attempt = 0; attempt < 3; attempt++) { after = await observe(); if (after.recognized.screen === previous.expectedScreen) break; }
    await verify(previous, after);
  }
} finally { if (pending) clearTimeout(pending.timer); ocr.kill(); }
