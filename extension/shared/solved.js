// extension/shared/solved.js - which problems the student has solved, kept
// in the extension's own storage and never sent anywhere.
//
// Storage (storage.local):
//   solvedProblems:  { [slug]: { at: ISO time, count, manual? } }
//     at     when it was last accepted (or marked by hand)
//     count  how many accepted submissions were seen for it (0 when it was
//            only marked by hand on the Progress tab)
//   starredProblems: { [slug]: true }  the Progress tab's stars
//
// Messages the background worker answers through createSolvedService:
//   from a content script on leetcode.com/problems/<slug>/...:
//     { type: 'lc-tutor:accepted', submissionId }  LeetCode accepted a
//       submission on this tab's page. The slug comes from the sender's
//       address, never from the message. Answers { ok, recorded, card }.
//   from the extension's own pages (the Progress tab):
//     { type: 'lc-tutor:solved-set', slug, solved }  mark or unmark by hand
//     { type: 'lc-tutor:star-set', slug, starred }
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

import { NEETCODE_150, suggestAfterSolve } from './roadmap.js';

export const SOLVED_KEY = 'solvedProblems';
export const STARRED_KEY = 'starredProblems';

// LeetCode's own slugs: lowercase letters and digits joined by single
// hyphens ("two-sum", "3sum", "powx-n").
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 120;

export function isSlug(value) {
  return typeof value === 'string' && value.length <= MAX_SLUG && SLUG_RE.test(value);
}

// The problem slug of a leetcode.com problem page address, or null.
export function slugFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'leetcode.com') return null;
  const match = /^\/problems\/([^/]+)/.exec(parsed.pathname);
  return match && isSlug(match[1]) ? match[1] : null;
}

function validTime(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// Whatever storage held, as a clean record: unknown keys and malformed
// entries are dropped.
export function normalizeSolved(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [slug, entry] of Object.entries(raw)) {
    if (!isSlug(slug) || !entry || typeof entry !== 'object') continue;
    const count = Number.isInteger(entry.count) && entry.count >= 0 ? entry.count : 0;
    const clean = { at: validTime(entry.at) ? entry.at : new Date(0).toISOString(), count };
    if (entry.manual === true) clean.manual = true;
    out[slug] = clean;
  }
  return out;
}

export function normalizeStarred(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [slug, on] of Object.entries(raw)) if (isSlug(slug) && on === true) out[slug] = true;
  return out;
}

// An accepted submission: the count goes up and `at` moves to now. A problem
// marked by hand before counts as detected from now on.
export function recordAccepted(solved, slug, at) {
  const before = solved[slug];
  return { ...solved, [slug]: { at, count: (before ? before.count : 0) + 1 } };
}

// The Progress tab's status mark. Marking keeps a detected record as it is;
// unmarking removes the problem whatever made it solved.
export function markSolved(solved, slug, on, at) {
  const next = { ...solved };
  if (!on) delete next[slug];
  else if (!next[slug]) next[slug] = { at, count: 0, manual: true };
  return next;
}

export function solvedSlugs(solved) {
  return Object.keys(solved);
}

function brief(problem) {
  return problem ? { slug: problem.slug, title: problem.title, difficulty: problem.difficulty } : null;
}

// What the Tutor panel's "nice job" card shows after `slug` was accepted,
// built only from the roadmap and the solved list:
//   { roadmap, solvedTitle, next, more: { topic, problem } | null, finished }
// `solvedTitle` is null for a problem that is not on the roadmap (the panel
// then uses the page's own title), and `more` is null then too, or when the
// topic has nothing left that `next` does not already suggest.
export function congratulation(solved, slug, roadmap = NEETCODE_150) {
  const done = solvedSlugs(solved);
  const suggestion = suggestAfterSolve(roadmap, done, slug, { count: 2 });
  const next = suggestion.agenda[0] || null;
  const sameTopic = suggestion.sameTopic;
  const other = sameTopic.problems.find((p) => !next || p.slug !== next.slug) || null;
  let solvedTitle = null;
  for (const topic of roadmap.topics) {
    const hit = topic.problems.find((p) => p.slug === slug);
    if (hit) solvedTitle = hit.title;
  }
  return {
    roadmap: suggestion.roadmap,
    solvedTitle,
    next: brief(next),
    more: sameTopic.topic && other ? { topic: sameTopic.topic, problem: brief(other) } : null,
    finished: !next,
  };
}

// The background worker's side. `storage` is { get(keys), set(items) };
// every write goes through one queue so two quick events never lose one
// another's change.
export function createSolvedService({ storage, extensionOrigin, now = () => new Date().toISOString(), log = () => {} }) {
  let chain = Promise.resolve();
  function update(fn) {
    const run = chain.then(async () => {
      const stored = (await storage.get([SOLVED_KEY, STARRED_KEY])) || {};
      return fn(normalizeSolved(stored[SOLVED_KEY]), normalizeStarred(stored[STARRED_KEY]));
    });
    chain = run.catch(() => {});
    return run;
  }

  // The same submission is reported once: LeetCode may poll its result
  // again, a page may be reloaded mid-poll, and a worker may restart.
  const seen = [];
  const MAX_SEEN = 200;

  function isExtensionPage(sender) {
    return Boolean(sender && typeof sender.url === 'string' && sender.url.startsWith(`${extensionOrigin}/`));
  }

  async function accepted(message, sender) {
    const slug = slugFromUrl(sender && sender.url);
    const id = message.submissionId;
    if (!slug || !sender.tab || typeof id !== 'string' || !/^\d{1,20}$/.test(id)) return { ok: false };
    const key = `${slug}:${id}`;
    if (seen.includes(key)) return { ok: true, recorded: false, card: null };
    seen.push(key);
    if (seen.length > MAX_SEEN) seen.shift();
    return update(async (solved) => {
      const next = recordAccepted(solved, slug, now());
      await storage.set({ [SOLVED_KEY]: next });
      return { ok: true, recorded: true, card: congratulation(next, slug) };
    });
  }

  async function setSolved(message) {
    if (!isSlug(message.slug) || typeof message.solved !== 'boolean') return { ok: false };
    return update(async (solved) => {
      await storage.set({ [SOLVED_KEY]: markSolved(solved, message.slug, message.solved, now()) });
      return { ok: true };
    });
  }

  async function setStarred(message) {
    if (!isSlug(message.slug) || typeof message.starred !== 'boolean') return { ok: false };
    return update(async (_solved, starred) => {
      const next = { ...starred };
      if (message.starred) next[message.slug] = true;
      else delete next[message.slug];
      await storage.set({ [STARRED_KEY]: next });
      return { ok: true };
    });
  }

  return {
    // Resolves to the answer, or undefined when the message is not for this
    // service.
    async handleMessage(message, sender) {
      if (!message || typeof message !== 'object') return undefined;
      try {
        if (message.type === 'lc-tutor:accepted') return await accepted(message, sender);
        if (message.type === 'lc-tutor:solved-set' || message.type === 'lc-tutor:star-set') {
          if (!isExtensionPage(sender)) return { ok: false };
          return message.type === 'lc-tutor:solved-set' ? await setSolved(message) : await setStarred(message);
        }
      } catch (err) {
        log(`could not update solved problems: ${err && err.message}`);
        return { ok: false };
      }
      return undefined;
    },
  };
}
