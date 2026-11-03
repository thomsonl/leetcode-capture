import test from 'node:test';
import assert from 'node:assert/strict';
import { NEETCODE_150, progress, unlockedTopics, nextOnRoadmap, moreOfTopic, suggestAfterSolve, problemUrl } from './shared/roadmap.js';

const R = NEETCODE_150;
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
