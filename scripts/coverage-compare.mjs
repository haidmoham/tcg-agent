import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalPrinting, CoverageError } from './coverage-audit.mjs';

export function compareSourceInventory(catalog, upstream, aliases) {
  if (aliases.catalogCommit !== catalog.source.commit || aliases.upstreamCommit !== upstream.commit) throw new CoverageError('set aliases do not match pinned inventories');
  const index = new Map();
  const unresolved = [];
  for (const [sourceRow, row] of upstream.rows.entries()) {
    const set = aliases.sets[row.set];
    if (!set || !row.setNumber) { unresolved.push({ sourceRow, reason: !set ? 'unreviewed-set-alias' : 'nonliteral-collector-number' }); continue; }
    let id;
    try { id = canonicalPrinting(set, row.setNumber); }
    catch { unresolved.push({ sourceRow, reason: 'noncanonical-identity' }); continue; }
    if (!index.has(id)) index.set(id, []);
    index.get(id).push({ path: row.path, className: row.className, sha256: row.sha256, regulationMark: row.regulationMark });
  }
  const rows = catalog.cards.map(card => {
    const matches = index.get(card.id) ?? [];
    return { id: card.id, regulationMark: card.regulationMark, status: matches.length ? 'script-present-unverified' : 'no-literal-script-match', matches };
  });
  const candidates = rows.filter(row => ['H', 'I', 'J'].includes(row.regulationMark));
  return {
    schemaVersion: 1, asOf: catalog.asOf, profileId: catalog.profileId,
    catalogCommit: catalog.source.commit, upstream: upstream.upstream, upstreamCommit: upstream.commit,
    identityBasis: 'Reviewed set-code alias plus normalized exact collector number. No name or fullName joins. Script presence is not legality, exported engine registration, complete card semantics or test coverage. Unresolved sourceRow is a zero-based index into the pinned upstream inventory, including historical out-of-scope classes.',
    counts: { catalogPrintings: rows.length, markCandidates: candidates.length,
      candidatesWithLiteralScriptMatch: candidates.filter(row => row.matches.length).length,
      candidatesWithoutLiteralScriptMatch: candidates.filter(row => !row.matches.length).length,
      unresolvedUpstreamClasses: unresolved.length, verifiedStandardPrintings: 0 },
    rows, unresolved
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [catalog, upstream, aliases] = await Promise.all([
    'coverage/standard-2026-10-19.json', 'integrations/twinleaf/source-inventory.json', 'coverage/set-aliases.json'
  ].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const comparison = compareSourceInventory(catalog, upstream, aliases);
  await writeFile('coverage/twinleaf-comparison.json', `${JSON.stringify(comparison, null, 2)}\n`);
  console.log(JSON.stringify(comparison.counts, null, 2));
}
