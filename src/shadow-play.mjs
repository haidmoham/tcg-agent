export const DECISION_SCHEMA = 'shadow-decision/1';
export const OBSERVATION_SCHEMA = 'shadow-observation/1';

const factKeys = new Set([
  'turn', 'turnNumber', 'phase', 'you.active', 'you.bench', 'you.discard', 'you.lostZone',
  'you.handCount', 'you.deckCount', 'you.prizeCount', 'opponent.active', 'opponent.bench',
  'opponent.discard', 'opponent.lostZone', 'opponent.handCount', 'opponent.deckCount',
  'opponent.prizeCount', 'stadium', 'you.usedSupporter', 'you.usedEnergy', 'you.usedRetreat', 'you.usedVstar',
]);
const fail = (path, reason) => { throw new TypeError(`${path}: ${reason}`); };
const object = (value, required, path, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required');
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) fail(`${path}.${key}`, 'not allowed');
};
const text = (value, path) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail(path, 'expected nonempty text of at most 2000 characters');
};
const boolean = (value, path) => { if (typeof value !== 'boolean') fail(path, 'expected boolean'); };
const integer = (value, path) => { if (!Number.isSafeInteger(value) || value < 0) fail(path, 'expected nonnegative integer'); };
const oneOf = (value, choices, path) => { if (!choices.includes(value)) fail(path, `expected ${choices.join(' | ')}`); };
const array = (value, path) => { if (!Array.isArray(value)) fail(path, 'expected array'); };
const strings = (value, path) => {
  array(value, path);
  value.forEach((item, index) => text(item, `${path}[${index}]`));
};
const unique = (values, path) => { if (new Set(values).size !== values.length) fail(path, 'duplicates are not allowed'); };
const evidence = (value, path) => text(value, path);
const url = (value, path) => {
  text(value, path);
  try { if (!['https:', 'synthetic:'].includes(new URL(value).protocol)) fail(path, 'expected HTTPS or synthetic URL'); }
  catch { fail(path, 'expected HTTPS or synthetic URL'); }
};
const scalar = value => value === null || ['string', 'boolean'].includes(typeof value)
  || (typeof value === 'number' && Number.isFinite(value));

