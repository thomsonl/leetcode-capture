// Regression test for a real capture's reply going silently missing.
//
// Some locally-hosted "thinking" models (e.g. Ollama's gemma-family thinking
// variants) put their whole answer in a `reasoning` field on the chat
// message and leave `content` empty - more likely on the longer response a
// Submit's full breakdown asks for than on a Run's short acknowledgement.
// Before the fix, LocalBackend.sendMessage read only `message.content`, so
// this came back as `''`; sendAndPrint then printed just the capture's
// label with nothing after it - indistinguishable, from the terminal, from
// "the reply never arrived" (see companion.js's LocalBackend.sendMessage
// and sendAndPrint for the actual fix).
//
// This spawns a real companion.js subprocess (COMPANION_BACKEND=local)
// against a stub OpenAI-compatible server, and appends a real capture line
// directly to the file companion.js tails - the same mechanism the relay
// server itself uses, without needing a second subprocess for it.
//
// Run with: node --test companion.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Starts a stub OpenAI-compatible chat-completions server. `replyFor` maps
// each request to a response shape (a `{ content, reasoning, finishReason }`-ish
// chat message; finishReason defaults to 'stop' if omitted); defaults to a
// normal, non-empty content reply if not overridden for a given call.
// companion.js's LocalBackend always sends `stream: true` for a streamable
// turn (see sendAndPrint), so this responds as a real SSE stream in that
// case - split into a couple of chunks, not one, so it also exercises the
// incremental onChunk path rather than just a single-event stream. A
// request with `stream` false/absent (there currently isn't one in this
// file, but the shape is cheap to keep) still gets the old plain JSON
// response.
function startStubBackend(replyFor) {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      callCount += 1;
      const parsedBody = JSON.parse(body);
      const message = replyFor(callCount, parsedBody);
      const finishReason = message.finishReason || 'stop';
      if (!parsedBody.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const content = message.content || '';
      if (content) {
        // Two chunks (split at the midpoint) rather than one, so a test can
        // tell this apart from an accidental one-shot response.
        const mid = Math.ceil(content.length / 2);
        for (const piece of [content.slice(0, mid), content.slice(mid)]) {
          if (piece) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
      }
      if (message.reasoning) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: message.reasoning } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeCapture({ trigger, attemptSeq }) {
  return {
    receivedAt: new Date().toISOString(),
    problemSlug: 'two-sum',
    problemTitle: 'Two Sum',
    problemDescription: 'Given an array of integers nums and an integer target...',
    problemTags: ['Array', 'Hash Table'],
    language: 'python3',
    trigger,
    timestamp: new Date().toISOString(),
    url: 'https://leetcode.com/problems/two-sum/',
    code: 'def twoSum(nums, target):\n    pass',
    attemptSeq,
  };
}

async function runCompanion({ stubReplyFor, capture }) {
  const stub = await startStubBackend(stubReplyFor);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, ''); // companion tails from current EOF on a fresh state file

  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: '18136', // arbitrary unused port so the relay-server health check fails fast
    },
    // stdin must stay open (not 'ignore') - readline treats an immediate
    // EOF on stdin as Ctrl+D and exits right away, before ever seeing a
    // capture. Leaving the pipe open and never writing/ending it keeps the
    // chat loop alive for the duration of the test, same as a real terminal.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  // companion.js probes for an existing relay server and, finding none,
  // tries to spawn one - let it fail/continue rather than actually
  // standing one up, since this test only needs the capture-tailing and
  // backend-call path.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  fs.appendFileSync(capturesPath, JSON.stringify(capture) + '\n');

  // Poll the child's output for the capture's label, then give the backend
  // call a moment to resolve and print.
  const deadline = Date.now() + 8000;
  const label = `attempt ${capture.attemptSeq}`;
  while (Date.now() < deadline && !out.includes(label)) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  child.kill();
  stub.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  return out;
}

test('a capture reply that comes back with only `reasoning` (empty `content`) is never silently dropped', async () => {
  const out = await runCompanion({
    stubReplyFor: () => ({
      role: 'assistant',
      content: '',
      reasoning: 'This is a long internal reasoning trace with no final content field populated.',
    }),
    capture: makeCapture({ trigger: 'submit', attemptSeq: 1 }),
  });

  assert.match(out, /got your Submit for Two Sum - taking a look/);
  assert.match(out, /attempt 1/);
  // The label must never be the last visible thing printed for this
  // capture - there must be a real reply body (the reasoning fallback) or,
  // failing that, an explicit warning - anything but silence.
  const afterLabel = out.slice(out.indexOf('attempt 1'));
  assert.match(afterLabel, /long internal reasoning trace|empty reply/);
});

