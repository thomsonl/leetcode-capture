// Writes extension/e2e/list-slugs.json: every problem of the shared catalog
// (shared/catalog.js) with its expected LeetCode title and difficulty and the
// lists that use it, so each slug can be checked against LeetCode itself.
// roadmap.test.mjs fails when the file is out of date.
//
// Usage: node extension/scripts/list-slugs.mjs
//        node extension/scripts/list-slugs.mjs --snippet > /tmp/check-slugs.js
// The second prints a script to paste into the console of a signed-in
// leetcode.com tab: it asks LeetCode's GraphQL for every slug of the file
// (question(titleSlug) { title difficulty }, 25 to a request) and resolves to,
// and logs, every slug LeetCode does not know or names or grades differently.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../shared/catalog.js';
import { LISTS } from '../shared/roadmap.js';

export function listSlugs() {
  const lists = new Map();
  for (const list of LISTS) for (const topic of list.topics) for (const p of topic.problems) lists.set(p.slug, [...(lists.get(p.slug) || []), list.id]);
  return {
    lists: LISTS.map((list) => ({ id: list.id, title: list.title, size: list.size, groups: list.topics.map((t) => ({ title: t.title, slugs: t.problems.map((p) => p.slug) })) })),
    problems: [...CATALOG.values()].map((p) => ({ slug: p.slug, title: p.title, difficulty: p.difficulty, lists: lists.get(p.slug) || [] })),
  };
}

export const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../e2e/list-slugs.json');

// The console script for the check; the expected values come from the file
// itself, so what is checked is exactly what the tests hold the lists to.
export function checkSnippet(data = JSON.parse(fs.readFileSync(OUT, 'utf8'))) {
  const expected = data.problems.map((p) => [p.slug, p.title, p.difficulty]);
  return `(async () => {
  const expected = ${JSON.stringify(expected)};
  const token = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const problems = [];
  for (let i = 0; i < expected.length; i += 25) {
    const batch = expected.slice(i, i + 25);
    const query = '{' + batch.map(([slug], j) => 'q' + j + ': question(titleSlug: ' + JSON.stringify(slug) + ') { titleSlug title difficulty }').join(' ') + '}';
    const res = await fetch('/graphql/', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrftoken': token }, body: JSON.stringify({ query }) });
    const data = (await res.json()).data || {};
    batch.forEach(([slug, title, difficulty], j) => {
      const q = data['q' + j];
      if (!q || q.titleSlug !== slug) problems.push({ slug, problem: 'unknown slug' });
      else if (q.title !== title || q.difficulty !== difficulty) problems.push({ slug, expected: title + ' (' + difficulty + ')', leetcode: q.title + ' (' + q.difficulty + ')' });
    });
  }
  console.log(expected.length + ' slugs checked, ' + problems.length + ' differ');
  if (problems.length) console.table(problems);
  return problems;
})();
`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--snippet')) {
    process.stdout.write(checkSnippet());
  } else {
    fs.writeFileSync(OUT, `${JSON.stringify(listSlugs(), null, 2)}\n`);
    console.log(`wrote ${OUT}`);
  }
}
