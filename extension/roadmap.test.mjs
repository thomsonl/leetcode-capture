import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NEETCODE_150, BLIND_75, GRIND_75, TOP_100_LIKED, TOP_INTERVIEW_150, SQL_50, LISTS, ROADMAPS, DEFAULT_LIST_ID, listById, problemInList, progress, unlockedTopics, nextOnRoadmap, moreOfTopic, suggestAfterSolve, problemUrl } from './shared/roadmap.js';
import { CATALOG, catalogEntry } from './shared/catalog.js';
import { listSlugs, OUT } from './scripts/list-slugs.mjs';

const R = NEETCODE_150;

// The publishers' own data as fetched (see each file's first line):
// { planId: [{ title, slugs: [[slug, 'E' | 'M' | 'H']] }] }.
function snapshot(name) {
  const plans = {};
  let plan = null;
  for (const line of fs.readFileSync(new URL(`./e2e/${name}`, import.meta.url), 'utf8').split('\n').slice(1)) {
    if (line.startsWith('=== ')) plans[line.slice(4).trim()] = plan = [];
    else if (line.startsWith('#')) plan.push({ title: line.slice(1), slugs: [] });
    else if (line.trim()) plan.at(-1).slugs.push(line.split('|'));
  }
  return plans;
}
const DIFFICULTY = { E: 'Easy', M: 'Medium', H: 'Hard' };
const all = R.topics.flatMap((t) => t.problems);

