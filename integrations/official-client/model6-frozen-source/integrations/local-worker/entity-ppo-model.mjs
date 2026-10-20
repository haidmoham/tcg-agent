import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { indexedEntityDecision } from '../../learning/entity-features.mjs';
import { model6FeatureContract as entityFeatureContract, model6ContractSha256 as entityContractSha256,
  encodeModel6Decision as encodeEntityDecision } from '../../learning/model6-features.mjs';

export function validateEntityPpoActions(records, actions) {
  if (!Array.isArray(actions) || actions.length !== records.length) throw new Error('one PPO sample per complete record required');
  return actions.map((action, index) => {
    const record = records[index];
    if (!action || !Number.isSafeInteger(action.actionIndex) || action.actionIndex < 0 || action.actionIndex >= record.candidates.length
        || record.legalMask?.[action.actionIndex] === false || !Number.isFinite(action.oldLogProb)
        || action.oldLogProb > 0.00001 || !Number.isFinite(action.oldValue)) throw new Error('invalid entity PPO categorical sample');
    return { actionIndex: action.actionIndex, oldLogProb: action.oldLogProb, oldValue: action.oldValue };
  });
}

export class EntityPpoModelClient {
  constructor({ executable, checkpoint, modelRoot, catalogPath, catalogSha256, frozenSelectionSha256, seed = 1729, device = 'cpu' }) {
    if (!isAbsolute(executable ?? '') || !isAbsolute(checkpoint ?? '') || !isAbsolute(catalogPath ?? '')
        || !['cpu', 'cuda'].includes(device) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff
        || !/^[a-f0-9]{64}$/.test(catalogSha256 ?? '')) throw new Error('explicit local entity PPO configuration required');
    if (modelRoot !== undefined && (!isAbsolute(modelRoot) || resolve(modelRoot) === parse(resolve(modelRoot)).root))
      throw new Error('absolute dedicated modelRoot required');
    const bytes = readFileSync(catalogPath);
    if (bytes.length > 64 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== catalogSha256)
      throw new Error('entity PPO catalog digest mismatch');
    this.catalog = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    this.catalogSha256 = catalogSha256; this.frozenSelectionSha256 = frozenSelectionSha256;
    this.checkpoint = resolve(checkpoint); this.device = device; this.seed = seed;
    this.checkpointSha256 = createHash('sha256').update(readFileSync(checkpoint)).digest('hex');
    this.pending = new Map(); this.buffer = ''; this.closed = false; this.sequence = 0;
    this.requests = 0; this.valueRequests = 0; this.inferenceMilliseconds = 0; this.stderr = '';
    this.child = spawn(executable, ['-u', fileURLToPath(new URL('../../learning/entity_ppo_runtime.py', import.meta.url)),
      'serve', '--checkpoint', checkpoint, '--catalog', catalogPath, '--device', device, '--seed', String(seed)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1',
      ...(modelRoot === undefined ? {} : { PTCG_AGENT_MODEL_ROOT: resolve(modelRoot) }) } });
    this.exited = new Promise(accept => { this.child.once('exit', accept); this.child.once('error', accept); });
    this.child.stdout.setEncoding('utf8'); this.child.stdout.on('data', chunk => this.read(chunk));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4096); });
    this.child.once('exit', () => this.close(new Error(`entity PPO stopped, ${this.stderr}`)));
    this.child.once('error', () => this.close(new Error('entity PPO unavailable')));
    this.child.stdin.on('error', () => this.close(new Error('entity PPO input closed')));
  }

  request(op, payload = {}) {
    if (this.closed) return Promise.reject(new Error('entity PPO closed'));
    const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => this.close(new Error('entity PPO reply timed out')), 30000);
      this.pending.set(id, { accept, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...payload, id, op }) + '\n');
    });
  }

  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) return this.close(new Error('entity PPO response exceeded budget'));
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let response;
      try { response = JSON.parse(line); } catch { return this.close(new Error('invalid entity PPO response')); }
      if (!response || typeof response !== 'object' || Array.isArray(response) || !Number.isSafeInteger(response.id)
          || typeof response.ok !== 'boolean' || !this.pending.has(response.id)) return this.close(new Error('uncorrelated entity PPO response'));
      const pending = this.pending.get(response.id); this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.ok) pending.accept(response); else pending.reject(new Error(response.error ?? 'entity PPO request rejected'));
    }
  }

  async verify() {
    const info = await this.request('ping');
    if (info.schema !== 'entity-masked-ppo/1' || !isDeepStrictEqual(info.featureContract, entityFeatureContract)
        || info.contractSha256 !== entityContractSha256 || info.catalogSha256 !== this.catalogSha256
        || info.cardVocabularySize !== this.catalog.cards?.length || info.actionVocabularySize !== this.catalog.actions?.length
        || resolve(info.checkpoint ?? '') !== this.checkpoint || info.checkpointSha256 !== this.checkpointSha256
        || info.device !== this.device || info.samplingSeed !== this.seed || !/^[a-f0-9]{64}$/.test(info.frozenSelectionSha256 ?? '')
        || this.frozenSelectionSha256 !== undefined && info.frozenSelectionSha256 !== this.frozenSelectionSha256) {
      this.close(); throw new Error('entity PPO feature, checkpoint, catalog or frozen selection mismatch');
    }
    this.frozenSelectionSha256 = info.frozenSelectionSha256;
    return info;
  }

  async act(records, { deterministic = false } = {}) {
    if (typeof deterministic !== 'boolean' || !Array.isArray(records) || !records.length || records.length > 64
        || records.some(record => record.schema !== entityFeatureContract.schema || !Array.isArray(record.candidates)
          || !record.candidates.length || record.candidates.length > entityFeatureContract.maxCandidates
          || record.legalMask !== undefined && (!Array.isArray(record.legalMask) || record.legalMask.length !== record.candidates.length
            || record.legalMask.some(flag => typeof flag !== 'boolean') || !record.legalMask.some(Boolean))))
      throw new Error('bounded complete entity PPO records required');
    const started = performance.now();
    const response = await this.request('act', { records, deterministic });
    const samples = validateEntityPpoActions(records, response.actions);
    this.requests += samples.length; this.inferenceMilliseconds += performance.now() - started;
    return samples;
  }

  async values(records) {
    if (!Array.isArray(records) || !records.length || records.length > 64) throw new Error('bounded complete critic records required');
    const response = await this.request('values', { records });
    if (!Array.isArray(response.values) || response.values.length !== records.length || !response.values.every(Number.isFinite))
      throw new Error('invalid entity PPO bootstrap values');
    this.valueRequests += records.length; return response.values;
  }

  async setSeed(seed) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || this.pending.size) throw new Error('idle model and unsigned seed required');
    const response = await this.request('seed', { seed });
    if (response.samplingSeed !== seed) throw new Error('sampling seed was not applied');
    this.seed = seed; return seed;
  }

  async decide({ view, decisionContext = view.decisionContext ?? {} }) {
    const record = encodeEntityDecision(view, { catalog: this.catalog, decisionContext });
    const [sample] = await this.act([record], { deterministic: true });
    return indexedEntityDecision(view, sample.actionIndex);
  }

  close(error = new Error('entity PPO closed')) {
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

export { EntityPpoModelClient as EntityPPOModelClient };

