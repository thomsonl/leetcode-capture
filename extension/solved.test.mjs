// Solved problems: the storage rules and the worker's messages
// (shared/solved.js), the page-world detection of an accepted submission
// (inject.js, run in a VM with a stand-in fetch and XMLHttpRequest), and
// content.js forwarding it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  SOLVED_KEY,
  STARRED_KEY,
  ACTIVE_LIST_KEY,
  congratulation,
  createSolvedService,
  isListId,
  isSlug,
  markSolved,
  normalizeSolved,
  normalizeStarred,
  recordAccepted,
  slugFromUrl,
} from './shared/solved.js';
import { listById } from './shared/roadmap.js';
import { skillChoices } from './shared/practice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---- the storage rules ---------------------------------------------------

test('slugs are LeetCode slugs only', () => {
  for (const ok of ['two-sum', '3sum', 'powx-n', 'a']) assert.ok(isSlug(ok), ok);
  for (const bad of ['', 'Two-Sum', 'two--sum', '-two', 'two-', 'two sum', '../x', 'a/b', 7, null, 'x'.repeat(121)]) assert.ok(!isSlug(bad), String(bad));
});

test('the slug comes from a leetcode.com problem address only', () => {
  assert.equal(slugFromUrl('https://leetcode.com/problems/two-sum/description/'), 'two-sum');
  assert.equal(slugFromUrl('https://leetcode.com/problems/3sum/'), '3sum');
  assert.equal(slugFromUrl('https://leetcode.com/problems/lru-cache?envType=study'), 'lru-cache');
  assert.equal(slugFromUrl('https://leetcode.com/problemset/'), null);
  assert.equal(slugFromUrl('https://evil.example/problems/two-sum/'), null);
  assert.equal(slugFromUrl('http://leetcode.com/problems/two-sum/'), null);
  assert.equal(slugFromUrl('https://leetcode.com/problems/Two_Sum/'), null);
  assert.equal(slugFromUrl(undefined), null);
});

test('normalizing drops malformed entries and keeps the rest', () => {
  const at = '2026-11-04T10:00:00.000Z';
  const clean = normalizeSolved({
    'two-sum': { at, count: 2 },
    '3sum': { at, count: 0, manual: true },
    'Bad Slug': { at, count: 1 },
    'no-time': { count: 'x' },
    'not-object': true,
  });
  assert.deepEqual(clean, {
    'two-sum': { at, count: 2 },
    '3sum': { at, count: 0, manual: true },
    'no-time': { at: new Date(0).toISOString(), count: 0 },
  });
  assert.deepEqual(normalizeSolved(null), {});
  assert.deepEqual(normalizeSolved([1]), {});
  assert.deepEqual(normalizeStarred({ 'two-sum': true, x: false, 'Bad!': true }), { 'two-sum': true });
});

test('an accepted submission counts up and moves the time; a manual mark becomes detected', () => {
  let s = recordAccepted({}, 'two-sum', 't1');
  assert.deepEqual(s, { 'two-sum': { at: 't1', count: 1 } });
  s = recordAccepted(s, 'two-sum', 't2');
  assert.deepEqual(s, { 'two-sum': { at: 't2', count: 2 } });
  s = markSolved(s, '3sum', true, 't3');
  assert.deepEqual(s['3sum'], { at: 't3', count: 0, manual: true });
  s = recordAccepted(s, '3sum', 't4');
  assert.deepEqual(s['3sum'], { at: 't4', count: 1 });
});

test('marking keeps a detected record; unmarking removes it whatever made it solved', () => {
  const s = { 'two-sum': { at: 't1', count: 3 } };
  assert.deepEqual(markSolved(s, 'two-sum', true, 't9'), s);
  assert.deepEqual(markSolved(s, 'two-sum', false, 't9'), {});
  assert.deepEqual(s, { 'two-sum': { at: 't1', count: 3 } }, 'the input is not changed');
});

// ---- the card ------------------------------------------------------------

