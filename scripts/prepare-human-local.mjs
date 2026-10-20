// Private, copy-only preparation. Never changes the training controller or its inputs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const [source, adoptionPath, indigoRoot, cardArtRoot, ...extra] = process.argv.slice(2);
if (!source || !adoptionPath || !indigoRoot || !cardArtRoot || extra.length)
  throw new Error('Usage: node scripts/prepare-human-local.mjs <completed-runtime-snapshot> <selected-human-baseline.json or adoption-verified.json> <absolute-local-indigoproject> <absolute-local-card-art-root>');
if (![indigoRoot, cardArtRoot].every(value => path.isAbsolute(value) && fs.existsSync(value) && fs.statSync(value).isDirectory()))
  throw new Error('Explicit existing local presentation and artwork directories required; private assets are not bundled.');
const target = path.join(root, 'runs/human-local');
if (fs.existsSync(target)) throw new Error('Private copy exists. Inspect it; preparation never overwrites pins or records.');
const adoption = read(adoptionPath), campaign = read(path.join(source, 'cohort-campaign-v4-config.json'));
const chosen = adoption.retainedCheckpoint ? { checkpoint: adoption.retainedCheckpoint, checkpointSha256: adoption.checkpointSha256 } : adoption.firstUpdate;
const receiptPath = adoption.originalReceipt ?? chosen.checkpoint.replace(/\.pt$/, '.receipt.json');
const receipt = read(receiptPath);
if (sha(chosen.checkpoint) !== chosen.checkpointSha256 || !receipt.reloadLogitsExact || !receipt.reloadValuesExact)
  throw new Error('Completed checkpoint reload proof or digest missing.');
for (const [name, digest] of Object.entries(receipt.sourceHashes)) if (sha(path.join(source, name)) !== digest)
  throw new Error(`Training runtime does not match checkpoint: ${name}`);
const pair = read(path.join(source, 'native/pair-manifest.json')).pairs.find(p => p.id === 'hammerpult-vs-hydrapple');
const native = read(pair.configPath);
fs.mkdirSync(target, { recursive: true });
const copy = (src, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); };
for (const dir of ['learning', 'integrations', 'src']) fs.cpSync(path.join(source, dir), path.join(target, 'runtime', dir),
  { recursive: true, filter: p => !p.includes('__pycache__') });
copy(path.join(source, 'package.json'), path.join(target, 'runtime/package.json'));
fs.cpSync(path.dirname(native.worker), path.join(target, 'native/bin'), { recursive: true });
fs.cpSync(native.workerSourceRoot, path.join(target, 'native/source'), { recursive: true, filter: p => !p.includes(`${path.sep}obj${path.sep}`) });
fs.cpSync(native.bundleRoot, path.join(target, 'bundle'), { recursive: true });
copy(native.policyModule, path.join(target, 'teacher.mjs'));
copy(chosen.checkpoint, path.join(target, 'opponent.pt'));
copy(receiptPath, path.join(target, 'opponent.receipt.json'));
copy(campaign.selection, path.join(target, 'selection.pt'));
copy(campaign.catalog, path.join(target, 'catalog.json'));
copy(campaign.teacherCatalog, path.join(target, 'teacher-catalog.json'));
copy(adoptionPath, path.join(target, 'baseline-selection.json'));
Object.assign(native, { worker: path.join(target, 'native/bin/Indigo.Live.Engine.dll'), bundleRoot: path.join(target, 'bundle'),
  workerSourceRoot: path.join(target, 'native/source'), policyModule: path.join(target, 'teacher.mjs') });
const pins = {};
function pin(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  const p = path.join(dir, entry.name); if (entry.isDirectory()) pin(p); else pins[path.relative(target, p)] = sha(p);
} }
pin(target);
const config = { schema: 'hammerpult-human-local/1', native, runtimeRoot: path.join(target, 'runtime'),
  pinRoot: target, pins, checkpointSha256: chosen.checkpointSha256,
  indigoRoot, cardArtRoot,
  recordsRoot: path.join(root, 'runs/human-demonstrations'), teacherCatalog: path.join(target, 'teacher-catalog.json'),
  model: { executable: campaign.python, checkpoint: path.join(target, 'opponent.pt'), modelRoot: target,
    catalogPath: path.join(target, 'catalog.json'), catalogSha256: receipt.catalogSha256,
    frozenSelectionSha256: receipt.frozenSelectionSha256, device: 'cpu', seed: 81729 },
  selection: { executable: campaign.python, checkpoint: path.join(target, 'selection.pt'), modelRoot: target,
    catalogPath: path.join(target, 'catalog.json'), catalogSha256: receipt.catalogSha256, device: 'cpu', seed: 81729 },
  deckSha256: pair.deckHashes, version: 'Model6 update23 · 20:53:20 UTC · cohort v4/001', sourceCheckpoint: chosen.checkpoint };
if (sha(config.selection.checkpoint) !== receipt.frozenSelectionSha256) throw new Error('Frozen selection mismatch');
fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
console.log(path.join(target, 'config.json'));