function validateRecord(record, path) {
  object(record, ['schema', 'id', 'kind', 'benchmarkOnly', 'split', 'splitUnit', 'eventId', 'matchId', 'gameId',
    'players', 'actorSeat', 'source', 'rules', 'decks', 'observation', 'candidates', 'human', 'review', 'future'], path);
  oneOf(record.schema, [DECISION_SCHEMA], `${path}.schema`);
  for (const key of ['id', 'eventId', 'matchId', 'gameId']) text(record[key], `${path}.${key}`);
  oneOf(record.kind, ['synthetic', 'stream'], `${path}.kind`);
  oneOf(record.benchmarkOnly, [true], `${path}.benchmarkOnly`);
  oneOf(record.split, ['validation', 'test'], `${path}.split`);
  oneOf(record.splitUnit, ['event', 'match'], `${path}.splitUnit`);
  oneOf(record.actorSeat, [0, 1, null], `${path}.actorSeat`);
  array(record.players, `${path}.players`);
  if (record.players.length !== 2) fail(`${path}.players`, 'exactly two seats required');
  record.players.forEach((player, index) => {
    object(player, ['seat', 'id'], `${path}.players[${index}]`);
    oneOf(player.seat, [0, 1], `${path}.players[${index}].seat`);
    text(player.id, `${path}.players[${index}].id`);
    if (player.id === 'unknown-actor') fail(`${path}.players[${index}].id`, 'reserved for the unknown actor group');
  });
  unique(record.players.map(player => player.seat), `${path}.players.seat`);
  unique(record.players.map(player => player.id), `${path}.players.id`);
  const source = record.source;
  object(source, ['url', 'videoId', 'preActionMs', 'actionEndMs', 'frameVerified', 'evidence'], `${path}.source`);
  url(source.url, `${path}.source.url`); text(source.videoId, `${path}.source.videoId`);
  integer(source.preActionMs, `${path}.source.preActionMs`); integer(source.actionEndMs, `${path}.source.actionEndMs`);
  if (source.actionEndMs < source.preActionMs) fail(`${path}.source.actionEndMs`, 'must not precede pre-action time');
  boolean(source.frameVerified, `${path}.source.frameVerified`); evidence(source.evidence, `${path}.source.evidence`);
  if (record.kind === 'stream' && !source.url.startsWith('https://')) fail(`${path}.source.url`, 'stream source must use HTTPS');
  object(record.rules, ['profile', 'evidence'], `${path}.rules`);
  text(record.rules.profile, `${path}.rules.profile`); evidence(record.rules.evidence, `${path}.rules.evidence`);
  array(record.decks, `${path}.decks`);
  if (record.decks.length !== 2) fail(`${path}.decks`, 'exactly two deck seats required');
  record.decks.forEach((deck, index) => {
    const p = `${path}.decks[${index}]`;
    object(deck, ['seat', 'sourceUrl', 'printingIds', 'identityComplete'], p);
    oneOf(deck.seat, [0, 1], `${p}.seat`); url(deck.sourceUrl, `${p}.sourceUrl`);
    strings(deck.printingIds, `${p}.printingIds`); unique(deck.printingIds, `${p}.printingIds`);
    boolean(deck.identityComplete, `${p}.identityComplete`);
    if (deck.identityComplete && !deck.printingIds.length) fail(`${p}.printingIds`, 'complete identity requires printings');
  });
  unique(record.decks.map(deck => deck.seat), `${path}.decks.seat`);
  const observation = record.observation;
  object(observation, ['facts', 'actorHand', 'publicState', 'masks'], `${path}.observation`);
  array(observation.facts, `${path}.observation.facts`);
  observation.facts.forEach((fact, index) => {
    const p = `${path}.observation.facts[${index}]`;
    object(fact, ['key', 'value', 'knowledge', 'knownAtMs', 'evidence'], p);
    if (!factKeys.has(fact.key)) fail(`${p}.key`, 'unapproved fact key or hidden opponent identity');
    if (!(scalar(fact.value) || (Array.isArray(fact.value) && fact.value.every(value => value !== null && scalar(value))))) fail(`${p}.value`, 'expected scalar or known scalar array');
    oneOf(fact.knowledge, ['public', 'actor'], `${p}.knowledge`);
    integer(fact.knownAtMs, `${p}.knownAtMs`);
    if (fact.knownAtMs > source.preActionMs) fail(`${p}.knownAtMs`, 'future information cannot enter pre-action facts');
    evidence(fact.evidence, `${p}.evidence`);
  });
  unique(observation.facts.map(fact => fact.key), `${path}.observation.facts.key`);
  const hand = observation.actorHand;
  object(hand, ['complete', 'cards', 'knownAtMs', 'evidence'], `${path}.observation.actorHand`);
  boolean(hand.complete, `${path}.observation.actorHand.complete`); strings(hand.cards, `${path}.observation.actorHand.cards`);
  integer(hand.knownAtMs, `${path}.observation.actorHand.knownAtMs`);
  if (hand.knownAtMs > source.preActionMs) fail(`${path}.observation.actorHand.knownAtMs`, 'future hand reveal is forbidden');
  if (!hand.complete && hand.cards.length) fail(`${path}.observation.actorHand.cards`, 'incomplete hand must stay masked');
  evidence(hand.evidence, `${path}.observation.actorHand.evidence`);
  object(observation.publicState, ['complete', 'evidence'], `${path}.observation.publicState`);
  boolean(observation.publicState.complete, `${path}.observation.publicState.complete`);
  evidence(observation.publicState.evidence, `${path}.observation.publicState.evidence`);
  array(observation.masks, `${path}.observation.masks`);
  observation.masks.forEach((mask, index) => {
    const p = `${path}.observation.masks[${index}]`;
    object(mask, ['field', 'reason'], p);
    if (!['actorHand', 'publicState', 'actorSeat', 'candidates', ...factKeys].includes(mask.field)) fail(`${p}.field`, 'unapproved mask field');
    text(mask.reason, `${p}.reason`);
  });
  unique(observation.masks.map(mask => mask.field), `${path}.observation.masks.field`);
  const masks = new Set(observation.masks.map(mask => mask.field));
  if (!hand.complete && !masks.has('actorHand')) fail(`${path}.observation.masks`, 'missing actorHand mask');
  if (!observation.publicState.complete && !masks.has('publicState')) fail(`${path}.observation.masks`, 'missing publicState mask');
  if (hand.complete && masks.has('actorHand')) fail(`${path}.observation.masks`, 'complete hand cannot be masked');
  if (observation.publicState.complete && masks.has('publicState')) fail(`${path}.observation.masks`, 'complete public state cannot be masked');
  for (const fact of observation.facts) {
    if (fact.value === null && !masks.has(fact.key)) fail(`${path}.observation.masks`, `missing mask for ${fact.key}`);
    if (fact.value !== null && masks.has(fact.key)) fail(`${path}.observation.masks`, `known fact ${fact.key} cannot be masked`);
  }
  const candidates = record.candidates;
  object(candidates, ['complete', 'evidence', 'items'], `${path}.candidates`);
  boolean(candidates.complete, `${path}.candidates.complete`); evidence(candidates.evidence, `${path}.candidates.evidence`);
  array(candidates.items, `${path}.candidates.items`);
  candidates.items.forEach((candidate, index) => {
    const p = `${path}.candidates.items[${index}]`;
    object(candidate, ['id', 'action', 'legality', 'evidence'], p);
    text(candidate.id, `${p}.id`); oneOf(candidate.legality, ['legal', 'illegal', 'unknown'], `${p}.legality`);
    evidence(candidate.evidence, `${p}.evidence`);
    object(candidate.action, ['kind'], `${p}.action`, ['source', 'target', 'choice']);
    for (const [key, value] of Object.entries(candidate.action)) text(value, `${p}.action.${key}`);
  });
  unique(candidates.items.map(candidate => candidate.id), `${path}.candidates.items.id`);
  const candidateMap = new Map(candidates.items.map(candidate => [candidate.id, candidate]));
  const human = record.human;
  object(human, ['status', 'actionIds', 'confidence', 'review', 'evidence'], `${path}.human`);
  oneOf(human.status, ['exact', 'ambiguous', 'unknown'], `${path}.human.status`);
  strings(human.actionIds, `${path}.human.actionIds`); unique(human.actionIds, `${path}.human.actionIds`);
  if ((human.status === 'exact' && human.actionIds.length !== 1)
      || (human.status === 'ambiguous' && human.actionIds.length < 2)
      || (human.status === 'unknown' && human.actionIds.length !== 0)) fail(`${path}.human.actionIds`, 'does not match label status');
  if (!Number.isFinite(human.confidence) || human.confidence < 0 || human.confidence > 1) fail(`${path}.human.confidence`, 'expected number in [0, 1]');
  oneOf(human.review, ['unreviewed', 'verified'], `${path}.human.review`); evidence(human.evidence, `${path}.human.evidence`);
  for (const id of human.actionIds) if (!candidateMap.has(id)) fail(`${path}.human.actionIds`, 'label must reference a candidate');
  const review = record.review;
  object(review, ['status', 'reviewer', 'independentOfHuman', 'reason', 'actionScores'], `${path}.review`);
  oneOf(review.status, ['unreviewed', 'independent'], `${path}.review.status`);
  boolean(review.independentOfHuman, `${path}.review.independentOfHuman`);
  if (typeof review.reason !== 'string' || review.reason.length > 2000) fail(`${path}.review.reason`, 'expected text of at most 2000 characters');
  array(review.actionScores, `${path}.review.actionScores`);
  if (review.status === 'independent') {
    text(review.reviewer, `${path}.review.reviewer`);
    text(review.reason, `${path}.review.reason`);
    if (!review.independentOfHuman) fail(`${path}.review.independentOfHuman`, 'mistake scores require independent review');
  } else if (review.reviewer !== null || review.independentOfHuman || review.actionScores.length) fail(`${path}.review`, 'unreviewed labels cannot assign mistake points');
  review.actionScores.forEach((score, index) => {
    const p = `${path}.review.actionScores[${index}]`;
    object(score, ['actionId', 'points', 'evidence'], p); text(score.actionId, `${p}.actionId`);
    if (candidateMap.get(score.actionId)?.legality !== 'legal') fail(`${p}.actionId`, 'mistake scores require a known legal candidate');
    if (!Number.isFinite(score.points) || score.points < 0) fail(`${p}.points`, 'expected finite nonnegative points');
    evidence(score.evidence, `${p}.evidence`);
  });
  unique(review.actionScores.map(score => score.actionId), `${path}.review.actionScores.actionId`);
  object(record.future, ['reveals', 'outcome'], `${path}.future`); array(record.future.reveals, `${path}.future.reveals`);
  if (record.future.outcome !== null) text(record.future.outcome, `${path}.future.outcome`);
  record.future.reveals.forEach((reveal, index) => {
    const p = `${path}.future.reveals[${index}]`;
    object(reveal, ['atMs', 'value'], p); integer(reveal.atMs, `${p}.atMs`); text(reveal.value, `${p}.value`);
    if (reveal.atMs <= source.preActionMs) fail(`${p}.atMs`, 'future reveals must follow pre-action time');
  });
}

