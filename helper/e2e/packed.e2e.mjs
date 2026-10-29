#!/usr/bin/env node
// The npm package, for real: `npm pack`, extract the tarball, install its
// dependencies, run its installer into a temporary home, then start the
// registered host the way a browser would (the wrapper the registration
// names, framed messages on stdio) and check that the relay and the headless
// companion come up from the bundled copy on a free port, keep their data in
// the helper's folder, and stop when stdin closes.
//
//   node e2e/packed.e2e.mjs [--link-deps]
//
// --link-deps skips `npm install` and links the checkout's
// companion/node_modules instead (for working offline). Without it, a failed
// install (no network) falls back to the same link and says so.
// Nothing outside the temporary folder is written: HOME and XDG_DATA_HOME
// point into it, so no real browser registration is ever touched.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDecoder, encodeMessage } from '../framing.js';
import { HOST_NAME } from '../config.js';

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HELPER, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(predicate, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-helper-packed-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
let host = null;
let childPids = [];

try {
  // 1. Pack (prepack builds runtime/, postpack removes it again).
  const packDir = path.join(tmp, 'pack');
  fs.mkdirSync(packDir);
  // npm up to 10 prints an array, later versions an object keyed by name.
  const report = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: HELPER }));
  const packed = Array.isArray(report) ? report[0] : Object.values(report)[0];
  const tarball = path.join(packDir, packed.filename);
  const listed = packed.files.map((f) => f.path);
  check('the tarball carries the bundled companion, relay and shared modules', () => {
    for (const rel of ['cli.js', 'host.js', 'runtime/bundle.json', 'runtime/companion/companion.js', 'runtime/relay-server/server.js', 'runtime/extension/shared/context-summary.js', 'runtime/vault-tool/vault-notes.js']) {
      assert.ok(listed.includes(rel), `${rel} is missing from the tarball`);
    }
    assert.ok(!listed.some((f) => f.endsWith('.test.js') || f.includes('/data/') || f.startsWith('scripts/') || f.startsWith('e2e/')), 'no tests, data or build scripts');
  });
  check('postpack left no runtime/ in the checkout', () => assert.equal(fs.existsSync(path.join(HELPER, 'runtime')), false));

  // 2. Extract, the way npm would, and install the dependencies.
  const extractDir = path.join(tmp, 'extract');
  fs.mkdirSync(extractDir);
  run('tar', ['-xzf', tarball, '-C', extractDir]);
  const pkg = path.join(extractDir, 'package');
  let depsNote = 'installed with npm install --omit=dev';
  const link = () => fs.symlinkSync(fs.realpathSync(path.join(REPO, 'companion', 'node_modules')), path.join(pkg, 'node_modules'), 'dir');
  if (process.argv.includes('--link-deps')) {
    link();
    depsNote = 'linked from the checkout (--link-deps)';
  } else {
    const install = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: pkg, encoding: 'utf8', timeout: 600000 });
    if (install.status !== 0) {
      fs.rmSync(path.join(pkg, 'node_modules'), { recursive: true, force: true });
      link();
      depsNote = `npm install failed (${(install.stderr || install.error?.message || '').trim().split('\n').pop()}), so they are linked from the checkout instead`;
    }
  }
  results.push(`note dependencies ${depsNote}`);
  check("the bundled companion resolves its packages from the package's own node_modules", () => {
    const req = createRequire(path.join(pkg, 'runtime', 'companion', 'companion.js'));
    for (const name of ['@anthropic-ai/claude-agent-sdk', 'chalk', 'marked', 'marked-terminal']) {
      const where = fs.realpathSync(req.resolve(name));
      const allowed = [fs.realpathSync(path.join(pkg, 'node_modules'))];
      assert.ok(allowed.some((dir) => where.startsWith(dir)), `${name} resolved to ${where}`);
    }
  });

  // 3. Install into the temporary home with no --root.
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share') };
  for (const key of ['LEETCODE_CAPTURE_ROOT', 'CAPTURE_LOG_PATH', 'LEETCODE_CAPTURES_FILE', 'LEETCODE_COMPANION_STATE_FILE', 'LEETCODE_CAPTURE_HELPER_LOG_DIR']) delete env[key];
  // Through a symlink, as npx and a global install run the bin.
  const bin = path.join(tmp, 'bin', 'leetcode-capture-helper');
  fs.mkdirSync(path.dirname(bin));
  fs.symlinkSync(path.join(pkg, 'cli.js'), bin);
  const out = run(bin, ['install', '--browser', 'firefox'], { env, cwd: tmp });
  const manifestPath = path.join(home, '.mozilla', 'native-messaging-hosts', `${HOST_NAME}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const appDir = path.join(home, '.local', 'share', 'leetcode-capture-helper', 'app');
  const runtime = path.join(pkg, 'runtime');
  check('install registers Firefox in the temporary home', () => assert.match(out, /Registered the LeetCode Capture helper with: Firefox/));
  check('install records the bundled copy as the root', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, 'helper-config.json'), 'utf8')).root, runtime);
  });

  // 4. Start the host as the browser would, with a fake client on stdio.
  const port = await freePort();
  const scratch = path.join(tmp, 'scratch');
  host = spawn(manifest.path, [manifestPath, 'leetcode-capture@thomsonklee.dev'], {
    env: {
      ...env,
      CAPTURE_PORT: String(port),
      LEETCODE_CAPTURE_SETTINGS: path.join(scratch, 'settings.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'companion'),
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: 'http://127.0.0.1:9/v1',
      VAULT_AUTO_SUMMARY: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const received = [];
  const decoder = createDecoder({ onMessage: (m) => received.push(m), onError: (e) => received.push({ decodeError: e.message }) });
  host.stdout.on('data', (c) => decoder.push(c));
  const exited = new Promise((resolve) => host.on('exit', (code, signal) => resolve({ code, signal })));
  const request = async (message) => {
    host.stdin.write(encodeMessage(message));
    await waitFor(() => received.some((m) => m.id === message.id), `an answer to ${message.type}`, 15000);
    return received.find((m) => m.id === message.id);
  };

  const pong = await request({ type: 'ping', id: 0 });
  check('the host answers a ping', () => assert.equal(pong.type, 'pong'));
  const status = await request({ type: 'start', id: 1 });
  childPids = [status.relay?.pid, status.companion?.pid].filter(Boolean);
  check('start brings up the relay and the companion from the bundled copy', () => {
    assert.equal(status.relay.state, 'running', JSON.stringify(status));
    assert.equal(status.companion.state, 'running');
    assert.equal(status.root, runtime);
    assert.equal(status.port, port);
  });
  if (process.platform === 'linux') {
    check('the children run in the bundled folders', () => {
      assert.equal(fs.readlinkSync(`/proc/${status.relay.pid}/cwd`), path.join(runtime, 'relay-server'));
      assert.equal(fs.readlinkSync(`/proc/${status.companion.pid}/cwd`), path.join(runtime, 'companion'));
    });
  }
  const posted = await fetch(`http://127.0.0.1:${port}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problemSlug: 'two-sum', language: 'python3', code: 'pass', trigger: 'run', timestamp: new Date().toISOString() }),
  });
  check('the relay on the free port takes a capture', () => assert.equal(posted.status, 200));
  const dataDir = path.join(appDir, 'data');
  await waitFor(() => fs.existsSync(path.join(dataDir, 'companion-state.json')), 'the companion to save its state').catch(() => {});
  check("the capture log and companion state are in the helper's folder, not the package", () => {
    assert.ok(fs.existsSync(path.join(dataDir, 'captures.jsonl')), 'captures.jsonl');
    assert.ok(fs.existsSync(path.join(dataDir, 'companion-state.json')), 'companion-state.json');
    assert.equal(fs.existsSync(path.join(runtime, 'relay-server', 'data')), false);
    assert.equal(fs.existsSync(path.join(runtime, 'companion', '.companion-state.json')), false);
  });
  await sleep(500);
  check('both children are still up', () => assert.ok(childPids.every(isAlive)));

  // 5. The browser goes away: stdin closes.
  host.stdin.end();
  const result = await Promise.race([exited, sleep(10000).then(() => null)]);
  check('the host exits when stdin closes', () => assert.ok(result, 'still running after 10 s'));
  await waitFor(() => childPids.every((pid) => !isAlive(pid)), 'the children to exit').catch(() => {});
  check('the relay and companion stop with it', () => assert.deepEqual(childPids.filter(isAlive), []));
  const free = await portFree(port);
  check('the relay port is released', () => assert.equal(free, true));

  // 6. Uninstall leaves no registration behind.
  run(bin, ['uninstall'], { env, cwd: tmp });
  check('uninstall removes the registration', () => assert.equal(fs.existsSync(manifestPath), false));
} catch (err) {
  results.push(`FAIL ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (host && host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
  // Only the pids this run's host reported as its own children.
  for (const pid of childPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  const log = path.join(home, '.local', 'share', 'leetcode-capture-helper', 'app', 'helper.log');
  if (process.exitCode && fs.existsSync(log)) results.push(`helper.log:\n${fs.readFileSync(log, 'utf8').slice(-4000)}`);
  fs.rmSync(path.join(HELPER, 'runtime'), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.filter((r) => r.startsWith('ok')).length} passed, ${failed} failed`);
