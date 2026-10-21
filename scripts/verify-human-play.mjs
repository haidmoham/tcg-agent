// One bounded end-to-end game. These are synthetic actions, never human demonstrations.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlayServer } from './play-checkpoint.mjs';
import { HumanSession, humanDecks } from '../play/human-session.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2] ?? 'runs/human-local/config.json', 'utf8'));
config.provenance = 'synthetic-smoke';
config.recordsRoot = path.resolve('runs/synthetic-human-play', randomUUID());
const { server, session } = createPlayServer(config, { Session: HumanSession, deckCatalog: humanDecks });
await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (operation, body) => {
  const res = await fetch(base + '/api/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ requestId: randomUUID(), ...body }), signal: AbortSignal.timeout(45000) });
  return { status: res.status, data: await res.json() };
};
const request = game => ({ gameId: game.id, revision: game.view.revision, decisionId: game.decisionId, observationHash: game.observationHash });
const receipt = { schema: 'human-play-smoke/1', provenance: 'synthetic-smoke', humanDemonstrationsCreated: 0,
  startedAt: new Date().toISOString(), checks: [], checkpointSha256: config.checkpointSha256, promptKinds: {}, recordsRoot: config.recordsRoot };
let g, start;
try {
  const catalog = await fetch(base + '/api/catalog').then(r => r.json()); assert.equal(catalog.demonstrations, true);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.mjs')).status, 200);
  assert.equal((await fetch(base + '/art/TWM-130.png')).status, 200);
  assert.equal((await fetch(base + '/api/new', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  receipt.checks.push('http-page-script-card-art', 'foreign-origin-rejected');
  start = await call('new', { modelId: 'first-baseline', deck: 0 }); assert.equal(start.status, 200); g = start.data.game;
  assert.equal(g.error, null); assert.equal(g.model.sha256, config.checkpointSha256);
  assert.equal(session.inputs.selected[0].length, 60);
  const initialRequest = request(g);
  assert.equal((await call('command', { ...request(g), observationHash: 'wrong', decision: {} })).status, 409);
  assert.equal((await call('command', { ...request(g), decision: { actionId: 'foreign' } })).status, 400);
  receipt.checks.push('exact-checkpoint-and-sixty', 'observation-binding', 'invalid-action-retained');
  const audit = async () => {
    const native = session.game;
    const variant = await native.worker.request('audit-privacy', { seat: 'human' });
    const a = new session.modules.PolicyView().project(native.frame.views.human);
    const b = new session.modules.PolicyView().project(variant.view);
    assert.deepEqual(a, b); receipt.checks.push('hidden-world-permutation');
  };
  await audit();
  const deadline = Date.now() + 180000;
  let humanCommands = 0, duplicateChecked = false;
  while (!g.terminal && humanCommands < 450 && Date.now() < deadline) {
    assert.equal(g.error, null);
    assert.equal(g.view.opponent.hand, undefined); assert.equal(g.view.opponent.deck, undefined);
    const view = session.game.views.human, prompt = view.prompts[0];
    if (prompt) receipt.promptKinds[prompt.kind] = (receipt.promptKinds[prompt.kind] ?? 0) + 1;
    let decision;
    for (const candidate of session.game.policy(view)) {
      if (candidate.promptId) {
        const preview = await call('preview', { ...request(g), decision: candidate });
        assert.equal(preview.status, 200);
        if (!preview.data.valid) continue;
      }
      decision = candidate; break;
    }
    assert.ok(decision, 'Synthetic driver has no choice');
    const payload = { ...request(g), requestId: randomUUID(), decision };
    const result = await call('command', payload);
    if (result.status !== 200) throw new Error(JSON.stringify(result));
    g = result.data.game; humanCommands++;
    if (!duplicateChecked) {
      const duplicate = await call('command', payload); assert.equal(duplicate.data.game.view.revision, g.view.revision);
      assert.equal((await call('command', { ...initialRequest, decision })).status, 409);
      receipt.checks.push('duplicate-command-idempotent', 'stale-revision-rejected'); duplicateChecked = true;
    }
    if (humanCommands === 20) await audit();
    if (humanCommands % 20 === 0) console.log(JSON.stringify({ syntheticHumanCommands: humanCommands, revision: g.view.revision, turn: g.view.turnNumber, error: g.error }));
  }
  assert.ok(g.terminal, 'Bounded complete-game check did not reach a natural terminal');
  assert.ok(g.learnedDecisions > 0); assert.equal(g.recording.status, 'completed');
  receipt.completedNaturally = true; receipt.terminal = g.terminal; receipt.humanCommands = humanCommands;
  receipt.modelDecisions = g.learnedDecisions; receipt.helperDecisions = g.helperDecisions; receipt.finalRevision = g.view.revision;
  const directory = session.game.journal.directory, records = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.some(r => r.type === 'human-decision-offered' && r.encodedInput));
  assert.ok(records.some(r => r.type === 'human-decision-offered' && r.candidateMask.includes(null)));
  assert.ok(records.filter(r => r.type === 'decision-result').every(r => r.imitationLabelEligible === false));
  assert.ok(records.filter(r => r.type === 'human-submitted').every(r => r.behaviorSource === 'synthetic-smoke' && r.behaviorLogProbability === null));
  assert.ok(records.some(r => r.type === 'game-ended' && r.outcome));
  receipt.checks.push('natural-terminal', 'learned-model-actions', 'raw-and-encoded-records', 'unknown-prompt-masks-preserved', 'synthetic-excluded-from-human-labels');
  const next = await call('new', { modelId: 'first-baseline', deck: 0 }); assert.equal(next.status, 200);
  const stopped = await call('interrupt', request(next.data.game)); assert.equal(stopped.status, 200); assert.equal(stopped.data.game.recording.status, 'interrupted');
  receipt.checks.push('restart-and-explicit-interruption');
} catch (error) {
  receipt.error = error.stack; receipt.completedNaturally = false;
  console.error(error.stack); process.exitCode = 1;
} finally {
  await session.close(); server.closeAllConnections(); await new Promise(ok => server.close(ok));
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(process.argv[3] ?? 'runs/human-play-smoke.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}
