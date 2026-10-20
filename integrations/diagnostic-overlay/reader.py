"""Read-only projection of private Live journals. No client imports or RPCs."""
import collections
import datetime
import json
import re
import time
from pathlib import Path

UNKNOWN = 'unavailable'


def val(value):
    return UNKNOWN if value is None else str(value)


def clock(at):
    return datetime.datetime.fromtimestamp(at / 1000).strftime('%H:%M:%S') if at else '?'


def age(at):
    return f'{max(0, time.time() - at / 1000):.1f}s' if at else UNKNOWN


class JsonLines:
    """Keep incomplete trailing lines until a writer finishes them; bound memory."""
    def __init__(self, path):
        self.path, self.offset, self.pending = path, 0, b''
        self.rows = collections.deque(maxlen=6000)
        self.bad = 0

    def poll(self):
        if not self.path.exists():
            return
        if self.path.stat().st_size < self.offset:
            self.offset, self.pending = 0, b''
            self.rows.clear()
        with self.path.open('rb') as stream:
            stream.seek(self.offset)
            chunk = stream.read(8 * 1024 * 1024)
            self.offset = stream.tell()
        lines = (self.pending + chunk).split(b'\n')
        self.pending = lines.pop()
        for line in lines:
            if not line.strip():
                continue
            try:
                self.rows.append(json.loads(line.decode('utf-8-sig')))
            except (ValueError, UnicodeError):
                self.bad += 1


