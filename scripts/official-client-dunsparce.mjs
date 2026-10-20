import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LocalWorker, verifyLocalInputs } from '../integrations/local-worker/probe.mjs';
import { PolicyView } from '../integrations/local-worker/policy-view.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const sourceId = 'sv9_120';
const deadline = Date.now() + 180000;
const args = process.argv.slice(2);
assert(args.length === 2, 'usage: node scripts/official-client-dunsparce.mjs local-config.json local-research-root');
const originalConfig = JSON.parse(await readFile(args[0]));
const original = verifyLocalInputs(originalConfig);
const corpusBytes = await readFile(join(args[1], 'network-recon/card-corpus-v1/cards.jsonl'));
assert(sha(corpusBytes) === 'afe7931aab5a6d4f77cdecbb7ae58502dd17fce4695986a348c2b27ebdd6c4ec', 'corpus-pin-mismatch');
const exact = corpusBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse).find(card => card.cardSourceID === sourceId);
assert(exact?.cardName === 'Dunsparce' && exact.hp === 70 && exact.retreatCost === 1 && exact.prizeValue === 1, 'exact-card-stats-mismatch');
assert((exact.cardStage ?? 0) === 0 && (exact.cardFormat ?? 0) === 0 && JSON.stringify(exact.cardTyping) === '[1]'
  && JSON.stringify(exact.weakness) === '[5]' && exact.weaknessAmt === 2 && !(exact.resistance?.length), 'exact-card-type-mismatch');
assert(exact.useActions.length === 2 && exact.useActions[0].actionName === 'Trading Places' && exact.useActions[0].energyCost === '{C}'
  && exact.useActions[1].actionName === 'Ram' && exact.useActions[1].energyCost === '{C}{C}'
  && exact.useActions.every(action => action.actionType === 1), 'exact-card-actions-mismatch');
assert(exact.useActions[0].subActions.some(node => node.$type === 'MatchLogic.SwapCards, MatchLogic')
  && exact.useActions[1].subActions.some(node => node.$type === 'MatchLogic.ApplyDamage, MatchLogic'
    && node.damageValue?.value1?.explicitValue === 20), 'exact-card-effects-mismatch');
const cards = JSON.parse(await readFile(join(original.root, 'cardData.json')));
assert(!cards.some(card => card.cardSourceID === sourceId), 'exact-card-already-in-source-bundle');
const cache = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache'); await mkdir(cache, { recursive: true });
const derived = await mkdtemp(join(cache, 'dunsparce-jtg120-'));
for (const row of original.manifest.files) await copyFile(join(original.root, row.path), join(derived, row.path));
await writeFile(join(derived, 'cardData.json'), JSON.stringify([...cards, exact]));
const joins = JSON.parse(await readFile(join(derived, 'printing-joins.json')));
joins.joins.push({ printingId: 'JTG-120', scope: 'primary-deck', cardSourceID: sourceId, status: 'joined', reasons: [], method: 'exact captured program; scoped offline extension' });
await writeFile(join(derived, 'printing-joins.json'), JSON.stringify(joins));
const manifest = structuredClone(original.manifest);
manifest.bundleId = `${manifest.bundleId}/dunsparce-jtg120-offline`;
manifest.parentBundle = { id: original.manifest.bundleId, manifestSha256: originalConfig.manifestSha256,
  contentIdentitySha256: original.manifest.contentIdentitySha256 };
