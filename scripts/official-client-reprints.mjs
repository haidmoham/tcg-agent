import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../integrations/official-client/compatibility.mjs';

const root = process.argv[2];
if (!root || process.argv.length !== 3) throw new Error('usage: node scripts/official-client-reprints.mjs local-research-root');
const bytes = await readFile(join(root, 'network-recon/card-corpus-v1/cards.jsonl'));
const manifest = JSON.parse(await readFile(join(root, 'runtime-program-bundle-v1/manifest.json')));
if (sha256(bytes) !== manifest.fullCorpus?.sha256) throw new Error('captured-corpus-pin-mismatch');
const corpus = new Map(bytes.toString('utf8').split('\n').filter(Boolean).map(line => { const card = JSON.parse(line); return [card.cardSourceID, card]; }));
const pinned = JSON.parse(await readFile(join(root, 'runtime-program-bundle-v1/cardData.json')));
const pairs = [
  ['ASC-158', 'me2-5_158', 'TWM-128', 'sv6_128'],
  ['ASC-159', 'me2-5_159', 'TWM-129', 'sv6_129'],
  ['ASC-160', 'me2-5_160', 'TWM-130', 'sv6_130'],
  ['ASC-99', 'me2-5_99', 'TWM-95', 'sv6_95'],
  ['JTG-120', 'sv9_120', 'TEF-128', 'sv5_128'],
  ['ASC-184', 'me2-5_184', 'TEF-144', 'sv5_144'],
  ['MEE-2', 'mee_2', 'MEE-10', 'mee_10'],
  ['MEE-7', 'mee_7', 'MEE-15', 'mee_15'],
  ['MEE-5', 'mee_5', 'MEE-13', 'mee_13']
];
const ignored = new Set(['cardSourceID', 'logicSourceID', 'releaseDate', 'actionGuid']);
const mechanics = value => Array.isArray(value) ? value.map(mechanics) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(key => !ignored.has(key)).sort().map(key => [key, mechanics(value[key])])) : value;
const report = pairs.map(([printing, source, candidatePrinting, candidateSource]) => {
  const exact = corpus.get(source), existing = pinned.find(card => card.cardSourceID === candidateSource);
  const a = exact && mechanics(exact), b = existing && mechanics(existing);
  const same = Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
  const differingFields = a && b ? [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key])) : [];
  return { printing, candidatePrinting, capturedExactProgramPresent: Boolean(exact), pinnedCandidatePresent: Boolean(existing),
    capturedMechanicsIdentical: same, differingFields, exactMechanicsSha256: a ? sha256(JSON.stringify(a)) : null,
    candidateMechanicsSha256: b ? sha256(JSON.stringify(b)) : null,
    classification: same ? 'captured-reprint-equivalence' : exact ? 'different-version-or-unverified-equivalence' : 'exact-program-unavailable',
    admissionGranted: false };
});
process.stdout.write(`${JSON.stringify({ schema: 'official-client-reprint-audit/1', corpusSha256: sha256(bytes),
  method: 'Compare all captured official static card fields recursively, excluding only printing source ID, logic source ID, release date and per-instance action GUID. Card archetype, names, stats, typing, properties, attacks, abilities, conditions, effect trees and action source IDs remain in comparison.',
  scope: 'Static mechanics evidence only. Regulation/legality and official UI mappings remain separate. No captured programs are exported. Exact historical manifest is unchanged.',
  cards: report }, null, 2)}\n`);
