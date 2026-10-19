import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const protocol = 'indigo-engine-worker/1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = path => sha(readFileSync(path));
const exactHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function verifyLocalInputs(config) {
  if (config?.schema !== 'local-worker-probe-v1') throw new Error('unsupported local probe configuration');
  for (const key of ['executable', 'worker', 'bundleRoot']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error('explicit absolute local paths required');
  }
  for (const key of ['executable', 'worker']) {
    if (!exactHash(config[`${key}Sha256`]) || hashFile(config[key]) !== config[`${key}Sha256`]) throw new Error('local executable pin mismatch');
  }
  const root = realpathSync(config.bundleRoot);
  const bytes = readFileSync(join(root, 'manifest.json'));
  if (!exactHash(config.manifestSha256) || sha(bytes) !== config.manifestSha256) throw new Error('local bundle manifest pin mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.files?.length !== 8) throw new Error('unsupported local bundle');
  const expectedFiles = new Set(['MatchLogic.dll', 'CardDatabase.DataAccess.dll', 'Newtonsoft.Json.dll', 'TimeProvider.dll', 'cardData.json', 'gameData.json', 'decks.json', 'printing-joins.json']);
  const pins = new Map();
  for (const row of manifest.files) {
    if (!expectedFiles.has(row.path) || !exactHash(row.sha256) || pins.has(row.path)) throw new Error('invalid local bundle entry');
    const target = realpathSync(join(root, row.path));
    const inside = relative(root, target);
    if (isAbsolute(inside) || inside.startsWith('..') || hashFile(target) !== row.sha256) throw new Error('local bundle input mismatch');
    pins.set(row.path, row.sha256);
  }
  for (const name of ['MatchLogic.dll', 'CardDatabase.DataAccess.dll', 'Newtonsoft.Json.dll', 'TimeProvider.dll']) {
    if (!pins.has(name) || hashFile(join(dirname(config.worker), name)) !== pins.get(name)) throw new Error('worker dependency differs from bundle');
  }
  let decisions;
  if (config.policyModule) {
    if (!isAbsolute(config.policyModule) || !exactHash(config.policySha256) || hashFile(config.policyModule) !== config.policySha256) throw new Error('local policy pin mismatch');
    decisions = config.policyModule;
  }
  const maxCommands = config.maxCommands ?? 0;
  const maxSeconds = config.maxSeconds ?? 30;
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 0 || maxCommands > 2000 || !Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 180) throw new Error('invalid local probe budget');
  const decks = JSON.parse(readFileSync(join(root, 'decks.json')));
  const selected = ['realDeckRows', 'zoroarkDeckRows'].map(key => decks[key]?.orderedSourceIDs);
  if (selected.some(deck => !Array.isArray(deck) || deck.length !== 60 || deck.some(card => typeof card !== 'string'))) throw new Error('expected two pinned 60-card source arrays');
  return { root, pins, manifest, selected, decisions, maxCommands, maxSeconds };
}

export class LocalWorker {
  constructor(config, { timeoutMs = 15000 } = {}) {
    this.epoch = randomUUID(); this.matchId = randomUUID(); this.timeoutMs = timeoutMs;
    this.closed = false; this.pending = null; this.buffer = '';
    this.child = spawn(config.executable, [config.worker, config.bundleRoot, config.manifestSha256], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', chunk => this.read(chunk));
    this.child.on('error', () => this.close(new Error('local worker unavailable')));
    this.child.on('exit', () => this.close(new Error('local worker stopped')));
    this.child.stdin.on('error', () => this.close(new Error('local worker input closed')));
  }
  request(method, payload) {
    if (this.closed || this.pending) return Promise.reject(new Error('worker closed or request already pending'));
    const requestId = randomUUID();
    const line = JSON.stringify({ protocol, requestId, epoch: this.epoch, matchId: this.matchId, method, payload });
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) return Promise.reject(new Error('request exceeds local frame budget'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('local worker reply uncertain; no automatic mutation retry')), this.timeoutMs);
      this.pending = { requestId, resolve, reject, timer };
      this.child.stdin.write(line + '\n');
    });
  }
  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) return this.close(new Error('local reply exceeds frame budget'));
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0 && !this.closed) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { return this.close(new Error('invalid local reply')); }
      const pending = this.pending;
      if (!reply || typeof reply !== 'object' || Array.isArray(reply) || !pending || reply.protocol !== protocol || reply.requestId !== pending.requestId || reply.epoch !== this.epoch || reply.matchId !== this.matchId || !Object.hasOwn(reply, 'payload')) return this.close(new Error('uncorrelated local reply'));
      clearTimeout(pending.timer); this.pending = null; pending.resolve(reply.payload);
    }
  }
  close(error = new Error('local worker closed')) {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    if (this.child.exitCode === null) this.child.kill();
  }
}

