import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateShadow, parseJsonl } from '../src/shadow-play.mjs';

const usage = 'Usage: node scripts/shadow-play.mjs validate FILE | evaluate FILE --adapter MODULE [--checkpoint FILE] [--top-k N] [--training-manifest FILE] [--output runs/REPORT.json]';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

try {
  const [command, input, ...args] = process.argv.slice(2);
  if (!['validate', 'evaluate'].includes(command) || !input || input.startsWith('--') || args.length % 2) throw new TypeError(usage);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--adapter', '--checkpoint', '--top-k', '--training-manifest', '--output'].includes(key)
        || Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new TypeError(usage);
    options[key] = value;
  }
  if (command === 'validate' && Object.keys(options).length) throw new TypeError(usage);
  const output = options['--output'] ? resolve(options['--output']) : null;
  if (output) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runs = resolve(root, 'runs');
    if (dirname(output) !== runs || resolve(input) === output) throw new TypeError('--output must be a new file directly inside the repository runs directory');
    mkdirSync(runs, { recursive: true });
    if (realpathSync(runs) !== runs) throw new TypeError('runs must not be a symlink or junction');
    if (existsSync(output)) throw new TypeError('--output requires a new file');
  }
  const bytes = readFileSync(input);
  if (bytes.length > 32 * 1024 * 1024) throw new TypeError('decision dataset exceeds 32 MiB budget');
  const records = parseJsonl(bytes.toString('utf8'));
  let report;
  if (command === 'validate') report = { schema: 'shadow-validation/1', records: records.length, sha256: sha256(bytes), valid: true };
  else {
    if (!options['--adapter']) throw new TypeError(usage);
    const adapterPath = resolve(options['--adapter']);
    const adapterHash = sha256(readFileSync(adapterPath));
    const checkpoint = options['--checkpoint'] ? resolve(options['--checkpoint']) : null;
    const checkpointBytes = checkpoint ? readFileSync(checkpoint) : null;
    const trainingBytes = options['--training-manifest'] ? readFileSync(options['--training-manifest']) : null;
    const module = await import(pathToFileURL(adapterPath).href);
    report = await evaluateShadow(records, { adapter: module.default ?? module.adapter, checkpoint,
      topK: options['--top-k'] ? Number(options['--top-k']) : 3,
      trainingManifest: trainingBytes ? JSON.parse(trainingBytes.toString('utf8')) : null });
    const checkpointHash = checkpointBytes ? sha256(checkpointBytes) : null;
    if (checkpoint && sha256(readFileSync(checkpoint)) !== checkpointHash) throw new TypeError('checkpoint changed during shadow evaluation');
    if (sha256(readFileSync(adapterPath)) !== adapterHash) throw new TypeError('adapter source changed during shadow evaluation');
    report.provenance = { datasetSha256: sha256(bytes), adapterSha256: adapterHash,
      evaluatorSha256: sha256(readFileSync(new URL('../src/shadow-play.mjs', import.meta.url))), nodeVersion: process.version,
      checkpointSha256: checkpointHash,
      trainingManifestSha256: trainingBytes ? sha256(trainingBytes) : null };
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, json, { flag: 'wx' });
  console.log(json.trimEnd());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
