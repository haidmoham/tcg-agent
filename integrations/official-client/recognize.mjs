const unknownFields = ['loaded-exact-printings', 'current-legality', 'playing-policy-view', 'legal-gameplay-candidates', 'gameplay-control-mappings'];
const normalize = value => value.trim().replace(/\s+/g, ' ').toUpperCase();
const metadataKeys = ['width', 'height', 'capturedAt', 'imageSha256'];
const regions = {
  HOME: [.02, 0, .075, .07], DECKS: [.075, 0, .13, .07], PROFILE: [.13, 0, .20, .07], SHOP: [.18, 0, .24, .07],
  RANKED: [.50, .07, .61, .14], CASUAL: [.62, .07, .75, .14], LEARN: [.75, .07, .85, .14], PLAY: [.59, .50, .87, .70],
  AGENTPULT: [.65, .80, .81, .93]
};

function wordsFrom(input, capture) {
  if (!Array.isArray(input) || input.length > 1000) return null;
  const words = [];
  for (const word of input) {
    if (!word || typeof word.text !== 'string' || word.text.length > 256 || !Number.isFinite(word.confidence)
        || word.confidence < 0 || word.confidence > 1 || !Array.isArray(word.polygon) || word.polygon.length !== 4) return null;
    if (word.polygon.some(point => !Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
        || point[0] < 0 || point[1] < 0 || point[0] > capture.width || point[1] > capture.height)) return null;
    const xs = word.polygon.map(point => point[0]), ys = word.polygon.map(point => point[1]);
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (bounds[0] === bounds[2] || bounds[1] === bounds[3]) return null;
    words.push({ label: normalize(word.text), confidence: word.confidence, bounds,
      center: { x: (bounds[0] + bounds[2]) / 2, y: (bounds[1] + bounds[3]) / 2 } });
  }
  return words;
}

export function recognizeVisibleScreen(ocr, capture = ocr?.capture) {
  const unknown = reason => ({ schema: 'official-client-recognition/1', screen: 'unknown', controls: [],
    deckDisplayName: null, gameplayReady: false, unknowns: [reason, ...unknownFields] });
  if (ocr?.schema !== 'official-client-ocr/1' || !capture || !ocr.capture
      || !Number.isSafeInteger(capture.width) || capture.width < 100 || capture.width > 7680
      || !Number.isSafeInteger(capture.height) || capture.height < 100 || capture.height > 4320
      || !Number.isSafeInteger(capture.capturedAt) || capture.capturedAt < 0
      || !/^[a-f0-9]{64}$/.test(capture.imageSha256 ?? '')
      || metadataKeys.some(key => capture[key] !== ocr.capture[key])) return unknown('capture-metadata-mismatch');
  const words = wordsFrom(ocr.words, capture);
  if (!words) return unknown('invalid-ocr-words');
  if (words.some(word => word.confidence >= .8 && /^(WARNING|ERROR|CONFIRM|CANCEL|YES|NO|SIGN IN|LOGIN|UPDATE|MAINTENANCE|CONNECTION LOST)$/.test(word.label))) return unknown('possible-modal');
  const locate = label => {
    const [left, top, right, bottom] = regions[label];
    const matches = words.filter(word => word.label === label && word.center.x / capture.width >= left
      && word.center.x / capture.width <= right && word.center.y / capture.height >= top && word.center.y / capture.height <= bottom);
    return matches.length === 1 && matches[0].confidence >= .9 ? matches[0] : null;
  };
  const header = Object.fromEntries(['HOME', 'DECKS', 'PROFILE', 'SHOP'].map(label => [label, locate(label)]));
  const ladderTitle = words.filter(word => word.label.replace(/\s/g, '') === 'SEPTEMBER2026LADDER' && word.confidence >= .95
    && word.center.x / capture.width > .05 && word.center.x / capture.width < .38 && word.center.y / capture.height > .07 && word.center.y / capture.height < .15);
  const ladderRewards = words.filter(word => word.label.replace(/\s/g, '') === 'LADDERENDREWARDS' && word.confidence >= .95
    && word.center.x / capture.width > .8 && word.center.y / capture.height > .07 && word.center.y / capture.height < .16);
  if (Object.values(header).every(Boolean) && ladderTitle.length === 1 && ladderRewards.length === 1) {
    return { schema: 'official-client-recognition/1', screen: 'ranked-ladder', capture: { ...capture }, deckDisplayName: null, gameplayReady: false,
      controls: [{ id: 'navigation.decks', label: 'DECKS', target: { ...header.DECKS.center, bounds: [...header.DECKS.bounds] },
        expectedScreen: 'decks', authority: 'navigation-only' }], unknowns: ['selected-deck-display-name', ...unknownFields] };
  }
  const anchors = { ...header, ...Object.fromEntries(['RANKED', 'CASUAL', 'LEARN', 'PLAY'].map(label => [label, locate(label)])) };
  if (Object.values(anchors).some(anchor => !anchor)) return unknown('unrecognized-home-layout');
  const decks = anchors.DECKS;
  const selectedDeck = locate('AGENTPULT') ? 'AgentPult' : null;
  return { schema: 'official-client-recognition/1', screen: 'home-lobby', capture: { ...capture },
    deckDisplayName: selectedDeck, gameplayReady: false,
    controls: [{ id: 'navigation.decks', label: 'DECKS', target: { ...decks.center, bounds: [...decks.bounds] },
      expectedScreen: 'decks', authority: 'navigation-only' }],
    unknowns: [...(selectedDeck ? [] : ['selected-deck-display-name']), ...unknownFields] };
}
