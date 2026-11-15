// Claude Push-to-Talk
// 1) Submits the message (by pressing Enter) when dictation ends in the Claude Code panel.
// 2) Writes the settings and the script used by the Stop hook (speak.ps1 or speak.py) to ~/.claude/push-to-talk.
// The parts that need the operating system live in a helper process and a hook script, chosen by platform:
//   Windows: helper.ps1 and speak.ps1 (PowerShell)    Linux: helper.py and speak.py (Python 3)
const vscode = require('vscode');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const SPEAK_SCRIPT = IS_WINDOWS ? 'speak.ps1' : 'speak.py';
const DATA_DIR = path.join(os.homedir(), '.claude', 'push-to-talk');
const PID_FILE = path.join(DATA_DIR, 'tts.pid');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
// Piper, a neural speech engine that runs on the computer. On Linux it is the only way to read aloud;
// on Windows its voices are offered next to the Windows voices.
// Nothing is bundled; the engine and the voices are downloaded here when the user chooses a voice. The speak script reads them from this folder.
const PIPER_DIR = path.join(DATA_DIR, 'piper');
const PIPER_ENGINE_DIR = path.join(PIPER_DIR, 'engine');
const PIPER_BIN = path.join(PIPER_ENGINE_DIR, 'piper', IS_WINDOWS ? 'piper.exe' : 'piper');
const PIPER_VOICES_DIR = path.join(PIPER_DIR, 'voices');
// The speak script touches this file when a response could not be read because no voice is downloaded or selected.
const NO_VOICE_FILE = path.join(DATA_DIR, 'no-voice');
const PIPER_ENGINE_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/';
const PIPER_ENGINES = {
  'linux-x64': { file: 'piper_linux_x86_64.tar.gz', size: 26460462, sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992' },
  'linux-arm64': { file: 'piper_linux_aarch64.tar.gz', size: 26004717, sha256: 'fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb' },
  'win32-x64': { file: 'piper_windows_amd64.zip', size: 22477236, sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea' },
};
const PIPER_ENGINE = PIPER_ENGINES[`${process.platform}-${process.arch}`];
// The voice catalogue (voices.json) lists every voice with its files, sizes and MD5 digests.
const PIPER_VOICES_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
// Threshold used by the Claude Code panel: a shorter press is "tap to toggle", a longer one is "hold to talk".
const HOLD_THRESHOLD_MS = 200;
const MAX_RECORDING_MS = 10 * 60 * 1000;
// Helper command: waits until any key that is held down right now is released.
// This keeps release detection independent of the key the command is bound to,
// so the dictation key can be changed from VS Code's Keyboard Shortcuts.
const WAIT_RELEASE = 'waitany';
// The last words of a dictation reach the input box a moment after dictation stops.
// Pressing Enter sooner than this would submit an empty or incomplete message, so shorter settings are raised to it.
const MIN_SUBMIT_DELAY_MS = 300;

let out;
let helper = null;
let helperBuf = '';
let pending = [];
let recording = false;
let held = false;
let sessionId = 0;
let cancelledSession = -1;
let activeMode = null; // 'panel' (Ctrl+D inside the Claude panel) or 'global' (the global dictation key)
let pressedAt = 0;
let submitTimer = null;
// Linux only: the helper could not read the key state, so key release cannot be detected
// and the dictation key works as a toggle (press to start, press again to stop and submit).
let releaseUnknown = false;
let lastKeyAt = 0;
// Longer than the keyboard's repeat delay: a held key repeats, and without release detection
// a repeat would look like a second press.
const REPEAT_GUARD_MS = 600;

function cfg() {
  return vscode.workspace.getConfiguration('claudePushToTalk');
}

function log(msg) {
  try {
    out.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
  } catch (_) {
    // The window is closing and the output channel is already gone (the helper exits at that moment).
  }
}

// The voice chosen in the settings; '' means none is chosen, and then nothing is read aloud.
function selectedVoice() {
  return String(cfg().get('voice', '') || '');
}

function writeConfig() {
  const c = cfg();
  const data = {
    readAloud: c.get('readAloud', true),
    voice: selectedVoice(),
    rate: c.get('rate', 1.15),
    maxChars: c.get('maxChars', 1200),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// The command of the Stop hook that reads responses aloud.
function hookCommand() {
  const script = path.join(DATA_DIR, SPEAK_SCRIPT).replace(/\\/g, '/');
  return IS_WINDOWS
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`
    : `python3 "${script}"`;
}

// Adds the read-aloud Stop hook to ~/.claude/settings.json if it is not there yet, keeping everything else in the file.
// Only done while read aloud is on. A hook that already runs a push-to-talk speak script is left as it is.
// The hook is removed again when the extension is uninstalled (see watchUninstall and uninstall.js).
function ensureHook() {
  if (!(IS_WINDOWS || IS_LINUX) || !cfg().get('readAloud', true)) return;
  let settings = {};
  let text = null;
  try {
    text = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log(`Could not read ${CLAUDE_SETTINGS_FILE}: ${e.message}`);
      return;
    }
  }
  if (text !== null && text.trim()) {
    try {
      settings = JSON.parse(text);
    } catch (e) {
      log(`${CLAUDE_SETTINGS_FILE} is not valid JSON, so the read-aloud hook was not added: ${e.message}`);
      return;
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
  const hooks = settings.hooks === undefined ? {} : settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
  const stop = hooks.Stop === undefined ? [] : hooks.Stop;
  if (!Array.isArray(stop)) return;
  const present = stop.some((group) =>
    group && Array.isArray(group.hooks) &&
    group.hooks.some((h) => h && /push-to-talk[\\/]+speak\.(ps1|py)/.test(String(h.command)))
  );
  if (present) return;

  stop.push({ hooks: [{ type: 'command', command: hookCommand(), timeout: 20 }] });
  hooks.Stop = stop;
  settings.hooks = hooks;
  try {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_FILE), { recursive: true });
    const tmp = `${CLAUDE_SETTINGS_FILE}.push-to-talk.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, CLAUDE_SETTINGS_FILE);
  } catch (e) {
    log(`Could not add the read-aloud hook: ${e.message}`);
    return;
  }
  log(`Read-aloud hook added to ${CLAUDE_SETTINGS_FILE}.`);
  vscode.window.showInformationMessage(
    'Claude Push-to-Talk: The read-aloud hook was added to your Claude settings. Responses are read in Claude sessions started from now on.'
  );
}

function helperExited(reason) {
  log(`Helper process exited (${reason}).`);
  helper = null;
  const waiting = pending;
  pending = [];
  waiting.forEach((r) => r('exit'));
}

function startHelper(context) {
  let command;
  let args;
  const env = Object.assign({}, process.env);
  if (IS_WINDOWS) {
    command = 'powershell.exe';
    args = ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', path.join(context.extensionPath, 'helper.ps1')];
  } else if (IS_LINUX) {
    command = 'python3';
    args = [path.join(context.extensionPath, 'helper.py')];
    // The VS Code snap points these at its own libraries, which the system's Python must not load.
    for (const name of Object.keys(env)) {
      if (/^(GTK_|GDK_|GIO_MODULE_DIR$|GSETTINGS_SCHEMA_DIR$|LOCPATH$)/.test(name)) delete env[name];
    }
  } else {
    log('Only Windows and Linux are supported; auto-submit is disabled.');
    return;
  }
  helper = cp.spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
  helper.on('error', (e) => helperExited(`could not start ${command}: ${e.message}`));
  helper.stdin.on('error', () => {});
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    helperBuf += chunk;
    let idx;
    while ((idx = helperBuf.indexOf('\n')) >= 0) {
      const line = helperBuf.slice(0, idx).trim();
      helperBuf = helperBuf.slice(idx + 1);
      if (!line) continue;
      if (line === 'ready') {
        log('Helper process is ready.');
        if (IS_LINUX) send('status').then((s) => log(`Helper: ${s}`));
        continue;
      }
      const resolve = pending.shift();
      if (resolve) resolve(line);
    }
  });
  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (d) => log(`helper stderr: ${String(d).trim()}`));
  helper.on('exit', (code) => {
    if (helper) helperExited(`code ${code}`);
  });
}

