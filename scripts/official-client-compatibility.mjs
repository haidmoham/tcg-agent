import { readFile } from 'node:fs/promises';
import { auditAgentPult, sha256 } from '../integrations/official-client/compatibility.mjs';

const args = process.argv.slice(2);
if (args.length > 3) throw new Error('usage: node scripts/official-client-compatibility.mjs [local-printing-joins.json] [reprint-audit.json] [dunsparce-verification.json]');
const bytes = args[0] ? await readFile(args[0]) : null;
const joins = bytes ? JSON.parse(bytes).joins : [];
if (!Array.isArray(joins)) throw new Error('invalid-printing-joins');
const reprints = args[1] ? JSON.parse(await readFile(args[1])).cards : [];
if (!Array.isArray(reprints)) throw new Error('invalid-reprint-audit');
const report = auditAgentPult(joins, reprints);
const joined = report.cards.filter(card => card.pinnedPrintingJoin).length;
const equivalent = report.cards.filter(card => !card.pinnedPrintingJoin && card.semanticEvidence?.capturedMechanicsIdentical).length;
let extension = null;
if (args[2]) {
  const evidence = JSON.parse(await readFile(args[2]));
  if (evidence.schema !== 'dunsparce-jtg120-native-admission/1' || evidence.exactPrinting !== 'JTG-120'
      || evidence.sourceBundleUnchanged !== true || Object.values(evidence.tested ?? {}).length !== 18
      || Object.values(evidence.tested).some(value => value !== true)) throw new Error('unverified-dunsparce-extension');
  extension = { scope: 'separate-derived-offline-package', manifestSha256: evidence.derivedManifestSha256,
    addedPrinting: evidence.exactPrinting, staticMechanicsTypesAvailable: joined + equivalent + 1,
    focusedNativeChecksPassed: 18, officialClientAdmission: false };
}
process.stdout.write(`${JSON.stringify({ ...report, joinEvidenceSha256: bytes ? sha256(bytes) : null,
  exactPrintingCoverage: { joined, distinct: 24 },
  semanticAvailability: { exactOrCapturedEquivalent: joined + equivalent, distinct: 24, gameplayCertification: false },
  derivedDunsparceExtension: extension,
  evidenceScope: 'Exact printing joins and explicitly compared static reprint mechanics are distinct evidence. No card programs or private assets are included. No gameplay or current legality certification.' }, null, 2)}\n`);
