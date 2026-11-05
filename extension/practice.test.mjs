import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBLEM_INDEX } from './shared/problem-index.js';
import { CURATED_BOOST, SKILLS, formatCount, levelTiers, matchesSkill, practiceSuggestions, problemBySlug, reasonFor, referenceLevel, skillById, skillChoices } from './shared/practice.js';
import { LISTS } from './shared/roadmap.js';

// ---- the shipped dataset -------------------------------------------------

test('every skill maps only onto tags LeetCode has, and offers plenty of free problems at every level', () => {
  const known = new Set(PROBLEM_INDEX.tags.map((t) => t[0]));
  for (const skill of SKILLS) {
    for (const entry of skill.tags) for (const tag of [entry].flat()) assert.ok(known.has(tag), `${skill.id}: unknown tag ${tag}`);
    for (const level of ['Easy', 'Medium', 'Hard']) {
      const { total } = practiceSuggestions({ skill: skill.id, reference: level, solved: [] });
      assert.ok(total >= (skill.id === 'intervals' ? 9 : 20), `${skill.id} at ${level}: ${total}`);
    }
  }
});

test('the friendly list is 15 to 20 skills with unique ids and labels', () => {
  assert.ok(SKILLS.length >= 15 && SKILLS.length <= 20, `${SKILLS.length} skills`);
  assert.equal(new Set(SKILLS.map((s) => s.id)).size, SKILLS.length);
  assert.equal(new Set(SKILLS.map((s) => s.label)).size, SKILLS.length);
  assert.deepEqual(skillChoices()[0], { id: 'arrays', label: 'Arrays' });
  for (const s of skillChoices()) assert.deepEqual(Object.keys(s), ['id', 'label']);
});

test('real data: the classics come first, and a grid search counts as Graphs', () => {
  const hash = practiceSuggestions({ skill: 'hash-maps', reference: 'Easy', solved: [] });
  assert.equal(hash.suggestions[0].slug, 'two-sum');
  assert.equal(hash.suggestions[0].difficulty, 'Easy');
  assert.match(hash.suggestions[0].reason, /^Same level · \d+k likes · on NeetCode 150$/);
  const graphs = practiceSuggestions({ skill: 'graphs', reference: 'Medium', solved: [], count: 20 });
  assert.ok(graphs.suggestions.some((s) => s.slug === 'number-of-islands'), JSON.stringify(graphs.suggestions.map((s) => s.slug)));
  const intervals = practiceSuggestions({ skill: 'intervals', reference: 'Medium', solved: [], count: 10 });
  assert.ok(intervals.suggestions.some((s) => s.slug === 'merge-intervals'), JSON.stringify(intervals.suggestions.map((s) => s.slug)));
  assert.equal(referenceLevel('two-sum'), 'Easy');
  assert.equal(referenceLevel('no-such-problem-here'), null);
});

test('real data: paid-only problems are in the index but never suggested', () => {
  const paid = PROBLEM_INDEX.problems.filter((p) => p[4] === 1);
  assert.ok(paid.length > 100);
  const paidSlugs = new Set(paid.map((p) => p[1]));
  for (const skill of SKILLS) {
    const { suggestions } = practiceSuggestions({ skill: skill.id, reference: 'Medium', solved: [], count: 20 });
    for (const s of suggestions) assert.ok(!paidSlugs.has(s.slug), `${skill.id}: ${s.slug}`);
  }
  assert.equal(problemBySlug(paid[0][1]).paid, true);
});

// ---- ranking, on a small index of its own ---------------------------------

