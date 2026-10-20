"""Local Windows overlay; reads journals only, never contacts the game."""
import argparse
import ctypes as C
from ctypes import wintypes as W
import json
import os
from pathlib import Path
import queue
import threading
import time
import tkinter as tk

from reader import Reader

U = C.WinDLL('user32', use_last_error=True)
U.GetForegroundWindow.restype = W.HWND
U.GetParent.argtypes, U.GetParent.restype = [W.HWND], W.HWND
U.GetWindowLongPtrW.argtypes, U.GetWindowLongPtrW.restype = [W.HWND, C.c_int], C.c_ssize_t
U.SetWindowLongPtrW.argtypes, U.SetWindowLongPtrW.restype = [W.HWND, C.c_int, C.c_ssize_t], C.c_ssize_t
U.SetWindowPos.argtypes = [W.HWND, W.HWND, C.c_int, C.c_int, C.c_int, C.c_int, W.UINT]
U.ShowWindow.argtypes = [W.HWND, C.c_int]
U.IsWindowVisible.argtypes = [W.HWND]
U.GetWindowRect.argtypes = [W.HWND, C.POINTER(W.RECT)]
U.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
U.CallWindowProcW.argtypes = [C.c_void_p, W.HWND, W.UINT, W.WPARAM, W.LPARAM]
U.CallWindowProcW.restype = C.c_ssize_t
WNDPROC = C.WINFUNCTYPE(C.c_ssize_t, W.HWND, W.UINT, W.WPARAM, W.LPARAM)
NOACTIVATE, TOOLWINDOW, TRANSPARENT, LAYERED = 0x08000000, 0x80, 0x20, 0x80000


def native_handle(window):
    child = window.winfo_id()
    return U.GetParent(child) or child


def position_target():
    """Read window geometry only. No focus/input, process attachment, or capture."""
    found = []
    callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def callback(hwnd, _):
        if U.IsWindowVisible(hwnd):
            title = C.create_unicode_buffer(512)
            U.GetWindowTextW(hwnd, title, 512)
            title_text = title.value.lower()
            if ('pok' in title_text and 'mon' in title_text and ('live' in title_text or 'trading card' in title_text)) and 'diagnostic' not in title_text:
                rect = W.RECT()
                U.GetWindowRect(hwnd, C.byref(rect))
                if rect.right - rect.left > 400:
                    found.append((hwnd, (rect.left, rect.top, rect.right, rect.bottom)))
        return True
    U.EnumWindows(callback_type(callback), 0)
    return found[0] if found else (None, None)


