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
// each request to a response shape; defaults to a normal, non-empty content
// reply if not overridden for a given call.
function startStubBackend(replyFor) {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      callCount += 1;
      const message = replyFor(callCount, JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
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
