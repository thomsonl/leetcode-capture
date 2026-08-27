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
import { replayToScreen } from './virtual-terminal.js';

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

// Regression test for a related but distinct gap in the same fix: the check
// above only covered `content` being *empty* at cutoff time. A model can
// also get cut off (finish_reason "length") after it had already started
// writing real, non-empty `content` - resolveReplyText's old early return
// (`if (trimmedContent) return trimmedContent;`) ran before any check of
// finishReason, so this partial content was returned as if it were a
// complete, successful reply instead of raising the same error the
// empty-content case above already raises (see companion.js's
// resolveReplyText).
//
// Unlike the reasoning-only case above, this test can't assert the partial
// text never reaches the terminal at all: `streamReply` calls `onChunk` with
// each `delta.content` piece live, as it arrives over SSE, before
// finishReason is even known - genuine, correct streaming behavior (a reply
// is meant to appear as it's generated) that's out of scope for this fix
// (see companion.js's streamReply/writeReplyPiece). What distinguishes the
// fix from the bug is what happens once the stream ends: pre-fix,
// resolveReplyText returned the partial content as a normal successful
// reply - no error line, and LocalBackend.history would carry it as a
// completed exchange. Post-fix, the turn ends in the same
// "companion: error talking to backend ... cut off before finishing" path
// the empty-content case uses, rather than a silent, clean finish.
test('a reply cut off mid-generation (finish_reason "length", non-empty content) raises the cutoff error instead of completing silently', async () => {
  const partialContent = 'Nice work on the hash-map approach. Your time complexity is O(n) and the';
  const out = await runCompanion({
    stubReplyFor: () => ({
      role: 'assistant',
      content: partialContent,
      finishReason: 'length',
    }),
    capture: makeCapture({ trigger: 'submit', attemptSeq: 1 }),
  });

  assert.match(out, /got your Submit for Two Sum - taking a look/);
  assert.match(out, /attempt 1/);
  // The turn must end in the error path, not a silent, clean completion -
  // this is the actual bug/fix boundary (see comment above).
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

function makeIdCapture({ slug, title, attemptSeq, trigger = 'run', code = 'pass' }) {
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
    code,
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

  // system + the pinned problem description (see "send the problem
  // description once per problem", companion.js's captureProblemContext) +
  // this turn's own user message.
  assert.equal(requests[0].length, 3, 'first call: system + pinned description + this turn\'s user message');
  // Full continuity: system, pinned description (still pinned - same
  // problem, not resent as a second copy), first user turn (sent in full -
  // nothing earlier to diff it against yet), first assistant reply, second
  // user turn - nothing truncated.
  assert.equal(requests[1].length, 5, 'second call should still carry the first turn as history');
  assert.ok(!out.includes('new problem detected'), 'no reset notice should print for the same problem');
});

test('a capture for a different problemSlug clears context (auto-clear on by default)', async () => {
  const { out, requests } = await runContextResetScenario({
    firstCapture: makeIdCapture({ slug: 'two-sum', title: 'Two Sum', attemptSeq: 1 }),
    secondCapture: makeIdCapture({ slug: 'house-robber', title: 'House Robber', attemptSeq: 2 }),
    capturePort: 18140,
  });

  assert.equal(requests[0].length, 3, 'system + pinned description + this turn\'s user message');
  // Reset: truncated back to just the leading system message, the new
  // problem's own pinned description, and this turn's own user message -
  // the first problem's turn (and its now-stale pinned description) is
  // gone.
  assert.equal(requests[1].length, 3, 'context should have been cleared before the second call');
  assert.match(out, /new problem detected \(house-robber\) - clearing tutor context/);
});

test('COMPANION_AUTO_CLEAR_CONTEXT=0 disables the reset even across a problem switch', async () => {
  const { out, requests } = await runContextResetScenario({
    firstCapture: makeIdCapture({ slug: 'two-sum', title: 'Two Sum', attemptSeq: 1 }),
    secondCapture: makeIdCapture({ slug: 'house-robber', title: 'House Robber', attemptSeq: 2 }),
    capturePort: 18141,
    env: { COMPANION_AUTO_CLEAR_CONTEXT: '0' },
  });

  assert.equal(requests[0].length, 3, 'system + pinned description + this turn\'s user message');
  // Conversation history (the first problem's own user/assistant turn) is
  // NOT cleared - but the *pinned description* still switches to whichever
  // problem is now actually current, independent of AUTO_CLEAR_CONTEXT:
  // LocalBackend.sendMessage's pinning decision only compares problemId,
  // it doesn't consult this toggle, since resending a stale problem's
  // description makes no sense to skip just because context-clearing
  // itself is turned off (see companion.js's LocalBackend class comment).
  assert.equal(requests[1].length, 5, 'context must not be cleared when the toggle is off');
  assert.ok(!out.includes('new problem detected'), 'no reset notice should print when the toggle is off');
});

test('a problem switch is still detected via the problemTitle fallback when problemSlug is absent', async () => {
  const { out, requests } = await runContextResetScenario({
    firstCapture: makeIdCapture({ slug: undefined, title: 'Two Sum', attemptSeq: 1 }),
    secondCapture: makeIdCapture({ slug: undefined, title: 'House Robber', attemptSeq: 2 }),
    capturePort: 18142,
  });

  assert.equal(requests[0].length, 3, 'system + pinned description + this turn\'s user message');
  assert.equal(requests[1].length, 3, 'title-fallback identifier switch should still clear context');
  assert.match(out, /new problem detected \(House Robber\) - clearing tutor context/);
});

// --- LocalBackend history trimming (COMPANION_LOCAL_MAX_HISTORY_TURNS) -----
//
// LocalBackend resends its full history array on every call (see
// companion.js's LocalBackend class comment); across a long single-problem
// conversation (several Run/Submit captures in a row, the scenario
// COMPANION_AUTO_CLEAR_CONTEXT's own reset-on-problem-switch doesn't help
// with) that grows without bound until it exhausts even a real backend's
// context window - confirmed live against the real Ollama gemma4:26b model
// this companion is configured for (see resolveReplyText's own comment).
// This stub reproduces that failure mode directly and deterministically,
// without needing a real model: once a request's total message content
// crosses `thresholdChars`, it responds the same way a real context-
// exhausted Ollama does - empty `content`, a `reasoning` scratchpad,
// finish_reason "length" - instead of a normal reply, so a request that
// grows past the threshold surfaces the same "error talking to backend...
// cut off before finishing" companion.js already prints for that case (see
// the "reply cut off mid-thought" test above). Always responds over SSE,
// like startTrackingStubBackend above - a capture always streams.
function startExhaustionStubBackend({ thresholdChars }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsedBody = JSON.parse(body);
      requests.push(parsedBody.messages);
      const totalChars = parsedBody.messages.reduce((sum, m) => sum + (m.content || '').length, 0);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (totalChars > thresholdChars) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning: 'partial internal reasoning trace, cut off mid-thought' } }],
          })}\n\n`
        );
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
      } else {
        const content = `Reply number ${requests.length}`;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

// A sizeable, but not huge, code field - big enough that a handful of resent
// turns cross a modest thresholdChars, small enough the test stays fast.
const EXHAUSTION_TEST_CODE = 'def solve(nums):\n    # placeholder line for size\n    pass\n'.repeat(15);

// Spawns companion.js against startExhaustionStubBackend and feeds it
// `turnCount` captures, one at a time, all for the *same* problem (so
// COMPANION_AUTO_CLEAR_CONTEXT's own reset never fires and can't be the
// reason growth stops) - waiting after each one for either a numbered reply
// or the exhaustion error to appear before sending the next, so the queue
// never races two captures against each other.
async function runManyTurnsScenario({ turnCount, capturePort, thresholdChars, env = {} }) {
  const { server, requests } = await startExhaustionStubBackend({ thresholdChars });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-exhaustion-test-'));
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

    for (let i = 1; i <= turnCount; i += 1) {
      const markerLen = out.length;
      fs.appendFileSync(
        capturesPath,
        JSON.stringify(
          makeIdCapture({ slug: 'two-sum', title: 'Two Sum', attemptSeq: i, code: EXHAUSTION_TEST_CODE })
        ) + '\n'
      );
      const deadline = Date.now() + 8000;
      // eslint-disable-next-line no-await-in-loop
      while (
        Date.now() < deadline &&
        !/Reply number|error talking to backend/.test(out.slice(markerLen))
      ) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(
        out.slice(markerLen),
        /Reply number|error talking to backend/,
        `turn ${i} produced neither a reply nor an error`
      );
      // If this turn already errored, stop early - matches how a real
      // conversation would actually be interrupted, and avoids feeding more
      // captures into a queue that's already surfaced the failure.
      if (/error talking to backend/.test(out.slice(markerLen))) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200)); // let the queue fully settle
    }

    return { out, requests };
  } finally {
    child.kill();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// The repro: with trimming disabled (the old, unbounded behavior),
// resending the full history every turn eventually crosses the stub's
// simulated context ceiling on a long enough single-problem conversation -
// this is PR #31's bug in its non-leaking form (the truncation is now caught
// and surfaced as an error rather than printed as the reply), but the
// exhaustion itself is still happening, which is exactly what this task
// fixes.
test('without history trimming, a long single-problem conversation eventually exhausts context (repro)', async () => {
  const { out } = await runManyTurnsScenario({
    turnCount: 6,
    capturePort: 18150,
    thresholdChars: 6000,
    env: { COMPANION_LOCAL_MAX_HISTORY_TURNS: '0' },
  });

  assert.match(
    out,
    /error talking to backend.*cut off before finishing/s,
    `expected the growing unbounded history to eventually exhaust the stub's simulated context window, got: ${JSON.stringify(out)}`
  );
});

