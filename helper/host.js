#!/usr/bin/env node
// LeetCode Capture helper: the Native Messaging host.
//
// The browser starts this program when the extension calls
// runtime.connectNative(HOST_NAME) and talks to it over stdin and stdout with
// the framing in framing.js. stdout is that channel, so nothing else may ever
// be written to it: the children's output goes to a log file.
//
// It owns two children, started on the extension's `start`:
//   - the relay (relay-server/server.js), unless one already answers on the
//     port (then it is "external" and left alone, and no companion is started
//     either, since whoever started that relay runs their own companion);
//   - the companion (companion/companion.js) in COMPANION_HEADLESS mode.
// Both get a pipe for stdin, so if this process dies in any way (even
// SIGKILL) the pipe closes and they exit too. The relay also has an idle exit
// that this host's keepalive holds off while the extension keeps talking.
//
// Messages from the extension (each may carry an `id`, echoed in the answer):
//   { type: 'ping' }    -> { type: 'pong', version }
//   { type: 'status' }  -> { type: 'status', ... } (see status() below)
//   { type: 'start' }   -> starts what is not running, then a status
//   { type: 'reset' }   -> the companion clears its tutor context: { type: 'reset', ok }
//   { type: 'stop' }    -> stops both children, answers { type: 'stopped' }, exits
// A status with no id is also sent whenever a child starts or exits.
//
// It stops both children and exits when the browser closes stdin (the
// extension disconnected, or the browser quit or crashed), on SIGTERM, SIGHUP
// or SIGINT, on `stop`, and when the extension has not sent anything for
// idleMs (it pings while a LeetCode tab is open).

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDecoder, encodeMessage } from './framing.js';
import { VERSION } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  // The extension pings every 60 s; five quiet minutes means it is gone.
  idleMs: 5 * 60 * 1000,
  keepaliveMs: 60 * 1000,
  // The relay's own idle exit, held off by the keepalive above.
  relayIdleExitMs: 5 * 60 * 1000,
  stopTimeoutMs: 3000,
  startTimeoutMs: 5000,
  reviveMs: 10 * 1000,
};

// Where the companion and relay live: LEETCODE_CAPTURE_ROOT, else the `root`
// the installer recorded next to this file, else the copy bundled in the npm
// package (runtime/, built by scripts/pack.mjs), else the folder above this
// file (a checkout of the repository).
export function resolveRoot(env = process.env, here = HERE) {
  if (env.LEETCODE_CAPTURE_ROOT) return path.resolve(env.LEETCODE_CAPTURE_ROOT);
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(here, 'helper-config.json'), 'utf8'));
    if (saved && typeof saved.root === 'string') return saved.root;
  } catch {
    // no saved config
  }
  const bundled = path.join(here, 'runtime');
  if (isBundled(bundled)) return bundled;
  return path.resolve(here, '..');
}

// A bundled copy carries this marker (scripts/pack.mjs writes it).
export function isBundled(root) {
  return fs.existsSync(path.join(root, 'bundle.json'));
}

export function checkRoot(root) {
  const missing = ['companion/companion.js', 'relay-server/server.js'].filter((rel) => !fs.existsSync(path.join(root, rel)));
  return missing.length ? `the LeetCode Capture files are missing from ${root} (${missing.join(', ')})` : null;
}

// A bundled copy may sit in a read-only or throwaway place (a global npm
// folder, npx's cache), and a new version is a new folder, so its capture log
// and companion state go to the helper's own data folder instead. A variable
// already set wins. A checkout keeps its usual places (relay-server/data/).
export function dataEnv(root, dataDir, env = process.env) {
  if (!isBundled(root)) return {};
  const captures = path.join(dataDir, 'data', 'captures.jsonl');
  return {
    CAPTURE_LOG_PATH: env.CAPTURE_LOG_PATH || env.LEETCODE_CAPTURES_FILE || captures,
    LEETCODE_CAPTURES_FILE: env.LEETCODE_CAPTURES_FILE || env.CAPTURE_LOG_PATH || captures,
    LEETCODE_COMPANION_STATE_FILE: env.LEETCODE_COMPANION_STATE_FILE || path.join(dataDir, 'data', 'companion-state.json'),
  };
}

const alive = (child) => Boolean(child) && child.exitCode === null && child.signalCode === null;

