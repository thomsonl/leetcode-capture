// extension/shared/code-ledger.js - what code the tutor has already been shown, and
// what to tell it next.
//
// The rules (Thomson's request):
//   - A Run (the button or Ctrl+') is never sent to the tutor on its own. It
//     is only recorded, as the newest code for its problem.
//   - A Submit is sent automatically, but only when its code differs from
//     what the tutor already holds.
//   - A typed message carries the code only when it changed since the tutor
//     last saw it, and then as a diff against that version, not the whole
//     code again. The first time (or after a reset) the tutor holds nothing,
//     so the full code goes once; a diff that would be nearly as long as the
//     code itself is replaced by the full code too.
//   - The active problem is whichever one the student last sent a message,
//     Run or Submit from. Activity on a different problem resets the tutor:
//     the old problem's entry here is dropped and no problem's code counts
//     as held any more, because the tutor's context is wiped with it.
//
// "Held" code (the baseline every diff is against) only advances through
// commit(), which the caller makes once the backend call succeeded, so a
// failed call never makes the ledger believe the tutor saw code it did not.
//
// Pure JavaScript with no Node API (no fs, http, process or Buffer), so the
// same module can later run inside the browser extension. All I/O stays in
// companion.js.

import { formatDiffBody } from './context-budget.js';

// A backstop on remembered problems: a reset already drops the old problem,
// so this only bounds the case where resets are turned off.
export const DEFAULT_MAX_PROBLEMS = 20;
// A diff longer than this share of the code it describes saves too little to
// be worth the model applying it; the full code goes instead.
export const FULL_CODE_RATIO = 0.8;
// Unchanged lines shown around each change, so the tutor can place it.
export const DIFF_CONTEXT_LINES = 2;
// Upper bound on the diff's table for the changed region (see diffLines'
// maxCells): about 2,000 by 2,000 changed lines. Past it the full code goes.
export const MAX_DIFF_CELLS = 4_000_000;

// What every stateless request labels the pinned current code with (see
// formatPinnedCode).
export const CURRENT_CODE_LABEL = "The student's current code";

// Shown to the model in place of an older turn's full code, since every
// request pins the current code (see context-budget.js's buildMessages).
export const FULL_CODE_COMPACT_NOTE =
  `(The student's full code was shown here. Their current code is pinned at the top of the conversation as "${CURRENT_CODE_LABEL}".)`;

// Only a Submit is sent to the tutor by itself. Anything else, a Run or an
// unknown trigger (the relay's /capture route accepts posts from any page),
// is only recorded.
export function sendsToTutor(trigger) {
  return trigger === 'submit';
}

export function languageFenceHint(language) {
  const known = {
    python: 'python',
    python3: 'python',
    javascript: 'javascript',
    typescript: 'typescript',
    java: 'java',
    'c++': 'cpp',
    cpp: 'cpp',
    c: 'c',
    'c#': 'csharp',
    go: 'go',
    golang: 'go',
    rust: 'rust',
    kotlin: 'kotlin',
    swift: 'swift',
    ruby: 'ruby',
    scala: 'scala',
    php: 'php',
  };
  return known[String(language).toLowerCase()] || '';
}

function fenced(code, language) {
  return `\`\`\`${languageFenceHint(language)}\n${code}\n\`\`\``;
}

function languageName(language) {
  return language || 'unknown language';
}

