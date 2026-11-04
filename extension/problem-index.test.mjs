// The problem index script (scripts/problem-index.mjs) and the file it
// commits (shared/problem-index.js). No test touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROBLEM_INDEX } from './shared/problem-index.js';
import { LIST_SLUGS, SCHEMA, buildIndex, checkIndex, fetchAll, graphql, renderIndex } from './scripts/problem-index.mjs';

const listSlugs = JSON.parse(fs.readFileSync(LIST_SLUGS, 'utf8'));

// ---- the committed dataset ------------------------------------------------

test('the committed index is valid and has every slug of the bundled lists with the same title and difficulty', () => {
  assert.deepEqual(checkIndex(PROBLEM_INDEX, listSlugs), []);
  assert.equal(PROBLEM_INDEX.schema, SCHEMA);
  assert.ok(PROBLEM_INDEX.count > 4000, `${PROBLEM_INDEX.count} problems`);
});

test('the committed index stays small enough to bundle', () => {
  const size = fs.statSync(new URL('./shared/problem-index.js', import.meta.url)).size;
  assert.ok(size < 600 * 1024, `${size} bytes`);
});

// ---- the fetch script -------------------------------------------------------

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body };
}

test('graphql retries a 429, a 5xx and a network error with a growing pause, honouring Retry-After', async () => {
  const answers = [response(429, null, { 'retry-after': '7' }), response(503, null), () => { throw new Error('reset'); }, response(200, { data: { ok: 1 } })];
  const waits = [];
  const data = await graphql('{ x }', {}, {
    fetchImpl: async () => { const a = answers.shift(); return typeof a === 'function' ? a() : a; },
    wait: async (ms) => waits.push(ms),
    log: () => {},
  });
  assert.deepEqual(data, { ok: 1 });
  assert.deepEqual(waits, [7000, 10000, 20000]);
});

test('graphql gives up at once on a 4xx other than 429, and after a few tries on a server that keeps failing', async () => {
  await assert.rejects(graphql('{ x }', {}, { fetchImpl: async () => response(400, null), wait: async () => {}, log: () => {} }), /HTTP 400/);
  let calls = 0;
  await assert.rejects(graphql('{ x }', {}, { fetchImpl: async () => { calls += 1; return response(500, null); }, wait: async () => {}, log: () => {} }), /gave up/);
  assert.equal(calls, 7);
});

function fakeLeetCode(questions) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push(query.includes('questionList') ? `list ${variables.skip}` : 'details');
    if (query.includes('questionList')) return response(200, { data: { questionList: { totalNum: questions.length, data: questions.slice(variables.skip, variables.skip + variables.limit) } } });
    const data = {};
    for (const m of query.matchAll(/(q\d+): question\(titleSlug: "([^"]+)"\)/g)) data[m[1]] = { titleSlug: m[2], likes: m[2].length, stats: JSON.stringify({ totalSubmissionRaw: 1000 + m[2].length }) };
    return response(200, { data });
  };
  return { calls, fetchImpl };
}

function question(i, extra = {}) {
  return { questionFrontendId: String(i), title: `Problem ${i}`, titleSlug: `problem-${i}`, difficulty: ['Easy', 'Medium', 'Hard'][i % 3], isPaidOnly: false, topicTags: [{ name: 'Array', slug: 'array' }], ...extra };
}

test('fetchAll pages the list, asks details for free problems only, waits between requests and resumes from its cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-index-'));
  const cacheFile = path.join(dir, 'cache.json');
  const questions = Array.from({ length: 230 }, (_, i) => question(i + 1, i === 4 ? { isPaidOnly: true } : {}));
  const lc = fakeLeetCode(questions);
  // The first run dies after the second request.
  let budget = 2;
  const flaky = async (...args) => { if (budget-- <= 0) throw new Error('killed'); return lc.fetchImpl(...args); };
  const waits = [];
  await assert.rejects(fetchAll({ cacheFile, delay: 1500, fetchImpl: flaky, wait: async (ms) => { waits.push(ms); if (ms !== 1500) throw new Error('killed'); }, log: () => {} }));
  assert.deepEqual(lc.calls, ['list 0', 'list 100']);
  const cache = await fetchAll({ cacheFile, delay: 1500, fetchImpl: lc.fetchImpl, wait: async () => {}, log: () => {} });
  assert.deepEqual(lc.calls, ['list 0', 'list 100', 'list 200', ...Array(10).fill('details')]);
  assert.equal(Object.keys(cache.details).length, 229);
  assert.equal(cache.details['problem-5'], undefined);
  assert.equal(waits[0], 1500, 'a pause between requests');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildIndex and renderIndex: compact rows, tags by use, paid problems without counts, a module that loads', async () => {
  const cache = {
    pages: {
      0: [
        question(2, { topicTags: [{ name: 'Array', slug: 'array' }, { name: 'Trie', slug: 'trie' }] }),
        question(1, { topicTags: [{ name: 'Array', slug: 'array' }] }),
        question(3, { isPaidOnly: true, topicTags: [] }),
      ],
    },
    details: { 'problem-1': { likes: 10, submissions: 99 }, 'problem-2': { likes: 3, submissions: 7 } },
  };
  const index = buildIndex(cache, '2026-11-04');
  assert.deepEqual(index.tags, [['array', 'Array'], ['trie', 'Trie']]);
  assert.deepEqual(index.problems, [
    [1, 'problem-1', 'Problem 1', 1, 0, 10, 99, [0]],
    [2, 'problem-2', 'Problem 2', 2, 0, 3, 7, [0, 1]],
    [3, 'problem-3', 'Problem 3', 0, 1, 0, 0, []],
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-index-'));
  const file = path.join(dir, 'index.mjs');
  fs.writeFileSync(file, renderIndex(index));
  const loaded = (await import(file)).PROBLEM_INDEX;
  assert.deepEqual(loaded, index);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkIndex catches a bad shape, a missing list slug and a renamed problem', () => {
  const base = { schema: SCHEMA, fetched: '2026-11-04', count: 1, tags: [['array', 'Array']], problems: [[1, 'two-sum', 'Two Sum', 0, 0, 5, 5, [0]]] };
  const issues = checkIndex(base, { problems: [{ slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy' }] });
  assert.deepEqual(issues, ['only 1 problems']);
  const bad = checkIndex({ ...base, schema: 2, fetched: 'yesterday', count: 3, problems: [[1, 'Two Sum', '', 4, 2, -1, 0, [7]], [1, 'x']] }, { problems: [{ slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy' }] });
  for (const want of [/schema/, /fetch date/, /count 3/, /bad slug/, /no title/, /bad level/, /bad flags/, /bad count/, /bad tags/, /not an 8-column row/, /two-sum is not in the index/]) {
    assert.ok(bad.some((i) => want.test(i)), `${want}: ${bad.join('; ')}`);
  }
  const renamed = checkIndex(base, { problems: [{ slug: 'two-sum', title: 'Two Sums', difficulty: 'Medium' }] });
  assert.ok(renamed.some((i) => /title "Two Sums"/.test(i)) && renamed.some((i) => /Medium, LeetCode says Easy/.test(i)), renamed.join('; '));
});
