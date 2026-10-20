import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateDataset, evaluateShadow, parseJsonl } from '../src/shadow-play.mjs';
import exampleAdapter from '../examples/shadow-policy.mjs';
import { decision } from './shadow-fixture.mjs';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';
import { nativeShadowPolicy } from '../integrations/local-worker/shadow-policy.mjs';

const adapter = (decide, extra = {}) => ({ ...exampleAdapter, create: async () => ({ decide }), ...extra });
const run = (rows, policy, options = {}) => evaluateShadow(rows, { adapter: policy, ...options });

test('same policy shadows both seats with fresh state and restores the human trace', async () => {
  const rows = [decision(), decision({ id: 'synthetic-1', actorSeat: 1, source: { ...decision().source, preActionMs: 3000, actionEndMs: 3100 }, future: { reveals: [{ atMs: 4000, value: 'FUTURE_SECRET' }], outcome: 'FUTURE_OUTCOME' } })];
  const original = structuredClone(rows), seen = [];
  let creates = 0, closes = 0;
  const report = await run(rows, adapter(null, { create: async () => {
    creates++;
    let called = false;
    return { decide(input) {
      assert.equal(called, false); called = true; seen.push(input);
      assert.deepEqual(Object.keys(input).sort(), ['actorSeat', 'candidates', 'observation', 'schema']);
      assert.equal(JSON.stringify(input).includes('FUTURE'), false);
      assert.equal(JSON.stringify(input).includes('human'), false);
      assert.equal(JSON.stringify(input).includes('review'), false);
      assert.equal(input.candidates.some(item => item.id === 'illegal'), false);
      return { actionId: 'pass', ranking: ['pass', 'attach'] };
    }, close() { closes++; } };
  } }));
  assert.deepEqual(seen.map(item => item.actorSeat), [0, 1]);
  assert.equal(creates, 2); assert.equal(closes, 2);
  assert.deepEqual(rows, original);
  assert.equal(report.aggregate.exactAgreement.numerator, 0);
  assert.equal(report.aggregate.exactAgreement.denominator, 2);
  assert.equal(report.aggregate.topKAgreement.numerator, 2);
  assert.equal(report.aggregate.reviewedMistakes.count, 0);
  assert.equal(report.aggregate.reviewedMistakes.mean, null);
  assert.equal(Object.keys(report.byPlayer).length, 2);
});

test('missing hands, all-masked states, incomplete alternatives and unsupported cards abstain before inference', async () => {
  const rows = [];
  for (const [id, change] of [
    ['hand', row => { row.observation.actorHand.complete = false; row.observation.actorHand.cards = []; row.observation.masks = [{ field: 'actorHand', reason: 'unreadable' }]; }],
    ['masked', row => { row.observation.facts = []; row.observation.actorHand.complete = false; row.observation.actorHand.cards = []; row.observation.publicState.complete = false; row.observation.masks = [{ field: 'actorHand', reason: 'unreadable' }, { field: 'publicState', reason: 'occluded' }]; }],
    ['alternatives', row => { row.candidates.complete = false; }],
    ['card', row => { row.decks[1].printingIds.push('unsupported:2024'); }],
  ]) {
    const row = decision({ id, matchId: id }); change(row); rows.push(row);
  }
  const report = await run(rows, adapter(() => { throw new Error('must never infer'); }));
  assert.equal(report.aggregate.attempted, 0);
  assert.equal(report.aggregate.abstained, 4);
  assert.equal(report.aggregate.coverage, 0);
});

test('ambiguous or low-confidence labels cannot count exact disagreement', async () => {
  for (const human of [
    { ...decision().human, status: 'ambiguous', actionIds: ['attach', 'pass'] },
    { ...decision().human, confidence: 0.5 },
    { ...decision().human, review: 'unreviewed' },
  ]) {
    const report = await run([decision({ human })], adapter(() => ({ actionId: 'pass' })));
    assert.equal(report.aggregate.exactAgreement.denominator, 0);
    assert.equal(report.aggregate.reviewedMistakes.count, 0);
  }
});

test('known illegal selections, malformed actions and unknown legality have distinct denominators', async () => {
  const illegal = await run([decision()], adapter(() => ({ actionId: 'illegal' })));
  assert.equal(illegal.aggregate.illegalRate.numerator, 1);
  assert.equal(illegal.aggregate.illegalRate.denominator, 1);
  const outside = await run([decision()], adapter(() => ({ actionId: 'not-in-offer' })));
  assert.equal(outside.aggregate.actionErrors, 1);
  assert.equal(outside.aggregate.illegalRate.denominator, 0);
  const row = decision(); row.candidates.items[1].legality = 'unknown';
  const unknown = await run([row], adapter(() => ({ actionId: 'pass' })));
  assert.equal(unknown.aggregate.unknownLegality, 1);
  assert.equal(unknown.aggregate.illegalRate.denominator, 0);
  assert.equal(unknown.aggregate.exactAgreement.denominator, 0);
});