export function createCodeLedger({ maxProblems = DEFAULT_MAX_PROBLEMS } = {}) {
  // problemId -> { slug, context, latest, held }, least recently used first.
  //   context: { title, slug, description } from the newest capture or snapshot
  //   latest:  { code, language } the newest code seen from any source
  //   held:    { code, language } what the tutor has been shown, or null
  const problems = new Map();
  let activeId = null;

  function touch(problemId) {
    let entry = problems.get(problemId);
    if (entry) problems.delete(problemId);
    else entry = { slug: null, context: null, latest: null, held: null };
    problems.set(problemId, entry);
    for (const id of problems.keys()) {
      if (problems.size <= maxProblems) break;
      if (id !== problemId && id !== activeId) problems.delete(id);
    }
    return entry;
  }

  return {
    get activeProblemId() {
      return activeId;
    },

    // Makes problemId the active problem. When another problem was active and
    // resetOnSwitch is on, that problem is dropped and no code counts as held
    // any more: the caller wipes the tutor's context to match. `dropped`
    // names the old problem (and its slug, when it had one) so the caller can
    // clear what else it keeps about it.
    activate(problemId, { slug = null, resetOnSwitch = true } = {}) {
      if (!problemId) return { switched: false, reset: false, previousId: activeId, dropped: null };
      const previousId = activeId;
      const switched = previousId !== null && previousId !== problemId;
      let dropped = null;
      activeId = problemId;
      if (switched && resetOnSwitch) {
        const old = problems.get(previousId);
        problems.delete(previousId);
        dropped = { problemId: previousId, slug: old ? old.slug : null };
        for (const entry of problems.values()) entry.held = null;
      }
      const entry = touch(problemId);
      if (slug) entry.slug = slug;
      return { switched, reset: switched && resetOnSwitch, previousId, dropped };
    },

    // Records the newest code for a problem (a Run, a Submit, or the live
    // editor read at send time). `context` is the problem statement that came
    // with it; a later source without a description keeps the one known.
    record(problemId, { code, language = null, slug = null, context = null } = {}) {
      if (!problemId) return;
      const entry = touch(problemId);
      if (slug) entry.slug = slug;
      if (typeof code === 'string') entry.latest = { code, language: language || null };
      if (context) {
        const description = context.description || (entry.context && entry.context.description) || null;
        entry.context = { ...context, description };
      }
    },

    latest(problemId) {
      const entry = problems.get(problemId);
      return entry ? entry.latest : null;
    },

    context(problemId) {
      const entry = problems.get(problemId);
      return entry ? entry.context : null;
    },

    held(problemId) {
      const entry = problems.get(problemId);
      return entry ? entry.held : null;
    },

    has(problemId) {
      return problems.has(problemId);
    },

    get size() {
      return problems.size;
    },

    // What the tutor needs to be told about this problem's code, without
    // changing anything: `none` (no code known), `unchanged` (the tutor holds
    // exactly this), `full` or `diff`. `current` defaults to the newest code
    // recorded.
    planUpdate(problemId, current = undefined) {
      const entry = problems.get(problemId);
      const code = current === undefined ? entry && entry.latest : current;
      if (!code || typeof code.code !== 'string') return { kind: 'none' };
      const held = entry ? entry.held : null;
      const language = code.language || (held && held.language) || null;
      if (held && held.code === code.code && (held.language || null) === language) {
        return { kind: 'unchanged', code: code.code, language };
      }
      const full = { kind: 'full', code: code.code, language };
      // A language switch replaces the whole solution, and a diff against
      // code in another language reads as nonsense.
      if (!held || (held.language || null) !== language) return full;
      const diff = formatDiffBody(held.code, code.code, {
        context: DIFF_CONTEXT_LINES,
        lineNumbers: true,
        maxCells: MAX_DIFF_CELLS,
      });
      if (!diff || diff.body.length > FULL_CODE_RATIO * code.code.length) return full;
      return { kind: 'diff', code: code.code, language, diff: diff.body, added: diff.added, removed: diff.removed };
    },

    // The backend call that carried this code succeeded: the tutor holds it.
    commit(problemId, { code, language = null }) {
      if (!problemId || typeof code !== 'string') return;
      touch(problemId).held = { code, language: language || null };
    },

    // The tutor's context was wiped some other way: it holds no code.
    forgetHeld() {
      for (const entry of problems.values()) entry.held = null;
    },
  };
}

// The code part of a message for a plan from planUpdate, or null when there
// is nothing to show (`none` or `unchanged`). A `full` plan carries the code
// (a resumed Claude session has no pinned copy); a `diff` the numbered diff,
// which the pinned full code alone cannot show: what the student just changed.
export function formatCodeUpdate(plan) {
  if (plan.kind === 'full') {
    return `The student's current code (${languageName(plan.language)}), in full:\n\n${fenced(plan.code, plan.language)}`;
  }
  if (plan.kind === 'diff') {
    return (
      `Changes to the student's code since the version you last saw ` +
      `(${languageName(plan.language)}, +${plan.added}/-${plan.removed} lines; the line numbers are those of ` +
      `the current code):\n\n` +
      `\`\`\`diff\n${plan.diff}\n\`\`\``
    );
  }
  return null;
}

// The block holding the student's current full code, which every request
// carries (see context-budget.js's buildMessages, and ClaudeBackend's
// session path), or null when no code is known. `code.stale` marks the last
// version the tutor was shown, standing in when the editor could not be read.
export function formatPinnedCode(code) {
  if (!code || typeof code.code !== 'string' || code.inMessage) return null;
  const language = languageName(code.language);
  const header = code.stale
    ? `${CURRENT_CODE_LABEL} (${language}), as last read: their editor could not be read for the newest ` +
      'message, so this is the last version you were shown and it may be out of date.'
    : `${CURRENT_CODE_LABEL} (${language}), exactly as it is now. Every code change shown in the conversation ` +
      'is already applied here; reason about this version.';
  return `${header}\n\n${fenced(code.code, code.language)}`;
}

