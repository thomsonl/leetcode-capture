// End to end: the local backend's context window, through a real
// companion.js subprocess against stub model servers.
//
// - A long conversation never gets stuck over the prompt budget: the oldest
//   whole exchanges are dropped to fit (context-budget.js's fitToBudget), on
//   every request, including the one right after a refusal.
// - With COMPANION_LOCAL_API=auto the API style comes from probing the
//   server (local-server.js), not from the exact base URL, and the window is
//   the smaller of the configured one and what the server reports.
// - A server that silently cuts the prompt (it reports far fewer prompt
//   tokens than were sent) is caught after the reply: one warning, and the
//   next request is trimmed to the window the server really has.
//
// Run with: node --test context-window.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SUMMARIZER_SYSTEM, SUMMARY_HEADER, SUMMARY_MAX_TOKENS, summaryBodyChars } from './context-summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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

// A port nothing listens on right now, for the relay the companion starts.
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

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// A stub model server. `routes` maps "METHOD /path" to a handler
// `(body, req, res)`; anything else answers 404, like a real server that
// does not know a probe's route. Every request is recorded. A summary call
// (the companion condensing older exchanges, context-summary.js) goes to
// `routes.summary` instead, or gets a 500 when there is none, and is recorded
// in `summaries` only, so the tutor-turn handlers never see one.
function startStub(routes) {
  const seen = [];
  const summaries = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      if (body?.messages?.[0]?.content === SUMMARIZER_SYSTEM) {
        summaries.push(body);
        if (routes.summary) routes.summary(body, req, res);
        else res.writeHead(500).end('no summaries here');
        return;
      }
      seen.push({ method: req.method, url: req.url, body });
      const handler = routes[`${req.method} ${req.url}`];
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      handler(body, req, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, summaries })));
}

async function startCompanion(t, { baseUrl, env = {} }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-context-window-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');
  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: baseUrl,
      LEETCODE_CAPTURES_FILE: capturesPath,
      CAPTURE_LOG_PATH: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: String(await freePort()),
      COMPANION_PANEL: '0',
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
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await pause(1500);
  let attempt = 0;
  return {
    out: () => out,
    capture(fields) {
      attempt += 1;
      fs.appendFileSync(
        capturesPath,
        JSON.stringify({
          receivedAt: new Date().toISOString(),
          problemSlug: 'two-sum',
          problemTitle: 'Two Sum',
          problemTags: [],
          language: 'python3',
          trigger: 'submit',
          timestamp: new Date().toISOString(),
          url: 'https://leetcode.com/problems/two-sum/',
          attemptSeq: attempt,
          ...fields,
        }) + '\n'
      );
    },
    type(text) {
      child.stdin.write(`${text}\n`);
    },
  };
}

// About 450 tokens by the companion's own estimate, like a long tutor reply.
const LONG_REPLY = 'The tutor explains another detail of the approach here. '.repeat(31);
// A big problem statement, about 1,540 estimated tokens.
const BIG_DESCRIPTION = 'Given an array of integers and a target, find the pair that adds up to it. '.repeat(80);

// Waits for the turn that starts at output offset `from` to end, with a
// reply or an error, and returns what it printed.
async function turnOutput(c, from, what) {
  await until(() => /Reply \d+|error talking to backend/.test(c.out().slice(from)), 10000, what);
  await pause(250);
  return c.out().slice(from);
}

