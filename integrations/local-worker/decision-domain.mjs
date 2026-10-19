const kinds = new Set(['select', 'confirm', 'cards', 'pokemon', 'prizes', 'order', 'acknowledge', 'allocation']);
const nativeCountLimit = 1000;
const defaultCandidateLimit = 10_000;
const maximumCandidateLimit = 1_000_000;

export class DecisionDomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DecisionDomainError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new DecisionDomainError(code, message); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  ? value : fail('UNSUPPORTED_DECISION_DOMAIN', 'Expected a bounded nonempty identifier');
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= nativeCountLimit
  ? value : fail('UNSUPPORTED_DECISION_DOMAIN', 'Counts must be finite integers from 0 through 1000');
const bounds = input => {
  const min = count(input.min), max = count(input.max);
  if (min > max) fail('UNSUPPORTED_DECISION_DOMAIN', 'Minimum exceeds maximum');
  return { min, max };
};

function domain(prompt) {
  if (!record(prompt) || !kinds.has(prompt.kind)) fail('UNSUPPORTED_DECISION_DOMAIN', 'Unsupported prompt kind');
  if (!Array.isArray(prompt.choices) || prompt.choices.length > nativeCountLimit) {
    fail('UNSUPPORTED_DECISION_DOMAIN', 'Expected at most 1000 explicit choices');
  }
  if (prompt.groups !== undefined && (!Array.isArray(prompt.groups) || prompt.groups.length > nativeCountLimit)) {
    fail('UNSUPPORTED_DECISION_DOMAIN', 'Expected at most 1000 explicit groups');
  }
  if (prompt.ordered !== undefined && typeof prompt.ordered !== 'boolean') fail('UNSUPPORTED_DECISION_DOMAIN', 'Invalid ordered flag');
  if (prompt.cancelable !== undefined && typeof prompt.cancelable !== 'boolean') fail('UNSUPPORTED_DECISION_DOMAIN', 'Invalid cancelable flag');
  const groups = new Map();
  for (const group of prompt.groups ?? []) {
    if (!record(group)) fail('UNSUPPORTED_DECISION_DOMAIN', 'Invalid group');
    const key = id(group.id);
    if (groups.has(key)) fail('UNSUPPORTED_DECISION_DOMAIN', 'Duplicate group identifier');
    groups.set(key, { ...bounds(group), members: [] });
  }
  const seen = new Set();
  const choices = prompt.choices.map((choice, index) => {
    if (!record(choice)) fail('UNSUPPORTED_DECISION_DOMAIN', 'Invalid choice');
    const key = id(choice.id);
    if (seen.has(key)) fail('UNSUPPORTED_DECISION_DOMAIN', 'Duplicate choice identifier');
    seen.add(key);
    const result = { id: key };
    if (choice.group !== undefined && choice.group !== null) {
      result.group = id(choice.group);
      if (!groups.has(result.group)) fail('UNSUPPORTED_DECISION_DOMAIN', 'Unknown choice group');
      groups.get(result.group).members.push(index);
    }
    if (prompt.kind === 'allocation') {
      result.minAmount = count(choice.minAmount);
      result.maxAmount = count(choice.maxAmount);
      if (result.minAmount > result.maxAmount) fail('UNSUPPORTED_DECISION_DOMAIN', 'Minimum amount exceeds maximum');
      if (choice.initialAmount !== undefined) result.initialAmount = count(choice.initialAmount);
    }
    return result;
  });
  if (prompt.kind === 'allocation' && !['add', 'final'].includes(prompt.allocationMode)) {
    fail('UNSUPPORTED_DECISION_DOMAIN', 'Allocation mode must be add or final');
  }
  return { id: id(prompt.id), kind: prompt.kind, ...bounds(prompt), groups, choices,
    ordered: prompt.kind === 'order' || prompt.ordered === true, cancelable: prompt.cancelable === true };
}

