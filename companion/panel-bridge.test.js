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
// open so the test can push messages down it.
function startStubRelay({ inboxStatus = 200 } = {}) {
  const published = [];
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
    server.listen(0, '127.0.0.1', () =>
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        published,
        flat: () => published.flat(),
        send: (message) => {
          for (const res of inboxClients) res.write(`id: 1\ndata: ${JSON.stringify(message)}\n\n`);
        },
        dropInbox: () => {
          for (const res of inboxClients) res.destroy();
        },
        inboxConnections: () => inboxConnections,
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

// ---- end to end: real companion.js + real relay + stub model ----------------

function startStubModel(replyFor) {
  const requests = [];
  const server = http.createServer((req, res) => {
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

  // 2. A capture is mirrored as a capture event plus its own tutor turn.
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
  await until(() => panel.events.filter((e) => e.type === 'turn-end').length >= 2, 10000, 'capture turn-end');
  const capture = panel.events.find((e) => e.type === 'capture');
  assert.deepEqual(
    { slug: capture.problemSlug, trigger: capture.trigger, seq: capture.attemptSeq, title: capture.problemTitle },
    { slug: 'two-sum', trigger: 'run', seq: 1, title: 'Two Sum' }
  );

  // 3. Switching to another problem in the panel starts a fresh tutor session.
  const before = requests.length;
  assert.equal(await panel.sendMessage('what about brackets?', 'valid-parentheses'), 202);
  await until(() => requests.length > before, 10000, 'model request for the second problem');
  const switched = requests[requests.length - 1].messages;
  assert.ok(!JSON.stringify(switched).includes('any hints?'), 'earlier problem history is cleared on a switch');
  assert.ok(JSON.stringify(switched).includes('valid-parentheses'), 'the tutor is told which problem is on screen');
  await until(() => panel.events.some((e) => e.type === 'notice' && /fresh tutor session/.test(e.text)), 5000, 'reset notice');
});
