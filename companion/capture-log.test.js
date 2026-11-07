// End to end: the capture log is cleared as it is consumed (see
// capture-log.js). A real relay server (started here, so the companion uses it
// instead of spawning its own) writes the log, and a real companion.js tails
// it. For the race, a small proxy in front of the relay posts one capture
// right before it passes the companion's trim request on and one right after
// the relay answered, before the companion has its answer.
//
// Each Run note names its problem and attempt number, which is how "handled
// exactly once" is checked.
//
// Run with: node --test capture-log.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pendingTrimFor, pendingTrimHappened, isPendingTrim, GUARD_BYTES } from './capture-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY_JS = path.join(__dirname, '..', 'relay-server', 'server.js');

function until(predicate, ms, what) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
}

async function startRelay(t, port, logPath) {
  const child = spawn(process.execPath, [RELAY_JS], {
    env: { ...process.env, CAPTURE_PORT: String(port), CAPTURE_LOG_PATH: logPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => c.toString().includes('listening') && resolve());
    child.once('exit', () => reject(new Error('relay exited')));
  });
  const capture = async (slug, code = `code for ${slug}`) => {
    const status = await post(port, '/capture', {
      problemSlug: slug,
      problemTitle: slug === 'old-problem' ? 'Old' : 'New',
      language: 'Python3',
      code,
      trigger: 'run',
      timestamp: new Date().toISOString(),
    });
    assert.equal(status, 200);
  };
  return { capture };
}

// Passes every request through to the relay (streams included), rewriting
// Host to the relay's own so its loopback check passes. `onTrim`, when set,
// wraps the trim request: { before(), after() } run around forwarding it.
function startProxy(t, port, relayPort) {
  const hooks = { onTrim: null, trims: 0 };
  const server = http.createServer(async (req, res) => {
    const isTrim = req.method === 'POST' && req.url === '/panel/trim-captures';
    const hook = isTrim ? hooks.onTrim : null;
    if (isTrim) hooks.trims += 1;
    if (hook) await hook.before();
    const upstream = http.request(
      { host: '127.0.0.1', port: relayPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${relayPort}` } },
      async (up) => {
        if (hook) {
          const chunks = [];
          for await (const c of up) chunks.push(c);
          await hook.after();
          res.writeHead(up.statusCode, up.headers);
          res.end(Buffer.concat(chunks));
          return;
        }
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => res.destroy());
    res.on('close', () => !res.writableEnded && upstream.destroy());
    req.pipe(upstream);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(hooks)));
}

function startCompanion(t, { port, scratch, capturesPath, env = {} }) {
  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      // Runs never reach the model, so nothing needs to listen here.
      COMPANION_BASE_URL: 'http://127.0.0.1:9/v1',
      LEETCODE_CAPTURES_FILE: capturesPath,
      CAPTURE_LOG_PATH: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: String(port),
      COMPANION_AUTO_CLEAR_CONTEXT: '1',
      VAULT_AUTO_SUMMARY: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (out += c.toString()));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  });
  const runs = (title, attempt) =>
    out.split(`recorded your Run for ${title} (run ${attempt})`).length - 1;
  return { out: () => out, runs };
}

function scratchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, capturesPath: path.join(dir, 'captures.jsonl') };
}

const logSlugs = (capturesPath) =>
  fs
    .readFileSync(capturesPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => `${JSON.parse(l).problemSlug}#${JSON.parse(l).attemptSeq}`);

const stateOffset = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).offset;

test('a problem switch drops the handled log; the switching capture and ones landing during the trim are each handled once', async (t) => {
  const { dir, capturesPath } = scratchDir(t);
  const relay = await startRelay(t, 18241, capturesPath);
  const proxy = await startProxy(t, 18240, 18241);
  const c = startCompanion(t, { port: 18240, scratch: dir, capturesPath });
  await until(() => c.out().includes('in-page panel connected'), 15000, 'the companion');

  await relay.capture('old-problem');
  await relay.capture('old-problem');
  await until(() => c.runs('Old', 2) === 1, 10000, 'the old Runs');
  assert.equal(proxy.trims, 0, 'no switch, nothing to drop');

  // The switch: one capture right before the relay trims, one right after it
  // trimmed and before the companion knows.
  proxy.onTrim = {
    before: () => relay.capture('new-problem'),
    after: () => relay.capture('new-problem'),
  };
  await relay.capture('new-problem');
  await until(() => c.runs('New', 3) === 1, 10000, 'the captures around the trim');
  proxy.onTrim = null;
  await relay.capture('new-problem');
  await until(() => c.runs('New', 4) === 1, 10000, 'a capture after the trim');
  await pause(500);

  assert.equal(proxy.trims, 1);
  for (const n of [1, 2]) assert.equal(c.runs('Old', n), 1, `Old run ${n}`);
  for (const n of [1, 2, 3, 4]) assert.equal(c.runs('New', n), 1, `New run ${n}`);
  assert.deepEqual(logSlugs(capturesPath), ['new-problem#2', 'new-problem#3', 'new-problem#4'], 'the handled prefix is gone, nothing else');
  assert.equal(stateOffset(dir), fs.statSync(capturesPath).size, 'the saved offset matches the trimmed log');
});

test('at start the handled part goes and an unread tail stays; an outside truncation still resets the offset', async (t) => {
  const { dir, capturesPath } = scratchDir(t);
  const relay = await startRelay(t, 18243, capturesPath);
  await relay.capture('old-problem');
  await relay.capture('old-problem');
  const handled = fs.statSync(capturesPath).size;
  await relay.capture('new-problem'); // arrived while the companion was down
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ offset: handled }));

  const c = startCompanion(t, { port: 18243, scratch: dir, capturesPath });
  await until(() => c.runs('New', 1) === 1, 15000, 'the unread capture');
  await pause(400);
  assert.equal(c.runs('Old', 1) + c.runs('Old', 2), 0, 'handled captures are not replayed');
  assert.deepEqual(logSlugs(capturesPath), ['new-problem#1']);

  // Someone empties the log by hand: the companion notices and keeps going.
  fs.writeFileSync(capturesPath, '');
  await until(() => c.out().includes('capture log shrank; resetting offset to 0'), 10000, 'the shrink note');
  await relay.capture('new-problem');
  await until(() => c.runs('New', 2) === 1, 10000, 'a capture after the truncation');
  await pause(300);
  assert.equal(c.runs('New', 1), 1);
});

for (const happened of [true, false]) {
  test(`a trim left pending by a crash is resolved from the log (the relay ${happened ? 'did' : 'did not'} trim)`, async (t) => {
    const { dir, capturesPath } = scratchDir(t);
    const relay = await startRelay(t, happened ? 18245 : 18246, capturesPath);
    await relay.capture('old-problem');
    await relay.capture('old-problem');
    const before = fs.statSync(capturesPath).size;
    await relay.capture('new-problem');
    const full = fs.readFileSync(capturesPath);
    const readAt = (position, length) => full.subarray(Math.max(0, position), position + length);
    const pendingTrim = pendingTrimFor(before, readAt);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ offset: before, pendingTrim }));
    // The relay did the cut, and the companion died before saving its new offset.
    if (happened) fs.writeFileSync(capturesPath, full.subarray(before));

    const c = startCompanion(t, { port: happened ? 18245 : 18246, scratch: dir, capturesPath });
    await until(() => c.runs('New', 1) === 1, 15000, 'the unread capture');
    await relay.capture('new-problem');
    await until(() => c.runs('New', 2) === 1, 10000, 'the next capture');
    await pause(400);
    assert.equal(c.runs('New', 1), 1);
    assert.equal(c.runs('Old', 1) + c.runs('Old', 2), 0);
    assert.ok(!c.out().includes('shrank'), 'resolved without the shrink fallback');
    assert.ok(!logSlugs(capturesPath).some((s) => s.startsWith('old-problem')));
  });
}

