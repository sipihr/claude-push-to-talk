#!/usr/bin/env python3
"""Claude Push-to-Talk - key watcher helper for Linux (the counterpart of helper.ps1).

Reads commands from stdin, one per line, and writes one reply line per command:
  waitany  -> takes a snapshot of the keys held down right now, waits until one of them is released,
              then writes "released"; writes "cancelled" instead if Esc is pressed while waiting;
              writes "unsupported" if the key state cannot be read on this system
  waitidle -> waits until no key is held down, then writes "idle"
  enter    -> once the modifier keys are released, presses Enter; writes "sent" or "skipped: <why>"
  clear    -> once all keys are released, presses Ctrl+A, Backspace; writes "cleared" or "skipped: <why>"
  status   -> writes one line describing which backends are usable
  ping     -> writes "pong"

Reading the key state (Wayland has no API for it):
  1. X11 through XWayland (XQueryKeymap). Needs no permission, but only sees keys while an X11
     window is active, which is the case when VS Code itself runs under XWayland (the snap does).
  2. evdev (/dev/input/event*). Used when VS Code is a native Wayland window; the user has to be
     in the "input" group.

Pressing keys:
  1. GNOME's own remote desktop interface (org.gnome.Mutter.RemoteDesktop). Needs no permission
     and shows no dialog.
  2. On other desktops, the XDG RemoteDesktop portal. It asks for permission once and stores a
     restore token in ~/.claude/push-to-talk/portal-token, so later sessions start without a dialog.
A session is opened for each key press and closed right after it, so the desktop's
"remote control" indicator is only shown for a moment.
"""
import ctypes
import fcntl
import glob
import os
import sys
import threading
import time

DATA_DIR = os.path.join(os.path.expanduser('~'), '.claude', 'push-to-talk')
TOKEN_FILE = os.path.join(DATA_DIR, 'portal-token')

# Key numbers are Linux input event codes (an X11 keycode is the event code + 8).
# The cancel key is Esc; the environment variable is for tests only.
KEY_CANCEL = int(os.environ.get('CLAUDE_PUSH_TO_TALK_CANCEL_KEY', '1'))
MODIFIER_KEYS = {29, 97, 42, 54, 56, 100, 125, 126}  # Ctrl, Shift, Alt, Super (left and right)

XK_RETURN, XK_BACKSPACE, XK_CONTROL_L, XK_A = 0xFF0D, 0xFF08, 0xFFE3, 0x61

# A portal Start call that takes longer than this had to show its permission dialog.
DIALOG_SECONDS = 1.5


def reply(text):
    sys.stdout.write(text + '\n')
    sys.stdout.flush()


class X11Keys:
    """Key state of the X server (XWayland). Only meaningful while an X11 window is active."""

    def __init__(self):
        self.lib = ctypes.CDLL('libX11.so.6')
        self.lib.XOpenDisplay.restype = ctypes.c_void_p
        self.lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.lib.XDefaultRootWindow.restype = ctypes.c_ulong
        self.lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        self.lib.XInternAtom.restype = ctypes.c_ulong
        self.lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        self.lib.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        self.lib.XFree.argtypes = [ctypes.c_void_p]
        self.lib.XGetWindowProperty.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int,
            ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p),
        ]
        self.dpy = self.lib.XOpenDisplay(None)
        if not self.dpy:
            raise OSError('cannot open the X display')
        self.root = self.lib.XDefaultRootWindow(self.dpy)
        self.atom = self.lib.XInternAtom(self.dpy, b'_NET_ACTIVE_WINDOW', 0)

    def active(self):
        """True if the active window is an X11 window (the root property is 0 for a Wayland window)."""
        kind, fmt = ctypes.c_ulong(), ctypes.c_int()
        count, rest, data = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
        status = self.lib.XGetWindowProperty(
            self.dpy, self.root, self.atom, 0, 1, 0, 0,
            ctypes.byref(kind), ctypes.byref(fmt), ctypes.byref(count), ctypes.byref(rest), ctypes.byref(data))
        if status != 0 or not data.value:
            return False
        try:
            return count.value > 0 and ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] != 0
        finally:
            self.lib.XFree(data)

    def down(self):
        buf = ctypes.create_string_buffer(32)
        self.lib.XQueryKeymap(self.dpy, buf)
        raw = buf.raw
        return {kc - 8 for kc in range(8, 256) if raw[kc >> 3] & (1 << (kc & 7))}


