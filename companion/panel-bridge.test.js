// Tests for the in-page panel bridge (panel-bridge.js) and its wiring in
// companion.js.
//
// The unit tests run the bridge against a small in-process stand-in for the
// relay. The end-to-end test is the real thing: a real companion.js
// subprocess (which auto-starts the real relay server) talking to a stub
// OpenAI-compatible model, with this test playing the browser panel over the
// relay's public /panel/* routes exactly as the extension does.
//
// Run with: node --test panel-bridge.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPanelBridge, parseSseBlock } from './panel-bridge.js';
import { SUMMARIZER_SYSTEM, SUMMARY_HEADER } from './context-summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEETCODE = 'https://leetcode.com';

function until(predicate, ms = 8000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (value) resolve(value);
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(tick, 25);
    };
    tick();
  });
}

test('parseSseBlock extracts the JSON payload and ignores comments and junk', () => {
  assert.deepEqual(parseSseBlock('id: 4\ndata: {"a":1}'), { a: 1 });
  assert.deepEqual(parseSseBlock('data:{"a":1}'), { a: 1 });
  assert.equal(parseSseBlock(': ping'), null);
  assert.equal(parseSseBlock('retry: 2000'), null);
  assert.equal(parseSseBlock('data: {not json'), null);
});

// A stand-in relay: records /panel/publish bodies, and holds /panel/inbox
// open so the test can push messages down it. With a fixed `port` it can also
// stand in for the relay a real companion.js expects: it answers the
// companion's OPTIONS /capture health check, so the companion uses it instead
// of spawning a relay of its own.
function startStubRelay({ inboxStatus = 200, port = 0 } = {}) {
  const published = [];
  const dropped = [];
  const rpcResults = [];
  const inboxClients = new Set();
  let inboxConnections = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/panel/publish') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        published.push(JSON.parse(body).events);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else if (req.method === 'POST' && req.url === '/panel/drop-problem') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        dropped.push(JSON.parse(body).problemSlug);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else if (req.method === 'POST' && req.url === '/panel/rpc-result') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        rpcResults.push({ body: JSON.parse(body), header: req.headers['x-lc-companion'] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else if (req.method === 'OPTIONS' && req.url === '/capture') {
      res.writeHead(204);
      res.end();
    } else if (req.method === 'GET' && req.url === '/panel/inbox') {
      inboxConnections += 1;
      if (inboxStatus !== 200) {
        res.writeHead(inboxStatus);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 2000\n\n');
      inboxClients.add(res);
      req.on('close', () => inboxClients.delete(res));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        published,
        dropped,
        rpcResults,
        flat: () => published.flat(),
        send: (message) => {
          for (const res of inboxClients) res.write(`id: 1\ndata: ${JSON.stringify(message)}\n\n`);
        },
        dropInbox: () => {
          for (const res of inboxClients) res.destroy();
        },
        inboxConnections: () => inboxConnections,
        inboxOpen: () => inboxClients.size,
        close: () => {
          for (const res of inboxClients) res.destroy();
          server.close();
        },
      })
    );
  });
}

test('publish batches events in order and merges consecutive chunks of one turn', async (t) => {
  const relay = await startStubRelay();
  t.after(() => relay.close());
  const bridge = createPanelBridge({ baseUrl: relay.baseUrl, onMessage: () => {} });
  t.after(() => bridge.stop());

  bridge.publish({ type: 'turn-start', turnId: 'a', problemSlug: 'two-sum' });
  bridge.publish({ type: 'chunk', turnId: 'a', text: 'Hel' });
  bridge.publish({ type: 'chunk', turnId: 'a', text: 'lo ' });
  bridge.publish({ type: 'chunk', turnId: 'a', text: 'there' });
  bridge.publish({ type: 'turn-end', turnId: 'a', problemSlug: 'two-sum', text: 'Hello there' });
  await bridge.drain();

  const events = relay.flat();
  assert.deepEqual(
    events.map((e) => e.type),
    ['turn-start', 'chunk', 'turn-end']
  );
  assert.equal(events[1].text, 'Hello there');
});

test('a chunk is never merged across a turn boundary', async (t) => {
  const relay = await startStubRelay();
  t.after(() => relay.close());
  const bridge = createPanelBridge({ baseUrl: relay.baseUrl, onMessage: () => {} });
  t.after(() => bridge.stop());

  bridge.publish({ type: 'chunk', turnId: 'a', text: 'one' });
  bridge.publish({ type: 'chunk', turnId: 'b', text: 'two' });
  await bridge.drain();
  assert.deepEqual(
    relay.flat().map((e) => [e.turnId, e.text]),
    [
      ['a', 'one'],
      ['b', 'two'],
    ]
  );
});

