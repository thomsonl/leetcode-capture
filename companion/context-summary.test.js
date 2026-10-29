// Unit tests for context-summary.js: condensing the oldest exchanges into one
// bounded "earlier in this session" summary instead of dropping them, with
// the model call, its fallbacks and the plain-drop last resort. The same
// behavior end to end, through a real companion.js, is in
// context-window.test.js.
//
// Run with: node --test context-summary.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMessagesTokens, estimateTokens } from './context-budget.js';
import {
  SUMMARY_HEADER,
  SUMMARY_MAX_TOKENS,
  SUMMARIZER_SYSTEM,
  buildSummaryRequest,
  condense,
  countPairs,
  digestSummary,
  firstSentence,
  fitWithSummary,
  summaryBodyChars,
} from './context-summary.js';

const SYSTEM = { role: 'system', content: 'S'.repeat(390) }; // 100 estimated tokens
const pair = (n, chars) => [
  { role: 'user', content: `Question ${n} about my loop. More detail ${n}.` },
  { role: 'assistant', content: `Answer ${n} says check the bounds. ${'x'.repeat(chars)}` },
];
const history = (count, chars, current = 'now') => {
  const h = [SYSTEM];
  for (let i = 1; i <= count; i += 1) h.push(...pair(i, chars));
  h.push({ role: 'user', content: current });
  return h;
};
const summaryOf = (messages) => messages.find((m) => m.role === 'system' && m.content.startsWith(SUMMARY_HEADER));

test('countPairs counts the whole exchanges before the current message', () => {
  assert.equal(countPairs(history(0, 1)), 0);
  assert.equal(countPairs(history(3, 1)), 3);
});

test('firstSentence skips code, diff lines and the companion framing', () => {
  assert.equal(firstSentence('Why is it slow? I tried a set.'), 'Why is it slow?');
  assert.equal(
    firstSentence("Code changed:\n```python\nx = 1\n```\n\nThe student's message:\nIs this right? Thanks."),
    'Is this right?'
  );
  assert.equal(firstSentence('+ 3 | x = 2\n- | y\n...\nno punctuation here'), 'no punctuation here');
});

test('digestSummary keeps one capped line per exchange and stays within maxChars', () => {
  const dropped = [
    { student: 'First question here. Ignored.', tutor: 'First hint here. Ignored too.' },
    { student: 'Second question here.', tutor: 'Second hint.' },
  ];
  const text = digestSummary({ dropped, maxChars: 1000 });
  assert.equal(
    text,
    '- Student: First question here. Tutor: First hint here.\n- Student: Second question here. Tutor: Second hint.'
  );
  const many = Array.from({ length: 40 }, (_, i) => ({ student: `Question ${i}.`, tutor: `Hint ${i}. ${'y'.repeat(300)}` }));
  const capped = digestSummary({ existing: 'Earlier: tried brute force.', dropped: many, maxChars: 500 });
  assert.ok(capped.length <= 500, `${capped.length}`);
  assert.match(capped, /Question 39/, 'the newest exchanges are kept');
});

test('buildSummaryRequest carries the instruction, the earlier summary and only the dropped exchanges', () => {
  const [system, user] = buildSummaryRequest({ existing: 'OLD SUMMARY', dropped: [{ student: 'Q1', tutor: 'A1' }] });
  assert.equal(system.content, SUMMARIZER_SYSTEM);
  assert.match(user.content, /under 250 words, keeping what the student tried, mistakes found, and hints already given/);
  assert.match(user.content, /OLD SUMMARY/);
  assert.match(user.content, /Student: Q1\n\nTutor: A1/);
});

test('condense uses the model reply, clamped, and falls back to the digest on failure, empty, timeout or no fit', async () => {
  const dropped = [{ student: 'Why is it slow? Details.', tutor: 'Use a hash map. More.' }];
  const digest = '- Student: Why is it slow? Tutor: Use a hash map.';
  assert.deepEqual(await condense({ dropped, maxChars: 500, summarize: async () => '  The model summary.  ' }), {
    summary: 'The model summary.',
    source: 'model',
  });
  const long = await condense({ dropped, maxChars: 100, summarize: async () => 'word '.repeat(100) });
  assert.ok(long.summary.length <= 100 && long.source === 'model');
  for (const summarize of [
    async () => {
      throw new Error('500');
    },
    async () => '   ',
    async () => null,
  ]) {
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(await condense({ dropped, maxChars: 500, summarize }), { summary: digest, source: 'digest' });
  }
  let aborted = false;
  const hung = await condense({
    dropped,
    maxChars: 500,
    timeoutMs: 50,
    summarize: (messages, signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => (aborted = true));
      }),
  });
  assert.deepEqual(hung, { summary: digest, source: 'digest' });
  assert.ok(aborted, 'a timed-out call is aborted');
  let called = false;
  const tooBig = await condense({
    dropped,
    maxChars: 500,
    fits: () => false,
    summarize: async () => {
      called = true;
      return 'x';
    },
  });
  assert.equal(called, false, 'a summary call that would not fit is never made');
  assert.equal(tooBig.source, 'digest');
});

