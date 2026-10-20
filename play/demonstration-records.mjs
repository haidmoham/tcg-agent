import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function appendDurable(file, record) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function ownRecordsRoot(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'server-owner.json'), token = `${process.pid}-${Date.now()}`;
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    try { process.kill(previous.pid, 0); throw new Error('A server already owns these demonstration records. Use its existing localhost URL.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    // Only a confirmed exited owner permits crash recovery.
    fs.renameSync(file, path.join(root, `exited-owner-${previous.token}.json`));
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
  return () => {
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
  };
}

// A missing game-ended event means interruption, never an inferred loss or draw.
export function recoverInterrupted(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    let records;
    try { records = lines.map(JSON.parse); }
    catch { // Retain torn data verbatim and flag it in a separate file.
      fs.writeFileSync(path.join(root, entry.name, 'recovery-warning.json'), JSON.stringify({
        interruptionStatus: 'uncertain', eligibleForPpo: false, reason: 'Incomplete append; events.jsonl preserved verbatim', at: new Date().toISOString() }));
      continue;
    }
    if (records.some(r => r.type === 'game-ended')) continue;
    const last = records.at(-1);
    appendDurable(file, { schema: 'human-demonstration-event/1', gameId: last.gameId, sequence: last.sequence + 1,
      at: new Date().toISOString(), type: 'game-ended', outcome: null, interruptionStatus: 'interrupted',
      reason: 'server-restarted-before-terminal', eligibleForPpo: false });
  }
}

export class DemonstrationJournal {
  constructor(root, gameId, pins, provenance) {
    this.directory = path.join(root, gameId);
    fs.mkdirSync(this.directory, { recursive: true });
    this.file = path.join(this.directory, 'events.jsonl');
    this.gameId = gameId; this.sequence = 0; this.ended = false;
    this.manifestSha256 = digest(pins);
    fs.writeFileSync(path.join(this.directory, 'manifest.json'), JSON.stringify({
      schema: 'human-demonstration-manifest/1', gameId, provenance, pins, pinsSha256: this.manifestSha256,
      purpose: 'later-imitation-learning', humanBehaviorLogProbability: null, eligibleForPpo: false,
    }, null, 2) + '\n', { flag: 'wx' });
    this.event('game-started', { provenance, interruptionStatus: 'in-progress', eligibleForPpo: false });
  }
  event(type, data = {}) {
    appendDurable(this.file, { schema: 'human-demonstration-event/1', gameId: this.gameId,
      sequence: this.sequence++, at: new Date().toISOString(), pinsSha256: this.manifestSha256, type, ...data });
  }
  end(outcome, reason) {
    if (this.ended) return;
    this.event('game-ended', { outcome, reason, interruptionStatus: outcome ? 'completed' : 'interrupted', eligibleForPpo: false });
    this.ended = true;
  }
}
