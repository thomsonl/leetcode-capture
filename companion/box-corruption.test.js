// Regression test for a capture (or a typed reply) corrupting everything
// already printed above the box while a long typed line sits in the prompt.
//
// Root cause (see companion.js's drawBoxRaw and AGENTS.md): node's readline
// tracks its own `prevRows` - how many rows its last `_refreshLine` render
// took - and rl.prompt(true) uses that to move the cursor *up* before
// clearing+redrawing. That's fine as long as readline is the only thing
// that's touched the terminal since its last render, but companion.js's own
// clearBottomRows already repositions the cursor independently (using this
// file's own row math) before every redraw. Once the prompt wraps to more
// than one physical row, readline's stale `prevRows` (from the *previous*
// multi-row render of the same long line) makes rl.prompt(true) move the
// cursor further up than it should - straight into content clearBottomRows
// never touched (an earlier turn's ack/label lines) - and then erases it
// with clearScreenDown before redrawing the box there instead. The fix
// (drawBoxRaw) resets rl.prevRows to 0 immediately before every
// rl.prompt(true) call, so that upward move is always a no-op.
//
// This can't be caught by a plain text search over the raw captured byte
// stream (box-padding.test.js's technique, sufficient for its own simpler
// padding-math bug): the corruption is about *interpreted* rendering - the
// erased text's bytes are still sitting earlier in the raw stream, just
// followed by escape codes that would make a real terminal stop showing
// them. This test replays the raw output through virtual-terminal.js (a
// small ANSI interpreter scoped to exactly what companion.js/readline emit)
// to see what a real terminal would actually display, the same ground truth
// established by live tmux verification (see the PR that introduced this
// file and AGENTS.md).
//
// Run with: node --test box-corruption.test.js

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

// --- virtual-terminal.js's own correctness, checked directly -------------

test('replayToScreen: plain text and newlines land where a terminal would show them', () => {
  const screen = replayToScreen('line one\nline two\n', { cols: 20, rows: 4 });
  assert.deepEqual(screen, ['line one', 'line two', '', '']);
});

test('replayToScreen: clearScreenDown erases from the cursor to the end of the screen', () => {
  // Three lines written, then cursor moved up 2 rows and clearScreenDown
  // (node's readline.clearScreenDown byte, confirmed empirically: '\x1b[0J')
  // fired from there - the first line must survive; the other two must not.
  const raw = 'first\nsecond\nthird\n\x1b[2A\x1b[0Jreplaced';
  const screen = replayToScreen(raw, { cols: 20, rows: 5 });
  assert.deepEqual(screen, ['first', 'replaced', '', '', '']);
});

test('replayToScreen: a stale extra moveCursor-up before clearScreenDown erases a row it should not', () => {
  // This is the exact shape of the bug: clearBottomRows itself already did
  // the *correct*, intentionally-scoped erase (move up 1 row, clear down -
  // removing "ack line" but leaving "banner" alone, matching this file's own
  // row math). Then a *second*, independent moveCursor (readline's own
  // stale prevRows, from rl.prompt(true)) moves up one row *more* than that
  // before its own clearScreenDown - reaching "banner", which nothing was
  // ever supposed to touch, and erasing it too before drawing "box" in its
  // place.
  const raw = 'banner\nack line\n\x1b[1A\x1b[0J\x1b[1A\x1b[0Jbox';
  const screen = replayToScreen(raw, { cols: 20, rows: 5 });
  // "banner" is gone (overwritten by "box") even though the first,
  // correctly-scoped erase alone would have left it untouched.
  assert.deepEqual(screen, ['box', '', '', '', '']);
});

// --- real companion.js, replayed through the emulator ---------------------

function startStubBackend(replyText) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // ignore
      }
      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: replyText } }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function makeCapture({ trigger, attemptSeq }) {
  return {
    receivedAt: new Date().toISOString(),
    problemSlug: 'two-sum',
    problemTitle: 'Two Sum',
    problemDescription: 'Given an array of integers nums and an integer target...',
    problemTags: ['Array'],
    language: 'python3',
    trigger,
    timestamp: new Date().toISOString(),
    url: 'https://leetcode.com/problems/two-sum/',
    code: 'def twoSum(nums, target):\n    pass',
    attemptSeq,
  };
}

