"""Import retained official-client artifacts into private SQLite; never drive a client."""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
VERSION = 'official-client-history-import/2'
MODES = {'ai_test', 'ranked', 'casual_other', 'unknown'}
RECEIPTS = {'official-client-frozen-game/1', 'official-client-model3-game/1'}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


_NOW = object()


def utc(value=_NOW):
    if value is _NOW:
        return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    if type(value) not in (int, float) or value <= 0:
        return None
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def count(value):
    return value if type(value) is int and value >= 0 else None


def sha(value):
    return value if isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) else None


def connect(path):
    path = path.absolute()
    if '.cache' not in path.parts or path.suffix not in ('.sqlite3', '.db'):
        raise ValueError('history-private-cache-database-required')
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.resolve() != path:
        raise ValueError('history-database-symlink-not-admitted')
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=15000')
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    version = db.execute('PRAGMA user_version').fetchone()[0]
    if version not in (0, 1):
        raise ValueError('history-schema-version-not-supported')
    db.executescript((ROOT / 'integrations/official-client/history.sql').read_text(encoding='utf-8'))
    db.execute('PRAGMA user_version=1')
    db.execute('INSERT OR IGNORE INTO history_meta VALUES (?,?)', ('schema', 'official-client-history/1'))
    db.commit()
    return db


def collect(folder):
    folder = folder.resolve(strict=True)
    if folder.parent.name != '.cache' or not re.fullmatch(r'model[3456]-live-[a-f0-9-]{36}', folder.name):
        raise ValueError('history-owned-client-run-folder-required')
    names = ['receipt.json', 'launch-intent.json', 'history-run.json', 'mode-declaration.json', 'mode-evidence.jsonl',
             'events.jsonl', 'private-observations.jsonl', 'private-policy-decisions.jsonl', 'private-selected-deck.json',
             'timing-sessions.jsonl', 'diagnostic-abort.json']
    files = [folder / name for name in names if (folder / name).is_file()]
    files += list(folder.glob('private-decisions-*.jsonl'))
    files += list(folder.glob('private-battle-log-latest-*.json'))
    files += list(folder.glob('private-battle-log-*/exports.jsonl'))
    artifacts, data, warnings = [], {}, []
    for path in sorted(files):
        if not path.resolve().is_relative_to(folder) or path.stat().st_size > 128 * 1024 * 1024:
            raise ValueError('history-artifact-path-or-budget')
        raw = path.read_bytes()
        name = path.relative_to(folder).as_posix()
        lines = raw.decode('utf-8-sig').splitlines()
        values = []
        if name.endswith('.jsonl'):
            for number, line in enumerate(lines, 1):
                if not line.strip():
                    continue
                try:
                    values.append((number, json.loads(line), digest(line)))
                except json.JSONDecodeError:
                    if number == len(lines) and not raw.endswith(b'\n'):
                        warnings.append('partial-trailing-line:' + name)
                    else:
                        raise ValueError('history-malformed-artifact:' + name) from None
            data[name] = values
        else:
            data[name] = json.loads(raw.decode('utf-8-sig'))
        artifacts.append({'name': name, 'path': str(path), 'sha256': digest(raw), 'bytes': len(raw),
                          'lines': len(values) if name.endswith('.jsonl') else None, 'text_lines': lines})
    return folder, artifacts, data, warnings


