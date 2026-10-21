// Offline evidence projection only. Never imports an engine, encoder, or model.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { loadCatalog } from './catalog-map.mjs';

const manifestPath = resolve(process.argv[2] ?? 'private/sample-manifest.json');
const root = dirname(manifestPath);
const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
const catalog = manifest.catalog ? await loadCatalog(manifest.catalog.path, manifest.catalog.sha256) : null;
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const text = s => typeof s === 'string' && s.length ? s : null;
const array = a => Array.isArray(a) ? a : null;
const card = c => c && typeof c === 'object' ? {
  sourcePrintingCode: text(c.card_number), reportedName: text(c.card_name),
  catalogIdentity: catalog?.card(c.card_number) ?? null, category: catalog?.card(c.card_number)?.category ?? null,
} : null;
const cards = list => array(list)?.map(card) ?? null;

// Aliases are position-local and based only on public zone traversal, never pile IDs.
function creature(c, owner, zone, slot) {
  if (!c) return null;
  return {
    alias: `${owner}/${zone}/${slot}`, owner, zone, ...card(c),
    reportedDamage: count(c.damage),
    reportedConditions: array(c.status_conditions)?.map(text) ?? null,
    reportedAttachedEnergy: cards(c.attached_energy),
    reportedAttachedTools: cards(c.attached_tools),
    hp: null, effectiveRetreat: null, energySupply: null, printedAttacks: null,
    attackReadiness: null, abilityUsage: null, placementTurn: null, evolutionHistory: null,
    provenance: 'parser-reported; full-board history not independently audited',
  };
}
function side(s, owner) {
  const area = s?.battle_area;
  return {
    handCount: count(s?.hand_count), deckCount: count(s?.deck_count), prizes: count(s?.prize_count),
    reportedDiscard: cards(s?.discard_cards), reportedLostZone: cards(s?.lost_zone),
    active: creature(area?.active, owner, 'active', 0),
    bench: array(area?.bench)?.map((c, i) => creature(c, owner, 'bench', i)) ?? null,
  };
}
function observation(raw) {
  const state = raw.game_state;
  const ownKey = raw.player;
  const otherKeys = Object.keys(state).filter(k => k !== ownKey && k !== 'stadium_spot');
  if (!state[ownKey] || otherKeys.length !== 1) throw new Error('Cannot establish focal seat');
  const you = side(state[ownKey], 'you');
  const opponent = side(state[otherKeys[0]], 'opponent');
  return {
    schema: 'replay-evidence/1', turnNumber: count(raw.turn_number), focalSeat: 'you',
    reportedOwnHand: cards(state[ownKey].hand_cards)?.map((c, i) => ({ alias: `you/hand/${i}`, ...c })) ?? null,
    ownHandEvidence: 'reported earlier forward audit from reset17 through57; not reproduced by these three downloads',
    you, opponent: { ...opponent, handIdentities: null },
    stadium: state.stadium_spot === null ? { reportedAbsent: true } : { reportedAbsent: null },
    fullDeck: null, legalCandidates: null, currentPrompt: null, decisionContext: null,
    uncertainty: {
      opponentHandIdentities: 'masked in all cases',
      publicBoard: 'provisional parser reconstruction',
      abilityAttribution: 'upstream position33 Drakloak ambiguity reported; per-entity usage withheld',
      placementAndEvolution: 'withheld; reconstruction not independently verified',
      printingToCatalog: 'exact native keys or declared catalog aliases only; null means unresolved',
    },
  };
}
function label(raw, pre) {
  const choice = raw.decision_point?.player_choice;
  if (!choice || !['ability', 'trainer_card'].includes(choice.action)) throw new Error('Unsupported observed choice');
  const code = text(choice.card_number);
  const actors = [pre.you.active, ...(pre.you.bench ?? [])].filter(c => c?.sourcePrintingCode === code);
  const hand = (pre.reportedOwnHand ?? []).filter(c => c.sourcePrintingCode === code);
  const sources = choice.action === 'ability' ? actors : hand;
  const abilityName = choice.action === 'ability' ? choice.display_text?.match(/ used ([^.]+)\.$/)?.[1] ?? null : null;
  if (!code || sources.length !== 1 || (choice.action === 'ability' && !abilityName))
    throw new Error('Observed choice has no unique source binding in preceding snapshot');
  const kind = choice.action === 'ability' ? 'ability' : 'play';
  const nativeAction = catalog?.action({ cardIdentity: sources[0].catalogIdentity, kind, abilityName }) ?? null;
  return {
    kind,
    sourceAlias: sources[0].alias, sourcePrintingCode: code, reportedCardName: sources[0].reportedName,
    abilityName, targetAlias: null, targetStatus: 'not established; do not infer a contingent prompt answer',
    legalOfferId: null, nativeActionKey: nativeAction?.actionKey ?? null, nativeAction,
    sourceCatalogIdentity: sources[0].catalogIdentity,
    operationTarget: { known: nativeAction != null, alias: null,
      meaning: 'native initial Use operation has no target; later effect selections are separate decisions' },
    quality: 'observed human choice; ungraded', bindingEvidence: 'unique matching printing in provisional pre-state',
  };
}
function diagnostics(value, path = '') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const at = `${path}/${key}`;
    return /constraint|ambigu|resolved_by|violation/i.test(key)
      ? [{ path: at, value: child }] : diagnostics(child, at);
  });
}
const loaded = new Map();
for (const entry of manifest.samples) {
  const bytes = await readFile(resolve(root, entry.file));
  const raw = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (raw.position !== entry.position) throw new Error('Position mismatch');
  loaded.set(entry.position, { raw, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const examples = manifest.pairs.map(({ statePosition, actionPosition }) => {
  const state = loaded.get(statePosition), action = loaded.get(actionPosition);
  if (!state || !action || actionPosition !== statePosition + 1
    || state.raw.player !== action.raw.player || state.raw.turn_number !== action.raw.turn_number)
    throw new Error('Invalid adjacent post-state/pre-action alignment');
  const pre = observation(state.raw);
  return {
    provenance: { matchUrl: manifest.matchUrl, statePosition, actionPosition,
      stateSha256: state.sha256, actionSha256: action.sha256 },
    preActionEvidence: pre, observedChoice: label(action.raw, pre),
    admission: {
      evidencePairRetained: true, existingModelInputValid: false, trainingEligible: false,
      modelEncodingAttempted: false,
      blockers: ['no complete legal candidate set for masked-choice BC',
        'unverified board/history fields lack sufficient unknown masks in the frozen base input'],
      reuseQuestion: 'affirmative third-party dataset license unresolved; no established explicit training prohibition',
    },
  };
});
const audit = {
  generatedAtUtc: new Date().toISOString(), downloadedSamples: loaded.size,
  evidencePairs: examples.length, modelReadyExamples: 0,
  sourceDiagnostics: [...loaded].map(([position, { raw }]) => ({ position,
    findings: diagnostics(raw), absenceMeaning: 'no exported diagnostic is not proof of unambiguous history' })),
  pairs: examples.map(e => ({ statePosition: e.provenance.statePosition, actionPosition: e.provenance.actionPosition,
    handCount: e.preActionEvidence.you.handCount, label: e.observedChoice,
    blockers: e.admission.blockers })),
  catalogPin: catalog ? { sha256: catalog.sha256, contractSha256: catalog.contractSha256,
    matchedSelectedBaselineReceipt: manifest.catalog.matchedSelectedBaselineReceipt } : null,
  exclusions: ['future consequences', 'post-label game_state', 'winner/outcome', 'opponent hand identities',
    'raw player names', 'pile_id and decision_id', 'placement/evolution bookkeeping', 'unverified ability-use counters'],
  workPerformed: 'offline JSON projection only; no engine, fitting, inference, or training import',
};
await mkdir(resolve(root, 'derived'), { recursive: true });
await writeFile(resolve(root, 'derived/evidence-pairs.json'), JSON.stringify(examples, null, 2) + '\n');
await writeFile(resolve(root, 'derived/admission-report.json'), JSON.stringify(audit, null, 2) + '\n');
const partialLabels = examples.map(e => ({ schema: 'partial-observation-positive-label/1',
  provenance: e.provenance, observation: e.preActionEvidence,
  demonstratedAction: e.observedChoice,
  semanticTuple: { kind: e.observedChoice.kind, sourceAlias: e.observedChoice.sourceAlias,
    sourceCardVocabularyId: e.observedChoice.sourceCatalogIdentity?.cardId ?? null,
    nativeActionId: e.observedChoice.nativeAction?.actionId ?? null,
    nativeActionKey: e.observedChoice.nativeActionKey },
  semanticLabelAdmitted: e.observedChoice.nativeAction != null,
  legality: { executionReportedByReplay: true, independentlyVerified: false, alternatives: null },
  supervision: { kind: 'positive-semantic-label-only', optimality: 'ungraded',
    rejectedOrUnobservedActionsAreNegatives: false, behaviorLogProbability: null,
    explicitAcceptableAlternatives: null, acceptableSetComplete: false,
    existingMaskedChoiceLossCompatible: false, trainingEligible: false },
}));
await writeFile(resolve(root, 'derived/partial-positive-labels.json'), JSON.stringify(partialLabels, null, 2) + '\n');
await writeFile(resolve(root, 'derived/mapping-proof.json'), JSON.stringify({
  catalogPin: audit.catalogPin,
  mappings: partialLabels.map(row => ({ provenance: row.provenance, tuple: row.semanticTuple,
    cardProof: row.demonstratedAction.sourceCatalogIdentity?.proof,
    actionProof: row.demonstratedAction.nativeAction?.proof,
    sourceBinding: row.demonstratedAction.bindingEvidence,
    admitted: row.semanticLabelAdmitted })),
}, null, 2) + '\n');
console.log(JSON.stringify({ downloadedSamples: loaded.size, evidencePairs: examples.length,
  modelReadyExamples: 0, pairs: audit.pairs.map(p => ({ state: p.statePosition, action: p.actionPosition,
    handCount: p.handCount, kind: p.label.kind, card: p.label.reportedCardName, ability: p.label.abilityName })) }, null, 2));