// The code a turn's request carries: the code the plan sends (full, diff or
// unchanged), else the last version the tutor was shown (marked stale when
// the editor could not be read), else null. A `full` plan's message already
// holds the whole code, so it is marked `inMessage` and not pinned a second
// time on that request (formatPinnedCode); every later request pins it.
export function currentCodeFor(plan, held, { codeUnavailable = false } = {}) {
  if (plan && typeof plan.code === 'string' && (plan.kind === 'full' || plan.kind === 'diff' || plan.kind === 'unchanged')) {
    return { code: plan.code, language: plan.language || null, stale: false, ...(plan.kind === 'full' ? { inMessage: true } : {}) };
  }
  if (held && typeof held.code === 'string') return { code: held.code, language: held.language || null, stale: Boolean(codeUnavailable) };
  return null;
}

// A Submit: its header line, the code update (full or diff), then the
// instruction for how to answer. `compactText` is what an older copy of this
// turn becomes once its code is pinned instead: no full code, no instruction.
export function buildSubmitMessage({ headerLine, plan, addendum = '' }) {
  const update = formatCodeUpdate(plan);
  const text = update ? `${headerLine}\n\n${update}${addendum}` : `${headerLine}${addendum}`;
  let compactText = text;
  if (plan.kind === 'full') compactText = `${headerLine}\n\n${FULL_CODE_COMPACT_NOTE}`;
  else if (update) compactText = `${headerLine}\n\n${update}`;
  return { text, compactText };
}

// A typed message: an optional preamble (which problem the student is on),
// the code update when the code changed, then what they wrote. With neither,
// the message goes exactly as typed.
export function buildChatMessage({ text, plan = { kind: 'none' }, preamble = null }) {
  const update = formatCodeUpdate(plan);
  const parts = [];
  const compactParts = [];
  if (preamble) {
    parts.push(preamble);
    compactParts.push(preamble);
  }
  if (update) {
    parts.push(update);
    compactParts.push(plan.kind === 'full' ? FULL_CODE_COMPACT_NOTE : update);
  }
  if (parts.length === 0) return { text, compactText: text };
  const message = update ? `The student's message:\n${text}` : text;
  parts.push(message);
  compactParts.push(message);
  return { text: parts.join('\n\n'), compactText: compactParts.join('\n\n') };
}

// The notes a panel message leads with: the problem the student moved to,
// and why their code is missing when the editor could not be read.
export function chatPreamble({ previousId, problemId, codeUnavailable = false, hasHeld = false }) {
  const notes = [];
  if (problemId && previousId !== problemId) notes.push(`(The student is now working on the LeetCode problem "${problemId}".)`);
  if (codeUnavailable) {
    notes.push(
      hasHeld
        ? `(The student's editor could not be read, so their newest code is not included: "${CURRENT_CODE_LABEL}" is the last version you were shown and may be out of date.)`
        : "(The student's editor could not be read, so their current code is not included.)"
    );
  }
  return notes.length ? notes.join('\n') : null;
}

// Everything a typed message's turn needs, the same in both runtimes (the
// companion and the extension's engine): the plan, the message, and the code
// the request carries. `preamble` is a string, a function of { plan, hasHeld },
// or null.
export function prepareChatTurn(ledger, { text, problemId, preamble = null, codeUnavailable = false }) {
  const plan = problemId && !codeUnavailable ? ledger.planUpdate(problemId) : { kind: 'none' };
  const held = problemId ? ledger.held(problemId) : null;
  const lead = typeof preamble === 'function' ? preamble({ plan, hasHeld: Boolean(held) }) : preamble;
  const message = buildChatMessage({ text, plan, preamble: lead });
  return {
    plan,
    message,
    problemContext: (problemId && ledger.context(problemId)) || undefined,
    currentCode: currentCodeFor(plan, held, { codeUnavailable }),
  };
}

// The same for a Submit the ledger decided to send (plan `full` or `diff`).
export function prepareSubmitTurn(ledger, { problemId, plan, headerLine, addendum = '', fallbackContext = null }) {
  const message = buildSubmitMessage({ headerLine, plan, addendum });
  return {
    plan,
    message,
    problemContext: ledger.context(problemId) || fallbackContext || undefined,
    currentCode: currentCodeFor(plan, ledger.held(problemId)),
  };
}
