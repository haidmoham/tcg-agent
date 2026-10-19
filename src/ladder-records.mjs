const METRICS = ['competitive_elo', 'progressive_elo', 'rank_points'];
const OUTCOMES = ['win', 'loss', 'draw', 'unknown'];

function object(value, keys, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${field}.${key} is not allowed`);
}

function text(value, field) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value)) throw new TypeError(`${field} must be a public provenance identifier (1..120 characters)`);
}

function oneOf(value, values, field) {
  if (!values.includes(value)) throw new TypeError(`${field} must be ${values.join(', ')}`);
}

function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${field} must be a valid UTC ISO timestamp with milliseconds`);
  }
}

function hex(value, length, field) {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new TypeError(`${field} must be ${length} lowercase hexadecimal characters`);
}

function validate(record) {
  object(record, ['schema', 'id', 'dataset', 'source', 'pilot', 'platform', 'ladder', 'season', 'observedAt', 'patch', 'policy', 'playedDeck', 'outcome', 'resultEvidence', 'disconnected', 'opponentDeck', 'rating'], 'record');
  oneOf(record.schema, ['ladder-record-v1'], 'schema');
  for (const field of ['id', 'ladder', 'season', 'patch']) text(record[field], field);
  oneOf(record.dataset, ['actual', 'synthetic'], 'dataset');
  oneOf(record.source, ['manual', 'user-export'], 'source');
  oneOf(record.pilot, ['human', 'authorized-agent'], 'pilot');
  oneOf(record.platform, ['tcg-live'], 'platform');
  date(record.observedAt, 'observedAt');
  object(record.policy, ['id', 'version', 'commit'], 'policy');
  for (const field of ['id', 'version']) text(record.policy[field], `policy.${field}`);
  hex(record.policy.commit, 40, 'policy.commit');
  object(record.playedDeck, ['id', 'version', 'hash'], 'playedDeck');
  for (const field of ['id', 'version']) text(record.playedDeck[field], `playedDeck.${field}`);
  hex(record.playedDeck.hash, 64, 'playedDeck.hash');
  oneOf(record.outcome, OUTCOMES, 'outcome');
  oneOf(record.resultEvidence, ['observed-result', 'not-observed'], 'resultEvidence');
  if ((record.outcome === 'unknown') !== (record.resultEvidence === 'not-observed')) throw new TypeError('known outcomes require observed-result evidence; unknown outcomes require not-observed');
  if (typeof record.disconnected !== 'boolean') throw new TypeError('disconnected must be boolean; disconnects do not determine outcomes');
  object(record.opponentDeck, ['status', 'id', 'evidence'], 'opponentDeck');
  oneOf(record.opponentDeck.status, ['observed', 'inferred', 'unknown'], 'opponentDeck.status');
  if (record.opponentDeck.status === 'unknown') {
    if (Object.keys(record.opponentDeck).length !== 1) throw new TypeError('unknown opponent decks must not contain an identity or evidence');
  } else {
    text(record.opponentDeck.id, 'opponentDeck.id');
    if (typeof record.opponentDeck.evidence !== 'string' || record.opponentDeck.evidence.trim().length < 1 || record.opponentDeck.evidence.length > 500 || /[\r\n]/.test(record.opponentDeck.evidence)) throw new TypeError('opponentDeck.evidence must be 1..500 characters without newlines');
  }
  if (record.rating !== null) {
    object(record.rating, ['metric', 'before', 'after'], 'rating');
    oneOf(record.rating.metric, METRICS, 'rating.metric');
    const points = [];
    for (const field of ['before', 'after']) {
      const point = record.rating[field];
      if (point === null) continue;
      object(point, ['value', 'observedAt'], `rating.${field}`);
      if (!Number.isFinite(point.value) || point.value < 0) throw new TypeError(`rating.${field}.value must be a finite nonnegative number`);
      date(point.observedAt, `rating.${field}.observedAt`);
      if (point.observedAt > record.observedAt) throw new TypeError(`rating.${field} cannot be observed after the record`);
      points.push(point);
    }
    if (record.rating.before && record.rating.after && record.rating.before.observedAt > record.rating.after.observedAt) throw new TypeError('rating.before cannot be observed after rating.after');
    if (!points.length) throw new TypeError('rating requires at least one observed value; use null when no rating is known');
  }
  return structuredClone(record);
}

