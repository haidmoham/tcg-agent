import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/official-client-history.py', import.meta.url));

// No client imports or access. The driver owns when a local snapshot is safe.
export function clientGameHistory({ python, root, folder, gameId, candidate, pins, database, declaredMode = 'unknown', modeSource = 'controller:unspecified' }) {
  if (!['ai_test', 'ranked', 'casual_other', 'unknown'].includes(declaredMode)) throw new Error('history-explicit-mode-enum-required');
  const db = database ? resolve(database) : join(root, '.cache/client-history/games.sqlite3');
  const ingest = async () => {
    const { stdout } = await execute(python, [script, '--db', db, 'import', resolve(folder)],
      { windowsHide: true, timeout: 30000, maxBuffer: 65536 });
    return JSON.parse(stdout);
  };
  let observedOffline;
  return {
    async begin({ resume }) {
      if (!resume) {
        await writeFile(join(folder, 'history-run.json'), JSON.stringify({ schema: 'official-client-history-run/1',
          id: gameId, candidate, checkpointSha256: pins.ordinaryCheckpointSha256, featureSchema: pins.featureContract.schema, at: Date.now() }) + '\n', { flag: 'wx' });
        await writeFile(join(folder, 'mode-declaration.json'), JSON.stringify({ schema: 'official-client-mode-declaration/1',
          mode: declaredMode, source: modeSource, at: Date.now() }) + '\n', { flag: 'wx' });
      } else {
        // Old runs remain admissible via their original launch-intent evidence.
        try { await readFile(join(folder, 'launch-intent.json')); } catch { throw new Error('history-resume-launch-evidence-required'); }
      }
      return ingest();
    },
    async observed(value) {
      const offline = value?.match?.offline;
      if (typeof offline !== 'boolean' || offline === observedOffline) return;
      observedOffline = offline;
      await appendFile(join(folder, 'mode-evidence.jsonl'), JSON.stringify({ schema: 'official-client-mode-evidence/1',
        mode: offline ? 'ai_test' : 'unknown', source: offline ? 'runtime-ui:offline=true' : 'runtime-ui:offline=false; queue not established',
        at: Date.now(), kind: 'observed' }) + '\n');
      return ingest();
    },
    checkpoint: ingest,
  };
}