// The user's report: a normal-size problem plus a few long tutor replies
// fill the prompt budget, and from then on every message is refused until a
// problem switch, because history was only trimmed by turn count and only
// after a successful reply. Here the budget is 4,700 estimated tokens (a
// 7,300 window minus the default 2,600 reserve), the pinned system prompt,
// statement and code take about 2,600, and each exchange about 470, so the
// sixth message does not fit with all five earlier exchanges.
test('a long conversation never gets stuck over the budget: the oldest exchanges are condensed to fit', async (t) => {
  const requests = [];
  const stub = await startStub({
    'POST /v1/chat/completions': (body, req, res) => {
      requests.push(body.messages);
      sse(res, [
        { choices: [{ delta: { content: `Reply ${requests.length}. ${LONG_REPLY}` } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    },
  });
  t.after(() => stub.server.close());
  const c = await startCompanion(t, {
    baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1`,
    env: { COMPANION_LOCAL_NUM_CTX: '7300' },
  });

  let from = c.out().length;
  c.capture({ problemDescription: BIG_DESCRIPTION, code: 'def twoSum(nums, target):\n    return []\n' });
  let printed = await turnOutput(c, from, 'the Submit reply');
  assert.match(printed, /Reply 1\./);

  for (let i = 2; i <= 8; i += 1) {
    from = c.out().length;
    c.type(`question number ${i} about my approach`);
    // eslint-disable-next-line no-await-in-loop
    printed = await turnOutput(c, from, `message ${i}`);
    assert.ok(!printed.includes('error talking to backend'), `message ${i} was refused: ${printed}`);
    assert.match(printed, new RegExp(`Reply ${i}\\.`));
  }

  // Older exchanges were really taken out, a whole exchange at a time, and
  // the pinned statement stayed.
  const last = requests[requests.length - 1];
  assert.ok(last.filter((m) => m.role === 'assistant').length < 6, 'some exchanges were dropped');
  assert.ok(last.some((m) => m.role === 'system' && m.content.includes(BIG_DESCRIPTION)));
  let start = 1;
  while (last[start].role === 'system') start += 1;
  for (let i = start; i < last.length; i += 2) {
    assert.equal(last[i].role, 'user');
    if (i + 1 < last.length) assert.equal(last[i + 1].role, 'assistant');
  }
  assert.equal(last[last.length - 1].content, 'question number 8 about my approach');
});

// Only the parts that can never be dropped (system prompt, statement, code
// and the current message) over the budget is a refusal, which names them.
// The next, normal message must then go through.
test('a message that cannot fit even alone is refused by name, and the next one still goes', async (t) => {
  const requests = [];
  const stub = await startStub({
    'POST /v1/chat/completions': (body, req, res) => {
      requests.push(body.messages);
      sse(res, [
        { choices: [{ delta: { content: `Reply ${requests.length}.` } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    },
  });
  t.after(() => stub.server.close());
  const c = await startCompanion(t, {
    baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1`,
    env: { COMPANION_LOCAL_NUM_CTX: '5000' },
  });

  let from = c.out().length;
  c.capture({ problemDescription: 'Find two numbers that add up to target.', code: 'def f():\n    return 1\n' });
  assert.match(await turnOutput(c, from, 'the Submit reply'), /Reply 1\./);

  from = c.out().length;
  c.type(`please read this ${'very long pasted text '.repeat(600)}`);
  const refused = await turnOutput(c, from, 'the refusal');
  assert.match(
    refused,
    /this request is estimated at ~\d+ prompt tokens, over the \d+-token budget.*this message ~\d+/s,
    refused
  );
  assert.equal(requests.length, 1, 'the oversized message was never sent');

  from = c.out().length;
  c.type('a normal question');
  assert.match(await turnOutput(c, from, 'the next message'), /Reply 2\./);
  const last = requests[1];
  assert.ok(!JSON.stringify(last).includes('very long pasted text'), 'the refused message is not in history');
  assert.equal(last[last.length - 1].content, 'a normal question');
});

const estimate = (messages) => messages.reduce((sum, m) => sum + Math.ceil((m.content || '').length / 3.9), 0);

// The exact-address check is gone: an Ollama on 127.0.0.1 and some other
// port is found by probing, gets the native API (the only one that honors
// num_ctx, still the configured COMPANION_LOCAL_NUM_CTX), and the model's
// own smaller window from /api/show sets the budget.
test('auto mode probes the server: an Ollama on any address gets the native API and its real window', async (t) => {
  const native = [];
  const compat = [];
  const stub = await startStub({
    'GET /api/version': (body, req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.12.3' }));
    },
    'POST /api/show': (body, req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model_info: { 'general.architecture': 'gemma3', 'gemma3.context_length': 4000 } }));
    },
    'POST /api/chat': (body, req, res) => {
      native.push(body);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: `Reply ${native.length}.` } }) + '\n');
      res.end(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1100 }) + '\n');
    },
    'POST /v1/chat/completions': (body, req, res) => {
      compat.push(body);
      sse(res, [{ choices: [{ delta: { content: 'wrong route' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    },
  });
  t.after(() => stub.server.close());
  const c = await startCompanion(t, {
    baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1`,
    env: { COMPANION_LOCAL_NUM_CTX: '8192', COMPANION_LOCAL_RESERVE_TOKENS: '1000' },
  });

  let from = c.out().length;
  c.capture({ problemDescription: 'Find two numbers that add up to target.', code: 'def f():\n    return 1\n' });
  assert.match(await turnOutput(c, from, 'the Submit reply'), /Reply 1\./);
  assert.equal(compat.length, 0, 'the OpenAI-compatible route was not used');
  assert.equal(native.length, 1);
  assert.equal(native[0].options.num_ctx, 8192, 'native requests still ask for the configured window');

  // 3,000 tokens of budget (4,000 reported minus the 1,000 reserve), not 7,192.
  from = c.out().length;
  c.type(`please read ${'some long pasted text '.repeat(700)}`);
  const refused = await turnOutput(c, from, 'the refusal');
  assert.match(refused, /over the 3000-token budget \(the model's 4000-token context window, as reported by the server \(Ollama \/api\/show\)/);
  assert.ok(!c.out().includes('companion: warning'), 'no truncation warning for an honest server');
});

test('an explicit COMPANION_LOCAL_API=openai still wins over the probe', async (t) => {
  const compat = [];
  const stub = await startStub({
    'GET /api/version': (body, req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.12.3' }));
    },
    'POST /v1/chat/completions': (body, req, res) => {
      compat.push(body);
      sse(res, [{ choices: [{ delta: { content: `Reply ${compat.length}.` } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    },
  });
  t.after(() => stub.server.close());
  const c = await startCompanion(t, {
    baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1`,
    env: { COMPANION_LOCAL_API: 'openai' },
  });
  const from = c.out().length;
  c.capture({ problemDescription: 'Find two numbers.', code: 'def f():\n    return 1\n' });
  assert.match(await turnOutput(c, from, 'the Submit reply'), /Reply 1\./);
  assert.equal(compat.length, 1);
});

// A server whose real window (2,000 tokens here) is smaller than the
// configured one, that silently keeps only the end of a longer prompt and
// answers as if nothing happened - the way Ollama and others behave. It
// reports what it kept in usage.prompt_tokens (when asked to with
// stream_options), and that is the only sign. Each exchange adds about 470
// estimated tokens; the guard acts once the server keeps under 70 percent
// of what was sent (a smaller cut is within tokenizer differences).
test('a server that silently truncates the prompt is caught: one warning, then requests trimmed to its real window', async (t) => {
  const WINDOW = 2000;
  const requests = [];
  const stub = await startStub({
    'POST /v1/chat/completions': (body, req, res) => {
      requests.push(body);
      const kept = Math.min(estimate(body.messages), WINDOW);
      const events = [
        { choices: [{ delta: { content: `Reply ${requests.length}. ${LONG_REPLY}` } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      if (body.stream_options?.include_usage) {
        events.push({ choices: [], usage: { prompt_tokens: kept, completion_tokens: 450, total_tokens: kept + 450 } });
      }
      sse(res, events);
    },
  });
  t.after(() => stub.server.close());
  const c = await startCompanion(t, {
    baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1`,
    env: { COMPANION_LOCAL_NUM_CTX: '9000', COMPANION_LOCAL_RESERVE_TOKENS: '200' },
  });

  let from = c.out().length;
  c.capture({ problemDescription: 'Find two numbers that add up to target.', code: 'def f():\n    return 1\n' });
  assert.match(await turnOutput(c, from, 'the Submit reply'), /Reply 1\./);
  let cutAt = null;
  for (let i = 2; i <= 9; i += 1) {
    from = c.out().length;
    c.type(`question number ${i}`);
    // eslint-disable-next-line no-await-in-loop
    const printed = await turnOutput(c, from, `message ${i}`);
    assert.match(printed, new RegExp(`Reply ${i}\\.`), printed);
    // The first request the server kept under 70 percent of: the guard's cue.
    if (cutAt === null && WINDOW < 0.7 * estimate(requests[i - 1].messages)) cutAt = i;
  }
  assert.ok(cutAt !== null, 'the conversation did outgrow the server window');
  assert.ok(requests[0].stream_options?.include_usage, 'usage is asked for on a streamed reply');

  const warnings = c.out().match(/companion: warning: the local server processed only ~\d+ of the ~\d+ prompt tokens sent/g) || [];
  assert.equal(warnings.length, 1, `one warning per session, got: ${c.out()}`);
  assert.match(c.out(), /budgeting for a 2000-token window from now on/);
  // Every request after the caught one fits the real window (minus the reserve).
  for (const body of requests.slice(cutAt)) {
    assert.ok(estimate(body.messages) <= WINDOW - 200, `a later request was ~${estimate(body.messages)} tokens`);
  }
});

// A strict server that rejects the unknown stream_options field still works:
// the companion retries once without it and leaves it off.
test('a server that rejects stream_options is retried without it', async (t) => {
  const bodies = [];
  const stub = await startStub({
    'POST /v1/chat/completions': (body, req, res) => {
      bodies.push(body);
      if (body.stream_options) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unrecognized request argument supplied: stream_options' }));
        return;
      }
      sse(res, [{ choices: [{ delta: { content: `Reply ${bodies.length}.` } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    },
  });
  t.after(() => stub.server.close());
  const c = await startCompanion(t, { baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1` });
  let from = c.out().length;
  c.capture({ problemDescription: 'Find two numbers.', code: 'def f():\n    return 1\n' });
  assert.match(await turnOutput(c, from, 'the Submit reply'), /Reply 2\./);
  from = c.out().length;
  c.type('next');
  assert.match(await turnOutput(c, from, 'the next reply'), /Reply 3\./);
  assert.deepEqual(
    bodies.map((b) => Boolean(b.stream_options)),
    [true, false, false]
  );
});

// A reply cut off for room (finish_reason "length") would be cut off again
// on a retry with the same history, so the oldest exchange goes with it.
test('after a reply is cut off for room, the oldest exchange is dropped so the next message has more room', async (t) => {
  const requests = [];
  const stub = await startStub({
    'POST /v1/chat/completions': (body, req, res) => {
      requests.push(body.messages);
      if (requests.length === 3) {
        sse(res, [{ choices: [{ delta: { reasoning: 'thinking...' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }]);
        return;
      }
      sse(res, [{ choices: [{ delta: { content: `Reply ${requests.length}.` } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    },
  });
  t.after(() => stub.server.close());
  const c = await startCompanion(t, { baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1` });
  let from = c.out().length;
  c.capture({ problemDescription: 'Find two numbers.', code: 'def f():\n    return 1\n' });
  assert.match(await turnOutput(c, from, 'reply 1'), /Reply 1\./);
  from = c.out().length;
  c.type('second');
  assert.match(await turnOutput(c, from, 'reply 2'), /Reply 2\./);
  from = c.out().length;
  c.type('third');
  assert.match(await turnOutput(c, from, 'the cutoff'), /cut off before finishing/);
  from = c.out().length;
  c.type('fourth');
  assert.match(await turnOutput(c, from, 'reply 4'), /Reply 4\./);
  const users = requests[3].filter((m) => m.role === 'user').map((m) => m.content);
  assert.equal(users.length, 2, `the first exchange and the cut-off message are gone: ${JSON.stringify(users)}`);
  assert.equal(users[1], 'fourth');
});

// --- condensing instead of dropping (context-summary.js) -------------------

const SUMMARY_CAP_CHARS = summaryBodyChars(SUMMARY_MAX_TOKENS);
const summaryMessageOf = (messages) =>
  messages.find((m) => m.role === 'system' && m.content.startsWith(`${SUMMARY_HEADER}\n`));
const json = (res, content) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
};

// The stuck scenario again (a big statement plus long tutor replies over a
// 4,700-token budget), each reply carrying a fact the summary must keep.
// `summary` answers the summary calls. Returns the tutor requests, the
// summary calls and everything printed after the first Submit was sent.
async function runCondenseScenario(t, { summary, messages = 8 }) {
  const requests = [];
  const stub = await startStub({
    'POST /v1/chat/completions': (body, req, res) => {
      requests.push(body.messages);
      sse(res, [
        { choices: [{ delta: { content: `Reply ${requests.length}. FACT-${requests.length} noted. ${LONG_REPLY}` } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    },
    ...(summary ? { summary } : {}),
  });
  t.after(() => stub.server.close());
  const c = await startCompanion(t, {
    baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1`,
    env: { COMPANION_LOCAL_NUM_CTX: '7300', COMPANION_LOCAL_MAX_HISTORY_TURNS: '0' },
  });
  const start = c.out().length;
  let from = start;
  c.capture({ problemDescription: BIG_DESCRIPTION, code: 'def twoSum(nums, target):\n    return []\n' });
  assert.match(await turnOutput(c, from, 'the Submit reply'), /Reply 1\./);
  for (let i = 2; i <= messages; i += 1) {
    from = c.out().length;
    c.type(`Question number ${i} about my approach? More words.`);
    // eslint-disable-next-line no-await-in-loop
    const printed = await turnOutput(c, from, `message ${i}`);
    assert.ok(!printed.includes('error talking to backend'), `message ${i} was refused: ${printed}`);
    assert.match(printed, new RegExp(`Reply ${i}\\.`));
  }
  return { c, requests, summaries: stub.summaries, printed: c.out().slice(start) };
}

// Checks every tutor request: the summary (when present) sits right after
// the pinned statement and code and before the live history, under its cap.
function assertSummaryPlacement(requests) {
  for (const messages of requests) {
    const summary = summaryMessageOf(messages);
    if (!summary) continue;
    const index = messages.indexOf(summary);
    assert.ok(messages[index - 1].role === 'system', 'pins come before the summary');
    assert.ok(messages.slice(index + 1).every((m) => m.role !== 'system'), 'only live history follows it');
    assert.ok(summary.content.length - SUMMARY_HEADER.length - 1 <= SUMMARY_CAP_CHARS, `summary over its cap: ${summary.content.length}`);
  }
}

test('the stuck scenario succeeds with a summary that keeps the oldest facts, and nothing is printed about it', async (t) => {
  // A model summary that names every FACT it was shown (from the dropped
  // replies and from the earlier summary), padded far past the cap.
  const { requests, summaries, printed } = await runCondenseScenario(t, {
    summary: (body, req, res) => {
      const facts = [...new Set(body.messages[1].content.match(/FACT-\d+/g) || [])];
      json(res, `Facts so far: ${facts.join(', ')}. ${'filler '.repeat(800)}`);
    },
  });
  assert.ok(summaries.length >= 1, 'a summary call was made');
  for (const call of summaries) {
    assert.equal(call.stream, false, 'the summary call is never streamed');
    assert.match(call.messages[1].content, /under 250 words/);
    assert.ok(!call.messages[1].content.includes(BIG_DESCRIPTION.slice(0, 200)), 'the pinned statement is never summarized');
    assert.ok(estimate(call.messages) <= 4700, 'the summary call fits the budget');
  }
  const last = requests[requests.length - 1];
  const summary = summaryMessageOf(last);
  assert.ok(summary, 'the last request carries the summary');
  assert.match(summary.content, /FACT-1\b/, 'the oldest fact survives repeated condensing');
  assert.ok(last.some((m) => m.role === 'system' && m.content.includes(BIG_DESCRIPTION)), 'the statement stays pinned');
  assert.equal(last[last.length - 1].content, 'Question number 8 about my approach? More words.');
  assertSummaryPlacement(requests);
  assert.ok(!/summar|condens|earlier in this session|companion: (warning|error)/i.test(printed), `something was printed about it: ${printed}`);
});

test('a summary call that fails falls back to the one-line-per-exchange digest', async (t) => {
  const { requests, summaries } = await runCondenseScenario(t, {
    summary: (body, req, res) => res.writeHead(500).end('model crashed'),
  });
  assert.ok(summaries.length >= 1);
  const summary = summaryMessageOf(requests[requests.length - 1]);
  assert.ok(summary, 'a digest stands in for the condensed exchanges');
  assert.match(summary.content, /^- Student: .* Tutor: Reply \d+\.$/m);
  assert.match(summary.content, /- Student: Question number \d+ about my approach\? Tutor: Reply \d+\./);
  assert.ok(!summary.content.includes('More words'), 'one sentence per side');
  assertSummaryPlacement(requests);
});

test('a summary call that returns nothing falls back to the digest too', async (t) => {
  const { requests, summaries } = await runCondenseScenario(t, { summary: (body, req, res) => json(res, '   ') });
  assert.ok(summaries.length >= 1);
  const summary = summaryMessageOf(requests[requests.length - 1]);
  assert.ok(summary);
  assert.match(summary.content, /- Student: .* Tutor: Reply \d+\./);
});

test('a problem switch clears the summary', async (t) => {
  const { c, requests } = await runCondenseScenario(t, { summary: (body, req, res) => json(res, 'SUMMARY-OF-TWO-SUM') });
  assert.ok(summaryMessageOf(requests[requests.length - 1]), 'condensed before the switch');
  const before = requests.length;
  const from = c.out().length;
  c.capture({ problemSlug: 'valid-parentheses', problemTitle: 'Valid Parentheses', url: 'https://leetcode.com/problems/valid-parentheses/', problemDescription: 'Brackets.', code: 'def isValid(s):\n    return True\n' });
  await turnOutput(c, from, 'the reply on the new problem');
  assert.equal(requests.length, before + 1);
  const after = requests[requests.length - 1];
  assert.ok(!summaryMessageOf(after), 'no summary after the reset');
  assert.ok(!JSON.stringify(after).includes('SUMMARY-OF-TWO-SUM'));
});