// Regression test for the model's own raw thinking process getting printed
// as if it were the tutor's actual reply. This is a *different* bug from
// the one above: there, `content` is empty because a model puts its whole
// finished answer in `reasoning` instead (finish_reason "stop") - a
// legitimate quirk the fallback above is meant to catch. Here, `content` is
// empty because generation was cut off *before* the model finished thinking
// (finish_reason "length", confirmed live against the real Ollama
// gemma4:26b model this companion is configured for - a big-enough Submit
// capture eats most of Ollama's small default context window and gets cut
// off mid-`reasoning`) - `reasoning` in that case is a raw, incomplete
// scratchpad, not an answer, and must never reach the terminal as if it
// were one (see companion.js's resolveReplyText for the actual fix).
test('a reply cut off mid-thought (finish_reason "length", empty content) is discarded, not shown as the reply', async () => {
  const rawThinking =
    'Task: Provide a full breakdown. Input Code Analysis: the user provided a hash-map lookup approach. Let me trace';
  const out = await runCompanion({
    stubReplyFor: () => ({
      role: 'assistant',
      content: '',
      reasoning: rawThinking,
      finishReason: 'length',
    }),
    capture: makeCapture({ trigger: 'submit', attemptSeq: 1 }),
  });

  assert.match(out, /got your Submit for Two Sum - taking a look/);
  assert.match(out, /attempt 1/);
  // The raw internal reasoning must never reach the terminal as the reply -
  // only the existing "companion: error talking to backend" path may say
  // anything about it.
  assert.ok(!out.includes(rawThinking), `raw thinking leaked into output: ${JSON.stringify(out)}`);
  assert.match(out, /error talking to backend/);
  assert.match(out, /cut off before finishing/);
});

test('a normal reply with populated `content` still prints as before', async () => {
  const out = await runCompanion({
    stubReplyFor: () => ({ role: 'assistant', content: 'Got your run - standing by.' }),
    capture: makeCapture({ trigger: 'run', attemptSeq: 1 }),
  });

  assert.match(out, /got your Run for Two Sum - taking a look/);
  assert.match(out, /Got your run - standing by\./);
});