function send(cmd) {
  return new Promise((resolve) => {
    if (!helper) return resolve('nohelper');
    pending.push(resolve);
    helper.stdin.write(cmd + '\n');
  });
}

function stopSpeaking() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid > 0) process.kill(pid);
  } catch (_) {
    // nothing is being read, or the process has already finished
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch (_) {}
}

function scheduleSubmit() {
  if (!cfg().get('autoSubmit', true)) return;
  clearTimeout(submitTimer);
  const delay = Math.max(MIN_SUBMIT_DELAY_MS, cfg().get('submitDelayMs', 800));
  submitTimer = setTimeout(async () => {
    if (!vscode.window.state.focused) {
      log('Window is not focused; Enter was not sent.');
      return;
    }
    const r = await send('enter');
    log(`Enter: ${r}`);
  }, delay);
}

function setRecording(value) {
  recording = value;
  // Enables the Escape keybinding (cancel) only while a dictation is in progress.
  vscode.commands.executeCommand('setContext', 'claudePushToTalk.recording', value);
}

// After a cancelled dictation, empties the Claude input box (Ctrl+A, Backspace through the helper).
function scheduleClear() {
  if (!cfg().get('clearOnCancel', true)) return;
  clearTimeout(submitTimer);
  const delay = Math.max(MIN_SUBMIT_DELAY_MS, cfg().get('submitDelayMs', 800));
  submitTimer = setTimeout(async () => {
    if (!vscode.window.state.focused) return;
    try {
      // Make sure the keystrokes land in the Claude input and not in an editor.
      await vscode.commands.executeCommand('claude-vscode.focus');
      const r = await send('clear');
      log(`Clear input: ${r}`);
    } catch (e) {
      log(`Clear input failed: ${e.message}`);
    }
  }, delay);
}

