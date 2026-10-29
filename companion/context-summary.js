// companion/context-summary.js - condenses the oldest exchanges of a tutor
// conversation into one short "earlier in this session" summary instead of
// dropping them, like Claude Code's /compact.
//
// LocalBackend (companion.js) fits every request to the model's prompt
// budget, and CodexBackend (codex-backend.js) keeps a bounded number of
// exchanges. Both used to drop the oldest whole exchanges outright, so the
// tutor forgot what the student had already tried and which hints it had
// given. Now those exchanges are folded into one summary (at most
// SUMMARY_MAX_TOKENS by the companion's own estimate), sent as a system
// message after the pinned problem and code and before the live history
// (context-budget.js's buildMessages). A later overflow merges the newly
// dropped exchanges into it, so it stays bounded. The pinned problem, the
// pinned code and the current message are never summarized.
//
// The summary comes from one model call on the same backend (a short
// instruction plus only the exchanges being dropped, which already fit
// before). When that call fails, times out, returns nothing or would not fit
// the window itself, a deterministic digest is used instead: one line per
// dropped exchange from the student's first sentence and the tutor's first
// sentence. When not even a summary fits, the oldest exchanges are dropped
// as before. None of this prints anything: a fixable overflow is silent.
//
// Pure apart from the injected `summarize` call: no Node API, no I/O, so it
// is unit-tested directly (context-summary.test.js) and could run in the
// browser extension.

import {
  CHARS_PER_TOKEN_ESTIMATE,
  SUMMARY_HEADER,
  buildMessages,
  estimateMessagesTokens,
  estimateTokens,
  fitToBudget,
  summaryContent,
} from './context-budget.js';

export { SUMMARY_HEADER, summaryContent };

// The summary's own size cap, by the companion's estimate.
export const SUMMARY_MAX_TOKENS = 300;
// Below this much room a summary is not worth keeping: plain dropping wins.
export const SUMMARY_MIN_TOKENS = 60;
// How long the summary call may take before the digest is used instead.
export const SUMMARY_TIMEOUT_MS = 60_000;
// One digest line's cap, in characters, for each side of an exchange.
const DIGEST_STUDENT_CHARS = 120;
const DIGEST_TUTOR_CHARS = 160;

// Marks the summary call's own system message, so a log or a test stub can
// tell it apart from a tutor turn.
export const SUMMARIZER_SYSTEM =
  'You condense the earlier part of a programming tutoring session into a short summary for the tutor to keep. ' +
  'Write plain sentences or short bullet lines, no headings, and never use the em dash.';

// The most characters a summary body may have so the whole summary message
// stays within `tokens` by the estimate.
export function summaryBodyChars(tokens) {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN_ESTIMATE) - SUMMARY_HEADER.length - 1);
}

// Whole exchanges at the start of `history` ([system, (user, assistant)*,
// current]): how many there are.
export function countPairs(history) {
  let pairs = 0;
  for (let i = 1; i + 2 < history.length && history[i]?.role === 'user' && history[i + 1]?.role === 'assistant'; i += 2) {
    pairs += 1;
  }
  return pairs;
}

function withoutPairs(history, k) {
  return [history[0], ...history.slice(1 + 2 * k)];
}

// What a dropped exchange looked like on the wire: an older user turn whose
// code is pinned goes as its compact form, the same rule as buildMessages.
function renderedPairs(history, k, pinnedCode) {
  const out = [];
  for (let i = 0; i < k; i += 1) {
    const user = history[1 + 2 * i];
    const assistant = history[2 + 2 * i];
    const compact = Boolean(pinnedCode) && typeof user.compactContent === 'string';
    out.push({ student: compact ? user.compactContent : user.content, tutor: assistant.content });
  }
  return out;
}

// Cuts `text` to at most `max` characters at a word boundary.
export function clampText(text, max) {
  const clean = String(text || '').trim();
  if (clean.length <= max) return clean;
  if (max <= 3) return '';
  const cut = clean.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

// The first sentence of a turn, without fenced code, diff lines or the
// companion's own framing, collapsed to one line.
export function firstSentence(text) {
  let body = String(text || '');
  const marker = body.lastIndexOf("The student's message:\n");
  if (marker !== -1) body = body.slice(marker + "The student's message:\n".length);
  body = body.replace(/```[\s\S]*?(```|$)/g, ' ');
  body = body
    .split('\n')
    .filter((line) => !/^\s*[+-]\s*\d*\s*\|/.test(line) && !/^\s*\.\.\.\s*$/.test(line))
    .join(' ');
  body = body.replace(/\s+/g, ' ').trim();
  const match = body.match(/^(.+?[.!?])(\s|$)/);
  return match ? match[1] : body;
}

// The deterministic fallback: the earlier summary (cut to make room) plus
// one line per dropped exchange, newest kept when it is all too long.
export function digestSummary({ existing = null, dropped, maxChars }) {
  const lines = dropped.map(
    ({ student, tutor }) =>
      `- Student: ${clampText(firstSentence(student), DIGEST_STUDENT_CHARS) || '(code only)'} ` +
      `Tutor: ${clampText(firstSentence(tutor), DIGEST_TUTOR_CHARS) || '(no text)'}`
  );
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  let text = clampText(lines.join('\n'), maxChars);
  if (existing) {
    const room = maxChars - text.length - 1;
    if (room >= 40) text = `${clampText(existing, room)}\n${text}`;
  }
  return text;
}