// The fix: with trimming enabled, the same growing conversation over the
// same number of turns never crosses the threshold, because the resent
// history is capped rather than growing without bound - confirming this
// isn't just "the same bug, later."
test('COMPANION_LOCAL_MAX_HISTORY_TURNS keeps a long single-problem conversation from ever exhausting context', async () => {
  const { out, requests } = await runManyTurnsScenario({
    turnCount: 6,
    capturePort: 18151,
    thresholdChars: 6000,
    env: { COMPANION_LOCAL_MAX_HISTORY_TURNS: '1' },
  });

  assert.ok(
    !out.includes('error talking to backend'),
    `expected no exhaustion errors with trimming enabled, got: ${JSON.stringify(out)}`
  );
  assert.equal(requests.length, 6, 'all six turns should have gone through without an early failure');
  for (const req of requests) {
    // system + at most 1 turn-pair still in flight (the trimmed-to pair plus
    // this request's own new user message can transiently be 2 pairs' worth
    // - see trimHistory's own comment: trimming runs after a reply lands,
    // not before the next request goes out).
    assert.ok(
      req.length <= 1 + 2 * 2,
      `request history should stay bounded (system + at most ~2 pairs), got ${req.length} messages`
    );
  }
});

// Every request's own message array must stay in well-formed
// [system, user, assistant, user, assistant, ...] shape - trimming a whole
// pair at a time (see trimHistory) must never leave a dangling half-turn.
test('trimmed history never leaves a dangling half-turn', async () => {
  const { requests } = await runManyTurnsScenario({
    turnCount: 6,
    capturePort: 18152,
    thresholdChars: 6000,
    env: { COMPANION_LOCAL_MAX_HISTORY_TURNS: '1' },
  });

  for (const req of requests) {
    assert.equal(req[0].role, 'system');
    // req[1] is the pinned problem description (a second, reconstructed-
    // fresh system-role message - see context-budget.js's buildMessages)
    // whenever one is known; the actual user/assistant pairs start right
    // after it. makeIdCapture always supplies a problemDescription, so it's
    // present here from the very first request onward - detected rather
    // than assumed, so this test still holds if that ever changes.
    const start = req[1]?.role === 'system' ? 2 : 1;
    for (let i = start; i < req.length; i += 2) {
      assert.equal(req[i].role, 'user', `message ${i} should be a user turn`);
      if (i + 1 < req.length) assert.equal(req[i + 1].role, 'assistant', `message ${i + 1} should be its reply`);
    }
  }
});