test('every relay request carries the companion header, and a relay that never answers cannot stall publishing', async (t) => {
  const seen = [];
  let stall = true;
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, header: req.headers['x-lc-companion'] });
    if (req.url === '/panel/publish' && stall) return; // accept, never answer
    req.resume();
    req.on('end', () => {
      res.writeHead(req.url === '/panel/inbox' ? 404 : 200);
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const bridge = createPanelBridge({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    onMessage: () => {},
    publishTimeoutMs: 200,
  });
  t.after(() => bridge.stop());
  bridge.start();
  bridge.publish({ type: 'notice', text: 'first' });
  await bridge.drain(); // resolves through the timeout instead of hanging
  stall = false;
  bridge.publish({ type: 'notice', text: 'second' });
  await bridge.drain();
  await until(() => seen.some((r) => r.url === '/panel/inbox'), 3000, 'inbox request');
  assert.equal(seen.filter((r) => r.url === '/panel/publish').length, 2);
  assert.ok(seen.every((r) => r.header === '1'), JSON.stringify(seen));
});

test('a dead relay never throws out of publish or drain', async () => {
  const bridge = createPanelBridge({ baseUrl: 'http://127.0.0.1:1', onMessage: () => {} });
  bridge.publish({ type: 'notice', text: 'nobody home' });
  await bridge.drain();
  bridge.stop();
});

test('inbox messages reach onMessage, the state goes connected, and it reconnects after a drop', async (t) => {
  const relay = await startStubRelay();
  t.after(() => relay.close());
  const received = [];
  const states = [];
  const bridge = createPanelBridge({
    baseUrl: relay.baseUrl,
    onMessage: (m) => received.push(m),
    onState: (s) => states.push(s),
  });
  t.after(() => bridge.stop());
  bridge.start();

  await until(() => states.includes('connected'), 3000, 'connected state');
  relay.send({ id: 1, text: 'any hints?', problemSlug: 'two-sum' });
  await until(() => received.length === 1, 3000, 'first message');
  assert.deepEqual(received[0], { id: 1, text: 'any hints?', problemSlug: 'two-sum' });

  relay.dropInbox();
  await until(() => states.includes('disconnected'), 3000, 'disconnected state');
  await until(() => relay.inboxConnections() >= 2, 5000, 'reconnect');
  await until(() => states.filter((s) => s === 'connected').length >= 2, 3000, 'connected again');
});

test('a relay that predates the panel (404 on the inbox) reports "unsupported"', async (t) => {
  const relay = await startStubRelay({ inboxStatus: 404 });
  t.after(() => relay.close());
  const states = [];
  const bridge = createPanelBridge({ baseUrl: relay.baseUrl, onMessage: () => {}, onState: (s) => states.push(s) });
  t.after(() => bridge.stop());
  bridge.start();
  await until(() => states.includes('unsupported'), 3000, 'unsupported state');
});

test('an rpc inbox message goes to onRpc, never onMessage, and its answer is posted back with the companion header', async (t) => {
  const relay = await startStubRelay();
  t.after(() => relay.close());
  const received = [];
  const calls = [];
  let release;
  const slow = new Promise((r) => (release = r));
  const bridge = createPanelBridge({
    baseUrl: relay.baseUrl,
    onMessage: (m) => received.push(m),
    onRpc: async (method, params) => {
      calls.push([method, params]);
      if (method === 'test') await slow;
      if (method === 'boom') throw new Error('kaput');
      return { ok: true, result: { method } };
    },
  });
  t.after(() => bridge.stop());
  bridge.start();
  await until(() => relay.inboxOpen() === 1, 3000, 'inbox open');
  relay.send({ type: 'rpc', id: 'r1', method: 'test', params: { patch: {} } });
  relay.send({ type: 'rpc', id: 'r2', method: 'get', params: {} });
  relay.send({ id: 7, text: 'still a chat message', problemSlug: 'two-sum' });
  relay.send({ type: 'rpc', id: 'r3', method: 'boom' });
  relay.send({ type: 'rpc', method: 'get' }); // no id: ignored
  await until(() => relay.rpcResults.length === 2 && received.length === 1, 3000, 'fast answers');
  assert.deepEqual(
    relay.rpcResults.map((r) => r.body),
    [
      { id: 'r2', response: { ok: true, result: { method: 'get' } } },
      { id: 'r3', response: { ok: false, error: { message: 'kaput' } } },
    ],
    'a slow call does not hold up later calls or chat messages'
  );
  assert.ok(relay.rpcResults.every((r) => r.header === '1'));
  release();
  await until(() => relay.rpcResults.length === 3, 3000, 'slow answer');
  assert.equal(relay.rpcResults[2].body.id, 'r1');
  assert.equal(calls.length, 3);
  assert.equal(received[0].text, 'still a chat message');
});