// Escape while dictating: stop dictation and do not submit.
async function cancelDictation() {
  if (!recording) return;
  const mode = activeMode;
  cancelledSession = sessionId;
  setRecording(false);
  clearTimeout(submitTimer);
  log('Dictation cancelled (Escape).');
  vscode.window.setStatusBarMessage('Dictation cancelled', 2500);
  try {
    // During the panel's own hold-to-talk the panel stops by itself when Ctrl+D is released;
    // in every other case dictation has to be switched off here.
    if (!(mode === 'panel' && held)) await vscode.commands.executeCommand('claude-vscode.toggleDictation');
  } catch (e) {
    log(`Cancel failed: ${e.message}`);
  }
  // In tap mode nothing is waiting for a key release, so clear right away.
  if (!held) scheduleClear();
}

// Waits for the dictation key to be released. Returns true if the dictation was cancelled meanwhile.
async function waitForRelease(mySession) {
  const r = await send(WAIT_RELEASE);
  if (r === 'unsupported' && !releaseUnknown) {
    log('The helper cannot read the key state, so key release is not detected: the dictation key works as a toggle. See "Linux" in the README.');
    vscode.window.showWarningMessage(
      'Claude Push-to-Talk: Key release cannot be detected on this system. Press the dictation key once to start and once more to stop and submit. See "Linux" in the README.'
    );
  }
  releaseUnknown = r === 'unsupported';
  if (r === 'cancelled') await cancelDictation();
  if (cancelledSession !== mySession) return false;
  await send('waitidle');
  held = false;
  scheduleClear();
  return true;
}

// True if this key press is the auto-repeat of a held key. Only needed when key release cannot be detected;
// otherwise 'held' covers it.
function isRepeat() {
  const now = Date.now();
  const repeat = releaseUnknown && now - lastKeyAt < REPEAT_GUARD_MS;
  lastKeyAt = now;
  return repeat;
}

// Runs when Ctrl+D is pressed inside the Claude panel (VS Code does not report key release; the helper watches for it).
// Mirrors the Claude Code panel's own logic:
//   - hold longer than 200 ms, then release -> dictation stops -> submit
//   - short tap                             -> dictation stays on; the next Ctrl+D stops it -> submit
async function onDictationKey() {
  stopSpeaking();
  if (held || isRepeat()) return; // key repeat
  clearTimeout(submitTimer);

  if (recording && Date.now() - pressedAt > MAX_RECORDING_MS) setRecording(false);

  if (recording) {
    setRecording(false);
    log('Dictation stopped (tap).');
    scheduleSubmit();
    held = true;
    await send(WAIT_RELEASE);
    held = false;
    return;
  }

  const mySession = ++sessionId;
  activeMode = 'panel';
  setRecording(true);
  held = true;
  pressedAt = Date.now();
  if (await waitForRelease(mySession)) return;
  held = false;
  if (releaseUnknown) {
    // The panel handles hold and tap by itself; without the release there is no telling which one this was.
    setRecording(false);
    log('Ctrl+D: key release is not detected, so nothing is submitted automatically.');
    return;
  }
  const dur = Date.now() - pressedAt;
  if (dur >= HOLD_THRESHOLD_MS) {
    setRecording(false);
    log(`Key released (${dur} ms), submitting.`);
    scheduleSubmit();
  } else {
    log(`Short tap (${dur} ms): dictation is on, press Ctrl+D again to stop.`);
  }
}

// How long the official extension needs to put the reference to the selected text into the Claude input.
const SELECTION_SETTLE_MS = 300;

function editorHasSelection() {
  const editor = vscode.window.activeTextEditor;
  return Boolean(editor && !editor.selection.isEmpty);
}

