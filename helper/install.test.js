// The installer, run entirely inside temporary folders: a fake home for each
// OS layout and a fake reg.exe for Windows. Nothing here touches the real
// browser folders or registry.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_NAME, GECKO_ID } from './config.js';
import { install, layout, status, uninstall } from './install.js';
import { parseArgs, run } from './cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ID = 'abcdefghijklmnopabcdefghijklmnop';

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-helper-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// Every file and folder under `dir`, relative, sorted.
function tree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

function fakeReg() {
  const keys = new Map();
  const calls = [];
  const reg = (args) => {
    calls.push(args);
    const [op, key] = args;
    if (op === 'add') {
      keys.set(key, args[args.indexOf('/d') + 1]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (op === 'delete') return { status: keys.delete(key) ? 0 : 1, stdout: '', stderr: '' };
    if (op === 'query') {
      return keys.has(key)
        ? { status: 0, stdout: `${key}\n    (Default)    REG_SZ    ${keys.get(key)}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: 'not found' };
    }
    return { status: 1, stdout: '', stderr: 'bad op' };
  };
  return { reg, keys, calls };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('layout: Linux, macOS and Windows locations', () => {
  const linux = layout({ platform: 'linux', home: '/h', env: {} });
  assert.equal(linux.dataDir, path.join('/h', '.local/share/leetcode-capture-helper'));
  assert.equal(linux.targets.find((x) => x.id === 'chrome').manifestPath, path.join('/h', `.config/google-chrome/NativeMessagingHosts/${HOST_NAME}.json`));
  assert.equal(linux.targets.find((x) => x.id === 'firefox').manifestPath, path.join('/h', `.mozilla/native-messaging-hosts/${HOST_NAME}.json`));
  assert.equal(layout({ platform: 'linux', home: '/h', env: { XDG_DATA_HOME: '/d' } }).dataDir, path.join('/d', 'leetcode-capture-helper'));

  const mac = layout({ platform: 'darwin', home: '/h', env: {} });
  assert.equal(mac.targets.find((x) => x.id === 'edge').manifestPath, path.join('/h', `Library/Application Support/Microsoft Edge/NativeMessagingHosts/${HOST_NAME}.json`));
  assert.equal(mac.targets.find((x) => x.id === 'firefox').manifestPath, path.join('/h', `Library/Application Support/Mozilla/NativeMessagingHosts/${HOST_NAME}.json`));
  assert.equal(mac.targets.find((x) => x.id === 'brave').manifestPath, path.join('/h', `Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/${HOST_NAME}.json`));

  const win = layout({ platform: 'win32', home: '/h', env: { LOCALAPPDATA: '/l' } });
  assert.equal(win.dataDir, path.join('/l', 'leetcode-capture-helper'));
  assert.equal(win.wrapper, path.join('/l', 'leetcode-capture-helper', 'leetcode-capture-helper.cmd'));
  assert.equal(win.targets.find((x) => x.id === 'chrome').regKey, `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);
  assert.equal(win.targets.find((x) => x.id === 'firefox').regKey, `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`);
  assert.throws(() => layout({ platform: 'aix', home: '/h' }), /unsupported/);
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: install registers the browsers that are there, and uninstall removes exactly that`, (t) => {
    const home = tempHome(t);
    const where = layout({ platform, home, env: {} });
    const chrome = where.targets.find((x) => x.id === 'chrome');
    const firefox = where.targets.find((x) => x.id === 'firefox');
    // Chrome and Firefox are "installed"; the user also has a file of their own there.
    fs.mkdirSync(chrome.profile, { recursive: true });
    fs.mkdirSync(firefox.profile, { recursive: true });
    fs.writeFileSync(path.join(chrome.profile, 'Preferences'), '{}');
    const before = tree(home);

    const result = install({ platform, home, env: {}, nodePath: '/opt/node 26/bin/node', root: REPO, chromeIds: [ID] });
    assert.deepEqual(result.registered, ['Google Chrome', 'Firefox']);

    const chromeManifest = readJson(chrome.manifestPath);
    assert.equal(chromeManifest.name, HOST_NAME);
    assert.equal(chromeManifest.type, 'stdio');
    assert.equal(chromeManifest.path, where.wrapper);
    assert.deepEqual(chromeManifest.allowed_origins, [`chrome-extension://${ID}/`]);
    assert.deepEqual(readJson(firefox.manifestPath).allowed_extensions, [GECKO_ID]);
    assert.equal(fs.existsSync(where.targets.find((x) => x.id === 'edge').manifestPath), false);

    const wrapper = fs.readFileSync(where.wrapper, 'utf8');
    assert.match(wrapper, /^#!\/bin\/sh\n/);
    assert.ok(wrapper.includes(`exec '/opt/node 26/bin/node' '${path.join(where.appDir, 'host.js')}' "$@"`));
    assert.equal(fs.statSync(where.wrapper).mode & 0o777, 0o755);
    for (const name of ['host.js', 'framing.js', 'config.js', 'package.json']) assert.ok(fs.existsSync(path.join(where.appDir, name)), name);
    assert.equal(readJson(path.join(where.appDir, 'helper-config.json')).root, REPO);

    const s = status({ platform, home, env: {} });
    assert.equal(s.installed, true);
    assert.equal(s.root, REPO);
    assert.equal(s.rootError, null);
    assert.deepEqual(s.browsers.filter((b) => b.registered).map((b) => b.id), ['chrome', 'firefox']);

    // Installing again replaces, never duplicates.
    install({ platform, home, env: {}, nodePath: '/usr/bin/node', root: REPO, chromeIds: [ID] });
    uninstall({ platform, home, env: {} });
    assert.deepEqual(tree(home), before);
    assert.equal(status({ platform, home, env: {} }).installed, false);
  });
}

test('linux: --browser registers even without the profile folder, and no id means no Chromium-family file', (t) => {
  const home = tempHome(t);
  const result = install({ platform: 'linux', home, env: {}, root: REPO, browsers: ['firefox', 'chrome'] });
  assert.deepEqual(result.registered, ['Firefox']);
  assert.ok(result.notes.some((n) => /Google Chrome: skipped/.test(n)));
  uninstall({ platform: 'linux', home, env: {} });
  assert.deepEqual(tree(home), []);
});

test("a root inside npx's cache gets a note on how to keep it", (t) => {
  const home = tempHome(t);
  const root = path.join(home, '.npm', '_npx', 'abc123', 'node_modules', 'leetcode-capture-helper', 'runtime');
  for (const rel of ['companion/companion.js', 'relay-server/server.js']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '');
  }
  const result = install({ platform: 'linux', home, env: {}, root, browsers: ['firefox'] });
  assert.ok(result.notes.some((n) => n.includes("npx's cache") && n.includes('npm install -g')), result.notes.join('\n'));
  assert.ok(!install({ platform: 'linux', home, env: {}, root: REPO, browsers: ['firefox'] }).notes.some((n) => n.includes('npx')));
});

test('the copied host runs from the data folder with the recorded root', async (t) => {
  const home = tempHome(t);
  install({ platform: 'linux', home, env: {}, root: REPO, browsers: ['firefox'] });
  const where = layout({ platform: 'linux', home, env: {} });
  const { resolveRoot, checkRoot } = await import(path.join(where.appDir, 'host.js'));
  assert.equal(resolveRoot({}, where.appDir), REPO);
  assert.equal(checkRoot(resolveRoot({}, where.appDir)), null);
});

test('windows: manifests in LOCALAPPDATA, per-user registry values, a .cmd wrapper, and a clean uninstall', (t) => {
  const home = tempHome(t);
  const env = { LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  const { reg, keys } = fakeReg();
  const result = install({ platform: 'win32', home, env, nodePath: 'C:\\Program Files\\nodejs\\node.exe', root: REPO, chromeIds: [ID], reg });
  assert.deepEqual(result.registered, ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave', 'Firefox']);
  const where = layout({ platform: 'win32', home, env });
  assert.equal(keys.size, 5);
  for (const key of keys.keys()) assert.match(key, /^HKCU\\Software\\/);
  assert.equal(keys.get(`HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`), path.join(where.dataDir, `${HOST_NAME}.firefox.json`));
  assert.deepEqual(readJson(path.join(where.dataDir, `${HOST_NAME}.chromium.json`)).allowed_origins, [`chrome-extension://${ID}/`]);
  const wrapper = fs.readFileSync(where.wrapper, 'utf8');
  assert.equal(wrapper, `@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "${path.join(where.appDir, 'host.js')}" %*\r\n`);
  assert.equal(status({ platform: 'win32', home, env, reg }).browsers.every((b) => b.registered), true);

  uninstall({ platform: 'win32', home, env, reg });
  assert.equal(keys.size, 0);
  assert.deepEqual(tree(home), []);
});

test('windows: a failed registry write undoes everything', (t) => {
  const home = tempHome(t);
  const env = { LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  const fake = fakeReg();
  let adds = 0;
  const reg = (args) => (args[0] === 'add' && ++adds === 3 ? { status: 1, stdout: '', stderr: 'Access is denied.' } : fake.reg(args));
  assert.throws(() => install({ platform: 'win32', home, env, root: REPO, chromeIds: [ID], reg }), /Access is denied/);
  assert.equal(fake.keys.size, 0);
  assert.deepEqual(tree(home), []);
});

test('bad input is refused before anything is written', (t) => {
  const home = tempHome(t);
  assert.throws(() => install({ platform: 'linux', home, env: {}, root: REPO, chromeIds: ['not-an-id'] }), /not a Chrome extension id/);
  assert.throws(() => install({ platform: 'linux', home, env: {}, root: home }), /missing/);
  assert.throws(() => install({ platform: 'linux', home, env: {}, root: REPO, browsers: ['netscape'] }), /unknown browser/);
  assert.deepEqual(tree(home), []);
});

test('cli: parses flags and runs against the layer it is given', (t) => {
  assert.deepEqual(parseArgs(['install', '--chrome-id', `${ID},${ID}`, '--browser', 'chrome']), {
    command: 'install',
    chromeIds: [ID, ID],
    browsers: ['chrome'],
    root: null,
  });
  assert.throws(() => parseArgs(['install', '--chrome-id']), /needs a value/);
  const home = tempHome(t);
  const lines = [];
  const print = (line) => lines.push(line);
  assert.equal(run(['install', '--browser', 'firefox', '--root', REPO], { home, env: {}, platform: 'linux', print }), 0);
  assert.match(lines.join('\n'), /Registered the LeetCode Capture helper with: Firefox/);
  assert.equal(run(['status'], { home, env: {}, platform: 'linux', print }), 0);
  assert.match(lines.join('\n'), /Firefox: registered for leetcode-capture@thomsonklee.dev/);
  assert.equal(run(['uninstall'], { home, env: {}, platform: 'linux', print }), 0);
  assert.deepEqual(tree(home), []);
  assert.equal(run(['frobnicate'], { home, env: {}, platform: 'linux', print }), 2);
  assert.equal(run(['install', '--bogus', 'x'], { home, env: {}, platform: 'linux', print }), 2);
});
