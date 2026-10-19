import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidateAnswers, collectLegalAnswers } from '../integrations/local-worker/decision-domain.mjs';

const prompt = overrides => ({ id: 'prompt-1', kind: 'select', min: 0, max: 2, choices: [{ id: 'a' }, { id: 'b' }], groups: [], ...overrides });
const identities = values => values.map(value => value.choiceIds.join(',')).sort();

test('finite subset domain includes every size and passes every candidate to the authority', async () => {
  const calls = [];
  const result = await collectLegalAnswers(prompt(), async answer => {
    calls.push(answer);
    return answer.choiceIds.includes('a');
  });
  assert.deepEqual(identities(calls), ['', 'a', 'a,b', 'b']);
  assert.deepEqual(identities(result.answers), ['a', 'a,b']);
  assert.equal(result.checked, 4);
  assert.equal(result.complete, true);
});

test('ordered prompts enumerate permutations of each allowed subset', () => {
  const ordered = [...generateCandidateAnswers(prompt({ kind: 'order', min: 1, max: 3,
    choices: ['a', 'b', 'c'].map(id => ({ id })) }))];
  assert.equal(ordered.length, 15);
  assert.equal(new Set(identities(ordered)).size, 15);
  assert.deepEqual(identities(ordered.filter(answer => answer.choiceIds.length === 3)),
    ['a,b,c', 'a,c,b', 'b,a,c', 'b,c,a', 'c,a,b', 'c,b,a']);
  assert.equal([...generateCandidateAnswers(prompt({ ordered: true, min: 2 }))].length, 2);
});

test('selection group bounds intersect with global cardinality bounds', () => {
  const grouped = prompt({ min: 2, max: 2, choices: [
    { id: 'a', group: 'left' }, { id: 'b', group: 'left' }, { id: 'c', group: 'right' }, { id: 'd' }],
  groups: [{ id: 'left', min: 1, max: 1 }, { id: 'right', min: 1, max: 1 }] });
  assert.deepEqual(identities([...generateCandidateAnswers(grouped)]), ['a,c', 'b,c']);
  assert.deepEqual([...generateCandidateAnswers(prompt({ groups: [{ id: 'absent', min: 1, max: 1 }] }))], []);
});

test('allocation includes omitted entries, selected zero and every inclusive integer amount', async () => {
  const allocation = prompt({ kind: 'allocation', min: 1, max: 1, allocationMode: 'final', choices: [
    { id: 'a', minAmount: 0, maxAmount: 2, initialAmount: 2 },
    { id: 'b', minAmount: 1, maxAmount: 2, initialAmount: 0 }] });
  const candidates = [...generateCandidateAnswers(allocation)];
  assert.equal(candidates.length, 12);
  assert.ok(candidates.some(answer => answer.choiceIds.length === 0 && answer.amounts.length === 0));
  assert.ok(candidates.some(answer => answer.choiceIds.join() === 'a' && answer.amounts[0].count === 0));
  const result = await collectLegalAnswers(allocation, answer => answer.amounts.reduce((sum, amount) => sum + amount.count, 0) === 2);
  assert.equal(result.checked, 12);
  assert.equal(result.answers.length, 4);
  assert.ok(result.answers.some(answer => answer.amounts.length === 2 && answer.amounts[0].count === 0 && answer.amounts[1].count === 2));
});

test('allocation does not assume amount conservation or group-count semantics', () => {
  const allocation = prompt({ kind: 'allocation', min: 7, max: 8, allocationMode: 'add',
    groups: [{ id: 'g', min: 3, max: 4 }], choices: [{ id: 'a', group: 'g', minAmount: 0, maxAmount: 0 }] });
  assert.equal([...generateCandidateAnswers(allocation)].length, 2);
});

test('ordered allocation preserves each choice and amount through every ordering', () => {
  const answers = [...generateCandidateAnswers(prompt({ kind: 'allocation', allocationMode: 'add', ordered: true,
    choices: [{ id: 'a', minAmount: 0, maxAmount: 0 }, { id: 'b', minAmount: 2, maxAmount: 2 }] }))];
  assert.equal(answers.length, 5);
  assert.deepEqual(answers.filter(answer => answer.choiceIds.length === 2).map(answer => answer.amounts), [
    [{ choiceId: 'a', count: 0 }, { choiceId: 'b', count: 2 }],
    [{ choiceId: 'b', count: 2 }, { choiceId: 'a', count: 0 }]]);
});