// --- single-capture context overflow (COMPANION_LOCAL_API / _NUM_CTX) ------
//
// A genuinely different bug from the history-growth one above: one capture's
// own content (problem description + submitted code, formatted alongside
// TUTOR_SYSTEM_PROMPT) can by itself exceed a small local model's context
// window, on the very first turn of a brand-new conversation - before any
// history has accumulated at all, so trimHistory (which only bounds growth
// across turns) cannot help. Confirmed live against the real Ollama
// gemma4:26b model this companion is configured for (see companion.js's
// LocalBackend class comment): a single normal-sized Submit capture (a real
// problem description plus a ~150-line solution, no prior history) already
// exhausted its default 4096-token window over the OpenAI-compat endpoint,
// then completed normally once resent to Ollama's native /api/chat with a
// larger `num_ctx`.
//
// This stub reproduces both API shapes on one server so a test can drive
// LocalBackend down either path: POST /v1/chat/completions behaves like the
// existing exhaustion stub above (OpenAI-compat SSE, small simulated
// context), while POST /api/chat behaves like real Ollama's native chat API
// (newline-delimited JSON, `message.content`/`message.thinking`,
// `done`/`done_reason`) with its own, independently-sized simulated context -
// letting a test prove the native path genuinely has more headroom, not just
// that it happens not to fail.
function startDualApiStubBackend({ compatThresholdChars, nativeThresholdChars }) {
  const requestsByRoute = { compat: [], native: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsedBody = JSON.parse(body);
      const totalChars = parsedBody.messages.reduce((sum, m) => sum + (m.content || '').length, 0);

      if (req.url === '/api/chat') {
        requestsByRoute.native.push(parsedBody.messages);
        const exceeded = totalChars > nativeThresholdChars;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        if (exceeded) {
          res.write(JSON.stringify({ message: { content: '', thinking: 'partial native reasoning, cut off' } }) + '\n');
          res.write(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'length' }) + '\n');
        } else {
          const content = `Reply number ${requestsByRoute.native.length}`;
          res.write(JSON.stringify({ message: { content } }) + '\n');
          res.write(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }) + '\n');
        }
        res.end();
        return;
      }

      // Default: the OpenAI-compat route (/v1/chat/completions).
      requestsByRoute.compat.push(parsedBody.messages);
      const exceeded = totalChars > compatThresholdChars;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (exceeded) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning: 'partial compat reasoning, cut off mid-thought' } }],
          })}\n\n`
        );
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
      } else {
        const content = `Reply number ${requestsByRoute.compat.length}`;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requestsByRoute }));
  });
}

// A single, realistic-sized capture - a real problem description plus a
// plausible ~150-line solution (not a synthetic worst case) - matching the
// order of magnitude confirmed live against the real Ollama model to exceed
// its default context window by itself, on the first turn, with zero prior
// history.
const SINGLE_CAPTURE_DESCRIPTION =
  'You are given an undirected graph with n nodes labeled from 0 to n - 1, and an array edges where ' +
  'edges[i] = [ui, vi] indicates a bidirectional edge between ui and vi. You are also given an array ' +
  'queries where queries[i] = [srci, dsti]. For each query, determine the length of the shortest path ' +
  'between srci and dsti, or -1 if none exists. Return an array answer where answer[i] is the answer ' +
  'to the ith query.\n\nExample 1:\nInput: n = 5, edges = [[0,1],[1,2],[2,3],[3,4]], queries = ' +
  '[[0,4],[0,2],[1,3]]\nOutput: [4,2,2]\n\nConstraints:\n- 2 <= n <= 10^5\n- 1 <= queries.length <= 10^5';
const SINGLE_CAPTURE_CODE =
  'class Solution {\npublic:\n    unordered_map<int, vector<int>> adj;\n\n    void buildGraph(vector<vector<int>>& edges) {\n' +
  '        for (auto& e : edges) { adj[e[0]].push_back(e[1]); adj[e[1]].push_back(e[0]); }\n    }\n\n' +
  '    int bfsDistance(int src, int dst, int n) {\n        vector<int> dist(n, -1);\n        queue<int> q;\n' +
  '        dist[src] = 0; q.push(src);\n        while (!q.empty()) {\n            int cur = q.front(); q.pop();\n' +
  '            if (cur == dst) return dist[cur];\n            for (int next : adj[cur]) {\n' +
  '                if (dist[next] == -1) { dist[next] = dist[cur] + 1; q.push(next); }\n            }\n        }\n' +
  '        return -1;\n    }\n\n    vector<int> findShortestPaths(int n, vector<vector<int>>& edges, vector<vector<int>>& queries) {\n' +
  '        buildGraph(edges);\n        vector<int> results;\n        for (auto& query : queries) {\n' +
  '            results.push_back(bfsDistance(query[0], query[1], n));\n        }\n        return results;\n    }\n' +
  '};\n'.repeat(6); // repeated to land in the same order of magnitude as a real ~150-line submission

function makeSingleCapture() {
  return {
    receivedAt: new Date().toISOString(),
    problemSlug: 'shortest-path-queries',
    problemTitle: 'Shortest Path Queries',
    problemDescription: SINGLE_CAPTURE_DESCRIPTION,
    problemTags: ['Graph', 'BFS'],
    language: 'cpp',
    trigger: 'submit',
    timestamp: new Date().toISOString(),
    url: 'https://leetcode.com/problems/shortest-path-queries/',
    code: SINGLE_CAPTURE_CODE,
    attemptSeq: 1,
  };
}

async function runSingleCaptureScenario({ capturePort, compatThresholdChars, nativeThresholdChars, env = {} }) {
  const { server, requestsByRoute } = await startDualApiStubBackend({ compatThresholdChars, nativeThresholdChars });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-single-capture-test-'));
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
    fs.appendFileSync(capturesPath, JSON.stringify(makeSingleCapture()) + '\n');

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !/Reply number|error talking to backend/.test(out)) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(out, /Reply number|error talking to backend/, 'the single capture produced neither a reply nor an error');
    await new Promise((resolve) => setTimeout(resolve, 300));

    return { out, requestsByRoute };
  } finally {
    child.kill();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// The repro: COMPANION_BASE_URL is a stub port (not Ollama's own default
// address), so COMPANION_LOCAL_API's "auto" default resolves to 'openai' -
// matching any plain OpenAI-compatible server (the pre-fix behavior for
// every local-backend user, Ollama included, before native-mode support
// existed). A single, realistic-sized Submit capture with NO prior history
// alone crosses the simulated small context window, on the very first turn -
// this is the bug the task describes, not PR #33's accumulated-history one.
test('a single oversized capture with no prior history exhausts context on the very first turn (repro)', async () => {
  const { out, requestsByRoute } = await runSingleCaptureScenario({
    capturePort: 18160,
    compatThresholdChars: 500, // well below this single realistic capture's own size
    nativeThresholdChars: 100000, // irrelevant here - the compat route is the one hit
  });

  assert.match(
    out,
    /error talking to backend.*cut off before finishing/s,
    `expected the single oversized capture to exhaust the simulated compat-endpoint context on its own, got: ${JSON.stringify(out)}`
  );
  assert.equal(requestsByRoute.compat.length, 1, 'exactly one request, no history to have accumulated yet');
  assert.equal(requestsByRoute.native.length, 0, 'auto mode should not have touched the native route here');
});

// The fix: same single capture, same COMPANION_BASE_URL (still not Ollama's
// own default address, so this forces native mode explicitly rather than
// relying on the auto-detection default - see companion.js's LOCAL_API
// comment for why the default heuristic can't apply to a stub server).
// nativeThresholdChars is set above this capture's size (simulating the
// real, larger num_ctx headroom Ollama's native API actually provides),
// while compatThresholdChars stays just as tiny as the repro above - proving
// the fix comes from genuinely using the native route with more room, not
// from the capture having gotten any smaller.
test('COMPANION_LOCAL_API=native avoids the single-capture overflow via a real bigger context window', async () => {
  const { out, requestsByRoute } = await runSingleCaptureScenario({
    capturePort: 18161,
    compatThresholdChars: 500,
    nativeThresholdChars: 100000,
    env: { COMPANION_LOCAL_API: 'native', COMPANION_LOCAL_NUM_CTX: '8192' },
  });

  assert.match(out, /Reply number 1/, `expected a normal reply via the native route, got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('error talking to backend'), 'the native route should not have exhausted context');
  assert.equal(requestsByRoute.native.length, 1, 'the request should have gone to /api/chat');
  assert.equal(requestsByRoute.compat.length, 0, 'native mode should never touch the compat route');
});

