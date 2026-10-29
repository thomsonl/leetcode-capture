// companion/context-budget.js - pure helpers for LocalBackend's context-
// budget management: the pre-flight request-size estimate, the line diff
// the tutor's code updates are built from (see code-ledger.js), and the
// outgoing message list with the pinned description and code. Split out
// from companion.js so this logic - deterministic, no I/O, no readline or
// backend state - can be unit-tested directly, the same way
// terminal-format.js and vault-summary.js already are, rather than only
// reachable through a full companion.js subprocess. It uses no Node API, so
// it can also run inside the browser extension. See companion.js's
// LocalBackend class comment and the top-level AGENTS.md for the
// live-confirmed failures this exists to address.

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
// "no deps" bar, see companion/'s own header comment). The common leading
// and trailing lines are matched up front, so the quadratic LCS table only
// covers the region that actually changed: a one-line edit in a 300-line
// solution costs a tiny table, not a 300 by 300 one. Not meant to be a
// byte-perfect unified diff, just a correct and compact list of operations.
// `maxCells` bounds that table: past it this returns null instead of
// allocating it (a rewrite of a very long file), and the caller sends the
// whole code instead.
export function diffLines(oldLines, newLines, { maxCells = Infinity } = {}) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const n = oldMid.length;
  const m = newMid.length;
  if ((n + 1) * (m + 1) > maxCells) return null;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldMid[i] === newMid[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  for (let k = 0; k < prefix; k++) ops.push({ type: 'same', line: oldLines[k] });
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      ops.push({ type: 'same', line: oldMid[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', line: oldMid[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: newMid[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: oldMid[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', line: newMid[j] });
    j++;
  }
  for (let k = oldLines.length - suffix; k < oldLines.length; k++) ops.push({ type: 'same', line: oldLines[k] });
  return ops;
}

// Renders diffLines' ops as +/- lines with `context` unchanged lines around
// each change, collapsing everything else to "...". With `lineNumbers`, every
// unchanged or added line also carries its line number in the NEW code (a
// removed line has none, it no longer exists there), so a reader holding the
// old code can place each change without a unified diff's hunk headers.
// Returns the rendered lines plus the added/removed counts, or null when
// diffLines gave up (see its `maxCells`).
export function formatDiffBody(oldCode, newCode, { context = 1, lineNumbers = false, maxCells } = {}) {
  const ops = diffLines((oldCode || '').split('\n'), (newCode || '').split('\n'), { maxCells });
  if (!ops) return null;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });
  const newLineCount = ops.filter((op) => op.type !== 'del').length;
  const width = String(Math.max(1, newLineCount)).length;
  const out = [];
  let skipping = false;
  let added = 0;
  let removed = 0;
  let newLineNo = 0;
  ops.forEach((op, idx) => {
    if (op.type !== 'del') newLineNo++;
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
    if (lineNumbers) {
      const number = op.type === 'del' ? ''.padStart(width) : String(newLineNo).padStart(width);
      out.push(`${prefix} ${number} | ${op.line}`);
    } else {
      out.push(`${prefix} ${op.line}`);
    }
  });
  return { body: out.join('\n'), added, removed };
}

// The compact +/- summary with 1 line of context, under a one-line header -
// a full unified diff's hunk headers aren't worth the tokens here, the model
// just needs to see what changed between two attempts.
export function formatDiffSummary(oldCode, newCode) {
  if (oldCode === newCode) return '(code unchanged from the previous attempt)';
  const { body, added, removed } = formatDiffBody(oldCode, newCode);
  return `Code changed from the previous attempt (+${added}/-${removed} lines):\n${body}`;
}

