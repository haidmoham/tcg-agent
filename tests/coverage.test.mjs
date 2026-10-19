import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditCoverage, assertDeckCovered, canonicalPrinting, STANDARD_PROFILE, CoverageError } from '../scripts/coverage-audit.mjs';
import { compareSourceInventory } from '../scripts/coverage-compare.mjs';

const snapshot = JSON.parse(await readFile(new URL('../coverage/standard-2026-10-19.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(snapshot);

test('coverage reports incomplete Standard and admits no unverified printing', () => {
  const report = auditCoverage(snapshot);
  assert.equal(report.fullStandardReady, false);
  assert.equal(report.counts.verifiedPlayable, 0);
  assert.ok(report.counts.printings > 4000);
  assert.ok(report.counts.markCandidates > 2000);
  assert.throws(() => assertDeckCovered(snapshot, ['me01:1']), /unsupported or unverified/);
  assert.throws(() => assertDeckCovered(snapshot, ['invented:1']), /unsupported or unverified/);
});

test('effect-bearing catalog Energy metadata never grants Basic Energy semantics', () => {
  const card = snapshot.cards.find(card => card.id === 'me05:84');
  assert.equal(card.sourceEnergyType, 'Normal');
  assert.equal(card.mechanicsReview, 'unreviewed');
  assert.equal(card.legality.status, 'unknown');
  assert.throws(() => assertDeckCovered(snapshot, [card.id]), /unsupported or unverified/);
  for (const row of snapshot.cards) {
    assert.equal('effect' in row || 'attacks' in row || 'image' in row || 'name' in row, false);
  }
});

test('unknown profile, schema, and stale source fail closed', () => {
  assert.throws(() => auditCoverage(snapshot, { profileId: 'standard' }), /unknown or mismatched/);
  assert.throws(() => auditCoverage(snapshot, { asOf: '2026-10-20' }), /exact as-of/);
  const stale = copy(); stale.source.reviewedAt = '2026-10-01';
  assert.throws(() => auditCoverage(stale), /stale/);
  const schema = copy(); schema.schemaVersion = 42;
  assert.throws(() => auditCoverage(schema), /schema/);
});

test('printing identity uses set and collector number, never names', () => {
  assert.equal(canonicalPrinting('sv05', '011'), 'sv05:11');
  assert.equal(canonicalPrinting('smp', 'SM085'), 'smp:SM085');
  const duplicate = copy(); duplicate.cards.push(structuredClone(duplicate.cards[0]));
  assert.throws(() => auditCoverage(duplicate), /duplicate/);
  const alternate = copy(); alternate.cards[0].number = `0${alternate.cards[0].number}`;
  alternate.cards.push(structuredClone(alternate.cards[0]));
  assert.throws(() => auditCoverage(alternate), /duplicate/);
});

test('a script or card verification cannot bypass required mechanics', () => {
  const data = copy(); const card = data.cards[0];
  card.implementation = { status: 'script-present-unverified', evidence: ['upstream/example.ts'] };
  assert.equal(auditCoverage(data).counts.scriptPresent, 1);
  assert.throws(() => assertDeckCovered(data, [card.id]), CoverageError);
  card.implementation.status = 'verified';
  assert.throws(() => auditCoverage(data), /legality\/mechanics/);
  card.legality = { status: 'legal', evidence: ['test fixture, not a real legality ruling'] };
  card.mechanicsReview = 'reviewed';
  card.requiredMechanics = ['typed-energy-payment'];
  assert.throws(() => auditCoverage(data), /coverage mismatch/);
  card.requiredMechanics = ['invented-mechanic'];
  assert.throws(() => auditCoverage(data), /unregistered mechanic/);
});

test('completeness and legality claims require evidence and matching counts', () => {
  const data = copy(); data.completeness.status = 'verified';
  assert.throws(() => auditCoverage(data), /enumeration evidence/);
  data.completeness.evidence = ['test fixture']; data.completeness.legalPrintingCount = 999;
  assert.throws(() => auditCoverage(data), /count mismatch/);
  const legal = copy(); legal.cards[0].legality.status = 'legal';
  assert.throws(() => auditCoverage(legal), /decision lacks evidence/);
  assert.equal(auditCoverage(snapshot).profileId, STANDARD_PROFILE);
});

test('upstream class joins require pinned aliases and literal printing identity', () => {
  const aliases = { catalogCommit: snapshot.source.commit, upstreamCommit: 'test-upstream', sets: { MEG: 'me01' } };
  const upstream = { commit: 'test-upstream', rows: [
    { set: 'MEG', setNumber: '001', className: 'A', path: 'a.ts', sha256: 'test' },
    { set: 'MEG', setNumber: null, className: 'B', fullName: 'Bulbasaur MEG', path: 'b.ts' },
    { set: 'M1L', setNumber: '1', className: 'C', path: 'c.ts' }
  ] };
  const report = compareSourceInventory(snapshot, upstream, aliases);
  assert.equal(report.rows.find(row => row.id === 'me01:1').matches.length, 1);
  assert.equal(report.rows.find(row => row.id === 'me01:1').status, 'script-present-unverified');
  assert.equal(report.counts.verifiedStandardPrintings, 0);
  assert.equal(report.unresolved.length, 2);
  assert.throws(() => compareSourceInventory(snapshot, upstream, { ...aliases, catalogCommit: 'wrong' }), /pinned inventories/);
});