for (const row of manifest.files) row.sha256 = sha(await readFile(join(derived, row.path)));
manifest.contentIdentitySha256 = sha(JSON.stringify(manifest.files.map(row => ({ path: row.path, sha256: row.sha256 }))));
manifest.provenRuntime = 'Derived offline input package; focused execution evidence is recorded in the separate Dunsparce receipt.';
manifest.notProven = [...new Set([...manifest.notProven, 'full AgentPult gameplay', 'official-client input mapping', 'full current Standard'])];
const manifestBytes = Buffer.from(JSON.stringify(manifest));
await writeFile(join(derived, 'manifest.json'), manifestBytes);
const config = { ...originalConfig, bundleRoot: derived, manifestSha256: sha(manifestBytes), projectionCopyMode: 'native', maxCommands: 100, maxSeconds: 60 };
const inputs = verifyLocalInputs(config);
const helper = (await import(pathToFileURL(inputs.decisions))).livePracticeDecisions;
const receipt = { schema: 'dunsparce-jtg120-native-admission/1', scope: 'isolated-offline-authored-decks', sourceManifestSha256: originalConfig.manifestSha256,
  derivedManifestSha256: config.manifestSha256, workerSha256: config.workerSha256, corpusSha256: sha(corpusBytes),
  exactCardProgramSha256: sha(JSON.stringify(exact)), sourceBundleUnchanged: false, exactPrinting: 'JTG-120', sourceId,
  admission: 'registered-in-derived-package-only', nativeRulesAdded: false, modelWeightsChanged: false, clientInputsSent: 0,
  staticChecks: { basic: true, colorless: true, hp: 70, fightingWeaknessTimesTwo: true, noResistance: true, noAbility: true,
    retreat: 1, tradingPlacesCost: 1, ramCost: 2, ramDamage: 20, usesExistingNativeSwitchAndDamage: true }, observations: [], tested: {}, untested: [] };