function* selections(input) {
  const selected = [], counts = new Map([...input.groups.keys()].map(key => [key, 0]));
  const stack = [{ index: 0, phase: 0 }];
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.phase === 0) {
      let feasible = selected.length <= input.max && selected.length + input.choices.length - frame.index >= input.min;
      for (const [key, group] of input.groups) {
        const remaining = group.members.reduce((sum, member) => sum + Number(member >= frame.index), 0);
        feasible &&= counts.get(key) <= group.max && counts.get(key) + remaining >= group.min;
      }
      if (!feasible) { stack.pop(); continue; }
      if (frame.index === input.choices.length) {
        yield [...selected];
        stack.pop();
        continue;
      }
      frame.phase = 1;
      stack.push({ index: frame.index + 1, phase: 0 });
    } else if (frame.phase === 1) {
      frame.phase = 2;
      const choice = input.choices[frame.index];
      selected.push(choice);
      if (choice.group !== undefined) counts.set(choice.group, counts.get(choice.group) + 1);
      stack.push({ index: frame.index + 1, phase: 0 });
    } else {
      const choice = selected.pop();
      if (choice.group !== undefined) counts.set(choice.group, counts.get(choice.group) - 1);
      stack.pop();
    }
  }
}

function* permutations(values, ordered) {
  const result = [...values];
  yield [...result];
  if (!ordered) return;
  const counters = new Array(result.length).fill(0);
  let index = 1;
  while (index < result.length) {
    if (counters[index] < index) {
      const swap = index % 2 === 0 ? 0 : counters[index];
      [result[swap], result[index]] = [result[index], result[swap]];
      yield [...result];
      counters[index]++;
      index = 1;
    } else {
      counters[index] = 0;
      index++;
    }
  }
}

function* allocations(input) {
  const amounts = new Array(input.choices.length).fill(null);
  while (true) {
    yield input.choices.flatMap((choice, index) => amounts[index] === null ? [] : [{ ...choice, amount: amounts[index] }]);
    let index = input.choices.length - 1;
    while (index >= 0 && amounts[index] === input.choices[index].maxAmount) {
      amounts[index] = null;
      index--;
    }
    if (index < 0) return;
    amounts[index] = amounts[index] === null ? input.choices[index].minAmount : amounts[index] + 1;
  }
}

export function* generateCandidateAnswers(prompt, { maxCandidates = defaultCandidateLimit } = {}) {
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > maximumCandidateLimit) {
    fail('UNSUPPORTED_DECISION_DOMAIN', 'Candidate budget must be from 1 through 1000000');
  }
  const input = domain(prompt);
  let emitted = 0;
  const checked = answer => {
    if (emitted >= maxCandidates) fail('DECISION_DOMAIN_BUDGET_EXCEEDED', `Decision domain exceeds ${maxCandidates} candidates`);
    emitted++;
    return answer;
  };
  if (input.cancelable) yield checked({ promptId: input.id, choiceIds: [], cancel: true });
  // Allocation bounds may describe units rather than selected-card counts.
  // The native validator owns those constraints and amount conservation.
  const selectedDomains = input.kind === 'allocation' ? allocations(input) : selections(input);
  for (const selected of selectedDomains) {
    for (const permutation of permutations(selected, input.ordered)) {
      const answer = { promptId: input.id, choiceIds: permutation.map(choice => choice.id) };
      if (input.kind === 'allocation') {
        answer.amounts = permutation.map(choice => ({ choiceId: choice.id, count: choice.amount }));
      }
      yield checked(answer);
    }
  }
}

export async function collectLegalAnswers(prompt, validate, options = {}) {
  if (typeof validate !== 'function') fail('INVALID_DECISION_VALIDATOR', 'Expected an authoritative validator');
  const answers = [];
  let checked = 0;
  for (const candidate of generateCandidateAnswers(prompt, options)) {
    const result = await validate(structuredClone(candidate));
    checked++;
    if (typeof result !== 'boolean') fail('INVALID_DECISION_VALIDATOR', 'Validator must return a boolean');
    if (result) answers.push(candidate);
  }
  return { answers, checked, complete: true };
}
