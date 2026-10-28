// Unit tests for sanitize.js. The end-to-end check that no escape byte from a
// panel message or a capture reaches the terminal lives in panel-bridge.test.js
// ("end to end: untrusted text never reaches the terminal as escape sequences").
//
// Run with: node --test sanitize.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripControlChars, oneLine, sanitizeCapture } from './sanitize.js';

const PROBE = 'esc-probe \x1b[31mRED\x1b[0m \x1b]0;pwned-title\x07 end';

test('stripControlChars drops C0 (except newline and tab), DEL and C1, and keeps everything else', () => {
  assert.equal(stripControlChars(PROBE), 'esc-probe [31mRED[0m ]0;pwned-title end');
  assert.equal(stripControlChars('a\x00b\x1bc\x7fd\x85e\x9bf\tg\nh\ri'), 'abcdef\tg\nhi');
  assert.equal(stripControlChars('plain é ✓ 你好'), 'plain é ✓ 你好');
  assert.equal(stripControlChars(null), '');
  assert.equal(stripControlChars(42), '42');
});

test('oneLine also collapses newlines and runs of whitespace', () => {
  assert.equal(oneLine('  Two\n\tSum\x1b[2J  '), 'Two Sum[2J');
  assert.equal(oneLine(undefined), '');
});

test('sanitizeCapture cleans every displayed field and leaves the code alone', () => {
  const code = 'def f():\n\treturn "\\x1b"\n';
  const clean = sanitizeCapture({
    problemTitle: 'Two \x1b[31mSum\x1b[0m',
    problemSlug: 'two-sum',
    trigger: 'run\x1b]0;x\x07',
    language: 'python3\n',
    problemDescription: 'Line 1\nLine\x1b[2J 2',
    problemTags: ['Array\x07', 5, ''],
    attemptSeq: '3; rm -rf',
    code,
  });
  assert.deepEqual(clean, {
    problemTitle: 'Two [31mSum[0m',
    problemSlug: 'two-sum',
    trigger: 'run]0;x',
    language: 'python3',
    problemDescription: 'Line 1\nLine[2J 2',
    problemTags: ['Array'],
    attemptSeq: null,
    code,
  });
  assert.equal(sanitizeCapture({ attemptSeq: 2 }).attemptSeq, 2);
  // A title made only of control characters is as good as missing.
  assert.equal(sanitizeCapture({ problemTitle: '\x1b\x07' }).problemTitle, null);
  assert.deepEqual(sanitizeCapture(null), {});
  assert.deepEqual(sanitizeCapture([1]), {});
});
