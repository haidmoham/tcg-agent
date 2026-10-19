import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAuditedEpisode } from '../integrations/local-worker/audit-runner.mjs';
import { benchmarkDeckOrder, benchmarkNative } from '../integrations/local-worker/benchmark.mjs';
import { verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { runNativeGauntlet } from '../integrations/local-worker/gauntlet.mjs';
import { verifyNativeContracts } from '../integrations/local-worker/verify-audit.mjs';

const usage = 'Usage: node scripts/native.mjs <record|replay|verify|benchmark|gauntlet> <private-config.json> <new-run-name> [seed|private-journal.json]';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output;
try {
  const [mode, configPath, name, input, ...extra] = process.argv.slice(2);
  if (!['record', 'replay', 'verify', 'benchmark', 'gauntlet'].includes(mode) || !configPath || !/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '') || extra.length || (['replay', 'verify', 'benchmark'].includes(mode) && !input) || (mode === 'gauntlet' && input)) throw new TypeError(usage);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const runs = join(root, 'runs');
  mkdirSync(runs, { recursive: true });
  if (realpathSync(runs) !== runs) throw new Error('ignored runs directory must not be redirected');
  const directory = join(runs, name);
  mkdirSync(directory);
  output = directory;
  const save = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  let receipt;
  if (mode === 'record' || mode === 'replay') {
    const replay = mode === 'replay' ? JSON.parse(readFileSync(input, 'utf8')) : null;
    const seed = replay?.header.seed ?? (input === undefined ? 1729 : Number(input));
    const inputs = replay ? verifyLocalInputs(config) : null;
    const seatOrder = replay ? benchmarkDeckOrder(inputs.selected, replay.header).map(deck => inputs.selected.indexOf(deck)) : [0, 1];
    const result = await runAuditedEpisode(config, { seed, replay, seatOrder, maxSeconds: 180, boundaryEvery: replay ? 0 : 25, extraReads: replay ? 1 : 0 });
    save('journal.json', result.journal); receipt = result.summary;
  } else if (mode === 'verify') {
    receipt = await verifyNativeContracts(config, JSON.parse(readFileSync(input, 'utf8')));
  } else if (mode === 'benchmark') {
    receipt = await benchmarkNative(config, JSON.parse(readFileSync(input, 'utf8')), { onRepeat: value => console.log(JSON.stringify({ repeat: value.repeat, commands: value.commands, elapsedMs: value.elapsedMs })) });
  } else {
    const manifest = JSON.parse(readFileSync(join(root, 'experiments/native-gauntlet-v1.json'), 'utf8'));
    receipt = await runNativeGauntlet(config, manifest, { onGame: ({ game, journal, failure, index }) => {
      save(`game-${index}-receipt.json`, game);
      if (journal) save(`game-${index}-journal.json`, journal);
      if (failure) save(`game-${index}-failure.json`, { name: failure.name, message: failure.message, stack: failure.stack });
      console.log(JSON.stringify({ game: index + 1, seed: game.seed, status: game.status, commands: game.commands ?? null }));
    } });
  }
  save('receipt.json', receipt);
  console.log(JSON.stringify(receipt));
  if (receipt.complete === false) process.exitCode = 2;
} catch (error) {
  if (output) {
    try { writeFileSync(join(output, 'failure.json'), JSON.stringify({ name: error.name, message: error.message, stack: error.stack }), { flag: 'wx' }); } catch {}
  }
  console.error('Native offline run failed. Private diagnostics, when available, remain in the new ignored run directory.');
  if (error instanceof TypeError && error.message === usage) console.error(usage);
  process.exitCode = 1;
}
