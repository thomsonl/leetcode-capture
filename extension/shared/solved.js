// extension/shared/solved.js - which problems the student has solved, kept
// in the extension's own storage and never sent anywhere.
//
// Storage (storage.local):
//   solvedProblems:  { [slug]: { at: ISO time, count, manual? } }
//     at     when it was last accepted (or marked by hand)
//     count  how many accepted submissions were seen for it (0 when it was
//            only marked by hand on the Progress tab)
//   starredProblems: { [slug]: true }  the Progress tab's stars
//   activeProgressList: list id      the list the student works on (see
//     shared/roadmap.js LISTS); missing or unknown means NeetCode 150.
//     Changing it never touches the solved problems.
//
// Messages the background worker answers through createSolvedService:
//   from a content script on leetcode.com/problems/<slug>/...:
//     { type: 'lc-tutor:accepted', submissionId, slug }  LeetCode accepted a
//       submission for the problem this tab shows (`slug`, read by the
//       content script from the live address, since sender.url does not
//       follow in-app moves; the sender must be a problem page in a tab).
//       Answers { ok, recorded, card }.
//   from the extension's own pages (the Progress tab):
//     { type: 'lc-tutor:solved-set', slug, solved }  mark or unmark by hand
//     { type: 'lc-tutor:star-set', slug, starred }
//   from either (the Progress tab's list selector, the card's list menu):
//     { type: 'lc-tutor:set-list', list, slug? }  work on another list. From
//       a problem page (with the card's `slug`, as for lc-tutor:accepted)
//       the answer carries that card again, built for the new list:
//       { ok, card }.
//   from a content script on a problem page (the Tutor panel's "Practice a
//   skill" picker, with the page's `slug` as for lc-tutor:accepted):
//     { type: 'lc-tutor:practice', slug, skill?, offset? }  read only. The
//       reference difficulty is that problem's in the bundled index (none
//       for a problem it lacks), and that problem is never suggested.
//       Answers { ok, skills, skill, reference, suggestions, offset, more }
//       (see shared/practice.js); without `skill` only the list of skills
//       matters. Nothing of it reaches the tutor.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

import { catalogEntry } from './catalog.js';
import { practiceSuggestions, referenceLevel, skillById, skillChoices } from './practice.js';
import { LISTS, NEETCODE_150, ROADMAPS, listById, problemInList, suggestAfterSolve } from './roadmap.js';

export const SOLVED_KEY = 'solvedProblems';
export const STARRED_KEY = 'starredProblems';
export const ACTIVE_LIST_KEY = 'activeProgressList';

export function isListId(value) {
  return typeof value === 'string' && Object.hasOwn(ROADMAPS, value);
}

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
// built only from the active list, the catalog and the solved list:
//   { roadmap, lists, solvedTitle, next,
//     more: { topic, label, problem } | null, finished, skills }
// `lists` is every list the card's menu offers ({ id, title, size }), and
// `skills` the "Practice a skill" chips ({ id, label }, a fixed list, never
// the solved problem's own tags).
// `solvedTitle` is the catalog's title, or null for a problem no bundled
// list has (the panel then uses the page's own title). `more` is null for a
// problem the active list does not have (then the card is the agenda only),
// or when its topic has nothing left that `next` does not already suggest.
export function congratulation(solved, slug, roadmap = NEETCODE_150) {
  const done = solvedSlugs(solved);
  const suggestion = suggestAfterSolve(roadmap, done, slug, { count: 2 });
  const next = suggestion.agenda[0] || null;
  const sameTopic = suggestion.sameTopic;
  const other = sameTopic.problems.find((p) => !next || p.slug !== next.slug) || null;
  const entry = problemInList(roadmap, slug) || catalogEntry(slug);
  const label = sameTopic.topic && `More ${sameTopic.topic.title} problems`;
  return {
    roadmap: suggestion.roadmap,
    lists: LISTS.map((list) => ({ id: list.id, title: list.title, size: list.size })),
    solvedTitle: entry ? entry.title : null,
    next: brief(next),
    more: sameTopic.topic && other ? { topic: sameTopic.topic, label, problem: brief(other) } : null,
    finished: !next,
    skills: skillChoices(),
  };
}

const MAX_OFFSET = 5000;

// The "Practice a skill" answer for the problem page `slug`: the skills,
// and with a known `skill` the suggestions after `offset`.
export function practiceAnswer(solved, slug, skill, offset = 0) {
  const result = practiceSuggestions({ skill: skillById(skill), reference: referenceLevel(slug), solved, exclude: slug, offset });
  return { ok: true, skills: skillChoices(), ...result };
}

// The background worker's side. `storage` is { get(keys), set(items) };
// every write goes through one queue so two quick events never lose one
// another's change.
export function createSolvedService({ storage, extensionOrigin, now = () => new Date().toISOString(), log = () => {} }) {
  let chain = Promise.resolve();
  function update(fn) {
    const run = chain.then(async () => {
      const stored = (await storage.get([SOLVED_KEY, STARRED_KEY, ACTIVE_LIST_KEY])) || {};
      return fn(normalizeSolved(stored[SOLVED_KEY]), normalizeStarred(stored[STARRED_KEY]), listById(stored[ACTIVE_LIST_KEY]));
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

  // The problem a message from a problem tab is about. The sender must be a
  // leetcode.com problem page in a tab, but its address (sender.url) is where
  // the document was loaded: LeetCode moves between problems in the page
  // (history.pushState) and sender.url does not follow, so the content
  // script names the problem from the page's live address.
  function tabSlug(message, sender) {
    if (!sender || !sender.tab || !slugFromUrl(sender.url)) return null;
    return isSlug(message.slug) ? message.slug : null;
  }

  // content.js sends this only when the submission's first check started on
  // the problem the page shows now (see inject.js), so a verdict that arrives
  // after a move never marks the next problem solved.
  async function accepted(message, sender) {
    const slug = tabSlug(message, sender);
    const id = message.submissionId;
    if (!slug || typeof id !== 'string' || !/^\d{1,20}$/.test(id)) return { ok: false };
    const key = `${slug}:${id}`;
    if (seen.includes(key)) return { ok: true, recorded: false, card: null };
    seen.push(key);
    if (seen.length > MAX_SEEN) seen.shift();
    return update(async (solved, _starred, list) => {
      const next = recordAccepted(solved, slug, now());
      await storage.set({ [SOLVED_KEY]: next });
      return { ok: true, recorded: true, card: congratulation(next, slug, list) };
    });
  }

  // Only the list choice is written; the solved problems stay as they are.
  async function setList(message, sender) {
    const page = isExtensionPage(sender);
    const slug = page ? null : tabSlug(message, sender);
    if (!isListId(message.list) || (!page && !slug)) return { ok: false };
    return update(async (solved) => {
      await storage.set({ [ACTIVE_LIST_KEY]: message.list });
      return slug ? { ok: true, card: congratulation(solved, slug, listById(message.list)) } : { ok: true };
    });
  }

  // Read only: the solved problems as stored now (after any queued write).
  async function practice(message, sender) {
    const slug = tabSlug(message, sender);
    const offset = message.offset === undefined ? 0 : message.offset;
    const skill = message.skill === undefined || message.skill === null ? null : message.skill;
    if (!slug || !Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) return { ok: false };
    if (skill !== null && !skillById(skill)) return { ok: false };
    return update(async (solved) => practiceAnswer(solved, slug, skill, offset));
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
        if (message.type === 'lc-tutor:set-list') return await setList(message, sender);
        if (message.type === 'lc-tutor:practice') return await practice(message, sender);
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
