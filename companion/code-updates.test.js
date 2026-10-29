// End to end: when the tutor is sent the student's code, and how (see
// code-ledger.js for the rules and code-ledger.test.js for their unit
// tests). A real companion.js starts a real relay server on its own port,
// captures arrive through the relay's /capture route the way the extension
// sends them, panel messages through /panel/message, and a stub model records
// every request.
//
// Run with: node --test code-updates.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEETCODE = 'https://leetcode.com';

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

// A model that records each request's messages and streams back
// "Reply <n>", or answers 500 while `failNext` is above zero.
function startStubModel() {
  const requests = [];
  const state = { failNext: 0, delayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      requests.push(JSON.parse(body).messages);
      if (state.delayMs) await pause(state.delayMs);
      if (state.failNext > 0) {
        state.failNext -= 1;
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('stub failure');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Reply ${requests.length}` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, state })));
}

function request(port, { method, route, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: route, method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    r.on('error', reject);
    r.end(payload);
  });
}

// Everything the relay holds for the panel right now: opens the event stream,
// keeps what the replay delivers, then closes it.
function relayEvents(port) {
  return new Promise((resolve) => {
    const events = [];
    let buffer = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/panel/events?after=0', headers: { origin: LEETCODE } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!data) continue;
          const event = JSON.parse(data);
          // The status event always comes right after the replayed buffer.
          if (event.type === 'status') {
            req.destroy();
            resolve(events);
            return;
          }
          events.push(event);
        }
      });
    });
    req.on('error', () => resolve(events));
  });
}

async function startCompanion(t, { port }) {
  const model = await startStubModel();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-code-updates-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');
  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${model.server.address().port}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      CAPTURE_LOG_PATH: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: String(port),
      COMPANION_AUTO_CLEAR_CONTEXT: '1',
      VAULT_AUTO_SUMMARY: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (out += c.toString()));
  t.after(async () => {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    model.server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await until(() => out.includes('in-page panel connected'), 15000, 'the companion and its relay');
  let attempt = 0;
  const companion = {
    model,
    requests: model.requests,
    out: () => out,
    lastUser: () => {
      const messages = model.requests[model.requests.length - 1];
      return messages[messages.length - 1].content;
    },
    lastPrompt: () => JSON.stringify(model.requests[model.requests.length - 1]),
    async capture(fields) {
      attempt += 1;
      const res = await request(port, {
        method: 'POST',
        route: '/capture',
        body: {
          problemSlug: 'two-sum',
          problemTitle: 'Two Sum',
          problemDescription: 'TWO-SUM-STATEMENT',
          language: 'Python3',
          timestamp: new Date().toISOString(),
          ...fields,
        },
      });
      assert.equal(res.status, 200, res.text);
      return attempt;
    },
    async panel(text, problemSlug, snapshot) {
      const res = await request(port, {
        method: 'POST',
        route: '/panel/message',
        headers: { origin: LEETCODE },
        body: snapshot ? { text, problemSlug, snapshot } : { text, problemSlug },
      });
      assert.equal(res.status, 202, res.text);
    },
    type(text) {
      child.stdin.write(`${text}\n`);
    },
    // Waits for the queue to go quiet: every request answered (or failed).
    async settle() {
      await pause(400);
    },
    relayEvents: () => relayEvents(port),
  };
  return companion;
}

// Long enough that a small edit is a real saving over the full code.
function solution(marker) {
  return [
    'def twoSum(nums, target):',
    '    seen = {}',
    '    for i, val in enumerate(nums):',
    '        complement = target - val',
    '        if complement in seen:',
    '            return [seen[complement], i]',
    `        seen[val] = i  # ${marker}`,
    '    return []',
    ...Array.from({ length: 30 }, (_, i) => `# a note about the approach, line ${i}`),
  ].join('\n');
}

test('Runs are only recorded; a Submit goes only when changed; messages carry diffs against what the tutor holds', async (t) => {
  const c = await startCompanion(t, { port: 18210 });

  // 1. A Run never calls the model. It shows as a quiet chip in the panel.
  await c.capture({ trigger: 'run', code: solution('run one') });
  await until(() => c.out().includes('recorded your Run for Two Sum'), 10000, 'the Run note');
  await pause(800);
  assert.equal(c.requests.length, 0, 'a Run must not reach the model');
  const runChip = (await c.relayEvents()).find((e) => e.type === 'capture');
  assert.equal(runChip.trigger, 'run');
  assert.equal(runChip.note, undefined, 'a Run is recorded silently in the panel');
  assert.ok(!(await c.relayEvents()).some((e) => e.type === 'turn-start'), 'no tutor turn for a Run');

  // 2. The first Submit carries the full code, with the statement.
  await c.capture({ trigger: 'submit', code: solution('first submit') });
  await until(() => c.requests.length === 1, 10000, 'the Submit request');
  await until(() => c.out().includes('Reply 1'), 10000, 'the Submit reply');
  assert.match(c.lastUser(), /^\[LeetCode capture\] Submit - Two Sum \(two-sum\)\n\nThe student's current code \(Python3\), in full:/);
  assert.match(c.lastUser(), /# first submit/);
  assert.match(c.lastUser(), /This was a Submit/);
  assert.match(c.lastPrompt(), /TWO-SUM-STATEMENT/);
  await c.settle();

  // 3. The same code submitted again is not sent.
  await c.capture({ trigger: 'submit', code: solution('first submit') });
  await until(() => c.out().includes('unchanged since the tutor last saw it'), 10000, 'the unchanged note');
  await pause(500);
  assert.equal(c.requests.length, 1, 'an unchanged Submit must not reach the model');
  assert.ok(!(await c.relayEvents()).some((e) => e.type === 'notice'), 'an unchanged Submit shows nothing in the panel');

  // 4. Three Runs, then a message typed in the terminal: only the diff from
  // what the tutor holds to the newest Run.
  await c.capture({ trigger: 'run', code: solution('run two') });
  await c.capture({ trigger: 'run', code: solution('run three') });
  await c.capture({ trigger: 'run', code: solution('run four') });
  await until(() => (c.out().match(/recorded your Run/g) || []).length === 4, 10000, 'the three Run notes');
  await pause(300);
  assert.equal(c.requests.length, 1);
  c.type('why does this work?');
  await until(() => c.requests.length === 2, 10000, 'the terminal message request');
  let last = c.lastUser();
  assert.match(last, /^Changes to the student's code since the version you last saw \(Python3, \+1\/-1 lines\):/);
  assert.match(last, /^- +\| {9}seen\[val\] = i {2}# first submit$/m);
  assert.match(last, /^\+ +7 \| {9}seen\[val\] = i {2}# run four$/m);
  assert.ok(!/run two|run three/.test(c.lastPrompt()), 'intermediate Runs are not sent');
  assert.ok(!last.includes('in full'), 'no full code once the tutor holds it');
  assert.match(last, /The student's message:\nwhy does this work\?$/);
  // LocalBackend pins what the tutor held before this turn.
  const pinned = c.requests[1].find((m) => m.role === 'system' && /exactly as you last saw it/.test(m.content));
  assert.ok(pinned && pinned.content.includes('# first submit'), 'the held code is pinned');
  // The older turn's full code is not resent next to the pinned copy.
  assert.equal((c.lastPrompt().match(/a note about the approach, line 29/g) || []).length, 1);
  await until(() => c.out().includes('Reply 2'), 10000, 'the reply');
  await c.settle();

  // 5. A panel message with the live editor code: the diff from the newest
  // Run (now held) to the editor.
  await c.panel('and now?', 'two-sum', { code: solution('typed in the editor'), language: 'Python3' });
  await until(() => c.requests.length === 3, 10000, 'the panel message request');
  last = c.lastUser();
  assert.match(last, /^- +\| {9}seen\[val\] = i {2}# run four$/m);
  assert.match(last, /^\+ +7 \| {9}seen\[val\] = i {2}# typed in the editor$/m);
  await until(() => c.out().includes('Reply 3'), 10000, 'the reply');
  await c.settle();

  // 6. Unchanged editor code adds nothing to the message.
  await c.panel('one more question', 'two-sum', { code: solution('typed in the editor'), language: 'Python3' });
  await until(() => c.requests.length === 4, 10000, 'the second panel message');
  assert.equal(c.lastUser(), 'one more question');
  await until(() => c.out().includes('Reply 4'), 10000, 'the reply');
  await c.settle();

  // 7. A Submit of what the tutor already holds (from the panel message) is
  // skipped too, and a changed Submit goes as a diff.
  await c.capture({ trigger: 'submit', code: solution('typed in the editor') });
  await until(() => (c.out().match(/unchanged since the tutor last saw it/g) || []).length === 2, 10000, 'the second unchanged note');
  await pause(300);
  assert.equal(c.requests.length, 4);
  await c.capture({ trigger: 'submit', code: solution('final') });
  await until(() => c.requests.length === 5, 10000, 'the changed Submit');
  last = c.lastUser();
  assert.match(last, /^\[LeetCode capture\] Submit - Two Sum \(two-sum\)\n\nChanges to the student's code/);
  assert.match(last, /# final$/m);
  assert.match(last, /This was a Submit/);
});

test('a failed backend call leaves what the tutor holds unchanged', async (t) => {
  const c = await startCompanion(t, { port: 18212 });
  c.model.state.failNext = 1;
  await c.capture({ trigger: 'submit', code: solution('v1') });
  await until(() => c.out().includes('error talking to backend'), 10000, 'the backend error');
  await c.settle();

  // The tutor never got v1, so the same Submit goes again, in full.
  await c.capture({ trigger: 'submit', code: solution('v1') });
  await until(() => c.requests.length === 2, 10000, 'the retried Submit');
  assert.match(c.lastUser(), /in full:/);
  await until(() => c.out().includes('Reply 2'), 10000, 'the reply');
  await c.settle();

  // A message that fails does not advance it either.
  await c.capture({ trigger: 'run', code: solution('v2') });
  await until(() => c.out().includes('recorded your Run'), 10000, 'the Run note');
  c.model.state.failNext = 1;
  c.type('first try');
  await until(() => c.requests.length === 3, 10000, 'the failing message');
  await until(() => (c.out().match(/error talking to backend/g) || []).length === 2, 10000, 'the second error');
  await c.settle();
  c.type('second try');
  await until(() => c.requests.length === 4, 10000, 'the retried message');
  assert.match(c.lastUser(), /# v1$/m, 'still a diff against v1');
  assert.match(c.lastUser(), /# v2$/m);
});

test('a diff nearly as long as the code is replaced by the full code', async (t) => {
  const c = await startCompanion(t, { port: 18214 });
  await c.capture({ trigger: 'submit', code: solution('v1') });
  await until(() => c.out().includes('Reply 1'), 10000, 'the first reply');
  await c.settle();
  const rewrite = Array.from({ length: 40 }, (_, i) => `x${i} = ${i * 3}`).join('\n');
  await c.capture({ trigger: 'submit', code: rewrite });
  await until(() => c.requests.length === 2, 10000, 'the rewrite');
  assert.match(c.lastUser(), /The student's current code \(Python3\), in full:/);
  assert.ok(c.lastUser().includes(rewrite));
  assert.ok(!c.lastUser().includes('```diff'));
});

test('activity on another problem resets everything, and the next message carries the full code', async (t) => {
  const c = await startCompanion(t, { port: 18216 });
  // Problem A: a Submit, a chat, and the panel transcript for it.
  await c.capture({ trigger: 'submit', code: solution('A code') });
  await until(() => c.out().includes('Reply 1'), 10000, 'the A reply');
  await c.settle();
  await c.panel('a question on A', 'two-sum');
  await until(() => c.out().includes('Reply 2'), 10000, 'the A chat reply');
  await c.settle();
  assert.ok((await c.relayEvents()).some((e) => e.problemSlug === 'two-sum'));

  // A Run on problem B makes B active and resets, without calling the model.
  await c.capture({
    trigger: 'run',
    problemSlug: 'house-robber',
    problemTitle: 'House Robber',
    problemDescription: 'HOUSE-ROBBER-STATEMENT',
    code: 'def rob(nums):\n    return max(nums)',
  });
  await until(() => c.out().includes('new problem detected (house-robber)'), 10000, 'the reset notice');
  await pause(500);
  assert.equal(c.requests.length, 2, 'a Run on B must not reach the model');
  const events = await c.relayEvents();
  assert.ok(!events.some((e) => e.problemSlug === 'two-sum'), `the relay still holds A's chat: ${JSON.stringify(events)}`);
  assert.ok(events.some((e) => e.type === 'notice' && e.problemSlug === 'house-robber'));

  // The first message on B carries B's statement and its full code, and
  // nothing of A.
  await c.panel('where do I start?', 'house-robber', { code: 'def rob(nums):\n    return max(nums)', language: 'Python3' });
  await until(() => c.requests.length === 3, 10000, 'the B message');
  const prompt = c.lastPrompt();
  assert.ok(!/A code|a question on A|TWO-SUM-STATEMENT/.test(prompt), `A leaked into B: ${prompt}`);
  assert.match(prompt, /HOUSE-ROBBER-STATEMENT/);
  assert.match(c.lastUser(), /The student's current code \(Python3\), in full:\n\n```python\ndef rob\(nums\):\n {4}return max\(nums\)\n```/);
  await until(() => c.out().includes('Reply 3'), 10000, 'the B reply');
  await c.settle();

  // Back on A from the panel: reset again, and A starts over with its full
  // live code and the statement the panel read from the page.
  await c.panel('back on two sum', 'two-sum', {
    code: solution('A again'),
    language: 'Python3',
    problemTitle: 'Two Sum',
    problemDescription: 'TWO-SUM-STATEMENT-FROM-PAGE',
  });
  await until(() => c.requests.length === 4, 10000, 'the message back on A');
  assert.ok(!/HOUSE-ROBBER|def rob/.test(c.lastPrompt()), 'B is gone after the second switch');
  assert.match(c.lastPrompt(), /TWO-SUM-STATEMENT-FROM-PAGE/);
  assert.match(c.lastUser(), /in full:[\s\S]*# A again/);
  await until(() => c.out().includes('Reply 4'), 10000, 'the reply back on A');
  const after = await c.relayEvents();
  assert.ok(!after.some((e) => e.problemSlug === 'house-robber'), "the relay dropped B's chat on the way back");
});

test('a panel message whose editor could not be read goes without code; the newest Run does not stand in', async (t) => {
  const c = await startCompanion(t, { port: 18218 });
  await c.capture({ trigger: 'run', code: solution('only run') });
  await until(() => c.out().includes('recorded your Run for Two Sum'), 10000, 'the Run note');
  await c.panel('is this right?', 'two-sum');
  await until(() => c.requests.length === 1, 10000, 'the message');
  assert.ok(!c.lastPrompt().includes('# only run'), `the Run's code was sent: ${c.lastUser()}`);
  assert.match(c.lastUser(), /The student's editor could not be read, so their current code is not included/);
  assert.match(c.lastUser(), /is this right\?$/);
  await c.settle();
  // The next message that does carry the editor code sends it in full.
  await c.panel('and now?', 'two-sum', { code: solution('typed'), language: 'Python3' });
  await until(() => c.requests.length === 2, 10000, 'the second message');
  assert.match(c.lastUser(), /in full:[\s\S]*# typed/);
});

// Every status event the relay sends a panel, from now on.
function watchStatus(port) {
  const statuses = [];
  let buffer = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/panel/events?after=0', headers: { origin: LEETCODE } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === 'status') statuses.push(event.busy);
      }
    });
  });
  req.on('error', () => {});
  return { statuses, close: () => req.destroy() };
}

test("the panel's busy flag: on while a message or Submit is queued or answered, never for a Run or an unchanged Submit", async (t) => {
  const c = await startCompanion(t, { port: 18220 });
  const watch = watchStatus(18220);
  t.after(() => watch.close());
  await until(() => watch.statuses.length >= 1, 5000, 'the first status');

  await c.capture({ trigger: 'run', code: solution('run') });
  await until(() => c.out().includes('recorded your Run'), 10000, 'the Run');
  await pause(400);
  assert.ok(!watch.statuses.includes(true), `a Run made the tutor busy: ${watch.statuses}`);

  // Two messages back to back on a slow model: busy from the first until the
  // second is answered, with no idle gap between them.
  c.model.state.delayMs = 600;
  const from = watch.statuses.length;
  await c.panel('first?', 'two-sum', { code: solution('run'), language: 'Python3' });
  await c.panel('second?', 'two-sum', { code: solution('run'), language: 'Python3' });
  await until(() => watch.statuses.slice(from).includes(true), 5000, 'busy');
  await until(() => c.requests.length === 2 && watch.statuses.at(-1) === false, 10000, 'idle again');
  assert.deepEqual(watch.statuses.slice(from), [true, false], 'one busy stretch for both messages');

  // A changed Submit is busy too; the same code again is not.
  const before = watch.statuses.length;
  await c.capture({ trigger: 'submit', code: solution('submitted') });
  await until(() => c.requests.length === 3 && watch.statuses.at(-1) === false, 10000, 'the Submit to finish');
  assert.deepEqual(watch.statuses.slice(before), [true, false]);
  const afterSubmit = watch.statuses.length;
  await c.capture({ trigger: 'submit', code: solution('submitted') });
  await until(() => c.out().includes('unchanged since the tutor last saw it'), 10000, 'the unchanged Submit');
  await pause(400);
  assert.deepEqual(watch.statuses.slice(afterSubmit), [], 'an unchanged Submit never shows as busy');
});
