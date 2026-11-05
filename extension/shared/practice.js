// extension/shared/practice.js - "Practice a skill": problems from all of
// LeetCode (shared/problem-index.js, bundled public metadata) for one skill,
// ranked by popularity near a reference difficulty. Pure: no storage, no
// network, no Node or browser APIs (extension/shared.test.js checks that).
//
// Skills are a fixed friendly list mapped onto LeetCode's own topic tags,
// never the tags of the problem the student is on, so a suggestion never
// hints at how that problem is solved.
//
// Mapping decisions (SKILLS below):
//   - A skill matches a problem when any one of its `tags` entries matches.
//     An entry is a tag slug, or an array of slugs that must all be present
//     (Graphs counts a grid search, BFS or DFS together with Matrix, since
//     LeetCode tags Number of Islands and Rotting Oranges that way and never
//     "graph").
//   - Graphs ("Graph Theory" on LeetCode, slug `graph`) also takes Union
//     Find and the specialised graph tags (topological sort, shortest path,
//     Dijkstra, DAGs, bipartite graphs, minimum spanning trees, strongly
//     connected components, Eulerian circuits, biconnected components).
//   - Trees take Tree, Binary Tree and Binary Search Tree; Linked lists take
//     Doubly-Linked List; Dynamic programming takes Memoization; Bit
//     manipulation takes Bitmask; Math takes Number Theory, Combinatorics
//     and Geometry; Strings take String Matching; Dynamic programming also
//     takes Knapsack and DP on Trees; Heaps take the lone Heap tag.
//   - LeetCode has no intervals tag, so Intervals is Sweep Line, a problem
//     of a bundled list's Intervals topic (`listTopic`), or a title naming an
//     interval together with Sorting, Greedy, a heap or an ordered set
//     (`titles`; a title alone also caught "Count Odd Numbers in an Interval
//     Range" and a JavaScript exercise).
//   - Left out on purpose: Sorting, Simulation, Counting, Enumeration and
//     similar tags (an aid in most problems, not a skill to practice on its
//     own), Database (SQL, which the SQL 50 list covers), Concurrency and
//     Shell.
//
// Ranking (practiceSuggestions):
//   - Candidates: the skill matches, not paid-only, not solved, not the
//     excluded problem (the one the student is on).
//   - Tiers by difficulty: the reference level first, then one level up,
//     then one level down (Easy: Easy, Medium; Medium: Medium, Hard, Easy;
//     Hard: Hard, Medium). No reference (a problem the index does not have):
//     one tier of every level.
//   - Within a tier, by score: LeetCode likes, times CURATED_BOOST when the
//     problem is on one of the bundled lists (shared/roadmap.js LISTS); then
//     total submissions, then frontend id, then slug, so the order is stable.

import { PROBLEM_INDEX } from './problem-index.js';
import { LISTS } from './roadmap.js';

export const LEVELS = ['Easy', 'Medium', 'Hard'];
export const PAGE_SIZE = 3;
export const CURATED_BOOST = 1.25;
const PAID = 1;

const GRAPH_TAGS = ['graph', 'union-find', 'topological-sort', 'shortest-path', 'dijkstra', 'directed-acyclic-graph', 'bipartite-graph', 'minimum-spanning-tree', 'strongly-connected-component', 'eulerian-circuit', 'biconnected-component'];

