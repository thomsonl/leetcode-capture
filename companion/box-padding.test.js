// Regression tests for the input box's pinning/padding math - originally
// just the box floating mid-screen instead of pinning to the terminal
// window's actual last row (see the first test below), extended to also
// cover two more bugs found live-testing that same fix (see
// companion/AGENTS.md's "input area is a small pinned box" /
// "pinned to the terminal window's actual last row" sections for the full
// history):
//
// 1. The box floating mid-screen: drawBox() used to write the rule + "> "
//    prompt directly at wherever the cursor already was after whatever
//    content had been printed so far - correct once real content has
//    scrolled the screen full at least once (the terminal's own scrolling
//    then keeps the box glued to the last row for free), but wrong before
//    that: with only a little startup content on screen, the box sat just
//    below it, with the rest of the window left blank underneath instead of
//    above - not glued to the window's last row the way vim's command line
//    or less's status line is. Fixed by padding once at startup
//    (padToBottomIfNeeded, since superseded by the fix below).
//
// 2. Chat content clustering at the bottom next to the box instead of
//    growing from the top, with real content (even the startup banner)
//    silently lost off the top of the screen: padToBottomIfNeeded's old
//    unconditional `screenFilledToBox = true` after its very first call
//    meant every *later* incremental redraw (a capture arriving) skipped
//    padding entirely and wrote new content immediately adjacent to the box
//    - which, since the box is pinned to the terminal's actual last row,
//    always forced a real terminal scroll on every redraw, silently
//    dropping a row off the top each time. Fixed by drawBox routing every
//    redraw through a full repaint (redrawViewport, which recomputes
//    padding fresh from historyBuffer - the true, never-lost record of
//    everything printed) until the screen has *genuinely* filled with real
//    content, not just after the first draw.
//
// A companion bug (a capture arriving while a long typed line wraps the
// prompt corrupting everything above the box, from readline's own
// `prevRows` bookkeeping going stale) is covered separately in
// box-corruption.test.js - it needs a real ANSI-interpreting replay to
// detect (see that file's own header for why), not just a raw text/line
// search the way the padding-math bugs above can be checked.
//
// This spawns the *real* companion.js as the actual program under test
// (not a reimplementation of its box logic), faking process.stdout.isTTY
// (and a fixed rows/columns) before it ever runs - the same trick
// terminal-format.test.js already uses for its own TTY-dependent
// assertions, since a spawned child's stdout is a plain pipe by default and
// ESM module state (here, companion.js's own top-level code) can't be
// re-evaluated with a different isTTY after the fact. Faking isTTY this way
// exercises every one of companion.js's real TTY-only code paths (styling,
// drawBox, redrawViewport) exactly as a real terminal would trigger them;
// the one thing it can't verify is how a real terminal *renders* the
// resulting escape codes - see companion/AGENTS.md for why the rest of this
// feature area's verification bar is a real pty/tmux, not `node --test`.
// What it can verify directly, with no terminal needed: the padding/repaint
// writes here are literal '\n' and text characters (a screen clear plus a
// full rewrite, not an incremental cursor-position edit), so simply
// counting/ordering lines in the raw captured output already proves whether
// the padding math and content ordering are right.
//
// Run with: node --test box-padding.test.js

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
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// The full-screen clear + cursor-home sequence redrawViewport (see
// companion.js) writes at the start of every repaint - not an SGR color
// code, so ANSI_RE above doesn't touch it. A real terminal replaces
// whatever it was showing the instant this arrives; this raw byte capture
// doesn't, so anything written *before* the last occurrence of this
// sequence is stale content a real terminal would already have discarded
// (see finalScreenLines below).
const CLEAR_RE = /\x1b\[2J\x1b\[H/g;

// Returns the lines of only the *most recent* full-screen repaint in a raw
// captured byte stream, ANSI-color-stripped - i.e. what a real terminal
// would actually be showing right now, not the full history of every write
// this test happened to capture along the way. Startup alone already
// triggers one such repaint (drawBox's own fill-phase branch - see
// companion.js), which duplicates the startup banner's own direct
// console.log writes earlier in the same raw capture; without this, a naive
// line search over the whole raw stream can match against that stale,
// already-superseded first copy instead of the real final layout.
function finalScreenLines(raw) {
  const clears = raw.split(CLEAR_RE);
  const finalScreen = clears[clears.length - 1];
  return finalScreen.replace(ANSI_RE, '').split('\n');
}

// Spawns companion.js itself (via a tiny wrapper that fakes isTTY/rows/
// columns before dynamically importing it - a static `import` would be
// hoisted and evaluate companion.js before the isTTY assignment ever runs,
// same reasoning as terminal-format.test.js's runInChild), waits for its
// startup banner to finish printing, then returns the raw captured output.
// No capture is ever sent - this only needs the very first, startup box
// draw, which is the bug report's own easiest-to-see repro case.
async function runCompanionWithFakeTty({ rows, columns }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-box-padding-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  const wrapper = [
    `process.stdout.isTTY = true;`,
    `process.stdout.columns = ${columns};`,
    `process.stdout.rows = ${rows};`,
    `await import('./companion.js');`,
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
      // An arbitrary unused port so the relay-server health check fails
      // fast and companion.js moves on to its own startup banner - same
      // technique companion.test.js already uses.
      CAPTURE_PORT: '18150',
      NO_COLOR: '',
    },
    // stdin must stay open, not 'ignore' - readline treats an immediate EOF
    // on stdin as Ctrl+D and exits right away (see companion.test.js).
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  // Poll for the box's own rule (a run of the '─' box-drawing character) to
  // show up, rather than a fixed sleep - the startup banner's exact line
  // count isn't this test's business to hardcode (see the assertions
  // below, which derive it from the output instead).
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !out.includes('─')) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // A little more time so nothing is still mid-write when this returns.
  await new Promise((resolve) => setTimeout(resolve, 200));

  child.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
  return out;
}

// Starts a stub OpenAI-compatible chat-completions server that always
// replies with the same short text - just enough for a capture's turn to
// complete and print, same technique as companion.test.js's own
// startStubBackend, trimmed to what this file needs.
function startStubBackend(replyText) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // ignore malformed body - not this test's concern
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

function makeCapture(attemptSeq) {
  return {
    receivedAt: new Date().toISOString(),
    problemSlug: 'two-sum',
    problemTitle: 'Two Sum',
    problemDescription: 'Given an array of integers nums and an integer target...',
    problemTags: ['Array'],
    language: 'python3',
    trigger: 'run',
    timestamp: new Date().toISOString(),
    url: 'https://leetcode.com/problems/two-sum/',
    code: 'def twoSum(nums, target):\n    pass',
    attemptSeq,
  };
}

// Same shape as runCompanionWithFakeTty above, but wired to a real stub
// backend and able to send a sequence of captures, waiting for each one's
// reply before sending the next (this file's own tests only need a handful
// of short exchanges, not the full tailing/offset-tracking behavior
// companion.test.js already covers elsewhere).
async function runCompanionWithCapturesAndFakeTty({ rows, columns, captureCount, replyText }) {
  const stub = await startStubBackend(replyText);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-box-padding-test-'));
  const capturesPath = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(capturesPath, '');

  const wrapper = [
    `process.stdout.isTTY = true;`,
    `process.stdout.columns = ${columns};`,
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
      CAPTURE_PORT: '18151',
      NO_COLOR: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));

  async function waitFor(predicate) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !predicate()) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  await waitFor(() => out.includes('─'));
  for (let seq = 1; seq <= captureCount; seq += 1) {
    fs.appendFileSync(capturesPath, JSON.stringify(makeCapture(seq)) + '\n');
    // Anchored to *this* capture's own label, then its own reply, then a
    // rule redrawn after that reply (confirming its turn's own final box
    // redraw actually happened) - not a raw occurrence *count* of
    // replyText across the whole cumulative stream. During the fill phase
    // (screen not yet genuinely full - see companion.js's drawBox),
    // *every* redraw is a full repaint of everything currently visible
    // (redrawViewport), so earlier captures' own reply text legitimately
    // gets re-emitted into the raw output many times over as the
    // conversation grows - a plain "has replyText appeared N times yet"
    // count reaches N long before the Nth capture's own turn has actually
    // finished, and can even race ahead of it entirely under load.
    // eslint-disable-next-line no-await-in-loop
    await waitFor(() => {
      const labelIndex = out.lastIndexOf(`(attempt ${seq})`);
      if (labelIndex === -1) return false;
      const replyIndex = out.indexOf(replyText, labelIndex);
      if (replyIndex === -1) return false;
      return out.indexOf('─', replyIndex) !== -1;
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  child.kill();
  stub.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  return out;
}

test('the box pins to the terminal window\'s actual last row on a tall window with only short startup content', async () => {
  const rows = 30;
  const out = await runCompanionWithFakeTty({ rows, columns: 100 });

  const lines = finalScreenLines(out);
  // A leading space is boxRule's own one-space left margin (see
  // terminal-format.js's boxRule) - not part of the padding math this test
  // is checking.
  const ruleIndex = lines.findIndex((line) => /^ ?─+$/.test(line));
  assert.notEqual(ruleIndex, -1, `expected to find the box's rule line, got: ${JSON.stringify(lines.join('\n'))}`);

  // The core invariant this fixes: the rule must sit on the terminal's
  // actual second-to-last row (0-indexed rows-2), with the prompt right
  // after it on the last row - not wherever the cursor happened to be after
  // a handful of startup lines, floating mid-screen with blank space left
  // *underneath* it instead of above it.
  assert.equal(
    ruleIndex,
    rows - 2,
    `expected the rule at row ${rows - 2} (0-indexed) so it lands on the terminal's actual last-but-one row, got row ${ruleIndex} - box is floating mid-screen instead of pinned to the bottom`
  );
  assert.ok(
    lines[ruleIndex + 1].includes('>'),
    `expected the prompt to immediately follow the rule on the terminal's actual last row, got: ${JSON.stringify(lines[ruleIndex + 1])}`
  );

  // Sanity check that this only passed because real padding happened, not
  // because the startup banner coincidentally already had rows-2 lines: the
  // banner is a handful of short, fixed status lines (see companion.js's
  // startup section), nowhere near enough to fill a 30-row window on its
  // own, so the line right before the rule must be blank filler.
  assert.equal(lines[ruleIndex - 1], '', 'expected a blank padding line directly above the rule');
});

test('the box does not pad (and does not crash) when the window is too short for even the startup banner', async () => {
  // A degenerate case (visibleRows smaller than the banner itself) - just
  // confirms redrawViewport's `slice.length < visibleRows` guard means no
  // extra padding is emitted, and nothing throws (e.g. from a negative
  // '\n'.repeat count).
  const out = await runCompanionWithFakeTty({ rows: 4, columns: 100 });
  const stripped = out.replace(ANSI_RE, '');
  assert.match(stripped, /─+/, 'expected the box to still draw even in a too-short window');
});

test('a short conversation in a tall window grows from the top, keeping earlier content (even the startup banner) instead of losing it to the box\'s own redraws', async () => {
  // The actual issue 1 bug (see this file's header): before the fix, only
  // the very first drawBox call ever padded - every later incremental
  // redraw (each capture's reply) wrote new content immediately adjacent to
  // the box, which is pinned to the terminal's last row, forcing a real
  // terminal scroll on every single redraw and silently dropping a row off
  // the *top* of the screen each time. In a tall window with only a
  // handful of short exchanges, that meant the startup banner - and even
  // earlier captures' own replies - would be gone by the time a later
  // capture's reply printed, despite acres of unused blank space still
  // being available on screen. Confirmed live over several real captures in
  // a tmux pane (see the PR that introduced this test).
  const rows = 40;
  const replyText = 'Got it, standing by.';
  const out = await runCompanionWithCapturesAndFakeTty({ rows, columns: 100, captureCount: 3, replyText });

  const lines = finalScreenLines(out);
  const screenText = lines.join('\n');

  // The startup banner must still be visible - the exact thing the bug
  // silently scrolled away.
  assert.match(screenText, /companion: type to chat directly/, `expected the startup banner to survive, got:\n${screenText}`);
  // All three captures' own ack lines must still be visible too, not just
  // the most recent one.
  for (const seq of [1, 2, 3]) {
    assert.match(
      screenText,
      new RegExp(`\\[capture\\] Run - Two Sum \\(attempt ${seq}\\)`),
      `expected capture ${seq}'s label to survive, got:\n${screenText}`
    );
  }

  // Content must actually be growing from the *top* of the screen, not
  // clustering at the bottom next to the box: the banner should appear
  // before any capture's own content, in on-screen order.
  const bannerIndex = lines.findIndex((l) => l.includes('companion: type to chat directly'));
  const firstCaptureIndex = lines.findIndex((l) => l.includes('attempt 1'));
  assert.ok(bannerIndex !== -1 && firstCaptureIndex !== -1 && bannerIndex < firstCaptureIndex);

  // And the box must still be pinned to the terminal's actual last two
  // rows, exactly like the very first test in this file checks for the
  // startup-only case.
  const ruleIndex = lines.findIndex((line) => /^ ?─+$/.test(line));
  assert.notEqual(ruleIndex, -1, `expected to find the box's rule, got:\n${screenText}`);
  assert.ok(lines[ruleIndex + 1].includes('>'), 'expected the prompt directly below the rule');
});

test('the box keeps a guaranteed blank breathing-room line above its rule even once the screen has genuinely filled', async () => {
  // Issue 2 (see this file's header and terminal-format.js's boxRule): the
  // box used to read as cramped against whatever was directly above it.
  // drawBoxRaw now always writes one blank line before the rule, so there's
  // real breathing room even once natural terminal scrolling has taken
  // over (screenFilledToBox latched true) and there's no leftover padding
  // left to coincidentally provide it. A short window with enough captures
  // to genuinely fill it is what forces that latched, no-more-padding
  // state - this deliberately does *not* rely on the startup-padding case
  // the first test in this file already covers.
  //
  // Unlike the other tests in this file, this one needs `replayToScreen`
  // (virtual-terminal.js), not `finalScreenLines`: once the screen has
  // genuinely filled, later redraws use the *incremental* path
  // (clearBottomRows + drawBoxRaw - relative cursor moves, no full
  // `\x1b[2J\x1b[H` clear), so "everything after the last full clear" no
  // longer means "exactly the final screen" - a later incremental redraw's
  // own bytes can trail after it in the raw capture. Only replaying every
  // escape code against a real cursor/grid, the same technique
  // box-corruption.test.js uses, gives the true final rendered state
  // regardless of which redraw path produced it.
  const rows = 12;
  const columns = 100;
  const replyText = 'Got it, standing by.';
  const out = await runCompanionWithCapturesAndFakeTty({ rows, columns, captureCount: 4, replyText });

  const lines = replayToScreen(out, { cols: columns, rows });
  const ruleIndex = lines.findIndex((line) => /^ ?─+$/.test(line));
  assert.notEqual(ruleIndex, -1, `expected to find the box's rule, got:\n${lines.join('\n')}`);
  assert.equal(
    lines[ruleIndex - 1],
    '',
    `expected a guaranteed blank line directly above the rule even with the screen genuinely full, got:\n${lines.join('\n')}`
  );
  // A one-space left margin on both the rule and the prompt (see
  // terminal-format.js's boxRule/promptString) - consistent inset, not the
  // rule starting flush at column 0 while the prompt sits one column in.
  assert.match(lines[ruleIndex], /^ ─/, 'expected the rule to carry its one-space left margin');
  assert.match(lines[ruleIndex + 1], /^ >/, 'expected the prompt to carry the same one-space left margin');
});