test('the card suggests the next roadmap problem and a different one of the same topic', () => {
  const card = congratulation({ 'two-sum': { at: 't', count: 1 } }, 'two-sum');
  assert.equal(card.roadmap.title, 'NeetCode 150');
  assert.equal(card.solvedTitle, 'Two Sum');
  assert.deepEqual(card.next, { slug: 'contains-duplicate', title: 'Contains Duplicate', difficulty: 'Easy' });
  // contains-duplicate is both the agenda's next and the topic's easiest:
  // the topic suggestion moves on to the next one.
  assert.equal(card.more.topic.title, 'Arrays & Hashing');
  assert.deepEqual(card.more.problem, { slug: 'valid-anagram', title: 'Valid Anagram', difficulty: 'Easy' });
  assert.equal(card.finished, false);
});

test('a problem off the active list gets only the agenda, with the catalog title when there is one', () => {
  const card = congratulation({ 'add-binary': { at: 't', count: 1 } }, 'add-binary');
  assert.equal(card.solvedTitle, 'Add Binary', 'on other lists, so the catalog has it');
  assert.equal(card.more, null);
  assert.equal(card.next.slug, 'contains-duplicate');
  const unknown = congratulation({}, 'not-on-any-list');
  assert.equal(unknown.solvedTitle, null);
  assert.equal(unknown.more, null);
  assert.equal(unknown.next.slug, 'contains-duplicate');
});

test('the card follows the list it is given: its next problem, its group, its label, and every list for the menu', async () => {
  const { BLIND_75, GRIND_75, SQL_50 } = await import('./shared/roadmap.js');
  const blind = congratulation({ 'two-sum': { at: 't', count: 1 } }, 'two-sum', BLIND_75);
  assert.deepEqual(blind.roadmap, { id: 'blind-75', title: 'Blind 75' });
  assert.equal(blind.next.slug, 'best-time-to-buy-and-sell-stock');
  assert.equal(blind.more.topic.title, 'Array');
  assert.equal(blind.more.label, 'More Array problems');
  assert.notEqual(blind.more.problem.slug, blind.next.slug);
  // Grind 75's weeks are not subjects: more of the same subject, not week.
  const grind = congratulation({}, 'flood-fill', GRIND_75);
  assert.equal(grind.next.slug, 'two-sum');
  assert.equal(grind.more.topic.title, 'Graphs');
  assert.equal(grind.more.label, 'More Graphs problems');
  assert.equal(grind.more.problem.slug, '01-matrix');
  // Two Sum is not on SQL 50: the agenda only, and the catalog's title.
  const sql = congratulation({}, 'two-sum', SQL_50);
  assert.equal(sql.solvedTitle, 'Two Sum');
  assert.equal(sql.more, null);
  assert.equal(sql.next.slug, 'recyclable-and-low-fat-products');
  assert.deepEqual(blind.lists.map((l) => `${l.id}:${l.size}`), ['neetcode-150:150', 'neetcode-250:250', 'blind-75:75', 'grind-75:75', 'top-100-liked:100', 'top-interview-150:150', 'sql-50:50']);
  // A list added to the picker is a list the card's menu and the worker know.
  const liked = congratulation({}, 'move-zeroes', listById('top-100-liked'));
  assert.deepEqual(liked.roadmap, { id: 'top-100-liked', title: 'Top 100 Liked' });
  assert.equal(liked.more.label, 'More Two Pointers problems');
  assert.ok(isListId('top-100-liked'));
  assert.equal(blind.lists[2].title, 'Blind 75');
});

test('a finished topic has no topic suggestion, and a finished roadmap says so', async () => {
  const { NEETCODE_150 } = await import('./shared/roadmap.js');
  const all = {};
  for (const t of NEETCODE_150.topics) for (const p of t.problems) all[p.slug] = { at: 't', count: 1 };
  const card = congratulation(all, 'two-sum');
  assert.equal(card.next, null);
  assert.equal(card.more, null);
  assert.equal(card.finished, true);
  const stack = NEETCODE_150.topics.find((t) => t.id === 'stack');
  const someStack = Object.fromEntries(stack.problems.map((p) => [p.slug, { at: 't', count: 1 }]));
  const card2 = congratulation(someStack, 'valid-parentheses');
  assert.equal(card2.more, null, 'nothing of Stack is left');
  assert.ok(card2.next);
});

