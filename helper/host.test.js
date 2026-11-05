import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDecoder, encodeMessage } from './framing.js';
import { checkRoot, createHost, resolveRoot } from './host.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeChild extends EventEmitter {
  constructor(pid, { ignoresTerm = false } = {}) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
    this.ignoresTerm = ignoresTerm;
    this.stdinText = '';
    this.stdin = new PassThrough();
    this.stdin.on('data', (c) => (this.stdinText += c));
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.ignoresTerm) return true;
    this.die(signal);
    return true;
  }

  die(signal = null, code = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.exitCode = code;
    setImmediate(() => this.emit('exit', code, signal));
  }
}

function setup({ relayAlreadyUp = false, ignoresTerm = false, rootError = null, idleMs = 60000, panelStatus = null } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const received = [];
  const decoder = createDecoder({ onMessage: (m) => received.push(m), onError: (e) => received.push({ decodeError: e.message }) });
  output.on('data', (c) => decoder.push(c));
  const spawned = [];
  let relayListening = relayAlreadyUp;
  const fetches = [];
  let clock = 1000;
  const intervals = [];
  const exits = [];
  const host = createHost({
    input,
    output,
    root: '/repo',
    env: { CAPTURE_PORT: '18999', KEEP: 'me' },
    execPath: '/usr/bin/node',
    spawn: (command, args, options) => {
      const child = new FakeChild(100 + spawned.length, { ignoresTerm });
      spawned.push({ command, args, options, child });
      if (options.cwd.endsWith('relay-server')) relayListening = true;
      return child;
    },
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      if (url.endsWith('/capture') && !relayListening) throw new Error('ECONNREFUSED');
      if (url.includes('/panel/events') && panelStatus !== null) {
        const chunk = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'status', companionOnline: panelStatus })}\n\n`);
        let sent = false;
        return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: chunk })) }) } };
      }
      return { ok: true, status: 204 };
    },
    now: () => clock,
    timers: {
      setTimeout,
      clearTimeout,
      setInterval: (fn, ms) => {
        intervals.push({ fn, ms });
        return intervals.length;
      },
      clearInterval: () => {},
    },
    exit: (code) => exits.push(code),
    idleMs,
    keepaliveMs: 1000,
    reviveMs: 0,
    stopTimeoutMs: 50,
    rootError,
  });
  const request = async (message) => {
    const before = received.length;
    input.write(encodeMessage(message));
    for (let i = 0; i < 100; i += 1) {
      const reply = received.slice(before).find((m) => m.id === message.id);
      if (reply) return reply;
      // eslint-disable-next-line no-await-in-loop
      await sleep(5);
    }
    throw new Error(`no answer to ${JSON.stringify(message)}`);
  };
  return {
    host,
    input,
    received,
    spawned,
    fetches,
    exits,
    request,
    tick: () => intervals.forEach((i) => i.fn()),
    setRelayListening: (on) => (relayListening = on),
    advance: (ms) => (clock += ms),
  };
}

async function waitFor(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('ping answers pong with the id', async () => {
  const h = setup();
  const reply = await h.request({ type: 'ping', id: 7 });
  assert.equal(reply.type, 'pong');
  assert.equal(typeof reply.version, 'string');
});

test('start runs the relay, then the headless companion, as its own children', async () => {
  const h = setup();
  const reply = await h.request({ type: 'start', id: 1 });
  assert.equal(h.spawned.length, 2);
  const [relay, companion] = h.spawned;
  assert.equal(relay.command, '/usr/bin/node');
  assert.deepEqual(relay.args, ['server.js']);
  assert.equal(relay.options.cwd, path.join('/repo', 'relay-server'));
  assert.equal(relay.options.env.RELAY_EXIT_WITH_STDIN, '1');
  assert.ok(Number(relay.options.env.RELAY_IDLE_EXIT_MS) > 0);
  assert.equal(relay.options.env.KEEP, 'me');
  assert.equal(relay.options.stdio[0], 'pipe');
  assert.equal(relay.options.detached, true);
  assert.deepEqual(companion.args, ['companion.js']);
  assert.equal(companion.options.cwd, path.join('/repo', 'companion'));
  assert.equal(companion.options.env.COMPANION_HEADLESS, '1');
  assert.equal(reply.relay.state, 'running');
  assert.equal(reply.companion.state, 'running');
  assert.equal(reply.error, null);

  // A second start changes nothing.
  await h.request({ type: 'start', id: 2 });
  assert.equal(h.spawned.length, 2);
});

test('a relay that already answers is left alone, with no second companion', async () => {
  const h = setup({ relayAlreadyUp: true });
  const reply = await h.request({ type: 'start', id: 1 });
  assert.equal(h.spawned.length, 0);
  assert.equal(reply.relay.state, 'external');
  assert.equal(reply.companion.state, 'stopped');
});

test('a relay started by someone else with no tutor attached gets the companion', async () => {
  const h = setup({ relayAlreadyUp: true, panelStatus: false });
  const reply = await h.request({ type: 'start', id: 1 });
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0].args, ['companion.js']);
  assert.equal(reply.relay.state, 'external');
  assert.equal(reply.companion.state, 'running');
});

test('a relay started by someone else that already has a tutor gets nothing added', async () => {
  const h = setup({ relayAlreadyUp: true, panelStatus: true });
  const reply = await h.request({ type: 'start', id: 1 });
  assert.equal(h.spawned.length, 0);
  assert.equal(reply.companion.state, 'stopped');
});

test('once asked to start, a relay that went away is started again', async () => {
  const h = setup({ relayAlreadyUp: true, panelStatus: true });
  await h.request({ type: 'start', id: 1 });
  assert.equal(h.spawned.length, 0);
  h.setRelayListening(false);
  h.advance(20000);
  h.tick();
  await waitFor(() => h.spawned.length === 2, 'the relay and companion starting again');
  assert.ok(h.spawned[0].options.cwd.endsWith('relay-server'));
});

test('before any start request nothing is brought back', async () => {
  const h = setup();
  h.advance(20000);
  h.tick();
  await sleep(30);
  assert.equal(h.spawned.length, 0);
});

test('a missing checkout is reported and nothing is started', async () => {
  const h = setup({ rootError: 'the LeetCode Capture files are missing' });
  const reply = await h.request({ type: 'start', id: 1 });
  assert.equal(h.spawned.length, 0);
  assert.match(reply.error, /missing/);
});

test('reset asks the companion to clear its context', async () => {
  const h = setup();
  assert.equal((await h.request({ type: 'reset', id: 1 })).ok, false);
  await h.request({ type: 'start', id: 2 });
  assert.equal((await h.request({ type: 'reset', id: 3 })).ok, true);
  await waitFor(() => h.spawned[1].child.stdinText === '/reset\n', 'the reset line');
});

test('a child that exits on its own is reported, and start brings it back', async () => {
  const h = setup();
  await h.request({ type: 'start', id: 1 });
  h.spawned[1].child.die(null, 1);
  await waitFor(() => h.received.some((m) => m.type === 'status' && m.id === undefined && m.companion.state === 'stopped'), 'the status');
  const reply = await h.request({ type: 'start', id: 2 });
  assert.equal(h.spawned.length, 3);
  assert.equal(reply.companion.state, 'running');
});

test('stdin closing stops both children (companion first) and exits', async () => {
  const h = setup();
  await h.request({ type: 'start', id: 1 });
  const order = [];
  h.spawned[0].child.on('exit', () => order.push('relay'));
  h.spawned[1].child.on('exit', () => order.push('companion'));
  h.input.end();
  await waitFor(() => h.exits.length === 1, 'the exit');
  assert.deepEqual(h.exits, [0]);
  assert.deepEqual(order, ['companion', 'relay']);
  assert.deepEqual(h.spawned[0].child.signals, ['SIGTERM']);
});

test('stop answers stopped, then exits', async () => {
  const h = setup();
  await h.request({ type: 'start', id: 1 });
  const reply = await h.request({ type: 'stop', id: 2 });
  assert.equal(reply.type, 'stopped');
  await waitFor(() => h.exits.length === 1, 'the exit');
  assert.ok(h.spawned.every((s) => s.child.signalCode === 'SIGTERM'));
});

test('a child that ignores SIGTERM is killed', async () => {
  const h = setup({ ignoresTerm: true });
  await h.request({ type: 'start', id: 1 });
  h.input.end();
  await waitFor(() => h.exits.length === 1, 'the exit');
  assert.deepEqual(h.spawned[1].child.signals, ['SIGTERM', 'SIGKILL']);
});

test('keeps the relay alive while heard from, and exits after the idle time', async () => {
  const h = setup({ idleMs: 10000 });
  await h.request({ type: 'start', id: 1 });
  h.advance(9000);
  h.tick();
  assert.equal(h.fetches.filter((f) => f.url.endsWith('/helper/keepalive')).length, 1);
  assert.equal(h.exits.length, 0);
  await h.request({ type: 'ping', id: 2 });
  h.advance(9000);
  h.tick();
  assert.equal(h.exits.length, 0);
  h.advance(1000);
  h.tick();
  await waitFor(() => h.exits.length === 1, 'the idle exit');
  assert.ok(h.spawned.every((s) => s.child.signalCode === 'SIGTERM'));
});

test('a broken frame exits with an error code', async () => {
  const h = setup();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(50 * 1024 * 1024, 0);
  h.input.write(header);
  await waitFor(() => h.exits.length === 1, 'the exit');
  assert.deepEqual(h.exits, [1]);
});

test('an unknown message gets an error answer', async () => {
  const h = setup();
  const reply = await h.request({ type: 'launch-rockets', id: 9 });
  assert.equal(reply.type, 'error');
});

test('resolveRoot: the env, then the saved config, then the folder above', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-helper-root-'));
  try {
    assert.equal(resolveRoot({ LEETCODE_CAPTURE_ROOT: '/somewhere' }, dir), path.resolve('/somewhere'));
    assert.equal(resolveRoot({}, dir), path.resolve(dir, '..'));
    fs.writeFileSync(path.join(dir, 'helper-config.json'), JSON.stringify({ root: '/saved' }));
    assert.equal(resolveRoot({}, dir), '/saved');
    assert.equal(checkRoot(REPO), null);
    assert.match(checkRoot(dir), /missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the real program, with the real relay and companion -------------------

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

async function runRealHost(t) {
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-helper-real-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');
  const host = nodeSpawn(process.execPath, [path.join(HERE, 'host.js'), 'chrome-extension://abc/'], {
    env: {
      ...process.env,
      LEETCODE_CAPTURE_ROOT: REPO,
      LEETCODE_CAPTURE_HELPER_LOG_DIR: scratch,
      LEETCODE_CAPTURE_SETTINGS: path.join(scratch, 'settings.json'),
      CAPTURE_PORT: String(port),
      CAPTURE_LOG_PATH: capturesPath,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
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
  let pids = [];
  t.after(() => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    // Only the pids this test's host reported as its own children.
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const request = async (message, ms = 10000) => {
    host.stdin.write(encodeMessage(message));
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const reply = received.find((m) => m.id === message.id);
      if (reply) return reply;
      // eslint-disable-next-line no-await-in-loop
      await sleep(20);
    }
    throw new Error(`no answer to ${message.type}; log:\n${fs.readFileSync(path.join(scratch, 'helper.log'), 'utf8')}`);
  };
  const started = async () => {
    const reply = await request({ type: 'start', id: 1 });
    assert.equal(reply.relay.state, 'running', JSON.stringify(reply));
    assert.equal(reply.companion.state, 'running');
    pids = [reply.relay.pid, reply.companion.pid];
    return reply;
  };
  return { host, port, exited, request, started, scratch, pids: () => pids };
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the real host starts the relay and companion, and stops both when stdin closes', async (t) => {
  const real = await runRealHost(t);
  assert.equal((await real.request({ type: 'ping', id: 0 })).type, 'pong');
  await real.started();
  assert.equal(await portFree(real.port), false);
  // The companion connects to the relay and the reset reaches it.
  assert.equal((await real.request({ type: 'reset', id: 2 })).ok, true);
  real.host.stdin.end();
  const result = await Promise.race([real.exited, sleep(8000).then(() => null)]);
  assert.ok(result, 'the host exits');
  assert.equal(result.code, 0);
  await waitFor(() => real.pids().every((pid) => !isAlive(pid)), 'the children to exit');
  assert.equal(await portFree(real.port), true);
});

test('the children follow a host that was killed outright', async (t) => {
  const real = await runRealHost(t);
  await real.started();
  real.host.kill('SIGKILL');
  await real.exited;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && real.pids().some(isAlive)) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  assert.deepEqual(real.pids().filter(isAlive), [], 'no orphan is left');
  assert.equal(await portFree(real.port), true);
});
