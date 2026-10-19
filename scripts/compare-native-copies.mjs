import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareNativeCopies } from '../integrations/local-worker/copy-comparison.mjs';

let output;
try {
  const [base, candidate, journal, name, ...extra] = process.argv.slice(2);
  if (!base || !candidate || !journal || !/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '') || extra.length) throw new Error('bounded copy comparison arguments required');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runs');
  mkdirSync(root, { recursive: true });
  if (realpathSync(root) !== root) throw new Error('ignored runs directory must not be redirected');
  const target = join(root, name); mkdirSync(target); output = target;
  const save = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  const result = await compareNativeCopies(JSON.parse(readFileSync(base)), JSON.parse(readFileSync(candidate)), JSON.parse(readFileSync(journal)), {
    onProof: proof => { save('candidate-journal.json', proof.journal); save('proof.json', proof.summary); console.log('Cross-build frame, actor, chance and privacy proof passed.'); },
    onRun: run => { save(`pair-${run.pair}-${run.side}.json`, run); console.log(JSON.stringify(run)); },
  });
  save('receipt.json', result); console.log(JSON.stringify({ baseline: result.baseline, candidate: result.candidate, speedup: result.speedup }));
} catch (error) {
  if (output) try { writeFileSync(join(output, 'failure.json'), JSON.stringify({ name: error.name, message: error.message, stack: error.stack }), { flag: 'wx' }); } catch {}
  console.error('Copy comparison failed; any diagnostics remain in the new ignored run directory.'); process.exitCode = 1;
}