// Global dictation key (Insert by default; in the terminal only with the dictationInTerminal setting): focuses the panel, and we start and stop dictation ourselves.
// The panel does not handle this key, so the official extension's toggleDictation command is used.
// Focus stays in the Claude input afterwards.
async function onDictationKeyGlobal() {
  stopSpeaking();
  if (held || isRepeat()) return; // key repeat
  clearTimeout(submitTimer);

  if (recording && Date.now() - pressedAt > MAX_RECORDING_MS) setRecording(false);

  try {
    if (recording) {
      // Dictation was started by a tap and is still on: stop it and submit.
      setRecording(false);
      held = true;
      // With a selection in the editor, focusing again would add its reference a second time (see below);
      // focus is still in the Claude input from the first press.
      if (!editorHasSelection()) await vscode.commands.executeCommand('claude-vscode.focus');
      await vscode.commands.executeCommand('claude-vscode.toggleDictation');
      log('Dictation stopped (global key tap).');
      scheduleSubmit();
      await send(WAIT_RELEASE);
      return;
    }

    const mySession = ++sessionId;
    activeMode = 'global';
    setRecording(true);
    held = true;
    pressedAt = Date.now();
    // When text is selected in the editor, the official focus command also adds a reference to it (@file#lines)
    // to the Claude input, a moment after the command returns. Dictation stops itself as soon as the input
    // changes underneath it, so it may only start once that reference has arrived.
    const selection = editorHasSelection();
    await vscode.commands.executeCommand('claude-vscode.focus');
    if (selection) await new Promise((resolve) => setTimeout(resolve, SELECTION_SETTLE_MS));
    await vscode.commands.executeCommand('claude-vscode.toggleDictation');
    const waitStarted = Date.now();
    if (await waitForRelease(mySession)) return;
    // If the key was already up when the wait began, it was released during the pause above: a tap, not a hold.
    const releasedEarly = selection && Date.now() - waitStarted < 50;
    const dur = releasedEarly ? 0 : Date.now() - pressedAt;
    if (releaseUnknown) {
      log('Dictation is on, press the key again to stop and submit.');
    } else if (dur >= HOLD_THRESHOLD_MS) {
      setRecording(false);
      await vscode.commands.executeCommand('claude-vscode.toggleDictation');
      log(`Global key released (${dur} ms), submitting.`);
      scheduleSubmit();
    } else {
      log(`Global key short tap (${dur} ms): dictation is on, press the key again to stop.`);
    }
  } catch (e) {
    setRecording(false);
    log(`Global dictation error: ${e.message}`);
  } finally {
    held = false;
  }
}

const LANG_NAMES = {
  tr: 'Turkish', en: 'English', ar: 'Arabic', de: 'German', fr: 'French', es: 'Spanish',
  it: 'Italian', ru: 'Russian', ja: 'Japanese', zh: 'Chinese', ko: 'Korean', pt: 'Portuguese', nl: 'Dutch',
};

function shortVoiceName(name) {
  return String(name).replace(/^Microsoft\s+/, '');
}

function voiceDetail(v) {
  const lang = LANG_NAMES[String(v.lang).slice(0, 2).toLowerCase()] || v.lang;
  if (v.piper) return `${lang}, Piper`;
  if (!v.gender) return lang;
  return `${lang}, ${v.gender === 'Female' ? 'female' : 'male'}`;
}

function piperVoiceEntries() {
  return installedPiperVoices().map((key) => ({ name: key, lang: key.split('-')[0].replace('_', '-'), gender: '', piper: true }));
}

// The voices that can read: the downloaded Piper voices and, on Windows, the installed Windows voices read live through the helper.
async function getVoices() {
  if (!IS_WINDOWS) return piperVoiceEntries();
  try {
    const parsed = JSON.parse(await send('voices'));
    const native = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => v && v.name);
    // No Windows voices means the helper did not answer; report nothing, so the list is left as it is.
    return native.length ? native.concat(piperVoiceEntries()) : [];
  } catch (_) {
    return [];
  }
}

// The Voice setting is plain text, so it can name a voice that is not on this computer: typed by hand,
// uninstalled, or synced from another computer. Such a voice would read nothing, so the setting is cleared
// and the user is told.
async function checkVoice() {
  const current = selectedVoice();
  if (!current) return;
  const voices = await getVoices();
  // No answer from the helper: leave the setting alone. (On Linux an empty list is real: nothing is downloaded.)
  if (!voices.length && !IS_LINUX) return;
  if (voices.some((v) => String(v.name).toLowerCase().includes(current.toLowerCase()))) return;
  await cfg().update('voice', undefined, vscode.ConfigurationTarget.Global);
  log(`Voice "${current}" is not on this computer; the Voice setting was cleared.`);
  const select = 'Select a voice…';
  const choice = await vscode.window.showWarningMessage(
    `Claude Push-to-Talk: The voice "${current}" is not on this computer, so no voice is selected now and nothing is read aloud.`,
    select
  );
  if (choice === select) vscode.commands.executeCommand('claudePushToTalk.pickVoice');
}