/** Parse the entire input atomically. No malformed or duplicate record is skipped. */
export function parseLadderRecords(jsonl) {
  if (typeof jsonl !== 'string') throw new TypeError('JSONL input must be text');
  const records = [], ids = new Set();
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const record = validate(JSON.parse(line));
      if (ids.has(record.id)) throw new TypeError(`duplicate record id ${record.id}`);
      ids.add(record.id);
      records.push(record);
    } catch (error) {
      throw new TypeError(`line ${index + 1}: ${error.message}`);
    }
  }
  return records;
}

function counts(records) {
  const result = { records: records.length, wins: 0, losses: 0, draws: 0, unknown: 0, disconnected: 0 };
  const names = { win: 'wins', loss: 'losses', draw: 'draws', unknown: 'unknown' };
  for (const record of records) {
    result[names[record.outcome]]++;
    if (record.disconnected) result.disconnected++;
  }
  const n = result.wins + result.losses;
  result.decisiveGames = n;
  result.decisiveWinRate = n ? result.wins / n : null;
  if (n) {
    const z = 1.959963984540054, p = result.wins / n, denominator = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / denominator;
    const radius = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
    result.decisiveWinRateWilson95 = [Math.max(0, center - radius), Math.min(1, center + radius)];
  } else result.decisiveWinRateWilson95 = null;
  return result;
}

function group(records, key) {
  const groups = new Map();
  for (const record of records) {
    const identity = key(record), serialized = JSON.stringify(identity);
    if (!groups.has(serialized)) groups.set(serialized, { identity, records: [] });
    groups.get(serialized).records.push(record);
  }
  return [...groups.values()].sort((a, b) => JSON.stringify(a.identity).localeCompare(JSON.stringify(b.identity)));
}

function ratingSummary(records) {
  const observations = records.flatMap(record => ['before', 'after'].flatMap(position => {
    const point = record.rating?.[position];
    return point ? [{ ...point, recordId: record.id, position }] : [];
  })).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.recordId.localeCompare(b.recordId) || a.position.localeCompare(b.position));
  const peak = observations.reduce((best, point) => best === null || point.value > best.value ? point : best, null);
  const latestTime = observations.at(-1)?.observedAt;
  const latestValues = [...new Set(observations.filter(point => point.observedAt === latestTime).map(point => point.value))];
  return { observedValues: observations.length, peakObservedRating: peak?.value ?? null, peakObservedAt: peak?.observedAt ?? null, latestObservedRating: latestValues.length === 1 ? latestValues[0] : null, latestObservedAt: latestTime ?? null, conflictingLatestObservations: latestValues.length > 1 };
}

function opponentSummary(records) {
  return {
    observed: group(records.filter(record => record.opponentDeck.status === 'observed'), record => ({ id: record.opponentDeck.id })).map(({ identity, records: matches }) => ({ ...identity, ...counts(matches) })),
    inferred: group(records.filter(record => record.opponentDeck.status === 'inferred'), record => ({ id: record.opponentDeck.id })).map(({ identity, records: matches }) => ({ ...identity, ...counts(matches) })),
    unknown: counts(records.filter(record => record.opponentDeck.status === 'unknown')),
  };
}

/** Report observations, never an estimated hidden peak or a converted rating. */
export function summarizeLadderRecords(input) {
  if (!Array.isArray(input)) throw new TypeError('records must be an array');
  const records = parseLadderRecords(input.map(record => JSON.stringify(validate(record))).join('\n'));
  const actual = records.filter(record => record.dataset === 'actual');
  const ratingIdentity = record => ({ platform: record.platform, ladder: record.ladder, season: record.season, metric: record.rating?.metric ?? null });
  return {
    schema: 'ladder-summary-v1', dataset: 'actual', recordsRead: records.length,
    syntheticRecordsExcluded: records.length - actual.length,
    totals: counts(actual), opponents: opponentSummary(actual),
    ratingSeries: group(actual, ratingIdentity).map(({ identity, records: matches }) => ({ ...identity, ...ratingSummary(matches) })),
    strata: group(actual, record => ({ ...ratingIdentity(record), pilot: record.pilot, patch: record.patch, policy: record.policy, playedDeck: record.playedDeck })).map(({ identity, records: matches }) => ({ ...identity, ...counts(matches), ...ratingSummary(matches), opponents: opponentSummary(matches) })),
    interpretation: 'User-supplied observations, not verified Live results or evidence of automation permission. Peaks are maximum observed values within each series. Decisive win rates exclude draws and unknown outcomes. Wilson intervals assume independent games and do not account for selection, opponent, deck, patch or policy changes. Synthetic records are excluded.',
  };
}
