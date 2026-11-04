#!/usr/bin/env node
// Writes extension/shared/problem-index.js: every LeetCode problem with its
// title, difficulty, topic tags and two popularity signals (likes and total
// submissions), fetched from LeetCode's public GraphQL endpoint, which
// answers a plain request with no login. The Tutor panel's "Practice a
// skill" suggestions (shared/practice.js) rank from this file; the extension
// never fetches it at run time.
//
// Usage:
//   node extension/scripts/problem-index.mjs [--cache <file>] [--fresh] [--delay <ms>]
//   node extension/scripts/problem-index.mjs --check
//
// The fetch is polite: one request at a time, a pause between requests
// (--delay, 1500 ms by default), and a retry with a growing pause on a 429,
// a 5xx or a network error. About 210 requests in all: the bulk list, 100
// problems a page, then likes and submissions for every free problem, 25
// problems a request (aliased `question(titleSlug:)` fields). Paid-only
// problems are listed but not asked about, since suggestions never offer them.
//
// Every answer goes into a cache file outside the repository (the OS temp
// folder unless --cache names one), so an interrupted run picks up where it
// stopped. --fresh starts over. The cache is deleted after a complete run.
//
// --check validates the committed file (shape, counts, and that every slug
// of the bundled lists, extension/e2e/list-slugs.json, is in it with the
// same title and difficulty) and exits 1 on any problem. practice.test.mjs
// runs the same check.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.resolve(HERE, '../shared/problem-index.js');
export const LIST_SLUGS = path.resolve(HERE, '../e2e/list-slugs.json');
export const SCHEMA = 1;
export const LEVELS = ['Easy', 'Medium', 'Hard'];
export const PAID = 1;