test('grouped selection equals an independent brute-force oracle', async () => {
  const choices = Array.from({ length: 6 }, (_, index) => ({ id: String(index), group: index % 2 ? 'odd' : 'even' }));
  const value = prompt({ min: 2, max: 4, choices,
    groups: [{ id: 'odd', min: 1, max: 2 }, { id: 'even', min: 1, max: 3 }] });
  const expected = [];
  for (let mask = 0; mask < 64; mask++) {
    const ids = choices.filter((_, index) => (mask & 2 ** index) !== 0).map(choice => choice.id);
    const odds = ids.filter(key => Number(key) % 2 === 1).length, evens = ids.length - odds;
    if (ids.length >= 2 && ids.length <= 4 && odds >= 1 && odds <= 2 && evens >= 1 && evens <= 3) expected.push(ids.join(','));
  }
  const result = await collectLegalAnswers(value, answer => answer.choiceIds.some(key => Number(key) >= 4));
  const generated = [...generateCandidateAnswers(value)];
  assert.deepEqual(identities(generated), expected.sort());
  assert.equal(result.checked, expected.length);
  assert.deepEqual(identities(result.answers), expected.filter(key => key.split(',').some(id => Number(id) >= 4)).sort());
});

test('cancellation is a distinct candidate and acknowledge may have an empty answer', () => {
  assert.deepEqual([...generateCandidateAnswers(prompt({ kind: 'acknowledge', min: 0, max: 0, choices: [], cancelable: true }))], [
    { promptId: 'prompt-1', choiceIds: [], cancel: true }, { promptId: 'prompt-1', choiceIds: [] }]);
  assert.equal([...generateCandidateAnswers(prompt({ kind: 'confirm', min: 1, max: 1 }))].length, 2);
});

test('exact budget exhaustion succeeds but incomplete domains never return completeness', async () => {
  assert.equal((await collectLegalAnswers(prompt(), () => false, { maxCandidates: 4 })).complete, true);
  let validations = 0;
  await assert.rejects(collectLegalAnswers(prompt(), () => { validations++; return true; }, { maxCandidates: 3 }),
    error => error.code === 'DECISION_DOMAIN_BUDGET_EXCEEDED');
  assert.equal(validations, 3);
  const iterator = generateCandidateAnswers(prompt(), { maxCandidates: 1 });
  assert.equal(iterator.next().done, false);
  assert.throws(() => iterator.next(), error => error.code === 'DECISION_DOMAIN_BUDGET_EXCEEDED');
});

test('unsupported kinds, ambiguous amounts and invalid bounds fail explicitly', () => {
  for (const value of [prompt({ kind: 'unknown' }), prompt({ max: Infinity }), prompt({ min: 2, max: 1 }),
    prompt({ choices: [{ id: 'a' }, { id: 'a' }] }), prompt({ choices: [{ id: 'a', group: 'missing' }] }),
    prompt({ kind: 'allocation', allocationMode: 'add', choices: [{ id: 'a', minAmount: 0 }] }),
    prompt({ kind: 'allocation', allocationMode: 'final', choices: [{ id: 'a', minAmount: 0, maxAmount: 1001 }] }),
    prompt({ kind: 'allocation', allocationMode: 'unknown', choices: [] })]) {
    assert.throws(() => [...generateCandidateAnswers(value)], error => error.code === 'UNSUPPORTED_DECISION_DOMAIN');
  }
  assert.throws(() => [...generateCandidateAnswers(prompt(), { maxCandidates: 1_000_001 })], /budget/);
});

test('native validator failures propagate and mutation cannot rewrite accepted candidates', async () => {
  await assert.rejects(collectLegalAnswers(prompt(), () => ({ valid: true })), error => error.code === 'INVALID_DECISION_VALIDATOR');
  await assert.rejects(collectLegalAnswers(prompt(), () => { throw new Error('native failure'); }), /native failure/);
  const result = await collectLegalAnswers(prompt({ min: 1, max: 1 }), answer => { answer.choiceIds[0] = 'changed'; return true; });
  assert.deepEqual(identities(result.answers), ['a', 'b']);
});

test('generation is deterministic, detached and handles the native count ceiling', () => {
  const input = prompt();
  const first = [...generateCandidateAnswers(input)];
  first.at(-1).choiceIds.push('changed');
  assert.deepEqual([...generateCandidateAnswers(input)], [...generateCandidateAnswers(input)]);
  assert.equal(input.choices.length, 2);
  const many = prompt({ min: 1000, max: 1000, choices: Array.from({ length: 1000 }, (_, index) => ({ id: String(index) })) });
  assert.equal([...generateCandidateAnswers(many, { maxCandidates: 1 })][0].choiceIds.length, 1000);
});
