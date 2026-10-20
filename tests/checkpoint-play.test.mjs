import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';
import { humanPresentation, modelCatalog } from '../play/session.mjs';
import { createPlayServer } from '../scripts/play-checkpoint.mjs';
import { promptAnswer } from '../play/prompt-answer.mjs';

test('damage allocation omits unused add targets and retains zero final counter states', () => {
  const prompt = { id: 'damage', kind: 'allocation', choices: [{ id: 'first' }, { id: 'second', initialAmount: 3 }] };
  const amounts = new Map([['first', 6], ['second', 0]]);
  assert.deepEqual(promptAnswer({ ...prompt, allocationMode: 'add' }, [], amounts).amounts, [{ choiceId: 'first', count: 6 }]);
  assert.deepEqual(promptAnswer({ ...prompt, allocationMode: 'final' }, [], amounts).amounts, [{ choiceId: 'first', count: 6 }, { choiceId: 'second', count: 0 }]);
  assert.deepEqual(promptAnswer({ id: 'order', kind: 'order' }, ['second', 'first'], amounts).choiceIds, ['second', 'first']);
});

function fixture() {
  const card = id => ({ instanceId: `native-${id}`, printingId: 'SET-1', category: 'pokemon', name: `Visible ${id}`, hiddenProgram: 'SECRET' });
  const creature = owner => ({ ...card(owner), owner, definitionId: 'set_1', hp: 120, damage: 10,
    providedEnergy: 1, currentRetreat: 1, printedRetreat: 1, conditions: [], publicCards: { energy: [card(`${owner}-energy`)], tools: [], evolutions: [] } });
  const side = owner => ({ active: creature(owner), bench: [], prizes: 6, deckCount: 40, handCount: 5, discard: [],
    hand: ['SECRET-HAND'], deck: ['SECRET-DECK'], prizeIdentities: ['SECRET-PRIZE'] });
  return { source: 'live-matchlogic', status: 'playing', revision: 4, turn: 'you', turnNumber: 3,
    result: null, hand: [card('hand')], you: side('you'), opponent: side('opponent'), stadium: null,
    seed: 8675309, authority: 'SECRET-AUTHORITY', log: [{ message: 'SECRET-LOG' }],
    actions: [{ id: 'native-play', kind: 'play', sourceCardId: 'native-hand', targetId: 'native-you', label: 'Play visible card' }],
    prompts: [{ id: 'native-prompt', kind: 'cards', min: 1, max: 1, cancelable: false, ordered: true,
      title: 'Choose a card', detail: 'Only visible choices', groups: [{ id: 'native-group', label: 'Cards', min: 1, max: 1 }],
      choices: [{ id: 'native-choice', card: card('hand'), group: 'native-group', label: 'Visible hand card' }] }] };
}

test('human presentation adds approved labels without exposing hidden native fields', () => {
  const raw = fixture();
  const policy = new PolicyView().project(raw);
  const presented = humanPresentation(policy, raw);
  const serialized = JSON.stringify(presented);
  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(serialized.includes('native-'), false);
  assert.equal(serialized.includes('8675309'), false);
  assert.equal(presented.opponent.hand, undefined);
  assert.equal(presented.opponent.deck, undefined);
  assert.equal(presented.opponent.prizeIdentities, undefined);
  assert.equal(presented.hand[0].name, 'Visible hand');
  assert.equal(presented.opponent.active.publicCards.energy[0].name, 'Visible opponent-energy');
  assert.equal(presented.actions[0].label, 'Play visible card');
  assert.equal(presented.prompts[0].choices[0].label, 'Visible hand card');
  assert.equal(presented.prompts[0].groups[0].label, 'Cards');
  assert.equal(presented.prompts[0].ordered, true);
  assert.equal(policy.hand[0].name, undefined);
});

test('presentation is invariant under changes to hidden hand, deck, prizes and authority', () => {
  const first = fixture();
  const second = structuredClone(first);
  second.seed++;
  second.authority = { changed: true };
  second.opponent.hand.reverse();
  second.opponent.deck = ['DIFFERENT-SECRET'];
  second.opponent.prizeIdentities = ['ANOTHER-SECRET'];
  second.log = [{ message: 'DIFFERENT-SECRET' }];
  assert.deepEqual(humanPresentation(new PolicyView().project(first), first), humanPresentation(new PolicyView().project(second), second));
});

