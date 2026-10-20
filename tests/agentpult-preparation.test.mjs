import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { teacherCatalog, prepareAgentPultPlans, aggregateAgentPultDatasets } from '../scripts/prepare-agentpult-training.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const scratch = () => { const path = join(root, 'runs', `preparation-test-${randomUUID()}`); mkdirSync(path, { recursive: true }); return path; };

test('fixed AgentPult specification retains exact sixty and explicit mechanical aliases', () => {
  const deck = read(join(root, 'learning/agentpult-deck.json'));
  assert.equal(deck.cards.length, 24);
  assert.equal(deck.cards.reduce((sum, card) => sum + card.count, 0), 60);
  assert.equal(deck.cards.find(card => card.set === 'JTG' && card.number === 120)?.count, 1);
  assert.equal(deck.cards.some(card => card.set === 'TEF' && card.number === 128), false);
  assert.equal(Object.keys(deck.mechanicalAliases).length, 8);
  assert.equal(deck.currentLegalityClaim, false);
});

test('catalog retains scalar identity metadata and rejects ambiguous joins without copying effects', () => {
  const cards = [{ cardSourceID: 'private-program', useActions: [{ actionName: 'Printed move', actionSourceID: 12,
    subActions: [{ vendorEffect: 'must stay outside catalog' }] }] }];
  const joins = [{ printingId: 'PUBLIC-1', cardSourceID: 'private-program', status: 'joined' }];
  const catalog = teacherCatalog(cards, joins, { 'REPRINT-1': 'PUBLIC-1' });
  assert.equal(catalog.actions['PUBLIC-1']['Printed move'], 'private-program/12');
  assert.equal(catalog.sourceByPrinting['REPRINT-1'], 'private-program');
  assert.equal(JSON.stringify(catalog).includes('vendorEffect'), false);
  assert.throws(() => teacherCatalog([{ ...cards[0], useActions: [...cards[0].useActions, ...cards[0].useActions] }], joins));
  assert.throws(() => teacherCatalog(cards, joins, { BAD: 'MISSING-1' }));
});

test('phase plans derive exact frozen seeds and refuse overwriting an existing directory', () => {
  const directory = scratch(), profile = join(directory, 'profile'); mkdirSync(profile);
  save(join(profile, 'teacher-catalog.json'), { actions: { 'TWM-129': { '[Ability] Recon Directive': 'recon' }, 'TWM-130': { 'Phantom Dive': 'dive' } } });
  const plans = join(directory, 'plans'); prepareAgentPultPlans(profile, plans);
  const bootstrap = read(join(plans, 'bootstrap.json')), qualification = read(join(plans, 'qualification.json'));
  assert.equal(bootstrap.tasks.length, 32);
  assert.equal(bootstrap.tasks.filter(task => task.split === 'train').length, 24);
  assert.equal(bootstrap.tasks.filter(task => task.split === 'validation').length, 8);
  assert.equal(qualification.tasks.length, 4);
  for (const task of [...bootstrap.tasks, ...qualification.tasks]) assert.equal(task.seatOrder[task.policySeat === 'human' ? 0 : 1], 0);
  assert.throws(() => prepareAgentPultPlans(profile, plans), /fresh private/);
  const checkpoint = join(directory, 'checkpoint.pt'), config = join(directory, 'model-config.json');
  writeFileSync(checkpoint, 'test fixture'); save(config, { executable: process.execPath, checkpoint, device: 'cuda' });
  const learnedPlans = join(directory, 'learned-plans');
  prepareAgentPultPlans(profile, learnedPlans, { bootstrap: config, final: config, baseline: config });
  const dagger = read(join(learnedPlans, 'dagger.json')), final = read(join(learnedPlans, 'final-evaluation.json'));
  assert.equal(dagger.tasks.length, 12); assert.equal(dagger.teacherMix, 0.25);
  assert.equal(dagger.tasks.filter(task => task.split === 'validation').length, 4);
  assert.equal(final.tasks.length, 8); assert.equal(final.teacherMix, 0); assert.equal(final.modelKind, 'card-action');
  assert.equal(read(join(learnedPlans, 'baseline-evaluation.json')).modelKind, 'native-v2');
  assert.equal(read(final.modelConfig).device, 'cpu'); assert.equal(read(config).device, 'cuda');
});

test('aggregation admits complete games once and rejects duplicate identities', () => {
  const directory = scratch();
  const parent = (name, offset) => {
    const path = join(directory, name); mkdirSync(path);
    const games = [0, 1].map(index => {
      const id = `seed-${offset + index}`, recordsPath = `${id}/records.jsonl`, bytes = Buffer.from('{"label":0}\n');
      mkdirSync(join(path, id)); writeFileSync(join(path, recordsPath), bytes);
      return { id, seed: offset + index, split: index ? 'validation' : 'train', completedNaturally: true,
        rejected: 0, commands: 2, privacyChecks: 4, realHandExchanges: 2, recordsPath, recordsSha256: hash(bytes) };
    });
    save(join(path, 'receipt.json'), { schema: 'native-card-action-dataset/1', complete: true, fatal: false,
      featureContract: { schema: 'test' }, sourceHashes: { source: 'a'.repeat(64) }, pins: { worker: 'b'.repeat(64) },
      printingAliases: {}, policyDeckHash: 'c'.repeat(64), opponentDeckHash: 'd'.repeat(64), games, outcomes: [], unattempted: [] });
    return path;
  };
  const first = parent('first', 1), second = parent('second', 3), output = join(directory, 'aggregate');
  assert.equal(aggregateAgentPultDatasets(first, second, output).games, 4);
  assert.equal(read(join(output, 'receipt.json')).counts.completed, 4);
  assert.throws(() => aggregateAgentPultDatasets(first, first, join(directory, 'duplicate')), /duplicate/);
  const corrupt = read(join(second, 'receipt.json')); corrupt.games[0].id = '../escape'; save(join(second, 'receipt.json'), corrupt);
  assert.throws(() => aggregateAgentPultDatasets(first, second, join(directory, 'escape')), /duplicate, incomplete or corrupt/);
});