test('setConfig publishes a config event and publishes it again after the inbox reconnects', async (t) => {
  const relay = await startStubRelay();
  t.after(() => relay.close());
  const bridge = createPanelBridge({ baseUrl: relay.baseUrl, onMessage: () => {} });
  t.after(() => bridge.stop());
  bridge.setConfig({ provider: 'local', label: 'Local model', model: 'm1' });
  await bridge.drain();
  assert.deepEqual(relay.flat(), [{ type: 'config', provider: 'local', label: 'Local model', model: 'm1' }]);
  bridge.start();
  await until(() => relay.flat().filter((e) => e.type === 'config').length >= 2, 3000, 'config on connect');
  relay.dropInbox();
  await until(() => relay.flat().filter((e) => e.type === 'config').length >= 3, 6000, 'config on reconnect');
});

// ---- end to end: real companion.js + real relay + stub model ----------------

function startStubModel(replyFor) {
  const requests = [];
  const server = http.createServer((req, res) => {
    // Only chat requests are the model's: the companion's startup probes of the server (local-server.js) get a 404, like a real server that lacks the route.
    if (req.method !== 'POST' || !/\/chat(\/completions)?$/.test(req.url)) return void res.writeHead(404).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const content = replyFor(requests.length, parsed);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const mid = Math.ceil(content.length / 2);
      for (const piece of [content.slice(0, mid), content.slice(mid)]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests })));
}

// Plays the browser panel: an SSE client on /panel/events with leetcode.com's
// Origin, plus a helper to post typed messages the way panel.js does.
function connectPanel(port) {
  const events = [];
  let buffer = '';
  const req = http.get(
    { host: '127.0.0.1', port, path: '/panel/events?after=0', headers: { origin: LEETCODE } },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const parsed = parseSseBlock(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (parsed) events.push(parsed);
        }
      });
    }
  );
  req.on('error', () => {});
  const post = (route, body) =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: route,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', origin: LEETCODE },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      r.on('error', reject);
      r.end(payload);
    });
  return { events, close: () => req.destroy(), sendMessage: (text, problemSlug) => post('/panel/message', { text, problemSlug }) };
}