export function validateDataset(records) {
  array(records, 'records');
  const ids = new Set(), matches = new Map(), events = new Map(), games = new Map();
  records.forEach((record, index) => {
    const path = `line ${index + 1}`;
    validateRecord(record, path);
    if (ids.has(record.id)) fail(`${path}.id`, 'duplicate decision ID');
    ids.add(record.id);
    const seats = JSON.stringify([...record.players].sort((a, b) => a.seat - b.seat));
    const priorMatch = matches.get(record.matchId);
    if (priorMatch && (priorMatch.eventId !== record.eventId || priorMatch.split !== record.split || priorMatch.seats !== seats)) fail(path, 'whole match split leakage or player/event mismatch');
    matches.set(record.matchId, { eventId: record.eventId, split: record.split, seats });
    const event = events.get(record.eventId) ?? { splits: new Set(), wholeEvent: false };
    event.splits.add(record.split); event.wholeEvent ||= record.splitUnit === 'event';
    if (event.wholeEvent && event.splits.size !== 1) fail(path, 'whole event split leakage');
    events.set(record.eventId, event);
    const gameKey = JSON.stringify([record.eventId, record.matchId, record.gameId]);
    const prior = games.get(gameKey);
    if (prior !== undefined && record.source.preActionMs <= prior) fail(`${path}.source.preActionMs`, 'game windows must be strictly chronological without duplicates');
    games.set(gameKey, record.source.preActionMs);
  });
  return structuredClone(records);
}

