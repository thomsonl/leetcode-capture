import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NEETCODE_150, NEETCODE_250, BLIND_75, GRIND_75, TOP_100_LIKED, TOP_INTERVIEW_150, SQL_50, LISTS, ROADMAPS, DEFAULT_LIST_ID, listById, problemInList, progress, unlockedTopics, nextOnRoadmap, moreOfTopic, suggestAfterSolve, problemUrl } from './shared/roadmap.js';
import { CATALOG, catalogEntry } from './shared/catalog.js';
import vm from 'node:vm';
import { checkSnippet, listSlugs, OUT } from './scripts/list-slugs.mjs';
import { grindSchedule, blindGroups, neetcodeProblems } from './scripts/list-sources.mjs';

const R = NEETCODE_150;

// The publishers' own data as fetched (see each file's first line):
// { section: [{ title, slugs: [[slug, 'E' | 'M' | 'H', ...]] }] } (Blind 75's
// post gives no difficulty, so its rows are [slug]).
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

const SIZES = { 'neetcode-150': [150, 18], 'neetcode-250': [250, 18], 'blind-75': [75, 10], 'grind-75': [75, 8], 'top-100-liked': [100, 15], 'top-interview-150': [150, 23], 'sql-50': [50, 7] };

test('the lists, in the selector order, with their sizes and group counts', () => {
  assert.deepEqual(LISTS.map((l) => l.id), ['neetcode-150', 'neetcode-250', 'blind-75', 'grind-75', 'top-100-liked', 'top-interview-150', 'sql-50']);
  assert.equal(DEFAULT_LIST_ID, 'neetcode-150');
  for (const list of LISTS) {
    const [size, groups] = SIZES[list.id];
    const slugs = list.topics.flatMap((t) => t.problems.map((p) => p.slug));
    assert.equal(list.size, size, list.id);
    assert.equal(slugs.length, size, list.id);
    assert.equal(new Set(slugs).size, size, `${list.id} has a problem twice`);
    assert.equal(list.topics.length, groups, list.id);
    assert.equal(new Set(list.topics.map((t) => t.id)).size, groups, `${list.id} group ids`);
    assert.ok(list.title && list.groupNoun, list.id);
    for (const t of list.topics) {
      assert.ok(t.problems.length > 0, `${list.id}/${t.id} is empty`);
      for (const p of t.problems) {
        assert.match(p.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
        assert.equal(p.topic, t.id);
      }
    }
    assert.equal(list.kind, list.id.startsWith('neetcode-') ? 'graph' : 'groups', list.id);
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

test('NeetCode 150 and 250 match neetcode.io\'s own lists: each topic\'s problems in its order', () => {
  const lists = snapshot('neetcode-lists.txt');
  for (const [flag, list] of [['neetcode150', NEETCODE_150], ['neetcode250', NEETCODE_250]]) {
    const site = new Map(lists[flag].map((g) => [g.title, g.slugs.map(([slug]) => slug)]));
    assert.equal(site.size, list.topics.length, flag);
    for (const t of list.topics) assert.deepEqual(t.problems.map((p) => p.slug), site.get(t.title), `${flag}/${t.title}`);
  }
});

test('Blind 75 is the original post: its categories, their order and each one\'s problems in order', () => {
  const post = snapshot('blind-75.txt')['blind-75'];
  assert.deepEqual(BLIND_75.topics.map((t) => t.title), post.map((g) => g.title));
  // The post lists Merge K Sorted Lists twice (Linked List and Heap); the
  // list keeps the first.
  const seen = new Set();
  BLIND_75.topics.forEach((t, i) => {
    const once = post[i].slugs.map(([slug]) => slug).filter((slug) => !seen.has(slug));
    once.forEach((slug) => seen.add(slug));
    assert.deepEqual(t.problems.map((p) => p.slug), once, t.title);
  });
  assert.equal(post.flatMap((g) => g.slugs).length, 76);
  // neetcode.io's Blind 75 differs by one problem, the post's Combination Sum
  // link (Combination Sum IV), which neetcode.io swaps for Combination Sum.
  const nc = new Set(snapshot('neetcode-lists.txt').blind75.flatMap((g) => g.slugs.map(([slug]) => slug)));
  const ours = new Set(BLIND_75.topics.flatMap((t) => t.problems.map((p) => p.slug)));
  assert.equal(nc.size, 75);
  assert.deepEqual([...ours].filter((s) => !nc.has(s)), ['combination-sum-iv']);
  assert.deepEqual([...nc].filter((s) => !ours.has(s)), ['combination-sum']);
});

test('Grind 75 is the site\'s default schedule: its weeks, the problems in order and their difficulty', () => {
  const site = snapshot('grind-75.txt')['grind-75'];
  assert.deepEqual(GRIND_75.topics.map((t) => t.title), site.map((g) => g.title));
  // The site still grades this one Easy; LeetCode (and so the catalog) says Medium.
  const regraded = { 'lowest-common-ancestor-of-a-binary-search-tree': 'Medium' };
  GRIND_75.topics.forEach((t, i) => {
    assert.deepEqual(t.problems.map((p) => p.slug), site[i].slugs.map(([slug]) => slug), t.title);
    for (const [slug, d] of site[i].slugs) assert.equal(GRIND_75.topics[i].problems.find((p) => p.slug === slug).difficulty, regraded[slug] || DIFFICULTY[d], slug);
  });
  assert.deepEqual(GRIND_75.topics.map((t) => t.problems.length), [13, 12, 8, 8, 8, 9, 7, 10]);
});

test('the source script reads each site the way the site does', () => {
  // Grind 75: by priority while the budget lasts (120 minutes: b and c fit,
  // a would not), then by difficulty
  // (stable), cut into weeks of 60 * hours minutes, the last week the rest.
  const q = (slug, priority, difficulty, duration) => ({ slug, priority, difficulty, duration });
  const weeks = grindSchedule([q('a', 3, 'Easy', 30), q('b', 1, 'Hard', 30), q('c', 2, 'Easy', 20), q('d', 4, 'Medium', 30), q('e', 5, 'Easy', 15)], { weeks: 2, hours: 1 });
  assert.deepEqual(weeks.map(([title, qs]) => [title, qs.map((x) => x.slug)]), [['Week 1', ['c']], ['Week 2', ['b']]]);
  // The Blind post: categories, links, a missing link resolved by title, a renamed slug.
  const text = 'Intro\n\nArray\n\n- Two Sum - https://leetcode.com/problems/two-sum/\n\n---\n\nDynamic Programming\n\n- Longest Common Subsequence - \n\nTree\n\n- Add and Search Word - https://leetcode.com/problems/add-and-search-word-data-structure-design/\n\nYou\'re welcome!';
  assert.deepEqual(blindGroups(text.replace('Intro', 'New Year Gift')), [['Array', ['two-sum']], ['Dynamic Programming', ['longest-common-subsequence']], ['Tree', ['design-add-and-search-words-data-structure']]]);
  // neetcode.io's problem objects, flags written as !0.
  assert.deepEqual(neetcodeProblems('x=[{problem:"Two Sum",pattern:"Arrays & Hashing",link:"two-sum/",difficulty:"Easy",neetcode150:!0,blind75:!0}]').map((p) => [p.slug, p.pattern, p.neetcode150, p.neetcode250]), [['two-sum', 'Arrays & Hashing', true, undefined]]);
});

test('NeetCode 250 is NeetCode 150 and 100 more, on the same roadmap', () => {
  const in250 = new Set(NEETCODE_250.topics.flatMap((t) => t.problems.map((p) => p.slug)));
  for (const p of NEETCODE_150.topics.flatMap((t) => t.problems)) {
    assert.ok(in250.has(p.slug), p.slug);
    assert.equal(problemInList(NEETCODE_250, p.slug).topic, p.topic, `${p.slug} keeps its topic`);
  }
  assert.equal(in250.size - 150, 100);
  assert.deepEqual(NEETCODE_250.topics.map((t) => [t.id, t.title]), NEETCODE_150.topics.map((t) => [t.id, t.title]));
  assert.deepEqual(NEETCODE_250.edges, NEETCODE_150.edges);
  assert.deepEqual(nextOnRoadmap(NEETCODE_250, [], { count: 2 }).map((p) => p.slug), ['concatenation-of-array', 'contains-duplicate']);
});

test('only the NeetCode roadmaps have prerequisite lines, and they join their own topics', () => {
  for (const list of LISTS) {
    const ids = new Set(list.topics.map((t) => t.id));
    if (list.kind !== 'graph') assert.deepEqual(list.edges, [], list.id);
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
  assert.equal(problemInList(GRIND_75, 'two-sum').subject, 'arrays-hashing');
});

test('every list groups by subject: Grind 75, whose groups are weeks, also has one subject per problem', () => {
  for (const list of LISTS) assert.equal(Boolean(list.subjects), list.id === 'grind-75', list.id);
  const subjects = GRIND_75.subjects;
  const problems = GRIND_75.topics.flatMap((t) => t.problems);
  assert.equal(subjects.flatMap((s) => s.problems).length, 75);
  assert.equal(new Set(subjects.flatMap((s) => s.problems.map((p) => p.slug))).size, 75);
  const order = new Map(problems.map((p, i) => [p.slug, i]));
  for (const s of subjects) {
    assert.ok(s.problems.length > 0, s.id);
    // In the list's order, and the same problem objects the weeks hold.
    for (let i = 1; i < s.problems.length; i += 1) assert.ok(order.get(s.problems[i - 1].slug) < order.get(s.problems[i].slug), s.id);
    for (const p of s.problems) assert.equal(p.subject, s.id);
  }
  for (const p of problems) assert.ok(problems.includes(p) && subjects.some((s) => s.problems.includes(p)), p.slug);
  // NeetCode's topic names and order, and a NeetCode 150 problem keeps its topic.
  const nc = NEETCODE_150.topics.map((t) => t.id);
  assert.deepEqual(subjects.map((s) => s.id), nc.filter((id) => subjects.some((s) => s.id === id)));
  for (const s of subjects) assert.equal(s.title, NEETCODE_150.topics.find((t) => t.id === s.id).title);
  // Each problem's subject is the topic neetcode.io gives it (NeetCode 150,
  // else NeetCode 250, else neetcode.io's full catalog); only the four
  // neetcode.io does not have are judgment calls (see the data's comment).
  const site = snapshot('neetcode-lists.txt');
  const titleOf = new Map(subjects.map((s) => [s.id, s.title]));
  const judged = { '01-matrix': 'graphs', 'first-bad-version': 'binary-search', 'string-to-integer-atoi': 'arrays-hashing', 'basic-calculator': 'stack' };
  for (const p of problems) {
    const inNc = problemInList(NEETCODE_150, p.slug) || problemInList(NEETCODE_250, p.slug);
    const other = site['grind75-others'].find((g) => g.slugs.some(([slug]) => slug === p.slug));
    if (inNc) assert.equal(p.subject, inNc.topic, p.slug);
    else if (other) assert.equal(titleOf.get(p.subject), other.title, p.slug);
    else assert.equal(p.subject, judged[p.slug], `${p.slug} is on no neetcode.io list`);
  }
  assert.equal(problems.filter((p) => judged[p.slug]).length, 4);
  // The weeks stay the order: what comes next does not change with subjects.
  assert.equal(nextOnRoadmap(GRIND_75, ['two-sum'])[0].slug, 'valid-parentheses');
  assert.equal(moreOfTopic(GRIND_75, [], 'two-sum').topic.id, 'arrays-hashing');
});

test('an unknown or damaged list id means NeetCode 150', () => {
  assert.equal(listById('grind-75'), GRIND_75);
  for (const bad of [undefined, null, '', 'nope', 'toString', '__proto__', 7, {}]) assert.equal(listById(bad), NEETCODE_150, String(bad));
  assert.equal(ROADMAPS['blind-75'], BLIND_75);
});

test('extension/e2e/list-slugs.json matches the catalog (regenerate with node extension/scripts/list-slugs.mjs)', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(OUT, 'utf8')), listSlugs());
});

test('the console check asks LeetCode for every slug and reports only the ones that differ', async () => {
  const data = listSlugs();
  const requests = [];
  // A stand-in for LeetCode's GraphQL: knows every slug but one, and spells
  // one title differently.
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const answer = {};
    for (const [, alias, slug] of JSON.parse(init.body).query.matchAll(/(q\d+): question\(titleSlug: "([^"]+)"\)/g)) {
      const p = data.problems.find((x) => x.slug === slug);
      if (slug === 'two-sum') answer[alias] = null;
      else answer[alias] = { titleSlug: slug, title: slug === 'move-zeroes' ? 'Move Zeros' : p.title, difficulty: p.difficulty };
    }
    return { json: async () => ({ data: answer }) };
  };
  const logs = [];
  const problems = await vm.runInNewContext(checkSnippet(data), { fetch, document: { cookie: 'a=b; csrftoken=tok' }, console: { log: (m) => logs.push(m), table: () => {} } });
  // Objects from the script's own realm: compared as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(problems)), [{ slug: 'two-sum', problem: 'unknown slug' }, { slug: 'move-zeroes', expected: 'Move Zeroes (Easy)', leetcode: 'Move Zeros (Easy)' }]);
  assert.equal(requests.length, Math.ceil(data.problems.length / 25));
  assert.ok(requests.every((r) => r.url === '/graphql/' && r.init.headers['x-csrftoken'] === 'tok'));
  assert.equal(logs[0], `${data.problems.length} slugs checked, 2 differ`);
});