// Real slugs where a list membership matters (two-sum and valid-anagram are
// on NeetCode 150); the rest are made up.
const TAGS = [['array', 'Array'], ['hash-table', 'Hash Table'], ['breadth-first-search', 'Breadth-First Search'], ['matrix', 'Matrix'], ['sweep-line', 'Sweep Line'], ['graph', 'Graph'], ['sorting', 'Sorting']];
function row(id, slug, title, level, { paid = false, likes = 0, subs = 0, tags = [0] } = {}) {
  return [id, slug, title, level, paid ? 1 : 0, likes, subs, tags];
}
const SMALL = {
  schema: 1,
  fetched: '2026-11-04',
  tags: TAGS,
  problems: [
    row(1, 'two-sum', 'Two Sum', 0, { likes: 100, subs: 10, tags: [0, 1] }),
    row(2, 'easy-big', 'Easy Big', 0, { likes: 110, subs: 5 }),
    row(3, 'easy-tie-a', 'Easy Tie A', 0, { likes: 50, subs: 9 }),
    row(4, 'easy-tie-b', 'Easy Tie B', 0, { likes: 50, subs: 20 }),
    row(5, 'easy-same-c', 'Easy Same C', 0, { likes: 40, subs: 1 }),
    row(6, 'easy-same-b', 'Easy Same B', 0, { likes: 40, subs: 1 }),
    row(7, 'medium-one', 'Medium One', 1, { likes: 1000, subs: 1 }),
    row(8, 'medium-two', 'Medium Two', 1, { likes: 900, subs: 1 }),
    row(9, 'medium-paid', 'Medium Paid', 1, { paid: true, likes: 99999 }),
    row(10, 'hard-one', 'Hard One', 2, { likes: 5, subs: 1 }),
    row(11, 'grid-walk', 'Grid Walk', 1, { likes: 3, tags: [2, 3] }),
    row(12, 'plain-bfs', 'Plain BFS', 1, { likes: 4, tags: [2] }),
    row(13, 'merge-my-intervals', 'Merge My Intervals', 1, { likes: 2, tags: [0, 6] }),
    row(16, 'odd-in-an-interval', 'Count Odd Numbers in an Interval', 0, { likes: 1, tags: [] }),
    row(14, 'sweep', 'Sweep', 1, { likes: 1, tags: [4] }),
    row(15, 'valid-anagram', 'Valid Anagram', 0, { likes: 85, subs: 1, tags: [1] }),
  ],
};
SMALL.count = SMALL.problems.length;
const slugs = (r) => r.suggestions.map((s) => s.slug);
const ask = (skill, reference, extra = {}) => practiceSuggestions({ skill, reference, solved: [], index: SMALL, count: 20, ...extra });

test('level tiers: same level first, then one up, then one down; Easy has no level down, Hard no level up', () => {
  assert.deepEqual(levelTiers('Easy'), [[0], [1]]);
  assert.deepEqual(levelTiers('Medium'), [[1], [2], [0]]);
  assert.deepEqual(levelTiers('Hard'), [[2], [1]]);
  assert.deepEqual(levelTiers(null), [[0, 1, 2]]);
  assert.deepEqual(levelTiers('Impossible'), [[0, 1, 2]]);
});

test('an Easy reference offers Easy by popularity, then Medium, never Hard; paid-only is left out', () => {
  const r = ask('arrays', 'Easy');
  assert.deepEqual(slugs(r), ['two-sum', 'easy-big', 'easy-tie-b', 'easy-tie-a', 'easy-same-c', 'easy-same-b', 'medium-one', 'medium-two', 'merge-my-intervals']);
  assert.ok(!slugs(r).includes('hard-one') && !slugs(r).includes('medium-paid'));
});

test('a list membership is a small boost: Two Sum (100 likes, on a list) beats 110 likes but not 130', () => {
  assert.ok(100 * CURATED_BOOST > 110 && 100 * CURATED_BOOST < 130);
  assert.deepEqual(slugs(ask('arrays', 'Easy')).slice(0, 2), ['two-sum', 'easy-big']);
  const bigger = { ...SMALL, problems: SMALL.problems.map((p) => (p[1] === 'easy-big' ? row(2, 'easy-big', 'Easy Big', 0, { likes: 130 }) : p)) };
  assert.deepEqual(slugs(practiceSuggestions({ skill: 'arrays', reference: 'Easy', solved: [], index: bigger })).slice(0, 2), ['easy-big', 'two-sum']);
});

test('ties go to more submissions, then the lower id, then the slug, so the order is stable', () => {
  const order = slugs(ask('arrays', 'Easy'));
  assert.ok(order.indexOf('easy-tie-b') < order.indexOf('easy-tie-a'), 'more submissions first');
  // easy-same-c has id 5, easy-same-b id 6: the lower id wins.
  assert.ok(order.indexOf('easy-same-c') < order.indexOf('easy-same-b'), 'lower id first');
  assert.deepEqual(slugs(ask('arrays', 'Easy')), order, 'same answer every time');
});

test('a Medium reference: Medium, then Hard, then Easy; Hard: Hard then Medium', () => {
  assert.deepEqual(slugs(ask('arrays', 'Medium')), ['medium-one', 'medium-two', 'merge-my-intervals', 'hard-one', 'two-sum', 'easy-big', 'easy-tie-b', 'easy-tie-a', 'easy-same-c', 'easy-same-b']);
  assert.deepEqual(slugs(ask('arrays', 'Hard')), ['hard-one', 'medium-one', 'medium-two', 'merge-my-intervals']);
});

test('no reference: every level in one tier, by popularity alone', () => {
  const r = ask('arrays', null);
  assert.equal(r.reference, null);
  assert.deepEqual(slugs(r).slice(0, 3), ['medium-one', 'medium-two', 'two-sum']);
  assert.ok(slugs(r).includes('hard-one'));
  assert.ok(!r.suggestions[0].reason.includes('level'), r.suggestions[0].reason);
});