export function parseJsonl(text) {
  if (typeof text !== 'string') fail('JSONL', 'expected text');
  const records = [], lines = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); lines.push(index + 1); }
    catch (error) { fail(`line ${index + 1}`, `invalid JSON (${error.message})`); }
  }
  try { return validateDataset(records); }
  catch (error) {
    throw new TypeError(error.message.replace(/^line (\d+)/, (_, line) => `line ${lines[Number(line) - 1]}`));
  }
}

function validateAdapter(adapter) {
  if (!adapter || adapter.schema !== 'shadow-policy/1' || adapter.observationSchema !== OBSERVATION_SCHEMA) fail('adapter', 'checkpoint schema mismatch');
  for (const key of ['policyId', 'checkpointId']) text(adapter[key], `adapter.${key}`);
  strings(adapter.supportedProfiles, 'adapter.supportedProfiles'); strings(adapter.supportedCards, 'adapter.supportedCards');
  if (typeof adapter.create !== 'function') fail('adapter.create', 'expected fresh per-window policy factory');
}

function adapterContract(adapter) {
  return { schema: adapter.schema, observationSchema: adapter.observationSchema, policyId: adapter.policyId,
    checkpointId: adapter.checkpointId, supportedProfiles: [...adapter.supportedProfiles], supportedCards: [...adapter.supportedCards] };
}

function assertAdapterContract(adapter, expected) {
  if (JSON.stringify(adapterContract(adapter)) !== JSON.stringify(expected)) fail('adapter', 'policy/checkpoint contract changed during evaluation');
}

function checkTrainingManifest(records, manifest) {
  if (manifest === null) return { status: 'not-provided', overlapChecked: false };
  object(manifest, ['schema', 'eventIds', 'matchIds'], 'trainingManifest');
  oneOf(manifest.schema, ['shadow-training-manifest/1'], 'trainingManifest.schema');
  strings(manifest.eventIds, 'trainingManifest.eventIds'); strings(manifest.matchIds, 'trainingManifest.matchIds');
  const events = new Set(manifest.eventIds), matches = new Set(manifest.matchIds);
  for (const record of records) {
    if (events.has(record.eventId) || matches.has(record.matchId)) fail('trainingManifest', `benchmark training leakage at ${record.id}`);
  }
  return { status: 'disjoint-declared-ids', overlapChecked: true };
}

