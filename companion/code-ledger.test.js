// Unit tests for code-ledger.js: what the tutor holds, what it is sent next,
// and the reset on a problem switch. companion.test.js covers the same rules
// end to end through a real companion.js subprocess.
//
// Run with: node --test code-ledger.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodeLedger,
  sendsToTutor,
  formatCodeUpdate,
  formatPinnedCode,
  buildSubmitMessage,
  buildChatMessage,
  FULL_CODE_COMPACT_NOTE,
  DEFAULT_MAX_PROBLEMS,
} from '../extension/shared/code-ledger.js';

const V1 = [
  'def twoSum(nums, target):',
  '    seen = {}',
  '    for i, val in enumerate(nums):',
  '        complement = target - val',
  '        if complement in seen:',
  '            return [seen[complement], i]',
  '        seen[val] = i',
  '    return []',
  '',
  // Long enough that a two-line change is a real saving over the full code.
  ...Array.from({ length: 30 }, (_, i) => `# a note about the approach, line ${i}`),
].join('\n');
const V2 = V1.replace('    return []', '    return [-1, -1]');
const V3 = V2.replace('        seen[val] = i', '        seen[val] = i  # remember it');

test('only a Submit is sent to the tutor on its own', () => {
  assert.equal(sendsToTutor('submit'), true);
  assert.equal(sendsToTutor('run'), false);
  assert.equal(sendsToTutor('hack'), false);
  assert.equal(sendsToTutor(undefined), false);
});

