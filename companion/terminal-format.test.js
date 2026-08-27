// Regression tests for terminal-format.js's TTY/NO_COLOR gating and markdown
// rendering.
//
// terminal-format.js decides once, at import time, whether styling is on
// (based on process.stdout.isTTY and NO_COLOR - see its header comment for
// why that decision is made explicitly rather than left to chalk's or
// marked-terminal's own ambient auto-detection). That means each scenario
// here needs its own fresh process with the relevant env/TTY state set
// *before* the module is ever imported - a single `node --test` process
// can't flip process.stdout.isTTY and re-import to get a different answer,
// since ESM module state is cached after the first import.
//
// Run with: node --test terminal-format.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ESC = '';

// Runs `script` (a small ESM snippet that imports terminal-format.js and
// logs whatever it wants to check) in a fresh child process, faking
// process.stdout.isTTY to `isTTY` before the import happens - this is the
// same trick a real terminal-attached process gives Node for free, just set
// explicitly since a spawned child's stdout is a pipe by default.
function runInChild({ isTTY, noColor, script }) {
  const wrapped = `process.stdout.isTTY = ${JSON.stringify(isTTY)};\n${script}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', wrapped], {
      cwd: __dirname,
      env: { ...process.env, ...(noColor ? { NO_COLOR: '1' } : { NO_COLOR: '' }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${err}`));
      else resolve(out);
    });
  });
}

