// Unit tests for context-budget.js's pure helpers - the pre-flight token
// estimate, the line diff, and the outgoing LocalBackend message list with
// its pinned description and code. Direct/fast, unlike companion.test.js's
// subprocess-level coverage of the same features end to end (the pre-flight
// refusal, the pinned description and code surviving the count cap) - see
// companion.test.js for those.
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
  formatDiffBody,
  buildMessages,
  fitToBudget,
  resolveContextWindow,
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

test('diffLines matches the common head and tail first, and gives up past maxCells', () => {
  const head = Array.from({ length: 500 }, (_, i) => `head ${i}`);
  const tail = Array.from({ length: 500 }, (_, i) => `tail ${i}`);
  // Only the one middle line differs, so a tiny table is enough even with a
  // limit far below 1000 by 1000.
  const ops = diffLines([...head, 'old', ...tail], [...head, 'new', ...tail], { maxCells: 16 });
  assert.equal(ops.length, 1002);
  assert.deepEqual(
    ops.filter((op) => op.type !== 'same'),
    [
      { type: 'del', line: 'old' },
      { type: 'add', line: 'new' },
    ]
  );
  assert.equal(diffLines(['a', 'b', 'c'], ['x', 'y', 'z'], { maxCells: 4 }), null);
  assert.equal(formatDiffBody('a\nb\nc', 'x\ny\nz', { maxCells: 4 }), null);
});

test('formatDiffBody numbers unchanged and added lines by the new code, and shows the context asked for', () => {
  const oldCode = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
  const newCode = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'].join('\n');
  const { body, added, removed } = formatDiffBody(oldCode, newCode, { context: 1, lineNumbers: true });
  assert.equal(added, 2);
  assert.equal(removed, 1);
  assert.deepEqual(body.split('\n'), ['...', '  3 | c', '-   | d', '+ 4 | D', '  5 | e', '...', '  7 | g', '+ 8 | h']);
});

// --- buildMessages -----------------------------------------------------

function userTurn(content, compactContent) {
  return { role: 'user', content, compactContent };
}

const PINNED = { text: 'PINNED CODE v2' };

test('buildMessages with no pinned description and a single turn sends system + that turn in full', () => {
  const history = [{ role: 'system', content: 'SYS' }, userTurn('full text v1', 'compact v1')];
  const messages = buildMessages({ history, pinnedProblemContext: null });
  assert.deepEqual(messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'full text v1' }]);
});

test('buildMessages inserts the pinned description as its own system message right after the leading system prompt', () => {
  const history = [{ role: 'system', content: 'SYS' }, userTurn('full text v1', 'compact v1')];
  const pinnedProblemContext = { problemId: 'two-sum', title: 'Two Sum', slug: 'two-sum', description: 'Add two numbers.' };
  const messages = buildMessages({ history, pinnedProblemContext });
  assert.equal(messages[0].content, 'SYS');
  assert.equal(messages[1].role, 'system');
  assert.match(messages[1].content, /Problem currently being discussed: Two Sum \(two-sum\)/);
  assert.match(messages[1].content, /Add two numbers\./);
  assert.equal(messages[2].content, 'full text v1');
});

test('buildMessages omits the pinned-description message entirely when no description is known', () => {
  const history = [{ role: 'system', content: 'SYS' }, userTurn('full text v1', 'compact v1')];
  const messages = buildMessages({ history, pinnedProblemContext: { problemId: 'x', description: null } });
  assert.equal(messages.length, 2);
  assert.ok(messages.every((m) => !m.content.includes('Problem currently being discussed')));
});

test('buildMessages pins the held code after the description, and sends older turns compact', () => {
  const history = [
    { role: 'system', content: 'SYS' },
    userTurn('full code v1', 'compact v1'),
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'a typed question' },
    { role: 'assistant', content: 'reply 2' },
    userTurn('diff v1 to v2', 'compact diff'),
  ];
  const pinnedProblemContext = { title: 'Two Sum', slug: 'two-sum', description: 'D' };
  const messages = buildMessages({ history, pinnedProblemContext, pinnedCode: PINNED });
  assert.deepEqual(
    messages.map((m) => m.content),
    ['SYS', 'Problem currently being discussed: Two Sum (two-sum)\n\nD', 'PINNED CODE v2', 'compact v1', 'reply 1', 'a typed question', 'reply 2', 'diff v1 to v2']
  );
  assert.equal(messages[2].role, 'system');
});

