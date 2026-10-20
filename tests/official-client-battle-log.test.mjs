import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeBattleLog, summarizeBattleLog, createBattleLogRecorder } from '../integrations/official-client/battle-log.mjs';
import { startObservationService } from '../integrations/official-client/observation-service.mjs';

const fixture = (text = 'Player A turn\r\nPlayer A drew a card.\r\n- A visible effect resolved.\r\n\r\n', observedAt = Date.now()) => ({
  schema: 'official-client-battle-log-export/1', source: 'synthetic-fixture', observedAt,
  matchIdSha256: 'a'.repeat(64), text, forbiddenAccountField: 'must-not-persist' });
const hash = value => createHash('sha256').update(value).digest('hex');

test('export projection preserves text order, evidence and line endings without interpreting game state', () => {
  const result = normalizeBattleLog(fixture());
  assert.equal(result.text, 'Player A turn\nPlayer A drew a card.\n- A visible effect resolved.\n\n');
  assert.equal(result.evidence, 'synthetic-fixture');
  assert.equal(result.textSha256, hash(result.text));
  assert.ok(!JSON.stringify(result).includes('must-not-persist'));
  for (const change of [v => v.source = 'raw-network-operation', v => v.observedAt += 100000,
    v => v.matchIdSha256 = 'raw-account-id', v => v.text += '\0', v => v.text = 'x'.repeat(1024 * 1024 + 1)]) {
    const value = fixture(); change(value); assert.throws(() => normalizeBattleLog(value), /battle-log/);
  }
});

test('private journal retains append and earlier-entry edits, deduplicates snapshots and chains provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tcg-battle-log-'));
  let recorder;
  try {
    recorder = await createBattleLogRecorder(root, join(root, 'owned-run'));
    const now = Date.now() - 100;
    const first = fixture('Turn 1\nDrew a card.\n', now);
    await Promise.all([recorder.record(first), recorder.record({ ...first, observedAt: now + 1 })]);
    await recorder.record(fixture('Turn 1\nDrew a card.\nAttached Energy.\n', now + 2));
    await recorder.record(fixture('Turn 1\nDrew two cards.\nAttached Energy.\n', now + 3));
    await assert.rejects(recorder.record(fixture('old capture', now - 1)), /regressed/);
    await recorder.close();
    const lines = (await readFile(join(root, 'owned-run/exports.jsonl'), 'utf8')).trimEnd().split('\n');
    const records = lines.map(JSON.parse);
    assert.ok(records.every(value => value.schema === 'official-client-battle-log-record/1' && value.exportSchema === 'official-client-battle-log-export/1'));
    assert.deepEqual(records.map(value => value.sequence), [1, 2, 3]);
    assert.equal(records[0].previousRecordSha256, null);
    assert.equal(records[1].previousRecordSha256, hash(lines[0]));
    assert.equal(records[2].previousRecordSha256, hash(lines[1]));
    assert.equal(records[2].text, 'Turn 1\nDrew two cards.\nAttached Energy.\n');
    assert.ok(records.every(value => value.inferredStateIncluded === false));
    assert.ok(!lines.join('').includes('must-not-persist'));
    const receipt = JSON.parse(await readFile(join(root, 'owned-run/receipt.json')));
    assert.equal(receipt.snapshots, 3);
    assert.equal(receipt.rawTextIncluded, false);
    assert.ok(!JSON.stringify(receipt).includes('Player A'));
    await assert.rejects(createBattleLogRecorder(root, join(root, 'owned-run')));
    await assert.rejects(recorder.record(first), /closed/);
    await assert.rejects(createBattleLogRecorder(root, join(root, '../outside-root')), /private-child/);
  } finally {
    await recorder?.close();
    if (!root.startsWith(join(tmpdir(), 'tcg-battle-log-'))) throw new Error('unexpected-test-cleanup-path');
    await rm(root, { recursive: true, force: true });
  }
});

test('receipt whitelist excludes raw text, identities and paths and reports stale evidence honestly', () => {
  const value = { schema: 'official-client-battle-log-receipt/1', snapshots: 1, lines: 3, observedAt: 10000,
    source: 'synthetic-fixture', textSha256: 'b'.repeat(64), text: 'private-log-text', path: 'private-path', matchId: 'private-id' };
  const result = summarizeBattleLog(value, 16000);
  assert.equal(result.stale, true);
  assert.equal(result.evidence, 'synthetic-fixture');
  assert.equal(result.inferredStateIncluded, false);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('service logs independently of screenshot failure and serves only the sanitized receipt', async () => {
  const receipt = { schema: 'official-client-battle-log-receipt/1', snapshots: 1, lines: 2, observedAt: Date.now(),
    source: 'synthetic-fixture', textSha256: 'c'.repeat(64), text: 'private-export' };
  const service = await startObservationService({ observe: async () => { throw new Error('capture missing'); },
    readBattleLog: async () => receipt, intervalMs: 100, lifespanMs: 2000 });
  try {
    const response = await fetch(service.url + '/battle-log');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.snapshots, 1);
    assert.ok(!JSON.stringify(result).includes('private-export'));
    assert.equal((await fetch(service.url + '/observation')).status, 503);
    assert.equal((await fetch(service.url + '/battle-log', { method: 'POST' })).status, 405);
    assert.equal((await fetch(service.url + '/battle-log', { headers: { Origin: 'http://example.test' } })).status, 403);
  } finally { await service.stop(); }
});

test('service invalidates unavailable log receipt and does not echo arbitrary errors', async () => {
  const service = await startObservationService({ observe: async () => { throw new Error(); },
    readBattleLog: async () => { throw new Error('private-export-error'); }, intervalMs: 100, lifespanMs: 2000 });
  try {
    const response = await fetch(service.url + '/battle-log');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'battle-log-unavailable', inputsEnabled: false });
  } finally { await service.stop(); }
});