// Uses a dynamic import() rather than a static `import` statement in the
// generated scripts below - static imports are hoisted and evaluated before
// any other top-level code in the module regardless of source order, which
// would import terminal-format.js (and freeze its styling decision) before
// the process.stdout.isTTY assignment above it ever runs.
test('styling is off (plain markdown, no ANSI) when stdout is not a TTY', async () => {
  const out = await runInChild({
    isTTY: false,
    script: `
      const { renderMarkdown, dim, promptString } = await import('./terminal-format.js');
      console.log(renderMarkdown('**bold** text\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`'));
      console.log(dim('companion: status'));
      console.log(JSON.stringify(promptString()));
    `,
  });
  assert.ok(!out.includes(ESC), `expected no ANSI escape codes, got: ${JSON.stringify(out)}`);
  assert.match(out, /\*\*bold\*\* text/); // raw markdown syntax untouched
  assert.match(out, /```js/);
  assert.match(out, /companion: status/);
  assert.match(out, /"> "/); // promptString falls back to the plain '> '
});

test('styling renders markdown wrapped to the real terminal width, with no upper cap, and colors when stdout is a TTY', async () => {
  const out = await runInChild({
    isTTY: true,
    script: [
      'process.stdout.columns = 200;', // an ultrawide terminal - content must stretch to use it, not stay capped
      "const { renderMarkdown, dim, promptString } = await import('./terminal-format.js');",
      // 149 chars - wider than the old fixed/capped width (80, later 120),
      // but well within a 200-col terminal, so this must render on one
      // unwrapped line now that there is no upper cap.
      "const paragraph = new Array(30).fill('word').join(' ');",
      "const fence = '```';",
      "const md = ['# Header', '', '**bold** text', '', paragraph, '', 'Here:', '', fence + 'js', 'const x = 1;', fence].join('\\n');",
      'console.log(renderMarkdown(md));',
      "console.log(dim('companion: status'));",
      'console.log(promptString());',
      "console.log('PARAGRAPH:' + paragraph);", // ground truth to compare the rendered line against
    ].join('\n'),
  });
  assert.ok(out.includes(ESC), 'expected ANSI escape codes when styling is on');
  // The fenced code block is set off from prose (marked-terminal indents
  // code blocks), and none of the raw markdown syntax markers survive
  // verbatim in the rendered header/bold text.
  assert.ok(!out.includes('**bold**'), 'bold markers should have been rendered, not left literal');
  assert.match(out, /bold/); // the word itself still present, just styled
  assert.match(out, /const/);
  assert.match(out, />/); // promptString's ">" marker
  const stripped = out.replace(/\x1b\[[0-9;]*m/g, '');
  const paragraph = stripped
    .split('\n')
    .find((l) => l.startsWith('PARAGRAPH:'))
    .slice('PARAGRAPH:'.length);
  const paragraphLine = stripped.split('\n').find((l) => l.trim().startsWith('word word'));
  assert.ok(paragraphLine, `expected the paragraph to appear in the rendered output: ${JSON.stringify(stripped)}`);
  assert.equal(
    paragraphLine.trim(),
    paragraph,
    `expected the paragraph to render on one unwrapped line at this terminal width, got: ${JSON.stringify(paragraphLine)}`
  );
});

test('NO_COLOR disables styling even on a TTY', async () => {
  const out = await runInChild({
    isTTY: true,
    noColor: true,
    script: `
      const { stylingEnabled, dim } = await import('./terminal-format.js');
      console.log(JSON.stringify(stylingEnabled()));
      console.log(dim('companion: status'));
    `,
  });
  assert.match(out, /^false/);
  assert.ok(!out.includes(ESC), `expected no ANSI escape codes under NO_COLOR, got: ${JSON.stringify(out)}`);
});

// --- turnMarker / boxRule / spinnerFrame (Claude-Code-TUI-like turns) ------

test('turnMarker/boxRule are empty when styling is off - piped output stays undecorated', async () => {
  const out = await runInChild({
    isTTY: false,
    script: `
      const { turnMarker, boxRule } = await import('./terminal-format.js');
      console.log(JSON.stringify(turnMarker()));
      console.log(JSON.stringify(boxRule()));
    `,
  });
  const lines = out.trim().split('\n');
  assert.equal(lines[0], '""');
  assert.equal(lines[1], '""');
});

test('turnMarker is a bullet, boxRule is a plain rule, when styling is on', async () => {
  const out = await runInChild({
    isTTY: true,
    script: `
      const { turnMarker, boxRule } = await import('./terminal-format.js');
      console.log(turnMarker());
      console.log(boxRule());
    `,
  });
  const [marker, rule] = out.split('\n');
  assert.ok(marker.includes(ESC), 'expected turnMarker to carry ANSI styling');
  assert.ok(marker.includes('•'), 'expected turnMarker to include the bullet character');
  assert.ok(rule.includes(ESC), 'expected boxRule to carry ANSI styling');
  assert.ok(rule.includes('─'), 'expected boxRule to include rule characters');
  assert.ok(!rule.includes('•'), 'boxRule should not repeat the turn marker');
});

// --- indentContinuation (Claude Code CLI transcript-style hanging indent) --

test('indentContinuation is a no-op when styling is off', async () => {
  const out = await runInChild({
    isTTY: false,
    script: `
      const { indentContinuation } = await import('./terminal-format.js');
      console.log(JSON.stringify(indentContinuation('first\\nsecond\\nthird')));
    `,
  });
  assert.match(out, /"first\\nsecond\\nthird"/);
});

test('indentContinuation indents every line but the first by turnMarker\'s own width', async () => {
  const out = await runInChild({
    isTTY: true,
    script: `
      const { indentContinuation } = await import('./terminal-format.js');
      console.log(JSON.stringify(indentContinuation('first line\\nsecond line\\nthird line')));
    `,
  });
  const [text] = JSON.parse(`[${out.trim()}]`);
  const lines = text.split('\n');
  assert.equal(lines[0], 'first line', 'the first line stays flush - the marker itself occupies that column');
  assert.equal(lines[1], '  second line', 'wrapped/continuation lines indent under where the marker\'s text starts');
  assert.equal(lines[2], '  third line');
});

test('indentContinuation with indentFirstLine indents every line, including the first', async () => {
  const out = await runInChild({
    isTTY: true,
    script: `
      const { indentContinuation } = await import('./terminal-format.js');
      console.log(JSON.stringify(indentContinuation('first line\\nsecond line', { indentFirstLine: true })));
    `,
  });
  const [text] = JSON.parse(`[${out.trim()}]`);
  const lines = text.split('\n');
  assert.equal(lines[0], '  first line', 'a second-or-later streamed piece has no marker of its own to sit flush against');
  assert.equal(lines[1], '  second line');
});

test('indentContinuation leaves blank lines untouched (no trailing whitespace on a separator row)', async () => {
  const out = await runInChild({
    isTTY: true,
    script: `
      const { indentContinuation } = await import('./terminal-format.js');
      console.log(JSON.stringify(indentContinuation('first paragraph\\n\\nsecond paragraph')));
    `,
  });
  const [text] = JSON.parse(`[${out.trim()}]`);
  const lines = text.split('\n');
  assert.equal(lines[1], '', 'a blank separator line between blocks must stay genuinely empty, not padded');
});

test('boxRule reflects a live terminal resize immediately - it recomputes width on every call', async () => {
  const out = await runInChild({
    isTTY: true,
    script: [
      "const { boxRule } = await import('./terminal-format.js');",
      'process.stdout.columns = 40;',
      "console.log('narrow', JSON.stringify(boxRule().replace(/\\x1b\\[[0-9;]*m/g, '').length));",
      'process.stdout.columns = 100;',
      "console.log('midwide', JSON.stringify(boxRule().replace(/\\x1b\\[[0-9;]*m/g, '').length));",
      'process.stdout.columns = 200;', // an ultrawide terminal - no upper cap any more
      "console.log('wide', JSON.stringify(boxRule().replace(/\\x1b\\[[0-9;]*m/g, '').length));",
    ].join('\n'),
  });
  const lines = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
  );
  // Tracks the terminal exactly at every width, with no ceiling.
  assert.equal(Number(lines.narrow), 40);
  assert.equal(Number(lines.midwide), 100);
  assert.equal(Number(lines.wide), 200);
});

test('refreshWidth re-registers marked-terminal so a resize changes where markdown wraps', async () => {
  const out = await runInChild({
    isTTY: true,
    script: [
      "const { renderMarkdown, refreshWidth } = await import('./terminal-format.js');",
      "const longParagraph = new Array(40).fill('word').join(' ');",
      'process.stdout.columns = 40;',
      'refreshWidth();',
      "const narrow = renderMarkdown(longParagraph).replace(/\\x1b\\[[0-9;]*m/g, '');",
      "const narrowLongest = Math.max(...narrow.split('\\n').map((l) => l.length));",
      'process.stdout.columns = 200;', // an ultrawide terminal - no upper cap any more
      'refreshWidth();',
      "const wide = renderMarkdown(longParagraph).replace(/\\x1b\\[[0-9;]*m/g, '');",
      "const wideLongest = Math.max(...wide.split('\\n').map((l) => l.length));",
      // Single string args, not separate console.log(label, number) calls -
      // Node's own console.log colorizes a bare number when it thinks
      // stdout is a TTY (which it does here, since isTTY was faked true for
      // this test harness), embedding ANSI codes this test isn't stripping.
      "console.log(`narrowLongest ${narrowLongest}`);",
      "console.log(`wideLongest ${wideLongest}`);",
    ].join('\n'),
  });
  const lines = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
  );
  const narrowLongest = Number(lines.narrowLongest);
  const wideLongest = Number(lines.wideLongest);
  assert.ok(narrowLongest <= 40, `expected the narrow render to wrap at <=40 cols, got ${narrowLongest}`);
  assert.ok(wideLongest > narrowLongest, `expected the post-resize render to use more width than the narrow one (${wideLongest} vs ${narrowLongest})`);
  // No upper cap any more - the wide render must use noticeably more than
  // the old 120-col ceiling, proving it isn't still capped there.
  assert.ok(wideLongest > 120, `expected the wide render to exceed the old 120-col ceiling, got ${wideLongest}`);
  assert.ok(wideLongest <= 200, `expected the wide render to stay within the 200-col terminal itself, got ${wideLongest}`);
});

