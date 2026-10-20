import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { agentPult } from '../integrations/official-client/compatibility.mjs';

const root = resolve(import.meta.dirname, '..');
const research = process.argv[2];
if (!research || process.argv.length !== 3) throw new Error('research-root-required');
const probes = (await readdir(join(root, '.cache'))).filter(name => name.startsWith('runtime-probe-'));
let latest;
for (const name of probes) {
  const records = JSON.parse(await readFile(join(root, '.cache', name, 'private-observations.json')));
  const value = records.find(record => record.result?.selectedDeck?.displayName === 'AgentPult');
  if (value) latest = value.result.selectedDeck;
}
if (!latest?.exactCards) throw new Error('runtime-own-deck-not-observed');
const corpus = (await readFile(join(research, 'network-recon/card-corpus-v1/cards.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const source = new Map(corpus.map(card => [card.cardSourceID, card]));
const normalize = value => ({ 'Basic {R} Energy': 'Fire Energy', 'Basic {D} Energy': 'Darkness Energy', 'Basic {P} Energy': 'Psychic Energy' })[value]
  ?? value.normalize('NFKC').replace(/[’]/g, "'");
const ignored = new Set(['cardSourceID', 'logicSourceID', 'releaseDate', 'actionGuid']);
const mechanics = value => Array.isArray(value) ? value.map(mechanics) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(key => !ignored.has(key)).sort().map(key => [key, mechanics(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(mechanics(value))).digest('hex');
const selected = Object.entries(latest.exactCards).map(([id, count]) => {
  const base = id.replace(/_(?:m?ph)\d*$/, '');
  const card = source.get(id) ?? source.get(base);
  if (!card) throw new Error('loaded-source-program-missing:' + id);
  return { id, base, count, card, hash: hash(card) };
});
const report = { schema: 'official-client-loaded-deck/1', displayName: 'AgentPult', total: selected.reduce((sum, item) => sum + item.count, 0),
  kind: 'runtime-own-deck-plus-static-corpus', exactHistoricalPrintingsMatch: false,
  loadedNames: selected.map(item => ({ count: item.count, name: item.card.cardName, source: item.base })),
  cards: agentPult.cards.map(expected => {
    const matches = selected.filter(item => normalize(item.card.cardName) === normalize(expected.name));
    const prefix = { ASC: 'me2-5', JTG: 'sv9', TEF: 'sv5', POR: 'me3', MEG: 'me1', SCR: 'sv7', CRI: 'me4', TWM: 'sv6', MEE: 'mee' }[expected.set];
    const target = source.get(`${prefix}_${expected.number}`);
    return { name: expected.name, expected: expected.count, loaded: matches.reduce((sum, item) => sum + item.count, 0),
      targetMechanicsHash: target ? hash(target) : null,
      mechanicsMatch: Boolean(target && matches.length && matches.every(item => item.hash === hash(target))),
      differingFields: target ? [...new Set(matches.flatMap(item => Object.keys(mechanics(target))
        .filter(key => JSON.stringify(mechanics(target)[key]) !== JSON.stringify(mechanics(item.card)[key]))))] : ['target-source-unavailable'],
      loadedMechanicsHashes: [...new Set(matches.map(item => item.hash))] };
  }) };
report.namedCompositionMatches = report.total === 60 && report.cards.every(card => card.loaded === card.expected);
report.mechanicsCompositionMatches = report.namedCompositionMatches && report.cards.every(card => card.mechanicsMatch);
await writeFile(join(root, '.cache/loaded-agent-pult-audit.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report) + '\n');
