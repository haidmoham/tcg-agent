import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeOrdinaryDecision, indexedOrdinaryDecision, ordinaryFeatureContract } from './learning-features.mjs';

export class NativeModelClient {
  constructor({ executable, checkpoint, seed = 1729, device = 'cuda' }) {
    if (!isAbsolute(executable ?? '') || !isAbsolute(checkpoint ?? '') || !['cpu', 'cuda'].includes(device)
        || !Number.isSafeInteger(seed) || seed < 0) throw new Error('explicit local model executable, checkpoint, device and seed required');
    this.pending = new Map(); this.buffer = ''; this.closed = false; this.sequence = 0;
    this.requests = 0; this.inferenceMilliseconds = 0;
    this.child = spawn(executable, [fileURLToPath(new URL('../../learning/native_torch.py', import.meta.url)), '--device', device, '--seed', String(seed), '--checkpoint', checkpoint],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(accept => { this.child.once('exit', accept); this.child.once('error', accept); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.read(chunk));
    this.child.stderr.on('data', () => {});
    this.child.once('exit', () => this.close(new Error('local model service stopped')));
    this.child.once('error', () => this.close(new Error('local model service unavailable')));
    this.child.stdin.on('error', () => this.close(new Error('local model service input closed')));
  }

  request(op, payload = {}) {
    if (this.closed) return Promise.reject(new Error('model service closed'));
    const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => this.close(new Error('model service reply timed out')), 30000);
      this.pending.set(id, { accept, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...payload, id, op }) + '\n');
    });
  }

  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) return this.close(new Error('model service response exceeded budget'));
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let response;
      try { response = JSON.parse(line); } catch { return this.close(new Error('model service response invalid')); }
      if (!response || typeof response !== 'object' || Array.isArray(response)
          || !Number.isSafeInteger(response.id) || response.id < 1 || typeof response.ok !== 'boolean') return this.close(new Error('model service response invalid'));
      const pending = this.pending.get(response.id);
      if (!pending) return this.close(new Error('model service response uncorrelated'));
      this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.ok !== true) pending.reject(new Error(response.error ?? 'model service rejected request'));
      else pending.accept(response);
    }
  }

  async verify() {
    const info = await this.request('ping');
    if (info.schema !== ordinaryFeatureContract.schema || info.stateDim !== 32 || info.candidateDim !== 27 || !info.checkpoint) throw new Error('model checkpoint feature contract mismatch');
    return info;
  }

  async decide({ view }) {
    const started = performance.now();
    const result = await this.request('infer', encodeOrdinaryDecision(view));
    this.requests++; this.inferenceMilliseconds += performance.now() - started;
    return indexedOrdinaryDecision(view, result.index);
  }

  close(error = new Error('model service closed')) {
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