// Reads the installed voices live and shows a pick list.
// firstRun: the list is shown by the extension itself, the first time it runs.
async function pickVoice(context, firstRun = false) {
  const voices = await getVoices();
  if (!voices.length) {
    // Linux: nothing is downloaded yet, so go straight to the download list.
    if (IS_LINUX) return downloadPiperVoice(context);
    vscode.window.showWarningMessage('Claude Push-to-Talk: Could not read the Windows voices.');
    return;
  }
  const current = selectedVoice();
  const items = voices.map((v) => ({ label: v.name, description: voiceDetail(v), value: shortVoiceName(v.name) }));
  for (const item of items) {
    if (item.value === current) item.label = `$(check) ${item.label}`;
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  // The ways to get a further voice sit at the end of the same list, so there is one place for voices.
  items.push({
    label: '$(cloud-download) Download a Piper voice…',
    description: 'A natural voice that runs on this computer (58 languages)',
    value: '__piper__',
  });
  if (IS_WINDOWS) {
    items.push({
      label: '$(settings-gear) Install a Windows voice…',
      description: 'Opens the Windows speech settings',
      value: '__windows__',
    });
  }
  if (installedPiperVoices().length) {
    items.push({ label: '$(trash) Remove downloaded voices…', description: 'Choose which Piper voices to delete', value: '__remove__' });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: firstRun ? 'Claude Push-to-Talk: Which voice should read Claude\'s responses aloud?' : undefined,
    placeHolder: firstRun
      ? 'Pick a voice, or get a new one at the end of the list (Esc: no reading aloud for now)'
      : 'Select the voice that reads responses',
    matchOnDescription: true,
    ignoreFocusOut: firstRun,
  });
  if (!picked) return;
  if (picked.value === '__piper__') return downloadPiperVoice(context);
  if (picked.value === '__windows__') return installWindowsVoice();
  if (picked.value === '__remove__') return removePiperVoices(context);
  await cfg().update('voice', picked.value || undefined, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`Read-aloud voice: ${picked.label.replace('$(check) ', '')}`, 3000);
}

// Windows voices are installed by Windows itself, in its speech settings.
async function installWindowsVoice() {
  await vscode.env.openExternal(vscode.Uri.parse('ms-settings:speech'));
  vscode.window.showInformationMessage(
    'Install the new voice with "Add voices" in Windows settings. It then appears in "Claude Push-to-Talk: Select Read-Aloud Voice".'
  );
}

// Unpacks the speech engine archive. tar reads .tar.gz, and the tar of Windows 10 and later also reads .zip.
function extractArchive(archive, dir) {
  const run = (command, args, env) =>
    new Promise((resolve, reject) => {
      cp.execFile(command, args, { windowsHide: true, env: Object.assign({}, process.env, env) }, (err) => (err ? reject(err) : resolve()));
    });
  if (!IS_WINDOWS) return run('tar', ['-xf', archive, '-C', dir]);
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return run(tar, ['-xf', archive, '-C', dir]).catch(() =>
    // The paths go through the environment, so spaces and quotes in them need no escaping.
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:PTT_ARCHIVE -DestinationPath $env:PTT_DEST -Force'],
      { PTT_ARCHIVE: archive, PTT_DEST: dir }
    )
  );
}

// Downloads a URL to a file, following redirects. Options: hash ('sha256' or 'md5') and expected (its hex digest),
// onBytes (called with the size of each chunk) and token (a VS Code cancellation token).
// The file only appears under its final name once it is complete and its digest matches.
function download(url, dest, options = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const part = `${dest}.part`;
    let settled = false;
    let cancelSub = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (cancelSub) cancelSub.dispose();
      if (!err) return resolve();
      fs.rm(part, { force: true }, () => reject(err));
    };
    const req = https.get(url, { headers: { 'User-Agent': 'claude-push-to-talk' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        settled = true;
        if (cancelSub) cancelSub.dispose();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('redirected to a URL that is not HTTPS'));
        return download(next.toString(), dest, options, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error(`the server answered ${res.statusCode}`));
      }
      const hash = options.hash ? crypto.createHash(options.hash) : null;
      const file = fs.createWriteStream(part);
      res.on('data', (chunk) => {
        if (hash) hash.update(chunk);
        if (options.onBytes) options.onBytes(chunk.length);
      });
      res.on('error', finish);
      file.on('error', finish);
      file.on('finish', () => {
        if (settled) return;
        if (hash && hash.digest('hex') !== options.expected) {
          return finish(new Error(`${path.basename(dest)} does not have the expected checksum`));
        }
        fs.rename(part, dest, (err) => finish(err || null));
      });
      res.pipe(file);
    });
    req.on('error', finish);
    req.setTimeout(30000, () => req.destroy(new Error('the connection timed out')));
    if (options.token) {
      cancelSub = options.token.onCancellationRequested(() => req.destroy(new Error('cancelled')));
    }
  });
}

function megabytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

// Keys of the downloaded Piper voices, e.g. 'tr_TR-dfki-medium'.
function installedPiperVoices() {
  try {
    const names = fs.readdirSync(PIPER_VOICES_DIR);
    return names.filter((n) => n.endsWith('.onnx') && names.includes(`${n}.json`)).map((n) => n.slice(0, -5));
  } catch (_) {
    return [];
  }
}

