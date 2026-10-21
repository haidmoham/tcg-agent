import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compareHillclimbPanels } from '../src/model6-hillclimb-analysis.mjs';

const [directory] = process.argv.slice(2);
if (!directory || process.argv.length !== 3) throw Error('usage: report-model6-hillclimb <completed-private-run>');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const root = path.resolve(directory), campaign = read(path.join(root, 'campaign.json'));
const state = read(path.join(root, 'status.json'));
if (!['completed', 'completed-anchor-screen'].includes(state.phase)) throw Error('fixed endpoint not complete');
const rawResult = path.join(root, 'result.json');
let result = read(rawResult);
if (state.phase === 'completed') {
  const receipts = Object.fromEntries(campaign.panels.map(panel => [panel.id, read(path.join(panel.output, 'receipt.json'))]));
  const blocks = Object.entries(receipts).filter(([id]) => id.startsWith('anchor-')).flatMap(([, receipt]) => receipt.blocks);
  receipts.anchor = { state: 'completed', plannedPairs: blocks.length, blocks };
  result = compareHillclimbPanels(receipts);
}
const output = { ...result, protocolSha256: campaign.protocolSha256, rawResultSha256: hash(rawResult),
  reportedAtUtc: new Date().toISOString(), reporterSha256: hash(new URL(import.meta.url)),
  analysisModuleSha256: hash(new URL('../src/model6-hillclimb-analysis.mjs', import.meta.url)), promotion: false };
fs.writeFileSync(path.join(root, 'canonical-result.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output));
