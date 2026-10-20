import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeVisibleScreen } from '../integrations/official-client/recognize.mjs';

function fixture() {
  const capture = { width: 1366, height: 768, capturedAt: 10000, imageSha256: 'a'.repeat(64) };
  const word = (text, x, y) => ({ text, confidence: .99, polygon: [[x - 20, y - 7], [x + 20, y - 7], [x + 20, y + 7], [x - 20, y + 7]] });
  return { schema: 'official-client-ocr/1', capture, words: [word('HOME', 69, 26), word('DECKS', 139, 26),
    word('PROFILE', 214, 26), word('SHOP', 286, 26), word('RANKED', 763, 75), word('CASUAL', 928, 75),
    word('LEARN', 1092, 75), word('PLAY', 990, 480), word('AgentPult', 985, 675)] };
}

test('recognizes an anchored Home layout and offers only safe Decks navigation', () => {
  const result = recognizeVisibleScreen(fixture());
  assert.equal(result.screen, 'home-lobby');
  assert.equal(result.deckDisplayName, 'AgentPult');
  assert.equal(result.gameplayReady, false);
  assert.deepEqual(result.controls.map(control => control.id), ['navigation.decks']);
  assert.deepEqual(result.controls[0].target, { x: 139, y: 26, bounds: [119, 19, 159, 33] });
  assert.ok(result.unknowns.includes('legal-gameplay-candidates'));
  assert.ok(result.controls.every(control => control.label !== 'PLAY'));
});

test('abstains for missing, duplicate, weak, or misplaced anchor words', () => {
  for (const alter of [
    value => value.words.splice(1, 1),
    value => value.words.push(structuredClone(value.words[1])),
    value => { value.words[1].confidence = .89; },
    value => { value.words[1].polygon = value.words[1].polygon.map(([x, y]) => [x, y + 100]); }
  ]) {
    const value = fixture(); alter(value);
    const result = recognizeVisibleScreen(value);
    assert.equal(result.screen, 'unknown');
    assert.deepEqual(result.controls, []);
  }
});

test('does not invent the selected deck or turn malformed and mismatched data into controls', () => {
  const missing = fixture(); missing.words.pop();
  assert.equal(recognizeVisibleScreen(missing).deckDisplayName, null);
  const generic = fixture(); generic.words.at(-1).text = 'Dragapult';
  assert.equal(recognizeVisibleScreen(generic).deckDisplayName, null);
  const value = fixture();
  assert.equal(recognizeVisibleScreen(value, { ...value.capture, imageSha256: 'b'.repeat(64) }).screen, 'unknown');
  value.words[0].polygon[0][0] = -1;
  assert.deepEqual(recognizeVisibleScreen(value).controls, []);
});

test('abstains when a warning or confirmation may cover the known layout', () => {
  const value = fixture();
  value.words.push({ text: 'CANCEL', confidence: .99, polygon: [[500, 400], [550, 400], [550, 420], [500, 420]] });
  const result = recognizeVisibleScreen(value);
  assert.equal(result.screen, 'unknown');
  assert.ok(result.unknowns.includes('possible-modal'));
});

test('admits only Decks navigation from the inspected ladder details screen without inventing a deck', () => {
  const value = fixture(); value.words = value.words.slice(0, 4);
  value.words.push({ text: 'SEPTEMBER2026LADDER', confidence: .99, polygon: [[84,69],[450,69],[450,95],[84,95]] },
    { text: 'LADDER END REWARDS', confidence: .99, polygon: [[1175,81],[1312,81],[1312,97],[1175,97]] });
  const result = recognizeVisibleScreen(value);
  assert.equal(result.screen, 'ranked-ladder');
  assert.equal(result.deckDisplayName, null);
  assert.equal(result.gameplayReady, false);
  assert.deepEqual(result.controls.map(control => control.id), ['navigation.decks']);
  const duplicate = structuredClone(value); duplicate.words.push(structuredClone(duplicate.words.at(-1)));
  assert.deepEqual(recognizeVisibleScreen(duplicate).controls, []);
  value.words.at(-1).confidence = .8;
  assert.deepEqual(recognizeVisibleScreen(value).controls, []);
});
