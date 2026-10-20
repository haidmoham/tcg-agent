import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { startObservationService, summarizeObservation } from '../integrations/official-client/observation-service.mjs';

function observation(capturedAt = Date.now()) {
  return { receipt: { schema: 'official-client-capture/1', capturedAt, imageSha256: 'a'.repeat(64), width: 1366, height: 768,
    window: { processId: 10, id: 20, visible: true, focused: false }, privateAccountName: 'private-account', privateScreenshot: 'private.png' },
  recognized: { schema: 'official-client-recognition/1', screen: 'home-lobby', deckDisplayName: 'AgentPult',
    unknowns: ['playing-policy-view'], controls: [], rawOcr: 'private-text' } };
}

test('observation service publishes a private-field whitelist and explicit stale/unknown state', () => {
  const value = summarizeObservation(observation(10000), 16000);
  assert.equal(value.stale, true);
  assert.equal(value.ageMs, 6000);
  assert.equal(value.inputsEnabled, false);
  assert.equal(value.gameplayReady, false);
  assert.equal(value.policyView, null);
  assert.equal(value.window.visible, true);
  assert.equal(value.window.focused, false);
  assert.deepEqual(value.source, { kind: 'visible-window-capture', structuredMatchAttached: false });
  assert.ok(!JSON.stringify(value).includes('private-'));
  assert.throws(() => summarizeObservation(observation(20000), 10000), /observation-invalid/);
});

test('loopback service has no input route, rejects browser/foreign-host calls and stops within its budget', async () => {
  let closed = 0, count = 0;
  const service = await startObservationService({ observe: async () => { count++; return observation(); },
    close: async () => { closed++; }, lifespanMs: 2000, intervalMs: 300, maxObservations: 2 });
  try {
    const result = await fetch(`${service.url}/observation`);
    assert.equal(result.status, 200);
    const value = await result.json();
    assert.equal(value.screen, 'home-lobby');
    assert.equal(value.inputsEnabled, false);
    assert.equal((await fetch(`${service.url}/step`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${service.url}/step`)).status, 404);
    assert.equal((await fetch(`${service.url}/observation`, { headers: { Origin: 'http://example.test' } })).status, 403);
    const foreignHostStatus = await new Promise((accept, reject) => {
      get(`${service.url}/health`, { headers: { Host: 'example.test' } }, response => { response.resume(); accept(response.statusCode); }).on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    await service.finished;
    assert.equal(count, 2);
    assert.equal(closed, 1);
  } finally { await service.stop(); }
});

test('capture failure invalidates the last good observation without exposing raw errors', async () => {
  let fail;
  const failed = new Promise(accept => { fail = accept; });
  let calls = 0;
  const service = await startObservationService({ observe: async () => {
    if (++calls > 1) { fail(); throw new Error('private-credentials-must-never-escape'); }
    return observation(Date.now() - 100000);
  }, intervalMs: 100, lifespanMs: 2000 });
  try {
    const stale = await fetch(`${service.url}/observation`);
    assert.equal(stale.status, 503);
    assert.equal((await stale.json()).stale, true);
    await failed;
    const result = await fetch(`${service.url}/observation`);
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'observation-unavailable', inputsEnabled: false });
    assert.equal((await (await fetch(`${service.url}/health`)).json()).status, 'capture-blocked');
  } finally { await service.stop(); }
});

test('observation polling never overlaps a pending capture', async () => {
  let finish, entered;
  const first = new Promise(accept => { entered = accept; });
  const held = new Promise(accept => { finish = accept; });
  let calls = 0;
  const service = await startObservationService({ observe: async () => { calls++; entered(); await held; return observation(); },
    intervalMs: 100, lifespanMs: 2000 });
  try {
    await first;
    assert.equal((await (await fetch(`${service.url}/health`)).json()).status, 'starting');
    assert.equal(calls, 1);
  } finally { finish(); await service.stop(); }
});