// In the order the chips show: the basics first, then structures, then
// techniques.
export const SKILLS = [
  { id: 'arrays', label: 'Arrays', tags: ['array'] },
  { id: 'hash-maps', label: 'Hash maps', tags: ['hash-table'] },
  { id: 'strings', label: 'Strings', tags: ['string', 'string-matching'] },
  { id: 'two-pointers', label: 'Two pointers', tags: ['two-pointers'] },
  { id: 'sliding-window', label: 'Sliding window', tags: ['sliding-window'] },
  { id: 'stacks', label: 'Stacks', tags: ['stack'] },
  { id: 'monotonic-stack', label: 'Monotonic stack', tags: ['monotonic-stack'] },
  { id: 'binary-search', label: 'Binary search', tags: ['binary-search'] },
  { id: 'linked-lists', label: 'Linked lists', tags: ['linked-list', 'doubly-linked-list'] },
  { id: 'trees', label: 'Trees', tags: ['tree', 'binary-tree', 'binary-search-tree'] },
  { id: 'tries', label: 'Tries', tags: ['trie'] },
  { id: 'heaps', label: 'Heaps', tags: ['heap-priority-queue', 'heap'] },
  { id: 'graphs', label: 'Graphs', tags: [...GRAPH_TAGS, ['breadth-first-search', 'matrix'], ['depth-first-search', 'matrix']] },
  { id: 'backtracking', label: 'Backtracking', tags: ['backtracking'] },
  { id: 'dynamic-programming', label: 'Dynamic programming', tags: ['dynamic-programming', 'memoization', 'knapsack-problem', 'dp-on-trees'] },
  { id: 'greedy', label: 'Greedy', tags: ['greedy'] },
  { id: 'intervals', label: 'Intervals', tags: ['sweep-line'], listTopic: /^intervals?$/i, titles: { pattern: /\bintervals?\b/i, withAny: ['sorting', 'greedy', 'heap-priority-queue', 'ordered-set'] } },
  { id: 'bit-manipulation', label: 'Bit manipulation', tags: ['bit-manipulation', 'bitmask'] },
  { id: 'math', label: 'Math', tags: ['math', 'number-theory', 'combinatorics', 'geometry'] },
  { id: 'design', label: 'Design', tags: ['design'] },
];

const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

export function skillById(id) {
  return (typeof id === 'string' && SKILL_BY_ID.get(id)) || null;
}

// What the panel shows of the list: ids and labels only.
export function skillChoices() {
  return SKILLS.map((s) => ({ id: s.id, label: s.label }));
}

// The index decoded once: { bySlug, problems: [{ id, slug, title, level,
// paid, likes, submissions, tags: Set<slug>, curated: list title or null }] }.
const cache = new WeakMap();
function decode(index) {
  let decoded = cache.get(index);
  if (decoded) return decoded;
  const onList = new Map();
  const topics = new Map(); // slug -> titles of the list topics that have it
  for (const list of LISTS) for (const topic of list.topics) for (const p of topic.problems) {
    if (!onList.has(p.slug)) onList.set(p.slug, list.title);
    topics.set(p.slug, [...(topics.get(p.slug) || []), topic.title]);
  }
  const problems = index.problems.map(([id, slug, title, level, flags, likes, submissions, tags]) => ({
    id,
    slug,
    title,
    level,
    paid: (flags & PAID) === PAID,
    likes,
    submissions,
    tags: new Set(tags.map((t) => index.tags[t][0])),
    curated: onList.get(slug) || null,
    topics: topics.get(slug) || [],
  }));
  decoded = { problems, bySlug: new Map(problems.map((p) => [p.slug, p])), ranked: new Map() };
  cache.set(index, decoded);
  return decoded;
}

export function problemBySlug(slug, index = PROBLEM_INDEX) {
  const p = typeof slug === 'string' ? decode(index).bySlug.get(slug) : null;
  return p ? { slug: p.slug, title: p.title, difficulty: LEVELS[p.level], paid: p.paid } : null;
}

// The difficulty of a problem the index has, or null.
export function referenceLevel(slug, index = PROBLEM_INDEX) {
  const p = problemBySlug(slug, index);
  return p ? p.difficulty : null;
}

export function matchesSkill(skill, problem) {
  for (const entry of skill.tags) {
    if (Array.isArray(entry) ? entry.every((t) => problem.tags.has(t)) : problem.tags.has(entry)) return true;
  }
  if (skill.listTopic && (problem.topics || []).some((t) => skill.listTopic.test(t))) return true;
  return Boolean(skill.titles && skill.titles.pattern.test(problem.title) && skill.titles.withAny.some((t) => problem.tags.has(t)));
}