test('the size backstop drops the handled log on one problem, and nothing is lost', async (t) => {
  const { dir, capturesPath } = scratchDir(t);
  const relay = await startRelay(t, 18248, capturesPath);
  const c = startCompanion(t, { port: 18248, scratch: dir, capturesPath, env: { LEETCODE_CAPTURES_TRIM_BYTES: '2000' } });
  await until(() => c.out().includes('in-page panel connected'), 15000, 'the companion');
  let largest = 0;
  for (let i = 1; i <= 12; i += 1) {
    await relay.capture('new-problem', `x = ${i}\n`.repeat(40));
    await until(() => c.runs('New', i) === 1, 10000, `Run ${i}`);
    largest = Math.max(largest, fs.statSync(capturesPath).size);
  }
  await pause(400);
  for (let i = 1; i <= 12; i += 1) assert.equal(c.runs('New', i), 1, `Run ${i}`);
  assert.ok(largest < 4000, `the log stayed small (${largest} bytes at most)`);
  assert.ok(logSlugs(capturesPath).length < 12);
});

test('a relay writing another file refuses the trim, and the companion says so instead of cutting it', async (t) => {
  const { dir, capturesPath } = scratchDir(t);
  const relayLog = path.join(dir, 'relay-captures.jsonl');
  const relay = await startRelay(t, 18249, relayLog);
  await relay.capture('old-problem');
  fs.copyFileSync(relayLog, capturesPath);
  const relayBytes = fs.readFileSync(relayLog);
  const c = startCompanion(t, { port: 18249, scratch: dir, capturesPath });
  await until(() => c.out().includes('would not clear the capture log'), 15000, 'the warning');
  assert.match(c.out(), /is CAPTURE_LOG_PATH the same file as LEETCODE_CAPTURES_FILE\?/);
  assert.deepEqual(fs.readFileSync(relayLog), relayBytes, "the relay's own log is untouched");
});

test('pendingTrimFor and pendingTrimHappened', () => {
  const log = Buffer.from('a'.repeat(300) + '\n' + 'b'.repeat(10) + '\n');
  const readAt = (buf) => (position, length) => buf.subarray(Math.max(0, position), position + length);
  const pending = pendingTrimFor(301, readAt(log));
  assert.ok(isPendingTrim(pending));
  assert.equal(Buffer.from(pending.tail, 'base64').length, GUARD_BYTES);
  assert.equal(pendingTrimHappened(pending, readAt(log)), false);
  assert.equal(pendingTrimHappened(pending, readAt(log.subarray(301))), true);
  // Shorter than the guard: it remembers what there is.
  const short = pendingTrimFor(4, readAt(Buffer.from('abc\nd\n')));
  assert.equal(Buffer.from(short.tail, 'base64').toString(), 'abc\n');
  assert.equal(pendingTrimHappened(short, readAt(Buffer.from('d\n'))), true);
  assert.equal(isPendingTrim({ before: 0, tail: '' }), false);
  assert.equal(isPendingTrim(null), false);
});