class EvdevKeys:
    """Key state of the input devices. Needs read access to /dev/input/event* (the "input" group)."""

    KEY_BYTES = 96
    EVIOCGKEY = (2 << 30) | (KEY_BYTES << 16) | (ord('E') << 8) | 0x18

    def __init__(self):
        self.fds = []

    def refresh(self):
        for fd in self.fds:
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds = []
        for dev in glob.glob('/dev/input/event*'):
            try:
                self.fds.append(os.open(dev, os.O_RDONLY | os.O_NONBLOCK))
            except OSError:
                pass
        return bool(self.fds)

    def down(self):
        keys = set()
        for fd in self.fds:
            buf = bytearray(self.KEY_BYTES)
            try:
                fcntl.ioctl(fd, self.EVIOCGKEY, buf)
            except OSError:
                continue
            # Codes from 256 up are mouse and gamepad buttons.
            for code in range(1, 256):
                if buf[code >> 3] & (1 << (code & 7)):
                    keys.add(code)
        return keys


class Skipped(Exception):
    pass


class Mutter:
    """Key presses through GNOME's org.gnome.Mutter.RemoteDesktop. No permission dialog."""

    name = 'GNOME remote desktop interface'
    BUS = 'org.gnome.Mutter.RemoteDesktop'
    PATH = '/org/gnome/Mutter/RemoteDesktop'
    SESSION = 'org.gnome.Mutter.RemoteDesktop.Session'

    def __init__(self):
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = Gio, GLib
        self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        # Fails here if the interface does not exist (another desktop).
        self._call(self.PATH, 'org.freedesktop.DBus.Peer', 'Ping', None)
        self.loop = None

    def _call(self, path, iface, method, params):
        return self.conn.call_sync(self.BUS, path, iface, method, params, None,
                                   self.Gio.DBusCallFlags.NONE, 3000, None)

    def needs_grant(self):
        return False

    def describe(self):
        return self.name

    def press(self, events):
        session = self._call(self.PATH, self.BUS, 'CreateSession', None).unpack()[0]
        try:
            self._call(session, self.SESSION, 'Start', None)
            for keysym, pressed in events:
                self._call(session, self.SESSION, 'NotifyKeyboardKeysym',
                           self.GLib.Variant('(ub)', (keysym, pressed)))
                time.sleep(0.012)
            time.sleep(0.05)
        finally:
            try:
                self._call(session, self.SESSION, 'Stop', None)
            except Exception:
                pass