// The licence line of a voice's model card; voices have different licences and some are not free for commercial use.
async function piperVoiceLicence(cardPath, token) {
  const tmp = path.join(PIPER_DIR, 'MODEL_CARD.tmp');
  try {
    await download(PIPER_VOICES_URL + cardPath, tmp, { token });
    const m = /License:\s*(\S.*)/i.exec(fs.readFileSync(tmp, 'utf8'));
    return m ? m[1].trim() : null;
  } catch (_) {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Lets the user pick a Piper voice from the online catalogue and downloads it (and, the first time, the engine).
// Only one download at a time: two would write the same files.
let piperDownloadActive = false;
async function downloadPiperVoice(context, firstRun = false) {
  if (piperDownloadActive) {
    vscode.window.showInformationMessage('Claude Push-to-Talk: A voice download is already open or in progress.');
    return;
  }
  piperDownloadActive = true;
  try {
    await pickAndDownloadPiperVoice(context, firstRun);
  } finally {
    piperDownloadActive = false;
  }
}

async function pickAndDownloadPiperVoice(context, firstRun) {
  const engine = PIPER_ENGINE;
  if (!engine) {
    vscode.window.showWarningMessage(`Claude Push-to-Talk: There is no Piper engine for this system (${process.platform}, ${process.arch}).`);
    return;
  }
  fs.mkdirSync(PIPER_VOICES_DIR, { recursive: true });

  let catalogue;
  try {
    catalogue = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Claude Push-to-Talk: Reading the voice list…', cancellable: true },
      async (_progress, token) => {
        const tmp = path.join(PIPER_DIR, 'voices.json.tmp');
        try {
          await download(`${PIPER_VOICES_URL}voices.json`, tmp, { token });
          return JSON.parse(fs.readFileSync(tmp, 'utf8'));
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
    );
  } catch (e) {
    if (e.message !== 'cancelled') vscode.window.showErrorMessage(`Claude Push-to-Talk: Could not read the voice list: ${e.message}`);
    return;
  }

  const installed = installedPiperVoices();
  const items = Object.values(catalogue)
    .filter((v) => v && v.key && v.files && v.language)
    .map((v) => {
      const files = Object.entries(v.files).filter(([name]) => name.endsWith('.onnx') || name.endsWith('.onnx.json'));
      const size = files.reduce((sum, [, f]) => sum + (f.size_bytes || 0), 0);
      const lang = v.language;
      return {
        label: `${lang.name_english} (${lang.country_english})`,
        description: `${v.name}, ${v.quality} quality, ${megabytes(size)}${installed.includes(v.key) ? ' · downloaded' : ''}`,
        voice: v,
        files,
        size,
        card: Object.keys(v.files).find((name) => name.endsWith('MODEL_CARD')),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.description.localeCompare(b.description));
  const picked = await vscode.window.showQuickPick(items, {
    title: firstRun
      ? 'Claude Push-to-Talk: Which voice should read Claude\'s responses aloud?'
      : 'Claude Push-to-Talk: Download a voice',
    placeHolder: firstRun
      ? 'Type your language and pick a voice to download it (Esc: no reading aloud for now)'
      : 'Select the voice to download (type a language to filter)',
    matchOnDescription: true,
    ignoreFocusOut: firstRun,
  });
  if (!picked) return;
  const key = picked.voice.key;

  const needEngine = !fs.existsSync(PIPER_BIN);
  const total = picked.size + (needEngine ? engine.size : 0);
  const licence = picked.card ? await piperVoiceLicence(picked.card) : null;
  const detail = [
    needEngine
      ? `Size: ${megabytes(total)} (speech engine ${megabytes(engine.size)}, voice ${megabytes(picked.size)}).`
      : `Size: ${megabytes(total)}.`,
    `Downloaded from ${needEngine ? 'github.com/rhasspy/piper and ' : ''}huggingface.co/rhasspy/piper-voices to ${PIPER_DIR}.`,
    `Voice licence: ${licence || 'see the model card of the voice'}. Check that it allows your use.`,
    'The voice runs on this computer; nothing you read aloud is sent anywhere.',
  ].join('\n\n');
  const ok = await vscode.window.showInformationMessage(
    `Download the Piper voice "${key}" (${picked.label})?`,
    { modal: true, detail },
    'Download'
  );
  if (ok !== 'Download') return;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Claude Push-to-Talk: Downloading ${key}`, cancellable: true },
      async (progress, token) => {
        const onBytes = (n) => progress.report({ increment: (n / total) * 100 });
        if (needEngine) {
          progress.report({ message: 'speech engine…' });
          const archive = path.join(PIPER_DIR, engine.file);
          await download(PIPER_ENGINE_URL + engine.file, archive, { hash: 'sha256', expected: engine.sha256, onBytes, token });
          fs.rmSync(PIPER_ENGINE_DIR, { recursive: true, force: true });
          fs.mkdirSync(PIPER_ENGINE_DIR, { recursive: true });
          await extractArchive(archive, PIPER_ENGINE_DIR);
          fs.rmSync(archive, { force: true });
          if (!fs.existsSync(PIPER_BIN)) throw new Error('the speech engine archive did not contain the program');
        }
        progress.report({ message: 'voice…' });
        // The small .json goes last: a voice counts as downloaded only when both files are there.
        const files = picked.files.slice().sort((a, b) => b[1].size_bytes - a[1].size_bytes);
        for (const [name, f] of files) {
          await download(PIPER_VOICES_URL + name, path.join(PIPER_VOICES_DIR, path.basename(name)), {
            hash: 'md5', expected: f.md5_digest, onBytes, token,
          });
        }
      }
    );
  } catch (e) {
    if (e.message === 'cancelled') return;
    log(`Voice download failed: ${e.message}`);
    vscode.window.showErrorMessage(`Claude Push-to-Talk: The download failed: ${e.message}`);
    return;
  }
  log(`Piper voice downloaded: ${key}`);

  // The voice that was just downloaded becomes the one that reads.
  await cfg().update('voice', key, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    `Claude Push-to-Talk: ${key} is downloaded and selected as the read-aloud voice. It reads every response, whatever its language.`
  );
}

// Lets the user tick which downloaded Piper voices to delete. When none is left, the speech engine is deleted too.
async function removePiperVoices(context) {
  const voices = installedPiperVoices();
  if (!voices.length) {
    vscode.window.showInformationMessage('Claude Push-to-Talk: There are no downloaded voices.');
    return;
  }
  const current = selectedVoice();
  const items = voices.map((key) => {
    let size = 0;
    try {
      size = fs.statSync(path.join(PIPER_VOICES_DIR, `${key}.onnx`)).size;
    } catch (_) {}
    const lang = voiceDetail({ lang: key.split('-')[0], gender: '' });
    return { label: key, description: `${lang}, ${megabytes(size)}${key === current ? ' · the selected voice' : ''}`, key };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Push-to-Talk: Remove downloaded voices',
    placeHolder: 'Tick the voices to remove, then press Enter',
    canPickMany: true,
  });
  if (!picked || !picked.length) return;
  const keys = picked.map((item) => item.key);
  const all = keys.length === voices.length;
  let detail = keys.join(', ');
  if (all) {
    detail += '\n\nNo voice is left after this, so the speech engine is removed too. ';
    detail += IS_WINDOWS
      ? 'The voices of Windows stay available.'
      : 'Responses are not read aloud again until you download a voice.';
  }
  const ok = await vscode.window.showWarningMessage(
    keys.length === 1 ? `Remove the voice "${keys[0]}"?` : `Remove ${keys.length} voices?`,
    { modal: true, detail },
    'Remove'
  );
  if (ok !== 'Remove') return;
  try {
    if (all) {
      fs.rmSync(PIPER_DIR, { recursive: true, force: true });
    } else {
      for (const key of keys) {
        fs.rmSync(path.join(PIPER_VOICES_DIR, `${key}.onnx`), { force: true });
        fs.rmSync(path.join(PIPER_VOICES_DIR, `${key}.onnx.json`), { force: true });
      }
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Push-to-Talk: Could not remove the voices: ${e.message}`);
    return;
  }
  if (keys.includes(current)) {
    await cfg().update('voice', undefined, vscode.ConfigurationTarget.Global);
  }
  log(`Voices removed: ${keys.join(', ')}${all ? ' (and the speech engine)' : ''}`);
  vscode.window.setStatusBarMessage(keys.length === 1 ? `Voice removed: ${keys[0]}` : `${keys.length} voices removed.`, 3000);
}

// After every response that was not read because no voice is downloaded or selected, tells the user so.
async function notifyNoVoice(context) {
  if (!cfg().get('readAloud', true)) return;
  // Linux has only the downloaded voices; Windows always has its own voices to select from.
  const none = IS_LINUX && !installedPiperVoices().length;
  log(`A response was not read aloud: no voice is ${none ? 'downloaded' : 'selected'}.`);
  const fix = none ? 'Download a voice…' : 'Select a voice…';
  const turnOff = 'Turn read aloud off';
  const choice = await vscode.window.showWarningMessage(
    `Claude Push-to-Talk: The response was not read aloud because no voice is ${none ? 'downloaded' : 'selected'}.`,
    fix,
    turnOff
  );
  if (choice === fix) none ? downloadPiperVoice(context) : pickVoice(context);
  else if (choice === turnOff) await cfg().update('readAloud', false, vscode.ConfigurationTarget.Global);
}

function watchNoVoice(context) {
  fs.watchFile(NO_VOICE_FILE, { interval: 1500 }, (now, before) => {
    if (now.mtimeMs > before.mtimeMs) notifyNoVoice(context);
  });
  context.subscriptions.push({ dispose: () => fs.unwatchFile(NO_VOICE_FILE) });
}

// Asks which voice should read, because without a chosen voice nothing is read aloud.
// The first time the extension runs this is a list to pick from; on later starts it is a warning with a button.
async function chooseFirstVoice(context) {
  if (!(IS_WINDOWS || IS_LINUX) || !context.globalState) return;
  if (!cfg().get('readAloud', true) || selectedVoice()) return;
  const firstRun = !context.globalState.get('firstVoiceAsked');
  if (firstRun) await context.globalState.update('firstVoiceAsked', true);

  // Linux has no voices of its own: the first thing to do is download one.
  if (IS_LINUX && !installedPiperVoices().length) {
    if (!firstRun || !PIPER_ENGINE) return; // on later starts the warning after a response covers it
    await downloadPiperVoice(context, true);
    if (!installedPiperVoices().length) {
      vscode.window.showInformationMessage(
        'Claude Push-to-Talk: No voice was downloaded, so responses are not read aloud. Run "Claude Push-to-Talk: Select Read-Aloud Voice" from the Command Palette when you want one.'
      );
    }
    return;
  }

  // Voices are there (the Windows voices, or downloaded ones) but none is chosen.
  if (firstRun) {
    await pickVoice(context, true);
    if (!selectedVoice()) {
      vscode.window.showInformationMessage(
        'Claude Push-to-Talk: No voice was selected, so responses are not read aloud. Run "Claude Push-to-Talk: Select Read-Aloud Voice" from the Command Palette when you want one.'
      );
    }
    return;
  }
  const select = 'Select a voice…';
  const choice = await vscode.window.showWarningMessage(
    'Claude Push-to-Talk: No read-aloud voice is selected, so responses are not read aloud.',
    select
  );
  if (choice === select) pickVoice(context);
}

// Removes the read-aloud hook as soon as the extension is uninstalled, so responses stop being read right away.
// VS Code has no "uninstalled" event for an extension and keeps running it until the window is reloaded, so the
// list of installed extensions (extensions.json, next to the extension's folder) is watched instead: an uninstall
// takes the extension out of that list, while an update leaves it there with the new version.
function watchUninstall(context) {
  const manifest = path.join(path.dirname(context.extensionPath), 'extensions.json');
  const id = String(context.extension && context.extension.id).toLowerCase();
  const listed = () => {
    const list = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    return Array.isArray(list) && list.some((e) => e && e.identifier && String(e.identifier.id).toLowerCase() === id);
  };
  try {
    // Not in the list to begin with (run from a development folder, or another profile): nothing to watch.
    if (!listed()) return;
  } catch (_) {
    return;
  }
  let done = false;
  fs.watchFile(manifest, { interval: 1500 }, () => {
    if (done) return;
    try {
      if (listed()) return;
    } catch (_) {
      return; // the file is being rewritten; the next change is checked again
    }
    done = true;
    stopSpeaking();
    try {
      log(`The extension was uninstalled; read-aloud hook: ${require('./uninstall.js').removeHook()}.`);
    } catch (e) {
      log(`Could not remove the read-aloud hook: ${e.message}`);
    }
  });
  context.subscriptions.push({ dispose: () => fs.unwatchFile(manifest) });
}

async function toggleSetting(key, label) {
  const c = cfg();
  const next = !c.get(key, true);
  await c.update(key, next, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`${label}: ${next ? 'on' : 'off'}`, 2500);
}

function activate(context) {
  out = vscode.window.createOutputChannel('Claude Push-to-Talk');
  context.subscriptions.push(out);

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(path.join(context.extensionPath, SPEAK_SCRIPT), path.join(DATA_DIR, SPEAK_SCRIPT));
  } catch (e) {
    log(`Could not copy ${SPEAK_SCRIPT}: ${e.message}`);
  }

  writeConfig();
  ensureHook();
  startHelper(context);
  checkVoice().catch((e) => log(`Voice check: ${e.message}`));
  chooseFirstVoice(context);
  watchNoVoice(context);
  watchUninstall(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePushToTalk.dictationKey', onDictationKey),
    vscode.commands.registerCommand('claudePushToTalk.dictationKeyGlobal', onDictationKeyGlobal),
    vscode.commands.registerCommand('claudePushToTalk.cancelDictation', cancelDictation),
    vscode.commands.registerCommand('claudePushToTalk.stopSpeaking', stopSpeaking),
    vscode.commands.registerCommand('claudePushToTalk.pickVoice', () => pickVoice(context)),
    vscode.commands.registerCommand('claudePushToTalk.removeVoices', () => removePiperVoices(context)),
    vscode.commands.registerCommand('claudePushToTalk.toggleReadAloud', async () => {
      await toggleSetting('readAloud', 'Read aloud');
      if (!cfg().get('readAloud', true)) stopSpeaking();
    }),
    vscode.commands.registerCommand('claudePushToTalk.toggleAutoSubmit', () =>
      toggleSetting('autoSubmit', 'Auto-submit')
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudePushToTalk')) {
        writeConfig();
        ensureHook();
      }
      if (e.affectsConfiguration('claudePushToTalk.voice')) checkVoice().catch((err) => log(`Voice check: ${err.message}`));
    })
  );
}

function deactivate() {
  clearTimeout(submitTimer);
  // Closing or reloading the window stops any reading in progress.
  stopSpeaking();
  if (helper) {
    try {
      helper.stdin.end();
      helper.kill();
    } catch (_) {}
  }
}

module.exports = { activate, deactivate };
