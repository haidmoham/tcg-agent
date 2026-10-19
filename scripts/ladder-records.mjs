import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLadderRecords, summarizeLadderRecords } from '../src/ladder-records.mjs';

const usage = 'Usage: node scripts/ladder-records.mjs <records.jsonl> [--output runs/summary.json]';

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--output')) throw new TypeError(usage);
  if (args[0].startsWith('--')) throw new TypeError(usage);
  const report = summarizeLadderRecords(parseLadderRecords(readFileSync(args[0], 'utf8')));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args[2]) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const runs = resolve(root, 'runs');
    const output = resolve(args[2]);
    if (dirname(output) !== runs) throw new TypeError('--output must be a file directly inside this repository\'s ignored runs directory');
    mkdirSync(runs, { recursive: true });
    if (realpathSync(runs) !== runs) throw new TypeError('runs must not be a symlink or junction');
    writeFileSync(output, json, { flag: 'wx' });
  }
  console.log(json.trimEnd());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
