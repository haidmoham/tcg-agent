import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const [executable, proposal, flag, stepId, ...extra] = process.argv.slice(2);
if (!isAbsolute(executable ?? '') || !proposal || flag !== '--step' || !/^[A-Za-z0-9._-]{1,80}$/.test(stepId ?? '') || extra.length) {
  throw new Error('usage: node scripts/official-client-input.mjs absolute-pwsh.exe private-proposal.json --step proposal-id');
}
try {
  const receipt = await new Promise((accept, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./official-client-input.ps1', import.meta.url)),
      '-ProposalPath', proposal, '-StepId', stepId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const stop = code => { if (!failed) { failed = true; child.kill(); reject(new Error(code)); } };
    const timeout = setTimeout(() => stop('input-timeout-outcome-uncertain-do-not-retry'), 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 16384) stop('input-reply-too-large-outcome-uncertain'); });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timeout); stop('input-process-unavailable'); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (failed) return;
      try {
        const value = JSON.parse(output.trim());
        if (value.schema !== 'official-client-input-receipt/1' || value.id !== stepId || value.verifyTransitionRequired !== true
            || !['executed-unverified', 'blocked'].includes(value.status)) return stop('input-reply-invalid-outcome-uncertain');
        if (code !== 0 && value.status !== 'blocked') return stop('input-process-failed-outcome-uncertain');
        accept(value);
      } catch { stop('input-reply-invalid-outcome-uncertain'); }
    });
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.status === 'blocked') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
