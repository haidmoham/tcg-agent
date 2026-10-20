import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile, unlink, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

if (process.argv.slice(2).join(' ') !== '--five-wins --arm --step') throw new Error('explicit-model4-five-win-attempt-required');
const root = resolve(import.meta.dirname, '..'), cache = join(root, '.cache');
const folder = join(cache, `model4-qualification-${randomUUID()}`);
await mkdir(folder);
await writeFile(join(cache, 'model4-qualification-latest.json'), JSON.stringify({ folder }));
const files = ['scripts/official-client-model3-game.mjs', 'scripts/official-client-runtime.py', 'integrations/official-client/runtime-agent.js', 'integrations/official-client/runtime-policy.mjs'];
const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
const report = { schema: 'official-client-model4-qualification/1', candidate: 'model4', requiredConsecutiveWins: 5,
  checkpointSha256: '38a6e726d528d8de3cc9924285c8d67c2700a8dde1cb64f6e388d99ae37ce8b5', pins, attempts: [], wins: 0, status: 'running', startedAt: Date.now() };
const save = () => writeFile(join(folder, 'receipt.json'), JSON.stringify(report, null, 2));
const log = async event => { const line = JSON.stringify({ at: Date.now(), ...event }) + '\n'; await appendFile(join(folder, 'events.jsonl'), line); process.stdout.write(line); };
await save();
try {
 for (let game = 1; game <= 5; game++) {
  for (const [file, pin] of Object.entries(pins)) if (createHash('sha256').update(await readFile(join(root, file))).digest('hex') !== pin) throw new Error('qualification-driver-changed');
  for (const name of ['official-client.kill', 'official-client-input.kill', 'official-client-runtime.kill']) {
   try { await access(join(cache, name)); throw new Error('qualification-paused'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await log({ event: 'qualification-game-starting', candidate: 'model4', game, wins: report.wins });
  const child = spawn(process.execPath, [join(root, 'scripts/official-client-model3-game.mjs'), '--model4', '--one-built-in-ai', '--arm', '--step'],
   { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', () => {});
  const exitCode = await new Promise((accept, reject) => { child.once('exit', accept); child.once('error', reject); });
  const latest = JSON.parse(await readFile(join(cache, 'model4-live-latest.json')));
  const result = JSON.parse(await readFile(join(latest.folder, 'receipt.json')));
  report.attempts.push({ game, folder: latest.folder, ...result });
  if (exitCode !== 0 || result.outcome !== 'completed') { report.status = result.failure?.startsWith('policy-') ? 'failed-policy-timeout' : 'blocked-driver'; await save(); break; }
  if (result.winner !== 'you') { report.status = result.winner === 'opponent' ? 'failed-loss' : 'blocked-unknown-outcome'; await save(); break; }
  if (result.rejectedActions !== 0) { report.status = 'blocked-driver'; await save(); break; }
  report.wins++; await save(); await log({ event: 'qualification-win', game, consecutiveWins: report.wins });
  if (report.wins === 5) { report.status = 'passed'; break; }
  await new Promise(accept => setTimeout(accept, 20000)); // Ordinary Test Deck outro.
  for (const marker of ['official-client-input.kill', 'official-client-runtime.kill']) {
   const path = join(cache, marker);
   if (await readFile(path, 'utf8') !== `session-ended:${result.id}\n`) throw new Error('qualification-human-pause-preserved');
  }
  for (const marker of ['official-client-input.kill', 'official-client-runtime.kill']) await unlink(join(cache, marker));
 }
} catch (error) { report.status = 'blocked-driver'; report.failure = error.message; }
report.endedAt = Date.now(); await save(); await log({ event: 'qualification-ended', status: report.status, wins: report.wins, attempts: report.attempts.length, evidenceFolder: folder });
