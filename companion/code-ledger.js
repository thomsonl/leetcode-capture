// companion/code-ledger.js - what code the tutor has already been shown, and
// what to tell it next.
//
// The rules (Thomson's request, see README.md, "What the tutor is sent"):
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

// Shown to the model in place of an older turn's full code, once the code it
// holds is pinned at the top of the conversation (see context-budget.js's
// buildMessages).
export const FULL_CODE_COMPACT_NOTE =
  "(The student's full code was shown here. The latest version you have seen is pinned at the top of the conversation.)";

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
// is nothing to show (`none` or `unchanged`).
export function formatCodeUpdate(plan) {
  if (plan.kind === 'full') {
    return `The student's current code (${languageName(plan.language)}), in full:\n\n${fenced(plan.code, plan.language)}`;
  }
  if (plan.kind === 'diff') {
    return (
      `Changes to the student's code since the version you last saw ` +
      `(${languageName(plan.language)}, +${plan.added}/-${plan.removed} lines):\n\n` +
      `\`\`\`diff\n${plan.diff}\n\`\`\``
    );
  }
  return null;
}

// The pinned system message holding the code the tutor has been shown (see
// context-budget.js's buildMessages), or null when it holds none.
export function formatPinnedCode(held) {
  if (!held || typeof held.code !== 'string') return null;
  return (
    `The student's code exactly as you last saw it (${languageName(held.language)}). ` +
    `It already includes every change shown earlier in the conversation, and any code change in the ` +
    `student's newest message applies to this version:\n\n${fenced(held.code, held.language)}`
  );
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