// ---- the worker's service --------------------------------------------------

function fakeStorage(initial = {}) {
  const data = structuredClone(initial);
  let writes = 0;
  return {
    data,
    get writes() {
      return writes;
    },
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items) {
      writes += 1;
      Object.assign(data, structuredClone(items));
    },
  };
}

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const tabSender = (url = 'https://leetcode.com/problems/two-sum/description/') => ({ id: 'x', url, tab: { id: 4 } });
const pageSender = { id: 'x', url: `${ORIGIN}/settings.html#progress` };

test('an accepted submission is stored once per submission id, for the problem the problem tab names', async () => {
  const storage = fakeStorage();
  let clock = 0;
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN, now: () => `2026-11-04T10:00:0${clock++}.000Z` });
  const first = await service.handleMessage({ type: 'lc-tutor:accepted', submissionId: '111', slug: 'two-sum' }, tabSender());
  assert.equal(first.ok, true);
  assert.equal(first.recorded, true);
  assert.equal(first.card.solvedTitle, 'Two Sum');
  assert.deepEqual(storage.data[SOLVED_KEY], { 'two-sum': { at: '2026-11-04T10:00:00.000Z', count: 1 } });
  const again = await service.handleMessage({ type: 'lc-tutor:accepted', submissionId: '111', slug: 'two-sum' }, tabSender());
  assert.deepEqual(again, { ok: true, recorded: false, card: null });
  assert.equal(storage.writes, 1);
  await service.handleMessage({ type: 'lc-tutor:accepted', submissionId: '112', slug: 'two-sum' }, tabSender());
  assert.deepEqual(storage.data[SOLVED_KEY]['two-sum'], { at: '2026-11-04T10:00:01.000Z', count: 2 });
  // After an in-app move the sender's address is still the one the tab
  // loaded; the problem is the one the content script names.
  const moved = await service.handleMessage({ type: 'lc-tutor:accepted', submissionId: '113', slug: '3sum' }, tabSender());
  assert.equal(moved.card.solvedTitle, '3Sum');
  assert.deepEqual(storage.data[SOLVED_KEY]['3sum'], { at: '2026-11-04T10:00:02.000Z', count: 1 });
  assert.equal(storage.data[SOLVED_KEY]['two-sum'].count, 2);
});

test('an accepted message from anywhere but a problem tab, or with a bad id, is refused', async () => {
  const storage = fakeStorage();
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN });
  const refused = [
    [{ type: 'lc-tutor:accepted', submissionId: '1' }, { id: 'x', url: 'https://leetcode.com/problemset/', tab: { id: 1 } }],
    [{ type: 'lc-tutor:accepted', submissionId: '1' }, { id: 'x', url: 'https://leetcode.com/problems/two-sum/' }],
    [{ type: 'lc-tutor:accepted', submissionId: 'runcode_1' }, tabSender()],
    [{ type: 'lc-tutor:accepted', submissionId: 12 }, tabSender()],
    [{ type: 'lc-tutor:accepted' }, pageSender],
    // No problem named, or not a slug.
    [{ type: 'lc-tutor:accepted', submissionId: '1' }, tabSender()],
    [{ type: 'lc-tutor:accepted', submissionId: '1', slug: 'Two Sum' }, tabSender()],
    [{ type: 'lc-tutor:accepted', submissionId: '1', slug: 'two-sum' }, { id: 'x', url: 'https://example.com/problems/two-sum/', tab: { id: 1 } }],
  ];
  for (const [message, sender] of refused) assert.deepEqual(await service.handleMessage(message, sender), { ok: false }, JSON.stringify([message, sender]));
  assert.equal(storage.writes, 0);
});

