// Unit tests for context-budget.js's pure helpers - the pre-flight token
// estimate and the diff-based compression of older LocalBackend history
// turns. Direct/fast, unlike companion.test.js's subprocess-level coverage
// of the same features end to end (the pre-flight refusal, the pinned
// description surviving trimHistory, and the compression's effect on a
// real request) - see companion.test.js for those.
//
// Run with: node --test context-budget.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateTokens,
  estimateMessagesTokens,
  diffLines,
  formatDiffSummary,
  compressOldCaptureTurn,
  buildMessages,
} from './context-budget.js';

test('estimateTokens divides length by the calibrated chars-per-token constant, rounding up', () => {
  assert.equal(estimateTokens('a'.repeat(39)), Math.ceil(39 / CHARS_PER_TOKEN_ESTIMATE));
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateMessagesTokens sums each message content\'s own estimate', () => {
  const messages = [{ content: 'a'.repeat(39) }, { content: 'b'.repeat(78) }];
  assert.equal(
    estimateMessagesTokens(messages),
    estimateTokens('a'.repeat(39)) + estimateTokens('b'.repeat(78))
  );
});

test('diffLines finds no changes for identical input', () => {
  const lines = ['def f():', '    return 1'];
  const ops = diffLines(lines, lines);
  assert.ok(ops.every((op) => op.type === 'same'));
  assert.equal(ops.length, lines.length);
});

test('diffLines detects a single changed line as a del+add pair, not a full rewrite', () => {
  const oldLines = ['def f(x):', '    return x + 1', '    # end'];
  const newLines = ['def f(x):', '    return x + 2', '    # end'];
  const ops = diffLines(oldLines, newLines);
  assert.equal(ops.filter((op) => op.type === 'same').length, 2, 'the two unchanged lines should stay "same"');
  assert.deepEqual(
    ops.filter((op) => op.type !== 'same').map((op) => op.type),
    ['del', 'add']
  );
});

test('diffLines handles pure insertion and pure deletion', () => {
  const insertOps = diffLines(['a', 'b'], ['a', 'x', 'b']);
  assert.deepEqual(insertOps.map((op) => op.type), ['same', 'add', 'same']);
  const deleteOps = diffLines(['a', 'x', 'b'], ['a', 'b']);
  assert.deepEqual(deleteOps.map((op) => op.type), ['same', 'del', 'same']);
});

test('formatDiffSummary reports "unchanged" for identical code without running a diff', () => {
  const code = 'def f():\n    return 1\n';
  assert.equal(formatDiffSummary(code, code), '(code unchanged from the previous attempt)');
});

test('formatDiffSummary reports a compact +/- summary with a changed-line count for real changes', () => {
  const oldCode = 'def f(x):\n    return x + 1\n';
  const newCode = 'def f(x):\n    return x + 2\n';
  const summary = formatDiffSummary(oldCode, newCode);
  assert.match(summary, /\+1\/-1 lines/);
  assert.match(summary, /^Code changed from the previous attempt/);
  assert.match(summary, /^- {5}return x \+ 1$/m);
  assert.match(summary, /^\+ {5}return x \+ 2$/m);
});

test('formatDiffSummary collapses long unchanged runs to "..." rather than reprinting them', () => {
  const commonLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const oldCode = commonLines.join('\n');
  const newLines = [...commonLines];
  newLines[25] = 'a genuinely different line';
  const summary = formatDiffSummary(oldCode, newLines.join('\n'));
  assert.ok(summary.includes('...'), 'unrelated unchanged lines far from the change should be collapsed');
  // Only a small amount of context around the real change should survive,
  // not all 50 unchanged lines.
  const keptLines = summary.split('\n').filter((l) => l.startsWith('line '));
  assert.ok(keptLines.length <= 4, `expected only a couple of context lines to survive, got ${keptLines.length}`);
});

test('compressOldCaptureTurn keeps the original header line and drops the addendum/full code', () => {
  const msg = {
    headerLine: '[LeetCode capture] Run - Two Sum (two-sum)',
    code: 'def twoSum(nums, target):\n    return []\n',
    content: 'irrelevant - compressOldCaptureTurn never reads this field',
  };
  const compressed = compressOldCaptureTurn(msg, 'def twoSum(nums, target):\n    pass\n');
  assert.match(compressed, /^\[LeetCode capture\] Run - Two Sum \(two-sum\)\n/);
  assert.ok(!compressed.includes('This was a'), 'the RUN/SUBMIT addendum should not survive compression');
  assert.match(compressed, /Code changed from the previous attempt/);
});

test('compressOldCaptureTurn falls back to a generic header when none is recorded', () => {
  const compressed = compressOldCaptureTurn({ code: 'x = 1\n' }, 'x = 0\n');
  assert.match(compressed, /^\[LeetCode capture\]\n/);
});

// --- buildMessages -----------------------------------------------------

function userTurn(content, code, headerLine = '[LeetCode capture] Run - Two Sum (two-sum)') {
  return { role: 'user', content, code, headerLine };
}

test('buildMessages with no pinned description and a single turn sends system + that turn in full', () => {
  const history = [{ role: 'system', content: 'SYS' }, userTurn('full text v1', 'code v1')];
  const messages = buildMessages({ history, pinnedProblemContext: null });
  assert.deepEqual(messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'full text v1' }]);
});

