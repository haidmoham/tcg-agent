import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const model2Sha256 = '144180ba472cfe23e405eb7c47448e5c88e8148ac5440c5d38f37a54d7ad690b';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const agentPult = JSON.parse(await readFile(new URL('./agent-pult.json', import.meta.url)));

export function auditAgentPult(joins = [], reprints = []) {
  const total = agentPult.cards.reduce((sum, card) => sum + card.count, 0);
  if (total !== 60 || new Set(agentPult.cards.map(card => `${card.set}-${card.number}`)).size !== 24) throw new Error('invalid-agent-pult-manifest');
  return {
    schema: 'official-client-compatibility/1', deck: agentPult.displayName, total,
    readyForClientInference: false,
    reasons: ['capture-to-policy-unmapped', 'loaded-printings-unverified', 'current-legality-unverified', 'exact-deck-gameplay-unverified', 'client-legal-offers-unmapped'],
    cards: agentPult.cards.map(card => ({ printing: `${card.set}-${card.number}`, name: card.name, count: card.count,
      pinnedPrintingJoin: joins.some(join => join.printingId === `${card.set}-${card.number}` && join.status === 'joined'),
      semanticEvidence: reprints.find(item => item.printing === `${card.set}-${card.number}`) ?? null,
      gameplayVerified: false, modelCoverage: 'unproven-for-exact-printing', uiMapping: 'unverified' }))
  };
}

export async function verifyModel2(configPath, receiptPath) {
  const config = JSON.parse(await readFile(configPath));
  const receipt = JSON.parse(await readFile(receiptPath));
  const actual = sha256(await readFile(config.checkpoint));
  if (actual !== model2Sha256 || receipt.training?.checkpointSha256 !== actual
      || receipt.featureSchema !== 'native-ordinary-features/1' || receipt.runtime?.parameters !== 1953
      || receipt.runtime?.stateDim !== 32 || receipt.runtime?.candidateDim !== 27) throw new Error('model2-pin-mismatch');
  return { config, evidence: { checkpointSha256: actual, featureSchema: receipt.featureSchema,
    parameters: 1953, stateDimensions: 32, candidateDimensions: 27, role: 'ordinary-action behavioral clone', setupAndPrompts: 'unsupported-by-official-client-bridge' } };
}