// companion.js is spawned with piped (non-TTY) stdio in every test in this
// file, same as a real piped/redirected invocation - so this also doubles
// as the "piping companion's output stays plain" regression: a markdown
// reply must come through with its raw syntax untouched and, critically, no
// ANSI escape codes at all (see terminal-format.js's stylingEnabled - it
// gates on process.stdout.isTTY explicitly rather than trusting ambient
// color-support detection, precisely so a piped child like this one never
// emits escape codes even if the environment sets FORCE_COLOR).
test('a markdown reply stays as raw, unrendered text with no ANSI codes over a pipe', async () => {
  const markdownReply =
    '**Nice work!** Here is a fenced block:\n\n```python\ndef f(x):\n    return x\n```\n\n- one\n- two';
  const out = await runCompanion({
    stubReplyFor: () => ({ role: 'assistant', content: markdownReply }),
    capture: makeCapture({ trigger: 'submit', attemptSeq: 1 }),
  });

  assert.match(out, /\*\*Nice work!\*\*/); // bold markers left literal, not rendered
  assert.match(out, /```python/); // fence markers left literal, not stripped
  assert.match(out, /- one\n- two/); // list markers left as-is, no re-indentation
  assert.ok(!out.includes('\x1b['), `expected no ANSI escape codes in piped output, got: ${JSON.stringify(out)}`);
});

// The three tests above all use startStubBackend, which writes both of its
// SSE chunks back to back with no delay - they prove the *content* streamed
// through onChunk reassembles correctly, but backend.sendMessage's own
// internal accumulation (see LocalBackend.streamReply's `content +=`) would
// produce the exact same final text even if the onChunk callback itself
// were silently never wired up to the terminal at all (sendAndPrint's
// !anyChunk fallback would still catch it and print it as one block). This
// test is the one that actually distinguishes "streamed live" from "flushed
// once, late": the stub deliberately delays between its two chunks, so a
// real regression to one-shot-at-the-end display would show up as both
// chunks appearing at the same moment instead of ~1.5s apart.
test('a streamed reply reaches the terminal incrementally, not only once the whole backend call resolves', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      JSON.parse(body); // drain/validate the request like the other stubs do
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FIRSTCHUNK-' } }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'SECONDCHUNK' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 1500);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: '18137',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.appendFileSync(capturesPath, JSON.stringify(makeCapture({ trigger: 'run', attemptSeq: 1 })) + '\n');

    const firstDeadline = Date.now() + 8000;
    while (Date.now() < firstDeadline && !out.includes('FIRSTCHUNK-')) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(out.includes('FIRSTCHUNK-'), 'first chunk never arrived');
    assert.ok(
      !out.includes('SECONDCHUNK'),
      'the second chunk must not already be present the moment the first one is seen'
    );
    const firstSeenAt = Date.now();

    const secondDeadline = Date.now() + 8000;
    while (Date.now() < secondDeadline && !out.includes('SECONDCHUNK')) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(out.includes('SECONDCHUNK'), 'second chunk never arrived');
    const gapMs = Date.now() - firstSeenAt;
    assert.ok(gapMs > 800, `expected a real delay between chunks (proving incremental delivery), got ${gapMs}ms`);
  } finally {
    child.kill();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// Vault auto-summary's Submit turns are the one case that must NOT stream
// (see sendAndPrint): the model is asked to tack a machine-readable
// <<<VAULT_JSON>>>...<<<END_VAULT_JSON>>> block onto the tail of the same
// reply, and extractVaultBlock can only strip that block once the reply is
// complete - streaming it live would risk the raw block (or a fragment of
// it) reaching the terminal before it's known to be strippable. This test
// deliberately delays the JSON block's chunk well after the visible reply
// text, the same way the incremental-streaming test above proves real
// streaming - here proving the opposite: nothing about this turn appears
// until the whole thing, JSON block included, has arrived and been
// stripped.
test('a vault-auto-summary Submit turn never streams and the JSON block never reaches the terminal', async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-vault-test-'));
  fs.mkdirSync(path.join(vaultPath, 'Study', 'Algorithms'), { recursive: true });

  const visibleReply = 'Nice work, this looks correct and runs in O(n) time.';
  const vaultJson =
    '{"problemRating":5,"topicProficiency":null,"summary":"solved cleanly","struggle":"none"}';

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsedBody = JSON.parse(body);
      // sendAndPrint's non-streaming branch (see backend.sendMessage's
      // onChunk contract) never passes onChunk for this turn, so
      // LocalBackend requests `stream: false` here - a real regression back
      // to streaming this turn would show up as this assertion failing
      // outright (the response never being read as plain JSON at all).
      assert.equal(parsedBody.stream, false, 'a vault auto-summary turn must request a non-streaming reply');
      const jsonBlock = `\n\n<<<VAULT_JSON>>>${vaultJson}<<<END_VAULT_JSON>>>`;
      // Delayed like the incremental-streaming test's chunks are, so the
      // same "did the visible text appear before the full response was
      // even ready" check below is meaningful here too.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: visibleReply + jsonBlock }, finish_reason: 'stop' }] }));
      }, 1500);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: '18138',
      VAULT_AUTO_SUMMARY: '1',
      VAULT_PATH: vaultPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const capture = makeCapture({ trigger: 'submit', attemptSeq: 1 });
    fs.appendFileSync(capturesPath, JSON.stringify(capture) + '\n');

    // Poll until *something* about the reply shows up, then immediately
    // check the JSON block hasn't leaked - if streaming ever regressed here,
    // the visible text would show up ~immediately (well under the 1500ms
    // delay) with the JSON block absent at that moment but arriving soon
    // after; catching the leak requires checking again post-delay too.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !out.includes('Nice work')) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(out.includes('Nice work'), 'the visible reply never arrived');
    // It only arrived because the whole backend call (including the delayed
    // JSON chunk) already resolved - confirm at least ~1.5s really passed,
    // i.e. this wasn't a fast, streamed partial print.
    const elapsedMs = Date.now() - (deadline - 4000);
    assert.ok(elapsedMs > 1300, `expected the reply to wait for the full (delayed) response, got ${elapsedMs}ms`);

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(!out.includes('VAULT_JSON'), `the vault JSON marker must never reach the terminal, got: ${JSON.stringify(out)}`);
    assert.ok(!out.includes(vaultJson), `the vault JSON body must never reach the terminal, got: ${JSON.stringify(out)}`);
  } finally {
    child.kill();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

// --- automatic context reset on problem switch (COMPANION_AUTO_CLEAR_CONTEXT) ----
//
// LocalBackend resends its full `history` array on every call (see
// companion.js), so a stub server that records `messages` for each request
// it receives is a direct window into whether resetContext() actually ran:
// an unbroken conversation keeps growing (system + every past turn), while a
// reset call truncates it straight back down to just the leading system
// message plus the new turn. Always responds over SSE, since a capture
// always streams (see sendAndPrint) - LocalBackend requests `stream: true`
// for every capture turn regardless of backend config.

function startTrackingStubBackend() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsedBody = JSON.parse(body);
      requests.push(parsedBody.messages);
      const content = `Reply number ${requests.length}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

function makeIdCapture({ slug, title, attemptSeq, trigger = 'run' }) {
  return {
    receivedAt: new Date().toISOString(),
    problemSlug: slug,
    problemTitle: title,
    problemDescription: 'a problem description',
    problemTags: [],
    language: 'python3',
    trigger,
    timestamp: new Date().toISOString(),
    url: 'https://leetcode.com/problems/x/',
    code: 'pass',
    attemptSeq,
  };
}

// Spawns companion.js against a tracking stub backend, feeds it two captures
// one at a time (waiting for each one's reply before sending the next, so
// the two backend calls can never race each other through the queue), and
// returns both the raw terminal output and the `messages` array the stub saw
// on each of its two calls.
async function runContextResetScenario({ firstCapture, secondCapture, capturePort, env = {} }) {
  const { server, requests } = await startTrackingStubBackend();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-ctx-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  const child = spawn(process.execPath, [path.join(__dirname, 'companion.js')], {
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: String(capturePort),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.appendFileSync(capturesPath, JSON.stringify(firstCapture) + '\n');

    let deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes('Reply number 1')) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(out.includes('Reply number 1'), 'first reply never arrived');
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the queue fully settle

    fs.appendFileSync(capturesPath, JSON.stringify(secondCapture) + '\n');
    deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes('Reply number 2')) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(out.includes('Reply number 2'), 'second reply never arrived');
    await new Promise((resolve) => setTimeout(resolve, 300));

    return { out, requests };
  } finally {
    child.kill();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('consecutive captures for the same problem do not clear context', async () => {
  const { out, requests } = await runContextResetScenario({
    firstCapture: makeIdCapture({ slug: 'two-sum', title: 'Two Sum', attemptSeq: 1 }),
    secondCapture: makeIdCapture({ slug: 'two-sum', title: 'Two Sum', attemptSeq: 2, trigger: 'submit' }),
    capturePort: 18139,
  });

  assert.equal(requests[0].length, 2, 'first call: system + this turn\'s user message');
  // Full continuity: system, first user turn, first assistant reply, second
  // user turn - nothing truncated.
  assert.equal(requests[1].length, 4, 'second call should still carry the first turn as history');
  assert.ok(!out.includes('new problem detected'), 'no reset notice should print for the same problem');
});

test('a capture for a different problemSlug clears context (auto-clear on by default)', async () => {
  const { out, requests } = await runContextResetScenario({
    firstCapture: makeIdCapture({ slug: 'two-sum', title: 'Two Sum', attemptSeq: 1 }),
    secondCapture: makeIdCapture({ slug: 'house-robber', title: 'House Robber', attemptSeq: 2 }),
    capturePort: 18140,
  });

  assert.equal(requests[0].length, 2);
  // Reset: truncated back to just the leading system message plus this
  // turn's own user message - the first problem's turn is gone.
  assert.equal(requests[1].length, 2, 'context should have been cleared before the second call');
  assert.match(out, /new problem detected \(house-robber\) - clearing tutor context/);
});

test('COMPANION_AUTO_CLEAR_CONTEXT=0 disables the reset even across a problem switch', async () => {
  const { out, requests } = await runContextResetScenario({
    firstCapture: makeIdCapture({ slug: 'two-sum', title: 'Two Sum', attemptSeq: 1 }),
    secondCapture: makeIdCapture({ slug: 'house-robber', title: 'House Robber', attemptSeq: 2 }),
    capturePort: 18141,
    env: { COMPANION_AUTO_CLEAR_CONTEXT: '0' },
  });

  assert.equal(requests[0].length, 2);
  assert.equal(requests[1].length, 4, 'context must not be cleared when the toggle is off');
  assert.ok(!out.includes('new problem detected'), 'no reset notice should print when the toggle is off');
});

test('a problem switch is still detected via the problemTitle fallback when problemSlug is absent', async () => {
  const { out, requests } = await runContextResetScenario({
    firstCapture: makeIdCapture({ slug: undefined, title: 'Two Sum', attemptSeq: 1 }),
    secondCapture: makeIdCapture({ slug: undefined, title: 'House Robber', attemptSeq: 2 }),
    capturePort: 18142,
  });

  assert.equal(requests[0].length, 2);
  assert.equal(requests[1].length, 2, 'title-fallback identifier switch should still clear context');
  assert.match(out, /new problem detected \(House Robber\) - clearing tutor context/);
});
