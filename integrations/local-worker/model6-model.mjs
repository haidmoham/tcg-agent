import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { model6FeatureContract as entityFeatureContract, model6ContractSha256 as entityContractSha256,
  encodeModel6Decision as encodeEntityDecision } from '../../learning/model6-features.mjs';
import { indexedEntityDecision } from '../../learning/entity-features.mjs';

export class Model6ModelClient {
  constructor({ executable, checkpoint, modelRoot, catalogPath, catalogSha256, seed = 1729, device = 'cpu' }) {
    if (!isAbsolute(executable ?? '') || !isAbsolute(checkpoint ?? '') || !isAbsolute(catalogPath ?? '')
        || !['cpu', 'cuda'].includes(device) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff
        || !/^[a-f0-9]{64}$/.test(catalogSha256 ?? '')) throw new Error('explicit local entity model configuration required');
    if (modelRoot !== undefined && (typeof modelRoot !== 'string' || !isAbsolute(modelRoot)
        || resolve(modelRoot) === parse(resolve(modelRoot)).root)) throw new Error('absolute dedicated modelRoot required');
    const bytes = readFileSync(catalogPath);
    if (bytes.byteLength > 64 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== catalogSha256)
      throw new Error('entity catalog raw-byte digest mismatch');
    this.catalog = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (this.catalog?.schema !== 'model5-public-catalog/1'
        || ['cards', 'actions'].some(name => !Array.isArray(this.catalog[name]) || !this.catalog[name].length
          || this.catalog[name].length > 100000 || this.catalog[name].some((row, index) => row?.id !== index)))
      throw new Error('entity catalog requires contiguous vocabularies including unknown zero');
    this.catalogSha256 = catalogSha256;
    this.checkpoint = resolve(checkpoint); this.device = device;
    this.pending = new Map(); this.buffer = ''; this.closed = false; this.sequence = 0;
    this.requests = 0; this.inferenceMilliseconds = 0;
    const childEnv = { ...process.env, PYTHONUNBUFFERED: '1',
      ...(modelRoot === undefined ? {} : { PTCG_AGENT_MODEL_ROOT: resolve(modelRoot) }) };
    this.child = spawn(executable, ['-u', fileURLToPath(new URL('../../learning/model6_torch.py', import.meta.url)),
      '--checkpoint', checkpoint, '--catalog', catalogPath, '--seed', String(seed), '--device', device],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    this.exited = new Promise(accept => { this.child.once('exit', accept); this.child.once('error', accept); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.read(chunk));
    this.stderr = '';
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4096); });
    this.child.once('exit', () => this.close(new Error(`entity model stopped${this.stderr ? `, ${this.stderr}` : ''}`)));
    this.child.once('error', () => this.close(new Error('entity model unavailable')));
    this.child.stdin.on('error', () => this.close(new Error('entity model input closed')));
  }

  request(op, payload = {}) {
    if (this.closed) return Promise.reject(new Error('entity model closed'));
    const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => this.close(new Error('entity model reply timed out')), 30000);
      this.pending.set(id, { accept, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...payload, op, id }) + '\n');
    });
  }

  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) return this.close(new Error('entity response exceeded budget'));
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let response;
      try { response = JSON.parse(line); } catch { return this.close(new Error('invalid entity model response')); }
      if (!response || typeof response !== 'object' || Array.isArray(response) || !Number.isSafeInteger(response.id)
          || typeof response.ok !== 'boolean' || !this.pending.has(response.id)) return this.close(new Error('uncorrelated entity response'));
      const pending = this.pending.get(response.id); this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.ok) pending.accept(response); else pending.reject(new Error(response.error ?? 'entity request rejected'));
    }
  }

  async verify() {
    const info = await this.request('ping');
    if (info.schema !== entityFeatureContract.schema || !isDeepStrictEqual(info.featureContract, entityFeatureContract)
        || info.contractSha256 !== entityContractSha256 || info.catalogSha256 !== this.catalogSha256
        || info.cardVocabularySize !== this.catalog.cards.length || info.actionVocabularySize !== this.catalog.actions.length
        || resolve(info.checkpoint ?? '') !== this.checkpoint || info.device !== this.device) {
      this.close(); throw new Error('entity checkpoint feature or catalog contract mismatch');
    }
    return info;
  }

  async infer(record) {
    const started = performance.now();
    const result = await this.request('infer', record);
    this.requests++; this.inferenceMilliseconds += performance.now() - started;
    const count = record.candidates.length;
    if (!Number.isSafeInteger(result.index) || result.index < 0 || result.index >= count
        || !Array.isArray(result.ranking) || result.ranking.length !== count || new Set(result.ranking).size !== count
        || result.ranking.some(index => !Number.isSafeInteger(index) || index < 0 || index >= count)
        || result.ranking[0] !== result.index || !Array.isArray(result.scores) || result.scores.length !== count
        || result.scores.some(score => typeof score !== 'number' || !Number.isFinite(score)))
      throw new Error('entity model must score and rank the complete legal candidate list');
    return result;
  }

  async decide({ view, decisionContext = view.decisionContext ?? {}, context }) {
    const result = await this.infer(encodeEntityDecision(view, { catalog: this.catalog, decisionContext: context ?? decisionContext }));
    return indexedEntityDecision(view, result.index);
  }

  async rankChoices({ view, prompt = view.prompts[0], decisionContext = view.decisionContext ?? {}, context }) {
    const result = await this.infer(encodeEntityDecision(view,
      { catalog: this.catalog, decisionContext: context ?? decisionContext }));
    if (result.ranking.length !== prompt.choices.length) throw new Error('entity ranking must cover complete prompt');
    return result.ranking;
  }

  close(error = new Error('entity model closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.child.exitCode === null) this.child.kill();
  }

  async shutdown() {
    if (!this.closed) { try { await this.request('close'); } catch {} }
    this.close(); await this.exited;
  }
}


