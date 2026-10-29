// Unit tests for sanitize.js. The end-to-end check that no escape byte from a
// panel message or a capture reaches the terminal lives in panel-bridge.test.js
// ("end to end: untrusted text never reaches the terminal as escape sequences").
//
// Run with: node --test sanitize.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripControlChars, oneLine, sanitizeCapture } from '../extension/shared/sanitize.js';

const PROBE = 'esc-probe \x1b[31mRED\x1b[0m \x1b]0;pwned-title\x07 end';

test('stripControlChars drops C0 (except newline and tab), DEL and C1, and keeps everything else', () => {
  assert.equal(stripControlChars(PROBE), 'esc-probe [31mRED[0m ]0;pwned-title end');
  assert.equal(stripControlChars('a\x00b\x1bc\x7fd\x85e\x9bf\tg\nh\ri'), 'abcdef\tg\nhi');
  assert.equal(stripControlChars('plain é ✓ 你好'), 'plain é ✓ 你好');
  assert.equal(stripControlChars(null), '');
  assert.equal(stripControlChars(42), '42');
});

// The "Trojan Source" characters: text that reads one way on screen and is
// another. U+202E (right-to-left override) makes "txt.exe" display as
// "exe.txt"; a zero-width space hides inside a word.
const BIDI_AND_ZERO_WIDTH = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200b\u200e\u200f\u061c\u2060\ufeff';

test('stripControlChars drops bidi controls and zero-width characters, and keeps emoji joiners', () => {
  assert.equal(stripControlChars(`a${BIDI_AND_ZERO_WIDTH}b`), 'ab');
  assert.equal(stripControlChars('safe\u202eexe.txt'), 'safeexe.txt');
  assert.equal(stripControlChars('pass\u200bword'), 'password');
  // Line and paragraph separators mean a newline, so they become one.
  assert.equal(stripControlChars('one\u2028two\u2029three'), 'one\ntwo\nthree');
  // ZWJ emoji sequences and ZWNJ in Persian survive byte for byte.
  for (const kept of ['👨‍👩‍👧‍👦', '🧑🏽‍💻', '🏳️‍🌈', 'می\u200cخواهم', 'עברית and العربية']) {
    assert.equal(stripControlChars(kept), kept);
  }
});

test('oneLine also collapses newlines and runs of whitespace', () => {
  assert.equal(oneLine('  Two\n\tSum\x1b[2J  '), 'Two Sum[2J');
  assert.equal(oneLine(undefined), '');
  assert.equal(oneLine('Two\u2028Sum\u202e'), 'Two Sum');
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
