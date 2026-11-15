// Claude Push-to-Talk - removes the read-aloud Stop hook that the extension added to ~/.claude/settings.json,
// leaving the rest of the file alone. (Installing the extension again adds the hook again, see ensureHook in extension.js.)
// Used in two ways:
//   - by extension.js, which notices the uninstall while VS Code is open and removes the hook right away;
//   - as the "vscode:uninstall" script in package.json, which VS Code runs with its own Node.js the next time
//     it starts after the uninstall (for an uninstall done while VS Code was closed). No VS Code API here.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

// A hook that runs the push-to-talk speak script (same test as in extension.js).
function isOurs(hook) {
  return Boolean(hook) && /push-to-talk[\\/]+speak\.(ps1|py)/.test(String(hook.command));
}

function removeHook() {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (_) {
    return 'settings file missing or not valid JSON; nothing changed';
  }
  const hooks = settings && settings.hooks;
  const stop = hooks && hooks.Stop;
  if (!Array.isArray(stop)) return 'no Stop hooks; nothing changed';

  let removed = 0;
  const kept = [];
  for (const group of stop) {
    if (!group || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const others = group.hooks.filter((h) => !isOurs(h));
    removed += group.hooks.length - others.length;
    if (others.length === group.hooks.length) kept.push(group);
    else if (others.length) kept.push(Object.assign({}, group, { hooks: others }));
    // a group that held only our hook is dropped
  }
  if (!removed) return 'hook not found; nothing changed';

  if (kept.length) hooks.Stop = kept;
  else delete hooks.Stop;
  if (!Object.keys(hooks).length) delete settings.hooks;

  const tmp = `${SETTINGS_FILE}.push-to-talk.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return `removed ${removed} hook${removed === 1 ? '' : 's'}`;
}

module.exports = { removeHook };

if (require.main === module) {
  try {
    console.log(`claude-push-to-talk uninstall: ${removeHook()}`);
  } catch (e) {
    console.log(`claude-push-to-talk uninstall: ${e.message}`);
  }
}
