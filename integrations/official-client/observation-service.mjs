import { createServer } from 'node:http';
import { summarizeBattleLog } from './battle-log.mjs';

export function summarizeObservation(value, now = Date.now(), maxAgeMs = 5000) {
  const { receipt, recognized } = value ?? {};
  const valid = receipt?.schema === 'official-client-capture/1' && recognized?.schema === 'official-client-recognition/1'
    && Number.isSafeInteger(receipt.capturedAt) && receipt.capturedAt <= now
    && /^[a-f0-9]{64}$/.test(receipt.imageSha256 ?? '');
  if (!valid) throw new Error('observation-invalid');
  const ageMs = now - receipt.capturedAt;
  return { schema: 'official-client-service-observation/1', capturedAt: receipt.capturedAt, ageMs,
    stale: ageMs > maxAgeMs, imageSha256: receipt.imageSha256, width: receipt.width, height: receipt.height,
    window: { app: 'Pokemon TCG Live', processId: receipt.window.processId, id: receipt.window.id, visible: receipt.window.visible === true, focused: receipt.window.focused === true },
    source: { kind: 'visible-window-capture', structuredMatchAttached: false },
    screen: recognized.screen, deckDisplayName: recognized.deckDisplayName, gameplayReady: false, inputsEnabled: false,
    policyView: null, unknowns: [...recognized.unknowns],
    navigationControls: recognized.controls.map(control => ({ id: control.id, label: control.label,
      target: control.target, expectedScreen: control.expectedScreen })) };
}

export async function startObservationService({ observe, readBattleLog = null, close = async () => {}, intervalMs = 2000,
  lifespanMs = 120000, maxObservations = 60, maxAgeMs = 5000, port = 0 }) {
  if (typeof observe !== 'function' || (readBattleLog !== null && typeof readBattleLog !== 'function') || typeof close !== 'function' || !Number.isInteger(intervalMs) || intervalMs < 100
      || !Number.isInteger(lifespanMs) || lifespanMs < 100 || lifespanMs > 600000
      || !Number.isInteger(maxObservations) || maxObservations < 1 || maxObservations > 300
      || !Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 10000
      || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('observation-service-options-invalid');
  let latest = null, error = null, latestLog = null, count = 0, stopped = false, timer, expires, inFlight;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, value) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${server.address().port}`)
      return reply(403, { error: 'local-native-client-required' });
    if (request.method !== 'GET' || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0)
      return reply(405, { error: 'read-only-service' });
    if (request.url === '/health') return reply(200, { schema: 'official-client-observation-service/1',
      status: error ? 'capture-blocked' : latest ? 'observing' : 'starting', count, inputsEnabled: false });
    if (request.url === '/battle-log') {
      if (!readBattleLog) return reply(200, { schema: 'official-client-battle-log-receipt/1', status: 'disabled', inputsEnabled: false });
      try { const value = summarizeBattleLog(latestLog, Date.now(), maxAgeMs); return reply(value.stale ? 503 : 200, value); }
      catch { return reply(503, { error: 'battle-log-unavailable', inputsEnabled: false }); }
    }
    if (request.url !== '/observation') return reply(404, { error: 'route-unavailable' });
    if (!latest || error) return reply(503, { error: 'observation-unavailable', inputsEnabled: false });
    try {
      const value = summarizeObservation(latest, Date.now(), maxAgeMs);
      reply(value.stale ? 503 : 200, value);
    } catch { reply(503, { error: 'observation-unavailable', inputsEnabled: false }); }
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  server.maxConnections = 8;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  const url = `http://127.0.0.1:${server.address().port}`;
  let stopPromise;
  const stop = () => stopPromise ??= (async () => {
    stopped = true; clearTimeout(timer); clearTimeout(expires);
    await close();
    await inFlight?.catch(() => {});
    await new Promise(accept => { server.close(accept); server.closeAllConnections(); });
  })();
  async function poll() {
    if (stopped) return;
    count++;
    inFlight = Promise.resolve().then(async () => {
      try { const value = await observe(); summarizeObservation(value); latest = value; error = null; }
      catch { latest = null; error = 'capture-unavailable'; }
      if (readBattleLog) {
        try { const value = await readBattleLog(); summarizeBattleLog(value); latestLog = value; }
        catch { latestLog = null; }
      }
    });
    await inFlight;
    if (stopped) return;
    if (count >= maxObservations) { await stop(); return; }
    timer = setTimeout(poll, intervalMs);
  }
  expires = setTimeout(stop, lifespanMs);
  void poll();
  return { url, stop, finished: new Promise(accept => server.once('close', accept)) };
}
