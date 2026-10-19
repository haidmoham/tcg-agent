import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareNativeModes } from '../integrations/local-worker/three-mode-comparison.mjs';

const usage = 'Usage: node scripts/compare-native-modes.mjs <native-config.json> <previous-config.json> <candidate-config.json> <native-cases.json> <new-run-name>';
let output;
try {
  const [nativePath, previousPath, candidatePath, casesPath, name, ...extra] = process.argv.slice(2);
  if (!nativePath || !previousPath || !candidatePath || !casesPath || !/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '') || extra.length) throw new TypeError(usage);
  const runs = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runs');
  mkdirSync(runs, { recursive: true });
  if (realpathSync(runs) !== runs) throw new Error('ignored runs directory must not be redirected');
  const directory = join(runs, name); mkdirSync(directory); output = directory;
  const save = (filename, value) => writeFileSync(join(output, filename), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  const manifest = JSON.parse(readFileSync(casesPath, 'utf8'));
  if (manifest.schema !== 'native-warm-cases-v1' || !Array.isArray(manifest.cases) || manifest.cases.length !== 2) throw new Error('fixed two-workload native case manifest required');
  const cases = manifest.cases.map(row => {
    if (!row || typeof row.journalPath !== 'string') throw new Error('explicit private journal paths required');
    return { id: row.id, journal: JSON.parse(readFileSync(resolve(dirname(resolve(casesPath)), row.journalPath), 'utf8')) };
  });
  const configs = [nativePath, previousPath, candidatePath].map(path => JSON.parse(readFileSync(path, 'utf8')));
  const receipt = await compareNativeModes(...configs, cases, {
    onProof: proof => { save('proof.json', proof); console.log('Candidate warm frame, actor and seed proof passed.'); },
    onRun: run => { save(`pair-${run.pair}-${run.side}.json`, run); console.log(JSON.stringify({ pair: run.pair, side: run.side, block: run.block,
      timedMilliseconds: run.timedMilliseconds, sessionMilliseconds: run.sessionMilliseconds, errors: run.errors, truncations: run.truncations })); },
  });
  save('receipt.json', receipt);
  console.log(JSON.stringify({ incremental: receipt.incremental, fullCampaign: receipt.fullCampaign }));
} catch (error) {
  if (output) try { writeFileSync(join(output, 'failure.json'), JSON.stringify({ complete: false, errors: 1, name: error.name, message: error.message, stack: error.stack }), { flag: 'wx' }); } catch {}
  console.error('Three-mode comparison failed. Any diagnostics remain in the new ignored run directory.');
  if (error instanceof TypeError && error.message === usage) console.error(usage);
  process.exitCode = 1;
}