def prepare(folder):
    folder, artifacts, data, warnings = collect(folder)
    receipt = data.get('receipt.json', {})
    run = data.get('history-run.json', {})
    if receipt and receipt.get('schema') not in RECEIPTS:
        raise ValueError('history-official-client-receipt-required')
    if not receipt and run.get('schema') != 'official-client-history-run/1':
        raise ValueError('history-official-client-run-evidence-required')
    launch = data.get('launch-intent.json', {})
    game_id = receipt.get('id') or run.get('id')
    if not isinstance(game_id, str) or not re.fullmatch('[a-f0-9-]{36}', game_id) or folder.name.split('-live-')[-1] != game_id:
        raise ValueError('history-game-identity-invalid')
    if any(value.get('id', game_id) != game_id for value in (run, launch)):
        raise ValueError('history-game-identity-conflict')
    events = [value for _, value, _ in data.get('events.jsonl', [])]
    observations = [value for _, value, _ in data.get('private-observations.jsonl', [])]
    mode_evidence = []
    declaration = data.get('mode-declaration.json')
    if declaration:
        if declaration.get('schema') != 'official-client-mode-declaration/1' or declaration.get('mode') not in MODES:
            raise ValueError('history-mode-declaration-invalid')
        mode_evidence.append({'mode': declaration['mode'], 'source': declaration.get('source', 'unknown'),
                              'at': declaration.get('at'), 'kind': 'declared'})
    if launch.get('mode') == 'provided-ai':
        mode_evidence.append({'mode': 'ai_test', 'source': 'launch-intent:provided-ai', 'at': launch.get('launchedAt'), 'kind': 'declared'})
    for _, evidence, _ in data.get('mode-evidence.jsonl', []):
        if evidence.get('schema') != 'official-client-mode-evidence/1' or evidence.get('mode') not in MODES:
            raise ValueError('history-observed-mode-invalid')
        mode_evidence.append({key: evidence.get(key) for key in ('mode', 'source', 'at', 'kind')})
    offline = {obs['result']['match']['offline'] for obs in observations if isinstance(obs.get('result', {}).get('match'), dict) and type(obs['result']['match'].get('offline')) is bool}
    if True in offline:
        mode_evidence.append({'mode': 'ai_test', 'source': 'runtime-ui:offline=true', 'kind': 'observed'})
    if False in offline:
        mode_evidence.append({'mode': 'unknown', 'source': 'runtime-ui:offline=false; queue not established', 'kind': 'observed'})
    known_modes = {value['mode'] for value in mode_evidence} - {'unknown'}
    conflict = len(known_modes) > 1 or ('ai_test' in known_modes and False in offline)
    mode = next(iter(known_modes)) if len(known_modes) == 1 and not conflict else 'unknown'
    finished = [event for event in events if event.get('event') == 'game-finished']
    pauses = [event for event in events if event.get('event') == 'paused']
    resumes = [event for event in events if event.get('event') == 'same-ai-game-resumed']
    sessions, decisions, attribution_counts, terminal, pins = [], [], Counter(), None, {}
    latest_pin_at, latest_terminal_at = -1, -1
    for artifact in artifacts:
        name = artifact['name']
        if not name.startswith('private-decisions-'):
            continue
        rows = data[name]
        previous = None
        sequence = 0
        results = {event.get('decisionId'): event for _, event, _ in rows if event.get('event') == 'execution-result'}
        for line, event, line_sha in rows:
            if event.get('schema') != 'official-client-decision-event/1' or event.get('gameId') != game_id:
                raise ValueError('history-decision-journal-identity')
            claimed = event.get('recordSha256')
            # JS insertion order is retained by Python's decoder. JS escapes no
            # ASCII punctuation; numeric payloads must use their original lexemes.
            record_text = artifact['text_lines'][line - 1]
            suffix = ',"recordSha256":"' + str(claimed) + '"}'
            if not record_text.endswith(suffix) or digest(record_text[:-len(suffix)] + '}') != claimed or event.get('previousRecordSha256') != previous or event.get('sequence') != sequence + 1:
                raise ValueError('history-decision-journal-chain-invalid')
            previous, sequence = claimed, sequence + 1
            if event.get('event') == 'session':
                sessions.append((event['sessionId'], event.get('pins', {})))
                if event['at'] >= latest_pin_at:
                    pins, latest_pin_at = event.get('pins', {}), event['at']
            elif event.get('event') == 'terminal':
                if event['at'] >= latest_terminal_at:
                    terminal, latest_terminal_at = event, event['at']
            elif event.get('event') == 'proposal':
                attribution = event.get('attribution', {})
                result = results.get(event['decisionId'], {})
                decisions.append({'id': event['decisionId'], 'session': event['sessionId'], 'kind': event['kind'],
                    'actor': attribution.get('kind', 'unknown'), 'policy': attribution.get('id'), 'at': utc(event.get('at')),
                    'pre': event.get('preObservationId'), 'selected': {'decision': event['decision'], 'resolvedDecision': event['resolvedDecision']},
                    'execution': result.get('status', 'unknown'), 'verified': False, 'name': name, 'line': line, 'sha': line_sha})
                attribution_counts[(attribution.get('id', 'unknown'), attribution.get('kind', 'unknown'))] += 1
    if not sessions:
        for line, event, line_sha in data.get('events.jsonl', []):
            if event.get('event') != 'proposed':
                continue
            policy = event.get('policy', 'unknown')
            kind = 'selection' if 'selection' in policy else 'driver' if policy == 'client-driver' else 'ordinary' if policy.startswith(('model3-', 'model4-')) else 'helper'
            actor = 'model' if kind in ('ordinary', 'selection') else kind
            decisions.append({'id': 'legacy-event:' + str(line), 'session': None, 'kind': kind, 'actor': actor, 'policy': policy,
                'at': utc(event.get('at')), 'pre': None, 'selected': None, 'execution': 'unknown', 'verified': False,
                'name': 'events.jsonl', 'line': line, 'sha': line_sha})
            attribution_counts[(policy, actor)] += 1
    model_ready = next((event for event in events if event.get('event') == 'model-ready'), {})
    checkpoint_evidence = {value for value in [sha(receipt.get('checkpointSha256')), sha(pins.get('ordinaryCheckpointSha256')), sha(run.get('checkpointSha256'))]
                           + [sha(event.get('checkpointSha256')) for event in events if event.get('event') == 'model-ready']
                           + [sha(value.get('ordinaryCheckpointSha256')) for _, value in sessions] if value}
    checkpoint_conflict = len(checkpoint_evidence) > 1
    checkpoint = next(iter(checkpoint_evidence)) if len(checkpoint_evidence) == 1 else None
    natural = bool(finished) and receipt.get('outcome') == 'completed'
    winner = finished[-1].get('winner') if finished else None
    outcome = {'you': 'win', 'opponent': 'loss', 'draw': 'draw'}.get(winner, 'unknown') if natural else 'unknown'
    outcome_conflict = natural and (len({event.get('winner') for event in finished}) > 1 or receipt.get('winner') != winner)
    if outcome_conflict:
        outcome = 'unknown'
    failure = receipt.get('failure')
    rejections = count(receipt.get('rejectedActions'))
    interruptions = max(len(pauses), len(resumes), max(0, len(data.get('timing-sessions.jsonl', [])) - 1))
    driver_failure = bool(failure and failure not in ('user-paused', 'operator-interrupted')) or bool(rejections) or bool(receipt.get('cleanupErrors'))
    quality = 'failed' if driver_failure else 'interrupted' if interruptions else 'clean' if natural and rejections == 0 and receipt.get('inputStopped') is True else 'unknown'
    status = 'completed' if natural else 'driver_failed' if driver_failure else 'aborted' if pauses or receipt.get('inputStopped') is True else 'running' if observations else 'declared' if run or launch else 'unknown'
    end_ms = finished[-1].get('at') if natural else receipt.get('timing', {}).get('sessionEndedAt') or (events[-1].get('at') if receipt else None)
    stopped_at = max([value for value in [receipt.get('timing', {}).get('sessionEndedAt')]
                     + [event.get('at') for event in events if event.get('event') in ('paused', 'detached-and-paused')] if type(value) is int] or [0])
    latest_live_at = max([obs.get('at', 0) for obs in observations if isinstance(obs.get('result', {}).get('match'), dict)
                          and obs['result']['match'].get('gameOver') is False] or [0])
    if not natural and latest_live_at > stopped_at:
        status, end_ms = 'running', None
    evidence_ms = max([value for value in [end_ms, launch.get('launchedAt'), run.get('at')] + [event.get('at') for event in events] if type(value) is int] or [0])
    reason = (terminal or {}).get('evidence', {}).get('finalReason')
    reason = {key: reason.get(key) for key in ('schema', 'source', 'status', 'terminalObserved', 'observedAt', 'localWon', 'reasonLocId', 'text')} if isinstance(reason, dict) and reason.get('status') == 'observed' and reason.get('terminalObserved') is True and reason.get('source') == 'BattleOutro.ShowMatchResultOverlay' else None
    deck = data.get('private-selected-deck.json', {}).get('exactCards')
    if conflict:
        warnings.append('conflicting-mode-evidence; no ranked or AI performance admission')
    if checkpoint_conflict or outcome_conflict:
        quality = 'unknown'
        warnings.append('conflicting-checkpoint-evidence' if checkpoint_conflict else 'conflicting-outcome-evidence')
    if not sessions:
        warnings.append('legacy logs lack linked selection/helper payloads and complete version pins')
    if not reason:
        warnings.append('terminal reason not observed')
    turns = [count(obs.get('result', {}).get('match', {}).get('turnNumber')) for obs in observations if isinstance(obs.get('result', {}).get('match'), dict)]
    launches = count(receipt.get('gameLaunches'))
    if launches is None and any(event.get('event') == 'ai-game-launch-sent' for event in events):
        launches = 1
    game = {'game_id': game_id, 'started_utc': utc(launch.get('launchedAt')), 'ended_utc': utc(end_ms),
        'end_source': 'game-finished-event' if natural else 'controller-stop' if end_ms else None,
        'mode': mode, 'mode_conflict': int(conflict), 'mode_evidence_json': encoded(mode_evidence),
        'account_alias': None, 'perspective': 'local_player', 'deck_composition_sha256': digest(encoded(deck)) if deck else None,
        'mechanics_profile_sha256': sha(pins.get('deckBundleSha256')),
        'candidate': receipt.get('candidate') or run.get('candidate') or ('model3' if receipt.get('schema') == 'official-client-model3-game/1' else None),
        'checkpoint_sha256': checkpoint, 'feature_schema': pins.get('featureContract', {}).get('schema') or run.get('featureSchema'),
        'helper_sha256': sha(pins.get('helperSha256')), 'status': status, 'outcome': outcome,
        'outcome_source': 'game-finished-event+completed-receipt' if natural else None,
        'terminal_reason_json': encoded(reason) if reason else None, 'driver_quality': quality,
        'clean_outcome': int(natural and outcome != 'unknown' and quality == 'clean' and not conflict and not any('partial-trailing' in item for item in warnings)),
        'elapsed_seconds': receipt.get('elapsedSeconds') if type(receipt.get('elapsedSeconds')) in (int, float) else None,
        'turn_count': max((value for value in turns if value is not None), default=None),
        'ordinary_decisions': count(receipt.get('ordinaryDecisions')), 'selection_decisions': count(receipt.get('selectionDecisions')),
        'helper_decisions': count(receipt.get('helperDecisions')), 'driver_rejections': rejections, 'interruptions': interruptions,
        'launches': launches,
        'recording_coverage': 'linked' if sessions else 'legacy_partial' if events else 'unknown', 'uncertainty_json': encoded(warnings),
        'evidence_at_ms': evidence_ms}
    import_id = digest(encoded({'version': VERSION, 'game': game_id, 'artifacts': [(a['name'], a['sha256']) for a in artifacts]}))
    game['current_import_id'] = import_id
    return game, artifacts, sessions, decisions, attribution_counts