test('the card after an accepted submission follows the stored list; no stored or a bad one means NeetCode 150', async () => {
  const storage = fakeStorage({ [ACTIVE_LIST_KEY]: 'grind-75' });
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN, now: () => 'now' });
  const a = await service.handleMessage({ type: 'lc-tutor:accepted', submissionId: '301', slug: 'two-sum' }, tabSender());
  assert.equal(a.card.roadmap.title, 'Grind 75');
  assert.equal(a.card.next.slug, 'valid-parentheses');
  assert.equal(a.card.more.label, 'More Arrays & Hashing problems');
  storage.data[ACTIVE_LIST_KEY] = 'no-such-list';
  const b = await service.handleMessage({ type: 'lc-tutor:accepted', submissionId: '302', slug: 'two-sum' }, tabSender());
  assert.equal(b.card.roadmap.title, 'NeetCode 150');
  delete storage.data[ACTIVE_LIST_KEY];
  const c = await service.handleMessage({ type: 'lc-tutor:accepted', submissionId: '303', slug: 'two-sum' }, tabSender());
  assert.equal(c.card.roadmap.title, 'NeetCode 150');
});

test('switching lists writes only the list choice, answers a problem tab with its card again, and refuses junk', async () => {
  const solved = { 'two-sum': { at: 't', count: 2 }, '3sum': { at: 't', count: 0, manual: true } };
  const storage = fakeStorage({ [SOLVED_KEY]: solved, [STARRED_KEY]: { 'lru-cache': true } });
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN });
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:set-list', list: 'blind-75' }, pageSender), { ok: true });
  assert.equal(storage.data[ACTIVE_LIST_KEY], 'blind-75');
  const fromTab = await service.handleMessage({ type: 'lc-tutor:set-list', list: 'sql-50', slug: 'two-sum' }, tabSender());
  assert.equal(fromTab.ok, true);
  assert.equal(fromTab.card.roadmap.title, 'SQL 50');
  assert.equal(fromTab.card.solvedTitle, 'Two Sum');
  assert.equal(fromTab.card.more, null);
  assert.equal(storage.data[ACTIVE_LIST_KEY], 'sql-50');
  assert.deepEqual(storage.data[SOLVED_KEY], solved, 'the solved problems are untouched');
  assert.deepEqual(storage.data[STARRED_KEY], { 'lru-cache': true });
  const writes = storage.writes;
  for (const [message, sender] of [
    [{ type: 'lc-tutor:set-list', list: 'nope' }, pageSender],
    [{ type: 'lc-tutor:set-list', list: '__proto__' }, pageSender],
    [{ type: 'lc-tutor:set-list' }, pageSender],
    [{ type: 'lc-tutor:set-list', list: 'blind-75', slug: 'two-sum' }, { id: 'x', url: 'https://leetcode.com/problemset/', tab: { id: 1 } }],
    [{ type: 'lc-tutor:set-list', list: 'blind-75' }, tabSender()],
    [{ type: 'lc-tutor:set-list', list: 'blind-75' }, { id: 'x', url: 'https://example.com/problems/two-sum/', tab: { id: 1 } }],
    [{ type: 'lc-tutor:set-list', list: 'blind-75' }, { id: 'x', url: 'https://leetcode.com/problems/two-sum/' }],
  ]) assert.deepEqual(await service.handleMessage(message, sender), { ok: false }, JSON.stringify([message, sender]));
  assert.equal(storage.writes, writes);
  assert.equal(storage.data[ACTIVE_LIST_KEY], 'sql-50');
});

test('the card carries the fixed practice skills, never the solved problem\'s own tags', async () => {
  const card = congratulation({}, 'two-sum');
  assert.deepEqual(card.skills, skillChoices());
  assert.deepEqual(congratulation({}, 'valid-parentheses').skills, card.skills, 'the same chips whatever was solved');
});

