import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseLadderRecords, summarizeLadderRecords } from '../src/ladder-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = readFileSync(new URL('../examples/ladder-records.example.jsonl', import.meta.url), 'utf8');
const base = () => ({ ...structuredClone(JSON.parse(example.trim().split('\n')[0])), dataset: 'actual' });
const parse = record => parseLadderRecords(JSON.stringify(record));
const report = (...records) => summarizeLadderRecords(records);

test('published examples are synthetic and never become actual results', () => {
  const summary = report(...parseLadderRecords(example));
  assert.equal(summary.syntheticRecordsExcluded, 3);
  assert.equal(summary.totals.records, 0);
  assert.deepEqual(summary.ratingSeries, []);
  assert.equal(summary.totals.decisiveWinRate, null);
});

test('outcomes retain draws and unknown disconnects without inventing losses', () => {
  const records = ['win', 'loss', 'draw', 'unknown'].map((outcome, i) => ({ ...base(), id: `record-${i}`, outcome, resultEvidence: outcome === 'unknown' ? 'not-observed' : 'observed-result', disconnected: outcome === 'unknown' }));
  const { totals } = report(...records);
  assert.deepEqual([totals.wins, totals.losses, totals.draws, totals.unknown, totals.disconnected], [1, 1, 1, 1, 1]);
  assert.equal(totals.decisiveWinRate, 0.5);
  assert.ok(totals.decisiveWinRateWilson95[0] < 0.5);
  assert.ok(totals.decisiveWinRateWilson95[1] > 0.5);
  const contradictory = { ...base(), outcome: 'loss', resultEvidence: 'not-observed', disconnected: true };
  assert.throws(() => parse(contradictory), /known outcomes require/);
});

test('observed and inferred opponent identities never share an aggregate', () => {
  const observed = { ...base(), opponentDeck: { status: 'observed', id: 'example-archetype', evidence: 'Complete deck list supplied in user export.' } };
  const inferred = { ...observed, id: 'inferred', opponentDeck: { ...observed.opponentDeck, status: 'inferred', evidence: 'Guess from three revealed cards.' } };
  const unknown = { ...base(), id: 'unknown', opponentDeck: { status: 'unknown' } };
  const { opponents } = report(observed, inferred, unknown);
  assert.equal(opponents.observed[0].records, 1);
  assert.equal(opponents.inferred[0].records, 1);
  assert.equal(opponents.unknown.records, 1);
  assert.throws(() => parse({ ...unknown, opponentDeck: { status: 'unknown', id: 'guess' } }), /must not contain/);
  assert.throws(() => parse({ ...observed, opponentDeck: { status: 'observed', id: 'guess' } }), /evidence/);
});

test('different metrics and seasons have separate observed peaks', () => {
  const first = base();
  const progressive = { ...base(), id: 'progressive', rating: { ...base().rating, metric: 'progressive_elo', after: { ...base().rating.after, value: 2500 } } };
  const nextSeason = { ...base(), id: 'next-season', season: 'synthetic-next-season', rating: { ...base().rating, after: { ...base().rating.after, value: 1800 } } };
  const summary = report(first, progressive, nextSeason);
  assert.equal(summary.ratingSeries.length, 3);
  assert.equal(summary.ratingSeries.find(series => series.metric === 'progressive_elo').peakObservedRating, 2500);
  assert.equal(summary.ratingSeries.find(series => series.season === 'synthetic-next-season').peakObservedRating, 1800);
});

test('policy, deck, patch and pilot provenance retain distinct strata', () => {
  const records = [base(), { ...base(), id: 'policy', policy: { ...base().policy, version: 'v2' } }, { ...base(), id: 'deck', playedDeck: { ...base().playedDeck, version: 'v2', hash: 'b'.repeat(64) } }, { ...base(), id: 'patch', patch: 'synthetic-patch-v2' }, { ...base(), id: 'pilot', pilot: 'authorized-agent' }];
  assert.equal(report(...records).strata.length, 5);
  assert.equal(report(...records).totals.records, 5);
});

test('peaks include observed before values and latest uses timestamps, not input order', () => {
  const old = base();
  old.rating.before.value = 1900;
  old.rating.after.value = 1850;
  const recent = { ...base(), id: 'recent', observedAt: '2026-10-20T12:01:00.000Z', rating: { metric: 'competitive_elo', before: null, after: { value: 1700, observedAt: '2026-10-20T12:00:00.000Z' } } };
  const summary = report(recent, old);
  assert.equal(summary.ratingSeries[0].peakObservedRating, 1900);
  assert.equal(summary.ratingSeries[0].latestObservedRating, 1700);
  assert.equal(summary.ratingSeries[0].peakObservedAt, old.rating.before.observedAt);
  assert.equal(report({ ...base(), rating: null }).ratingSeries[0].peakObservedRating, null);
});