// The levels in the order they are offered for a reference level; null
// means one tier of all levels.
export function levelTiers(reference) {
  const level = LEVELS.indexOf(reference);
  if (level < 0) return [[0, 1, 2]];
  return [level, level + 1, level - 1].filter((l) => l >= 0 && l < LEVELS.length).map((l) => [l]);
}

function score(p) {
  return p.likes * (p.curated ? CURATED_BOOST : 1);
}

function compare(a, b) {
  return score(b) - score(a) || b.submissions - a.submissions || compareIds(a.id, b.id) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

function compareIds(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

// Every free problem of the skill in offer order for a reference level,
// solved or not (filtered per call), cached per skill and level.
function rankedFor(skill, reference, index) {
  const decoded = decode(index);
  const key = `${skill.id}|${reference || ''}`;
  let ranked = decoded.ranked.get(key);
  if (ranked) return ranked;
  const matching = decoded.problems.filter((p) => !p.paid && matchesSkill(skill, p));
  ranked = [];
  for (const tier of levelTiers(reference)) ranked.push(...matching.filter((p) => tier.includes(p.level)).sort(compare));
  decoded.ranked.set(key, ranked);
  return ranked;
}

export function formatCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1e6) return `${Math.floor(n / 1000)}k`;
  return `${(Math.floor(n / 1e5) / 10).toFixed(1).replace(/\.0$/, '')}M`;
}

const RELATION = { 0: 'Same level', 1: 'One level up', '-1': 'One level down' };

// The one short line under a suggestion: how its level compares, how liked
// it is, and the first bundled list that has it. Nothing about how to solve
// it, or the problem the student is on.
export function reasonFor(problem, reference) {
  const parts = [];
  const ref = LEVELS.indexOf(reference);
  if (ref >= 0) parts.push(RELATION[problem.level - ref]);
  parts.push(`${formatCount(problem.likes)} ${problem.likes === 1 ? 'like' : 'likes'}`);
  if (problem.curated) parts.push(`on ${problem.curated}`);
  return parts.join(' · ');
}

function solvedSet(solved) {
  if (solved instanceof Set) return solved;
  if (Array.isArray(solved)) return new Set(solved);
  if (solved && typeof solved === 'object') return new Set(Object.keys(solved));
  return new Set();
}

// The suggestions for one skill:
//   { skill: { id, label } | null, reference, suggestions: [{ slug, title,
//     difficulty, reason }], offset, total, more }
// `reference` is 'Easy', 'Medium', 'Hard' or null; `solved` a Set, an array
// of slugs or the solved store's record; `exclude` a slug never offered
// (the problem the student is on); `offset` how many were shown already.
// An unknown skill answers no suggestions.
export function practiceSuggestions({ skill, reference = null, solved, exclude = null, offset = 0, count = PAGE_SIZE, index = PROBLEM_INDEX } = {}) {
  const found = typeof skill === 'string' ? skillById(skill) : skill && SKILL_BY_ID.get(skill.id) === skill ? skill : null;
  const level = LEVELS.includes(reference) ? reference : null;
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const size = Number.isInteger(count) && count > 0 ? Math.min(count, 20) : PAGE_SIZE;
  if (!found) return { skill: null, reference: level, suggestions: [], offset: 0, total: 0, more: false };
  const done = solvedSet(solved);
  const skip = new Set(Array.isArray(exclude) ? exclude : exclude ? [exclude] : []);
  const open = rankedFor(found, level, index).filter((p) => !done.has(p.slug) && !skip.has(p.slug));
  const page = open.slice(start, start + size);
  return {
    skill: { id: found.id, label: found.label },
    reference: level,
    suggestions: page.map((p) => ({ slug: p.slug, title: p.title, difficulty: LEVELS[p.level], reason: reasonFor(p, level) })),
    offset: start,
    total: open.length,
    more: start + size < open.length,
  };
}