// An unbroken long token (a URL, a long identifier) has no whitespace for
// marked-terminal's reflowText to break on - checks whether it's left to
// overflow past the terminal's own width, or hard-wrapped like everything
// else. Confirmed live (see companion/AGENTS.md) that marked-terminal
// already hard-wraps it - this locks that in as a regression test, since a
// future marked/marked-terminal upgrade changing that behavior would be
// exactly the kind of silent breakage this file's own convention (test the
// actual rendered width, not just assume wrapping happened) is meant to
// catch.
test('renderMarkdown hard-wraps an unbroken long token (no whitespace to break on) instead of letting it overflow', async () => {
  const out = await runInChild({
    isTTY: true,
    script: [
      "const { renderMarkdown } = await import('./terminal-format.js');",
      'process.stdout.columns = 100;',
      "const longToken = 'https://example.com/' + 'a'.repeat(200);",
      "console.log(renderMarkdown(`Here is a reference: ${longToken} and more text after it.`));",
    ].join('\n'),
  });
  const stripped = out.replace(/\x1b\[[0-9;]*m/g, '');
  const longestLine = Math.max(...stripped.split('\n').map((l) => l.length));
  assert.ok(
    longestLine <= 100,
    `expected the unbroken token to be hard-wrapped to the terminal's 100-col width, longest line was ${longestLine} chars: ${JSON.stringify(stripped)}`
  );
});

// A *tight* bulleted list (no blank line between items - what an LLM's own
// list output almost always looks like) used to skip reflowText entirely:
// marked-terminal's listitem() only reflow-wraps a *loose* item (blank line
// between bullets), so a tight item's long single-sentence bullet rendered
// as one raw, unwrapped line, relying on the terminal's own hardware
// auto-wrap to break it - mid-word, with no hanging indent - once it hit
// the physical column edge. Confirmed live at a 250+ column tmux width (see
// companion/AGENTS.md and the PR that introduced this test) before this fix
// existed. This compares a tight list's rendering directly against the
// *same* content as a genuinely loose list (which already reflowed
// correctly before this fix) rather than hardcoding marked-terminal's own
// indent amount, so the test stays meaningful even if marked-terminal
// changes its internal list-indent width in a future upgrade.
test('a long single-sentence bullet in a tight list wraps at a word boundary with a hanging indent, same as a loose list', async () => {
  const out = await runInChild({
    isTTY: true,
    script: [
      'process.stdout.columns = 280;', // wide enough that the old bug's single unwrapped line was visibly absurd
      "const { renderMarkdown } = await import('./terminal-format.js');",
      // A realistic long, single-sentence bullet - well past 280 columns
      // unwrapped, with no punctuation-adjacent whitespace near the column
      // boundary a naive fixed-offset split might accidentally land on.
      "const sentence = 'Correctness: your window invariant held throughout the trace I walked through by hand, including the tricky case where a repeated character last recorded index is actually to the left of the current window own left boundary, which is the classic off-by-one trap in this exact family of sliding-window problems.';",
      "const tight = renderMarkdown(`- ${sentence}\\n- Complexity: O(n) time.`).replace(/\\x1b\\[[0-9;]*m/g, '');",
      "const loose = renderMarkdown(`- ${sentence}\\n\\n- Complexity: O(n) time.`).replace(/\\x1b\\[[0-9;]*m/g, '');",
      'console.log(JSON.stringify({ tight, loose, columns: 280 }));',
    ].join('\n'),
  });
  const { tight, loose } = JSON.parse(out.trim());
  const tightLines = tight.split('\n');
  const longest = Math.max(...tightLines.map((l) => l.length));
  // No line - including the list's own tab+bullet-marker indent on top of
  // the reflowed text (LIST_INDENT_OVERHEAD) - may run past the terminal's
  // actual width. A looser bound here previously let a genuine overflow
  // bug through: reflowText wrapped a bullet's raw text to fit, but the
  // list-render indent added on top of that pushed the total past 280
  // anyway, and the terminal's own hardware wrap then split a hyphenated
  // word ("off-by-one") mid-word - confirmed live in a real 260-col tmux
  // pane (see the PR that added this test and companion/AGENTS.md).
  assert.ok(longest <= 280, `expected every rendered line to fit within the 280-col terminal, longest line was ${longest} chars: ${JSON.stringify(tight)}`);
  assert.ok(tightLines.length >= 3, `expected the long bullet to wrap across multiple lines, got: ${JSON.stringify(tight)}`);
  // The fix should make a tight list render byte-for-byte identically to
  // the same content as a loose list - that's the existing, already-correct
  // behavior this test pins the tight-list path to.
  assert.equal(tight, loose, 'expected a tight list to reflow exactly like an equivalent loose list');
  // No mid-word break: every word from the source sentence survives intact
  // somewhere in the wrapped output, rather than being split across two
  // lines at whatever column the raw terminal happened to hard-wrap on.
  for (const word of ['recorded', 'boundary,', 'off-by-one', 'sliding-window', 'problems.']) {
    assert.ok(tight.includes(word), `expected the word "${word}" to survive intact (not split mid-word), got: ${JSON.stringify(tight)}`);
  }
  // Continuation lines (wrapped text that isn't the bullet marker's own
  // first line) are indented under the marker, not flush at column 0 -
  // found generically rather than by a specific word, since exactly where
  // the line wraps shifts with marked-terminal's own indent accounting.
  const continuationLine = tightLines.find((l) => l && !l.trim().startsWith('*'));
  assert.ok(continuationLine, `expected to find a wrapped continuation line, got: ${JSON.stringify(tight)}`);
  assert.ok(/^\s+\S/.test(continuationLine), `expected the continuation line to be indented, got: ${JSON.stringify(continuationLine)}`);
});

test('spinnerFrame cycles through distinct glyphs and stays plain text off a TTY', async () => {
  const out = await runInChild({
    isTTY: false,
    script: `
      const { spinnerFrame, SPINNER_FRAME_COUNT } = await import('./terminal-format.js');
      console.log(SPINNER_FRAME_COUNT);
      console.log(spinnerFrame(0));
      console.log(spinnerFrame(1));
      console.log(JSON.stringify(spinnerFrame(0) === spinnerFrame(SPINNER_FRAME_COUNT)));
    `,
  });
  const lines = out.trim().split('\n');
  const count = Number(lines[0]);
  assert.ok(count > 1, 'expected more than one spinner frame');
  assert.match(lines[1], /thinking/);
  assert.notEqual(lines[1], lines[2]); // frame 0 and frame 1 differ
  assert.match(out, /true/); // frame index wraps around after SPINNER_FRAME_COUNT
  assert.ok(!out.includes(ESC), 'expected no ANSI codes off a TTY');
});

// --- createMarkdownStreamer --------------------------------------------

test('createMarkdownStreamer is a pure chunk pass-through when styling is off', async () => {
  const out = await runInChild({
    isTTY: false,
    script: `
      const { createMarkdownStreamer } = await import('./terminal-format.js');
      const s = createMarkdownStreamer();
      console.log(JSON.stringify(s.push('Hello wor')));
      console.log(JSON.stringify(s.push('ld, this ')));
      console.log(JSON.stringify(s.push('is streamed.')));
      console.log(JSON.stringify(s.finish()));
    `,
  });
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, ['Hello wor', 'ld, this ', 'is streamed.', '']);
});