class Portal:
    """Key presses through org.freedesktop.portal.RemoteDesktop."""

    BUS = 'org.freedesktop.portal.Desktop'
    PATH = '/org/freedesktop/portal/desktop'
    IFACE = 'org.freedesktop.portal.RemoteDesktop'

    def __init__(self):
        import gi
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = Gio, GLib
        self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.sender = self.conn.get_unique_name()[1:].replace('.', '_')
        self.lock = threading.Lock()
        self.counter = 0
        # Response signals are delivered by this loop; the commands run on another thread.
        self.loop = GLib.MainLoop()

    def _call(self, path, iface, method, params, timeout_ms=5000):
        return self.conn.call_sync(self.BUS, path, iface, method, params, None,
                                   self.Gio.DBusCallFlags.NONE, timeout_ms, None)

    def _request(self, method, build, timeout):
        """Calls a portal method that answers through a Request object; returns its results."""
        self.counter += 1
        token = 'ptt%d_%d' % (os.getpid(), self.counter)
        path = '%s/request/%s/%s' % (self.PATH, self.sender, token)
        done, box = threading.Event(), {}

        def on_response(_conn, _sender, _path, _iface, _signal, params):
            box['code'], box['results'] = params.unpack()
            done.set()

        sub = self.conn.signal_subscribe(self.BUS, 'org.freedesktop.portal.Request', 'Response', path,
                                         None, self.Gio.DBusSignalFlags.NONE, on_response)
        try:
            self._call(self.PATH, self.IFACE, method, build(token))
            if not done.wait(timeout):
                try:
                    self._call(path, 'org.freedesktop.portal.Request', 'Close', None)
                except Exception:
                    pass
                raise Skipped('the portal did not answer %s' % method)
        finally:
            self.conn.signal_unsubscribe(sub)
        if box['code'] != 0:
            raise Skipped('permission to press keys was not given' if method == 'Start'
                          else 'the portal refused %s' % method)
        return box['results']

    def _open(self):
        """Opens a keyboard session. Returns (session path, True if the permission dialog was shown)."""
        V = self.GLib.Variant
        results = self._request('CreateSession', lambda t: V('(a{sv})', ({
            'handle_token': V('s', t), 'session_handle_token': V('s', t + 's')},)), 10)
        session = results['session_handle']
        try:
            token = ''
            try:
                with open(TOKEN_FILE, encoding='utf-8') as f:
                    token = f.read().strip()
            except OSError:
                pass

            def select(t):
                opts = {'handle_token': V('s', t), 'types': V('u', 1), 'persist_mode': V('u', 2)}
                if token:
                    opts['restore_token'] = V('s', token)
                return V('(oa{sv})', (session, opts))

            self._request('SelectDevices', select, 10)
            started = time.monotonic()
            results = self._request('Start', lambda t: V('(osa{sv})', (session, '', {'handle_token': V('s', t)})), 120)
            asked = not token or time.monotonic() - started > DIALOG_SECONDS
            if not results.get('devices', 0) & 1:
                raise Skipped('the portal did not give keyboard access')
            new_token = results.get('restore_token', '')
            if new_token:
                os.makedirs(DATA_DIR, exist_ok=True)
                fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    f.write(new_token)
            return session, asked
        except Exception:
            self._close(session)
            raise

    def _close(self, session):
        try:
            self._call(session, 'org.freedesktop.portal.Session', 'Close', None)
        except Exception:
            pass

    def needs_grant(self):
        return not os.path.exists(TOKEN_FILE)

    def describe(self):
        return 'RemoteDesktop portal, ' + ('waiting for permission' if self.needs_grant() else 'permission saved')

    def grant(self):
        """Shows the permission dialog once, so that later key presses need none."""
        with self.lock:
            try:
                session, _ = self._open()
                self._close(session)
            except Exception as e:
                sys.stderr.write('portal: %s\n' % e)

    def press(self, events):
        """events: (keysym, pressed) pairs. Raises Skipped if nothing was pressed."""
        if not self.lock.acquire(timeout=3):
            raise Skipped('the permission dialog is still open')
        try:
            session, asked = self._open()
            try:
                # The dialog took the focus away, so the keys could land in the wrong place.
                if asked:
                    raise Skipped('permission was only just given; try again')
                V = self.GLib.Variant
                for keysym, pressed in events:
                    self._call(session, self.IFACE, 'NotifyKeyboardKeysym',
                               V('(oa{sv}iu)', (session, {}, keysym, 1 if pressed else 0)))
                    time.sleep(0.012)
                time.sleep(0.05)
            finally:
                self._close(session)
        finally:
            self.lock.release()


