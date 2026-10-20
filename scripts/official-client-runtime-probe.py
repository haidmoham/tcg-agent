"""One scoped runtime observation, optionally one explicit background Decks step."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--window', type=int, required=True)
    parser.add_argument('--frida-root', type=Path)
    parser.add_argument('--open-decks', action='store_true')
    parser.add_argument('--start-test-deck', action='store_true')
    args = parser.parse_args()
    command = [sys.executable, str(ROOT / 'scripts/official-client-runtime.py'), '--pid', str(args.pid),
               '--window', str(args.window), '--permit-scoped-adapter']
    if args.frida_root is not None:
        command.extend(['--frida-root', str(args.frida_root.resolve(strict=True))])
    if args.open_decks or args.start_test_deck:
        command.append('--permit-input-probe')
    if args.start_test_deck:
        command.append('--supervised-test-game')
    child = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
    records = []
    run_id = str(uuid.uuid4())
    def receive():
        line = child.stdout.readline(65536)
        if not line:
            raise ValueError('runtime-child-ended')
        value = json.loads(line)
        records.append(value)
        if value.get('ok') is False:
            raise ValueError('runtime-request-failed')
        return value
    def request(op, **values):
        child.stdin.write(json.dumps({'id': run_id + '-' + str(len(records)), 'op': op, **values}) + '\n')
        child.stdin.flush()
        return receive()
    try:
        ready = receive()
        before = request('observe')
        if args.start_test_deck:
            attempt = ROOT / '.cache/official-client-test-game-attempt.json'
            with attempt.open('x', encoding='utf-8') as handle:
                json.dump({'id': run_id, 'startedAt': time.time(), 'outcome': 'launch-pending', 'mode': 'provided-ai'}, handle)
            request_id = run_id + '-' + str(len(records))
            request('start_test_deck', expected=before['snapshotHash'], armed=True, step=request_id)
            time.sleep(3)
            after = request('observe')
            print(json.dumps({'testDeckLaunchSent': True, 'matchObserved': after['result'].get('match') is not None,
                              'gameAttempts': 1, 'driverResult': after['result']}), flush=True)
        if args.open_decks:
            request_id = run_id + '-' + str(len(records))
            request('open_decks', expected=before['snapshotHash'], armed=True, step=request_id)
            time.sleep(1)
            after = request('observe')
            if after['result'].get('screen', {}).get('code') != 1:
                raise ValueError('runtime-decks-transition-unverified-no-retry')
        request('close')
        child.wait(timeout=10)
        print(json.dumps({'ready': ready, 'observations': sum('result' in r and 'screen' in r['result'] for r in records),
                          'deckDisplayName': before['result'].get('selectedDeck', {}).get('displayName'),
                          'backgroundDecksVerified': args.open_decks, 'gameAttempts': int(args.start_test_deck)}), flush=True)
    finally:
        if child.poll() is None:
            child.stdin.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        folder = ROOT / '.cache' / ('runtime-probe-' + run_id)
        folder.mkdir(parents=True)
        (folder / 'private-observations.json').write_text(json.dumps(records, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
