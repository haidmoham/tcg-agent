import { createHash } from 'node:crypto';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sources = new Set(['MatchManager.BattleLogExportData', 'user-exported-battle-log', 'synthetic-fixture']);
const capturePhases = new Set(['live-ui-read', 'terminal-ui-read', 'terminal-ui-presentation-cache']);

function normalizeTerminalReason(value, now) {
  if (value?.schema !== 'official-client-terminal-reason/1' || value.source !== 'BattleOutro.ShowMatchResultOverlay'
      || !['unknown', 'observed'].includes(value.status) || typeof value.terminalObserved !== 'boolean'
      || !(value.localWon === null || typeof value.localWon === 'boolean')
      || !(value.observedAt === null || (Number.isSafeInteger(value.observedAt) && value.observedAt > 0 && value.observedAt <= now))
      || ![ ['reasonLocId', 512], ['text', 2048] ].every(([key, limit]) => value[key] === null
        || (typeof value[key] === 'string' && value[key].length <= limit && !value[key].includes('\0')))
      || (value.terminalObserved && (value.observedAt === null || value.localWon === null))
      || (value.status === 'observed' && (!value.terminalObserved || !(value.reasonLocId || value.text)))) throw new Error('battle-log-terminal-reason-invalid');
  return Object.fromEntries(['schema', 'source', 'status', 'terminalObserved', 'observedAt', 'localWon', 'reasonLocId', 'text'].map(key => [key, value[key]]));
}

export function normalizeBattleLog(value, now = Date.now()) {
  if (value?.schema !== 'official-client-battle-log-export/1' || !sources.has(value.source)
      || !Number.isSafeInteger(value.observedAt) || value.observedAt < 1 || value.observedAt > now
      || !digest(value.matchIdSha256) || typeof value.text !== 'string' || value.text.includes('\0')
      || Buffer.byteLength(value.text) > 1024 * 1024) throw new Error('battle-log-export-invalid');
  const text = value.text.replace(/\r\n/g, '\n');
  if (text.split('\n').length > 10000) throw new Error('battle-log-line-budget');
  if (value.capturePhase !== undefined && !capturePhases.has(value.capturePhase)) throw new Error('battle-log-capture-phase-invalid');
  return { schema: value.schema, source: value.source, observedAt: value.observedAt,
    evidence: value.source === 'synthetic-fixture' ? 'synthetic-fixture' : 'observed-export-text',
    matchIdSha256: value.matchIdSha256, text, textSha256: hash(text),
    ...(value.terminalReason !== undefined ? { terminalReason: normalizeTerminalReason(value.terminalReason, now) } : {}),
    ...(value.capturePhase !== undefined ? { capturePhase: value.capturePhase } : {}) };
}

export function summarizeBattleLog(value, now = Date.now(), maxAgeMs = 5000) {
  if (value?.schema !== 'official-client-battle-log-receipt/1' || !Number.isSafeInteger(value.snapshots)
      || value.snapshots < 0 || !Number.isSafeInteger(value.lines) || value.lines < 0
      || (value.snapshots && (!sources.has(value.source) || !digest(value.textSha256)
        || !Number.isSafeInteger(value.observedAt) || value.observedAt < 1 || value.observedAt > now))) throw new Error('battle-log-receipt-invalid');
  const ageMs = value.snapshots ? now - value.observedAt : null;
  return { schema: value.schema, status: value.snapshots ? 'recorded' : 'waiting',
    assessedAt: now,
    evidence: value.source === 'synthetic-fixture' ? 'synthetic-fixture' : value.snapshots ? 'observed-export-text' : null,
    observedAt: value.snapshots ? value.observedAt : null, ageMs, stale: ageMs === null || ageMs > maxAgeMs,
    source: value.snapshots ? value.source : null, snapshots: value.snapshots, lines: value.lines,
    textSha256: value.snapshots ? value.textSha256 : null, rawTextIncluded: false,
    inferredStateIncluded: false, privateLog: true, inputsEnabled: false };
}

// Each record is a complete observed export, in export order. Changed earlier
// text is retained as a new snapshot, never guessed into a new game action.
export async function createBattleLogRecorder(privateRoot, directory) {
  const base = await realpath(resolve(privateRoot));
  const output = resolve(directory);
  if (await realpath(dirname(output)) !== base) throw new Error('battle-log-private-child-required');
  await mkdir(output, { mode: 0o700 }); // A fresh owned directory; never reuse/truncate.
  const journal = await open(resolve(output, 'exports.jsonl'), 'wx', 0o600);
  let latest = null, snapshots = 0, previous = null, closed = false, queue = Promise.resolve();
  const receipt = () => ({ schema: 'official-client-battle-log-receipt/1', snapshots,
    lines: latest?.text ? latest.text.split('\n').length - Number(latest.text.endsWith('\n')) : 0, observedAt: latest?.observedAt ?? null,
    source: latest?.source ?? null, textSha256: latest?.textSha256 ?? null });
  const saveReceipt = () => writeFile(resolve(output, 'receipt.json'), JSON.stringify(summarizeBattleLog(receipt()), null, 2) + '\n', { mode: 0o600 });
  return {
    receipt,
    record(input) {
      if (closed) return Promise.reject(new Error('battle-log-recorder-closed'));
      const value = normalizeBattleLog(input); // Whitelist/copy before queuing.
      const pending = queue.then(async () => {
        if (latest && value.observedAt < latest.observedAt) throw new Error('battle-log-observation-regressed');
        if (latest && value.matchIdSha256 === latest.matchIdSha256 && value.textSha256 === latest.textSha256 && value.source === latest.source
            && value.capturePhase === latest.capturePhase && JSON.stringify(value.terminalReason) === JSON.stringify(latest.terminalReason)) {
          latest = value; await saveReceipt(); return receipt();
        }
        const record = { ...value, schema: 'official-client-battle-log-record/1', exportSchema: value.schema,
          sequence: snapshots + 1, previousRecordSha256: previous, inferredStateIncluded: false };
        const encoded = JSON.stringify(record);
        await journal.appendFile(encoded + '\n');
        previous = hash(encoded); snapshots++; latest = value;
        await saveReceipt();
        return receipt();
      });
      queue = pending.catch(() => {});
      return pending;
    },
    async close() { if (closed) return; closed = true; try { await queue; await journal.sync(); } finally { await journal.close(); } }
  };
}