// Builds the actual outgoing messages array for a LocalBackend request: the
// leading system message, the pinned problem description right after it (if
// one is known), then the pinned code (the latest version of the student's
// code the tutor has been shown, which any code change in the current turn
// applies to), then the rest of history. An older user turn that carried the
// full code is sent as its `compactContent` instead, since that code (or a
// newer version of it) is already pinned (only while code is pinned, so the
// compact note never points at nothing); the turn just pushed for this
// request is always last and always sent in full.
//
// Pinning is what lets history trimming (LocalBackend.trimHistory) drop the
// turn that originally carried the full code without the tutor losing it:
// later turns only carry diffs against it. Pure function of its inputs -
// LocalBackend.buildMessages (companion.js) is a thin wrapper passing its
// own fields through - so it can be unit-tested without a real backend.
// `history` is never mutated.
export function buildMessages({ history, pinnedProblemContext, pinnedCode = null }) {
  const messages = [history[0]]; // the leading system message
  if (pinnedProblemContext?.description) {
    messages.push({
      role: 'system',
      content:
        `Problem currently being discussed: ${pinnedProblemContext.title} ` +
        `(${pinnedProblemContext.slug})\n\n${pinnedProblemContext.description}`,
    });
  }
  if (pinnedCode && typeof pinnedCode.text === 'string') {
    messages.push({ role: 'system', content: pinnedCode.text });
  }

  const rest = history.slice(1);
  const currentTurnIndex = rest.length - 1;
  for (let i = 0; i < rest.length; i++) {
    const msg = rest[i];
    const compact =
      Boolean(pinnedCode) && msg.role === 'user' && i !== currentTurnIndex && typeof msg.compactContent === 'string';
    messages.push({ role: msg.role, content: compact ? msg.compactContent : msg.content });
  }
  return messages;
}

// The context window LocalBackend budgets against: the smallest of what is
// configured (COMPANION_LOCAL_NUM_CTX, or a settings field later), what the
// server reported when probed (local-server.js), and what a reply showed
// the server really kept (LocalBackend's silent-truncation guard). Any of
// the last two may be missing. Returns the window and where it came from,
// so messages can say which one is in charge. The one place the window is
// decided, so a new source (a settings field) only needs a new argument.
export function resolveContextWindow({ configured, detected = null, observed = null }) {
  let best = { tokens: configured, source: 'configured' };
  if (detected && detected.tokens > 0 && detected.tokens < best.tokens) {
    best = { tokens: detected.tokens, source: 'detected', from: detected.source };
  }
  if (observed && observed > 0 && observed < best.tokens) best = { tokens: observed, source: 'observed' };
  return best;
}

// Fits one request to the prompt budget: `history` is
// [system, user, assistant, ..., user] with the current message last. While
// the request is over budget, the oldest whole user+assistant exchange is
// dropped (never half of one, never the pinned statement or code, never the
// current message). Returns the history to keep, the messages to send and
// their estimate, how many exchanges went, and whether it fits. When even
// the pinned parts plus the current message are over, `parts` gives each
// one's estimate so the refusal can say what is too big. Pure: `history`
// is never mutated.
export function fitToBudget({ history, pinnedProblemContext = null, pinnedCode = null, budget }) {
  let kept = history;
  let droppedPairs = 0;
  let messages = buildMessages({ history: kept, pinnedProblemContext, pinnedCode });
  let estimatedTokens = estimateMessagesTokens(messages);
  // kept is [system, (user, assistant)*, current]: an exchange is left to
  // drop while there are at least four entries.
  while (estimatedTokens > budget && kept.length >= 4 && kept[1].role === 'user' && kept[2].role === 'assistant') {
    kept = [kept[0], ...kept.slice(3)];
    droppedPairs += 1;
    messages = buildMessages({ history: kept, pinnedProblemContext, pinnedCode });
    estimatedTokens = estimateMessagesTokens(messages);
  }
  const fits = estimatedTokens <= budget;
  const result = { history: kept, messages, estimatedTokens, droppedPairs, fits };
  if (!fits) {
    const current = kept[kept.length - 1];
    const problemTokens = pinnedProblemContext?.description ? estimateTokens(messages[1].content) : 0;
    result.parts = {
      systemPrompt: estimateTokens(kept[0].content),
      problem: problemTokens,
      code: pinnedCode && typeof pinnedCode.text === 'string' ? estimateTokens(pinnedCode.text) : 0,
      message: estimateTokens(current.content),
    };
  }
  return result;
}