test('buildMessages keeps older turns in full while no code is pinned', () => {
  const history = [
    { role: 'system', content: 'SYS' },
    userTurn('full code v1', 'compact v1'),
    { role: 'assistant', content: 'reply 1' },
    userTurn('question', 'question'),
  ];
  const messages = buildMessages({ history, pinnedProblemContext: null, pinnedCode: null });
  assert.equal(messages[1].content, 'full code v1');
});

test('buildMessages never mutates the history array it was given', () => {
  const history = [
    { role: 'system', content: 'SYS' },
    userTurn('full text v1', 'compact v1'),
    { role: 'assistant', content: 'reply 1' },
    userTurn('full text v2', 'compact v2'),
  ];
  const before = JSON.parse(JSON.stringify(history));
  buildMessages({ history, pinnedProblemContext: null, pinnedCode: PINNED });
  assert.deepEqual(history, before);
});

// --- fitToBudget / resolveContextWindow ------------------------------------

const SYSTEM = { role: 'system', content: 'S'.repeat(390) }; // 100 estimated tokens
const pair = (n, chars) => [
  { role: 'user', content: `question ${n}` },
  { role: 'assistant', content: `answer ${n} ${'x'.repeat(chars)}` },
];

test('fitToBudget keeps everything when the request already fits', () => {
  const history = [SYSTEM, ...pair(1, 100), { role: 'user', content: 'now' }];
  const fit = fitToBudget({ history, budget: 10000 });
  assert.equal(fit.fits, true);
  assert.equal(fit.droppedPairs, 0);
  assert.deepEqual(fit.history, history);
  assert.equal(fit.estimatedTokens, estimateMessagesTokens(fit.messages));
});

test('fitToBudget drops the oldest whole exchanges first, keeping the pins and the current message', () => {
  const history = [SYSTEM, ...pair(1, 1950), ...pair(2, 1950), ...pair(3, 1950), { role: 'user', content: 'now' }];
  const pinnedProblemContext = { problemId: 'p', title: 'T', slug: 't', description: 'D'.repeat(390) };
  const pinnedCode = { text: 'C'.repeat(390) };
  // Pins and system about 310 tokens, each exchange about 505: room for one.
  const fit = fitToBudget({ history, pinnedProblemContext, pinnedCode, budget: 900 });
  assert.equal(fit.fits, true);
  assert.equal(fit.droppedPairs, 2);
  assert.deepEqual(
    fit.history.map((m) => m.content.slice(0, 10)),
    [SYSTEM.content.slice(0, 10), 'question 3', 'answer 3 x', 'now']
  );
  assert.ok(fit.messages.some((m) => m.content === pinnedProblemContext.description || m.content.includes('DDDD')));
  assert.ok(fit.messages.some((m) => m.content === pinnedCode.text));
  assert.ok(fit.estimatedTokens <= 900);
  assert.equal(history.length, 8, 'the input is not mutated');
});

test('fitToBudget refuses only when the pins plus the current message are over, and says how big each is', () => {
  const history = [SYSTEM, ...pair(1, 100), { role: 'user', content: 'M'.repeat(3900) }];
  const fit = fitToBudget({ history, pinnedCode: { text: 'C'.repeat(780) }, budget: 500 });
  assert.equal(fit.fits, false);
  assert.equal(fit.droppedPairs, 1, 'every droppable exchange was tried first');
  assert.deepEqual(fit.parts, { systemPrompt: 100, problem: 0, code: 200, message: 1000 });
});

test('resolveContextWindow takes the smallest known window and names its source', () => {
  assert.deepEqual(resolveContextWindow({ configured: 8192 }), { tokens: 8192, source: 'configured' });
  assert.deepEqual(resolveContextWindow({ configured: 8192, detected: { tokens: 32768, source: 'x' } }), {
    tokens: 8192,
    source: 'configured',
  });
  assert.deepEqual(resolveContextWindow({ configured: 8192, detected: { tokens: 4096, source: 'llama.cpp /props' } }), {
    tokens: 4096,
    source: 'detected',
    from: 'llama.cpp /props',
  });
  assert.deepEqual(
    resolveContextWindow({ configured: 8192, detected: { tokens: 4096, source: 'x' }, observed: 3000 }),
    { tokens: 3000, source: 'observed' }
  );
});