test('solved problems and the excluded one are never offered; solved may be a Set, an array or the store record', () => {
  for (const solved of [new Set(['two-sum']), ['two-sum'], { 'two-sum': { at: '2026-11-04T00:00:00Z', count: 1 } }]) {
    const r = practiceSuggestions({ skill: 'arrays', reference: 'Easy', solved, exclude: 'easy-big', index: SMALL });
    assert.deepEqual(slugs(r), ['easy-tie-b', 'easy-tie-a', 'easy-same-c']);
  }
});

test('an array of slugs is left out too, for the problems a card already shows', () => {
  const r = practiceSuggestions({ skill: 'arrays', reference: 'Easy', solved: ['two-sum'], exclude: ['easy-big', 'easy-tie-b'], index: SMALL });
  assert.deepEqual(slugs(r), ['easy-tie-a', 'easy-same-c', 'easy-same-b']);
});

test('three at a time: the offset pages through, and `more` says whether another page exists', () => {
  const first = practiceSuggestions({ skill: 'arrays', reference: 'Hard', solved: [], index: SMALL });
  assert.equal(first.suggestions.length, 3);
  assert.equal(first.total, 4);
  assert.equal(first.more, true);
  const second = practiceSuggestions({ skill: 'arrays', reference: 'Hard', solved: [], index: SMALL, offset: 3 });
  assert.deepEqual(slugs(second), ['merge-my-intervals']);
  assert.equal(second.more, false);
  const past = practiceSuggestions({ skill: 'arrays', reference: 'Hard', solved: [], index: SMALL, offset: 30 });
  assert.deepEqual(past.suggestions, []);
  assert.equal(past.more, false);
  for (const offset of [-1, 1.5, '3', null]) assert.equal(practiceSuggestions({ skill: 'arrays', reference: 'Hard', solved: [], index: SMALL, offset }).offset, 0);
});

test('an unknown skill, or a skill object not from the list, answers nothing', () => {
  for (const skill of ['no-such-skill', '', null, undefined, 42, { id: 'arrays', label: 'Arrays', tags: ['array'] }]) {
    const r = practiceSuggestions({ skill, reference: 'Easy', solved: [], index: SMALL });
    assert.deepEqual(r, { skill: null, reference: 'Easy', suggestions: [], offset: 0, total: 0, more: false });
  }
  assert.equal(skillById('constructor'), null);
  assert.equal(skillById('__proto__'), null);
});

test('everything solved, or nothing of the skill at all: an empty answer, not an error', () => {
  const all = SMALL.problems.map((p) => p[1]);
  const r = practiceSuggestions({ skill: 'arrays', reference: 'Medium', solved: all, index: SMALL });
  assert.deepEqual(r.suggestions, []);
  assert.equal(r.total, 0);
  assert.equal(r.more, false);
  assert.deepEqual(r.skill, { id: 'arrays', label: 'Arrays' });
  assert.deepEqual(ask('tries', 'Easy').suggestions, []);
});

test('Graphs takes a BFS on a grid or the graph tag, not a bare BFS; Intervals takes Sweep Line or a title', () => {
  assert.deepEqual(slugs(ask('graphs', 'Medium')), ['grid-walk']);
  assert.deepEqual(slugs(ask('intervals', 'Medium')), ['merge-my-intervals', 'sweep'], 'a title alone is not enough');
  assert.ok(matchesSkill(skillById('intervals'), { tags: new Set(), title: 'x', topics: ['Intervals'] }), 'a list\'s Intervals topic counts');
  const graphs = skillById('graphs');
  assert.ok(matchesSkill(graphs, { tags: new Set(['graph']), title: 'x' }));
  assert.ok(!matchesSkill(graphs, { tags: new Set(['matrix']), title: 'x' }));
});

test('a reason names the level against the reference, the likes and the first bundled list, nothing else', () => {
  assert.equal(reasonFor({ level: 1, likes: 15234, curated: 'Blind 75' }, 'Medium'), 'Same level · 15k likes · on Blind 75');
  assert.equal(reasonFor({ level: 2, likes: 9876, curated: null }, 'Medium'), 'One level up · 9.8k likes');
  assert.equal(reasonFor({ level: 0, likes: 1, curated: null }, 'Medium'), 'One level down · 1 like');
  assert.equal(reasonFor({ level: 0, likes: 842, curated: null }, null), '842 likes');
  assert.equal(practiceSuggestions({ skill: 'hash-maps', reference: 'Easy', solved: [], index: SMALL }).suggestions[0].reason, `Same level · 100 likes · on ${LISTS.find((l) => l.topics.some((t) => t.problems.some((p) => p.slug === 'two-sum'))).title}`);
});

test('counts read like LeetCode\'s: 842, 9.8k, 15k, 1.2M, never rounded up', () => {
  assert.deepEqual([0, 842, 999, 1000, 1050, 9876, 9999, 10000, 15999, 999999, 1000000, 1290000].map(formatCount), ['0', '842', '999', '1k', '1k', '9.8k', '9.9k', '10k', '15k', '999k', '1M', '1.2M']);
});