class Reader:
    def __init__(self, pointer):
        self.pointer = Path(pointer)
        self.folder = None
        self.streams = {}
        self.manifest = {}
        self.names = {}
        self.catalog_status = UNKNOWN
        self.session = {}
        try:
            self.manifest = json.loads((self.pointer.parent / 'official-client-model5.json').read_text(encoding='utf-8-sig'))
            catalog = json.loads(Path(self.manifest['modelConfig']['catalogPath']).read_text(encoding='utf-8-sig'))
            names = {c['id']: c.get('name', c.get('key')) for c in catalog['cards']}
            self.names = {key: names.get(index, key) for key, index in catalog['cardIds'].items()}
            self.catalog_status = f'local extracted catalog: {len(self.names)} label mappings'
        except (OSError, ValueError, KeyError):
            self.catalog_status = 'local catalog unavailable; observed labels still used'

    def name(self, card):
        if not isinstance(card, dict):
            return '?'
        key = card.get('definitionId', card.get('source', card.get('printingId', '?')))
        return card.get('name') or self.names.get(key, key)

    def action(self, item, cards=None):
        cards = cards or {}
        if not isinstance(item, dict):
            return UNKNOWN
        source = cards.get(item.get('sourceCardId') or item.get('actorId'), '')
        target = cards.get(item.get('targetId'), '')
        label = item.get('label') or ' '.join(filter(None, [item.get('kind'), source, item.get('attackName')]))
        return (label or item.get('id', '?')) + (f' -> {target}' if target else '')

    def update(self):
        pointer = json.loads(self.pointer.read_text(encoding='utf-8-sig'))
        folder = Path(pointer['folder'])
        if folder != self.folder:
            self.folder, self.streams, self.session = folder, {}, {}
        paths = [folder / 'events.jsonl', folder / 'private-observations.jsonl', folder / 'private-policy-decisions.jsonl']
        paths += sorted(folder.glob('private-decisions-*.jsonl'))
        for path in paths:
            stream = self.streams.setdefault(path.name, JsonLines(path))
            stream.poll()
        journal = sorted([row for key, stream in self.streams.items() if key.startswith('private-decisions-') for row in stream.rows], key=lambda r: (r.get('at', 0), r.get('sequence', 0)))
        for row in journal:
            if row.get('event') == 'session':
                self.session = row
        latest = lambda kind: next((r for r in reversed(journal) if r.get('event') == kind), {})
        obs, proposal = latest('observation'), latest('proposal')
        rawrows = self.streams['private-observations.jsonl'].rows
        raw = rawrows[-1] if rawrows else {}
        rawresult = raw.get('result') or {}
        # An actor projection is a declared visibility boundary. Never display raw runtime objects.
        actor = obs.get('actor') or {}
        actor_at = obs.get('at')
        if raw.get('at', 0) > obs.get('at', 0) and isinstance(rawresult.get('match'), dict):
            actor = rawresult['match']
            actor_at = raw['at']
        view = proposal.get('policyInput') or {}
        events = self.streams['events.jsonl'].rows
        finished = next((r for r in reversed(events) if r.get('event') == 'game-finished'), {})
        detached = next((r for r in reversed(events) if r.get('event') == 'detached-and-paused'), {})
        pins = self.session.get('pins') or {}
        contract = pins.get('featureContract') or {}
        checkpoint = pins.get('ordinaryCheckpointSha256') or self.manifest.get('checkpointSha256')
        contract_hash = self.manifest.get('contractSha256')
        current_turn = actor.get('turnNumber')
        whose = ('you' if actor['isMyTurn'] else 'opponent') if isinstance(actor.get('isMyTurn'), bool) else UNKNOWN
        freshness = 'STALE / last observed' if not actor_at or time.time() * 1000 - actor_at > 10000 else 'LIVE LOG'
        if finished or actor.get('gameOver') is True:
            freshness = 'COMPLETED / retained session'
        lines = [f'{freshness} | observation {clock(actor_at)} | age {age(actor_at)}',
                 f"{pointer.get('candidate', UNKNOWN)} | checkpoint {str(checkpoint)[:12] if checkpoint else UNKNOWN}",
                 f"Contract {contract.get('schema', UNKNOWN)} / {str(contract_hash)[:12] if contract_hash else UNKNOWN}",
                 f'Turn {val(current_turn)} | whose turn: {whose} | phase code: {val(actor.get("state"))}',
                 f'Revision {val(obs.get("revision"))} | phase name: unavailable (code retained)',
                 '']
        winner = finished.get('winner', actor.get('winner'))
        winner = winner if winner in ('you', 'opponent', 'draw') else UNKNOWN
        if finished or actor.get('gameOver') is True:
            lines.insert(1, f'RESULT: {winner} | ended {clock(finished.get("at"))} | historical board below')
        board = []
        cards = {}
        for owner in ('you', 'opponent'):
            side = actor.get(owner) or {}
            board += [owner.upper(), f'Hand {val(side.get("handCount"))}  Deck {val(side.get("deckCount"))}  Discard {len(side["discard"]) if isinstance(side.get("discard"), list) else UNKNOWN}  Prizes {val(side.get("prizes"))}']
            for zone in ('active', 'bench'):
                creatures = side.get(zone)
                creatures = [creatures] if isinstance(creatures, dict) else creatures
                if creatures is None:
                    board.append(f'{zone}: unavailable')
                for i, card in enumerate(creatures or []):
                    name = self.name(card)
                    cards[card.get('instanceId')] = name
                    hp, damage = card.get('hp'), card.get('damage')
                    remain = hp - damage if isinstance(hp, (int, float)) and isinstance(damage, (int, float)) else None
                    board.append(f'{zone[0].upper()}{i+1} {name} | HP {val(hp)} - damage {val(damage)} = {val(remain)}')
                    energy = card.get('providedEnergyTypes')
                    if energy is None and 'energy' in card:
                        types = {'R':'fire','P':'psychic','D':'darkness','W':'water','G':'grass','L':'lightning','F':'fighting','M':'metal','C':'colorless','Y':'fairy','N':'dragon'}
                        energy = [types.get(x, x) for x in re.findall(r'\{([A-Z])\}', card['energy'])] if re.fullmatch(r'(\{[A-Z]\})*', card['energy']) else None
                    conditions = card.get('conditions')
                    board.append('   Energy ' + (', '.join(energy) or 'none' if energy is not None else UNKNOWN) + ' | Status ' + (', '.join(conditions) or 'none' if isinstance(conditions, list) else val(conditions)))
                    tools = (card.get('publicCards') or {}).get('tools')
                    if tools:
                        board.append('   Tools: ' + ', '.join(self.name(c) for c in tools))
            # Own visible hand, and public discards only. Never traverse opponent hidden zones.
            if owner == 'you':
                for card in side.get('hand') or []:
                    cards[card.get('instanceId')] = self.name(card)
            board.append('')
        prompt = actor.get('prompt')
        offers = ['CURRENT OBSERVED OFFERS', f'Observation age {age(actor_at)}', '']
        actions = actor.get('actions')
        offers.append(f'Legal actions: {len(actions) if isinstance(actions, list) else UNKNOWN}')
        for i, action in enumerate(actions or []):
            offers.append(f'{i+1:02d}. {self.action(action, cards)}')
        offers.extend(self.prompt_lines(prompt))
        origin = view.get('decisionContext') or {}
        offers += ['', 'LAST POLICY INPUT ORIGIN (historical)', self.name(origin.get('originCard')) if origin.get('originCard') else UNKNOWN,
                   val(origin.get('originEvidence')), 'Prompt selection labels are only the actor-visible offers.']
        did = proposal.get('decisionId')
        same = [r for r in journal if r.get('decisionId') == did] if did else []
        get = lambda kind: next((r for r in reversed(same) if r.get('event') == kind), {})
        dispatch, result, linked = get('dispatch'), get('execution-result'), get('observation-link')
        decision = proposal.get('decision') or {}
        attr = proposal.get('attribution') or {}
        policy_actions = view.get('actions') or []
        selected = next((a for a in policy_actions if a.get('id') == decision.get('actionId')), None)
        policy_cards = list(view.get('hand') or [])
        for owner in ('you', 'opponent'):
            side = view.get(owner) or {}
            active = side.get('active')
            policy_cards += ([active] if isinstance(active, dict) else active or []) + list(side.get('bench') or []) + list(side.get('discard') or [])
        selected_text = self.action(selected, {c.get('instanceId'): self.name(c) for c in policy_cards}) if selected else val(decision.get('choiceIds'))
        state = [f'LAST CHOICE | {clock(proposal.get("at"))} | turn {val(view.get("turnNumber"))}',
                 f'{attr.get("kind", UNKNOWN).upper()}: {attr.get("id", UNKNOWN)}', selected_text,
                 'Logits: unavailable | probabilities: unavailable',
                 'Scores are not reasons or calibrated confidence.']
        ranking = proposal.get('ranking')
        if ranking is not None:
            state += [f'Recorded ranking (candidate indices only): {ranking}']
        state += ['', f'Proposed {clock(proposal.get("at"))} | dispatched {clock(dispatch.get("at"))}',
                  f'Returned {clock(result.get("at"))}: {val(result.get("status"))}',
                  f'Runtime status: {val(((result.get("response") or {}).get("result") or {}).get("status"))}',
                  f'Semantic execution verified: {val(result.get("executionVerified"))}',
                  f'Subsequent observation: {val(linked.get("status"))}',
                  'A later state does not prove the intended action executed.']
        dc = obs.get('driverContext') or {}
        timing = [f'Current acknowledgement: {val((dc.get("acknowledgement") or {}).get("kind"))}' if isinstance(dc.get('acknowledgement'), dict) else f'Current acknowledgement: {val(dc.get("acknowledgement"))}',
                  f'Processing: {val(dc.get("operationProcessing"))} | transition pending: {val(dc.get("uiTransitionPending"))}']
        elapsed = result.get('at', 0) - dispatch.get('at', 0) if result and dispatch else None
        timing += [f'Dispatch -> return (journal wall time): {val(elapsed)} ms',
                   f'Inference latency: unavailable | RPC internal latency: unavailable',
                   f'Frame/capture age: unavailable | observation age: {age(actor_at)}',
                   f'Proposal age: {age(proposal.get("at"))} | reader poll: 1000 ms']
        terminal = actor.get('finalReason') or obs.get('terminalUi') or {}
        terminal_lines = ['TERMINAL', f'Game over flag: {val(actor.get("gameOver"))}',
                          f'Recorded winner: {winner} | event: {clock(finished.get("at"))}',
                          f'Controller detached/paused: {bool(detached)} | input stopped: {val(detached.get("inputStopped"))}',
                          f'UI terminal observed: {val(terminal.get("terminalObserved"))}',
                          f'Local won: {val(terminal.get("localWon"))}',
                          f'Reason: {val(terminal.get("reasonLocId"))}']
        uncertainty = ['UNCERTAINTY / MISSING FIELDS', 'Opponent hand/deck/prize faces excluded by projection.', self.catalog_status,
                       f'Malformed complete JSONL records: {sum(s.bad for s in self.streams.values())}',
                       'Unknown runtime fields: ' + ', '.join(rawresult.get('unknowns') or []),
                       'Unprojected: ' + '; '.join((obs.get('actor', {}).get('uncertainty') or {}).get('unprojected') or []),
                       'Public context (last policy input):']
        for category, owners in (view.get('publicContext') or {}).items():
            for owner, item in owners.items():
                uncertainty.append(f'  {category}/{owner}: known={val(item.get("known"))}, value={val(item.get("value"))}')
        encoded = proposal.get('encodedInput') or {}
        for key, nameskey in [('globals', 'globalFeatures'), ('entities', 'entityFeatures'), ('candidates', 'candidateFeatures')]:
            values = encoded.get(key) or []
            names = contract.get(nameskey) or []
            vectors = [values] if key == 'globals' else values
            uncertainty += ['', f'{key}: {len(vectors)} vector(s), named known/unknown masks:']
            for i, name in enumerate(names):
                if re.search('known|unknown|observed|missing', str(name), re.I):
                    counts = collections.Counter(str(v[i]) for v in vectors if i < len(v))
                    uncertainty.append(f'  {name}: {dict(counts)}')
            if key != 'globals':
                ids = encoded.get('entityCardIds' if key == 'entities' else 'candidateActionIds') or []
                uncertainty.append(f'  Vocabulary unknown ID 0: {ids.count(0)}/{len(ids)} (includes structural/sentinel uses)')
        history = ['RECENT JOURNAL (latest 60 events; UTC local clock)', 'MODEL / HELPER and driver stages remain separate.', '']
        filtered = [r for r in journal if r.get('event') not in ('observation', 'session', 'session-metadata')]
        for row in filtered[-60:]:
            kind = row.get('event')
            label = ''
            if kind == 'proposal':
                a = row.get('attribution') or {}
                label = a.get('kind', '?').upper() + ' ' + a.get('id', '?')
            elif kind == 'execution-result':
                label = f'{val(row.get("status"))}, semantic verified={val(row.get("executionVerified"))}'
            elif kind == 'dispatch':
                label = (row.get('request') or {}).get('op', '?')
            elif kind == 'observation-link':
                label = row.get('status', '?')
            history.append(f'{clock(row.get("at"))}  {kind}  {label}')
        errors = [r for r in self.streams['events.jsonl'].rows if any(w in str(r.get('event', '')).lower() for w in ('error', 'failed', 'abort', 'stop'))]
        history += ['', 'ERROR / STOP EVENTS (type only; private free text omitted)']
        history += [f'{clock(r.get("at"))} {r.get("event")}' for r in errors[-20:]] if errors else ['No recorded error events.']
        visible = ['PLAYER-VISIBLE CARDS', 'Own hand:'] + [self.name(c) for c in (actor.get('you') or {}).get('hand') or []]
        for owner in ('you', 'opponent'):
            visible += ['', owner.upper() + ' public discard:'] + [self.name(c) for c in (actor.get(owner) or {}).get('discard') or []]
        overview = lines + state[:5] + [''] + board + terminal_lines
        return {'Overview': overview, 'Offers': lines[:1] + offers + ['', 'LAST CHOICE OFFER SNAPSHOT'] + [self.action(a) for a in (proposal.get('offered') or {}).get('actions') or []] + self.prompt_lines((proposal.get('offered') or {}).get('prompt')), 'Driver': lines + state + [''] + timing + [''] + terminal_lines, 'Masks': lines[:1] + uncertainty, 'History': history, 'Cards': visible}, freshness

    def prompt_lines(self, prompt):
        if not isinstance(prompt, dict):
            return ['', 'Prompt: none observed']
        lines = ['', f'Prompt: {val(prompt.get("kind"))} | min {val(prompt.get("min"))} max {val(prompt.get("max"))}']
        for group in [prompt] + (prompt.get('groups') or []):
            for i, choice in enumerate(group.get('choices') or []):
                # Prize slots remain opaque even if a future log accidentally includes faces.
                label = f'opaque prize slot {i+1}' if prompt.get('kind') == 'prizes' else (choice.get('name') or choice.get('label') or choice.get('id', '?'))
                lines.append(f'  {group.get("id", "choice")}/{i+1}: {label}')
        return lines
