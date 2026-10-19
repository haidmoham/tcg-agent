import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const STANDARD_PROFILE = 'live-standard-2026-10-19';
const day = 86_400_000;
const statuses = new Set(['unsupported', 'script-present-unverified', 'verified']);

export class CoverageError extends Error {
  constructor(message) { super(message); this.name = 'CoverageError'; }
}

function requireValue(condition, message) {
  if (!condition) throw new CoverageError(message);
}

function date(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'expected ISO calendar date');
  const time = Date.parse(`${value}T00:00:00Z`);
  requireValue(Number.isFinite(time) && new Date(time).toISOString().startsWith(value), 'invalid calendar date');
  return time;
}

export function canonicalPrinting(set, number) {
  requireValue(typeof set === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(set), 'invalid catalog set ID');
  requireValue(typeof number === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(number), 'invalid collector number');
  const normalized = number.replace(/^0+(?=\d)/, '').toUpperCase();
  return `${set}:${normalized}`;
}

export function auditCoverage(manifest, { profileId = STANDARD_PROFILE, asOf = manifest?.asOf } = {}) {
  requireValue(profileId === STANDARD_PROFILE && manifest?.profileId === profileId, 'unknown or mismatched rules profile');
  requireValue(manifest.schemaVersion === 1, 'unknown coverage schema version');
  const requested = date(asOf);
  const checked = date(manifest.asOf);
  requireValue(requested === checked, 'coverage only establishes its exact as-of date');
  requireValue(manifest.source?.repository === 'https://github.com/tcgdex/cards-database', 'unknown catalog source');
  requireValue(/^[0-9a-f]{40}$/.test(manifest.source.commit), 'catalog must pin a full commit SHA');
  const observed = date(manifest.source.reviewedAt);
  requireValue(requested >= observed && requested - observed <= 7 * day, 'catalog source is stale or from the future');
  requireValue(manifest.source.license === 'MIT', 'catalog license not reviewed');
  requireValue(Array.isArray(manifest.cards) && Array.isArray(manifest.mechanics), 'missing cards or mechanics matrix');
  requireValue(['unknown', 'incomplete', 'verified'].includes(manifest.completeness?.status), 'unknown completeness status');
  const mechanics = new Map();
  for (const mechanic of manifest.mechanics) {
    requireValue(typeof mechanic.id === 'string' && !mechanics.has(mechanic.id), 'duplicate or missing mechanic ID');
    requireValue(statuses.has(mechanic.status), `unknown mechanic coverage for ${mechanic.id}`);
    requireValue(Array.isArray(mechanic.evidence), `missing mechanic evidence for ${mechanic.id}`);
    if (mechanic.status === 'verified') requireValue(mechanic.evidence.length > 0, `verified mechanic lacks evidence ${mechanic.id}`);
    mechanics.set(mechanic.id, mechanic);
  }
  const ids = new Set();
  const counts = { printings: 0, markCandidates: 0, legalityVerified: 0, legalityUnknown: 0, excluded: 0, scriptPresent: 0, verifiedPlayable: 0 };
  for (const card of manifest.cards) {
    const id = canonicalPrinting(card.set, card.number);
    requireValue(card.id === id && !ids.has(id), `duplicate or noncanonical printing ${id}`);
    ids.add(id);
    requireValue(/^[0-9a-f]{40}$/.test(card.sourceBlob), `missing source blob for ${id}`);
    requireValue(['H', 'I', 'J', null].includes(card.regulationMark) || /^[A-Z]$/.test(card.regulationMark), `unknown regulation mark ${id}`);
    requireValue(['legal', 'illegal', 'unknown'].includes(card.legality?.status), `unknown legality ${id}`);
    requireValue(Array.isArray(card.legality.evidence), `missing legality evidence ${id}`);
    if (card.legality.status !== 'unknown') requireValue(card.legality.evidence.length > 0, `legality decision lacks evidence ${id}`);
    requireValue(statuses.has(card.implementation?.status), `unknown implementation status ${id}`);
    requireValue(Array.isArray(card.implementation.evidence) && Array.isArray(card.requiredMechanics), `missing implementation evidence ${id}`);
    requireValue(['reviewed', 'unreviewed'].includes(card.mechanicsReview), `unknown mechanics review ${id}`);
    requireValue(card.requiredMechanics.every(m => mechanics.has(m)), `unregistered mechanic for ${id}`);
    if (card.implementation.status === 'verified') {
      requireValue(card.legality.status === 'legal' && card.mechanicsReview === 'reviewed', `verified card lacks legality/mechanics review ${id}`);
      requireValue(card.implementation.evidence.length > 0 && card.requiredMechanics.length > 0, `verified card lacks correctness evidence ${id}`);
      requireValue(card.requiredMechanics.every(m => mechanics.get(m).status === 'verified'), `card/mechanic coverage mismatch ${id}`);
    }
    counts.printings++;
    if (['H', 'I', 'J'].includes(card.regulationMark)) counts.markCandidates++;
    if (card.legality.status === 'legal') counts.legalityVerified++;
    if (card.legality.status === 'unknown') counts.legalityUnknown++;
    if (card.legality.status === 'illegal') counts.excluded++;
    if (card.implementation.status === 'script-present-unverified') counts.scriptPresent++;
    if (card.implementation.status === 'verified') counts.verifiedPlayable++;
  }
  const blockers = [];
  if (manifest.completeness.status !== 'verified') blockers.push('Full Standard printing denominator has not been independently verified.');
  else {
    requireValue(Array.isArray(manifest.completeness.evidence) && manifest.completeness.evidence.length > 0, 'complete catalog lacks enumeration evidence');
    requireValue(manifest.completeness.legalPrintingCount === counts.legalityVerified && counts.legalityVerified > 0, 'complete catalog count mismatch');
  }
  if (counts.legalityUnknown) blockers.push(`${counts.legalityUnknown} printings require exact legality and availability adjudication.`);
  if (counts.legalityVerified > counts.verifiedPlayable) blockers.push(`${counts.legalityVerified - counts.verifiedPlayable} legal printings lack verified executable mechanics.`);
  if (!counts.verifiedPlayable) blockers.push('No Standard printing is verified playable by this backend.');
  return { profileId, asOf, backend: manifest.backend, counts, fullStandardReady: blockers.length === 0, blockers };
}

export function assertDeckCovered(manifest, printings, options) {
  auditCoverage(manifest, options);
  requireValue(Array.isArray(printings) && printings.length > 0, 'deck requires exact printing IDs');
  const cards = new Map(manifest.cards.map(card => [card.id, card]));
  for (const id of printings) {
    const card = cards.get(id);
    requireValue(card && card.implementation.status === 'verified' && card.legality.status === 'legal', `unsupported or unverified Standard printing ${id}`);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? 'coverage/standard-2026-10-19.json';
  try {
    const report = auditCoverage(JSON.parse(await readFile(file, 'utf8')));
    console.log(JSON.stringify(report, null, 2));
    if (process.argv.includes('--require-full') && !report.fullStandardReady) process.exitCode = 2;
  } catch (error) {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}
