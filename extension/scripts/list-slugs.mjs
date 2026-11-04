// Writes extension/e2e/list-slugs.json: every problem of the shared catalog
// (shared/catalog.js) with its expected LeetCode title and difficulty and the
// lists that use it, so each slug can be checked against LeetCode itself.
// roadmap.test.mjs fails when the file is out of date.
//
// Usage: node extension/scripts/list-slugs.mjs

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

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, `${JSON.stringify(listSlugs(), null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}