class Overlay:
    def __init__(self, args):
        self.args = args
        self.cache = Path(args.runtime_dir)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.before_focus = int(U.GetForegroundWindow() or 0)
        self.client, bounds = position_target()
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title('TCG diagnostic controls')
        self.root.overrideredirect(True)
        self.body = tk.Toplevel(self.root)
        self.body.withdraw()
        self.body.title('TCG diagnostic display')
        self.body.overrideredirect(True)
        self.root.configure(bg='#22354a')
        self.body.configure(bg='#101923')
        self.body.attributes('-alpha', 0.96)
        self.root.attributes('-topmost', True)
        self.body.attributes('-topmost', True)
        self.page = 'Overview'
        self.pages, self.mode, self.hidden = {}, False, False
        self.width, self.height = args.width, args.height
        if bounds:
            self.x, self.y = bounds[2] - self.width - 12, bounds[1] + 48
            self.height = min(self.height, max(280, bounds[3] - self.y - 90))
        else:
            self.x, self.y = self.root.winfo_screenwidth() - self.width - 12, 48
        if args.x is not None:
            self.x = args.x
        if args.y is not None:
            self.y = args.y
        self.callbacks = []
        self.controls()
        self.text = tk.Text(self.body, bg='#101923', fg='#edf3fa', font=('Consolas', 10), wrap='word', borderwidth=0,
                            padx=12, pady=8, insertwidth=0, takefocus=0, selectbackground='#456080', cursor='arrow')
        self.text.pack(fill='both', expand=True)
        self.text.configure(state='disabled')
        self.text.tag_configure('heading', foreground='#80c7ff', font=('Consolas', 10, 'bold'))
        self.text.tag_configure('warning', foreground='#ffd38a')
        self.root.update_idletasks()
        self.root_handle, self.body_handle = native_handle(self.root), native_handle(self.body)
        for hwnd in (self.root_handle, self.body_handle):
            self.style(hwnd, hwnd == self.body_handle)
            old = U.GetWindowLongPtrW(hwnd, -4)
            def proc(h, msg, wp, lp, previous=old):
                if msg == 0x21:  # WM_MOUSEACTIVATE: never activate on click
                    return 3
                return U.CallWindowProcW(previous, h, msg, wp, lp)
            callback = WNDPROC(proc)
            self.callbacks.append(callback)
            U.SetWindowLongPtrW(hwnd, -4, C.cast(callback, C.c_void_p).value)
        self.layout()
        self.root.deiconify()
        self.body.deiconify()
        self.layout()
        self.reader = Reader(args.latest)
        self.messages, self.stop = queue.Queue(maxsize=1), threading.Event()
        threading.Thread(target=self.read_loop, daemon=True).start()
        self.root.after(200, self.tick)
        self.root.after(1200, self.receipt)
        if args.capture:
            self.root.after(2200, self.capture)
        if args.capture_pages:
            for i, page in enumerate(('Offers', 'Driver', 'Masks', 'History', 'Cards', 'Overview')):
                self.root.after(3000 + i * 500, lambda p=page: self.capture_page(p))
        self.root.protocol('WM_DELETE_WINDOW', self.close)

    def style(self, hwnd, passive):
        styles = U.GetWindowLongPtrW(hwnd, -20) | NOACTIVATE | TOOLWINDOW
        styles = styles | LAYERED | TRANSPARENT if passive else styles & ~TRANSPARENT
        U.SetWindowLongPtrW(hwnd, -20, styles)

    def controls(self):
        top = tk.Frame(self.root, bg='#22354a')
        top.pack(fill='x')
        self.title = tk.Label(top, text='TCG DIAGNOSTICS  •  drag to move', fg='#eef5ff', bg='#22354a', anchor='w', font=('Segoe UI', 9, 'bold'))
        self.title.pack(side='left', fill='x', expand=True)
        self.title.bind('<ButtonPress-1>', self.drag_start)
        self.title.bind('<B1-Motion>', self.drag)
        self.button(top, 'Close ×', self.close).pack(side='right')
        self.hide_button = self.button(top, 'Hide', self.hide)
        self.hide_button.pack(side='right')
        self.inspect_button = self.button(top, 'Inspect: off', self.inspect)
        self.inspect_button.pack(side='right')
        nav = tk.Frame(self.root, bg='#22354a')
        nav.pack(fill='x')
        for page in ('Overview', 'Offers', 'Driver', 'Masks', 'History', 'Cards'):
            self.button(nav, page, lambda p=page: self.select(p)).pack(side='left')
        self.button(nav, '▼', lambda: self.text.yview_scroll(12, 'units')).pack(side='right')
        self.button(nav, '▲', lambda: self.text.yview_scroll(-12, 'units')).pack(side='right')
        self.status = tk.Label(self.root, text='PASS THROUGH • body clicks go to underlying window', bg='#192939', fg='#b6c8dc', anchor='w', font=('Segoe UI', 9))
        self.status.pack(fill='x')
        self.grip = tk.Label(self.root, text='↔ resize', bg='#192939', fg='#b6c8dc', cursor='size_nw_se')
        self.grip.place(relx=1.0, rely=1.0, anchor='se')
        self.grip.bind('<ButtonPress-1>', self.resize_start)
        self.grip.bind('<B1-Motion>', self.resize)

    def button(self, parent, label, command):
        return tk.Button(parent, text=label, command=command, takefocus=0, bd=0, bg='#2c435c', fg='#eef5ff', activebackground='#436286', activeforeground='white', padx=7, pady=3, font=('Segoe UI', 9))

    def layout(self):
        self.root.geometry(f'{self.width}x82{self.x:+d}{self.y:+d}')
        self.body.geometry(f'{self.width}x{self.height}{self.x:+d}{self.y+82:+d}')
        self.root.update_idletasks()
        for hwnd, y, height in ((self.body_handle, self.y+82, self.height), (self.root_handle, self.y, 82)):
            U.SetWindowPos(hwnd, W.HWND(-1), self.x, y, self.width, height, 0x10)

    def drag_start(self, event):
        self.drag_origin = (event.x_root, event.y_root, self.x, self.y)

    def drag(self, event):
        sx, sy, x, y = self.drag_origin
        self.x, self.y = x + event.x_root - sx, y + event.y_root - sy
        self.layout()

    def resize_start(self, event):
        self.resize_origin = (event.x_root, event.y_root, self.width, self.height)

    def resize(self, event):
        sx, sy, width, height = self.resize_origin
        self.width = max(590, width + event.x_root - sx)
        self.height = max(220, height + event.y_root - sy)
        self.layout()

    def select(self, page):
        self.page = page
        self.render(reset=True)

    def inspect(self):
        self.mode = not self.mode
        self.style(self.body_handle, not self.mode)
        self.inspect_button.configure(text='Inspect: ON' if self.mode else 'Inspect: off')
        self.status.configure(text='INSPECT • mouse scroll enabled here • Close stays available' if self.mode else 'PASS THROUGH • body clicks go to underlying window')

    def hide(self):
        self.hidden = not self.hidden
        U.ShowWindow(self.body_handle, 0 if self.hidden else 4)
        self.hide_button.configure(text='Show' if self.hidden else 'Hide')

    def read_loop(self):
        while not self.stop.is_set():
            started = time.perf_counter()
            try:
                pages, freshness = self.reader.update()
                message = (pages, freshness, (time.perf_counter() - started) * 1000)
            except Exception as exc:
                # Exception text can contain private paths/runtime data; expose type only.
                message = ({'Overview': ['READER WAITING', type(exc).__name__, 'No invented live state. Check the local pointer/log access.']}, 'WAITING', 0)
            try:
                self.messages.put_nowait(message)
            except queue.Full:
                pass
            self.stop.wait(1)

    def tick(self):
        if (self.cache / 'close.request').exists():
            self.close()
            return
        try:
            self.pages, freshness, read_ms = self.messages.get_nowait()
            self.title.configure(text=f'TCG • {freshness} • drag here')
            self.read_ms = read_ms
            self.render()
        except queue.Empty:
            pass
        self.root.after(200, self.tick)

    def render(self, reset=False):
        lines = self.pages.get(self.page, ['Waiting for journal…'])
        scroll = self.text.yview()[0]
        self.text.configure(state='normal')
        self.text.delete('1.0', 'end')
        for line in [self.page.upper() + '  |  read-only  |  scroll ▲ ▼'] + lines:
            tag = 'heading' if line.isupper() or line.startswith(('LIVE LOG', 'LAST CHOICE', 'STALE')) else ('warning' if any(w in line for w in ('unavailable', 'unverified', 'unknown')) else '')
            self.text.insert('end', line + '\n', tag)
        self.text.configure(state='disabled')
        self.text.yview_moveto(0 if reset else scroll)

    def receipt(self):
        data = {'pid': os.getpid(), 'displayHwnd': int(self.body_handle), 'controlsHwnd': int(self.root_handle),
                'clientFound': bool(self.client), 'clientHwnd': int(self.client or 0),
                'foregroundBefore': self.before_focus, 'foregroundAfter': int(U.GetForegroundWindow() or 0),
                'displayExStyle': hex(U.GetWindowLongPtrW(self.body_handle, -20)),
                'controlsExStyle': hex(U.GetWindowLongPtrW(self.root_handle, -20)),
                'displayBounds': [self.x, self.y+82, self.width, self.height], 'readerMilliseconds': getattr(self, 'read_ms', None)}
        (self.cache / 'launch-receipt.json').write_text(json.dumps(data, indent=2))

    def capture(self):
        try:
            from PIL import ImageGrab
            # A private crop of our own rendered surface, no whole-desktop capture.
            ImageGrab.grab(bbox=(self.x, self.y, self.x+self.width, self.y+82+self.height), all_screens=True).save(self.cache / 'overlay-visible.png')
            (self.cache / 'visible-content.txt').write_text('\n'.join(self.pages.get(self.page, [])), encoding='utf-8')
        except Exception as exc:
            (self.cache / 'capture-status.txt').write_text(type(exc).__name__)

    def capture_page(self, page):
        self.select(page)
        self.root.update_idletasks()
        from PIL import ImageGrab
        ImageGrab.grab(bbox=(self.x, self.y, self.x+self.width, self.y+82+self.height), all_screens=True).save(self.cache / f'overlay-{page.lower()}.png')
        self.receipt()

    def close(self):
        self.stop.set()
        self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--latest', required=True, help='Read-only model5-live-latest.json pointer')
    parser.add_argument('--runtime-dir', default=str(Path(__file__).resolve().parents[2] / '.cache' / 'diagnostic-overlay'))
    parser.add_argument('--width', type=int, default=620)
    parser.add_argument('--height', type=int, default=760)
    parser.add_argument('--x', type=int)
    parser.add_argument('--y', type=int)
    parser.add_argument('--capture', action='store_true', help='Save one private visible overlay crop; requires installed Pillow')
    parser.add_argument('--capture-pages', action='store_true', help='Exercise all six overlay views, save private crops, and return to Overview')
    args = parser.parse_args()
    try:
        U.SetProcessDpiAwarenessContext(C.c_void_p(-4))
    except AttributeError:
        U.SetProcessDPIAware()
    overlay = Overlay(args)
    overlay.root.mainloop()


if __name__ == '__main__':
    main()
