"""Bounded, explicitly permitted Mono UI bridge. No auth or raw-match reads."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import queue
import re
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--frida-root', type=Path, help='Optional explicit directory containing an already installed frida package')
    parser.add_argument('--window', type=int, required=True)
    parser.add_argument('--permit-scoped-adapter', action='store_true', required=True)
    parser.add_argument('--permit-input-probe', action='store_true')
    parser.add_argument('--supervised-test-game', action='store_true')
    parser.add_argument('--resume-owned-test-game', action='store_true')
    parser.add_argument('--battle-log-output', type=Path)
    args = parser.parse_args()
    log_output = None
    if args.battle_log_output:
        log_output = args.battle_log_output.resolve()
        if not log_output.is_relative_to((ROOT / '.cache').resolve()) or log_output.suffix != '.json' or not log_output.parent.is_dir():
            raise ValueError('runtime-private-battle-log-output-required')
    def save_battle_log(value):
        if not log_output or value.get('schema') != 'official-client-battle-log-export/1' or not isinstance(value.get('matchIdentity'), str):
            raise ValueError('runtime-private-battle-log-output-required')
        export = {key: value[key] for key in ('schema', 'source', 'observedAt', 'text')}
        export['matchIdSha256'] = hashlib.sha256(value['matchIdentity'].encode()).hexdigest()
        if len(export['text'].encode()) > 1024 * 1024:
            raise ValueError('runtime-battle-log-budget')
        with tempfile.NamedTemporaryFile(mode='w', dir=log_output.parent, suffix='.json', encoding='utf-8', delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(export, handle, ensure_ascii=False)
        temporary.replace(log_output)
        return {'schema': 'official-client-battle-log-written/1', 'observedAt': export['observedAt'],
                'textSha256': hashlib.sha256(export['text'].encode()).hexdigest(), 'rawTextIncluded': False}
    if args.resume_owned_test_game:
        attempt = json.loads((ROOT / '.cache/official-client-test-game-attempt.json').read_text(encoding='utf-8'))
        if not args.supervised_test_game or attempt.get('mode') != 'provided-ai' or time.time() - attempt.get('startedAt', 0) > 3600:
            raise ValueError('runtime-owned-game-receipt-required')
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsIconic.argtypes = [wintypes.HWND]
    user.GetForegroundWindow.restype = wintypes.HWND
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    def check(action=False):
        for name in ('official-client.kill', 'official-client-runtime.kill'):
            if (ROOT / '.cache' / name).exists():
                raise ValueError('runtime-killed')
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(args.window, ctypes.byref(owner))
        if owner.value != args.pid or not user.IsWindowVisible(args.window) or user.IsIconic(args.window):
            raise ValueError('runtime-window-identity-or-visibility')
        handle = kernel.OpenProcess(0x1000, False, args.pid)
        if not handle:
            raise ValueError('runtime-process-unavailable')
        try:
            value = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(value))
            if not kernel.QueryFullProcessImageNameW(handle, 0, value, ctypes.byref(length)) or Path(value.value).name != 'Pokemon TCG Live.exe':
                raise ValueError('runtime-process-identity')
        finally:
            kernel.CloseHandle(handle)
        if action and (not args.permit_input_probe or user.GetForegroundWindow() == args.window
                       or (ROOT / '.cache/official-client-input.kill').exists()):
            raise ValueError('runtime-input-paused-or-client-foreground')
    check()
    if args.frida_root is not None:
        sys.path.insert(0, str(args.frida_root.resolve(strict=True)))
    import frida
    session = None
    script = None
    stage = 'attach'
    try:
        session = frida.attach(args.pid)
        stage = 'load-scoped-agent'
        script = session.create_script((ROOT / 'integrations/official-client/runtime-agent.js').read_text(encoding='utf-8'))
        script.load()
        stage = 'ready'
        emit(script.exports_sync.ready(args.window, args.supervised_test_game, args.resume_owned_test_game))
        last = None
        last_hash = None
        count = 0
        lines = queue.Queue(maxsize=32)
        def read_lines():
            for line in sys.stdin:
                lines.put(line)
            lines.put(None)
        threading.Thread(target=read_lines, daemon=True).start()
        deadline = time.monotonic() + (900 if args.supervised_test_game else 120)
        while True:
            try:
                line = lines.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise ValueError('runtime-session-timeout')
            if line is None:
                break
            if time.monotonic() > deadline:
                raise ValueError('runtime-session-timeout')
            if len(line) > 8192 or count >= (500 if args.supervised_test_game else 30):
                raise ValueError('runtime-request-budget')
            request = json.loads(line)
            request_id = request.get('id')
            op = request.get('op')
            if op == 'close':
                emit({'id': request_id, 'ok': True, 'closed': True})
                break
            admitted = ('observe', 'battle_log', 'open_decks', 'start_test_deck', 'act', 'answer_text', 'answer_entities') if args.supervised_test_game else ('observe', 'battle_log', 'open_decks')
            if op not in admitted or set(request) - {'id', 'op', 'expected', 'armed', 'step', 'data'}:
                raise ValueError('runtime-request-not-admitted')
            if op == 'battle_log' and not log_output:
                raise ValueError('runtime-private-battle-log-output-required')
            action = op not in ('observe', 'battle_log')
            check(action)
            if action and (request.get('armed') is not True or request.get('step') != request_id
                           or not last_hash or request.get('expected') != last_hash):
                raise ValueError('runtime-explicit-arm-step-required')
            count += 1
            stage = op
            expected = json.dumps(last, separators=(',', ':'), ensure_ascii=False) if action else None
            result = script.exports_sync.request(op, request_id, expected, request.get('data'))
            check()
            if op == 'battle_log':
                result = save_battle_log(result)
            elif not action:
                last = result
                last_hash = hashlib.sha256(json.dumps(result, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
            else:
                last = None
                last_hash = None
            if op == 'observe' and log_output:
                save_battle_log(script.exports_sync.request('battle_log', str(request_id) + '-log', None, None))
            emit({'id': request_id, 'ok': True, 'snapshotHash': last_hash, 'result': result})
    except Exception as error:
        # Never include arbitrary foreign exception messages or raw client objects.
        code = str(error) if isinstance(error, ValueError) and str(error).startswith('runtime-') else type(error).__name__
        if type(error).__name__ == 'RPCException':
            safe = re.search(r'(required-[a-z-]+(?::[A-Za-z_]+)?|ui-[a-z-]+|managed-call-rejected|ambiguous-[a-z-]+|runtime-[a-z-]+)', str(error))
            if safe:
                code = safe.group(0)
        emit({'ok': False, 'stage': stage, 'error': code, 'clientOutcome': 'unverified' if stage in ('open_decks', 'start_test_deck', 'act') else 'no-action-requested'})
        return 2
    finally:
        if script is not None:
            try:
                script.exports_sync.close()
            except Exception:
                pass
            script.unload()
        if session is not None:
            session.detach()
    return 0

if __name__ == '__main__':
    sys.exit(main())
