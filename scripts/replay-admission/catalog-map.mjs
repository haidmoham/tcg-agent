import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Only exact catalog IDs/declared aliases are accepted. Never fuzzy-match names
// or strip printing suffixes. All returned numeric IDs are pinned to this catalog.
export async function loadCatalog(path, expectedSha256) {
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!expectedSha256 || sha256 !== expectedSha256) throw new Error('Catalog pin mismatch');
  const catalog = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (catalog.schema !== 'model5-public-catalog/1') throw new Error('Unsupported catalog schema');
  const canonical = code => {
    const seen = new Set();
    while (Object.hasOwn(catalog.printingAliases ?? {}, code)) {
      if (seen.has(code)) throw new Error('Catalog alias cycle');
      seen.add(code); code = catalog.printingAliases[code];
    }
    return code;
  };
  function card(code) {
    const key = canonical(code);
    const id = catalog.cardIds?.[key];
    const row = catalog.cards?.[id];
    if (!Number.isSafeInteger(id) || id <= 0 || row?.id !== id) return null;
    return { catalogSha256: sha256, cardId: id, definitionId: row.key,
      category: row.category, format: row.format, catalogName: row.name,
      proof: { requestedCode: code, canonicalToken: key,
        resolution: key === code && row.key === code ? 'exact-native-source-key' : 'explicit-catalog-join-or-alias',
        catalogPath: `cards[${id}]`, cardIdsToken: key },
    };
  }
  function action({ cardIdentity, kind, abilityName }) {
    if (!cardIdentity) return null;
    const key = cardIdentity.definitionId;
    let rows = catalog.actions.filter(row => row.id > 0 && row.key.startsWith(`${key}/`) && !row.key.endsWith('/play'));
    if (kind === 'ability') rows = rows.filter(row =>
      row.name === `[Ability] ${abilityName}` || row.name === abilityName);
    else if (kind === 'play' && cardIdentity.category === 'trainer')
      rows = rows.filter(row => row.evidence?.source === key && row.evidence.actionSourceID != null);
    else return null;
    // Native Offers.cs uses Use(actionSourceID) for trainer effects, not the
    // catalog's synthetic /play alias. Multiple source effects remain unresolved.
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (catalog.actionIds?.[row.key] !== row.id || row.evidence?.source !== key
      || row.key !== `${key}/${row.evidence.actionSourceID}`) return null;
    return { catalogSha256: sha256, actionId: row.id, actionKey: row.key, catalogName: row.name,
      proof: { resolution: kind === 'ability' ? 'exact-action-name-on-exact-card' : 'sole-native-trainer-use-action',
        catalogPath: `actions[${row.id}]`, nativeActionSourceId: row.evidence.actionSourceID,
        nativeOfferRule: 'MatchWorker.Offers.cs: OfflineUseActions -> source.cardSourceID/action.actionSourceID' } };
  }
  return { sha256, contractSha256: catalog.contractSha256, card, action };
}
