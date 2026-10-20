'use strict';

// Explicitly authorized scoped instrumentation. No credential, SDK authority,
// private-card, opponent-hand, deck-order, prize-identity or raw-board reads.
const mono = Process.getModuleByName('mono-2.0-bdwgc.dll');
const user = Process.getModuleByName('user32.dll');
const foreground = new NativeFunction(user.getExportByName('GetForegroundWindow'), 'pointer', []);
const visible = new NativeFunction(user.getExportByName('IsWindowVisible'), 'int', ['pointer']);
const iconic = new NativeFunction(user.getExportByName('IsIconic'), 'int', ['pointer']);
const owner = new NativeFunction(user.getExportByName('GetWindowThreadProcessId'), 'uint', ['pointer', 'pointer']);
let boundWindow = ptr(0), allowTestGame = false, testGameStarted = false;
function background() {
  const id = Memory.alloc(4); owner(boundWindow, id);
  if (boundWindow.isNull() || id.readU32() !== Process.id || !visible(boundWindow) || iconic(boundWindow)
      || foreground().equals(boundWindow)) throw new Error('runtime-background-window-required');
}
const api = (name, result, args) => new NativeFunction(mono.getExportByName(name), result, args);
const root = api('mono_get_root_domain', 'pointer', [])();
api('mono_thread_attach', 'pointer', ['pointer'])(root);
const assemblyForeach = api('mono_assembly_foreach', 'void', ['pointer', 'pointer']);
const assemblyImage = api('mono_assembly_get_image', 'pointer', ['pointer']);
const imageName = api('mono_image_get_name', 'pointer', ['pointer']);
const classFromName = api('mono_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
const classParent = api('mono_class_get_parent', 'pointer', ['pointer']);
const className = api('mono_class_get_name', 'pointer', ['pointer']);
const objectClass = api('mono_object_get_class', 'pointer', ['pointer']);
const valueType = api('mono_class_is_valuetype', 'int', ['pointer']);
const methodNamed = api('mono_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
const classMethods = api('mono_class_get_methods', 'pointer', ['pointer', 'pointer']);
const methodName = api('mono_method_get_name', 'pointer', ['pointer']);
const signature = api('mono_method_signature', 'pointer', ['pointer']);
const parameterCount = api('mono_signature_get_param_count', 'uint', ['pointer']);
const classField = api('mono_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
const classVtable = api('mono_class_vtable', 'pointer', ['pointer', 'pointer']);
const staticGet = api('mono_field_static_get_value', 'void', ['pointer', 'pointer', 'pointer']);
const fieldGet = api('mono_field_get_value', 'void', ['pointer', 'pointer', 'pointer']);
const invoke = api('mono_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
const virtualMethod = api('mono_object_get_virtual_method', 'pointer', ['pointer', 'pointer']);
const unbox = api('mono_object_unbox', 'pointer', ['pointer']);
const classType = api('mono_class_get_type', 'pointer', ['pointer']);
const typeObject = api('mono_type_get_object', 'pointer', ['pointer', 'pointer']);
const arrayLength = api('mono_array_length', 'ulong', ['pointer']);
const arrayAddress = api('mono_array_addr_with_size', 'pointer', ['pointer', 'int', 'ulong']);
const stringLength = api('mono_string_length', 'int', ['pointer']);
const stringChars = api('mono_string_chars', 'pointer', ['pointer']);
const compile = api('mono_compile_method', 'pointer', ['pointer']);
const newString = api('mono_string_new', 'pointer', ['pointer', 'pointer']);
const images = new Map();
const collect = new NativeCallback(assembly => {
  const image = assemblyImage(assembly);
  images.set(imageName(image).readUtf8String().replace(/\.dll$/, ''), image);
}, 'void', ['pointer', 'pointer']);
assemblyForeach(collect, ptr(0));
function klass(image, namespace, name) {
  if (!images.has(image)) throw new Error('required-image-missing');
  const value = classFromName(images.get(image), Memory.allocUtf8String(namespace), Memory.allocUtf8String(name));
  if (value.isNull()) throw new Error('required-class-missing');
  return value;
}
function method(type, name, count) {
  for (let current = type; !current.isNull(); current = classParent(current)) {
    const found = methodNamed(current, Memory.allocUtf8String(name), count);
    if (!found.isNull()) return found;
    const iterator = Memory.alloc(Process.pointerSize); iterator.writePointer(ptr(0));
    let candidate;
    while (!(candidate = classMethods(current, iterator)).isNull()) {
      if (methodName(candidate).readUtf8String().endsWith('.' + name) && parameterCount(signature(candidate)) === count) return candidate;
    }
  }
  throw new Error('required-method-missing:' + name);
}
function run(target, selected, args = []) {
  const argv = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
  args.forEach((value, index) => argv.add(index * Process.pointerSize).writePointer(value));
  const exception = Memory.alloc(Process.pointerSize); exception.writePointer(ptr(0));
  const value = invoke(selected, target, argv, exception);
  if (!exception.readPointer().isNull()) throw new Error('managed-call-rejected');
  return value;
}
function call(target, name, args = []) {
  if (target.isNull()) throw new Error('ui-object-unavailable');
  const selected = method(objectClass(target), name, args.length);
  const resolved = virtualMethod(target, selected);
  return run(valueType(objectClass(target)) ? unbox(target) : target, resolved, args);
}
function field(target, name) {
  if (target.isNull()) return ptr(0);
  let selected = ptr(0);
  for (let current = objectClass(target); !current.isNull(); current = classParent(current)) {
    selected = classField(current, Memory.allocUtf8String(name));
    if (!selected.isNull()) break;
  }
  if (selected.isNull()) throw new Error('required-ui-field-missing:' + name);
  const out = Memory.alloc(Process.pointerSize); fieldGet(target, selected, out);
  return out.readPointer();
}
function scalarField(target, name, booleanValue = false) {
  let selected = ptr(0);
  for (let current = objectClass(target); !current.isNull(); current = classParent(current)) {
    selected = classField(current, Memory.allocUtf8String(name));
    if (!selected.isNull()) break;
  }
  if (selected.isNull()) throw new Error('required-scalar-field-missing:' + name);
  const out = Memory.alloc(8); fieldGet(target, selected, out);
  return booleanValue ? out.readU8() !== 0 : out.readS32();
}
function offlineGame() {
  const type = klass('TPCI.RainierClient', '', 'NetworkMatchController');
  const selected = classField(type, Memory.allocUtf8String('gameplayType'));
  if (selected.isNull()) throw new Error('required-gameplay-type-missing');
  const out = Memory.alloc(4); staticGet(classVtable(root, type), selected, out);
  return out.readS32() === 7;
}
function str(value, bound = 128) {
  if (value.isNull()) return null;
  const length = stringLength(value);
  if (length < 0 || length > bound) throw new Error('ui-string-out-of-bounds');
  return stringChars(value).readUtf16String(length);
}
function integer(value) { if (value.isNull()) throw new Error('ui-value-unavailable'); return unbox(value).readS32(); }
function boolean(value) { if (value.isNull()) throw new Error('ui-value-unavailable'); return unbox(value).readU8() !== 0; }
function intArg(value) { const out = Memory.alloc(4); out.writeS32(value); return out; }
const textArg = value => newString(root, Memory.allocUtf8String(value));
const sdkOperations = klass('RainierClientSDK', 'RainierClientSDK', 'MatchUserOperations');
function sdk(name, args) { return run(ptr(0), method(sdkOperations, name, args.length), args); }
function sequence(value, bound = 60) {
  if (value.isNull()) return [];
  const iterator = call(value, 'GetEnumerator');
  const result = [];
  while (boolean(call(iterator, 'MoveNext'))) {
    if (result.length >= bound) throw new Error('ui-sequence-out-of-bounds');
    result.push(call(iterator, 'get_Current'));
  }
  return result;
}
const unityObject = klass('UnityEngine.CoreModule', 'UnityEngine', 'Object');
function objects(type) {
  const reflected = typeObject(root, classType(type));
  const includeInactive = Memory.alloc(1); includeInactive.writeU8(1);
  const array = run(ptr(0), method(unityObject, 'FindObjectsOfType', 2), [reflected, includeInactive]);
  const length = Number(arrayLength(array));
  if (length > 16) throw new Error('ambiguous-ui-objects');
  return Array.from({ length }, (_, index) => arrayAddress(array, Process.pointerSize, index).readPointer());
}
const rainier = klass('TPCI.RainierClient', '', 'RainierManager');
const decks = klass('TPCI.RainierClient', 'TPCI.Rainier.Features.DeckManager', 'HUBDeckSelectController');
const matches = klass('TPCI.RainierClient', '', 'MatchManager');
function one(type, required = false) {
  const found = objects(type);
  if (found.length > 1 || (required && found.length !== 1)) throw new Error('ambiguous-ui-instance');
  return found[0] ?? ptr(0);
}
function inherits(target, name) {
  for (let current = objectClass(target); !current.isNull(); current = classParent(current)) {
    if (className(current).readUtf8String() === name) return true;
  }
  return false;
}
function selectedDeck(controller) {
  if (controller.isNull()) return null;
  const panel = field(controller, 'deckPanel');
  if (panel.isNull()) return null;
  const selection = call(panel, 'GetCurrentSelection');
  if (selection.isNull()) return null;
  const name = str(field(selection, 'deckName'));
  if (name !== 'AgentPult') return { displayName: name, exactCards: null };
  // Only this player's displayed deck composition, never a match deck/order.
  const cards = field(selection, 'cards');
  const json = run(ptr(0), method(klass('Newtonsoft.Json', 'Newtonsoft.Json', 'JsonConvert'), 'SerializeObject', 1), [cards]);
  const exactCards = JSON.parse(str(json, 16384));
  if (!exactCards || Object.keys(exactCards).length > 60 || Object.values(exactCards).some(n => !Number.isInteger(n) || n < 1 || n > 60)) throw new Error('own-deck-shape-invalid');
  return { displayName: name, exactCards, standardValid: scalarField(selection, 'valid', true),
    testDeckInteractable: boolean(call(field(panel, 'testDeckButton'), 'IsInteractable')) };
}
function publicCard(card, own, creature = false) {
  // Check the visible representation before obtaining any identifying CardInfo.
  if (card.isNull() || !boolean(call(card, 'get_IsPublic'))) return null;
  // Callers enumerate public board/discard/stadium zones or explicit visible
  // selection senders. visuallyRevealed is a prize-animation flag, not the
  // face-up status of an opponent's board card. Opponent hand/deck/prizes are
  // never enumerated here.
  const info = call(card, 'get_cardInfo');
  const instanceId = str(call(info, 'get_entityID'));
  const source = str(call(info, 'get_cardSourceID'));
  const category = boolean(call(info, 'get_isPokemon')) ? 'pokemon' : boolean(call(info, 'get_isEnergy')) ? 'energy' : 'trainer';
  const result = { instanceId, source, category, name: str(call(info, 'get_cardName')) };
  if (creature) {
    const energy = str(call(info, 'get_totalEnergy')) ?? '';
    result.hp = integer(call(info, 'get_totalHP'));
    result.damage = integer(call(info, 'get_damageCounters')) * 10;
    result.energy = energy;
    result.currentRetreat = integer(call(info, 'get_retreatCost'));
    result.conditions = ['get_posStatusEffects', 'get_negsStatusEffects'].flatMap(getter => sequence(call(info, getter))
      .map(applied => field(applied, 'statusEffect')).filter(effect => className(objectClass(effect)).readUtf8String() === 'SpecialConditionEffect')
      .map(effect => ['none', 'poison', 'burn', 'paralyze', 'confuse', 'sleep'][integer(call(effect, 'GetEffectEnumValue'))]));
    result.publicCards = { energy: [], tools: [], evolutions: [] };
    const attached = new Set();
    const collect = (parent, depth) => {
      for (const child of sequence(call(parent, 'GetOwnedCards'), 60)) {
        const value = publicCard(child, false);
        if (!value || attached.has(value.instanceId)) continue;
        attached.add(value.instanceId);
        result.publicCards[value.category === 'energy' ? 'energy' : value.category === 'pokemon' ? 'evolutions' : 'tools'].push(value);
        if (depth < 2) collect(child, depth + 1);
      }
    };
    collect(card, 0);
  }
  if (own) {
    result.placeableBoardPos = sequence(call(info, 'get_placeableBoardPos')).map(integer);
    result.attachableEntities = sequence(call(info, 'get_attachableEntities')).map(value => str(value));
    result.usableActions = sequence(call(info, 'get_activeUsableActions')).map(action => ({
      guid: str(call(action, 'GetActionGUID')), type: integer(call(action, 'GetActionType')),
      name: str(call(action, 'GetName')), source: str(call(action, 'GetActionSourceID')) }));
  }
  return result;
}
function matchObservation(match) {
  const board = call(match, 'get_board'); // Rendered UI BoardController, never MatchBoard.
  function side(playerIndex) {
    const player = call(board, 'GetPlayer', [intArg(playerIndex)]);
    const own = playerIndex === 0;
    function cards(zone, creature = false) {
      const owner = field(player, zone);
      return sequence(call(owner, 'GetOwnedCards')).map(card => publicCard(card, own, creature)).filter(Boolean);
    }
    // Opponent hand is a count only. Neither hand entries nor deck/prize entries
    // are enumerated. The counters are the same properties used by visible UI.
    const handOwner = field(player, 'hand');
    return { hand: own ? cards('hand') : null,
      handCount: integer(call(field(handOwner, 'ownedCards'), 'get_Count')),
      deckCount: integer(call(field(player, 'deck'), 'get_CardCount')),
      prizes: integer(call(field(player, 'prize'), 'get_CardCount')),
      active: cards('active', true), bench: cards('bench', true), discard: cards('discard'), stadium: cards('stadium') };
  }
  const navigation = call(match, 'get_MenuNavigation');
  const menu = call(navigation, 'get_CurrentMenu');
  const result = { state: integer(call(match, 'get_currentState')), operationProcessing: boolean(call(match, 'get_IsOperationProcessing')),
    isMyTurn: boolean(call(match, 'get_IsMyTurn')), turnNumber: integer(call(call(match, 'get_currentMatch'), 'GetRoundCount')),
    menu: menu.isNull() ? null : className(objectClass(menu)).readUtf8String(), you: side(0), opponent: side(1) };
  // The attachment overlay moves public board cards into a visual miniature.
  // Recover their semantic zones from that UI's original-owner map, without
  // consulting an engine board or substituting a previous observation.
  if (!menu.isNull() && inherits(menu, 'BoardAttachedCardSelectionMenu')) {
    const miniature = field(menu, 'tinyBoardLayout');
    for (const pointer of sequence(call(miniature, 'GetCardsAccessibleForTargeting'), 24)) {
      if (!boolean(call(pointer, 'get_IsPublic'))) continue;
      const original = call(miniature, 'GetTrueOwnerForCard', [pointer]);
      for (const playerIndex of [0, 1]) {
        const player = call(board, 'GetPlayer', [intArg(playerIndex)]), target = playerIndex === 0 ? result.you : result.opponent;
        for (const zone of ['active', 'bench', 'stadium']) if (original.equals(field(player, zone))) {
          const card = publicCard(pointer, playerIndex === 0, zone !== 'stadium');
          if (card && !target[zone].some(existing => existing.instanceId === card.instanceId)) target[zone].push(card);
        }
      }
    }
  }
  const currentMatch = call(match, 'get_currentMatch');
  result.offline = offlineGame();
  result.gameOver = scalarField(currentMatch, 'gameOver', true);
  const winningSeat = result.gameOver ? scalarField(currentMatch, 'winner') : null;
  result.winner = [1, 2].includes(winningSeat) ? (winningSeat === (boolean(call(currentMatch, 'get_isPlayer1')) ? 1 : 2) ? 'you' : 'opponent') : null;
  result.finalReason = terminalReason;
  const offered = [];
  commandMap.clear();
  // SDK legality queries mutate its shared testMatchOperation. The offline AI
  // uses that same scratch object on its own thread: never query during its turn.
  if (!result.operationProcessing && !result.menu && (result.isMyTurn || result.state === 1)) {
    const ownVisible = [...result.you.hand, ...result.you.active, ...result.you.bench];
    const targets = [...result.you.active, ...result.you.bench];
    const offer = (kind, source, target, label, command, args, extra = {}) => {
      const id = JSON.stringify([command, ...args]);
      commandMap.set(id, { command, args });
      offered.push({ id, kind, ...(source ? { sourceCardId: source.instanceId } : {}),
        ...(target ? { targetId: target.instanceId } : {}), label, ...extra });
    };
    for (const card of ownVisible) {
      for (const position of card.placeableBoardPos) {
        if (boolean(sdk('CanPlaceCard', [textArg(card.instanceId), intArg(position), textArg(''), ptr(0), intArg(0)])))
          offer('play', card, null, 'Place ' + card.name + ' ' + ([15, 16].includes(position) ? 'active' : [13, 14].includes(position) ? 'bench' : 'stadium'), 'PlaceCard', [card.instanceId, position, '']);
      }
      for (const target of targets) {
        if (boolean(sdk('CanAttachCard', [textArg(card.instanceId), textArg(target.instanceId), textArg(''), ptr(0), intArg(0)])))
          offer('play', card, target, 'Attach ' + card.name + ' to ' + target.name, 'AttachCard', [card.instanceId, target.instanceId, '']);
        if (boolean(sdk('CanEvolveCard', [textArg(card.instanceId), textArg(target.instanceId), textArg(''), ptr(0), intArg(0)])))
          offer('play', card, target, 'Evolve ' + target.name + ' with ' + card.name, 'EvolveCard', [card.instanceId, target.instanceId, '']);
      }
      for (const action of card.usableActions) {
        if (!boolean(sdk('CanUseCard', [textArg(card.instanceId), textArg(action.guid), textArg(''), ptr(0), intArg(0), intArg(0)]))) continue;
        offer(action.type === 1 ? 'attack' : action.type === 2 ? 'ability' : 'play', card, null,
          card.name + ': ' + action.name, action.type === 1 ? 'AttackCard' : 'UseCard', [card.instanceId, action.guid, ''],
          { ...(action.type === 1 ? { attackName: action.name } : {}), actionKey: card.source + '/' + action.source });
      }
    }
    const current = call(match, 'get_currentMatch');
    if (boolean(sdk('CanEndTurn', [current]))) offer('pass', null, null, result.state === 1 ? 'Finish setup' : 'End turn', 'EndTurn', ['', 0]);
    if (result.state === 2 && result.you.active.length && boolean(sdk('CanRetreat', [current])))
      offer('retreat', result.you.active[0], null, 'Retreat active Pokemon', 'Retreat', ['']);
  }
  result.actions = offered;
  result.acknowledgement = !menu.isNull() && inherits(menu, 'MulliganDisplayOverlay') ? 'mulligan-done' : null;
  result.prompt = null;
  result.uiTransitionPending = !menu.isNull() && inherits(menu, 'PrizeCardSelectionMenu') && scalarField(menu, '_selectionSubmitted', true);
  promptChoiceMap.clear();
  if (!menu.isNull() && inherits(menu, 'PrizeCardSelectionMenu') && !result.uiTransitionPending && boolean(call(menu, 'get_IsAwaitingSelection'))) {
    if (!boolean(call(menu, 'get_IsSelectingFromLocalPlayerCards'))) throw new Error('runtime-opponent-prize-selection-not-admitted');
    // These are displayed clickable card backs. Never inspect their CardInfo,
    // addresses, indexes or any underlying prize identities.
    const choices = sequence(field(menu, '_validCard3Ds'), 6).map((pointer, index) => {
      const id = 'prize-slot-' + index; promptChoiceMap.set(id, { opaquePrizePointer: pointer }); return { id };
    });
    result.prompt = { kind: 'prizes', min: scalarField(menu, '_minPrizesToSelect'), max: scalarField(menu, '_maxPrizesToSelect'),
      selectedCount: integer(call(field(menu, '_selectedPrizes'), 'get_Count')), choices };
  } else if (!menu.isNull() && inherits(menu, 'TextSelectionOverlay')) {
    const options = sequence(call(menu, 'GetOptions')).map(value => str(value));
    result.prompt = { kind: 'text', selectionType: scalarField(field(menu, 'typedSelection'), 'selectionType'),
      choices: options.map((label, index) => ({ id: 'option-' + index, label })).filter(choice => choice.label !== 'REMOVED_OPTION') };
  } else if (!menu.isNull() && inherits(menu, 'ReparentDamageMenu')) {
    const selection = field(menu, 'damageSelection');
    if (boolean(call(selection, 'get_isUnlimited'))) throw new Error('runtime-unlimited-damage-not-admitted');
    const from = new Set(sequence(call(selection, 'get_fromDamageSelections'), 24).map(entry => str(call(entry, 'get_entityID'))));
    const to = new Set(sequence(call(selection, 'get_toDamageSelections'), 24).map(entry => str(call(entry, 'get_entityID'))));
    const visible = new Map([...result.you.active, ...result.you.bench, ...result.opponent.active, ...result.opponent.bench].map(card => [card.instanceId, card]));
    const max = integer(call(selection, 'get_maxMovableDamageTotal'));
    const send = integer(call(selection, 'get_maxSendDamageSingle')), receive = integer(call(selection, 'get_maxRecvDamageSingle'));
    const groups = [{ id: 'damage-from', min: integer(call(selection, 'get_minSourceSelectionCount')), max: integer(call(selection, 'get_maxSourceSelectionCount')) },
      { id: 'damage-to', min: integer(call(selection, 'get_minTargetSelectionCount')), max: integer(call(selection, 'get_maxTargetSelectionCount')) }];
    let hasBoth = false;
    const choices = sequence(call(selection, 'get_finalDamageSelections'), 24).map((entry, index) => {
      const entityId = str(call(entry, 'get_entityID')), card = visible.get(entityId), initial = integer(call(entry, 'get_currentDamageCounters'));
      if (!card || initial * 10 !== card.damage) throw new Error('runtime-damage-target-not-visible-or-mismatched');
      const inFrom = from.has(entityId), inTo = to.has(entityId), id = 'damage-' + index;
      if (inFrom && inTo) hasBoth = true;
      promptChoiceMap.set(id, { damageEntityId: entityId, damageInitial: initial });
      return { id, identity: entityId, source: card.source, name: card.name, category: card.category,
        group: inFrom && inTo ? 'damage-both' : inFrom ? 'damage-from' : 'damage-to', initialAmount: initial,
        minAmount: inFrom ? Math.max(0, initial - Math.min(max, send < 0 ? initial : send)) : initial,
        maxAmount: inTo ? initial + Math.min(max, receive < 0 ? max : receive) : initial };
    });
    if (hasBoth) groups.push({ id: 'damage-both', min: 0, max: choices.length });
    result.prompt = { kind: 'allocation', min: integer(call(selection, 'get_minMovableDamageTotal')), max,
      groups, choices, allocationUnit: 10, allocationMode: 'final' };
  } else if (!menu.isNull() && inherits(menu, 'AttachCardFromPileMenu')) {
    const selection = call(menu, 'get_reparentSelection');
    if (boolean(call(selection, 'get_unlimitedReparent'))) throw new Error('runtime-unlimited-reparent-not-admitted');
    const visibleSources = new Map();
    for (const sender of sequence(call(menu, 'ValidTargetSenders'), 8)) {
      for (const card of sequence(call(sender, 'GetCardsAccessibleForTargeting'), 60)) {
        const value = publicCard(card, true);
        if (value) visibleSources.set(value.instanceId, { value, pointer: card });
      }
    }
    const options = sequence(call(selection, 'get_reparentOptions'), 60).map(option => ({ option, sourceId: str(call(option, 'get_entityID')) }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const groups = options.map(({ option, sourceId }, index) => {
      const source = visibleSources.get(sourceId);
      if (!source) throw new Error('runtime-reparent-source-not-visible');
      const targets = sequence(call(menu, 'ValidPlacementReceivers', [source.pointer]), 24).map(pointer => ({ pointer, value: publicCard(pointer, true) }))
        .filter(target => target.value).sort((a, b) => a.value.source.localeCompare(b.value.source) || a.value.instanceId.localeCompare(b.value.instanceId));
      // This source is already admitted by the visible targeting UI. Retain it
      // so an exact source -> destination decision survives outside pointer maps.
      return { id: 'reparent-' + index, min: 0, max: 1, sourceCard: source.value, choices: targets.map((target, targetIndex) => {
        const id = `reparent-${index}-${targetIndex}`;
        promptChoiceMap.set(id, { reparentOption: option, targetId: target.value.instanceId });
        return { id, identity: target.value.instanceId, name: target.value.name, source: target.value.source, category: target.value.category };
      }) };
    });
    result.prompt = { kind: 'entities', reparent: true, selectionMethod: 16,
      min: integer(call(selection, 'get_minReparentedOptions')), max: integer(call(selection, 'get_maxReparentedOptions')), groups };
  } else if (!menu.isNull() && (inherits(menu, 'EntitySelectionOverlay') || inherits(menu, 'ActivePromotionDragMenu'))) {
    const selection = field(menu, inherits(menu, 'ActivePromotionDragMenu') ? 'entitySelection' : 'typedSelection');
    const rendered = new Map();
    // Inspect only cards explicitly exposed by this visible selection UI.
    // No deck/prize container enumeration or CardAddress.index reads.
    for (const sender of sequence(call(menu, 'ValidTargetSenders'), 8)) {
      if (sender.isNull()) continue;
      for (const card of sequence(call(sender, 'GetCardsAccessibleForTargeting'), 60)) {
        const value = publicCard(card, true);
        if (value) rendered.set(value.instanceId, { value, pointer: card });
      }
    }
    if (inherits(menu, 'BoardAttachedCardSelectionMenu')) {
      const constraints = field(menu, 'bacsConstraintEvaluator');
      const publicParents = sequence(call(constraints, 'GetCardsTappableForDistribution'), 24);
      const directCards = sequence(call(constraints, 'GetCardsTappableForDirectSelection'), 60);
      const addVisible = (card, depth) => {
        const value = publicCard(card, true);
        if (!value) return;
        rendered.set(value.instanceId, { value, pointer: card });
        if (depth < 3) for (const child of sequence(call(card, 'GetOwnedCards'), 60)) addVisible(child, depth + 1);
      };
      for (const card of [...publicParents, ...directCards]) addVisible(card, 0);
    }
    const groups = sequence(field(selection, 'selectionGroups'), 16).map((group, groupIndex) => {
      const options = sequence(call(group, 'get_validOptions'), 60).map(option => str(call(option, 'get_entityID')))
        .filter(id => rendered.has(id)).map(id => ({ id, ...rendered.get(id) }))
        .sort((a, b) => a.value.source.localeCompare(b.value.source) || a.id.localeCompare(b.id));
      return { id: 'group-' + groupIndex, min: integer(call(group, 'get_minAmount')), max: integer(call(group, 'get_maxAmount')),
        choices: options.map((option, index) => {
          const id = `entity-${groupIndex}-${index}`;
          promptChoiceMap.set(id, { group, entityId: option.id, pointer: option.pointer });
          return { id, identity: option.id, name: option.value.name, source: option.value.source, category: option.value.category };
        }) };
    });
    result.prompt = { kind: 'entities', selectionMethod: scalarField(selection, 'selectionMethod'),
      min: integer(call(selection, 'get_totalMinAmount')), max: integer(call(selection, 'get_totalMaxAmount')), groups };
  }
  return result;
}
let terminalReason = { schema: 'official-client-terminal-reason/1', source: 'BattleOutro.ShowMatchResultOverlay',
  status: 'unknown', terminalObserved: false, observedAt: null, localWon: null, reasonLocId: null, text: null };
let cachedTerminalExport = null;
function exportableBattleLog() {
  const match = one(matches, true);
  const assignable = api('mono_class_is_assignable_from', 'int', ['pointer', 'pointer']);
  const contract = name => klass('TPCI.RainierClient', '_Rainier.Scripts.BattleLog', name);
  const phases = contract('IBattleLogPhaseData'), entries = contract('IBattleLogMainEntryData'), subs = contract('IBattleLogSubEntryData');
  const lines = []; let characters = 0;
  const append = value => {
    lines.push(value ?? '');
    characters += (value ?? '').length + 2;
    if (lines.length > 10000 || characters > 1024 * 1024) throw new Error('runtime-battle-log-budget');
  };
  // Mirrors BattleLogExporter formatting, without calling ExportBattleLog,
  // touching the clipboard, or reading any other fields on these models.
  for (const phase of sequence(call(match, 'get_BattleLogExportData'), 5000)) {
    if (!assignable(phases, objectClass(phase))) continue;
    const kind = integer(call(phase, 'get_BattlePhase'));
    append(str(call(phase, [0, 1].includes(kind) ? 'get_PlainTextPhaseTitle' : 'get_PhaseTitle'), 4096));
    for (const entry of sequence(call(phase, 'get_LogEntries'), 5000)) {
      if (!assignable(entries, objectClass(entry))) continue;
      append(str(call(entry, 'get_PlainTextDisplayString'), 4096));
      for (const sub of sequence(call(entry, 'get_SubEntries'), 5000)) {
        if (!assignable(subs, objectClass(sub))) continue;
        append('- ' + (str(call(sub, 'get_PlainTextDisplayString'), 4096) ?? ''));
        const detail = str(call(sub, 'get_PlainTextSubString'), 4096);
        if (detail) append('   \u0007 ' + detail);
      }
    }
    append('');
  }
  return { schema: 'official-client-battle-log-export/1', source: 'MatchManager.BattleLogExportData', observedAt: Date.now(),
    matchIdentity: str(call(call(match, 'get_currentMatch'), 'get_matchID')), text: lines.map(line => line + '\r\n').join(''),
    terminalReason, capturePhase: terminalReason.terminalObserved ? 'terminal-ui-read' : 'live-ui-read' };
}
function readBattleLog() {
  try { return exportableBattleLog(); }
  catch (error) { if (cachedTerminalExport) return cachedTerminalExport; throw error; }
}
// Observe the ordinary visible outro arguments and its displayed message. No
// EndGameModification, raw board, hidden winner calculation or log parsing.
let terminalHook = null;
try {
  terminalHook = Interceptor.attach(compile(method(klass('TPCI.RainierClient', '', 'BattleOutro'), 'ShowMatchResultOverlay', 2)), {
    onEnter(args) {
      this.outro = args[0];
      try {
        const reasonLocId = str(args[2], 512);
        terminalReason = { schema: 'official-client-terminal-reason/1', source: 'BattleOutro.ShowMatchResultOverlay',
          status: reasonLocId ? 'observed' : 'unknown', terminalObserved: true, observedAt: Date.now(),
          localWon: (args[1].toInt32() & 0xff) !== 0, reasonLocId, text: null };
      } catch { terminalReason = { ...terminalReason, status: 'unknown', terminalObserved: false }; }
    },
    onLeave() {
      try {
        const bar = field(this.outro, 'gameEndReasonDisplay');
        const text = str(call(bar, 'get_CurrText'), 2048);
        terminalReason = { ...terminalReason, text, status: text || terminalReason.reasonLocId ? 'observed' : 'unknown' };
      } catch { /* The exact reason stays unknown; never infer it. */ }
      try { cachedTerminalExport = { ...exportableBattleLog(), capturePhase: 'terminal-ui-presentation-cache' }; }
      catch { /* A later bounded read may succeed while the UI still exists. */ }
    },
  });
} catch { /* Source-bound optional observation; absence is exposed in ready. */ }
function observe() {
  const manager = one(rainier);
  let screen = null;
  if (!manager.isNull()) {
    const current = call(manager, 'get_CurrentOpenScreen');
    if (!current.isNull()) screen = { type: className(objectClass(current)).readUtf8String(), code: integer(call(current, 'get_screenType')) };
  }
  const match = one(matches);
  return { schema: 'official-client-runtime-ui/1', screen, selectedDeck: selectedDeck(one(decks)), terminalReason,
    match: match.isNull() ? null : matchObservation(match),
    policyView: null, gameplayReady: false, unknowns: ['playing-policy-view', 'legal-gameplay-candidates', 'gameplay-prompt-mappings'] };
}
const commandMap = new Map();
const promptChoiceMap = new Map();
let pending = null, stopped = false, actions = 0, lastAction = 0;
const consumed = new Set();
const dispatcher = klass('TPCI.RainierClient.Managers.GameManager.UnityMainThreadDispatcher', '', 'UnityMainThreadDispatcher');
const hook = Interceptor.attach(compile(method(dispatcher, 'Update', 0)), {
  onEnter() {
    if (!pending || stopped) return;
    const request = pending; pending = null; clearTimeout(request.timer);
    try {
      if (Date.now() > request.deadline) throw new Error('runtime-request-expired');
      if (request.op === 'battle_log') return request.accept(readBattleLog());
      const before = observe();
      if (request.op === 'observe') return request.accept(before);
      if (!request.id || consumed.has(request.id) || request.expected !== JSON.stringify(before)) throw new Error('runtime-stale-or-reused-action');
      if (actions >= (allowTestGame ? 300 : 2) || Date.now() - lastAction < 2000) throw new Error('runtime-action-budget');
      background();
      if (testGameStarted && before.match && !before.match.offline) throw new Error('runtime-offline-game-required');
      let execute;
      if (request.op === 'acknowledge_mulligan' && testGameStarted && before.match?.acknowledgement === 'mulligan-done')
        execute = () => {
          const menu = call(call(one(matches, true), 'get_MenuNavigation'), 'get_CurrentMenu');
          const drawer = call(field(field(menu, 'customView'), 'modalDrawerBuilder'), 'get_Drawer');
          const buttons = sequence(call(drawer, 'get_BottomButtons'), 8).filter(button => boolean(call(call(button, 'get_gameObject'), 'get_activeInHierarchy')) && boolean(call(button, 'IsInteractable')));
          if (buttons.length !== 1) throw new Error('runtime-mulligan-done-button-unverified');
          call(call(buttons[0], 'get_onClick'), 'Invoke');
        };
      else if (request.op === 'leave_previous_test' && allowTestGame && !testGameStarted && before.match?.offline && !before.match.gameOver)
        execute = () => call(one(matches, true), 'ConcedeMatch');
      else if (request.op === 'open_decks' && !before.match && before.screen?.code === 0) execute = () => call(one(decks, true), 'Activate');
      else if (request.op === 'start_test_deck' && allowTestGame && !testGameStarted && !before.match && before.screen?.code === 1
          && before.selectedDeck?.displayName === 'AgentPult' && before.selectedDeck.standardValid && before.selectedDeck.testDeckInteractable
          && Object.values(before.selectedDeck.exactCards).reduce((sum, count) => sum + count, 0) === 60) {
        execute = () => {
          testGameStarted = true; cachedTerminalExport = null;
          terminalReason = { schema: 'official-client-terminal-reason/1', source: 'BattleOutro.ShowMatchResultOverlay',
            status: 'unknown', terminalObserved: false, observedAt: null, localWon: null, reasonLocId: null, text: null };
          call(one(decks, true), 'Settings_TestDeck');
        };
      } else if (request.op === 'act' && testGameStarted && before.match && request.data?.actionId && commandMap.has(request.data.actionId)) {
        const selected = commandMap.get(request.data.actionId);
        execute = () => sdk(selected.command, selected.args.map(value => typeof value === 'number' ? intArg(value) : textArg(value)));
      } else if (request.op === 'answer_text' && testGameStarted && before.match?.prompt?.kind === 'text'
          && before.match.prompt.choices.some(choice => choice.id === request.data?.choiceId)) {
        const index = Number(request.data.choiceId.slice(7));
        execute = () => call(call(call(one(matches, true), 'get_MenuNavigation'), 'get_CurrentMenu'), 'SelectOption', [intArg(index)]);
      } else if (request.op === 'answer_allocation' && testGameStarted && before.match?.prompt?.kind === 'allocation'
          && Array.isArray(request.data?.amounts) && request.data.amounts.length === before.match.prompt.choices.length
          && new Set(request.data.amounts.map(entry => entry.choiceId)).size === request.data.amounts.length
          && request.data.amounts.every(entry => Number.isSafeInteger(entry.count) && before.match.prompt.choices.some(choice => choice.id === entry.choiceId && entry.count >= choice.minAmount && entry.count <= choice.maxAmount))) {
        const amounts = request.data.amounts.map(entry => ({ ...entry, ...promptChoiceMap.get(entry.choiceId) }));
        execute = () => {
          const menu = call(call(one(matches, true), 'get_MenuNavigation'), 'get_CurrentMenu'), constraints = field(menu, 'constraintEvaluator');
          for (const entry of amounts) if (entry.count < entry.damageInitial) call(constraints, 'AccountForRemovedDamage', [textArg(entry.damageEntityId), intArg(entry.damageInitial - entry.count)]);
          for (const entry of amounts) if (entry.count > entry.damageInitial) call(constraints, 'AccountForAddedDamage', [textArg(entry.damageEntityId), intArg(entry.count - entry.damageInitial)]);
          if (!boolean(call(field(menu, 'damageSelection'), 'Validate'))) throw new Error('runtime-selection-validation-rejected-no-send');
          call(menu, 'CompleteReparentingAction');
        };
      } else if (request.op === 'answer_prizes' && testGameStarted && before.match?.prompt?.kind === 'prizes'
          && before.match.prompt.selectedCount === 0 && Array.isArray(request.data?.choiceIds)
          && request.data.choiceIds.length >= before.match.prompt.min && request.data.choiceIds.length <= before.match.prompt.max
          && new Set(request.data.choiceIds).size === request.data.choiceIds.length
          && request.data.choiceIds.every(id => promptChoiceMap.get(id)?.opaquePrizePointer)) {
        const selected = request.data.choiceIds.map(id => promptChoiceMap.get(id).opaquePrizePointer);
        execute = () => {
          const menu = call(call(one(matches, true), 'get_MenuNavigation'), 'get_CurrentMenu');
          for (const pointer of selected) call(menu, 'TryMarkCardSelected', [pointer, intArg(0)]);
          const button = field(menu, 'doneButton');
          if (!boolean(call(button, 'IsInteractable'))) throw new Error('runtime-prize-submit-not-interactable');
          call(call(button, 'get_onClick'), 'Invoke');
        };
      } else if (request.op === 'answer_entities' && testGameStarted && before.match?.prompt?.kind === 'entities'
          && Array.isArray(request.data?.choiceIds) && request.data.choiceIds.length <= 60
          && new Set(request.data.choiceIds).size === request.data.choiceIds.length
          && request.data.choiceIds.every(id => promptChoiceMap.has(id))) {
        const selected = request.data.choiceIds.map(id => promptChoiceMap.get(id));
        const menu = call(call(one(matches, true), 'get_MenuNavigation'), 'get_CurrentMenu');
        if (inherits(menu, 'AttachCardFromPileMenu')) {
          const selection = call(menu, 'get_reparentSelection');
          if (selected.some(choice => !choice.reparentOption) || new Set(selected.map(choice => choice.reparentOption.toString())).size !== selected.length)
            throw new Error('runtime-reparent-choice-invalid');
          execute = () => {
            for (const choice of selected) call(choice.reparentOption, 'SetNewParentEntityID', [textArg(choice.targetId)]);
            if (!boolean(call(selection, 'Validate'))) throw new Error('runtime-selection-validation-rejected-no-send');
            call(menu, 'CompleteReparentingAction', [intArg(0)]);
          };
        } else {
        if (new Set(selected.map(choice => choice.entityId)).size !== selected.length) throw new Error('runtime-duplicate-physical-choice');
        const promotion = inherits(menu, 'ActivePromotionDragMenu');
        const selection = field(menu, promotion ? 'entitySelection' : 'typedSelection');
        execute = () => {
          for (const group of sequence(field(selection, 'selectionGroups'), 16)) call(call(group, 'get_selectedOptions'), 'Clear');
          for (const choice of selected) call(choice.group, 'AddToSelectedOptionsByEntityID', [textArg(choice.entityId)]);
          if (!boolean(call(selection, 'Validate'))) throw new Error('runtime-selection-validation-rejected-no-send');
          if (promotion) call(menu, 'SubmitSelectionAndClose');
          else {
            // This menu's override expects an actively distributed visual
            // endpoint. Its ordinary submit already consumes the validated
            // selection groups and restores its temporary board on close.
            if (!inherits(menu, 'BoardAttachedCardSelectionMenu')) for (const choice of selected) call(menu, 'AddSelection', [choice.pointer]);
            call(menu, 'SubmitClicked');
          }
        };
        }
      } else throw new Error('runtime-action-not-admitted');
      consumed.add(request.id); actions++; lastAction = Date.now();
      execute();
      request.accept({ schema: 'official-client-runtime-action/1', id: request.id, status: 'sent-unverified', target: request.op, actions });
    } catch (error) { request.reject(new Error(error.message)); }
  }
});
rpc.exports = {
  ready(windowId, enableTestGame, resumeOwnedGame) {
    boundWindow = ptr(windowId); allowTestGame = enableTestGame === true;
    if (resumeOwnedGame === true) { if (!allowTestGame || !offlineGame()) throw new Error('runtime-offline-game-required'); testGameStarted = true; }
    return { schema: 'official-client-runtime-ready/1', processId: Process.id, mainThreadHook: true, inputArmed: false,
    admittedReadOperations: ['observe', 'battle_log'], terminalUiCaptureAvailable: terminalHook !== null,
    admittedActions: allowTestGame ? ['open_decks', 'acknowledge_mulligan', 'leave_previous_test', 'start_test_deck', 'act', 'answer_text', 'answer_entities', 'answer_prizes', 'answer_allocation'] : ['open_decks'], testGameLaunchEnabled: allowTestGame, credentialsAccessed: false }; },
  request(op, id, expected, data) {
    if (stopped || pending || !['observe', 'battle_log', 'open_decks', ...(allowTestGame ? ['acknowledge_mulligan', 'leave_previous_test', 'start_test_deck', 'act', 'answer_text', 'answer_entities', 'answer_prizes', 'answer_allocation'] : [])].includes(op)) throw new Error('runtime-request-not-admitted');
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { if (pending?.id === id) pending = null; reject(new Error('runtime-main-thread-timeout')); }, 5000);
      pending = { op, id, expected, data, accept, reject, timer, deadline: Date.now() + 4500 };
    });
  },
  close() { stopped = true; if (pending) { clearTimeout(pending.timer); pending.reject(new Error('runtime-closed')); pending = null; } hook.detach(); terminalHook?.detach(); return { closed: true }; }
};
