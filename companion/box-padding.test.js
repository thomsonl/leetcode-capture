// Regression test for the input box floating mid-screen instead of pinning
// to the terminal window's actual last row.
//
// Before this fix, drawBox() (see companion.js) wrote the rule + "> " prompt
// directly at wherever the cursor already was after whatever content had
// been printed so far - correct once real content has scrolled the screen
// full at least once (the terminal's own scrolling then keeps the box glued
// to the last row for free), but wrong before that: with only a little
// startup content on screen, the box sat just below it, with the rest of
// the window left blank underneath instead of above - not glued to the
// window's last row the way vim's command line or less's status line is.
// padToBottomIfNeeded (companion.js) now pads with blank lines so the box's
// very first draw lands on the terminal's actual last row instead.
//
// This spawns the *real* companion.js as the actual program under test
// (not a reimplementation of its box logic), faking process.stdout.isTTY
// (and a fixed rows/columns) before it ever runs - the same trick
// terminal-format.test.js already uses for its own TTY-dependent
// assertions, since a spawned child's stdout is a plain pipe by default and
// ESM module state (here, companion.js's own top-level code) can't be
// re-evaluated with a different isTTY after the fact. Faking isTTY this way
// exercises every one of companion.js's real TTY-only code paths (styling,
// drawBox, padToBottomIfNeeded) exactly as a real terminal would trigger
// them; the one thing it can't verify is how a real terminal *renders* the
// resulting escape codes - see companion/AGENTS.md's "input area is a small
// pinned box" section for why the rest of this feature area's verification
// bar is a real pty/tmux, not `node --test`. What it can verify directly,
// with no terminal needed: padToBottomIfNeeded writes literal '\n'
// characters, not cursor-positioning escapes, so simply counting lines in
// the raw captured output already proves whether the padding math is right.
//
// Run with: node --test box-padding.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANSI_RE = /\x1b\[[0-9;]*m/g;

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

test('the box pins to the terminal window\'s actual last row on a tall window with only short startup content', async () => {
  const rows = 30;
  const out = await runCompanionWithFakeTty({ rows, columns: 100 });

  const stripped = out.replace(ANSI_RE, '');
  const lines = stripped.split('\n');
  const ruleIndex = lines.findIndex((line) => /^─+$/.test(line));
  assert.notEqual(ruleIndex, -1, `expected to find the box's rule line, got: ${JSON.stringify(stripped)}`);

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
  // confirms padToBottomIfNeeded's `contentRows < visibleRows` guard means
  // no padding is emitted, and nothing throws (e.g. from a negative
  // '\n'.repeat count).
  const out = await runCompanionWithFakeTty({ rows: 4, columns: 100 });
  const stripped = out.replace(ANSI_RE, '');
  assert.match(stripped, /─+/, 'expected the box to still draw even in a too-short window');
});
