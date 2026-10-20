import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const [executable, processId, windowId, directory, ...extra] = process.argv.slice(2);
if (!isAbsolute(executable ?? '') || !/^\d+$/.test(processId ?? '') || !/^\d+$/.test(windowId ?? '') || !directory || extra.length) {
  throw new Error('usage: node scripts/official-client-capture.mjs absolute-pwsh.exe process-id window-id private-cache-output');
}
try {
  const receipt = await new Promise((accept, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./capture-official-client.ps1', import.meta.url)),
      '-ProcessId', processId, '-WindowId', windowId, '-OutputDirectory', directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const stop = code => { if (!failed) { failed = true; child.kill(); reject(new Error(code)); } };
    const timeout = setTimeout(() => stop('capture-timeout-owned-process-stopped'), 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', bytes => { output += bytes; if (Buffer.byteLength(output) > 16384) stop('capture-reply-too-large'); });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timeout); stop('capture-process-unavailable'); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (failed) return;
      if (code !== 0) return stop('capture-rejected-check-window-and-private-output');
      try {
        const value = JSON.parse(output.trim());
        if (value.schema !== 'official-client-capture/1' || value.window?.processId !== Number(processId)
            || value.window?.id !== Number(windowId) || value.clientInputsSent !== 0) return stop('capture-reply-invalid');
        accept(value);
      } catch { stop('capture-reply-invalid'); }
    });
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
