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
      const { renderMarkdown, dim, roleLabel, promptString } = await import('./terminal-format.js');
      console.log(renderMarkdown('**bold** text\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`'));
      console.log(dim('companion: status'));
      console.log(JSON.stringify(roleLabel('tutor')));
      console.log(JSON.stringify(promptString()));
    `,
  });
  assert.ok(!out.includes(ESC), `expected no ANSI escape codes, got: ${JSON.stringify(out)}`);
  assert.match(out, /\*\*bold\*\* text/); // raw markdown syntax untouched
  assert.match(out, /```js/);
  assert.match(out, /companion: status/);
  assert.match(out, /""/); // roleLabel returns '' when styling is off
  assert.match(out, /"> "/); // promptString falls back to the plain '> '
});

test('styling renders markdown and colors when stdout is a TTY', async () => {
  const out = await runInChild({
    isTTY: true,
    script: `
      const { renderMarkdown, dim, roleLabel, promptString } = await import('./terminal-format.js');
      console.log(renderMarkdown('# Header\\n\\n**bold** text\\n\\nHere:\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`'));
      console.log(dim('companion: status'));
      console.log(roleLabel('tutor'));
      console.log(promptString());
    `,
  });
  assert.ok(out.includes(ESC), 'expected ANSI escape codes when styling is on');
  // The fenced code block is set off from prose (marked-terminal indents
  // code blocks), and none of the raw markdown syntax markers survive
  // verbatim in the rendered header/bold text.
  assert.ok(!out.includes('**bold**'), 'bold markers should have been rendered, not left literal');
  assert.match(out, /bold/); // the word itself still present, just styled
  assert.match(out, /const/);
  assert.match(out, /tutor/);
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
