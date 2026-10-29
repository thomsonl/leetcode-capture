// COMPANION_HEADLESS: the mode the Native Messaging helper (helper/host.js)
// runs the companion in. No relay of its own, SIGHUP ignored, stdin closing
// ends it, /reset clears the tutor context, and the idle exit when the relay
// is gone. Each case uses its own free port.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function startProcess(t, file, env) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return { child, exited, output: () => out };
}

function companionEnv(scratch, port, extra = {}) {
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');
  return {
    COMPANION_BACKEND: 'local',
    COMPANION_MODEL: 'stub-model',
    COMPANION_BASE_URL: 'http://127.0.0.1:9/v1',
    LEETCODE_CAPTURES_FILE: capturesPath,
    LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
    LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
    LEETCODE_COMPANION_POLL_MS: '100',
    CAPTURE_PORT: String(port),
    CAPTURE_LOG_PATH: capturesPath,
    COMPANION_AUTO_CLEAR_CONTEXT: '1',
    VAULT_AUTO_SUMMARY: '0',
    COMPANION_HEADLESS: '1',
    ...extra,
  };
}

function scratchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-companion-headless-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startRelay(t, scratch, port) {
  const relay = startProcess(t, path.join(__dirname, '..', 'relay-server', 'server.js'), {
    CAPTURE_PORT: String(port),
    CAPTURE_LOG_PATH: path.join(scratch, 'relay-captures.jsonl'),
  });
  await until(() => relay.output().includes('listening'), 5000, 'the relay to listen');
  return relay;
}

test('headless: never starts a relay of its own, and exits when the relay stays away', async (t) => {
  const scratch = scratchDir(t);
  const port = await freePort();
  const companion = startProcess(t, path.join(__dirname, 'companion.js'), companionEnv(scratch, port, { COMPANION_IDLE_EXIT_MS: '800' }));
  const result = await Promise.race([companion.exited, sleep(8000).then(() => null)]);
  assert.ok(result, `the companion should exit on its own; output:\n${companion.output()}`);
  assert.equal(result.code, 0);
  assert.match(companion.output(), /relay is not answering/);
  assert.match(companion.output(), /nothing heard from the relay/);
  // Nothing was left listening on the port.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
});

test('headless: ignores SIGHUP, clears the context on /reset, and exits when stdin closes', async (t) => {
  const scratch = scratchDir(t);
  const port = await freePort();
  await startRelay(t, scratch, port);
  const companion = startProcess(t, path.join(__dirname, 'companion.js'), companionEnv(scratch, port));
  await until(() => companion.output().includes('in-page panel connected') || companion.output().includes('/exit to quit'), 8000, 'the companion to start');
  companion.child.kill('SIGHUP');
  await sleep(400);
  assert.equal(companion.child.exitCode, null, 'SIGHUP must not end a headless companion');
  companion.child.stdin.write('/reset\n');
  await until(() => companion.output().includes('tutor context cleared'), 5000, 'the reset');
  companion.child.stdin.end();
  const result = await Promise.race([companion.exited, sleep(5000).then(() => null)]);
  assert.ok(result, 'closing stdin ends the companion');
  assert.equal(result.code, 0);
});

test('not headless: SIGHUP still ends the companion (a closed terminal)', async (t) => {
  const scratch = scratchDir(t);
  const port = await freePort();
  await startRelay(t, scratch, port);
  const companion = startProcess(t, path.join(__dirname, 'companion.js'), companionEnv(scratch, port, { COMPANION_HEADLESS: '0' }));
  await until(() => companion.output().includes('/exit to quit'), 8000, 'the companion to start');
  companion.child.kill('SIGHUP');
  const result = await Promise.race([companion.exited, sleep(5000).then(() => null)]);
  assert.ok(result, 'SIGHUP ends a terminal companion');
});
