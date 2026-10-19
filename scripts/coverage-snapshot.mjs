import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { canonicalPrinting, auditCoverage, STANDARD_PROFILE } from './coverage-audit.mjs';

const commit = 'cbddf7e54033b1b58e44af1049c88832e55b94d0';
const root = resolve(process.argv[2] ?? '.cache/tcgdex');
const output = process.argv[3] ?? 'coverage/standard-2026-10-19.json';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8_000_000 }).trim();
if (git('rev-parse', 'HEAD') !== commit) throw new Error('catalog checkout does not match pinned commit');
if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('catalog checkout has modified tracked source');
const tree = git('ls-tree', '-r', '-z', commit, '--', 'data/Scarlet & Violet', 'data/Mega Evolution').split('\0').filter(Boolean).map(line => {
  const [header, path] = line.split('\t');
  return { path, blob: header.split(' ')[2] };
}).sort((a, b) => a.path.localeCompare(b.path, 'en'));
const sources = new Map();
for (const item of tree) sources.set(item.path, await readFile(resolve(root, item.path), 'utf8'));
function literal(text, key) {
  const values = [...text.matchAll(new RegExp(`\\b${key}\\s*:\\s*["']([^"']+)["']`, 'g'))];
  return values.length === 1 ? values[0][1] : null;
}
const sets = new Map();
for (const item of tree.filter(item => item.path.split('/').length === 3)) {
  const text = sources.get(item.path);
  const id = literal(text, 'id');
  if (!id) throw new Error(`missing unique literal set ID ${item.path}`);
  sets.set(item.path.slice(0, -3), { id, sourceBlob: item.blob, sourcePath: item.path, releaseDate: literal(text, 'releaseDate') });
}
const cards = [];
for (const item of tree.filter(item => item.path.split('/').length === 4 && item.path.endsWith('.ts'))) {
  const set = sets.get(dirname(item.path).replaceAll('\\', '/'));
  if (!set) throw new Error(`missing set for ${item.path}`);
  const number = basename(item.path, '.ts');
  const text = sources.get(item.path);
  const direct = !/\.\.\./.test(text);
  const sourceMark = direct ? literal(text, 'regulationMark') : null;
  cards.push({
    id: canonicalPrinting(set.id, number), set: set.id, number: number.replace(/^0+(?=\d)/, '').toUpperCase(),
    sourcePath: item.path, sourceBlob: item.blob,
    regulationMark: sourceMark && /^[a-z]$/i.test(sourceMark) ? sourceMark.toUpperCase() : null,
    category: direct ? literal(text, 'category') : null,
    sourceEnergyType: direct ? literal(text, 'energyType') : null,
    legality: { status: 'unknown', evidence: [] },
    mechanicsReview: 'unreviewed', requiredMechanics: [],
    implementation: { status: 'unsupported', evidence: [] }
  });
}
cards.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const mechanics = JSON.parse(await readFile('coverage/mechanics.json', 'utf8'));
const manifest = {
  schemaVersion: 1, profileId: STANDARD_PROFILE, asOf: '2026-10-19',
  backend: { id: 'reference-kernel', version: '0.1.0' },
  source: { repository: 'https://github.com/tcgdex/cards-database', commit, reviewedAt: '2026-10-19', license: 'MIT', licenseFile: 'coverage/TCGdex-LICENSE',
    scope: ['data/Scarlet & Violet', 'data/Mega Evolution'], extractor: 'scripts/coverage-snapshot.mjs' },
  completeness: { status: 'incomplete', legalPrintingCount: null, evidence: [],
    missing: ['Older equivalent reprints and errata adjudication', 'Promo and Basic Energy sources outside selected eras', 'Exact Live release availability and temporary restrictions', 'Independent full Standard printing enumeration', 'Mechanic requirements and correctness proofs for every admitted printing'] },
  sets: [...sets.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')), mechanics, cards
};
const report = auditCoverage(manifest);
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, ...report }, null, 2));