// A stray /api/tags-style probe or any other route this stub doesn't know
// about isn't part of this feature (see companion.js's LOCAL_API comment:
// the API style is decided once up front from config, never auto-probed at
// request time), but this pins down that requestsByRoute stays keyed
// correctly by exact route even though both routes share one server/port -
// a regression here would silently misattribute requests between the two
// tests above.
test('the dual-API stub correctly separates compat and native requests by route', async () => {
  const { requestsByRoute: openaiRoutes } = await runSingleCaptureScenario({
    capturePort: 18162,
    compatThresholdChars: 100000,
    nativeThresholdChars: 100000,
  });
  assert.equal(openaiRoutes.compat.length, 1);
  assert.equal(openaiRoutes.native.length, 0);

  const { requestsByRoute: nativeRoutes } = await runSingleCaptureScenario({
    capturePort: 18163,
    compatThresholdChars: 100000,
    nativeThresholdChars: 100000,
    env: { COMPANION_LOCAL_API: 'native' },
  });
  assert.equal(nativeRoutes.compat.length, 0);
  assert.equal(nativeRoutes.native.length, 1);
});

// --- context-budget: pre-flight size check, pinned description, ----------
// --- and older-turn compression -------------------------------------------
//
// See companion/context-budget.test.js for direct unit coverage of the pure
// helpers (diffLines/formatDiffSummary/buildMessages/estimateTokens) these
// three subprocess-level tests exercise end to end. Investigation:
// data/companion-context-capacity-test (firstmate repo), and companion's
// own AGENTS.md, for the live-confirmed failure and design this closes.

