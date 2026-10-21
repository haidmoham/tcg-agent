import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [inputsFile, output] = process.argv.slice(2);
if (!inputsFile || !output || process.argv.length !== 4 || fs.existsSync(output))
  throw Error('usage: qualify-search-policy-controls <private-inputs.json> <fresh-receipt.json>');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = read(inputsFile), environment = read(inputs.environmentConfig);
const initialization = read(inputs.initializationReceipt);
assert.equal(inputs.checkpointSha256, 'b91885409acfb5c0e427d86a784f537cc3308292f053128dafc5bce42d813e21');
assert.equal(hash(inputs.checkpoint), inputs.checkpointSha256);
assert.equal(initialization.baseCheckpointSha256, environment.agent.ordinarySha256);
assert.equal(initialization.warmStartAllTensorsExact, true);
assert.equal(initialization.reloadPolicyValueExact, true);
for (const [relative, digest] of Object.entries(initialization.sourceHashes))
  assert.equal(hash(path.join(inputs.runtimeRoot, relative)), digest);
const [{ EntityPpoModelClient }, { AlphaZeroModelClient }, { encodeModel6Decision }] = await Promise.all([
  import(pathToFileURL(path.join(environment.runtimeRoot, 'integrations/local-worker/entity-ppo-model.mjs'))),
  import(pathToFileURL(path.join(inputs.runtimeRoot, 'integrations/local-worker/alphazero-model.mjs'))),
  import(pathToFileURL(path.join(environment.runtimeRoot, 'learning/model6-features.mjs'))),
]);
const sources = [], contexts = [];
for (const file of inputs.humanJournals) {
  sources.push({ sha256: hash(file), type: 'previously-inspected-human-development' });
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    if (row.type === 'human-decision-offered') contexts.push(row.projectedObservation);
  }
}
for (const file of inputs.nativeRootCaptures ?? []) {
  sources.push({ sha256: hash(file), type: 'retained-native-engineering-root' });
  contexts.push(read(file).view);
}
const ordinaryViews = contexts.filter(view => view.status === 'playing' && view.turn === 'you'
  && view.prompts.length === 0 && view.actions.length > 0);
assert.ok(ordinaryViews.length > 0);
for (const view of ordinaryViews) {
  assert.equal(view.opponent?.hand == null, true);
  assert.equal(view.opponent?.deck == null, true);
}
const baseline = new EntityPpoModelClient(environment.ordinary);
const initial = new AlphaZeroModelClient({ ...environment.ordinary, runtimeRoot: inputs.runtimeRoot,
  checkpoint: inputs.checkpoint, modelRoot: path.dirname(inputs.checkpoint), device: 'cpu' });
const startedAtUtc = new Date().toISOString(), rows = [];
try {
  await Promise.all([baseline.verify(), initial.verify()]);
  for (const [index, view] of ordinaryViews.entries()) {
    let begin = performance.now();
    const encoded = encodeModel6Decision(view, { catalog: baseline.catalog });
    const encodeMilliseconds = performance.now() - begin;
    begin = performance.now();
    const encodedBytes = Buffer.byteLength(JSON.stringify(encoded));
    const stringifyMilliseconds = performance.now() - begin;
    begin = performance.now();
    const [reference] = await baseline.act([encoded], { deterministic: true });
    const baselineRpcMilliseconds = performance.now() - begin;
    begin = performance.now();
    const scored = await initial.score([encoded]);
    const initialRpcMilliseconds = performance.now() - begin;
    const logits = scored.logits[0], actionIndex = logits.indexOf(Math.max(...logits));
    const actionExact = actionIndex === reference.actionIndex;
    const selectedLogProbabilityError = Math.abs(logits[actionIndex] - reference.oldLogProb);
    const tanhValueError = Math.abs(scored.values[0] - Math.tanh(reference.oldValue));
    assert.equal(actionExact, true, `ordinary action changed at retained context ${index}`);
    assert.ok(selectedLogProbabilityError <= 1e-6, `selected log probability changed at retained context ${index}`);
    assert.ok(tanhValueError <= 1e-6, `critic transform changed at retained context ${index}`);
    rows.push({ index, candidates: encoded.candidates.length, encodedBytes, encodeMilliseconds,
      stringifyMilliseconds, baselineRpcMilliseconds, initialRpcMilliseconds, actionExact,
      selectedLogProbabilityError, tanhValueError });
  }
  const sum = key => rows.reduce((total, row) => total + row[key], 0);
  const receipt = { schema: 'search-policy-control-qualification/1', startedAtUtc, completedAtUtc: new Date().toISOString(),
    classification: 'Non-strength engineering parity check; no new games or fits', inputsSha256: hash(inputsFile),
    scriptSha256: hash(new URL(import.meta.url)), sources, sourceGuardFiles: Object.keys(initialization.sourceHashes).length,
    retainedContexts: contexts.length, ordinaryContexts: rows.length,
    checkpointSha256: inputs.checkpointSha256, baselineSha256: environment.agent.ordinarySha256,
    exactOrdinaryActions: rows.filter(row => row.actionExact).length,
    maximumSelectedLogProbabilityError: Math.max(...rows.map(row => row.selectedLogProbabilityError)),
    maximumTanhValueError: Math.max(...rows.map(row => row.tanhValueError)),
    stageObservations: { encodedBytes: sum('encodedBytes'), encodeMilliseconds: sum('encodeMilliseconds'),
      stringifyMilliseconds: sum('stringifyMilliseconds'), baselineRpcMilliseconds: sum('baselineRpcMilliseconds'),
      initialRpcMilliseconds: sum('initialRpcMilliseconds'),
      caveat: 'One-record calls on retained contexts under concurrent gameplay, including cold first inference. RPC includes transport, Python parsing/tensorization and inference; not exclusive kernel time, a speed comparison or end-to-end collection profile.' },
    remaining: 'Actual prompt-route/complete-history parity and natural native wrapper smoke before diagnostic gameplay.',
    newGames: 0, newFits: 0, promotion: false, rows };
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ordinaryContexts: rows.length, exactActions: receipt.exactOrdinaryActions,
    maximumSelectedLogProbabilityError: receipt.maximumSelectedLogProbabilityError,
    maximumTanhValueError: receipt.maximumTanhValueError, stageObservations: receipt.stageObservations }));
} finally { await Promise.all([baseline.shutdown(), initial.shutdown()]); }