test('catalog binds displayed checkpoint to receipt digest and excludes private filesystem paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-catalog-'));
  try {
    const checkpoint = join(directory, 'model.pt');
    const receipt = join(directory, 'receipt.json');
    const bytes = Buffer.from('saved checkpoint fixture');
    writeFileSync(checkpoint, bytes);
    writeFileSync(receipt, JSON.stringify({ featureSchema: 'native-ordinary-features/1',
      runtime: { objective: 'legal-candidate supervised imitation', parameters: 1953 },
      training: { checkpointSha256: createHash('sha256').update(bytes).digest('hex'), records: 125, updates: 10 },
      heldout: { records: 60, teacherAgreement: 0.4 } }));
    const config = { models: [{ id: 'm1', name: 'Model 1', version: 'v1', receipt, model: { checkpoint, executable: 'PRIVATE-PYTHON' } }] };
    const [model] = modelCatalog(config);
    assert.equal(model.training.labels, 125);
    assert.equal(model.training.teacherAgreement, 0.4);
    assert.match(model.decks[0], /not specified/);
    assert.equal(JSON.stringify(model).includes(directory), false);
    assert.equal(JSON.stringify(model).includes('PRIVATE-PYTHON'), false);
    writeFileSync(checkpoint, 'changed checkpoint');
    assert.throws(() => modelCatalog(config), /differs from its training receipt/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('each checkpoint displays its own training coverage and selection-validation provenance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-coverage-'));
  try {
    const checkpoint = join(directory, 'model.pt');
    const receipt = join(directory, 'receipt.json');
    const bytes = Buffer.from('second saved checkpoint fixture');
    writeFileSync(checkpoint, bytes);
    writeFileSync(receipt, JSON.stringify({ featureSchema: 'native-ordinary-features/1',
      runtime: { objective: 'legal-candidate supervised imitation', parameters: 1953 },
      training: { checkpointSha256: createHash('sha256').update(bytes).digest('hex'), records: 673, updates: 200 },
      heldout: { records: 218, teacherAgreement: 107 / 218, kind: 'validation used for checkpoint selection; not untouched final test' },
      coverage: { trainedOnLabel: 'Both pinned private decks; 18 human-seat teacher games',
        collection: [{ split: 'train', actorSeat: 'human', decks: [{ deckIndex: 0, records: 302, games: 9 }, { deckIndex: 1, records: 371, games: 9 }] }],
        finalPolicyRoleEvaluation: 'pending fixed paired native evaluation', nativePins: { workerSha256: 'pinned-worker' } } }));
    const config = { native: { workerSha256: 'pinned-worker' }, models: [{ id: 'm2', name: 'Model 2', version: 'v2', receipt, model: { checkpoint } }] };
    const [model] = modelCatalog(config);
    assert.match(model.decks[0], /Both pinned private decks/);
    assert.match(model.decks[1], /Dragapult ex: 302 labels from 9 human-seat games/);
    assert.match(model.decks[2], /Zoroark ex: 371 labels from 9 human-seat games/);
    assert.match(model.training.validationUse, /not untouched final test/);
    assert.match(model.mechanics.at(-1), /pending fixed paired/);
    assert.equal(JSON.stringify(model).includes('pinned-worker'), false);
    config.native.workerSha256 = 'different-worker';
    assert.throws(() => modelCatalog(config), /different native runtime pins/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const configPath = process.env.CHECKPOINT_PLAY_CONFIG;
test('loopback HTTP rejects foreign origins, hosts and filesystem routes', { skip: !configPath }, async () => {
  const { server, session } = createPlayServer(JSON.parse(readFileSync(configPath, 'utf8')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/api/state`)).status, 200);
    for (const route of ['/runs/play-local.json', '/art/%2e%2e%2fplay-local.json', '/learning/native_torch.py', '/api/authority']) {
      assert.equal((await fetch(origin + route)).status, 404, route);
    }
    assert.equal((await fetch(`${origin}/api/new`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${origin}/api/new`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 403);
    const foreignHostStatus = await new Promise((resolve, reject) => {
      get(`${origin}/api/state`, { headers: { Host: 'foreign.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    const catalog = await (await fetch(`${origin}/api/catalog`)).json();
    assert.equal(catalog.models.length > 0, true);
    assert.equal(JSON.stringify(catalog).includes('checkpoint"'), false);
    assert.deepEqual(await (await fetch(`${origin}/api/state`)).json(), { game: null });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await session.close();
  }
});