test('practice suggestions answer a problem tab for the problem it names, leave out solved problems and write nothing', async () => {
  const storage = fakeStorage({ [SOLVED_KEY]: { 'two-sum': { at: 't', count: 1 } } });
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN });
  const skills = await service.handleMessage({ type: 'lc-tutor:practice', slug: 'two-sum' }, tabSender());
  assert.equal(skills.ok, true);
  assert.deepEqual(skills.skills, skillChoices());
  assert.deepEqual(skills.suggestions, []);
  // On Contains Duplicate (Easy): Easy hash map problems, not Two Sum
  // (solved), not the page's own problem.
  const r = await service.handleMessage({ type: 'lc-tutor:practice', slug: 'contains-duplicate', skill: 'hash-maps' }, tabSender());
  assert.equal(r.ok, true);
  assert.equal(r.reference, 'Easy');
  assert.deepEqual(r.skill, { id: 'hash-maps', label: 'Hash maps' });
  assert.equal(r.suggestions.length, 3);
  for (const s of r.suggestions) {
    assert.equal(s.difficulty, 'Easy');
    assert.ok(s.slug !== 'two-sum' && s.slug !== 'contains-duplicate', s.slug);
    assert.match(s.reason, /^Same level · /);
  }
  assert.equal(r.more, true);
  const next = await service.handleMessage({ type: 'lc-tutor:practice', slug: 'contains-duplicate', skill: 'hash-maps', offset: 3 }, tabSender());
  assert.equal(next.offset, 3);
  assert.ok(!next.suggestions.some((s) => r.suggestions.some((t) => t.slug === s.slug)), 'the next three are new');
  // The card's own problems (skip) are left out, and a bad skip is refused.
  const skipped = await service.handleMessage({ type: 'lc-tutor:practice', slug: 'contains-duplicate', skill: 'hash-maps', skip: [r.suggestions[0].slug] }, tabSender());
  assert.equal(skipped.ok, true);
  assert.ok(!skipped.suggestions.some((s) => s.slug === r.suggestions[0].slug), 'a skipped problem is not offered');
  for (const skip of ['two-sum', ['Not A Slug'], ['a', 'b', 'c', 'd', 'e'], [1]]) {
    assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:practice', slug: 'contains-duplicate', skill: 'hash-maps', skip }, tabSender()), { ok: false });
  }
  // A problem the index does not have: every level, by popularity.
  const unknown = await service.handleMessage({ type: 'lc-tutor:practice', slug: 'a-brand-new-problem', skill: 'arrays' }, tabSender());
  assert.equal(unknown.reference, null);
  assert.equal(unknown.suggestions.length, 3);
  assert.equal(storage.writes, 0);
});

test('practice suggestions refuse anything but a problem tab naming its problem, an unknown skill and a bad offset', async () => {
  const storage = fakeStorage();
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN });
  for (const [message, sender] of [
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'arrays' }, pageSender],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'arrays' }, { id: 'x', url: 'https://leetcode.com/problemset/', tab: { id: 1 } }],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'arrays' }, { id: 'x', url: 'https://leetcode.com/problems/two-sum/' }],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'arrays' }, { id: 'x', url: 'https://example.com/problems/two-sum/', tab: { id: 1 } }],
    [{ type: 'lc-tutor:practice', skill: 'arrays' }, tabSender()],
    [{ type: 'lc-tutor:practice', slug: 'Two Sum', skill: 'arrays' }, tabSender()],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'no-such-skill' }, tabSender()],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: '__proto__' }, tabSender()],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 7 }, tabSender()],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'arrays', offset: -3 }, tabSender()],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'arrays', offset: 1.5 }, tabSender()],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'arrays', offset: '3' }, tabSender()],
    [{ type: 'lc-tutor:practice', slug: 'two-sum', skill: 'arrays', offset: 1e9 }, tabSender()],
  ]) assert.deepEqual(await service.handleMessage(message, sender), { ok: false }, JSON.stringify([message, sender]));
  assert.equal(storage.writes, 0);
});

test('marking, unmarking and starring answer only the extension pages', async () => {
  const storage = fakeStorage({ [SOLVED_KEY]: { 'two-sum': { at: 't', count: 1 } } });
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN, now: () => 'now' });
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:solved-set', slug: '3sum', solved: true }, tabSender()), { ok: false });
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:star-set', slug: '3sum', starred: true }, tabSender()), { ok: false });
  assert.equal(storage.writes, 0);
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:solved-set', slug: '3sum', solved: true }, pageSender), { ok: true });
  assert.deepEqual(storage.data[SOLVED_KEY]['3sum'], { at: 'now', count: 0, manual: true });
  await service.handleMessage({ type: 'lc-tutor:solved-set', slug: 'two-sum', solved: false }, pageSender);
  assert.deepEqual(Object.keys(storage.data[SOLVED_KEY]), ['3sum']);
  await service.handleMessage({ type: 'lc-tutor:star-set', slug: 'lru-cache', starred: true }, pageSender);
  assert.deepEqual(storage.data[STARRED_KEY], { 'lru-cache': true });
  await service.handleMessage({ type: 'lc-tutor:star-set', slug: 'lru-cache', starred: false }, pageSender);
  assert.deepEqual(storage.data[STARRED_KEY], {});
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:solved-set', slug: 'Bad', solved: true }, pageSender), { ok: false });
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:solved-set', slug: 'x', solved: 'yes' }, pageSender), { ok: false });
  assert.equal(await service.handleMessage({ type: 'lc-tutor:other' }, pageSender), undefined);
});