class Helper:
    def __init__(self):
        self.x11 = None
        try:
            self.x11 = X11Keys()
        except Exception:
            pass
        self.evdev = EvdevKeys()
        self.portal = None
        self.portal_error = ''
        for backend in (Mutter, Portal):
            try:
                self.portal = backend()
                break
            except Exception as e:
                self.portal_error = str(e)
        # Set once a key was read through X11, which means VS Code is an X11 window.
        self.vscode_is_x11 = False

    def reader(self):
        """Returns a function giving the set of keys held down, or None if no backend is usable."""
        if self.x11 and self.x11.active():
            return self.x11.down
        if self.evdev.refresh():
            return self.evdev.down
        return None

    def wait_any(self):
        down = self.reader()
        if down is None:
            return 'unsupported'
        if self.x11 and down == self.x11.down:
            self.vscode_is_x11 = True
        first = down()
        cancel_was_down = KEY_CANCEL in first
        keys = first - {KEY_CANCEL}
        deadline = time.monotonic() + 120
        while keys and time.monotonic() < deadline:
            now = down()
            if not cancel_was_down and KEY_CANCEL in now:
                return 'cancelled'
            if keys - now:
                break
            time.sleep(0.015)
        return 'released'

    def wait_up(self, seconds, only=None):
        """Waits until no key (or none of `only`) is held down. Returns False on timeout."""
        down = self.reader()
        if down is None:
            return True
        deadline = time.monotonic() + seconds
        while True:
            keys = down()
            if not (keys & only if only else keys):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.015)

    def press(self, events, only, done, still_down):
        if not self.wait_up(3, only):
            return 'skipped: ' + still_down
        if self.vscode_is_x11 and not self.x11.active():
            return 'skipped: VS Code is not the active window'
        if not self.portal:
            return 'skipped: no way to press keys (%s)' % self.portal_error
        try:
            self.portal.press(events)
        except Skipped as e:
            return 'skipped: %s' % e
        except Exception as e:
            return 'skipped: key press failed: %s' % e
        return done

    def status(self):
        if self.x11 and self.x11.active():
            keys = 'X11'
        elif self.evdev.refresh():
            keys = 'evdev'
        elif self.x11:
            keys = 'none right now (no X11 window is active and /dev/input is not readable)'
        else:
            keys = 'none (no X display and /dev/input is not readable)'
        if not self.portal:
            inject = 'unavailable (%s)' % self.portal_error
        else:
            inject = self.portal.describe()
        return 'key state: %s; key press: %s' % (keys, inject)

    def run(self):
        reply('ready')
        if self.portal and self.portal.needs_grant():
            threading.Thread(target=self.portal.grant, daemon=True).start()
        for line in sys.stdin:
            parts = line.split()
            cmd = parts[0] if parts else ''
            if cmd == 'waitany':
                reply(self.wait_any())
            elif cmd == 'waitidle':
                self.wait_up(120)
                reply('idle')
            elif cmd == 'enter':
                reply(self.press([(XK_RETURN, True), (XK_RETURN, False)],
                                 MODIFIER_KEYS, 'sent', 'modifier still down'))
            elif cmd == 'clear':
                reply(self.press([(XK_CONTROL_L, True), (XK_A, True), (XK_A, False), (XK_CONTROL_L, False),
                                  (XK_BACKSPACE, True), (XK_BACKSPACE, False)],
                                 None, 'cleared', 'a key is still down'))
            elif cmd == 'status':
                reply(self.status())
            elif cmd == 'ping':
                reply('pong')
            else:
                reply('unknown')


def main():
    helper = Helper()
    worker = threading.Thread(target=helper.run, daemon=True)
    worker.start()
    if helper.portal and helper.portal.loop:
        # The main thread delivers the portal's signals; the process ends when stdin closes.
        threading.Thread(target=lambda: (worker.join(), helper.portal.loop.quit()), daemon=True).start()
        helper.portal.loop.run()
    else:
        worker.join()


if __name__ == '__main__':
    main()