// Drives `turnCount` consecutive captures for the *same* problem through a
// real companion.js subprocess against startTrackingStubBackend, each
// turn's code carrying a distinct, easy-to-grep marker
// (`attempt N marker line`) so a test can tell exactly which turn's raw
// code did or didn't survive into a later request. Waits for each numbered
// reply before sending the next, same discipline as
// runContextResetScenario/runManyTurnsScenario above.
async function runSameProblemManyTurns({ turnCount, capturePort, env = {} }) {
  const { server, requests } = await startTrackingStubBackend();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-budget-test-'));
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
    for (let i = 1; i <= turnCount; i += 1) {
      fs.appendFileSync(
        capturesPath,
        JSON.stringify(
          makeIdCapture({
            slug: 'two-sum',
            title: 'Two Sum',
            attemptSeq: i,
            trigger: i === turnCount ? 'submit' : 'run',
            // Realistic incremental edits (most lines identical between
            // attempts, only the marker comment line actually changes) -
            // unlike a synthetic fixture where every line differs between
            // attempts, this is the shape a diff is actually meant to
            // compress well, and matches how a student's real
            // attempt-to-attempt edits usually look.
            code:
              'def twoSum(nums, target):\n' +
              '    seen = {}\n' +
              '    for i, val in enumerate(nums):\n' +
              '        complement = target - val\n' +
              '        if complement in seen:\n' +
              '            return [seen[complement], i]\n' +
              `        # attempt ${i} marker line\n` +
              '        seen[val] = i\n' +
              '    return []\n',
          })
        ) + '\n'
      );
      const marker = `Reply number ${i}`;
      const deadline = Date.now() + 8000;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() < deadline && !out.includes(marker)) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(out.includes(marker), `turn ${i} reply never arrived`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200)); // let the queue fully settle
    }
    return { out, requests };
  } finally {
    child.kill();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// The priority fix: a capture whose estimated prompt size exceeds
// COMPANION_LOCAL_NUM_CTX minus COMPANION_LOCAL_RESERVE_TOKENS must be
// refused with a clean, visible error before it's ever sent - not silently
// let through to risk Ollama's native /api/chat discarding part of the
// prompt and reviewing the wrong code (the failure this exists to close).
// Uses a small NUM_CTX/RESERVE_TOKENS pair so this doesn't need an actual
// ~900-line capture to reproduce - the mechanism under test is the
// estimate-vs-budget comparison itself, not any particular real-world size.
test('a capture sized to exceed the estimated token budget is refused with a visible error, never sent', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'should never be reached' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-companion-preflight-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  // Far larger than the tight budget below allows (COMPANION_LOCAL_NUM_CTX
  // 2000 minus COMPANION_LOCAL_RESERVE_TOKENS 200 = an 1800-token budget;
  // this alone is roughly 18,800 characters, on top of the system prompt).
  const oversizedCode = 'def helper(nums, target):\n    return sum(nums) + target\n'.repeat(400);

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
      CAPTURE_PORT: '18170',
      COMPANION_LOCAL_NUM_CTX: '2000',
      COMPANION_LOCAL_RESERVE_TOKENS: '200',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.appendFileSync(
      capturesPath,
      JSON.stringify(
        makeIdCapture({ slug: 'two-sum', title: 'Two Sum', attemptSeq: 1, trigger: 'submit', code: oversizedCode })
      ) + '\n'
    );

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out.includes('error talking to backend')) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.match(
      out,
      /error talking to backend \(local\): this request is estimated at ~\d+ prompt tokens, over the \d+-token budget/,
      `expected a clean pre-flight refusal error, got: ${JSON.stringify(out)}`
    );
    assert.ok(
      !out.includes('should never be reached'),
      'the oversized reply must never print - the request should never have reached the stub'
    );
    assert.equal(requests.length, 0, 'the stub should never have received a request at all');
  } finally {
    child.kill();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// The correctness constraint on the description-once-per-problem change:
// the description must stay available for the whole session, not just for
// as long as the turn that first carried it survives trimHistory's rolling
// window. Aggressive trimming (COMPANION_LOCAL_MAX_HISTORY_TURNS=1) across
// 5 turns for the same problem guarantees turn 1's own user message is long
// gone from history by the last request - yet the pinned description (see
// context-budget.js's buildMessages) must still be there, reconstructed
// fresh into every request independent of that window.
test('the pinned problem description survives trimHistory dropping the turn that first carried it', async () => {
  const { requests } = await runSameProblemManyTurns({
    turnCount: 5,
    capturePort: 18171,
    env: { COMPANION_LOCAL_MAX_HISTORY_TURNS: '1' }, // only the latest pair is ever kept
  });

  assert.equal(requests.length, 5);
  const lastRequest = requests[4];
  assert.ok(
    !lastRequest.some((m) => m.role === 'user' && (m.content || '').includes('attempt 1 marker line')),
    "turn 1's own code should genuinely be gone from history by now (trimmed out)"
  );
  assert.ok(
    lastRequest.some((m) => m.role === 'system' && (m.content || '').includes('a problem description')),
    `expected the pinned description to still be present on the last request, got: ${JSON.stringify(lastRequest)}`
  );
});

// The compression itself: an older, already-reviewed turn's own raw code
// must not survive verbatim into a later request - only the very first
// capture (nothing earlier to diff against) and the current turn (never
// compressed - see buildMessages) keep their full code.
test('older history turns are compressed to a diff; the current turn always keeps its full code', async () => {
  const { requests } = await runSameProblemManyTurns({ turnCount: 4, capturePort: 18172 });

  assert.equal(requests.length, 4);
  const lastRequest = requests[3];
  const currentTurnMsg = lastRequest.find(
    (m) => m.role === 'user' && (m.content || '').includes('attempt 4 marker line')
  );
  assert.ok(currentTurnMsg, "the current turn's own code should be present");
  // Only a full, uncompressed turn carries the fenced code block
  // formatCaptureMessage wraps real code in - a compressed turn (below)
  // never does, since compressOldCaptureTurn drops it entirely.
  assert.match(currentTurnMsg.content, /```/, "the current turn should still carry its full fenced code block");

  const olderTurnMsg = lastRequest.find(
    (m) => m.role === 'user' && (m.content || '').includes('Code changed from the previous attempt')
  );
  assert.ok(olderTurnMsg, `expected a compressed diff for an older (non-first, non-current) turn, got: ${JSON.stringify(lastRequest)}`);
  assert.ok(
    !olderTurnMsg.content.includes('```'),
    "a compressed turn should no longer carry its own fenced code block"
  );
});

// Measures, not just asserts the marker text is present: a compressed
// older turn (a small, realistic one-line edit between attempts here -
// see runSameProblemManyTurns) should be dramatically smaller than its own
// full code+header+fences would have been, confirming this is a real size
// win and not just a cosmetic relabeling.
test('a compressed older turn is measurably smaller than its own original content', async () => {
  const { requests } = await runSameProblemManyTurns({ turnCount: 4, capturePort: 18173 });
  const lastRequest = requests[3];

  const diffMessages = lastRequest.filter(
    (m) => m.role === 'user' && (m.content || '').includes('Code changed from the previous attempt')
  );
  assert.ok(diffMessages.length >= 1, 'expected at least one compressed older turn in this request');
  const fullTurnMsg = lastRequest.find((m) => m.role === 'user' && (m.content || '').includes('```'));
  assert.ok(fullTurnMsg, 'expected at least one full (uncompressed) turn to compare against');
  for (const m of diffMessages) {
    assert.ok(
      m.content.length < fullTurnMsg.content.length / 2,
      `expected a compressed turn (${m.content.length} chars) to be well under half a full turn's size ` +
        `(${fullTurnMsg.content.length} chars)`
    );
  }
});

// Regression tests for the companion's displayed width tracking a live
// terminal resize. Reproduced live first (see the PR description and
// companion/AGENTS.md): the box rule and prose wrap width are already a
// single, correctly-firing width source (terminal-format.js's
// contentWidth(), driven by companion.js's real process.stdout 'resize'
// listener - see companion.js's own comment above that listener) - the
// resize *handling* itself was never broken. The actual bug was
// terminal-format.js's old COMFORTABLE_WIDTH, a fixed 80-column target
// regardless of how wide the terminal actually was: confirmed live, a
// 100+ column real terminal still rendered an 80-col box rule with visible
// unused space to its right. First fixed by raising that fixed target to a
// 120-col ceiling; Thomson then asked for it to be literally uncapped (a
// fullscreen monitor is often 200-300+ columns, and 120 still read as
// capped), so contentWidth() now tracks process.stdout.columns exactly with
// no upper bound at all - see terminal-format.js's own comment. Neither
// change touched how the resize event itself is wired up.
//
// These two tests spawn the real companion.js (via the same fake-TTY
// wrapper box-padding.test.js/box-corruption.test.js already use) and fire
// a genuine process.stdout 'resize' event partway through - not just call
// terminal-format.js's exports directly (that unit-level coverage already
// lives in terminal-format.test.js) - so this also stands as the
// resize-event-handler regression test the bug's other possible root cause
// (a #24-style regression, ruled out by the live reproduction above) would
// have needed. Output is replayed through virtual-terminal.js's
// replayToScreen, not a raw text/line search, for the same reason
// box-padding.test.js/box-corruption.test.js already do: a resize triggers
// a full \x1b[2J\x1b[H repaint, which a naive search can't tell apart from
// stale pre-resize bytes still sitting earlier in the stream.
function findRuleWidth(screenLines) {
  // replayToScreen returns one already-right-trimmed string per row (see
  // its own return statement), so a rule row's string length is exactly its
  // rendered width.
  const ruleLine = screenLines.find((line) => line.includes('─'));
  return ruleLine === undefined ? null : ruleLine.length;
}

test('an idle live terminal resize grows the box rule to the real terminal width, with no upper cap', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-width-resize-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  // 260 columns - deliberately past the old 80/120-col caps and into the
  // range Thomson described a real fullscreen monitor's terminal reaching
  // (200-300+ cols), so this proves genuinely uncapped tracking, not just
  // "wider than 120".
  const WIDE_COLUMNS = 260;

  const wrapper = [
    `process.stdout.isTTY = true;`,
    `process.stdout.columns = 60;`,
    `process.stdout.rows = 20;`,
    `await import('./companion.js');`,
    // Mirrors what a real terminal does on SIGWINCH (see companion.js's own
    // comment above its 'resize' listener): update columns, then emit
    // 'resize' - exercising the actual live listener, not a reimplementation
    // of it.
    `setTimeout(() => {`,
    `  process.stdout.columns = ${WIDE_COLUMNS};`,
    `  process.stdout.emit('resize');`,
    `}, 700);`,
  ].join('\n');

  const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: __dirname,
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: '18170',
      NO_COLOR: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  // Wait for the startup box to appear, then for comfortably longer than
  // the scheduled resize (700ms above) plus its own redraw - a single '─'
  // count can't distinguish "one rule drawn" from "two rules drawn" since
  // each rule is itself dozens of '─' characters.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !out.includes('─')) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));

  child.kill();
  fs.rmSync(scratch, { recursive: true, force: true });

  const screen = replayToScreen(out, { cols: WIDE_COLUMNS, rows: 20 });
  const width = findRuleWidth(screen);
  assert.ok(width !== null, `expected a box rule in the rendered screen, got: ${JSON.stringify(out)}`);
  // Must land exactly at the new terminal width, not the old fixed 80-col
  // target and not either of the previously-considered 120-col ceilings.
  assert.equal(width, WIDE_COLUMNS, `expected the rule to track the resize to the full ${WIDE_COLUMNS}-col terminal width, got ${width}`);
});