def import_run(db, folder):
    game, artifacts, sessions, decisions, attributions = prepare(folder)
    identity, import_id = game['game_id'], game['current_import_id']
    with db:
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT * FROM games WHERE game_id=?', (identity,)).fetchone()
        if previous and previous['started_utc'] and game['started_utc'] and previous['started_utc'] != game['started_utc']:
            prior_launch = db.execute('SELECT 1 FROM import_artifacts i JOIN artifacts a USING(artifact_id) '
                'WHERE i.import_id=? AND a.relative_name=?', (previous['current_import_id'], 'launch-intent.json')).fetchone()
            # Version 1 rendered missing timestamps as import time. Correct only
            # a preparation snapshot with no launch evidence; keep old imports.
            if prior_launch or previous['status'] != 'declared' or previous['launches'] not in (None, 0):
                raise ValueError('history-stable-game-start-conflict')
        if previous:
            # A copied or older snapshot must never erase contradictory mode
            # evidence or an interruption already retained for this game.
            evidence = {encoded(item): item for item in json.loads(previous['mode_evidence_json']) + json.loads(game['mode_evidence_json'])}
            game['mode_evidence_json'] = encoded(list(evidence.values()))
            known = {item['mode'] for item in evidence.values()} - {'unknown'}
            conflict = bool(previous['mode_conflict'] or game['mode_conflict'] or len(known) > 1)
            game['mode_conflict'] = int(conflict)
            game['mode'] = next(iter(known)) if len(known) == 1 and not conflict else 'unknown'
            game['interruptions'] = max(previous['interruptions'], game['interruptions'])
            rejections = [value for value in (previous['driver_rejections'], game['driver_rejections']) if value is not None]
            game['driver_rejections'] = max(rejections, default=None)
            warnings = list(dict.fromkeys(json.loads(previous['uncertainty_json']) + json.loads(game['uncertainty_json'])))
            if previous['driver_quality'] == 'failed' or game['driver_quality'] == 'failed':
                game['driver_quality'] = 'failed'
            elif game['interruptions']:
                game['driver_quality'] = 'interrupted'
            if previous['checkpoint_sha256'] and game['checkpoint_sha256'] and previous['checkpoint_sha256'] != game['checkpoint_sha256']:
                warnings.append('conflicting-checkpoint-evidence')
            if previous['outcome'] != 'unknown' and game['outcome'] != 'unknown' and previous['outcome'] != game['outcome']:
                warnings.append('conflicting-outcome-evidence')
            if 'conflicting-checkpoint-evidence' in warnings:
                game['checkpoint_sha256'], game['driver_quality'] = None, 'unknown'
            if 'conflicting-outcome-evidence' in warnings:
                game['outcome'], game['driver_quality'] = 'unknown', 'unknown'
            game['uncertainty_json'] = encoded(list(dict.fromkeys(warnings)))
            if conflict or game['driver_quality'] != 'clean' or game['outcome'] == 'unknown':
                game['clean_outcome'] = 0
        columns = list(game)
        if not previous:
            db.execute('INSERT INTO games (' + ','.join(columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')', [game[key] for key in columns])
        current = not previous or (game['evidence_at_ms'] >= previous['evidence_at_ms'] and not (previous['status'] == 'completed' and game['status'] != 'completed'))
        if previous and current:
            db.execute('UPDATE games SET ' + ','.join(key + '=?' for key in columns if key != 'game_id') + ' WHERE game_id=?', [game[key] for key in columns if key != 'game_id'] + [identity])
        elif previous:
            db.execute('UPDATE games SET mode=?,mode_conflict=?,mode_evidence_json=?,clean_outcome=CASE WHEN ? THEN 0 ELSE clean_outcome END WHERE game_id=?',
                       (game['mode'], game['mode_conflict'], game['mode_evidence_json'], game['mode_conflict'], identity))
        inserted = db.execute('INSERT OR IGNORE INTO imports VALUES (?,?,?,?,?,?)',
            (import_id, identity, utc(), VERSION, game['evidence_at_ms'], encoded(game))).rowcount
        artifact_ids = {}
        for artifact in artifacts:
            artifact_id = digest(encoded([identity, artifact['name'], artifact['sha256']]))
            artifact_ids[artifact['name']] = artifact_id
            db.execute('INSERT OR IGNORE INTO artifacts VALUES (?,?,?,?,?,?)',
                (artifact_id, identity, artifact['name'], artifact['sha256'], artifact['bytes'], artifact['lines']))
            db.execute('INSERT OR IGNORE INTO artifact_locations VALUES (?,?)', (artifact_id, artifact['path']))
            db.execute('INSERT OR IGNORE INTO import_artifacts VALUES (?,?)', (import_id, artifact_id))
        for session_id, pins in sessions:
            previous_pins = db.execute('SELECT pins_json FROM sessions WHERE game_id=? AND session_id=?', (identity, session_id)).fetchone()
            if previous_pins and previous_pins[0] != encoded(pins):
                raise ValueError('history-session-pins-changed')
            db.execute('INSERT OR IGNORE INTO sessions VALUES (?,?,?)', (identity, session_id, encoded(pins)))
        if current:
            for decision in decisions:
                prior = db.execute('SELECT record_sha256 FROM decisions WHERE game_id=? AND decision_id=?', (identity, decision['id'])).fetchone()
                if prior and prior[0] != decision['sha']:
                    raise ValueError('history-decision-identity-changed')
                db.execute('INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(game_id,decision_id) DO UPDATE SET execution_status=excluded.execution_status,artifact_id=excluded.artifact_id,record_sha256=excluded.record_sha256',
                    (identity, decision['id'], decision['session'], decision['kind'], decision['actor'], decision['policy'], decision['at'], decision['pre'],
                     encoded(decision['selected']) if decision['selected'] is not None else None, decision['execution'], 0, 0,
                     artifact_ids[decision['name']], decision['line'], decision['sha']))
            db.execute('DELETE FROM attributions WHERE game_id=?', (identity,))
            db.executemany('INSERT INTO attributions VALUES (?,?,?,?,?)',
                [(identity, policy, actor, amount, game['recording_coverage']) for (policy, actor), amount in attributions.items()])
    return {'gameId': identity, 'mode': game['mode'], 'status': game['status'], 'outcome': game['outcome'], 'newSnapshot': bool(inserted)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=ROOT / '.cache/client-history/games.sqlite3')
    commands = parser.add_subparsers(dest='command', required=True)
    ingest = commands.add_parser('import')
    ingest.add_argument('folders', type=Path, nargs='+')
    commands.add_parser('summary')
    listing = commands.add_parser('list')
    listing.add_argument('--mode', choices=sorted(MODES))
    listing.add_argument('--checkpoint')
    listing.add_argument('--clean', action='store_true')
    args = parser.parse_args()
    with closing(connect(args.db)) as db:
        if args.command == 'import':
            result = [import_run(db, folder) for folder in args.folders]
        elif args.command == 'summary':
            result = {'schema': 'official-client-history/1', 'schemaVersion': db.execute('PRAGMA user_version').fetchone()[0], 'sqlite': sqlite3.sqlite_version,
                'games': db.execute('SELECT count(*) FROM games').fetchone()[0],
                'byMode': {mode: db.execute('SELECT count(*) FROM games WHERE mode=?', (mode,)).fetchone()[0] for mode in sorted(MODES)},
                'byModeStatus': [dict(row) for row in db.execute('SELECT mode,status,driver_quality,count(*) AS games FROM games GROUP BY mode,status,driver_quality ORDER BY mode,status,driver_quality')],
                'cleanResultsByMode': [dict(row) for row in db.execute('SELECT mode,outcome,count(*) AS games FROM clean_policy_results GROUP BY mode,outcome ORDER BY mode,outcome')],
                'imports': db.execute('SELECT count(*) FROM imports').fetchone()[0], 'decisions': db.execute('SELECT count(*) FROM decisions').fetchone()[0],
                'foreignKeysEnabled': bool(db.execute('PRAGMA foreign_keys').fetchone()[0]),
                'foreignKeyViolations': len(db.execute('PRAGMA foreign_key_check').fetchall()), 'integrity': db.execute('PRAGMA quick_check').fetchone()[0],
                'nonzeroTrainingEligibility': db.execute('SELECT count(*) FROM decisions WHERE training_eligible<>0').fetchone()[0],
                'invalidCleanOutcomes': db.execute("SELECT count(*) FROM games WHERE clean_outcome=1 AND (status<>'completed' OR outcome='unknown' OR driver_quality<>'clean' OR mode_conflict<>0)").fetchone()[0]}
        else:
            where, values = ['1=1'], []
            for column, value in [('mode', args.mode), ('checkpoint_sha256', args.checkpoint)]:
                if value:
                    where.append(column + '=?'); values.append(value)
            if args.clean:
                where.append('clean_outcome=1')
            result = [dict(row) for row in db.execute('SELECT game_id,started_utc,ended_utc,mode,candidate,checkpoint_sha256,status,outcome,driver_quality,clean_outcome,recording_coverage FROM games WHERE ' + ' AND '.join(where) + ' ORDER BY started_utc', values)]
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
