import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkNativeWarm, proveNativeWarm } from '../integrations/local-worker/warm-benchmark.mjs';

const usage = 'Usage: node scripts/benchmark-native-warm.mjs <benchmark|proof> <private-config.json> <new-run-name> <private-cases.json> [repeats]';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output;
try {
  const [mode, configPath, name, casesPath, repetitions, ...extra] = process.argv.slice(2);
  if (!['benchmark', 'proof'].includes(mode) || !configPath || !/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '')
      || !casesPath || extra.length || (mode === 'proof' && repetitions !== undefined)) throw new TypeError(usage);
  const repeats = repetitions === undefined ? 3 : Number(repetitions);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw new TypeError(usage);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(casesPath, 'utf8'));
  if (manifest.schema !== 'native-warm-cases-v1' || !Array.isArray(manifest.cases) || manifest.cases.length < 2 || manifest.cases.length > 3) throw new Error('fixed native case manifest required');
  const cases = manifest.cases.map(row => {
    if (!row || typeof row.journalPath !== 'string') throw new Error('explicit private journal paths required');
    return { id: row.id, journal: JSON.parse(readFileSync(resolve(dirname(resolve(casesPath)), row.journalPath), 'utf8')) };
  });
  const runs = join(root, 'runs');
  mkdirSync(runs, { recursive: true });
  if (realpathSync(runs) !== runs) throw new Error('ignored runs directory must not be redirected');
  const directory = join(runs, name);
  mkdirSync(directory);
  output = directory;
  const onGame = value => console.log(JSON.stringify({ id: value.id, stage: value.stage ?? 'proof', round: value.round ?? value.sequence,
    commands: value.commands, frames: value.frames, elapsedMilliseconds: value.elapsedMilliseconds, errors: value.errors, truncations: value.truncations }));
  const receipt = mode === 'benchmark' ? await benchmarkNativeWarm(config, cases, { repeats, onGame }) : await proveNativeWarm(config, cases, { onGame });
  writeFileSync(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(receipt));
} catch (error) {
  if (output) {
    try { writeFileSync(join(output, 'failure.json'), JSON.stringify({ errors: 1, complete: false, name: error.name, message: error.message, stack: error.stack }), { flag: 'wx' }); } catch {}
  }
  console.error('Warm native run failed. Private diagnostics remain in the new ignored run directory when available.');
  console.error(JSON.stringify({ errors: 1, complete: false }));
  if (error instanceof TypeError && error.message === usage) console.error(usage);
  process.exitCode = 1;
}