test('end to end: a message typed in the panel reaches the tutor and its reply streams back', async (t) => {
  const PORT = 18192;
  const { server: model, requests } = await startStubModel((n) => (n === 1 ? 'Try a **hash map**.' : 'Brackets must nest.'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-panel-e2e-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: String(PORT),
      CAPTURE_LOG_PATH: capturesPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (out += c.toString()));

  // companion.js spawns the relay itself; the panel can only connect once it
  // is listening (the real panel reconnects on its own, this test client
  // doesn't).
  let relayUp = false;
  for (let i = 0; i < 100 && !relayUp; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    relayUp = await fetch(`http://127.0.0.1:${PORT}/capture`, { method: 'OPTIONS' }).then(
      () => true,
      () => false
    );
    // eslint-disable-next-line no-await-in-loop
    if (!relayUp) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(relayUp, 'relay server never came up');

  const panel = connectPanel(PORT);
  t.after(() => {
    panel.close();
    child.kill();
    model.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  // The panel learns the companion is online from the relay's status event.
  await until(() => panel.events.some((e) => e.type === 'status' && e.companionOnline), 10000, 'companion online');
  await until(() => out.includes('in-page panel connected'), 5000, 'companion announcing the panel');

  // 1. A panel-typed message goes to the model and the reply streams back.
  assert.equal(await panel.sendMessage('any hints?', 'two-sum'), 202);
  await until(() => panel.events.some((e) => e.type === 'turn-end'), 10000, 'first turn-end');
  const firstTurn = panel.events.filter((e) => e.turnId && e.turnId === panel.events.find((x) => x.type === 'turn-end').turnId);
  const userEvent = panel.events.find((e) => e.type === 'user');
  assert.equal(userEvent.text, 'any hints?');
  assert.equal(userEvent.problemSlug, 'two-sum');
  assert.equal(firstTurn.find((e) => e.type === 'turn-end').text, 'Try a **hash map**.');
  assert.equal(firstTurn.find((e) => e.type === 'turn-end').problemSlug, 'two-sum');
  assert.ok(JSON.stringify(requests[0].messages).includes('any hints?'));
  assert.ok(out.includes('[panel] any hints?'), 'the terminal echoes panel messages under a [panel] label');

  // 2. A Run is mirrored as a capture chip (with no note), and never reaches
  // the model: no tutor turn.
  fs.appendFileSync(
    capturesPath,
    `${JSON.stringify({
      problemSlug: 'two-sum',
      problemTitle: 'Two Sum',
      language: 'python3',
      trigger: 'run',
      timestamp: new Date().toISOString(),
      code: 'def twoSum(nums, target): pass',
      attemptSeq: 1,
    })}\n`
  );
  await until(() => panel.events.some((e) => e.type === 'capture'), 10000, 'the capture event');
  await until(() => out.includes('recorded your Run for Two Sum'), 10000, 'the Run note in the terminal');
  const capture = panel.events.find((e) => e.type === 'capture');
  assert.deepEqual(
    { slug: capture.problemSlug, trigger: capture.trigger, seq: capture.attemptSeq, title: capture.problemTitle, note: capture.note },
    { slug: 'two-sum', trigger: 'run', seq: 1, title: 'Two Sum', note: undefined }
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(requests.length, 1, 'a Run must not reach the model');
  assert.equal(panel.events.filter((e) => e.type === 'turn-start').length, 1, 'no tutor turn for a Run');

  // 3. Switching to another problem in the panel starts a fresh tutor session.
  const before = requests.length;
  assert.equal(await panel.sendMessage('what about brackets?', 'valid-parentheses'), 202);
  await until(() => requests.length > before, 10000, 'model request for the second problem');
  const switched = requests[requests.length - 1].messages;
  assert.ok(!JSON.stringify(switched).includes('any hints?'), 'earlier problem history is cleared on a switch');
  assert.ok(JSON.stringify(switched).includes('valid-parentheses'), 'the tutor is told which problem is on screen');
  await until(() => panel.events.some((e) => e.type === 'notice' && /fresh tutor session/.test(e.text)), 5000, 'reset notice');
});

// ---- real companion.js against the stub relay ------------------------------
//
// No real relay here: the stub answers the health check on CAPTURE_PORT, so
// the test controls exactly what arrives on the inbox and sees exactly what
// the companion publishes.

function spawnCompanion({ port, modelPort, scratch, extraEnv = {} }) {
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');
  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: String(port),
      CAPTURE_LOG_PATH: capturesPath,
      // Keeps the test independent of whoever runs it.
      COMPANION_AUTO_CLEAR_CONTEXT: '1',
      VAULT_AUTO_SUMMARY: '0',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (c) => chunks.push(c));
  child.stderr.on('data', (c) => chunks.push(c));
  return {
    child,
    // Raw bytes, so an escape byte cannot hide behind any decoding.
    output: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
    capture: (fields) =>
      fs.appendFileSync(
        capturesPath,
        `${JSON.stringify({ language: 'python3', timestamp: new Date().toISOString(), code: 'pass', ...fields })}\n`
      ),
  };
}

test('end to end: untrusted text never reaches the terminal as escape sequences', async (t) => {
  const ESC = 0x1b;
  const PROBE = 'esc-probe \x1b[31mRED\x1b[0m \x1b]0;pwned-title\x07 end';
  const relay = await startStubRelay({ port: 18196 });
  const { server: model, requests } = await startStubModel(() => 'Noted.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-esc-'));
  const companion = spawnCompanion({ port: 18196, modelPort: model.address().port, scratch });
  t.after(() => {
    companion.child.kill();
    relay.close();
    model.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  await until(() => relay.inboxOpen() > 0, 10000, 'the companion to open its inbox');
  // Straight down the inbox, as if the relay had not stripped anything.
  relay.send({ text: PROBE, problemSlug: 'two-sum' });
  await until(() => companion.text().includes('[panel] esc-probe'), 10000, 'the panel message in the terminal');
  await until(() => requests.length >= 1, 10000, 'the model request for the panel message');

  // A capture any website could have posted to /capture: escapes in the
  // title, an unknown trigger with an OSC sequence, and a C1 CSI.
  companion.capture({
    problemSlug: 'evil-problem',
    problemTitle: 'Evil \x1b[2J\x1b[31mTitle\x9b0m',
    trigger: 'hack\x1b]0;pwned\x07',
    attemptSeq: 1,
  });
  // Not a Submit, so it is only recorded (see code-ledger.js's sendsToTutor).
  await until(() => companion.text().includes('recorded your hack]0;pwned for Evil'), 10000, 'the capture note');
  // The capture is for a new problem, so the reset notice (which prints the
  // problem id) was on screen too.
  await until(() => companion.text().includes('new problem detected (evil-problem)'), 10000, 'the reset notice');
  await until(() => relay.flat().filter((e) => e.type === 'turn-end').length >= 1, 10000, 'the published turn-end');
  await until(() => relay.flat().some((e) => e.type === 'capture'), 10000, 'the published capture');
  assert.equal(requests.length, 1, 'an unknown trigger must not reach the model');

  const out = companion.output();
  const at = out.indexOf(ESC);
  assert.equal(at, -1, `an ESC byte reached the terminal: ${JSON.stringify(out.subarray(Math.max(0, at - 40), at + 40).toString('utf8'))}`);
  assert.ok(!out.includes(Buffer.from([0xc2, 0x9b])), 'a C1 CSI (U+009B) reached the terminal');
  assert.ok(companion.text().includes('[panel] esc-probe [31mRED[0m ]0;pwned-title end'));
  assert.ok(companion.text().includes('recorded your hack]0;pwned for Evil [2J[31mTitle0m (attempt 1)'));

  // Nor the panel, nor the model's prompt.
  const published = JSON.stringify(relay.flat());
  assert.ok(!/\\u001b|\\u009b|\\u0007/.test(published), `published events carry control characters: ${published}`);
  assert.ok(!/\\u001b|\\u009b|\\u0007/.test(JSON.stringify(requests)), 'the model prompt carries control characters');
});

test('end to end: switching problems in the panel tracks what the tutor has really seen', async (t) => {
  const relay = await startStubRelay({ port: 18197 });
  const { server: model, requests } = await startStubModel(() => 'Okay.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-switch-'));
  const companion = spawnCompanion({ port: 18197, modelPort: model.address().port, scratch });
  t.after(() => {
    companion.child.kill();
    relay.close();
    model.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const lastPrompt = () => JSON.stringify(requests[requests.length - 1].messages);
  const turnEnds = () => relay.flat().filter((e) => e.type === 'turn-end').length;
  await until(() => relay.inboxOpen() > 0, 10000, 'the companion to open its inbox');

  // 1. Typed in the terminal before any capture: answered there, but no
  // problem to file it under, so nothing goes to the panel.
  companion.child.stdin.write('hello from the terminal\n');
  await until(() => requests.length === 1, 10000, 'the terminal message reaching the model');
  await until(() => companion.text().includes('Okay.'), 10000, 'the reply in the terminal');

  // 2. A Run on problem A: recorded, A becomes active, no model call (the
  // first problem resets nothing).
  companion.capture({
    problemSlug: 'two-sum',
    problemTitle: 'Two Sum',
    problemDescription: 'TWO-SUM-DESCRIPTION-MARKER',
    trigger: 'run',
    attemptSeq: 1,
    code: 'def twoSum(nums, target):\n    return []',
  });
  await until(() => companion.text().includes('recorded your Run for Two Sum'), 10000, 'the Run note');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(requests.length, 1, 'a Run must not reach the model');

  // 3. A panel question on B, with no editor code (it could not be read): a
  // new problem, and A is forgotten (its context, its code, and its chat in
  // the relay).
  relay.send({ text: 'what about brackets?', problemSlug: 'valid-parentheses' });
  await until(() => requests.length === 2, 10000, 'the question on B');
  assert.match(lastPrompt(), /working on the LeetCode problem \\"valid-parentheses\\"\.\)\\n\(The student's editor could not be read/);
  assert.ok(!lastPrompt().includes('TWO-SUM-DESCRIPTION-MARKER'), "A's context is cleared on the switch");
  assert.ok(!lastPrompt().includes('return []'), "A's code is not carried over");
  await until(() => turnEnds() === 1, 10000, 'the B turn-end');
  assert.deepEqual(relay.dropped, ['two-sum'], "the relay is asked to drop A's chat");

  // 4. Back to A without editor code: everything about A was dropped at the
  // switch, so it starts over like a new problem.
  relay.send({ text: 'back to two sum', problemSlug: 'two-sum' });
  await until(() => requests.length === 3, 10000, 'the question back on A');
  assert.match(lastPrompt(), /working on the LeetCode problem \\"two-sum\\"\.\)\\n\(The student's editor could not be read/);
  assert.ok(!lastPrompt().includes('TWO-SUM-DESCRIPTION-MARKER'), "A's old statement was dropped");
  assert.ok(!lastPrompt().includes('brackets'), "B's chat is gone");
  await until(() => turnEnds() === 2, 10000, 'the second A turn-end');
  assert.deepEqual(relay.dropped, ['two-sum', 'valid-parentheses']);

  // 5. Another question on A: same problem, no reset, so only the note that
  // the editor could not be read.
  relay.send({ text: 'and the edge cases?', problemSlug: 'two-sum' });
  await until(() => requests.length === 4, 10000, 'the follow-up on A');
  const lastMessages = requests[requests.length - 1].messages;
  assert.equal(
    lastMessages[lastMessages.length - 1].content,
    "(The student's editor could not be read, so their current code is not included.)\n\nand the edge cases?"
  );
  await until(() => turnEnds() === 3, 10000, 'the follow-up turn-end');

  const events = relay.flat();
  assert.ok(events.every((e) => !('problemSlug' in e) || e.problemSlug), 'no event is published without a problem');
  assert.ok(!events.some((e) => e.type === 'user' && e.text === 'hello from the terminal'));
  assert.deepEqual(
    events.filter((e) => e.type === 'notice').map((e) => e.problemSlug),
    ['valid-parentheses', 'two-sum']
  );
  // Every chunk belongs to a turn that was announced.
  const started = new Set(events.filter((e) => e.type === 'turn-start').map((e) => e.turnId));
  assert.ok(events.filter((e) => e.type === 'chunk').every((e) => started.has(e.turnId)));
});

// ---- the companion exiting mid-reply, with a relay it did not start ---------
//
// The relay outlives the companion here (started separately, as when the
// student runs it themselves), so no epoch change rescues the panel: before
// the relay closed open turns, the cut reply stayed "typing" forever and was
// replayed that way to every tab opened later.

test('end to end: a companion killed mid-reply leaves the reply interrupted, not typing', async (t) => {
  const PORT = 18198;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-panel-exit-'));
  // A model that streams the first half of its reply, then never finishes.
  const model = http.createServer((req, res) => {
    // Only chat requests are the model's: the companion's startup probes of the server (local-server.js) get a 404, like a real server that lacks the route.
    if (req.method !== 'POST' || !/\/chat(\/completions)?$/.test(req.url)) return void res.writeHead(404).end();
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half of a reply' } }] })}\n\n`);
    });
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));

  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay-server', 'server.js')], {
    env: { ...process.env, CAPTURE_PORT: String(PORT), CAPTURE_LOG_PATH: path.join(scratch, 'relay-captures.jsonl') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relayExited = new Promise((resolve) => relay.on('exit', resolve));
  let relayOut = '';
  relay.stdout.on('data', (c) => (relayOut += c));
  await until(() => relayOut.includes('listening'), 5000, 'the relay to listen');

  const companion = spawnCompanion({ port: PORT, modelPort: model.address().port, scratch });
  const companionExited = new Promise((resolve) => companion.child.on('exit', resolve));
  const panel = connectPanel(PORT);
  const panels = [panel];
  t.after(async () => {
    for (const p of panels) p.close();
    if (companion.child.exitCode === null && companion.child.signalCode === null) {
      companion.child.kill('SIGKILL');
      await companionExited;
    }
    relay.kill();
    await relayExited;
    model.closeAllConnections();
    model.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  await until(() => panel.events.some((e) => e.type === 'status' && e.companionOnline), 10000, 'companion online');
  assert.equal(await panel.sendMessage('any hints?', 'two-sum'), 202);
  await until(() => panel.events.some((e) => e.type === 'chunk' && e.text === 'Half of a reply'), 10000, 'the first half of the reply');
  const turnId = panel.events.find((e) => e.type === 'turn-start').turnId;

  // A crash: no exit handlers, no last words.
  companion.child.kill('SIGKILL');
  await companionExited;

  await until(() => panel.events.filter((e) => e.type === 'status').pop().companionOnline === false, 5000, 'companion offline');
  const end = panel.events.find((e) => e.type === 'turn-end' && e.turnId === turnId);
  assert.ok(end, `the cut reply never got a turn-end: ${JSON.stringify(panel.events)}`);
  assert.deepEqual([end.interrupted, end.text, end.problemSlug], [true, 'Half of a reply', 'two-sum']);

  // A tab opened afterwards is told the same.
  const late = connectPanel(PORT);
  panels.push(late);
  await until(() => late.events.some((e) => e.type === 'status'), 5000, 'the late tab to catch up');
  assert.deepEqual(
    late.events.filter((e) => e.turnId === turnId).map((e) => [e.type, e.interrupted === true]),
    [
      ['turn-start', false],
      ['turn-end', true],
    ]
  );
});

// ---- end to end: switching the tutor's model from the options page ----------
//
// A real companion.js and the real relay it starts, two stub models, and this
// test playing both the Tutor panel and the extension's options page (POST
// /settings/rpc with an extension Origin). The settings file is a temp path.

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function startRecordingModel(name) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/chat(\/completions)?$/.test(req.url)) return void res.writeHead(404).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ body: JSON.parse(body), authorization: req.headers.authorization || null });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${name} reply ${requests.length}` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function postJson(port, route, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
}

test('end to end: a provider change saved from the options page takes over the next message and resets the held code', async (t) => {
  const modelA = await startRecordingModel('A');
  const modelB = await startRecordingModel('B');
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-swap-e2e-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');
  const settingsFile = path.join(scratch, 'config', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ version: 1, provider: 'local', providers: { local: { model: 'model-a', baseUrl: modelA.url, contextTokens: 32768 } } })
  );
  const env = { ...process.env };
  for (const name of [
    'COMPANION_BACKEND',
    'COMPANION_MODEL',
    'COMPANION_BASE_URL',
    'COMPANION_API_KEY',
    'COMPANION_LOCAL_NUM_CTX',
    'VAULT_AUTO_SUMMARY',
    'COMPANION_AUTO_CLEAR_CONTEXT',
    'COMPANION_LOCAL_MAX_HISTORY_TURNS',
  ]) {
    delete env[name];
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...env,
      LEETCODE_CAPTURE_SETTINGS: settingsFile,
      COMPANION_LOCAL_API: 'openai',
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: String(port),
      CAPTURE_LOG_PATH: capturesPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (out += c.toString()));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let panel = null;
  t.after(async () => {
    if (panel) panel.close();
    child.kill();
    await exited;
    modelA.server.close();
    modelB.server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  await until(() => out.includes('companion: backend=local (Local model) model=model-a'), 10000, 'the banner naming the saved model');
  let relayUp = false;
  for (let i = 0; i < 100 && !relayUp; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    relayUp = await fetch(`http://127.0.0.1:${port}/capture`, { method: 'OPTIONS' }).then(
      () => true,
      () => false
    );
    // eslint-disable-next-line no-await-in-loop
    if (!relayUp) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(relayUp, 'relay server never came up');
  panel = connectPanel(port);
  await until(() => out.includes('in-page panel connected'), 10000, 'the panel bridge');
  await until(() => panel.events.some((e) => e.type === 'config' && e.model === 'model-a'), 10000, 'the first config event');
  const firstConfig = panel.events.find((e) => e.type === 'config');
  assert.deepEqual({ provider: firstConfig.provider, label: firstConfig.label, model: firstConfig.model }, { provider: 'local', label: 'Local model', model: 'model-a' });

  const code = 'def twoSum(nums, target):\n    seen = {}\n    return []';
  const message = (text) =>
    postJson(
      port,
      '/panel/message',
      { text, problemSlug: 'two-sum', snapshot: { code, language: 'python3', problemTitle: 'Two Sum' } },
      { origin: LEETCODE }
    );
  const turnEnds = () => panel.events.filter((e) => e.type === 'turn-end').length;

  assert.equal((await message('first question')).status, 202);
  await until(() => turnEnds() === 1, 10000, 'the first reply');
  assert.equal(modelA.requests.length, 1);
  assert.match(JSON.stringify(modelA.requests[0].body.messages), /seen = \{\}/, 'the first message carries the full code');

  assert.equal((await message('second question')).status, 202);
  await until(() => turnEnds() === 2, 10000, 'the second reply');
  const second = modelA.requests[1].body.messages;
  assert.equal(second[second.length - 1].content.includes('seen = {}'), false, 'unchanged code is not sent again');

  // A web page cannot reach the settings route.
  const fromPage = await postJson(port, '/settings/rpc', { method: 'get', params: {} }, { origin: LEETCODE });
  assert.equal(fromPage.status, 403);

  // The options page saves model B, with an API key.
  const saved = await postJson(
    port,
    '/settings/rpc',
    { method: 'save', params: { patch: { provider: 'local', providers: { local: { model: 'model-b', baseUrl: modelB.url, apiKey: 'sk-test-secret-key-123' } } } } },
    { origin: EXTENSION_ORIGIN, 'sec-fetch-mode': 'cors' }
  );
  assert.equal(saved.status, 200, saved.text);
  const savedBody = JSON.parse(saved.text);
  assert.equal(savedBody.ok, true, saved.text);
  assert.equal(savedBody.result.active.model, 'model-b');
  assert.equal(savedBody.result.settings.providers.local.hasKey, true);
  assert.ok(!saved.text.includes('sk-test-secret-key-123'), 'the key never goes back to the page');
  const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(onDisk.providers.local.model, 'model-b');
  assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);

  await until(() => panel.events.some((e) => e.type === 'config' && e.model === 'model-b'), 10000, 'the new config event');
  assert.ok(panel.events.every((e) => !JSON.stringify(e).includes('sk-test-secret-key-123')), 'no key in any panel event');
  await until(() => out.includes('settings saved - now using Local model (model-b)'), 5000, 'the terminal note');

  assert.equal((await message('third question')).status, 202);
  await until(() => turnEnds() === 3, 10000, 'the third reply');
  assert.equal(modelA.requests.length, 2, 'model A gets nothing after the swap');
  assert.equal(modelB.requests.length, 1, 'the next message goes to model B');
  const third = modelB.requests[0];
  assert.equal(third.body.model, 'model-b');
  assert.equal(third.authorization, 'Bearer sk-test-secret-key-123');
  const thirdText = JSON.stringify(third.body.messages);
  const thirdLast = third.body.messages[third.body.messages.length - 1];
  assert.equal(thirdLast.role, 'user');
  assert.match(thirdLast.content, /in full:[\s\S]*seen = \{\}/, 'the swap reset the held code, so the message carries the full code again');
  assert.ok(!thirdText.includes('first question'), 'the new backend starts a fresh conversation');
  assert.ok(!out.includes('sk-test-secret-key-123'), 'the key is never printed');

  // A panel that connects now gets the newest config right away.
  const late = connectPanel(port);
  t.after(() => late.close());
  await until(() => late.events.some((e) => e.type === 'status'), 5000, 'the late panel');
  assert.deepEqual(
    late.events.filter((e) => e.type === 'config').map((e) => e.model),
    ['model-b']
  );
});

// Condensing older exchanges (context-summary.js) is silent: its model call
// is not streamed, so nothing of it reaches the panel feed, it adds no turn,
// notice or status of its own, and a backend swap leaves the summary behind.
test('end to end: the summary call never reaches the panel, and a swap clears the summary', async (t) => {
  const SECRET = 'SECRET-SUMMARY-TEXT';
  const makeModel = (name) => {
    const turns = [];
    const summaries = [];
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !/\/chat(\/completions)?$/.test(req.url)) return void res.writeHead(404).end();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (parsed.messages[0].content === SUMMARIZER_SYSTEM) {
          summaries.push(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `${SECRET} from ${name}` }, finish_reason: 'stop' }] }));
          return;
        }
        turns.push(parsed);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${name} reply ${turns.length}` } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, turns, summaries, url: `http://127.0.0.1:${server.address().port}/v1` })));
  };
  const modelA = await makeModel('A');
  const modelB = await makeModel('B');
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-summary-panel-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');
  const settingsFile = path.join(scratch, 'config', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, provider: 'local', providers: { local: { model: 'model-a', baseUrl: modelA.url } } }));
  const env = { ...process.env };
  for (const name of ['COMPANION_BACKEND', 'COMPANION_MODEL', 'COMPANION_BASE_URL', 'COMPANION_API_KEY', 'COMPANION_LOCAL_NUM_CTX']) delete env[name];
  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...env,
      LEETCODE_CAPTURE_SETTINGS: settingsFile,
      COMPANION_LOCAL_API: 'openai',
      // Only one exchange is kept whole, so the third message condenses.
      COMPANION_LOCAL_MAX_HISTORY_TURNS: '1',
      COMPANION_AUTO_CLEAR_CONTEXT: '1',
      VAULT_AUTO_SUMMARY: '0',
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: String(port),
      CAPTURE_LOG_PATH: capturesPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (out += c.toString()));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let panel = null;
  t.after(async () => {
    if (panel) panel.close();
    child.kill();
    await exited;
    modelA.server.close();
    modelB.server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  let relayUp = false;
  for (let i = 0; i < 100 && !relayUp; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    relayUp = await fetch(`http://127.0.0.1:${port}/capture`, { method: 'OPTIONS' }).then(() => true, () => false);
    // eslint-disable-next-line no-await-in-loop
    if (!relayUp) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(relayUp, 'relay server never came up');
  panel = connectPanel(port);
  await until(() => out.includes('in-page panel connected'), 10000, 'the panel bridge');
  await until(() => panel.events.some((e) => e.type === 'config' && e.model === 'model-a'), 10000, 'the config event');

  const turnEnds = () => panel.events.filter((e) => e.type === 'turn-end').length;
  for (let i = 1; i <= 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await panel.sendMessage(`question ${i}. More.`, 'two-sum'), 202);
    // eslint-disable-next-line no-await-in-loop
    await until(() => turnEnds() === i, 10000, `reply ${i}`);
  }
  assert.equal(modelA.summaries.length, 1, 'the third message condensed the first exchange');
  assert.equal(modelA.summaries[0].stream, false);
  const third = modelA.turns[2].messages;
  assert.ok(third.some((m) => m.role === 'system' && m.content === `${SUMMARY_HEADER}\n${SECRET} from A`), 'the summary is in the request');
  assert.ok(!third.some((m) => m.role === 'user' && m.content.includes('question 1')), 'the condensed exchange is not sent whole');

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!panel.events.some((e) => JSON.stringify(e).includes(SECRET)), 'no summary text in the panel feed');
  assert.equal(panel.events.filter((e) => e.type === 'turn-start').length, 3, 'no extra tutor turn');
  assert.equal(panel.events.filter((e) => e.type === 'notice').length, 0, 'no notice');
  assert.deepEqual(
    panel.events.filter((e) => e.type === 'turn-end').map((e) => e.text),
    ['A reply 1', 'A reply 2', 'A reply 3']
  );
  let busyStarts = 0;
  let wasBusy = false;
  for (const e of panel.events.filter((x) => x.type === 'status')) {
    if (e.busy && !wasBusy) busyStarts += 1;
    wasBusy = Boolean(e.busy);
  }
  assert.ok(busyStarts <= 3, `the status light went busy ${busyStarts} times for 3 messages`);
  assert.ok(!out.includes(SECRET), 'nothing of it in the terminal either');

  // Swap to model B: the new backend starts without the summary.
  const saved = await postJson(
    port,
    '/settings/rpc',
    { method: 'save', params: { patch: { provider: 'local', providers: { local: { model: 'model-b', baseUrl: modelB.url } } } } },
    { origin: EXTENSION_ORIGIN, 'sec-fetch-mode': 'cors' }
  );
  assert.equal(saved.status, 200, saved.text);
  await until(() => out.includes('now using Local model (model-b)'), 5000, 'the swap');
  assert.equal(await panel.sendMessage('question 4', 'two-sum'), 202);
  await until(() => turnEnds() === 4, 10000, 'reply 4');
  assert.equal(modelB.turns.length, 1);
  const afterSwap = JSON.stringify(modelB.turns[0].messages);
  assert.ok(!afterSwap.includes(SUMMARY_HEADER) && !afterSwap.includes(SECRET), 'a swap clears the summary');
});
