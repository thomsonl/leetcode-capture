// companion/context-budget.js - pure helpers for LocalBackend's context-
// budget management: the pre-flight request-size estimate and the diff-
// based compression of older history turns. Split out from companion.js so
// this logic - deterministic, no I/O, no readline/backend state - can be
// unit-tested directly, the same way terminal-format.js and vault-
// summary.js already are, rather than only reachable through a full
// companion.js subprocess. See companion.js's LocalBackend class comment
// and companion/AGENTS.md for the two live-confirmed failures this exists
// to address.

// Cheap character-based token-count estimate, used only for the pre-flight
// size check in LocalBackend.sendMessage (companion.js) - not a real
// tokenizer, and not meant to be one. Calibrated against the real, locally-
// running gemma4:26b model this project is configured for (not assumed):
// four live /api/chat requests at 30/100/250/500 lines of realistic Python
// code measured 4.28/4.13/4.01/3.93 characters per prompt token
// respectively - converging toward ~3.9 as size grows, matching
// data/companion-context-capacity-test's own finding (in the firstmate
// repo) almost exactly. 3.9 is used here deliberately as the conservative
// (lower) end of that measured range: since estimated tokens = length /
// CHARS_PER_TOKEN_ESTIMATE, a smaller divisor yields a larger (safer, more
// conservative - more likely to trigger the pre-flight refusal) estimate
// for the same character count, and the measured ratio is lowest, i.e.
// closest to 3.9, exactly in the large-capture danger zone this check
// exists to catch - so this estimate is most accurate right where it
// matters most.
export const CHARS_PER_TOKEN_ESTIMATE = 3.9;

export function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN_ESTIMATE);
}

export function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// A simple LCS-based line diff (no external dependency - this project's own
// "no deps" bar, see companion/'s own header comment) used only to compress
// an older history turn's code down to what changed from the attempt before
// it (see compressOldCaptureTurn below) - not meant to be a byte-perfect
// unified diff, just compact enough to show what changed between two
// attempts without resending the full code for both.
export function diffLines(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'same', line: oldLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: oldLines[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', line: newLines[j] });
    j++;
  }
  return ops;
}

// Renders diffLines' ops as a compact +/- diff with 1 line of context
// around each change, collapsing everything else to "..." - a full unified
// diff's hunk headers aren't worth the tokens here, the model just needs to
// see what changed since the attempt before this one.
export function formatDiffSummary(oldCode, newCode) {
  if (oldCode === newCode) return '(code unchanged from the previous attempt)';
  const ops = diffLines((oldCode || '').split('\n'), (newCode || '').split('\n'));
  const CONTEXT = 1;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === 'same') return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) keep[k] = true;
  });
  const out = [];
  let skipping = false;
  let added = 0;
  let removed = 0;
  ops.forEach((op, idx) => {
    if (op.type === 'add') added++;
    if (op.type === 'del') removed++;
    if (!keep[idx]) {
      if (!skipping) {
        out.push('...');
        skipping = true;
      }
      return;
    }
    skipping = false;
    const prefix = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
    out.push(`${prefix} ${op.line}`);
  });
  return `Code changed from the previous attempt (+${added}/-${removed} lines):\n${out.join('\n')}`;
}

// Replaces an older, already-reviewed capture turn's full code with a
// compact diff against the code from the capture immediately before it -
// the tutor only ever needs the *current* turn's code in full; older turns
// exist purely so the conversation has continuity ("what did we already
// discuss"), not so their own full code gets re-reviewed every single
// request. Keeps the turn's original header line (trigger/problem/attempt)
// so the model still knows what this turn was; the trailing
// RUN_ADDENDUM/SUBMIT_ADDENDUM instruction is dropped entirely - it only
// ever told the model how to respond to that turn, which is moot once the
// turn is old. `msg` is one of LocalBackend.history's own user-turn entries
// (`{ content, code, headerLine }`, see companion.js's sendMessage).
export function compressOldCaptureTurn(msg, previousCode) {
  const header = msg.headerLine || '[LeetCode capture]';
  return `${header}\n${formatDiffSummary(previousCode, msg.code)}`;
}

// Builds the actual outgoing messages array for a LocalBackend request: the
// leading system message, the pinned problem description right after it (if
// one is known), then the rest of history with every *older* user turn
// (everything except the one just pushed for this request, which is always
// last) compressed down to a diff against the capture before it, rather
// than resent in full. Pure function of its inputs - LocalBackend.
// buildMessages (companion.js) is a thin wrapper passing its own fields
// through - kept here, not as a class method, specifically so it can be
// unit-tested without constructing a real LocalBackend/network stack.
// `history` is never mutated: this.history remains the true, full record
// throughout, which is what lets the pinned description stay correct
// independent of trimHistory's own pair-splicing.
export function buildMessages({ history, pinnedProblemContext }) {
  const messages = [history[0]]; // the leading system message
  if (pinnedProblemContext?.description) {
    messages.push({
      role: 'system',
      content:
        `Problem currently being discussed: ${pinnedProblemContext.title} ` +
        `(${pinnedProblemContext.slug})\n\n${pinnedProblemContext.description}`,
    });
  }

  const rest = history.slice(1);
  const currentTurnIndex = rest.length - 1; // the just-pushed user turn - always last, always sent in full
  let previousCode = null;
  for (let i = 0; i < rest.length; i++) {
    const msg = rest[i];
    if (msg.role !== 'user' || typeof msg.code !== 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (i === currentTurnIndex || previousCode === null) {
      // The current turn under review, or the earliest capture in this
      // window with no earlier code to diff against yet - both sent in
      // full.
      messages.push({ role: 'user', content: msg.content });
    } else {
      messages.push({ role: 'user', content: compressOldCaptureTurn(msg, previousCode) });
    }
    previousCode = msg.code;
  }
  return messages;
}