test('buildMessages inserts the pinned description as its own system message right after the leading system prompt', () => {
  const history = [{ role: 'system', content: 'SYS' }, userTurn('full text v1', 'code v1')];
  const pinnedProblemContext = { problemId: 'two-sum', title: 'Two Sum', slug: 'two-sum', description: 'Add two numbers.' };
  const messages = buildMessages({ history, pinnedProblemContext });
  assert.equal(messages[0].content, 'SYS');
  assert.equal(messages[1].role, 'system');
  assert.match(messages[1].content, /Problem currently being discussed: Two Sum \(two-sum\)/);
  assert.match(messages[1].content, /Add two numbers\./);
  assert.equal(messages[2].content, 'full text v1');
});

test('buildMessages omits the pinned-description message entirely when no description is known', () => {
  const history = [{ role: 'system', content: 'SYS' }, userTurn('full text v1', 'code v1')];
  const messages = buildMessages({ history, pinnedProblemContext: { problemId: 'x', description: null } });
  assert.equal(messages.length, 2);
  assert.ok(messages.every((m) => !m.content.includes('Problem currently being discussed')));
});

test('buildMessages sends the first capture turn in full (nothing earlier to diff against)', () => {
  const history = [
    { role: 'system', content: 'SYS' },
    userTurn('full text v1', 'code v1'),
    { role: 'assistant', content: 'reply 1' },
    userTurn('full text v2', 'code v2'),
  ];
  const messages = buildMessages({ history, pinnedProblemContext: null });
  // system, turn1 (full, first ever), assistant1, turn2 (full, current)
  assert.equal(messages.length, 4);
  assert.equal(messages[1].content, 'full text v1');
  assert.equal(messages[3].content, 'full text v2');
});

test('buildMessages compresses an older turn (neither the first nor the current) to a diff', () => {
  const history = [
    { role: 'system', content: 'SYS' },
    userTurn('full text v1', 'code v1'),
    { role: 'assistant', content: 'reply 1' },
    userTurn('full text v2', 'code v2'),
    { role: 'assistant', content: 'reply 2' },
    userTurn('full text v3', 'code v3'),
  ];
  const messages = buildMessages({ history, pinnedProblemContext: null });
  // system, turn1 (full - first ever), assistant1, turn2 (COMPRESSED -
  // neither first nor current), assistant2, turn3 (full - current).
  assert.equal(messages.length, 6);
  assert.equal(messages[1].content, 'full text v1');
  assert.notEqual(messages[3].content, 'full text v2');
  assert.match(messages[3].content, /Code changed from the previous attempt/);
  assert.equal(messages[5].content, 'full text v3');
});

test('buildMessages leaves typed chat turns (no code field) untouched, never compressed', () => {
  const history = [
    { role: 'system', content: 'SYS' },
    userTurn('full text v1', 'code v1'),
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'a typed follow-up question', code: null },
    { role: 'assistant', content: 'reply 2' },
    userTurn('full text v3', 'code v3'),
  ];
  const messages = buildMessages({ history, pinnedProblemContext: null });
  assert.equal(messages[3].content, 'a typed follow-up question');
});

test('buildMessages never mutates the history array it was given', () => {
  const history = [
    { role: 'system', content: 'SYS' },
    userTurn('full text v1', 'code v1'),
    { role: 'assistant', content: 'reply 1' },
    userTurn('full text v2', 'code v2'),
    { role: 'assistant', content: 'reply 2' },
    userTurn('full text v3', 'code v3'),
  ];
  const before = JSON.parse(JSON.stringify(history));
  buildMessages({ history, pinnedProblemContext: null });
  assert.deepEqual(history, before);
});