test('writes queue up: quick marks never lose one another', async () => {
  const storage = fakeStorage();
  const slowGet = storage.get.bind(storage);
  storage.get = async (keys) => {
    await new Promise((r) => setTimeout(r, 5));
    return slowGet(keys);
  };
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN, now: () => 'now' });
  const slugs = ['a', 'b', 'c', 'd', 'e'];
  await Promise.all([
    ...slugs.map((slug) => service.handleMessage({ type: 'lc-tutor:solved-set', slug, solved: true }, pageSender)),
    service.handleMessage({ type: 'lc-tutor:accepted', submissionId: '5', slug: 'two-sum' }, tabSender()),
  ]);
  assert.deepEqual(Object.keys(storage.data[SOLVED_KEY]).sort(), [...slugs, 'two-sum'].sort());
});

test('a storage failure answers ok: false and the next write still runs', async () => {
  const storage = fakeStorage();
  let fail = true;
  const realSet = storage.set.bind(storage);
  storage.set = async (items) => {
    if (fail) throw new Error('quota');
    return realSet(items);
  };
  const logs = [];
  const service = createSolvedService({ storage, extensionOrigin: ORIGIN, log: (t) => logs.push(t) });
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:solved-set', slug: 'a', solved: true }, pageSender), { ok: false });
  assert.match(logs[0], /quota/);
  fail = false;
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:solved-set', slug: 'a', solved: true }, pageSender), { ok: true });
});

// ---- inject.js: the page-world detection ----------------------------------

// Runs the real inject.js in a fresh VM context with a stand-in window:
// fetch answers from `routes` (url -> body text), and a minimal
// XMLHttpRequest answers the same way. Returns the context and the accepted
// ids reported to content.js.
function loadInject(routes) {
  const document = new EventTarget();
  const reports = [];
  const slugs = [];
  document.addEventListener('leetcode-capture:submission-accepted', (e) => {
    assert.equal(typeof e.detail, 'string', 'the detail is a JSON string');
    const detail = JSON.parse(e.detail);
    reports.push(detail.submissionId);
    slugs.push(detail.slug);
  });
  const calls = [];
  const fetch = async function (input) {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, self: this });
    const body = routes[new URL(url, 'https://leetcode.com/problems/two-sum/').pathname];
    return new Response(body === undefined ? 'not found' : body, { status: body === undefined ? 404 : 200 });
  };
  class XMLHttpRequest extends EventTarget {
    constructor() {
      super();
      this.responseType = '';
    }
    open(method, url) {
      this.url = url;
    }
    send() {
      queueMicrotask(() => {
        const text = routes[new URL(this.url, 'https://leetcode.com/problems/two-sum/').pathname] || '';
        if (this.responseType === 'json') this.response = JSON.parse(text);
        else this.responseText = text;
        this.dispatchEvent(new Event('load'));
      });
    }
  }
  const location = new URL('https://leetcode.com/problems/two-sum/description/');
  const context = { document, fetch, XMLHttpRequest, CustomEvent, URL, JSON, location };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(here, 'inject.js'), 'utf8'), context);
  // An in-app move to another problem, as LeetCode's router does.
  const moveTo = (slug) => {
    location.pathname = `/problems/${slug}/description/`;
  };
  return { context, reports, slugs, calls, moveTo };
}

const ACCEPTED = JSON.stringify({ state: 'SUCCESS', status_msg: 'Accepted', status_code: 10, task_name: 'judger.judgetask.Judge', total_correct: 63, total_testcases: 63 });
const tick = () => new Promise((r) => setTimeout(r, 10));