function frameCheck(frame) {
  if (!Number.isSafeInteger(frame?.revision) || !frame.views?.human || !frame.views?.opponent) throw new Error('invalid local frame');
  if (frame.terminal !== null && (!frame.terminal || !['human', 'opponent', null].includes(frame.terminal.winner))) throw new Error('invalid terminal frame');
  for (const view of Object.values(frame.views)) {
    if (view.source !== 'live-matchlogic' || !Array.isArray(view.hand) || !Array.isArray(view.actions) || !Array.isArray(view.prompts) || Object.hasOwn(view.opponent, 'hand')) throw new Error('unexpected local seat projection');
    if (view.status === 'failed' || view.prompts.some(prompt => prompt.kind === 'unsupported')) throw new Error('unsupported native decision');
  }
}

export async function probeLocalWorker(config) {
  const inputs = verifyLocalInputs(config);
  const policy = inputs.decisions ? (await import(pathToFileURL(inputs.decisions))).livePracticeDecisions : null;
  if (policy !== null && typeof policy !== 'function') throw new Error('local candidate generator missing');
  const worker = new LocalWorker(config);
  const start = performance.now();
  const budget = setTimeout(() => worker.close(new Error('local probe time budget exhausted')), inputs.maxSeconds * 1000);
  let commands = 0; let previews = 0; let rejections = 0; let seatFrames = 0;
  try {
    const identity = { id: inputs.manifest.bundleId, cardsHash: inputs.pins.get('cardData.json'), rulesHash: inputs.pins.get('gameData.json'), runtimeHash: inputs.pins.get('MatchLogic.dll') };
    const seats = Object.fromEntries(['human', 'opponent'].map((seat, index) => [seat, { accountId: `offline-probe-${seat}`, name: `Offline ${seat}`, cards: inputs.selected[index] }]));
    let frame = await worker.request('create', { bundle: identity, seats });
    frameCheck(frame); seatFrames += 2;
    for (const seat of ['human', 'opponent']) {
      const view = await worker.request('view', { seat });
      if (!isDeepStrictEqual(view, frame.views[seat])) throw new Error('seat read changed accepted projection');
    }
    while (!frame.terminal && policy && commands < inputs.maxCommands) {
      let next;
      for (const seat of ['human', 'opponent']) {
        const view = structuredClone(frame.views[seat]);
        let candidates = 0;
        for (const decision of policy(view)) {
          if (++candidates > 128) throw new Error('local candidate budget exceeded');
          if (decision.promptId) {
            const preview = await worker.request('preview', { seat, selection: { ...decision, requestId: randomUUID(), expectedRevision: frame.revision } });
            previews++;
            if (preview.valid !== true) continue;
          }
          const reply = await worker.request('command', { seat, command: { ...decision, commandId: randomUUID(), expectedRevision: frame.revision } });
          if (reply.receipt?.status === 'rejected') { rejections++; continue; }
          if (reply.receipt?.status !== 'accepted' || reply.frame?.revision !== frame.revision + 1) throw new Error('invalid command receipt');
          next = reply.frame; commands++; break;
        }
        if (next) break;
      }
      if (!next) throw new Error('no supported local candidate advances the game');
      frame = next; frameCheck(frame); seatFrames += 2;
    }
    const receipt = { schema: 'local-worker-receipt-v1', mode: 'privileged-offline-diagnostic', fullStandardClaim: false, seededReplayCertified: false, policyIsolationCertified: false, manifestSha256: config.manifestSha256, workerSha256: config.workerSha256, policySha256: config.policySha256 ?? null, commands, previews, rejections, seatFrames, finalRevision: frame.revision, completedNaturally: frame.terminal !== null, winnerSeat: frame.terminal?.winner ?? null, elapsedMs: performance.now() - start };
    if (!frame.terminal) await worker.request('abort', { commandId: randomUUID(), expectedRevision: frame.revision });
    return receipt;
  } finally { clearTimeout(budget); worker.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await probeLocalWorker(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2)); }
  catch { console.error('Local offline probe failed. Keep private diagnostics local; no Standard admission or result is inferred.'); process.exitCode = 1; }
}