// Same resize, but fired while a reply is actively streaming (turnActive) -
// companion.js's own resize listener explicitly defers the visible redraw
// in that case (see its comment: "mid-turn, the new size still takes
// effect - just only visibly once the turn's own next write calls drawBox
// again") rather than forcing one immediately, so as not to corrupt
// whatever the in-progress turn's own writes are tracking. This proves that
// deferral still ends with the box correctly reflecting the new width once
// the turn completes, and that nothing above the box was corrupted by the
// resize landing mid-stream.
test('a live terminal resize mid-stream does not corrupt the turn and the box reflects the new width once it ends', async () => {
  const longReply =
    'This is a long paragraph meant to exercise prose wrapping so a resize landing mid-stream has real in-progress content to interact with rather than an empty turn.';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const mid = Math.ceil(longReply.length / 2);
      const first = longReply.slice(0, mid);
      const second = longReply.slice(mid);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: second } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 600);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-width-resize-midstream-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  // Same deliberately-past-any-old-cap width as the idle test above.
  const WIDE_COLUMNS = 260;

  const wrapper = [
    `process.stdout.isTTY = true;`,
    `process.stdout.columns = 60;`,
    `process.stdout.rows = 20;`,
    `await import('./companion.js');`,
    `setTimeout(() => {`,
    `  process.stdout.columns = ${WIDE_COLUMNS};`,
    `  process.stdout.emit('resize');`,
    `}, 300);`, // lands while the reply above is still mid-stream
  ].join('\n');

  const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: __dirname,
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: '18171',
      NO_COLOR: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  await new Promise((resolve) => setTimeout(resolve, 800)); // let the box appear
  fs.appendFileSync(capturesPath, JSON.stringify(makeCapture({ trigger: 'submit', attemptSeq: 1 })) + '\n');

  // A single word, not a multi-word phrase - the reply's own wrap width
  // (which this very test varies) can land a line break between any two
  // words, so a phrase spanning a wrap point would falsely look absent.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !out.includes('turn.')) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  child.kill();
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });

  // Strip ANSI codes and undo indentContinuation's hanging-indent line
  // breaks (a "\n" followed by the turnMarker-width indent) before checking
  // the full phrase survived - otherwise a wrap point landing mid-phrase
  // (which shifts with the width this test is exercising) would make an
  // intact reply look corrupted.
  const stripped = out.replace(/\x1b\[[0-9;]*m/g, '').replace(/\n {2}/g, ' ');
  assert.match(stripped, /got your Submit for Two Sum - taking a look/);
  assert.match(stripped, /attempt 1/);
  // The full reply must have reached the terminal intact, not corrupted by
  // the resize landing mid-write.
  assert.match(stripped, /interact with rather than an empty turn\.?/);

  const screen = replayToScreen(out, { cols: WIDE_COLUMNS, rows: 20 });
  const width = findRuleWidth(screen);
  assert.ok(width !== null, `expected a box rule in the final rendered screen, got: ${JSON.stringify(out)}`);
  assert.equal(width, WIDE_COLUMNS, `expected the box to reflect the full ${WIDE_COLUMNS}-col terminal width once the turn ended, got ${width}`);
});