test('createMarkdownStreamer withholds an open fenced code block until it closes', async () => {
  const out = await runInChild({
    isTTY: true,
    script: `
      const { createMarkdownStreamer } = await import('./terminal-format.js');
      const s = createMarkdownStreamer();
      // A blank line arrives, but it's *inside* the still-open fence - must
      // not be treated as a safe split point (no blank line precedes the
      // fence itself, so nothing is safe to flush at all yet).
      console.log('push1', JSON.stringify(s.push('Here is code:\\n\`\`\`js\\nconst x = 1;\\n\\nconst y = 2;\\n')));
      console.log('push2', JSON.stringify(s.push('\`\`\`\\nAfter the block.')));
    `,
  });
  assert.match(out, /push1 ""/); // nothing complete yet - fence still open
  const push2Line = out.split('\n').find((l) => l.startsWith('push2'));
  assert.ok(!push2Line.includes('""'), 'expected the closed fence to flush once it completes');
  assert.match(push2Line, /const x = 1/);
  assert.match(push2Line, /const y = 2/); // the blank line inside the fence survived, not split on
  assert.ok(!push2Line.includes('After the block'), 'text after the fence has no trailing blank line yet - must stay buffered');
});

test('createMarkdownStreamer flushes a completed block at a blank line, holding the next block back', async () => {
  const out = await runInChild({
    isTTY: true,
    script: `
      const { createMarkdownStreamer } = await import('./terminal-format.js');
      const s = createMarkdownStreamer();
      const first = s.push('First paragraph.\\n\\nSecond paragraph is still ');
      console.log('first', JSON.stringify(first));
      const rest = s.finish();
      console.log('rest', JSON.stringify(rest));
    `,
  });
  const firstLine = out.split('\n').find((l) => l.startsWith('first'));
  const restLine = out.split('\n').find((l) => l.startsWith('rest'));
  assert.match(firstLine, /First paragraph/);
  assert.ok(!firstLine.includes('Second paragraph'), 'the incomplete second block must not flush early');
  assert.match(restLine, /Second paragraph/);
});