// The summary call's messages: the instruction, the earlier summary if any,
// and only the exchanges being dropped.
export function buildSummaryRequest({ existing = null, dropped }) {
  const exchanges = dropped.map(({ student, tutor }) => `Student: ${student}\n\nTutor: ${tutor}`).join('\n\n---\n\n');
  const content =
    'Summarize these earlier exchanges in under 250 words, keeping what the student tried, mistakes found, and ' +
    'hints already given. ' +
    (existing ? 'Merge in the earlier summary below so one summary covers everything. ' : '') +
    'Reply with the summary only.\n\n' +
    (existing ? `Earlier summary:\n${existing}\n\n` : '') +
    `Exchanges:\n\n${exchanges}`;
  return [
    { role: 'system', content: SUMMARIZER_SYSTEM },
    { role: 'user', content },
  ];
}

function withTimeout(promiseFactory, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('the summary call timed out'));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => promiseFactory(controller?.signal)), timeout]).finally(() =>
    clearTimeout(timer)
  );
}

// Produces the merged summary of `dropped` (and `existing`), at most
// `maxChars`. Tries `summarize(messages, signal)` once when given and when
// `fits(messages)` says the call itself fits; otherwise, or when it throws,
// times out or returns nothing, uses the digest. Returns { summary, source }
// with source 'model' or 'digest'. Never throws.
export async function condense({ existing = null, dropped, maxChars, summarize = null, fits = () => true, timeoutMs = SUMMARY_TIMEOUT_MS }) {
  if (summarize) {
    const messages = buildSummaryRequest({ existing, dropped });
    if (fits(messages)) {
      try {
        const reply = await withTimeout((signal) => summarize(messages, signal), timeoutMs);
        const text = clampText(typeof reply === 'string' ? reply : '', maxChars);
        if (text) return { summary: text, source: 'model' };
      } catch {
        // the digest below
      }
    }
  }
  return { summary: digestSummary({ existing, dropped, maxChars }), source: 'digest' };
}

// How many of `pairs` exchanges to condense once some must go: at least
// `needed`, and at least the older half, so the summary call is not paid
// again on the very next message.
export function condenseCount(pairs, needed) {
  return Math.min(pairs, Math.max(needed, Math.ceil(pairs / 2)));
}

// Fits one LocalBackend request to `budget`, condensing instead of dropping.
// `history` is [system, (user, assistant)*, current]; `summary` the current
// summary or null; `maxPairs` the exchange-count cap (0 for none) and
// `forcePairs` exchanges that must go regardless (after a reply cut off for
// room). Returns { history, summary, messages, estimatedTokens, fits,
// droppedPairs, summarized ('model' | 'digest' | null), parts? } in the
// shape of fitToBudget. Never mutates `history`.
export async function fitWithSummary({
  history,
  pinnedProblemContext = null,
  pinnedCode = null,
  summary = null,
  budget,
  maxPairs = 0,
  forcePairs = 0,
  summarize = null,
  timeoutMs = SUMMARY_TIMEOUT_MS,
}) {
  const build = (h, s) => buildMessages({ history: h, pinnedProblemContext, pinnedCode, summary: s });
  const pairs = countPairs(history);
  const countExcess = maxPairs > 0 ? Math.max(0, pairs - maxPairs) : 0;
  const mustDrop = Math.min(pairs, Math.max(countExcess, forcePairs));
  const asIs = build(history, summary);
  const asIsTokens = estimateMessagesTokens(asIs);
  if (mustDrop === 0 && asIsTokens <= budget) {
    return { history, summary, messages: asIs, estimatedTokens: asIsTokens, fits: true, droppedPairs: 0, summarized: null };
  }

  // The fewest exchanges to condense so the rest plus a full-size summary
  // fit; failing that, all of them with whatever room is left.
  const reserve = estimateTokens(summaryContent('x'.repeat(summaryBodyChars(SUMMARY_MAX_TOKENS))));
  let needed = null;
  for (let k = Math.max(mustDrop, 1); k <= pairs; k += 1) {
    if (estimateMessagesTokens(build(withoutPairs(history, k), null)) + reserve <= budget) {
      needed = k;
      break;
    }
  }
  let k;
  let maxChars;
  if (needed !== null) {
    k = condenseCount(pairs, needed);
    maxChars = summaryBodyChars(SUMMARY_MAX_TOKENS);
  } else {
    k = pairs;
    const room = budget - estimateMessagesTokens(build(withoutPairs(history, pairs), null));
    maxChars = summaryBodyChars(Math.min(SUMMARY_MAX_TOKENS, room));
  }

  if ((k > 0 || summary) && maxChars >= summaryBodyChars(SUMMARY_MIN_TOKENS)) {
    const kept = withoutPairs(history, k);
    const dropped = renderedPairs(history, k, pinnedCode);
    const condensed = await condense({
      existing: summary,
      dropped,
      maxChars,
      summarize,
      fits: (messages) => estimateMessagesTokens(messages) <= budget,
      timeoutMs,
    });
    const messages = build(kept, condensed.summary);
    const estimatedTokens = estimateMessagesTokens(messages);
    if (estimatedTokens <= budget) {
      return {
        history: kept,
        summary: condensed.summary,
        messages,
        estimatedTokens,
        fits: true,
        droppedPairs: k,
        summarized: condensed.source,
      };
    }
  }

  // No room for any summary: drop the oldest exchanges as before (and the
  // summary with them), or refuse when the pins and this message alone are
  // over the budget.
  const plain = fitToBudget({ history: withoutPairs(history, mustDrop), pinnedProblemContext, pinnedCode, budget });
  return { ...plain, droppedPairs: plain.droppedPairs + mustDrop, summary: null, summarized: null };
}
