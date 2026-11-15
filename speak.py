#!/usr/bin/env python3
"""Claude Push-to-Talk - reads Claude's last response aloud on Linux (the counterpart of speak.ps1).

Runs in two modes:
  (no arguments)        Claude Code Stop hook: reads the hook JSON from stdin, prepares the text,
                        hands the reading off to a separate process and exits immediately.
  --worker <text file>  Reads the text file aloud with a Piper voice downloaded by the extension.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

DATA_DIR = os.path.join(os.path.expanduser('~'), '.claude', 'push-to-talk')
PID_FILE = os.path.join(DATA_DIR, 'tts.pid')
CONFIG_FILE = os.path.join(DATA_DIR, 'config.json')
LOG_FILE = os.path.join(DATA_DIR, 'speak.log')

# Piper (a neural speech engine) and its voices, downloaded by the extension on request.
PIPER_DIR = os.path.join(DATA_DIR, 'piper')
PIPER_BIN = os.path.join(PIPER_DIR, 'engine', 'piper', 'piper')
PIPER_VOICES = os.path.join(PIPER_DIR, 'voices')
# Touched when a response could not be read because no voice is downloaded or selected; the extension watches it and tells the user.
NO_VOICE_FILE = os.path.join(DATA_DIR, 'no-voice')
NO_VOICE_MESSAGE = 'nothing read: no voice is downloaded (run "Claude Push-to-Talk: Select Read-Aloud Voice" in VS Code)'
NOT_SELECTED_MESSAGE = 'nothing read: no voice is selected (run "Claude Push-to-Talk: Select Read-Aloud Voice" in VS Code)'


def write_log(msg):
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write('%s %s\n' % (time.strftime('%Y-%m-%dT%H:%M:%S'), msg))
    except OSError:
        pass


def read_config():
    cfg = {'readAloud': True, 'voice': '', 'rate': 1.15, 'maxChars': 1200}
    try:
        with open(CONFIG_FILE, encoding='utf-8') as f:
            data = json.load(f)
        for key in cfg:
            if data.get(key) is not None:
                cfg[key] = data[key]
    except (OSError, ValueError, AttributeError):
        pass
    return cfg


def stop_previous():
    try:
        with open(PID_FILE, encoding='utf-8') as f:
            old = int(f.read().strip())
        with open('/proc/%d/cmdline' % old, 'rb') as f:
            is_worker = b'speak.py' in f.read()
        if is_worker:
            os.kill(old, signal.SIGTERM)
    except (OSError, ValueError):
        pass
    try:
        os.unlink(PID_FILE)
    except OSError:
        pass


def last_assistant_text(hook):
    if hook.get('last_assistant_message'):
        return str(hook['last_assistant_message'])
    path = hook.get('transcript_path')
    if not path or not os.path.isfile(path):
        return ''
    with open(path, encoding='utf-8', errors='replace') as f:
        lines = f.readlines()[-80:]
    for line in reversed(lines):
        try:
            entry = json.loads(line)
            if entry.get('type') != 'assistant' or not entry.get('message'):
                continue
            parts = [p.get('text', '') for p in entry['message'].get('content', []) if p.get('type') == 'text']
        except (ValueError, AttributeError, TypeError):
            continue
        text = '\n'.join(parts).strip()
        if text:
            return text
    return ''


def to_speakable(text, max_chars):
    text = re.sub(r'(?s)```.*?```', ' ', text)                 # code blocks
    text = re.sub(r'(?m)^\s*\|.*\|\s*$', ' ', text)            # table rows
    text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', text)     # links
    text = re.sub(r'https?://\S+', ' ', text)
    text = re.sub(r'(?m)^\s{0,3}#{1,6}\s*', '', text)          # headings
    text = re.sub(r'(?m)^\s*([-*+]|\d+\.)\s+', '', text)       # list markers
    text = re.sub(r'(?m)^\s*>\s?', '', text)
    text = re.sub(r'[`*_~#|<>]', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if max_chars > 0 and len(text) > max_chars:
        cut = text[:max_chars]
        end = max(cut.rfind(c) for c in '.!?')
        if end > max_chars / 2:
            cut = cut[:end + 1]
        text = cut
    return text


def process_running(name):
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open('/proc/%s/comm' % pid, encoding='utf-8') as f:
                if f.read().strip() == name:
                    return True
        except OSError:
            pass
    return False


def piper_voices():
    """Keys of the downloaded Piper voices, e.g. 'tr_TR-dfki-medium'."""
    if not os.access(PIPER_BIN, os.X_OK):
        return []
    try:
        names = os.listdir(PIPER_VOICES)
    except OSError:
        return []
    return sorted(n[:-5] for n in names if n.endswith('.onnx') and n + '.json' in names)


def pick_voice(cfg):
    """The voice chosen in the settings, if it is downloaded; otherwise None (nothing is read)."""
    key = str(cfg['voice'] or '')
    return key if key and key in piper_voices() else None


def no_voice_message():
    return NOT_SELECTED_MESSAGE if piper_voices() else NO_VOICE_MESSAGE


class VsCodeWatch:
    """Tells whether VS Code was running when the reading started and has since been closed.
    (If it was not running, e.g. Claude Code in a standalone terminal, the reading is left alone.)"""

    def __init__(self):
        self.name = os.environ.get('CLAUDE_PUSH_TO_TALK_WATCH', 'code')
        self.was_running = process_running(self.name)

    def closed(self):
        if self.was_running and not process_running(self.name):
            write_log('stopped: %s was closed' % self.name)
            return True
        return False


def speak(text, cfg):
    """Reads with Piper, playing the audio while it is produced."""
    key = pick_voice(cfg)
    if not key:
        write_log(no_voice_message())
        return
    model = os.path.join(PIPER_VOICES, key + '.onnx')
    sample_rate, length_scale = 22050, 1.0
    try:
        with open(model + '.json', encoding='utf-8') as f:
            info = json.load(f)
        sample_rate = int(info.get('audio', {}).get('sample_rate', sample_rate))
        length_scale = float(info.get('inference', {}).get('length_scale', length_scale))
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    try:
        speed = min(4.0, max(0.25, float(cfg['rate'])))
    except (TypeError, ValueError):
        speed = 1.0
    if shutil.which('aplay'):
        play = ['aplay', '-q', '-t', 'raw', '-f', 'S16_LE', '-c', '1', '-r', str(sample_rate), '-']
    elif shutil.which('pw-cat'):
        play = ['pw-cat', '-p', '--format', 's16', '--channels', '1', '--rate', str(sample_rate), '-']
    else:
        write_log('nothing read: no audio player (aplay or pw-cat) found')
        return
    write_log('speaking: %d chars, voice: %s' % (len(text), key))
    if os.environ.get('CLAUDE_PUSH_TO_TALK_NOPLAY'):   # test: exit without playing
        return

    piper = subprocess.Popen(
        [PIPER_BIN, '--model', model, '--output_raw', '--length_scale', '%.3f' % (length_scale / speed), '--quiet'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    player = subprocess.Popen(play, stdin=piper.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    piper.stdout.close()

    def stop(*_):
        for proc in (player, piper):
            try:
                proc.kill()
            except OSError:
                pass
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        piper.stdin.write((text + '\n').encode('utf-8'))
        piper.stdin.close()
    except OSError:
        pass
    watch = VsCodeWatch()
    deadline = time.monotonic() + 900
    while player.poll() is None:
        time.sleep(0.3)
        if watch.closed() or time.monotonic() > deadline:
            for proc in (player, piper):
                proc.kill()
            break
    if piper.wait() != 0:
        write_log('Piper failed (exit code %s)' % piper.returncode)


def worker(text_file):
    with open(PID_FILE, 'w', encoding='utf-8') as f:
        f.write(str(os.getpid()))
    try:
        with open(text_file, encoding='utf-8') as f:
            text = f.read()
        os.unlink(text_file)
        if text.strip():
            speak(text, read_config())
    finally:
        try:
            with open(PID_FILE, encoding='utf-8') as f:
                mine = f.read().strip() == str(os.getpid())
            if mine:
                os.unlink(PID_FILE)
        except OSError:
            pass


def hook():
    cfg = read_config()
    if not cfg['readAloud']:
        return
    raw = sys.stdin.buffer.read().decode('utf-8', errors='replace')
    if not raw.strip():
        return
    text = to_speakable(last_assistant_text(json.loads(raw)), int(cfg['maxChars']))
    if not text:
        return
    if not pick_voice(cfg):
        write_log(no_voice_message())
        with open(NO_VOICE_FILE, 'w', encoding='utf-8') as f:
            f.write(time.strftime('%Y-%m-%dT%H:%M:%S') + '\n')
        return
    stop_previous()
    text_file = os.path.join(DATA_DIR, 'say-%d.txt' % os.getpid())
    with open(text_file, 'w', encoding='utf-8') as f:
        f.write(text)
    subprocess.Popen([sys.executable, os.path.abspath(__file__), '--worker', text_file],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)


if __name__ == '__main__':
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        if len(sys.argv) >= 3 and sys.argv[1] == '--worker':
            worker(sys.argv[2])
        else:
            hook()
    except Exception as e:   # the hook must never fail or delay Claude
        write_log('ERROR: %s' % e)
    sys.exit(0)
