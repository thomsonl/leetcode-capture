// Registers (and unregisters) the helper with the browsers, for the current
// user only, with no admin rights.
//
// What install writes, all of it listed in a receipt so uninstall removes
// exactly that and nothing else:
//   - a private copy of the host (host.js, framing.js, config.js) in the data
//     folder, so clearing the npx cache does not break the browser's launch,
//     plus helper-config.json recording where the companion and relay live;
//   - a wrapper script that runs that copy with the node that ran install;
//   - one registration file per browser (Native Messaging "host manifest"),
//     and on Windows one registry value per browser pointing at it.
//
// Every location comes from layout(), which takes the platform, home folder
// and environment as arguments, and the registry is reached only through the
// `reg` function passed in, so tests run everything in a temporary folder
// with a fake registry.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHROME_EXTENSION_IDS, CHROME_ID_RE, GECKO_ID, HOST_DESCRIPTION, HOST_NAME, VERSION } from './config.js';
import { checkRoot } from './host.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_FILES = ['host.js', 'framing.js', 'config.js'];
const RECEIPT = 'install-receipt.json';

// Each browser: where its per-user registrations live. `profile` is the
// folder that shows the browser is installed (Linux and macOS); Windows
// registers in the registry for every browser, since the key alone is cheap
// and uninstall removes it again.
const BROWSERS = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    kind: 'chromium',
    linux: '.config/google-chrome',
    darwin: 'Library/Application Support/Google/Chrome',
    win32: 'Software\\Google\\Chrome\\NativeMessagingHosts',
  },
  {
    id: 'chromium',
    label: 'Chromium',
    kind: 'chromium',
    linux: '.config/chromium',
    darwin: 'Library/Application Support/Chromium',
    win32: 'Software\\Chromium\\NativeMessagingHosts',
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    kind: 'chromium',
    linux: '.config/microsoft-edge',
    darwin: 'Library/Application Support/Microsoft Edge',
    win32: 'Software\\Microsoft\\Edge\\NativeMessagingHosts',
  },
  {
    id: 'brave',
    label: 'Brave',
    kind: 'chromium',
    linux: '.config/BraveSoftware/Brave-Browser',
    darwin: 'Library/Application Support/BraveSoftware/Brave-Browser',
    win32: 'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  },
  {
    id: 'firefox',
    label: 'Firefox',
    kind: 'firefox',
    linux: '.mozilla',
    darwin: 'Library/Application Support/Mozilla',
    win32: 'Software\\Mozilla\\NativeMessagingHosts',
  },
];

export const BROWSER_IDS = BROWSERS.map((b) => b.id);

export function layout({ platform = process.platform, home, env = process.env }) {
  if (!home) throw new Error('layout needs a home folder');
  let dataDir;
  if (platform === 'win32') dataDir = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'leetcode-capture-helper');
  else if (platform === 'darwin') dataDir = path.join(home, 'Library', 'Application Support', 'leetcode-capture-helper');
  else if (platform === 'linux') dataDir = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'leetcode-capture-helper');
  else throw new Error(`unsupported platform ${platform}`);
  const targets = BROWSERS.map((b) => {
    if (platform === 'win32') {
      return { ...b, regKey: `HKCU\\${b.win32}\\${HOST_NAME}`, manifestPath: path.join(dataDir, `${HOST_NAME}.${b.kind}.json`) };
    }
    const profile = path.join(home, platform === 'darwin' ? b.darwin : b.linux);
    // Firefox keeps registrations beside the profile folder, not inside it,
    // and calls the folder differently on each OS.
    const dir =
      b.kind === 'firefox'
        ? path.join(profile, platform === 'darwin' ? 'NativeMessagingHosts' : 'native-messaging-hosts')
        : path.join(profile, 'NativeMessagingHosts');
    return { ...b, profile, manifestDir: dir, manifestPath: path.join(dir, `${HOST_NAME}.json`) };
  });
  const wrapper = path.join(dataDir, platform === 'win32' ? 'leetcode-capture-helper.cmd' : 'leetcode-capture-helper.sh');
  return { platform, dataDir, appDir: path.join(dataDir, 'app'), wrapper, receipt: path.join(dataDir, RECEIPT), targets };
}

export function defaultReg(args) {
  const result = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || (result.error ? result.error.message : '') };
}

function manifestFor(target, wrapper, chromeIds) {
  const base = { name: HOST_NAME, description: HOST_DESCRIPTION, path: wrapper, type: 'stdio' };
  return target.kind === 'firefox'
    ? { ...base, allowed_extensions: [GECKO_ID] }
    : { ...base, allowed_origins: chromeIds.map((id) => `chrome-extension://${id}/`) };
}

// Single quotes for sh: only a single quote itself needs care.
const shQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

function wrapperText(platform, nodePath, hostPath) {
  if (platform === 'win32') return `@echo off\r\n"${nodePath}" "${hostPath}" %*\r\n`;
  return `#!/bin/sh\n# LeetCode Capture helper: written by \`leetcode-capture-helper install\`.\nexec ${shQuote(nodePath)} ${shQuote(hostPath)} "$@"\n`;
}

function readReceipt(where) {
  try {
    return JSON.parse(fs.readFileSync(where.receipt, 'utf8'));
  } catch {
    return null;
  }
}

// Creates `dir` and its missing parents, and returns the ones it created
// (outermost first) so uninstall can remove exactly those.
function mkdirTracked(dir) {
  const created = [];
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    created.unshift(current);
    current = path.dirname(current);
  }
  fs.mkdirSync(dir, { recursive: true });
  return created;
}

export function normalizeChromeIds(ids) {
  const all = [...CHROME_EXTENSION_IDS, ...(ids || [])].map((id) => String(id).trim());
  for (const id of all) {
    if (!CHROME_ID_RE.test(id)) throw new Error(`"${id}" is not a Chrome extension id (32 letters from a to p)`);
  }
  return [...new Set(all)];
}

