// Regression tests for mouse-input.js's SGR mouse-report filtering.
//
// Run with: node --test mouse-input.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMouseFilter, decodeWheelDirection } from './mouse-input.js';

function collectOutput() {
  const chunks = [];
  const output = new PassThrough();
  output.on('data', (c) => chunks.push(c));
  return { output, text: () => Buffer.concat(chunks).toString('binary') };
}

test('decodeWheelDirection identifies wheel-up/down and ignores ordinary buttons', () => {
  assert.equal(decodeWheelDirection(64), 'up');
  assert.equal(decodeWheelDirection(65), 'down');
  // modifier bits (shift=4, meta=8, ctrl=16) added on top must not change
  // the wheel direction decision.
  assert.equal(decodeWheelDirection(64 + 4), 'up');
  assert.equal(decodeWheelDirection(65 + 4 + 16), 'down');
  // ordinary left/middle/right click or release codes are not wheel events.
  assert.equal(decodeWheelDirection(0), null);
  assert.equal(decodeWheelDirection(1), null);
  assert.equal(decodeWheelDirection(2), null);
});

test('plain typed text passes through unchanged, byte for byte', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  filter.push('hello');
  filter.push(' world\r');
  assert.equal(text(), 'hello world\r');
  assert.deepEqual(events, []);
});

test('a wheel-up SGR report fires onWheel and is not forwarded to output', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  filter.push('\x1b[<64;10;5M');
  assert.deepEqual(events, ['up']);
  assert.equal(text(), '');
});

test('a wheel-down SGR report fires onWheel and is not forwarded', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  filter.push('\x1b[<65;10;5M');
  assert.deepEqual(events, ['down']);
  assert.equal(text(), '');
});

test('a non-wheel SGR mouse report (plain click) is swallowed too, no onWheel fired', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  filter.push('\x1b[<0;10;5M'); // left button press
  filter.push('\x1b[<0;10;5m'); // release
  assert.deepEqual(events, []);
  assert.equal(text(), '');
});

test('text surrounding a mouse report is preserved, only the report itself is removed', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  filter.push('before\x1b[<64;10;5Mafter');
  assert.deepEqual(events, ['up']);
  assert.equal(text(), 'beforeafter');
});

test('an unrelated escape sequence (arrow key) passes through untouched', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  filter.push('\x1b[A'); // up arrow
  assert.deepEqual(events, []);
  assert.equal(text(), '\x1b[A');
});

test('a lone Escape keypress with nothing after it eventually passes through', async () => {
  const { output, text } = collectOutput();
  const filter = createMouseFilter({ output, onWheel: () => {} });
  filter.push('\x1b');
  // Nothing forwarded yet - could still be the start of a mouse report.
  assert.equal(text(), '');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(text(), '\x1b');
});

test('a mouse report split across two push() calls is still detected', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  filter.push('\x1b[<64;1');
  assert.deepEqual(events, []); // not resolved yet
  filter.push('0;5M');
  assert.deepEqual(events, ['up']);
  assert.equal(text(), '');
});

test('garbage that looks like the start of a mouse report but never resolves is eventually let through', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  // Well past MAX_PENDING with no M/m terminator.
  filter.push('\x1b[<' + '9'.repeat(40));
  assert.deepEqual(events, []);
  assert.equal(text(), '\x1b[<' + '9'.repeat(40));
});

test('multiple wheel reports in one chunk are all detected in order', () => {
  const { output, text } = collectOutput();
  const events = [];
  const filter = createMouseFilter({ output, onWheel: (d) => events.push(d) });
  filter.push('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M');
  assert.deepEqual(events, ['up', 'up', 'down']);
  assert.equal(text(), '');
});

test('multi-byte UTF-8 text split across chunk boundaries round-trips intact', () => {
  const { output, text } = collectOutput();
  const filter = createMouseFilter({ output, onWheel: () => {} });
  const bytes = Buffer.from('héllo 日本語', 'utf8');
  // Split mid-character deliberately.
  filter.push(bytes.subarray(0, 3));
  filter.push(bytes.subarray(3));
  assert.equal(Buffer.from(text(), 'binary').toString('utf8'), 'héllo 日本語');
});