test('only independently reviewed, action-specific valid labels produce mistake points', async () => {
  const row = decision();
  row.review = { status: 'independent', reviewer: 'synthetic-independent-reviewer', independentOfHuman: true, reason: 'Synthetic independent analysis.', actionScores: [{ actionId: 'pass', points: 2, evidence: 'Constructed demonstrated error.' }] };
  const reviewed = await run([row], adapter(() => ({ actionId: 'pass' })));
  assert.equal(reviewed.aggregate.reviewedMistakes.points, 2);
  assert.equal(reviewed.aggregate.reviewedMistakes.count, 1);
  const unknown = await run([row], adapter(() => ({ actionId: 'attach' })));
  assert.equal(unknown.aggregate.reviewedMistakes.count, 0);
});

test('schema mismatch and training overlap fail before policy construction', async () => {
  let created = false;
  const policy = adapter(null, { observationSchema: 'wrong-schema', create() { created = true; } });
  await assert.rejects(run([decision()], policy), /schema|contract/i);
  assert.equal(created, false);
  await assert.rejects(run([decision()], exampleAdapter, { trainingManifest: { schema: 'shadow-training-manifest/1', eventIds: ['synthetic-event'], matchIds: [] } }), /train|overlap|leak/i);
  const train = decision({ split: 'train' });
  assert.throws(() => validateDataset([train]), /split|train/i);
  const split = decision({ id: 'other', split: 'validation', matchId: 'other-match' });
  assert.throws(() => validateDataset([decision(), split]), /split|event/i);
  split.splitUnit = 'match';
  assert.throws(() => validateDataset([decision(), split]), /split|event/i);
});

test('validator rejects spectator identities, future inputs, missing masks and duplicate labels', () => {
  for (const mutate of [
    row => row.observation.facts.push({ key: 'opponent.hand', value: ['secret'], knowledge: 'public', knownAtMs: 900, evidence: 'Spectator overlay.' }),
    row => row.observation.facts[0].knownAtMs = 1500,
    row => row.observation.actorHand.knownAtMs = 1500,
    row => { row.observation.actorHand.complete = false; row.observation.actorHand.cards = []; },
    row => row.human.actionIds = ['attach', 'attach'],
    row => row.future.reveals[0].atMs = 900,
    row => row.observation.facts[0].value = [null],
  ]) {
    const row = decision(); mutate(row); assert.throws(() => validateDataset([row]));
  }
  assert.throws(() => parseJsonl('{bad}\n'), /line|JSON/i);
  assert.throws(() => validateDataset([decision(), decision()]), /duplicate|unique/i);
});