async function episode(seed, bench, attack) {
  assert(Date.now() < deadline, 'total-probe-time-budget-exceeded');
  const worker = new LocalWorker(config, { timeoutMs: 10000 });
  const deck = [...Array(4).fill(sourceId), ...Array(4).fill('me2-5_16'), ...Array(52).fill('mee_10')];
  const seats = Object.fromEntries(['human', 'opponent'].map(seat => [seat, { accountId: `dunsparce-offline-${seat}`, name: `Offline ${seat}`, cards: deck }]));
  const projectors = { human: new PolicyView(), opponent: new PolicyView() };
  let accepted = 0, phase = null, attackSeat = null, activeBefore = null, damageBefore = null;
  let energyBefore = null, discardBefore = null, benchBefore = [], selectedSwitchTarget = null;
  try {
    let frame = await worker.request('create', { bundle: { id: manifest.bundleId, cardsHash: inputs.pins.get('cardData.json'), rulesHash: inputs.pins.get('gameData.json'), runtimeHash: inputs.pins.get('MatchLogic.dll') }, seats,
      offline: { seed, projectionCopyMode: 'native' } });
    for (let step = 0; step < 80 && !frame.terminal; step++) {
      assert(Date.now() < deadline, 'total-probe-time-budget-exceeded');
      let next;
      for (const seat of ['human', 'opponent']) {
        const view = projectors[seat].project(frame.views[seat]);
        if (view.status === 'failed' || view.prompts.some(p => p.kind === 'unsupported')) throw new Error('unsupported-native-prompt');
        const mine = view.you.active;
        const dunsparce = mine?.printingId === 'JTG-120';
        const offered = view.actions.filter(a => a.kind === 'attack');
        if (dunsparce && view.turn === 'you' && view.status === 'playing' && !view.prompts.length) {
          receipt.observations.push({ seed, bench, attack, revision: view.revision, energies: mine.providedEnergy, benchCount: view.you.bench.length,
            attacks: offered.map(a => a.attackName), retreat: mine.currentRetreat, hp: mine.hp });
          if (mine.providedEnergy === 0) { assert(!offered.some(a => ['Trading Places', 'Ram'].includes(a.attackName)), 'zero-energy-attack-offered'); receipt.tested.zeroEnergyNoAttack = true; }
          if (mine.providedEnergy === 1) { assert(!offered.some(a => a.attackName === 'Ram'), 'ram-offered-with-one-energy'); receipt.tested.ramUnavailableWithOneEnergy = true; }
          if (mine.providedEnergy === 1 && offered.some(a => a.attackName === 'Trading Places')) receipt.tested.tradingPlacesAvailableWithOneEnergy = true;
          if (mine.providedEnergy === 2 && offered.some(a => a.attackName === 'Ram')) receipt.tested.ramAvailableWithTwoEnergy = true;
          if (view.you.bench.length === 0) { assert(!view.actions.some(a => a.kind === 'retreat'), 'retreat-offered-without-bench'); receipt.tested.retreatUnavailableWithoutBench = true; }
          if (mine.currentRetreat === 1) receipt.tested.retreatCostOneProjected = true;
          if (mine.hp === 70) receipt.tested.exactSeventyHpProjected = true;
        }
        if (phase === 'await-switch' && seat === attackSeat && !view.prompts.length) {
          assert(view.you.active?.instanceId !== activeBefore, 'trading-places-did-not-switch');
          assert(view.you.bench.some(c => c.instanceId === activeBefore), 'old-active-not-benched');
          assert(benchBefore.includes(view.you.active?.instanceId), 'switch-target-was-not-own-bench');
          assert(view.you.bench.find(c => c.instanceId === activeBefore).providedEnergy === energyBefore, 'switch-discarded-energy');
          if (selectedSwitchTarget) assert(view.you.active.instanceId === selectedSwitchTarget, 'switch-ignored-selected-target');
          receipt.tested.tradingPlacesSwitch = true;
          receipt.tested.tradingPlacesKeepsEnergy = true;
          receipt.tested.switchSelectedOwnBench = Boolean(selectedSwitchTarget);
          receipt.tested.tradingPlacesTurnEnded = view.turn === 'opponent';
          return { seed, accepted, outcome: 'switch-verified' };
        }
        if (phase === 'await-retreat' && seat === attackSeat && !view.prompts.length) {
          assert(view.you.active?.instanceId !== activeBefore && benchBefore.includes(view.you.active?.instanceId), 'retreat-did-not-switch-to-own-bench');
          assert(view.you.bench.find(c => c.instanceId === activeBefore)?.providedEnergy === energyBefore - 1, 'retreat-did-not-pay-one-energy');
          assert(view.you.discard.length === discardBefore + 1, 'retreat-discard-count-mismatch');
          assert(view.turn === 'you', 'retreat-ended-turn');
          receipt.tested.retreatPaysOneEnergy = true; receipt.tested.retreatKeepsTurn = true;
          return { seed, accepted, outcome: 'retreat-verified' };
        }
        if (phase === 'await-no-bench' && seat === attackSeat && !view.prompts.length) {
          assert(view.you.active?.instanceId === activeBefore && view.you.bench.length === 0, 'no-bench-attack-changed-active');
          receipt.tested.noBenchAttackKeepsActive = true;
          receipt.tested.noBenchAttackTurnEnded = view.turn === 'opponent';
          return { seed, accepted, outcome: 'no-bench-verified' };
        }
        if (phase === 'await-ram' && seat === attackSeat && !view.prompts.length) {
          assert(view.opponent.active?.damage === damageBefore + 20, 'ram-damage-not-twenty');
          assert(view.turn === 'opponent', 'ram-did-not-end-turn');
          receipt.tested.ramTwentyDamage = true; receipt.tested.ramTurnEnded = true;
          return { seed, accepted, outcome: 'ram-verified' };
        }
        let candidates = [...helper(view)];
        const prompt = view.prompts[0];
        if (prompt && view.status === 'setup') {
          const exactChoices = prompt.choices.filter(c => c.card?.printingId === 'JTG-120');
          if (!view.you.active && exactChoices.length && prompt.min <= 1 && prompt.max >= 1) candidates.unshift({ promptId: prompt.id, choiceIds: [exactChoices[0].id] });
          if (!bench && view.you.active && prompt.min === 0) candidates.unshift({ promptId: prompt.id, choiceIds: [] });
        }
        if (!prompt && view.status === 'playing' && view.turn === 'you') {
          const source = id => view.hand.find(c => c.instanceId === id);
          const energy = view.actions.find(a => a.kind === 'play' && source(a.sourceCardId)?.category === 'energy' && a.targetId === mine?.instanceId);
          const pokemon = bench && view.actions.find(a => a.kind === 'play' && source(a.sourceCardId)?.category === 'pokemon' && !a.targetId);
          const selectedAttack = dunsparce && (!bench || view.you.bench.length > 0 || attack === 'Ram')
            && (attack === 'retreat' ? view.actions.find(a => a.kind === 'retreat') : offered.find(a => a.attackName === attack));
          const pass = view.actions.find(a => a.kind === 'pass');
          candidates = [selectedAttack, energy, pokemon, pass].filter(Boolean).map(a => ({ actionId: a.id }));
          if (!bench && dunsparce && mine.providedEnergy >= 1 && view.you.bench.length === 0) {
            receipt.tested.noBenchTradingPlacesOffered = offered.some(a => a.attackName === 'Trading Places');
          }
        }
        for (const candidate of candidates.slice(0, 128)) {
          if (prompt && ['await-switch', 'await-retreat'].includes(phase) && candidate.choiceIds) {
            const chosen = prompt.choices.find(c => candidate.choiceIds.includes(c.id) && benchBefore.includes(c.instanceId ?? c.card?.instanceId));
            if (chosen) selectedSwitchTarget = chosen.instanceId ?? chosen.card?.instanceId;
          }
          const raw = projectors[seat].resolve(candidate);
          if (candidate.promptId) {
            const preview = await worker.request('preview', { seat, selection: { ...raw, requestId: randomUUID(), expectedRevision: frame.revision } });
            if (!preview.valid) continue;
          }
          const selectedAction = candidate.actionId && view.actions.find(a => a.id === candidate.actionId);
          const reply = await worker.request('command', { seat, command: { ...raw, commandId: randomUUID(), expectedRevision: frame.revision } });
          if (reply.receipt?.status === 'rejected') continue;
          assert(reply.receipt?.status === 'accepted', 'command-not-accepted');
          if (['attack', 'retreat'].includes(selectedAction?.kind) && dunsparce) {
            attackSeat = seat; activeBefore = mine.instanceId; damageBefore = view.opponent.active?.damage ?? 0;
            energyBefore = mine.providedEnergy; discardBefore = view.you.discard.length; benchBefore = view.you.bench.map(c => c.instanceId); selectedSwitchTarget = null;
            phase = selectedAction.kind === 'retreat' ? 'await-retreat' : selectedAction.attackName === 'Trading Places' ? (view.you.bench.length ? 'await-switch' : 'await-no-bench') : 'await-ram';
          }
          next = reply.frame; accepted++; break;
        }
        if (next) break;
      }
      if (!next) throw new Error('no-supported-offline-decision');
      frame = next;
    }
    return { seed, accepted, outcome: 'budget-or-terminal' };
  } finally { worker.close(); }
}