test('nothing known means nothing to send; the first code goes in full', () => {
  const ledger = createCodeLedger();
  ledger.activate('two-sum', { slug: 'two-sum' });
  assert.deepEqual(ledger.planUpdate('two-sum'), { kind: 'none' });
  ledger.record('two-sum', { code: V1, language: 'Python3' });
  const plan = ledger.planUpdate('two-sum');
  assert.equal(plan.kind, 'full');
  assert.equal(plan.code, V1);
  assert.match(formatCodeUpdate(plan), /^The student's current code \(Python3\), in full:\n\n```python\n/);
});

test('held code only advances on commit, and unchanged code is reported as such', () => {
  const ledger = createCodeLedger();
  ledger.activate('two-sum');
  ledger.record('two-sum', { code: V1, language: 'Python3' });
  assert.equal(ledger.planUpdate('two-sum').kind, 'full');
  // A failed call commits nothing: the next plan is still the full code.
  assert.equal(ledger.planUpdate('two-sum').kind, 'full');
  assert.equal(ledger.held('two-sum'), null);
  ledger.commit('two-sum', { code: V1, language: 'Python3' });
  assert.equal(ledger.planUpdate('two-sum').kind, 'unchanged');
});

test('three recorded versions then one plan: only the diff from the held code to the newest', () => {
  const ledger = createCodeLedger();
  ledger.activate('two-sum');
  ledger.commit('two-sum', { code: V1, language: 'Python3' });
  ledger.record('two-sum', { code: V2, language: 'Python3' });
  ledger.record('two-sum', { code: V1, language: 'Python3' });
  ledger.record('two-sum', { code: V3, language: 'Python3' });
  const plan = ledger.planUpdate('two-sum');
  assert.equal(plan.kind, 'diff');
  assert.equal(plan.added, 2);
  assert.equal(plan.removed, 2);
  const text = formatCodeUpdate(plan);
  assert.match(text, /^Changes to the student's code since the version you last saw \(Python3, \+2\/-2 lines; the line numbers are those of the current code\):/);
  // Line numbers are the new code's, removed lines carry none, and a couple
  // of unchanged lines around each change give the tutor its place.
  const lines = text.split('\n');
  assert.ok(lines.includes('-    |         seen[val] = i'), text);
  assert.ok(lines.includes('+  7 |         seen[val] = i  # remember it'), text);
  assert.ok(lines.includes('+  8 |     return [-1, -1]'), text);
  assert.ok(lines.includes('   6 |             return [seen[complement], i]'), text);
  assert.ok(!text.includes('def twoSum'), 'lines far from the change are left out');
  assert.match(text, /^\.\.\.$/m);
});

test('a plan for the live editor code can differ from the newest recorded code', () => {
  const ledger = createCodeLedger();
  ledger.activate('two-sum');
  ledger.commit('two-sum', { code: V1, language: 'Python3' });
  ledger.record('two-sum', { code: V2, language: 'Python3' });
  assert.equal(ledger.planUpdate('two-sum', { code: V1, language: 'Python3' }).kind, 'unchanged');
});

test('a diff almost as long as the code falls back to the full code', () => {
  const ledger = createCodeLedger();
  ledger.activate('p');
  const oldCode = Array.from({ length: 20 }, (_, i) => `a${i} = ${i}`).join('\n');
  const newCode = Array.from({ length: 20 }, (_, i) => `b${i} = ${i * 2}`).join('\n');
  ledger.commit('p', { code: oldCode, language: 'Python3' });
  ledger.record('p', { code: newCode, language: 'Python3' });
  const plan = ledger.planUpdate('p');
  assert.equal(plan.kind, 'full');
  assert.equal(plan.code, newCode);
});

test('a language switch sends the full code', () => {
  const ledger = createCodeLedger();
  ledger.activate('p');
  ledger.commit('p', { code: V1, language: 'Python3' });
  ledger.record('p', { code: V2, language: 'Java' });
  assert.equal(ledger.planUpdate('p').kind, 'full');
});

test('a very long rewrite skips the diff table and sends the full code', () => {
  const ledger = createCodeLedger();
  ledger.activate('p');
  const oldCode = Array.from({ length: 2500 }, (_, i) => `x${i}`).join('\n');
  const newCode = Array.from({ length: 2500 }, (_, i) => `y${i}`).join('\n');
  ledger.commit('p', { code: oldCode });
  ledger.record('p', { code: newCode });
  assert.equal(ledger.planUpdate('p').kind, 'full');
});

test('switching problems resets: the old problem is dropped and no code counts as held', () => {
  const ledger = createCodeLedger();
  assert.deepEqual(ledger.activate('two-sum', { slug: 'two-sum' }), {
    switched: false,
    reset: false,
    previousId: null,
    dropped: null,
  });
  ledger.record('two-sum', { code: V1, context: { title: 'Two Sum', slug: 'two-sum', description: 'D1' } });
  ledger.commit('two-sum', { code: V1 });
  assert.deepEqual(ledger.activate('two-sum', { slug: 'two-sum' }).reset, false, 'the same problem is no switch');

  const result = ledger.activate('house-robber', { slug: 'house-robber' });
  assert.deepEqual(result, {
    switched: true,
    reset: true,
    previousId: 'two-sum',
    dropped: { problemId: 'two-sum', slug: 'two-sum' },
  });
  assert.equal(ledger.has('two-sum'), false);
  assert.equal(ledger.activeProblemId, 'house-robber');

  // Coming back starts from nothing: the full code goes again.
  ledger.activate('two-sum', { slug: 'two-sum' });
  assert.equal(ledger.context('two-sum'), null);
  ledger.record('two-sum', { code: V2 });
  assert.equal(ledger.planUpdate('two-sum').kind, 'full');
});

test('with resets off a switch keeps every problem and what the tutor holds', () => {
  const ledger = createCodeLedger();
  ledger.activate('a');
  ledger.commit('a', { code: V1 });
  const result = ledger.activate('b', { resetOnSwitch: false });
  assert.equal(result.switched, true);
  assert.equal(result.reset, false);
  assert.equal(result.dropped, null);
  assert.deepEqual(ledger.held('a'), { code: V1, language: null });
});

test('remembered problems are capped, never evicting the active one', () => {
  const ledger = createCodeLedger();
  ledger.activate('keep', { resetOnSwitch: false });
  for (let i = 0; i < DEFAULT_MAX_PROBLEMS + 10; i += 1) ledger.record(`p${i}`, { code: 'x' });
  assert.equal(ledger.size, DEFAULT_MAX_PROBLEMS);
  assert.ok(ledger.has('keep'));
  assert.ok(ledger.has(`p${DEFAULT_MAX_PROBLEMS + 9}`));
  assert.ok(!ledger.has('p0'));
});

test('a later source without a description keeps the known one', () => {
  const ledger = createCodeLedger();
  ledger.record('p', { code: 'a', context: { title: 'P', slug: 'p', description: 'the statement' } });
  ledger.record('p', { code: 'b', context: { title: 'P', slug: 'p', description: null } });
  assert.equal(ledger.context('p').description, 'the statement');
  assert.deepEqual(ledger.latest('p'), { code: 'b', language: null });
});

test('forgetHeld empties every baseline', () => {
  const ledger = createCodeLedger();
  ledger.commit('a', { code: V1 });
  ledger.forgetHeld();
  assert.equal(ledger.held('a'), null);
});

test('a Submit message: header, code update, instruction; its compact form drops the full code', () => {
  const full = buildSubmitMessage({
    headerLine: '[LeetCode capture] Submit - Two Sum (two-sum)',
    plan: { kind: 'full', code: V1, language: 'Python3' },
    addendum: '\n\nGIVE THE BREAKDOWN',
  });
  assert.match(full.text, /^\[LeetCode capture\] Submit - Two Sum \(two-sum\)\n\nThe student's current code/);
  assert.ok(full.text.endsWith('GIVE THE BREAKDOWN'));
  assert.equal(full.compactText, `[LeetCode capture] Submit - Two Sum (two-sum)\n\n${FULL_CODE_COMPACT_NOTE}`);

  const ledger = createCodeLedger();
  ledger.commit('p', { code: V1 });
  ledger.record('p', { code: V2 });
  const diff = buildSubmitMessage({ headerLine: 'H', plan: ledger.planUpdate('p'), addendum: '\n\nX' });
  assert.match(diff.text, /^H\n\nChanges to the student's code/);
  assert.ok(!diff.compactText.includes('X'), 'the instruction is dropped from an older turn');
  assert.match(diff.compactText, /```diff/);
});

test('a chat message goes as typed when nothing changed, and leads with the code update when it did', () => {
  assert.deepEqual(buildChatMessage({ text: 'hi' }), { text: 'hi', compactText: 'hi' });
  assert.deepEqual(buildChatMessage({ text: 'hi', plan: { kind: 'unchanged', code: 'x' } }), {
    text: 'hi',
    compactText: 'hi',
  });
  const withCode = buildChatMessage({ text: 'why?', plan: { kind: 'full', code: 'x = 1', language: 'Python3' }, preamble: 'PRE' });
  assert.equal(withCode.text, "PRE\n\nThe student's current code (Python3), in full:\n\n```python\nx = 1\n```\n\nThe student's message:\nwhy?");
  assert.equal(withCode.compactText, `PRE\n\n${FULL_CODE_COMPACT_NOTE}\n\nThe student's message:\nwhy?`);
  assert.equal(buildChatMessage({ text: 'q', preamble: 'PRE' }).text, 'PRE\n\nq');
});

test('the pinned code names the version later changes apply to', () => {
  assert.equal(formatPinnedCode(null), null);
  const pinned = formatPinnedCode({ code: 'x = 1', language: 'Python3' });
  assert.match(pinned, /^The student's current code \(Python3\), exactly as it is now/);
  assert.match(pinned, /```python\nx = 1\n```$/);
});

test('every request carries the current code: diff applied, stale after a failed read, and a swap keeps the chat', async () => {
  const { currentCodeFor, prepareChatTurn } = await import('../extension/shared/code-ledger.js');
  const { LocalBackend } = await import('../extension/shared/local-backend.js');
  const { transferConversation } = await import('../extension/shared/conversation.js');
  const ledger = createCodeLedger();
  ledger.activate('p');
  const body = Array.from({ length: 20 }, (_, i) => `x${i} = ${i}`).join('\n');
  ledger.record('p', { code: `a = 1\n${body}`, language: 'python3', context: { problemId: 'p', title: 'P', slug: 'p', description: 'STATEMENT' } });
  ledger.commit('p', { code: `a = 1\n${body}`, language: 'python3' });
  ledger.record('p', { code: `a = 2\n${body}`, language: 'python3' });
  const turn = prepareChatTurn(ledger, { text: 'q', problemId: 'p' });
  assert.equal(turn.plan.kind, 'diff');
  assert.equal(turn.currentCode.code, `a = 2\n${body}`, 'the pin is the code after the diff');
  assert.match(formatPinnedCode(turn.currentCode), /a = 2/);
  const failed = prepareChatTurn(ledger, { text: 'q', problemId: 'p', codeUnavailable: true, preamble: () => null });
  assert.deepEqual(failed.currentCode, { code: `a = 1\n${body}`, language: 'python3', stale: true }, 'a failed read keeps the last code seen');
  assert.match(formatPinnedCode(failed.currentCode), /could not be read[\s\S]*a = 1/);
  assert.equal(formatPinnedCode(currentCodeFor({ kind: 'full', code: 'x', language: null }, null)), null, 'a full message is not pinned twice');

  // A swap moves the exchanges, the summary and the statement.
  const probe = async () => null;
  const a = new LocalBackend({ baseUrl: 'http://127.0.0.1:9', model: 'a', probe, numCtx: 8192 });
  a.history.push({ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' });
  a.summary = 'SUMMARY';
  a.pinnedProblemContext = { problemId: 'p', title: 'P', slug: 'p', description: 'STATEMENT' };
  const b = new LocalBackend({ baseUrl: 'http://127.0.0.1:9', model: 'b', probe, numCtx: 8192 });
  assert.equal(transferConversation(a, b), true);
  b.pinnedCode = { text: formatPinnedCode(turn.currentCode) };
  const sent = JSON.stringify(b.buildMessages());
  for (const part of ['first', 'reply', 'SUMMARY', 'STATEMENT', 'a = 2']) assert.ok(sent.includes(part), part);
});