test('fitWithSummary leaves a fitting request alone and makes no call', async () => {
  const h = history(2, 100);
  let calls = 0;
  const fit = await fitWithSummary({ history: h, budget: 10000, summarize: async () => (calls += 1, 'x') });
  assert.equal(fit.fits, true);
  assert.equal(fit.droppedPairs, 0);
  assert.equal(fit.summary, null);
  assert.equal(calls, 0);
  assert.deepEqual(fit.history, h);
});

test('fitWithSummary condenses the older exchanges into one summary placed after the pins', async () => {
  const h = history(4, 1950); // each exchange about 510 tokens
  const pinnedProblemContext = { problemId: 'p', title: 'T', slug: 't', description: 'D'.repeat(390) };
  const pinnedCode = { text: 'C'.repeat(390) };
  const seen = [];
  const fit = await fitWithSummary({
    history: h,
    pinnedProblemContext,
    pinnedCode,
    // The previous request (three exchanges) fit; this one, with four, does not.
    budget: 2000,
    summarize: async (messages) => {
      seen.push(messages);
      return 'Student asked about Question 1 and Question 2; tutor said check the bounds.';
    },
  });
  assert.equal(fit.fits, true);
  assert.equal(fit.summarized, 'model');
  assert.ok(fit.droppedPairs >= 2, 'at least the older half goes');
  assert.ok(fit.estimatedTokens <= 2000);
  assert.equal(seen.length, 1);
  assert.match(seen[0][1].content, /Question 1/);
  assert.ok(!seen[0][1].content.includes('C'.repeat(50)), 'the pinned code is never summarized');
  assert.ok(!seen[0][1].content.includes('D'.repeat(50)), 'the pinned problem is never summarized');
  const roles = fit.messages.map((m) => (m.role === 'system' ? m.content.slice(0, 12) : m.role));
  const summaryIndex = fit.messages.indexOf(summaryOf(fit.messages));
  assert.equal(summaryIndex, 3, `system, problem, code, then the summary: ${roles}`);
  assert.equal(fit.messages[fit.messages.length - 1].content, 'now');
  assert.equal(h.length, 10, 'the input is not mutated');
});

test('repeated overflows merge into the existing summary and it stays under its cap', async () => {
  let h = history(0, 0);
  let summary = null;
  const cap = summaryBodyChars(SUMMARY_MAX_TOKENS);
  for (let turn = 1; turn <= 30; turn += 1) {
    h = [...h.slice(0, -1), ...pair(turn, 1950), { role: 'user', content: `now ${turn}` }];
    // eslint-disable-next-line no-await-in-loop
    const fit = await fitWithSummary({
      history: h,
      summary,
      budget: 1800,
      // A model that ignores the word limit: the cap still holds.
      summarize: async (messages) => `${messages[1].content.length} ${'merged fact '.repeat(400)}`,
    });
    assert.equal(fit.fits, true, `turn ${turn}`);
    h = fit.history;
    summary = fit.summary;
    if (summary) assert.ok(summary.length <= cap, `turn ${turn}: ${summary.length} > ${cap}`);
    if (summary) assert.ok(estimateTokens(summary) <= SUMMARY_MAX_TOKENS);
  }
  assert.ok(summary, 'a summary was made');
});

test('the earlier summary is handed to the next summary call so facts carry forward', async () => {
  const seen = [];
  const fit = await fitWithSummary({
    history: history(4, 1950),
    summary: 'OLDEST FACT: the student first tried brute force.',
    budget: 1500,
    summarize: async (messages) => {
      seen.push(messages[1].content);
      return 'merged';
    },
  });
  assert.equal(fit.summary, 'merged');
  assert.match(seen[0], /OLDEST FACT/);
});

test('the digest stands in when the model call fails, and the exchange-count cap condenses too', async () => {
  const fit = await fitWithSummary({
    history: history(3, 10),
    budget: 100000,
    maxPairs: 1,
    summarize: async () => {
      throw new Error('down');
    },
  });
  assert.equal(fit.summarized, 'digest');
  assert.equal(fit.droppedPairs, 2);
  assert.equal(
    fit.summary,
    '- Student: Question 1 about my loop. Tutor: Answer 1 says check the bounds.\n' +
      '- Student: Question 2 about my loop. Tutor: Answer 2 says check the bounds.'
  );
});

test('with no room for even a small summary the oldest are dropped as before; pins too big still refuse', async () => {
  const h = history(2, 1950, 'M'.repeat(390 * 8)); // the current message alone is about 800 tokens
  const fit = await fitWithSummary({ history: h, summary: 'old', budget: 920, summarize: async () => 'never fits' });
  assert.equal(fit.fits, true);
  assert.equal(fit.summary, null);
  assert.equal(fit.summarized, null);
  assert.ok(!summaryOf(fit.messages));
  assert.ok(estimateMessagesTokens(fit.messages) <= 920);

  const refused = await fitWithSummary({ history: h, budget: 500, summarize: async () => 'x' });
  assert.equal(refused.fits, false);
  assert.deepEqual(refused.parts, { systemPrompt: 100, problem: 0, code: 0, message: 800 });
});