for (const scenario of [{ bench: true, attack: 'Trading Places' }, { bench: true, attack: 'Ram' }, { bench: false, attack: 'Trading Places' }, { bench: true, attack: 'retreat' }]) {
  for (let seed = 3101; seed < 3107; seed++) {
    const result = await episode(seed, scenario.bench, scenario.attack);
    receipt.observations.push(result);
    if (result.outcome.endsWith('verified') || result.outcome === 'no-bench-observed') break;
  }
}
receipt.sourceBundleUnchanged = sha(await readFile(join(original.root, 'manifest.json'))) === originalConfig.manifestSha256;
assert(receipt.sourceBundleUnchanged, 'source-bundle-changed');
verifyLocalInputs(originalConfig);
const required = ['zeroEnergyNoAttack', 'retreatUnavailableWithoutBench', 'retreatCostOneProjected', 'exactSeventyHpProjected',
  'ramUnavailableWithOneEnergy', 'tradingPlacesAvailableWithOneEnergy', 'ramAvailableWithTwoEnergy', 'tradingPlacesSwitch',
  'tradingPlacesKeepsEnergy', 'switchSelectedOwnBench', 'tradingPlacesTurnEnded', 'ramTwentyDamage', 'ramTurnEnded',
  'noBenchTradingPlacesOffered', 'noBenchAttackKeepsActive', 'noBenchAttackTurnEnded', 'retreatPaysOneEnergy', 'retreatKeepsTurn'];
for (const key of required) assert(receipt.tested[key] === true, `required-native-check-missing:${key}`);
receipt.untested = ['official-client-input-mapping', 'full-AgentPult-gameplay', 'all-card-interactions', 'full-Standard-admission'];
await writeFile(join(cache, 'dunsparce-receipt.json'), JSON.stringify(receipt, null, 2));
await writeFile(join(cache, 'dunsparce-config.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ ...receipt, observations: receipt.observations.filter(o => o.outcome) }, null, 2));