test('NeetCode 150 has 18 topics and exactly 150 unique problems', () => {
  assert.equal(R.topics.length, 18);
  assert.equal(all.length, 150);
  assert.equal(new Set(all.map((p) => p.slug)).size, 150);
  for (const p of all) {
    assert.match(p.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(['Easy', 'Medium', 'Hard'].includes(p.difficulty), p.slug);
    assert.ok(p.title, p.slug);
  }
});

test('every prerequisite line joins two real topics and the graph has no cycle', () => {
  const ids = new Set(R.topics.map((t) => t.id));
  for (const [a, b] of R.edges) assert.ok(ids.has(a) && ids.has(b) && a !== b, `${a} -> ${b}`);
  const order = new Map(R.topics.map((t, i) => [t.id, i]));
  // NeetCode's topic order is already a valid topological order.
  for (const [a, b] of R.edges) assert.ok(order.get(a) < order.get(b), `${a} before ${b}`);
});

test('progress counts per topic and ignores slugs outside the roadmap', () => {
  const p = progress(R, ['two-sum', 'contains-duplicate', 'not-on-the-roadmap']);
  assert.equal(p.solved, 2);
  assert.equal(p.total, 150);
  assert.deepEqual(p.topics[0], { id: 'arrays-hashing', title: 'Arrays & Hashing', solved: 2, total: 9, complete: false });
});

test('a fresh student starts at Arrays & Hashing and only that is unlocked', () => {
  assert.deepEqual([...unlockedTopics(R, [])], ['arrays-hashing']);
  assert.deepEqual(nextOnRoadmap(R, [], { count: 2 }).map((p) => p.slug), ['contains-duplicate', 'valid-anagram']);
});

test('starting a topic unlocks what it points to, and a topic needs all its parents started', () => {
  const open = unlockedTopics(R, ['two-sum']);
  assert.ok(open.has('two-pointers') && open.has('stack') && !open.has('trees'));
  const both = unlockedTopics(R, ['two-sum', 'valid-palindrome', 'binary-search', 'reverse-linked-list']);
  assert.ok(both.has('trees'), 'binary search and linked list both started');
  assert.ok(!unlockedTopics(R, ['two-sum', 'valid-palindrome', 'binary-search']).has('trees'), 'linked list not started yet');
});

test('the agenda skips solved problems and moves on in NeetCode order', () => {
  const next = nextOnRoadmap(R, ['contains-duplicate', 'two-sum'], { count: 1 });
  assert.equal(next[0].slug, 'valid-anagram');
});

test('more of the same topic gives unsolved problems, easiest first, never the one just solved', () => {
  const more = moreOfTopic(R, ['two-sum'], 'two-sum', { count: 3 });
  assert.equal(more.topic.id, 'arrays-hashing');
  assert.deepEqual(more.problems.map((p) => p.slug), ['contains-duplicate', 'valid-anagram', 'group-anagrams']);
  assert.deepEqual(moreOfTopic(R, [], 'unknown-slug'), { topic: null, problems: [] });
});

test('suggestAfterSolve counts the problem just solved', () => {
  const s = suggestAfterSolve(R, [], 'contains-duplicate', { count: 1 });
  assert.equal(s.roadmap.id, 'neetcode-150');
  assert.equal(s.agenda[0].slug, 'valid-anagram');
  assert.equal(s.sameTopic.topic.id, 'arrays-hashing');
  assert.ok(!s.sameTopic.problems.some((p) => p.slug === 'contains-duplicate'));
  assert.equal(problemUrl('two-sum'), 'https://leetcode.com/problems/two-sum/');
});

// ---- every list ------------------------------------------------------------

const SIZES = { 'neetcode-150': [150, 18], 'blind-75': [75, 10], 'grind-75': [75, 8], 'top-100-liked': [100, 15], 'top-interview-150': [150, 23], 'sql-50': [50, 7] };

test('the lists, in the selector order, with their sizes and group counts', () => {
  assert.deepEqual(LISTS.map((l) => l.id), ['neetcode-150', 'blind-75', 'grind-75', 'top-100-liked', 'top-interview-150', 'sql-50']);
  assert.equal(DEFAULT_LIST_ID, 'neetcode-150');
  for (const list of LISTS) {
    const [size, groups] = SIZES[list.id];
    const slugs = list.topics.flatMap((t) => t.problems.map((p) => p.slug));
    assert.equal(list.size, size, list.id);
    assert.equal(slugs.length, size, list.id);
    assert.equal(new Set(slugs).size, size, `${list.id} has a problem twice`);
    assert.equal(list.topics.length, groups, list.id);
    assert.equal(new Set(list.topics.map((t) => t.id)).size, groups, `${list.id} group ids`);
    assert.ok(list.title && list.description && list.groupNoun, list.id);
    assert.ok(!/[\u2013\u2014]/.test(list.description), `${list.id}: no en or em dash`);
    for (const t of list.topics) {
      assert.ok(t.problems.length > 0, `${list.id}/${t.id} is empty`);
      for (const p of t.problems) {
        assert.match(p.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
        assert.equal(p.topic, t.id);
      }
    }
    assert.equal(list.kind, list.id === 'neetcode-150' ? 'graph' : 'groups', list.id);
  }
});

test('the publishers\' groups, as they name them', () => {
  assert.deepEqual(BLIND_75.topics.map((t) => t.title), ['Array', 'Binary', 'Dynamic Programming', 'Graph', 'Interval', 'Linked List', 'Matrix', 'String', 'Tree', 'Heap']);
  assert.deepEqual(GRIND_75.topics.map((t) => t.title), ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5', 'Week 6', 'Week 7', 'Week 8']);
  assert.deepEqual(TOP_INTERVIEW_150.topics.map((t) => t.title), ['Array / String', 'Two Pointers', 'Sliding Window', 'Matrix', 'Hashmap', 'Intervals', 'Stack', 'Linked List', 'Binary Tree General', 'Binary Tree BFS', 'Binary Search Tree', 'Graph General', 'Graph BFS', 'Trie', 'Backtracking', 'Divide & Conquer', "Kadane's Algorithm", 'Binary Search', 'Heap', 'Bit Manipulation', 'Math', '1D DP', 'Multidimensional DP']);
  assert.deepEqual(SQL_50.topics.map((t) => t.title), ['Select', 'Basic Joins', 'Basic Aggregate Functions', 'Sorting and Grouping', 'Advanced Select and Joins', 'Subqueries', 'Advanced String Functions / Regex / Clause']);
  assert.equal(GRIND_75.topics[0].problems[0].slug, 'two-sum');
  assert.equal(TOP_INTERVIEW_150.topics[0].problems[0].slug, 'merge-sorted-array');
  assert.equal(SQL_50.topics[0].problems[0].slug, 'recyclable-and-low-fat-products');
  assert.deepEqual(TOP_100_LIKED.topics.map((t) => t.title), ['Backtracking', 'Binary Search', 'Binary Tree', 'Dynamic Programming', 'Graph', 'Greedy', 'Hashing', 'Heap', 'Linked Lists', 'Matrix', 'Sliding Window', 'Stack', 'Two Pointers', 'Trie', 'Misc']);
});

test('LeetCode\'s study plans match LeetCode\'s own data: sections, their order, the problems in order and their difficulty', () => {
  const plans = snapshot('leetcode-study-plans.txt');
  for (const [planId, list] of [['top-100-liked', TOP_100_LIKED], ['top-interview-150', TOP_INTERVIEW_150], ['top-sql-50', SQL_50]]) {
    const plan = plans[planId];
    assert.deepEqual(list.topics.map((t) => t.title), plan.map((g) => g.title), list.id);
    list.topics.forEach((t, i) => {
      assert.deepEqual(t.problems.map((p) => p.slug), plan[i].slugs.map(([slug]) => slug), `${list.id}/${t.title}`);
      assert.deepEqual(t.problems.map((p) => p.difficulty), plan[i].slugs.map(([, d]) => DIFFICULTY[d]), `${list.id}/${t.title} difficulty`);
    });
  }
});

test('NeetCode 150 matches neetcode.io\'s own list: each topic\'s problems in its order', () => {
  const site = new Map(snapshot('neetcode-lists.txt').neetcode150.map((g) => [g.title, g.slugs.map(([slug]) => slug)]));
  assert.equal(site.size, NEETCODE_150.topics.length);
  for (const t of NEETCODE_150.topics) assert.deepEqual(t.problems.map((p) => p.slug), site.get(t.title), t.title);
});

test('only NeetCode 150 has prerequisite lines, and they join its own topics', () => {
  for (const list of LISTS) {
    const ids = new Set(list.topics.map((t) => t.id));
    if (list.id !== 'neetcode-150') assert.deepEqual(list.edges, [], list.id);
    for (const [a, b] of list.edges) assert.ok(ids.has(a) && ids.has(b), `${list.id}: ${a} -> ${b}`);
  }
});

test('one catalog: every listed slug is in it, every entry is used, and lists share its title and difficulty', () => {
  const used = new Set();
  for (const list of LISTS) {
    for (const p of list.topics.flatMap((t) => t.problems)) {
      const entry = catalogEntry(p.slug);
      assert.ok(entry, `${list.id}: ${p.slug} has no catalog entry`);
      assert.equal(p.title, entry.title);
      assert.equal(p.difficulty, entry.difficulty);
      used.add(p.slug);
    }
  }
  for (const [slug, e] of CATALOG) {
    assert.ok(used.has(slug), `${slug} is in the catalog but on no list`);
    assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(['Easy', 'Medium', 'Hard'].includes(e.difficulty), slug);
    assert.ok(e.title && e.title === e.title.trim() && !/[\u2013\u2014]/.test(e.title), slug);
  }
  assert.equal(catalogEntry('not-a-problem'), null);
});

test('the shared problems: Blind 75 sits almost wholly inside NeetCode 150, and a solve counts in every list', () => {
  const nc = new Set(NEETCODE_150.topics.flatMap((t) => t.problems.map((p) => p.slug)));
  const outside = BLIND_75.topics.flatMap((t) => t.problems).filter((p) => !nc.has(p.slug)).map((p) => p.slug);
  assert.deepEqual(outside, ['combination-sum-iv']);
  for (const list of LISTS.filter((l) => l.id !== 'sql-50')) assert.equal(progress(list, ['two-sum', 'climbing-stairs']).solved, 2, list.id);
  assert.equal(progress(SQL_50, ['two-sum', 'big-countries']).solved, 1);
  // The five titles LeetCode spells differently from NeetCode's site.
  assert.equal(catalogEntry('merge-k-sorted-lists').title, 'Merge k Sorted Lists');
  assert.equal(catalogEntry('copy-list-with-random-pointer').title, 'Copy List with Random Pointer');
  assert.equal(catalogEntry('find-median-from-data-stream').title, 'Find Median from Data Stream');
});

test('a list without lines unlocks every group and moves on group by group in its order', () => {
  for (const list of [BLIND_75, GRIND_75, TOP_100_LIKED, TOP_INTERVIEW_150, SQL_50]) {
    assert.equal(unlockedTopics(list, []).size, list.topics.length, list.id);
    const first = list.topics[0].problems;
    assert.deepEqual(nextOnRoadmap(list, [], { count: 1 }).map((p) => p.slug), [first[0].slug], list.id);
    // Finishing the first group but its last problem keeps it next.
    const almost = first.slice(0, -1).map((p) => p.slug);
    assert.equal(nextOnRoadmap(list, almost)[0].slug, first.at(-1).slug, list.id);
    // Finishing it moves to the second group, even with later ones started.
    const done = [...first.map((p) => p.slug), list.topics[2].problems[0].slug];
    assert.equal(nextOnRoadmap(list, done)[0].topic, list.topics[1].id, list.id);
    const all = list.topics.flatMap((t) => t.problems.map((p) => p.slug));
    assert.deepEqual(nextOnRoadmap(list, all), [], list.id);
    assert.equal(progress(list, all).solved, list.size);
  }
});

test('per list progress, more of a group and the suggestion after a solve', () => {
  const g = progress(GRIND_75, ['two-sum', 'first-bad-version', 'big-countries']);
  assert.equal(g.solved, 2);
  assert.deepEqual(g.topics.slice(0, 2).map((t) => [t.id, t.solved, t.total]), [['week-1', 1, 13], ['week-2', 1, 12]]);
  const more = moreOfTopic(SQL_50, [], 'big-countries', { count: 2 });
  assert.equal(more.topic.title, 'Select');
  assert.ok(more.problems.every((p) => p.slug !== 'big-countries' && p.difficulty === 'Easy'));
  const s = suggestAfterSolve(BLIND_75, [], 'two-sum');
  assert.deepEqual(s.roadmap, { id: 'blind-75', title: 'Blind 75' });
  assert.equal(s.agenda[0].slug, 'best-time-to-buy-and-sell-stock');
  assert.equal(problemInList(SQL_50, 'two-sum'), null);
  assert.equal(problemInList(GRIND_75, 'two-sum').topic, 'week-1');
});

test('an unknown or damaged list id means NeetCode 150', () => {
  assert.equal(listById('grind-75'), GRIND_75);
  for (const bad of [undefined, null, '', 'nope', 'toString', '__proto__', 7, {}]) assert.equal(listById(bad), NEETCODE_150, String(bad));
  assert.equal(ROADMAPS['blind-75'], BLIND_75);
});

test('extension/e2e/list-slugs.json matches the catalog (regenerate with node extension/scripts/list-slugs.mjs)', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(OUT, 'utf8')), listSlugs());
});