export function createHost({
  input,
  output,
  root,
  env = process.env,
  spawn = nodeSpawn,
  fetchImpl = fetch,
  execPath = process.execPath,
  logFd = 'ignore',
  exit = (code) => process.exit(code),
  now = () => Date.now(),
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
  idleMs = DEFAULTS.idleMs,
  keepaliveMs = DEFAULTS.keepaliveMs,
  relayIdleExitMs = DEFAULTS.relayIdleExitMs,
  stopTimeoutMs = DEFAULTS.stopTimeoutMs,
  startTimeoutMs = DEFAULTS.startTimeoutMs,
  reviveMs = DEFAULTS.reviveMs,
  rootError = null,
}) {
  const port = env.CAPTURE_PORT ? Number(env.CAPTURE_PORT) : 8135;
  const base = `http://127.0.0.1:${port}`;
  let relay = null;
  let companion = null;
  let relayExternal = false;
  let lastError = rootError;
  let starting = null;
  let shuttingDown = null;
  let lastHeard = now();
  let wantRunning = false;
  let lastRevive = 0;

  // One line in helper.log for each thing that matters when a start goes wrong.
  function note(text) {
    if (typeof logFd !== 'number') return;
    try {
      fs.writeSync(logFd, `[host ${new Date(now()).toISOString()}] ${text}\n`);
    } catch {
      // no log then
    }
  }

  function send(message) {
    try {
      output.write(encodeMessage(message));
    } catch {
      // The browser went away; stdin ending will shut everything down.
    }
  }

  function status(id) {
    const relayState = relayExternal ? 'external' : alive(relay) ? 'running' : 'stopped';
    return {
      type: 'status',
      ...(id === undefined ? {} : { id }),
      version: VERSION,
      root,
      port,
      relay: { state: relayState, pid: alive(relay) ? relay.pid : null },
      companion: { state: alive(companion) ? 'running' : 'stopped', pid: alive(companion) ? companion.pid : null },
      error: lastError,
    };
  }

  async function relayUp() {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), 500);
    try {
      await fetchImpl(`${base}/capture`, { method: 'OPTIONS', signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      timers.clearTimeout(timer);
    }
  }

  // Whether a tutor (the companion) is attached to the relay: true, false, or
  // null when that cannot be told. The relay's panel stream opens with a
  // status event that says so.
  async function companionOnline() {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetchImpl(`${base}/panel/events?after=0`, { signal: controller.signal });
      if (!response || !response.body || typeof response.body.getReader !== 'function') return null;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) return null;
        text += decoder.decode(value, { stream: true });
        const match = /"companionOnline":(true|false)/.exec(text);
        if (match) {
          controller.abort();
          return match[1] === 'true';
        }
      }
    } catch {
      return null;
    } finally {
      timers.clearTimeout(timer);
    }
  }

  function startChild(script, extraEnv) {
    const child = spawn(execPath, [path.basename(script)], {
      cwd: path.join(root, path.dirname(script)),
      env: { ...env, ...extraEnv },
      stdio: ['pipe', logFd, logFd],
      // Its own process group, so a Ctrl+C or hang-up meant for a terminal
      // this host was started from reaches the host, which stops it in order.
      detached: true,
      windowsHide: true,
    });
    if (child.stdin) child.stdin.on('error', () => {});
    child.on('error', (err) => {
      lastError = `could not start ${script}: ${err.message}`;
      note(lastError);
    });
    child.on('exit', (code, signal) => {
      note(`${script} exited (code ${code}, signal ${signal})`);
      if (!shuttingDown) send(status());
    });
    return child;
  }

  async function start() {
    if (rootError) return;
    if (!alive(relay)) {
      relayExternal = false;
      if (await relayUp()) {
        relayExternal = true;
        note('a relay already answers on this port; leaving it alone');
        // A relay somebody else started may have no tutor attached: then the
        // extension's Settings page stays locked. Start one unless it is there.
        if (!alive(companion) && (await companionOnline()) === false) {
          note('no tutor is attached to that relay; starting the companion');
          companion = startChild('companion/companion.js', { COMPANION_HEADLESS: '1' });
        }
        lastError = null;
        send(status());
        return;
      }
      relay = startChild('relay-server/server.js', {
        RELAY_IDLE_EXIT_MS: String(relayIdleExitMs),
        RELAY_EXIT_WITH_STDIN: '1',
      });
      const deadline = now() + startTimeoutMs;
      let up = false;
      while (!up && alive(relay) && now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => timers.setTimeout(resolve, 100));
        // eslint-disable-next-line no-await-in-loop
        up = await relayUp();
      }
      if (!up) {
        lastError = `the relay did not start on ${base}`;
        note(lastError);
        return;
      }
    }
    if (!alive(companion)) {
      companion = startChild('companion/companion.js', { COMPANION_HEADLESS: '1' });
    }
    note(`started: relay pid ${relay && relay.pid}, companion pid ${companion && companion.pid}`);
    lastError = null;
    send(status());
  }

  function ensureStarted() {
    if (!starting) starting = start().finally(() => (starting = null));
    return starting;
  }

  function stopChild(child) {
    if (!alive(child)) return Promise.resolve();
    return new Promise((resolve) => {
      const killTimer = timers.setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, stopTimeoutMs);
      child.once('exit', () => {
        timers.clearTimeout(killTimer);
        resolve();
      });
      try {
        if (child.stdin) child.stdin.end();
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    });
  }

  async function stopChildren() {
    // The companion first, so it never sees its relay vanish mid-turn.
    await stopChild(companion);
    await stopChild(relay);
    relayExternal = false;
  }

  function shutdown(code = 0) {
    if (!shuttingDown) {
      shuttingDown = (async () => {
        timers.clearInterval(tick);
        if (starting) await starting.catch(() => {});
        await stopChildren();
        exit(code);
      })();
    }
    return shuttingDown;
  }

  async function handle(message) {
    lastHeard = now();
    if (!message || typeof message !== 'object' || shuttingDown) return;
    const { id } = message;
    switch (message.type) {
      case 'ping':
        send({ type: 'pong', id, version: VERSION });
        return;
      case 'status':
        send(status(id));
        return;
      case 'start':
        wantRunning = true;
        note('start requested');
        await ensureStarted();
        send(status(id));
        return;
      case 'reset': {
        const ok = alive(companion) && Boolean(companion.stdin) && companion.stdin.writable;
        if (ok) companion.stdin.write('/reset\n');
        send({ type: 'reset', id, ok });
        return;
      }
      case 'stop':
        await stopChildren();
        send({ type: 'stopped', id });
        await shutdown(0);
        return;
      default:
        send({ type: 'error', id, error: `unknown message type ${JSON.stringify(message.type)}` });
    }
  }

  // The idle exit and the relay keepalive.
  const tick = timers.setInterval(() => {
    if (shuttingDown) return;
    if (now() - lastHeard >= idleMs) {
      shutdown(0);
      return;
    }
    if (alive(relay)) {
      fetchImpl(`${base}/helper/keepalive`, { method: 'POST', headers: { 'x-lc-companion': '1' } }).catch(() => {});
    }
    revive();
  }, Math.min(keepaliveMs, idleMs));

  // Once asked to start, notice a relay or tutor that has gone away (a relay
  // that was somebody else's and stopped, a child that crashed) and bring it
  // back, at most every reviveMs.
  async function revive() {
    if (!wantRunning || starting || shuttingDown || rootError || now() - lastRevive < reviveMs) return;
    const relayGone = relayExternal ? !(await relayUp()) : !alive(relay);
    const companionGone = !relayExternal && !alive(companion);
    if (relayGone || companionGone) {
      lastRevive = now();
      note('something went away; starting it again');
      await ensureStarted().catch(() => {});
    }
  }

  const decoder = createDecoder({
    onMessage: (message) => {
      handle(message).catch((err) => send({ type: 'error', id: message && message.id, error: err.message }));
    },
    // The stream is out of step; nothing more from it can be trusted.
    onError: () => shutdown(1),
  });
  input.on('data', (chunk) => decoder.push(chunk));
  input.on('end', () => shutdown(0));
  input.on('error', () => shutdown(0));

  return { handle, shutdown, status, get children() { return { relay, companion }; } };
}

// The real program: stdin and stdout are the browser's.
export function main() {
  const root = resolveRoot();
  const logDir = process.env.LEETCODE_CAPTURE_HELPER_LOG_DIR || HERE;
  let logFd = 'ignore';
  try {
    const logPath = path.join(logDir, 'helper.log');
    // Keep one run's worth, so the log never grows without bound.
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) fs.truncateSync(logPath, 0);
    logFd = fs.openSync(logPath, 'a');
  } catch {
    // No log then; the children's output is dropped.
  }
  const childEnv = { ...process.env, ...dataEnv(root, HERE) };
  for (const file of [childEnv.CAPTURE_LOG_PATH, childEnv.LEETCODE_COMPANION_STATE_FILE]) {
    try {
      if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // the relay reports a log it cannot write
    }
  }
  const host = createHost({
    input: process.stdin,
    output: process.stdout,
    root,
    env: childEnv,
    logFd,
    rootError: checkRoot(root),
  });
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => host.shutdown(0));
  return host;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
