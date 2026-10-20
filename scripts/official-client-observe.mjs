import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeVisibleScreen } from '../integrations/official-client/recognize.mjs';
import { startObservationService } from '../integrations/official-client/observation-service.mjs';
import { createBattleLogRecorder } from '../integrations/official-client/battle-log.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
const [configPath, ...extra] = process.argv.slice(2);
const privatePath = resolve(configPath ?? '');
const part = relative(cache, privatePath);
if (!configPath || extra.length || !part || part.startsWith('..') || isAbsolute(part)) throw new Error('private-config-required');
const config = JSON.parse(await readFile(privatePath));
if (!isAbsolute(config.python ?? '') || !isAbsolute(config.powershell ?? '') || !Number.isSafeInteger(config.processId)
    || !Number.isSafeInteger(config.windowId) || config.deckDisplayName !== 'AgentPult') throw new Error('observation-config-invalid');
await mkdir(cache, { recursive: true });
let battleLogRecorder = null, readBattleLog = null;
if (config.battleLogExportFile !== undefined) {
  const input = resolve(config.battleLogExportFile);
  const part = relative(cache, input);
  if (!isAbsolute(config.battleLogExportFile) || !part || part.startsWith('..') || isAbsolute(part)) throw new Error('private-battle-log-input-required');
  battleLogRecorder = await createBattleLogRecorder(cache, join(cache, `battle-log-${randomUUID()}`));
  readBattleLog = async () => {
    const physical = await realpath(input);
    const physicalPart = relative(await realpath(cache), physical);
    if (!physicalPart || physicalPart.startsWith('..') || isAbsolute(physicalPart)) throw new Error('private-battle-log-input-required');
    const bytes = await readFile(physical);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('battle-log-input-budget');
    return battleLogRecorder.record(JSON.parse(bytes));
  };
}
const ocr = spawn(config.python, [join(root, 'scripts/official-client-ocr.py'), '--serve'],
  { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', pending, sequence = 0, closed = false;
const children = new Set();
ocr.stdout.setEncoding('utf8');
ocr.stderr.on('data', () => {});
function rejectPending() { if (pending) { clearTimeout(pending.timer); pending.reject(new Error('ocr-unavailable')); pending = null; } }
ocr.on('error', rejectPending); ocr.on('exit', rejectPending);
ocr.stdin.on('error', rejectPending);
ocr.stdout.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 512000) { rejectPending(); ocr.kill(); return; }
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const value = JSON.parse(line);
      if (value.schema === 'official-client-ocr-service/1' && value.ready) continue;
      if (!pending || value.id !== pending.id) throw new Error();
      const waiter = pending; pending = null; clearTimeout(waiter.timer);
      value.ok ? waiter.accept(value) : waiter.reject(new Error('ocr-unavailable'));
    } catch { rejectPending(); ocr.kill(); }
  }
});
function request(op, values = {}) {
  if (pending || closed || ocr.exitCode !== null) throw new Error('ocr-unavailable');
  return new Promise((accept, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { rejectPending(); ocr.kill(); }, 15000);
    pending = { id, timer, accept, reject };
    ocr.stdin.write(`${JSON.stringify({ id, op, ...values })}\n`);
  });
}
async function capture(directory) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/official-client-capture.mjs'), config.powershell,
      String(config.processId), String(config.windowId), directory], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '', failed = false;
    const fail = () => { if (!failed) { failed = true; reject(new Error('capture-unavailable')); child.kill(); } };
    const timer = setTimeout(fail, 17000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; if (output.length > 16384) fail(); });
    child.stderr.on('data', () => {});
    child.once('error', fail);
    child.once('close', code => {
      clearTimeout(timer); children.delete(child);
      if (failed) return;
      try { if (code !== 0) throw new Error(); accept(JSON.parse(output)); } catch { fail(); }
    });
  });
}
async function observe() {
  try { await access(join(cache, 'official-client.kill')); throw new Error('observation-killed'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = join(cache, `service-observation-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const receipt = await capture(directory);
  const { result } = await request('ocr', { directory });
  const recognized = recognizeVisibleScreen(result);
  await writeFile(join(directory, 'ocr.json'), JSON.stringify(result));
  await writeFile(join(directory, 'recognized.json'), JSON.stringify(recognized));
  await writeFile(join(cache, 'latest-service-observation.json'), JSON.stringify({ directory, receipt, recognized }));
  return { receipt, recognized };
}
let service;
async function close() { closed = true; rejectPending(); ocr.kill(); for (const child of children) child.kill(); }
try {
  await request('ping');
  service = await startObservationService({ observe, readBattleLog, close });
  await writeFile(join(cache, 'observation-service.json'), JSON.stringify({ schema: 'official-client-observation-service/1', url: service.url, processId: process.pid }));
  process.stdout.write(`${JSON.stringify({ service: service.url, inputsEnabled: false, lifespanMs: 120000, maxObservations: 60 })}\n`);
  process.once('SIGINT', () => service.stop()); process.once('SIGTERM', () => service.stop());
  await service.finished;
} finally { await close(); await battleLogRecorder?.close(); }
