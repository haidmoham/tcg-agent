import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Inspect a retained public page offline. This never requests a page or turns
// parser diagnostics into verified player observations or legal alternatives.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node inspect-public-metadata.mjs <saved-page> <fresh-private-output>');
const bytes = await readFile(input);
const html = bytes.toString('utf8');
const attribute = html.match(/data-replay-parse-metadata-value=(["'])(.*?)\1/s);
const decodeAttribute = (value) => value.replace(/&(?:quot|apos|amp|lt|gt|#39|#x[0-9a-f]+|#[0-9]+);/gi, (entity) => {
  const named = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" };
  const normalized = entity.toLowerCase();
  if (named[normalized] !== undefined) return named[normalized];
  return String.fromCodePoint(Number.parseInt(entity.slice(normalized.startsWith('&#x') ? 3 : 2, -1), normalized.startsWith('&#x') ? 16 : 10));
});
const metadata = attribute ? JSON.parse(decodeAttribute(attribute[2])) : null;
const violations = Array.isArray(metadata?.unresolved_violations) ? metadata.unresolved_violations : null;
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const report = {
  schema: 'public-replay-parser-provenance/1',
  sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  metadataPresent: metadata !== null,
  parserReported: {
    resolverVersion: typeof metadata?.resolver_version === 'string' ? metadata.resolver_version : null,
    logIncomplete: typeof metadata?.log_incomplete === 'boolean' ? metadata.log_incomplete : null,
    legacyFormat: typeof metadata?.legacy_format === 'boolean' ? metadata.legacy_format : null,
    violationsObserved: nonnegativeInteger(metadata?.violations_observed),
    unresolvedCount: violations ? violations.length : null,
    unresolvedPositions: violations ? [...new Set(violations.map(v => nonnegativeInteger(v?.triggered_at?.dp_global_position)).filter(v => v !== null))] : null,
    diagnosticsCount: Array.isArray(metadata?.diagnostics) ? metadata.diagnostics.length : null,
  },
  independentBoardVerification: false,
  completeLegalCandidatesPresent: false,
  trainingAdmission: false,
  interpretation: 'Parser-reported provenance only. Absence stays unknown; zero reported violations does not prove board history, action attribution or legal alternatives.',
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(report)}\n`);