test('inject.js reports an accepted submission seen through fetch, once', async () => {
  const { context, reports, calls } = loadInject({
    '/submissions/detail/101/check/': ACCEPTED,
    '/submissions/detail/102/check/': JSON.stringify({ state: 'PENDING' }),
  });
  const res = await context.fetch('/submissions/detail/102/check/');
  assert.equal(await res.text(), JSON.stringify({ state: 'PENDING' }), 'the page reads its own response unchanged');
  await context.window.fetch('https://leetcode.com/submissions/detail/101/check/');
  await context.window.fetch(new Request('https://leetcode.com/submissions/detail/101/check/'));
  await tick();
  assert.deepEqual(reports, ['101']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].self, context, 'the page fetch runs with the page as this');
});

test('inject.js ignores a Run, a wrong answer, an error and unrelated requests', async () => {
  const { context, reports } = loadInject({
    '/submissions/detail/runcode_1699.5_abc/check/': JSON.stringify({ state: 'SUCCESS', status_msg: 'Accepted', status_code: 10 }),
    '/submissions/detail/201/check/': JSON.stringify({ state: 'SUCCESS', status_msg: 'Wrong Answer', status_code: 11 }),
    '/submissions/detail/202/check/': JSON.stringify({ state: 'SUCCESS', status_msg: 'Accepted', task_name: 'judger.runcodetask.RunCode' }),
    '/submissions/detail/203/check/': JSON.stringify({ state: 'STARTED' }),
    '/submissions/detail/204/check/': 'not json',
    '/submissions/detail/205/check/': JSON.stringify({ state: 'SUCCESS', status_msg: 'Accepted', status_code: 15 }),
    '/submissions/detail/206/': ACCEPTED,
    '/graphql/': ACCEPTED,
  });
  for (const url of [
    '/submissions/detail/runcode_1699.5_abc/check/',
    '/submissions/detail/201/check/',
    '/submissions/detail/202/check/',
    '/submissions/detail/203/check/',
    '/submissions/detail/204/check/',
    '/submissions/detail/205/check/',
    '/submissions/detail/206/',
    '/graphql/',
    '/submissions/detail/999/check/',
  ]) await context.fetch(url);
  await tick();
  assert.deepEqual(reports, []);
});

test('inject.js also reads the /v2/check/ path LeetCode polls today, and still ignores other paths', async () => {
  const { context, reports } = loadInject({
    '/submissions/detail/401/v2/check/': ACCEPTED,
    '/submissions/detail/402/v3/check/': ACCEPTED,
    '/submissions/detail/403/v2/check/': JSON.stringify({ state: 'SUCCESS', status_msg: 'Wrong Answer', status_code: 11 }),
  });
  await context.fetch('/submissions/detail/401/v2/check/');
  await context.fetch('/submissions/detail/402/v3/check/');
  await context.fetch('/submissions/detail/403/v2/check/');
  await tick();
  assert.deepEqual(reports, ['401']);
});

test('inject.js names the problem a submission\'s first check started on, even when the verdict comes after a move', async () => {
  const routes = { '/submissions/detail/601/v2/check/': JSON.stringify({ state: 'PENDING' }), '/submissions/detail/602/check/': ACCEPTED };
  const { context, reports, slugs, moveTo } = loadInject(routes);
  // fetch: the first poll starts on two-sum; the page moves to 3sum, and the
  // next poll brings the verdict.
  await context.fetch('/submissions/detail/601/v2/check/');
  moveTo('3sum');
  routes['/submissions/detail/601/v2/check/'] = ACCEPTED;
  await context.fetch('/submissions/detail/601/v2/check/');
  await tick();
  // XMLHttpRequest: opened on 3sum, the page moves before the answer.
  const xhr = new context.XMLHttpRequest();
  xhr.open('GET', '/submissions/detail/602/check/');
  moveTo('valid-anagram');
  xhr.send();
  await tick();
  assert.deepEqual(reports, ['601', '602']);
  assert.deepEqual(slugs, ['two-sum', '3sum']);
});