test('CLI validates fixtures and evaluates both seats without a native or GPU runtime', () => {
  const file = 'examples/shadow-decisions.synthetic.jsonl';
  const validation = spawnSync(process.execPath, ['scripts/shadow-play.mjs', 'validate', file], { encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr);
  const evaluated = spawnSync(process.execPath, ['scripts/shadow-play.mjs', 'evaluate', file, '--adapter', 'examples/shadow-policy.mjs'], { encoding: 'utf8' });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  const report = JSON.parse(evaluated.stdout);
  assert.equal(report.aggregate.windows, 2);
  assert.equal(report.aggregate.exactAgreement.numerator, 2);
  assert.equal(Object.keys(report.byPlayer).length, 2);
  assert.equal(readFileSync(file, 'utf8').includes('"kind":"synthetic"'), true);
});

test('native checkpoint handshake rejects feature mismatch without launching inference', async () => {
  const valid = { schema: 'native-ordinary-features/1', stateDim: 32, candidateDim: 27, checkpoint: 'private-model.pt' };
  const info = await NativeModelClient.prototype.verify.call({ request: async op => { assert.equal(op, 'ping'); return valid; } });
  assert.equal(info, valid);
  for (const change of [{ schema: 'old-checkpoint' }, { stateDim: 31 }, { candidateDim: 26 }, { checkpoint: null }]) {
    await assert.rejects(NativeModelClient.prototype.verify.call({ request: async () => ({ ...valid, ...change }) }), /contract mismatch/);
  }
  assert.throws(() => nativeShadowPolicy({}), /projector/);
});

test('unknown actor, incomplete deck identity and policy abstention preserve coverage groups', async () => {
  const unknown = decision({ actorSeat: null });
  const report = await run([unknown], exampleAdapter);
  assert.equal(report.aggregate.attempted, 0);
  assert.equal(report.aggregate.abstentionReasons['unknown-actor'], 1);
  assert.equal(report.byPlayer['synthetic-left'].windows, 0);
  assert.equal(report.byPlayer['synthetic-right'].windows, 0);
  assert.equal(report.byPlayer['unknown-actor'].windows, 1);
  const row = decision(); row.decks[0].identityComplete = false;
  const incomplete = await run([row], exampleAdapter);
  assert.equal(incomplete.aggregate.attempted, 0);
  const abstained = await run([decision()], adapter(() => ({ abstain: 'insufficient policy confidence' })));
  assert.equal(abstained.aggregate.eligible, 1);
  assert.equal(abstained.aggregate.answered, 0);
  assert.equal(abstained.aggregate.abstained, 1);
});

test('unsupported hand, insufficient ranking and changing adapter identity cannot produce misleading scores', async () => {
  const row = decision(); row.observation.actorHand.cards = ['unsupported:2024'];
  const unsupported = await run([row], adapter(() => { throw new Error('must not infer'); }));
  assert.equal(unsupported.aggregate.attempted, 0);
  const argmax = await run([decision()], adapter(() => ({ actionId: 'attach' })));
  assert.equal(argmax.aggregate.exactAgreement.denominator, 1);
  assert.equal(argmax.aggregate.topKAgreement.denominator, 0);
  const changing = adapter(() => { changing.checkpointId = 'different-checkpoint'; return { actionId: 'attach' }; });
  await assert.rejects(run([decision()], changing), /contract changed/);
});

test('CLI refuses invalid top-k and preserves existing output files', () => {
  const args = ['scripts/shadow-play.mjs', 'evaluate', 'examples/shadow-decisions.synthetic.jsonl', '--adapter', 'examples/shadow-policy.mjs'];
  const invalid = spawnSync(process.execPath, [...args, '--top-k', 'NaN'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /topK/);
  const overwrite = spawnSync(process.execPath, [...args, '--output', 'examples/shadow-decisions.synthetic.jsonl'], { encoding: 'utf8' });
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /new file|runs directory/);
});

test('policy failure still closes its instance and malformed rankings receive no score', async () => {
  let closed = 0;
  const failed = await run([decision()], adapter(null, { create: async () => ({ decide() { throw new Error('inference failed'); }, close() { closed++; } }) }));
  assert.equal(closed, 1);
  assert.equal(failed.aggregate.actionErrors, 1);
  assert.equal(failed.aggregate.exactAgreement.denominator, 0);
  const duplicate = await run([decision()], adapter(() => ({ actionId: 'attach', ranking: ['attach', 'attach'] })));
  assert.equal(duplicate.aggregate.actionErrors, 1);
  assert.equal(duplicate.aggregate.topKAgreement.denominator, 0);
  const withheld = await run([decision()], adapter(() => ({ actionId: 'attach', ranking: ['attach', 'illegal'] })));
  assert.equal(withheld.aggregate.actionErrors, 1);
  assert.equal(withheld.aggregate.topKAgreement.denominator, 0);
});

test('CLI rejects a checkpoint changed during evaluation before emitting a report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-checkpoint-test-'));
  const checkpoint = join(directory, 'checkpoint.bin'), module = join(directory, 'adapter.mjs');
  writeFileSync(checkpoint, 'frozen');
  writeFileSync(module, `import { writeFileSync } from 'node:fs';
export default {schema:'shadow-policy/1',observationSchema:'shadow-observation/1',policyId:'test',checkpointId:'test',supportedProfiles:['synthetic-duel/1'],supportedCards:['synthetic:creature','synthetic:energy'],
create:async ({checkpoint})=>({decide(input){writeFileSync(checkpoint,'changed');return {actionId:input.candidates[0].id};}})};`);
  try {
    const result = spawnSync(process.execPath, ['scripts/shadow-play.mjs', 'evaluate', 'examples/shadow-decisions.synthetic.jsonl', '--adapter', module, '--checkpoint', checkpoint], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checkpoint changed/);
    assert.equal(result.stdout, '');
  } finally {
    unlinkSync(checkpoint); unlinkSync(module); rmdirSync(directory);
  }
});