const metric = () => ({ numerator: 0, denominator: 0, rate: null });
function stats() {
  return { windows: 0, eligible: 0, attempted: 0, answered: 0, abstained: 0, coverage: null,
    abstentionReasons: {}, actionErrors: 0, unknownLegality: 0, exactAgreement: metric(),
    topKAgreement: metric(), ambiguousAgreement: metric(), illegalRate: metric(), actionErrorRate: metric(),
    reviewedMistakes: { points: null, count: 0, mean: null } };
}
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function policyInput(record) {
  return freeze({ schema: OBSERVATION_SCHEMA, actorSeat: record.actorSeat,
    observation: { facts: record.observation.facts.map(({ key, value, knowledge }) => ({ key, value: structuredClone(value), knowledge })),
      actorHand: { cards: [...record.observation.actorHand.cards] } },
    candidates: record.candidates.items.filter(item => item.legality !== 'illegal').map(({ id, action }) => ({ id, action: { ...action } })) });
}
function abstention(record, adapter) {
  if (record.actorSeat === null) return 'unknown-actor';
  if (record.kind === 'stream' && !record.source.frameVerified) return 'unverified-frame';
  if (!record.observation.facts.length || record.observation.facts.every(fact => fact.value === null)) return 'all-masked-state';
  if (!record.observation.actorHand.complete) return 'missing-actor-hand';
  if (!record.observation.publicState.complete) return 'incomplete-public-state';
  if (record.observation.masks.length) return 'masked-state';
  if (!record.candidates.complete) return 'incomplete-alternatives';
  if (!record.candidates.items.some(item => item.legality === 'legal')) return 'no-known-legal-actions';
  if (!adapter.supportedProfiles.includes(record.rules.profile)) return 'unsupported-rules';
  if (record.decks.some(deck => !deck.identityComplete)) return 'incomplete-deck-identity';
  const cards = new Set(adapter.supportedCards);
  if (record.decks.some(deck => deck.printingIds.some(card => !cards.has(card)))) return 'unsupported-cards';
  if (record.observation.actorHand.cards.some(card => !cards.has(card))) return 'unsupported-cards';
  const actorDeck = new Set(record.decks.find(deck => deck.seat === record.actorSeat).printingIds);
  if (record.observation.actorHand.cards.some(card => !actorDeck.has(card))) return 'hand-outside-deck';
  return null;
}
function prediction(value, record) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'abstain')) {
    object(value, ['abstain'], 'prediction'); text(value.abstain, 'prediction.abstain');
    return { status: 'abstained', reason: 'policy-abstention' };
  }
  object(value, ['actionId'], 'prediction', ['ranking']); text(value.actionId, 'prediction.actionId');
  const items = new Map(record.candidates.items.map(item => [item.id, item]));
  if (!items.has(value.actionId)) return { status: 'action-error', reason: 'unresolved-action' };
  if (items.get(value.actionId).legality === 'illegal') return { status: 'answered', actionId: value.actionId, ranking: [value.actionId], rankingProvided: false, legality: 'illegal' };
  const ranking = value.ranking ?? [value.actionId];
  strings(ranking, 'prediction.ranking'); unique(ranking, 'prediction.ranking');
  if (!ranking.length || ranking[0] !== value.actionId || ranking.some(id => !items.has(id) || items.get(id).legality === 'illegal')) fail('prediction.ranking', 'must start with selected action and reference unique offered candidates');
  return { status: 'answered', actionId: value.actionId, ranking, rankingProvided: Object.hasOwn(value, 'ranking'), legality: items.get(value.actionId).legality };
}
function recordStats(target, row, record, topK) {
  target.windows++;
  if (row.eligible) target.eligible++;
  if (row.attempted) { target.attempted++; target.actionErrorRate.denominator++; }
  if (row.status === 'abstained') {
    target.abstained++;
    target.abstentionReasons[row.reason] = (target.abstentionReasons[row.reason] ?? 0) + 1;
    return;
  }
  if (row.status === 'action-error') { target.actionErrors++; target.actionErrorRate.numerator++; return; }
  target.answered++;
  if (row.legality === 'unknown') { target.unknownLegality++; return; }
  target.illegalRate.denominator++;
  if (row.legality === 'illegal') { target.illegalRate.numerator++; return; }
  const human = record.human;
  if (human.review === 'verified' && human.confidence >= 0.9) {
    if (human.status === 'exact' && record.candidates.items.find(item => item.id === human.actionIds[0]).legality === 'legal') {
      target.exactAgreement.denominator++;
      target.exactAgreement.numerator += Number(row.actionId === human.actionIds[0]);
      const offeredCount = record.candidates.items.filter(item => item.legality !== 'illegal').length;
      if ((row.rankingProvided || topK === 1 || offeredCount === 1) && row.ranking.length >= Math.min(topK, offeredCount)) {
        target.topKAgreement.denominator++;
        target.topKAgreement.numerator += Number(row.ranking.slice(0, topK).includes(human.actionIds[0]));
      }
    } else if (human.status === 'ambiguous' && human.actionIds.every(id => record.candidates.items.find(item => item.id === id).legality === 'legal')) {
      target.ambiguousAgreement.denominator++;
      target.ambiguousAgreement.numerator += Number(human.actionIds.includes(row.actionId));
    }
  }
  const score = record.review.status === 'independent' && record.review.actionScores.find(item => item.actionId === row.actionId);
  if (score) {
    target.reviewedMistakes.points = (target.reviewedMistakes.points ?? 0) + score.points;
    target.reviewedMistakes.count++;
  }
}
function finishStats(target) {
  target.coverage = target.windows ? target.eligible / target.windows : null;
  for (const key of ['exactAgreement', 'topKAgreement', 'ambiguousAgreement', 'illegalRate', 'actionErrorRate']) {
    target[key].rate = target[key].denominator ? target[key].numerator / target[key].denominator : null;
  }
  if (target.reviewedMistakes.count) target.reviewedMistakes.mean = target.reviewedMistakes.points / target.reviewedMistakes.count;
}