test('inject.js reports nothing for a check that started off a problem page', async () => {
  const { context, reports } = loadInject({ '/submissions/detail/702/v2/check/': ACCEPTED });
  context.location.pathname = '/problemset/';
  await context.fetch('/submissions/detail/702/v2/check/');
  await tick();
  assert.deepEqual(reports, []);
});

test('inject.js reports an accepted submission seen through XMLHttpRequest, text or json', async () => {
  const { context, reports } = loadInject({
    '/submissions/detail/301/check/': ACCEPTED,
    '/submissions/detail/302/check/': ACCEPTED,
    '/submissions/detail/303/check/': JSON.stringify({ state: 'SUCCESS', status_msg: 'Time Limit Exceeded', status_code: 14 }),
  });
  const run = (url, type = '') => {
    const xhr = new context.XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = type;
    xhr.send();
  };
  run('/submissions/detail/301/check/');
  run('/submissions/detail/301/check/');
  run('/submissions/detail/302/check/?x=1', 'json');
  run('/submissions/detail/303/check/');
  await tick();
  assert.deepEqual(reports, ['301', '302']);
});

test('inject.js wraps only once when it runs twice, and a reused request follows its newest address', async () => {
  const { context, reports } = loadInject({ '/submissions/detail/401/check/': ACCEPTED, '/other/': ACCEPTED });
  const fetchBefore = context.fetch;
  const openBefore = context.XMLHttpRequest.prototype.open;
  vm.runInContext(fs.readFileSync(path.join(here, 'inject.js'), 'utf8'), context);
  assert.equal(context.fetch, fetchBefore);
  assert.equal(context.XMLHttpRequest.prototype.open, openBefore);
  const xhr = new context.XMLHttpRequest();
  xhr.open('GET', '/submissions/detail/401/check/');
  xhr.open('GET', '/other/');
  xhr.send();
  await tick();
  assert.deepEqual(reports, []);
});

// ---- content.js: forwarding to the worker and the panel --------------------

test('content.js forwards an accepted submission once and hands the card to the panel', async () => {
  const { handleAccepted } = require('./content.js');
  const events = new EventTarget();
  const solved = [];
  events.addEventListener('leetcode-capture:solved', (e) => solved.push(JSON.parse(e.detail)));
  const sent = [];
  const card = congratulation({ 'two-sum': { at: 't', count: 1 } }, 'two-sum');
  const send = async (m) => {
    sent.push(m);
    return { ok: true, recorded: true, card };
  };
  const opts = { events, send, slugOf: () => 'two-sum', titleOf: () => 'Two Sum' };
  const ev = (detail) => ({ detail });
  await handleAccepted(ev(JSON.stringify({ submissionId: '501', slug: 'two-sum' })), opts);
  await handleAccepted(ev(JSON.stringify({ submissionId: '501', slug: 'two-sum' })), opts);
  await handleAccepted(ev('not json'), opts);
  await handleAccepted(ev(JSON.stringify({ submissionId: 'runcode_1', slug: 'two-sum' })), opts);
  // Checked on another problem than the page shows now, or not said: dropped.
  await handleAccepted(ev(JSON.stringify({ submissionId: '505', slug: '3sum' })), opts);
  await handleAccepted(ev(JSON.stringify({ submissionId: '506' })), opts);
  assert.deepEqual(sent, [{ type: 'lc-tutor:accepted', submissionId: '501', slug: 'two-sum' }], 'nothing but the id and the checked slug go to the worker');
  assert.deepEqual(solved, [{ slug: 'two-sum', pageTitle: 'Two Sum', card }]);
  // A worker that records nothing (already seen) or cannot be asked: no card.
  await handleAccepted(ev(JSON.stringify({ submissionId: '502', slug: 'two-sum' })), { ...opts, send: async () => ({ ok: true, recorded: false, card: null }) });
  await handleAccepted(ev(JSON.stringify({ submissionId: '503', slug: 'two-sum' })), { ...opts, send: async () => null });
  await handleAccepted(ev(JSON.stringify({ submissionId: '504', slug: 'two-sum' })), { ...opts, slugOf: () => null });
  assert.equal(solved.length, 1);
});