test('a capture arriving while a long typed line wraps the prompt does not corrupt the previous turn', async () => {
  const rows = 20;
  const cols = 80;
  const stub = await startStubBackend('Got it, standing by.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-box-corruption-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  const wrapper = [
    `process.stdout.isTTY = true;`,
    `process.stdout.columns = ${cols};`,
    `process.stdout.rows = ${rows};`,
    `await import('./companion.js');`,
  ].join('\n');

  const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: __dirname,
    env: {
      ...process.env,
      COMPANION_BACKEND: 'local',
      COMPANION_MODEL: 'stub-model',
      COMPANION_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1`,
      LEETCODE_CAPTURES_FILE: capturesPath,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
      LEETCODE_COMPANION_POLL_MS: '100',
      CAPTURE_PORT: '18161', // arbitrary unused port
      // Explicitly off, not just unset - the box (and this whole bug) only
      // exists when styling is on; NO_COLOR set in the ambient environment
      // would otherwise silently turn this test into a no-op.
      NO_COLOR: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  async function waitFor(predicate, description) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for: ${description}\n${out}`);
  }

  // First capture: fills a bit of the screen with real turn content (the
  // ack line + label this test asserts survives) before the long-line
  // typing starts.
  await waitFor(() => out.includes('─'), 'startup box');
  fs.appendFileSync(capturesPath, JSON.stringify(makeCapture({ trigger: 'run', attemptSeq: 1 })) + '\n');
  await waitFor(() => out.includes('Got it, standing by.'), 'first capture reply');
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Now simulate typing a line long enough to wrap to 3 physical rows at
  // 80 columns, written directly to the child's stdin the same way a real
  // keystroke stream would arrive - and wait for it to actually land in the
  // captured output (readline's own echo) before moving on, so this isn't
  // racing the same timing gap a naive fixed delay would.
  const longLine =
    'this is a deliberately long typed line well past eighty characters so it wraps onto extra physical terminal rows all on its own';
  child.stdin.write(longLine);
  await waitFor(() => out.includes(longLine.slice(0, 40)), 'typed line echoed');
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Second capture, while that long line is still sitting unsent in the
  // prompt - this is the exact scenario that corrupted the screen before
  // the fix.
  fs.appendFileSync(capturesPath, JSON.stringify(makeCapture({ trigger: 'submit', attemptSeq: 2 })) + '\n');
  // Anchored to the second capture's own label, then its own reply, then a
  // rule redrawn after that reply - not a raw *count* of the reply text
  // across the whole cumulative stream. While the screen hasn't genuinely
  // filled yet, every redraw is a full repaint of everything currently
  // visible (redrawViewport - see companion.js's drawBox), so the first
  // capture's own reply text legitimately gets re-emitted multiple times as
  // the second capture's own turn proceeds (its ack line, its label, each
  // trigger their own repaint) - a plain occurrence count can reach 2 well
  // before the second capture's reply has actually arrived.
  await waitFor(() => {
    const labelIndex = out.lastIndexOf('(attempt 2)');
    if (labelIndex === -1) return false;
    const replyIndex = out.indexOf('Got it, standing by.', labelIndex);
    if (replyIndex === -1) return false;
    return out.indexOf('─', replyIndex) !== -1;
  }, 'second capture reply');
  await new Promise((resolve) => setTimeout(resolve, 300));

  child.kill();
  stub.close();
  fs.rmSync(scratch, { recursive: true, force: true });

  const screen = replayToScreen(out, { cols, rows });
  const screenText = screen.join('\n');

  // The first turn's own ack/label lines must still be visible - this is
  // exactly what the prevRows bug erased.
  assert.match(
    screenText,
    /got your Run for Two Sum/,
    `expected the first capture's ack line to survive, got:\n${screenText}`
  );
  assert.match(
    screenText,
    /\[capture\] Run - Two Sum \(attempt 1\)/,
    `expected the first capture's label to survive, got:\n${screenText}`
  );
  // And the second turn's own ack/label must be present too - the bug also
  // ate the *new* turn's own ack/label on its way to erasing the old one.
  assert.match(
    screenText,
    /got your Submit for Two Sum/,
    `expected the second capture's ack line to appear, got:\n${screenText}`
  );
  assert.match(
    screenText,
    /\[capture\] Submit - Two Sum \(attempt 2\)/,
    `expected the second capture's label to appear, got:\n${screenText}`
  );
  // The box's rule must still directly precede the prompt somewhere on
  // screen (not collapsed away by an erroneous erase).
  const ruleIndex = screen.findIndex((line) => /^ ?─+$/.test(line));
  assert.notEqual(ruleIndex, -1, `expected to find the box's rule, got:\n${screenText}`);
});