export async function evaluateShadow(inputRecords, { adapter, checkpoint = null, topK = 3, trainingManifest = null } = {}) {
  const records = validateDataset(inputRecords);
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 512) fail('topK', 'expected integer in [1, 512]');
  const trainingAudit = checkTrainingManifest(records, trainingManifest);
  validateAdapter(adapter);
  const contract = freeze(adapterContract(adapter));
  const aggregate = stats(), byPlayer = Object.create(null), byGame = Object.create(null), rows = [];
  for (const record of records) {
    assertAdapterContract(adapter, contract);
    for (const player of record.players) byPlayer[player.id] ??= stats();
    const game = JSON.stringify([record.eventId, record.matchId, record.gameId]);
    byGame[game] ??= stats();
    const row = { id: record.id, actorSeat: record.actorSeat, eligible: false, attempted: false };
    const reason = abstention(record, contract);
    if (reason) Object.assign(row, { status: 'abstained', reason });
    else {
      row.eligible = true; row.attempted = true;
      let policy;
      try {
        policy = await adapter.create({ checkpoint });
        if (!policy || typeof policy.decide !== 'function') fail('policy', 'decide method required');
        Object.assign(row, prediction(await policy.decide(policyInput(record)), record));
      } catch {
        Object.assign(row, { status: 'action-error', reason: 'policy-or-action-error' });
      } finally {
        if (policy?.close) {
          try { await policy.close(); }
          catch { Object.assign(row, { status: 'action-error', reason: 'policy-close-error' }); }
        }
      }
    }
    assertAdapterContract(adapter, contract);
    rows.push(row);
    const player = record.actorSeat === null ? 'unknown-actor' : record.players.find(player => player.seat === record.actorSeat).id;
    byPlayer[player] ??= stats();
    for (const target of [aggregate, byPlayer[player], byGame[game]]) recordStats(target, row, record, topK);
  }
  for (const target of [aggregate, ...Object.values(byPlayer), ...Object.values(byGame)]) finishStats(target);
  return { schema: 'shadow-report/1', policy: { id: contract.policyId, checkpointId: contract.checkpointId }, topK,
    data: { records: records.length, synthetic: records.filter(record => record.kind === 'synthetic').length,
      stream: records.filter(record => record.kind === 'stream').length, benchmarkOnly: true },
    trainingAudit, aggregate, byPlayer, byGame, rows };
}
