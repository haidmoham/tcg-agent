import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { cardActionFeatureContract, cardActionContractSha256, encodeCardActionDecision,
  indexedCardActionDecision, validatePrintingAliases } from '../../learning/card-action-features.mjs';

const finiteState = state => Array.isArray(state) && state.length === 224 && state.every(Number.isFinite);

export function validatePpoActions(records, actions) {
  if (!Array.isArray(actions) || actions.length !== records.length) throw new Error('one PPO sample per complete candidate list required');
  return actions.map((action, index) => {
    if (!action || !Number.isSafeInteger(action.actionIndex) || action.actionIndex < 0 || action.actionIndex >= records[index].candidates.length
        || !Number.isFinite(action.oldLogProb) || action.oldLogProb > 0.00001 || !Number.isFinite(action.oldValue))
      throw new Error('PPO sample is outside its legal candidate list or nonfinite');
    return { actionIndex: action.actionIndex, oldLogProb: action.oldLogProb, oldValue: action.oldValue };
  });
}

export class PpoModelClient {
  constructor({ executable, checkpoint, modelRoot, seed = 1729, device = 'cpu', printingAliases = {}, frozenSelectionSha256 }) {
    if (!isAbsolute(executable ?? '') || !isAbsolute(checkpoint ?? '') || !['cpu', 'cuda'].includes(device)
        || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('explicit local PPO model configuration required');
    if (modelRoot !== undefined && (!isAbsolute(modelRoot) || resolve(modelRoot) === parse(resolve(modelRoot)).root)) throw new Error('absolute dedicated modelRoot required');
    this.checkpoint = resolve(checkpoint); this.device = device; this.seed = seed;
    this.checkpointSha256 = createHash('sha256').update(readFileSync(checkpoint)).digest('hex');
    this.printingAliases = structuredClone(validatePrintingAliases(printingAliases));
    this.frozenSelectionSha256 = frozenSelectionSha256;
    this.pending = new Map(); this.buffer = ''; this.closed = false; this.sequence = 0;
    this.requests = 0; this.valueRequests = 0; this.inferenceMilliseconds = 0;
    this.child = spawn(executable, ['-u', fileURLToPath(new URL('../../learning/ppo_runtime.py', import.meta.url)),
      'serve', '--checkpoint', checkpoint, '--device', device, '--seed', String(seed)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      ...(modelRoot === undefined ? {} : { PTCG_AGENT_MODEL_ROOT: resolve(modelRoot) }) } });
    this.exited = new Promise(accept => { this.child.once('exit', accept); this.child.once('error', accept); });
    this.child.stdout.setEncoding('utf8'); this.child.stdout.on('data', chunk => this.read(chunk));
    this.child.stderr.on('data', () => {});
    this.child.once('exit', () => this.close(new Error('PPO model stopped')));
    this.child.once('error', () => this.close(new Error('PPO model unavailable')));
    this.child.stdin.on('error', () => this.close(new Error('PPO model input closed')));
  }

  request(op, payload = {}) {
    if (this.closed) return Promise.reject(new Error('PPO model closed'));
    const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => this.close(new Error('PPO model reply timed out')), 30000);
      this.pending.set(id, { accept, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...payload, id, op }) + '\n');
    });
  }

  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) return this.close(new Error('PPO response exceeded budget'));
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let response;
      try { response = JSON.parse(line); } catch { return this.close(new Error('invalid PPO response')); }
      if (!response || typeof response !== 'object' || Array.isArray(response) || !Number.isSafeInteger(response.id)
          || typeof response.ok !== 'boolean' || !this.pending.has(response.id)) return this.close(new Error('uncorrelated PPO response'));
      const pending = this.pending.get(response.id); this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.ok) pending.accept(response); else pending.reject(new Error(response.error ?? 'PPO request rejected'));
    }
  }

  async verify() {
    const info = await this.request('ping');
    if (info.schema !== 'native-masked-ppo/1' || info.stateDim !== cardActionFeatureContract.stateDimensions
        || info.candidateDim !== cardActionFeatureContract.candidateDimensions || info.contractSha256 !== cardActionContractSha256
        || resolve(info.checkpoint ?? '') !== this.checkpoint || info.checkpointSha256 !== this.checkpointSha256
        || info.device !== this.device || !isDeepStrictEqual(info.printingAliases, this.printingAliases)
        || info.samplingSeed !== this.seed
        || typeof info.frozenSelectionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(info.frozenSelectionSha256)
        || (this.frozenSelectionSha256 !== undefined && info.frozenSelectionSha256 !== this.frozenSelectionSha256)) {
      this.close(); throw new Error('PPO checkpoint, feature, alias or frozen-selection identity mismatch');
    }
    this.frozenSelectionSha256 = info.frozenSelectionSha256; return info;
  }

  async act(records, { deterministic = false } = {}) {
    if (typeof deterministic !== 'boolean' || !Array.isArray(records) || !records.length || records.length > 64
        || records.some(record => !finiteState(record.state) || !Array.isArray(record.candidates) || !record.candidates.length
          || record.candidates.length > 512 || record.candidates.some(row => !Array.isArray(row) || row.length !== 191 || !row.every(Number.isFinite))))
      throw new Error('complete bounded PPO observation records required');
    const started = performance.now(), response = await this.request('act', { records, deterministic });
    const samples = validatePpoActions(records, response.actions);
    this.requests += samples.length; this.inferenceMilliseconds += performance.now() - started; return samples;
  }

  async values(states) {
    if (!Array.isArray(states) || !states.length || states.length > 64 || !states.every(finiteState)) throw new Error('bounded actor-visible PPO states required');
    const response = await this.request('values', { states });
    if (!Array.isArray(response.values) || response.values.length !== states.length || !response.values.every(Number.isFinite)) throw new Error('PPO critic returned invalid bootstrap values');
    this.valueRequests += states.length; return response.values;
  }

  async setSeed(seed) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || this.pending.size) throw new Error('idle PPO scorer and unsigned episode sampling seed required');
    const response = await this.request('seed', { seed });
    if (response.samplingSeed !== seed) throw new Error('PPO episode sampling seed was not applied');
    this.seed = seed; return seed;
  }

  async decide({ view }) {
    const encoded = encodeCardActionDecision(view, null, { printingAliases: this.printingAliases });
    const [sample] = await this.act([encoded], { deterministic: true });
    return indexedCardActionDecision(view, sample.actionIndex);
  }

  close(error = new Error('PPO model closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); if (this.child.exitCode === null) this.child.kill();
  }

  async shutdown() {
    if (!this.closed) { try { await this.request('close'); } catch {} }
    this.close(); await this.exited;
  }
}