const ENDPOINT = 'https://leetcode.com/graphql/';
const HEADERS = { 'content-type': 'application/json', referer: 'https://leetcode.com/problemset/' };
const PAGE = 100;
const BATCH = 25;
const MAX_TRIES = 7;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One GraphQL request, retried on a 429, a 5xx or a network failure with a
// pause that doubles each time (or what Retry-After asks for).
export async function graphql(query, variables, { fetchImpl = fetch, wait = sleep, log = console.error } = {}) {
  let pause = 5000;
  for (let attempt = 1; ; attempt += 1) {
    let res;
    let failure;
    try {
      res = await fetchImpl(ENDPOINT, { method: 'POST', headers: HEADERS, body: JSON.stringify({ query, variables }) });
    } catch (err) {
      failure = `network error: ${err && err.message}`;
    }
    if (res && res.ok) {
      const body = await res.json();
      if (body.errors && !body.data) throw new Error(`GraphQL error: ${JSON.stringify(body.errors).slice(0, 300)}`);
      return body.data;
    }
    if (res && res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} from ${ENDPOINT}`);
    failure = failure || `HTTP ${res.status}`;
    if (attempt >= MAX_TRIES) throw new Error(`gave up after ${attempt} tries: ${failure}`);
    const after = res && Number(res.headers.get('retry-after'));
    const ms = Number.isFinite(after) && after > 0 ? after * 1000 : pause;
    log(`${failure}, retrying in ${Math.round(ms / 1000)} s`);
    await wait(ms);
    pause *= 2;
  }
}

const LIST_QUERY = `query problemList($skip: Int, $limit: Int) {
  questionList(categorySlug: "", limit: $limit, skip: $skip, filters: {}) {
    totalNum
    data { questionFrontendId title titleSlug difficulty isPaidOnly topicTags { name slug } }
  }
}`;

function detailQuery(slugs) {
  return `{ ${slugs.map((slug, i) => `q${i}: question(titleSlug: ${JSON.stringify(slug)}) { titleSlug likes stats }`).join(' ')} }`;
}

function readCache(file) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache && cache.schema === SCHEMA && cache.pages && cache.details) return cache;
  } catch {
    // none yet, or unreadable: start over
  }
  return { schema: SCHEMA, started: new Date().toISOString(), total: null, pages: {}, details: {} };
}

function writeCache(file, cache) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(cache));
  fs.renameSync(`${file}.tmp`, file);
}

// Fetches everything not in the cache yet; returns the full cache.
export async function fetchAll({ cacheFile, delay = 1500, fetchImpl = fetch, wait = sleep, log = console.error }) {
  const cache = readCache(cacheFile);
  let first = true;
  const ask = async (query, variables) => {
    if (!first) await wait(delay);
    first = false;
    return graphql(query, variables, { fetchImpl, wait, log });
  };

  for (let skip = 0; cache.total === null || skip < cache.total; skip += PAGE) {
    if (cache.pages[skip]) continue;
    const data = await ask(LIST_QUERY, { skip, limit: PAGE });
    const list = data && data.questionList;
    if (!list || !Array.isArray(list.data)) throw new Error(`no problem list at skip ${skip}`);
    cache.total = list.totalNum;
    cache.pages[skip] = list.data;
    writeCache(cacheFile, cache);
    log(`list: ${Math.min(skip + PAGE, cache.total)} of ${cache.total}`);
  }

  const wanted = Object.values(cache.pages)
    .flat()
    .filter((q) => !q.isPaidOnly && !cache.details[q.titleSlug])
    .map((q) => q.titleSlug);
  for (let i = 0; i < wanted.length; i += BATCH) {
    const slugs = wanted.slice(i, i + BATCH);
    const data = await ask(detailQuery(slugs));
    slugs.forEach((slug, j) => {
      const q = data && data[`q${j}`];
      let submissions = 0;
      try {
        submissions = Number(JSON.parse(q.stats).totalSubmissionRaw) || 0;
      } catch {
        // no stats: counts as zero
      }
      cache.details[slug] = { likes: q && Number.isInteger(q.likes) ? q.likes : 0, submissions };
    });
    writeCache(cacheFile, cache);
    log(`details: ${Math.min(i + BATCH, wanted.length)} of ${wanted.length}`);
  }
  return cache;
}

// The compact index from the fetched answers. Problems are ordered by their
// frontend id; tags by how many problems use them (the most used get the
// smallest numbers), ties by slug.
export function buildIndex(cache, fetched) {
  const seen = new Set();
  const questions = [];
  for (const q of Object.values(cache.pages).flat()) {
    if (seen.has(q.titleSlug)) continue;
    seen.add(q.titleSlug);
    questions.push(q);
  }
  const use = new Map();
  for (const q of questions) for (const t of q.topicTags || []) {
    const entry = use.get(t.slug) || { slug: t.slug, name: t.name, count: 0 };
    entry.count += 1;
    use.set(t.slug, entry);
  }
  const tags = [...use.values()].sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  const tagIndex = new Map(tags.map((t, i) => [t.slug, i]));
  const id = (q) => (/^\d+$/.test(q.questionFrontendId) ? Number(q.questionFrontendId) : q.questionFrontendId);
  questions.sort((a, b) => {
    const x = id(a);
    const y = id(b);
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y), 'en', { numeric: true });
  });
  const problems = questions.map((q) => {
    const detail = cache.details[q.titleSlug] || { likes: 0, submissions: 0 };
    const level = LEVELS.indexOf(q.difficulty);
    if (level < 0) throw new Error(`unknown difficulty ${q.difficulty} for ${q.titleSlug}`);
    return [
      id(q),
      q.titleSlug,
      q.title,
      level,
      q.isPaidOnly ? PAID : 0,
      q.isPaidOnly ? 0 : detail.likes,
      q.isPaidOnly ? 0 : detail.submissions,
      (q.topicTags || []).map((t) => tagIndex.get(t.slug)).sort((a, b) => a - b),
    ];
  });
  return { schema: SCHEMA, fetched, count: problems.length, tags: tags.map((t) => [t.slug, t.name]), problems };
}

export function renderIndex(index) {
  const rows = index.problems.map((p) => `    ${JSON.stringify(p)},`).join('\n');
  return `// extension/shared/problem-index.js - GENERATED by extension/scripts/problem-index.mjs
// from LeetCode's public GraphQL (https://leetcode.com/graphql/). Do not edit
// by hand: re-run the script to refresh it (see its header).
//
// Public problem metadata only, bundled with the extension so the Tutor
// panel's "Practice a skill" suggestions (shared/practice.js) need no network.
//
// schema   the version of this layout
// fetched  the day it was fetched (UTC)
// count    how many problems
// tags     [slug, name] of every LeetCode topic tag; problems refer to a tag
//          by its position here
// problems one row per problem, by frontend id:
//          [frontend id, slug, title, level (0 Easy, 1 Medium, 2 Hard),
//           flags (1 paid only), likes, total submissions, tag positions]
//          Paid-only problems carry 0 likes and 0 submissions (not fetched).
//
// Pure data, no Node or browser APIs (extension/shared.test.js checks that).

export const PROBLEM_INDEX = {
  schema: ${index.schema},
  fetched: ${JSON.stringify(index.fetched)},
  count: ${index.count},
  tags: ${JSON.stringify(index.tags)},
  problems: [
${rows}
  ],
};
`;
}

// Every problem with the shape the file documents, and every slug of the
// bundled lists present with the same title and difficulty. Returns a list
// of problems found (empty when all is well).
export function checkIndex(index, listSlugs) {
  const issues = [];
  if (!index || typeof index !== 'object') return ['no index'];
  if (index.schema !== SCHEMA) issues.push(`schema is ${index.schema}, expected ${SCHEMA}`);
  if (typeof index.fetched !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(index.fetched) || Number.isNaN(Date.parse(index.fetched))) issues.push(`bad fetch date ${index.fetched}`);
  if (!Array.isArray(index.tags) || !index.tags.length) issues.push('no tags');
  else index.tags.forEach((t, i) => {
    if (!Array.isArray(t) || t.length !== 2 || typeof t[0] !== 'string' || typeof t[1] !== 'string' || !t[0] || !t[1]) issues.push(`bad tag ${i}`);
  });
  if (!Array.isArray(index.problems)) return [...issues, 'no problems'];
  if (index.count !== index.problems.length) issues.push(`count ${index.count} but ${index.problems.length} problems`);
  if (index.problems.length < 3000) issues.push(`only ${index.problems.length} problems`);
  const bySlug = new Map();
  const ids = new Set();
  index.problems.forEach((p, i) => {
    const where = `problem ${i}${Array.isArray(p) && typeof p[1] === 'string' ? ` (${p[1]})` : ''}`;
    if (!Array.isArray(p) || p.length !== 8) return issues.push(`${where}: not an 8-column row`);
    const [id, slug, title, level, flags, likes, submissions, tags] = p;
    if (!(Number.isInteger(id) && id > 0) && !(typeof id === 'string' && id)) issues.push(`${where}: bad id`);
    if (ids.has(id)) issues.push(`${where}: duplicate id ${id}`);
    ids.add(id);
    if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) issues.push(`${where}: bad slug`);
    if (bySlug.has(slug)) issues.push(`${where}: duplicate slug`);
    bySlug.set(slug, p);
    if (typeof title !== 'string' || !title.trim()) issues.push(`${where}: no title`);
    if (![0, 1, 2].includes(level)) issues.push(`${where}: bad level`);
    if (flags !== 0 && flags !== PAID) issues.push(`${where}: bad flags`);
    for (const n of [likes, submissions]) if (!Number.isInteger(n) || n < 0) issues.push(`${where}: bad count`);
    if (!Array.isArray(tags) || tags.some((t) => !Number.isInteger(t) || t < 0 || t >= (index.tags || []).length)) issues.push(`${where}: bad tags`);
  });
  const free = index.problems.filter((p) => Array.isArray(p) && p[4] === 0);
  if (free.length && free.filter((p) => p[5] > 0).length < free.length * 0.9) issues.push('most free problems have no likes: the detail fetch failed');
  for (const want of (listSlugs && listSlugs.problems) || []) {
    const p = bySlug.get(want.slug);
    if (!p) issues.push(`list slug ${want.slug} is not in the index`);
    else {
      if (p[2] !== want.title) issues.push(`list slug ${want.slug}: title "${want.title}", LeetCode says "${p[2]}"`);
      if (LEVELS[p[3]] !== want.difficulty) issues.push(`list slug ${want.slug}: ${want.difficulty}, LeetCode says ${LEVELS[p[3]]}`);
    }
  }
  return issues;
}

export async function loadCommitted(file = OUT) {
  const { PROBLEM_INDEX } = await import(pathToFileURL(file).href);
  return PROBLEM_INDEX;
}

function parseArgs(argv) {
  const args = { cache: path.join(os.tmpdir(), 'leetcode-capture-problem-index.cache.json'), delay: 1500, fresh: false, check: false, out: OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cache') args.cache = path.resolve(argv[++i]);
    else if (argv[i] === '--delay') args.delay = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--fresh') args.fresh = true;
    else if (argv[i] === '--check') args.check = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(args.delay) || args.delay < 500) throw new Error('--delay must be at least 500 ms');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lists = JSON.parse(fs.readFileSync(LIST_SLUGS, 'utf8'));
  if (args.check) {
    const issues = checkIndex(await loadCommitted(args.out), lists);
    for (const issue of issues) console.error(issue);
    console.log(issues.length ? `${issues.length} problems in ${args.out}` : `${args.out} is valid`);
    process.exit(issues.length ? 1 : 0);
  }
  const repo = path.resolve(HERE, '../..');
  if (path.resolve(args.cache).startsWith(repo + path.sep)) throw new Error('--cache must be outside the repository');
  if (args.fresh) fs.rmSync(args.cache, { force: true });
  console.error(`cache: ${args.cache}`);
  const cache = await fetchAll({ cacheFile: args.cache, delay: args.delay });
  const index = buildIndex(cache, new Date().toISOString().slice(0, 10));
  const issues = checkIndex(index, lists);
  fs.writeFileSync(args.out, renderIndex(index));
  console.log(`wrote ${args.out}: ${index.count} problems, ${index.tags.length} tags, ${fs.statSync(args.out).size} bytes`);
  if (issues.length) {
    for (const issue of issues) console.error(issue);
    console.error(`${issues.length} problems; the cache is kept at ${args.cache}`);
    process.exit(1);
  }
  fs.rmSync(args.cache, { force: true });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