export function install({
  platform = process.platform,
  home,
  env = process.env,
  nodePath = process.execPath,
  root,
  chromeIds = [],
  browsers = null,
  reg = defaultReg,
  sourceDir = HERE,
}) {
  const where = layout({ platform, home, env });
  const rootError = checkRoot(root);
  if (rootError) throw new Error(rootError);
  const ids = normalizeChromeIds(chromeIds);
  const wanted = browsers ? new Set(browsers) : null;
  for (const id of wanted || []) if (!BROWSER_IDS.includes(id)) throw new Error(`unknown browser "${id}" (one of ${BROWSER_IDS.join(', ')})`);

  // A reinstall starts from a clean slate.
  const previous = readReceipt(where);
  if (previous) uninstall({ platform, home, env, reg });

  const receipt = { version: VERSION, platform, files: [], dirs: [], registry: [] };
  const notes = [];
  const writeFile = (file, text, mode) => {
    receipt.dirs.push(...mkdirTracked(path.dirname(file)));
    fs.writeFileSync(file, text, mode ? { mode } : undefined);
    if (mode) fs.chmodSync(file, mode);
    receipt.files.push(file);
  };

  try {
    for (const name of APP_FILES) writeFile(path.join(where.appDir, name), fs.readFileSync(path.join(sourceDir, name)));
    writeFile(path.join(where.appDir, 'package.json'), `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`);
    writeFile(path.join(where.appDir, 'helper-config.json'), `${JSON.stringify({ root: path.resolve(root) }, null, 2)}\n`);
    writeFile(where.wrapper, wrapperText(platform, nodePath, path.join(where.appDir, 'host.js')), platform === 'win32' ? undefined : 0o755);

    const registered = [];
    for (const target of where.targets) {
      if (wanted && !wanted.has(target.id)) continue;
      if (target.kind === 'chromium' && ids.length === 0) {
        if (wanted) notes.push(`${target.label}: skipped, no extension id (pass --chrome-id <id>, shown in the extension's settings)`);
        continue;
      }
      if (platform !== 'win32' && !wanted && !fs.existsSync(target.profile)) continue;
      writeFile(target.manifestPath, `${JSON.stringify(manifestFor(target, where.wrapper, ids), null, 2)}\n`);
      if (platform === 'win32') {
        const result = reg(['add', target.regKey, '/ve', '/t', 'REG_SZ', '/d', target.manifestPath, '/f']);
        if (result.status !== 0) throw new Error(`could not register with ${target.label}: ${result.stderr.trim() || 'reg add failed'}`);
        receipt.registry.push(target.regKey);
      }
      registered.push(target.label);
    }
    if (ids.length === 0) {
      notes.push('Chrome, Chromium, Edge and Brave were not registered: pass --chrome-id <id> (the options page shows the command with it)');
    }
    if (registered.length === 0) notes.push('No browser was registered.');
    if (path.resolve(root).split(path.sep).includes('_npx')) {
      notes.push(
        `The companion and relay run from npx's cache (${path.resolve(root)}). If that cache is cleared, run this install command again; for a lasting copy, run \`npm install -g leetcode-capture-helper\` and then \`leetcode-capture-helper install\`.`,
      );
    }
    // Uninstall must also be able to remove the receipt and the folders.
    receipt.dirs.push(...mkdirTracked(where.dataDir));
    fs.writeFileSync(where.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
    return { registered, notes, dataDir: where.dataDir, wrapper: where.wrapper };
  } catch (err) {
    // Leave nothing half-written behind.
    receipt.dirs.push(...mkdirTracked(where.dataDir));
    fs.writeFileSync(where.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
    uninstall({ platform, home, env, reg });
    throw err;
  }
}

export function uninstall({ platform = process.platform, home, env = process.env, reg = defaultReg }) {
  const where = layout({ platform, home, env });
  const receipt = readReceipt(where);
  if (!receipt) return { removed: [], nothing: true };
  const removed = [];
  for (const key of receipt.registry || []) {
    reg(['delete', key, '/f']);
    removed.push(key);
  }
  for (const file of receipt.files || []) {
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  fs.rmSync(where.receipt, { force: true });
  // Folders install created, innermost first, and only while empty (a folder
  // something else has since put files in stays).
  const dirs = [...new Set(receipt.dirs || [])].sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
      removed.push(dir);
    } catch {
      // not empty, or already gone
    }
  }
  return { removed, nothing: false };
}

export function status({ platform = process.platform, home, env = process.env, reg = defaultReg }) {
  const where = layout({ platform, home, env });
  const receipt = readReceipt(where);
  const browsers = where.targets.map((target) => {
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(target.manifestPath, 'utf8'));
    } catch {
      // not registered
    }
    let registered = Boolean(manifest) && manifest.path === where.wrapper;
    if (registered && platform === 'win32') {
      const result = reg(['query', target.regKey, '/ve']);
      registered = result.status === 0 && result.stdout.includes(target.manifestPath);
    }
    const allowed = manifest ? manifest.allowed_origins || manifest.allowed_extensions || [] : [];
    return { id: target.id, label: target.label, registered, allowed: registered ? allowed : [] };
  });
  let root = null;
  try {
    root = JSON.parse(fs.readFileSync(path.join(where.appDir, 'helper-config.json'), 'utf8')).root;
  } catch {
    // not installed
  }
  return {
    installed: Boolean(receipt) && fs.existsSync(where.wrapper),
    version: receipt ? receipt.version : null,
    dataDir: where.dataDir,
    root,
    rootError: root ? checkRoot(root) : null,
    browsers,
  };
}