test('conflicting observations at latest timestamp are flagged without choosing a rating', () => {
  const first = base(), second = { ...base(), id: 'conflict' };
  second.rating.after.value += 10;
  const series = report(first, second).ratingSeries[0];
  assert.equal(series.conflictingLatestObservations, true);
  assert.equal(series.latestObservedRating, null);
});

test('invalid dates, impossible calendar dates and reversed rating chronology fail', () => {
  for (const observedAt of ['yesterday', '2026-02-30T12:00:00.000Z', '2026-10-19', '2026-10-19T12:00:00Z']) assert.throws(() => parse({ ...base(), observedAt }), /timestamp/);
  const reversed = base();
  reversed.rating.before.observedAt = '2026-10-19T12:00:01.000Z';
  assert.throws(() => parse(reversed), /after/);
  const future = base();
  future.rating.after.observedAt = '2026-10-20T12:00:00.000Z';
  assert.throws(() => parse(future), /after the record/);
});

test('nonfinite ratings, malformed provenance and unsolicited fields fail validation', () => {
  for (const value of [NaN, Infinity, -1, '1800', null]) {
    const record = base();
    record.rating.after.value = value;
    assert.throws(() => report(record), /finite nonnegative/);
  }
  assert.throws(() => parse({ ...base(), username: 'private' }), /not allowed/);
  assert.throws(() => parse({ ...base(), counts: NaN }), /not allowed/);
  assert.throws(() => parse({ ...base(), policy: { ...base().policy, commit: 'main' } }), /hexadecimal/);
  assert.throws(() => parse({ ...base(), playedDeck: { ...base().playedDeck, hash: 'deck-name' } }), /hexadecimal/);
  assert.throws(() => parse({ ...base(), pilot: 'bot' }), /pilot/);
  assert.throws(() => parse({ ...base(), source: 'live-api' }), /source/);
  assert.throws(() => parse({ ...base(), rating: { metric: 'competitive_elo', before: null, after: null } }), /at least one observed/);
  const missing = base();
  delete missing.dataset;
  assert.throws(() => parse(missing), /dataset/);
  const missingPoint = base();
  delete missingPoint.rating.before;
  assert.throws(() => parse(missingPoint), /rating.before/);
});

test('duplicates and malformed JSON fail the whole import with line diagnostics', () => {
  const line = JSON.stringify(base());
  assert.throws(() => parseLadderRecords(`${line}\n${line}`), /line 2: duplicate/);
  assert.throws(() => parseLadderRecords(`${line}\n{`), /line 2:/);
  assert.throws(() => report(base(), base()), /duplicate/);
  assert.equal(parseLadderRecords(`\n${line}\n\n`).length, 1);
});

test('summary does not mutate user records', () => {
  const record = base(), snapshot = structuredClone(record);
  report(record);
  assert.deepEqual(record, snapshot);
});

test('CLI validates the actual synthetic example without writing by default', () => {
  const result = spawnSync(process.execPath, ['scripts/ladder-records.mjs', 'examples/ladder-records.example.jsonl'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).syntheticRecordsExcluded, 3);
});

test('CLI refuses publication paths and preserves existing output', () => {
  const outside = resolve(root, 'docs', 'must-not-write.json');
  const blocked = spawnSync(process.execPath, ['scripts/ladder-records.mjs', 'examples/ladder-records.example.jsonl', '--output', outside], { cwd: root, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.equal(existsSync(outside), false);
  const output = resolve(root, 'runs', `ladder-test-${process.pid}.json`);
  mkdirSync(resolve(root, 'runs'), { recursive: true });
  writeFileSync(output, 'preserve this private record');
  const existing = spawnSync(process.execPath, ['scripts/ladder-records.mjs', 'examples/ladder-records.example.jsonl', '--output', output], { cwd: root, encoding: 'utf8' });
  assert.equal(existing.status, 1);
  assert.equal(readFileSync(output, 'utf8'), 'preserve this private record');
  unlinkSync(output);
});

test('CLI saves a requested report inside runs without copying raw records', () => {
  const output = resolve(root, 'runs', `ladder-report-test-${process.pid}.json`);
  const result = spawnSync(process.execPath, ['scripts/ladder-records.mjs', 'examples/ladder-records.example.jsonl', '--output', output], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(saved.schema, 'ladder-summary-v1');
  assert.equal(saved.syntheticRecordsExcluded, 3);
  assert.equal(saved.totals.records, 0);
  assert.equal(saved.records, undefined);
  unlinkSync(output);
});
