// Fetches every problem list's own website and writes what it says to the
// snapshots roadmap.test.mjs holds shared/roadmap.js to, so a list can be
// re-verified against its publisher in one step:
//
//   e2e/neetcode-lists.txt        neetcode.io's main bundle: NeetCode 150,
//                                 NeetCode 250 and Blind 75 (its blind75 flag),
//                                 plus the topic ("pattern") neetcode.io gives
//                                 each Grind 75 problem that is on none of them
//   e2e/blind-75.txt              the original Blind post (2018)
//   e2e/grind-75.txt              techinterviewhandbook.org/grind75 at its
//                                 default settings, computed the way the site
//                                 computes it from the site's own data
//   e2e/leetcode-study-plans.txt  LeetCode's GraphQL studyPlanV2Detail
//
// Usage: node extension/scripts/list-sources.mjs           (write the files)
//        node extension/scripts/list-sources.mjs --check   (write nothing,
//                                 exit 1 if a site no longer matches its file)
// Then run npm test: a list that no longer matches its site fails there.
// Plain fetches, no login, one request at a time.
//
// Format of every file: line 1 names the source and the day; then
// "=== <list>" sections, "#<group>" lines and one "slug|E|M|H" (or just
// "slug" where the source gives no difficulty) per problem, in the source's
// order.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRIND_75 } from '../shared/roadmap.js';
import { CATALOG } from '../shared/catalog.js';

const E2E = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../e2e');
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) leetcode-capture list check' };
// The local calendar day, as the other notes date things.
const today = () => new Date().toLocaleDateString('en-CA');
const pause = () => new Promise((r) => setTimeout(r, 1500));

async function get(url) {
  await pause();
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const D = (difficulty) => ({ easy: 'E', medium: 'M', hard: 'H' })[String(difficulty).toLowerCase()];
function render(header, sections) {
  const lines = [header];
  for (const [name, groups] of sections) {
    lines.push(`=== ${name}`);
    for (const [title, rows] of groups) lines.push(`#${title}`, ...rows);
  }
  return `${lines.join('\n')}\n`;
}
// Ordered groups in order of first appearance: [[title, rows]].
function grouped(items) {
  const groups = new Map();
  for (const [title, row] of items) groups.set(title, [...(groups.get(title) || []), row]);
  return [...groups];
}

// ---- neetcode.io -----------------------------------------------------------

export function neetcodeProblems(bundle) {
  return [...bundle.matchAll(/\{problem:"[^{}]*\}/g)].map(([o]) => {
    const d = {};
    for (const [, k, v] of o.matchAll(/(\w+):("(?:[^"\\]|\\.)*"|!0|!1)/g)) d[k] = v === '!0' ? true : v === '!1' ? false : JSON.parse(v);
    return { ...d, slug: String(d.link || '').replace(/\/$/, '') };
  });
}

async function neetcode() {
  const page = await get('https://neetcode.io/practice');
  const main = page.match(/src="(main\.[0-9a-f]+\.js)"/)?.[1];
  if (!main) throw new Error('neetcode.io/practice: no main bundle');
  const url = `https://neetcode.io/${main}`;
  const problems = neetcodeProblems(await get(url));
  const sections = [];
  const listed = new Set();
  for (const flag of ['neetcode150', 'neetcode250', 'blind75']) {
    const seen = new Set();
    const items = [];
    for (const p of problems) {
      if (!p[flag] || seen.has(p.slug)) continue;
      seen.add(p.slug);
      listed.add(p.slug);
      items.push([p.pattern, `${p.slug}|${D(p.difficulty)}`]);
    }
    sections.push([flag, grouped(items)]);
  }
  // The rest of neetcode.io's catalog has a topic for most other problems:
  // the ones Grind 75 needs (its subjects follow neetcode.io's topics).
  const items = [];
  for (const p of GRIND_75.topics.flatMap((t) => t.problems)) {
    if (listed.has(p.slug)) continue;
    const patterns = [...new Set(problems.filter((x) => x.slug === p.slug).map((x) => x.pattern))];
    if (patterns.length > 1) throw new Error(`neetcode.io gives ${p.slug} two topics: ${patterns}`);
    if (patterns.length) items.push([patterns[0], `${p.slug}|${D(problems.find((x) => x.slug === p.slug).difficulty)}`]);
  }
  sections.push(['grind75-others', grouped(items)]);
  const header = `Source: neetcode.io's own problem data, the objects in ${url} (the bundle https://neetcode.io/practice loaded), fetched ${today()}. Format: "#Topic" then "slug|difficulty" in the order neetcode.io lists them; topics in order of first appearance. neetcode.io's lists are Blind 75 (flag blind75), NeetCode 150 and NeetCode 250 (practice/practice/neetcode250); it has no NeetCode 75. grind75-others: the topic neetcode.io's full catalog gives each Grind 75 problem that is on none of those lists.`;
  return render(header, sections);
}

// ---- the original Blind 75 post -------------------------------------------

const BLIND_URL = 'https://www.teamblind.com/post/New-Year-Gift---Curated-List-of-Top-75-LeetCode-Questions-to-Save-Your-Time-OaM1orEU';
// LeetCode renamed one slug since 2018 (the old one redirects), and the post
// gives Longest Common Subsequence no link; both resolved here, by name.
const BLIND_RENAMED = { 'add-and-search-word-data-structure-design': 'design-add-and-search-words-data-structure' };

// The post's text, from the page's DiscussionForumPosting data.
export function blindPostText(html) {
  let stream = '';
  for (const [, chunk] of html.matchAll(/self\.__next_f\.push\((\[1,"(?:[^"\\]|\\.)*"\])\)/g)) stream += JSON.parse(chunk)[1];
  const start = stream.indexOf('{"@context":"https://schema.org","@type":"DiscussionForumPosting"');
  if (start < 0) throw new Error('Blind post: no DiscussionForumPosting');
  let depth = 0;
  let inString = false;
  for (let i = start; i < stream.length; i += 1) {
    const c = stream[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && (depth -= 1) === 0) return JSON.parse(stream.slice(start, i + 1)).text;
  }
  throw new Error('Blind post: unterminated data');
}

export function blindGroups(text) {
  const byTitle = new Map([...CATALOG.values()].map((p) => [p.title.toLowerCase(), p.slug]));
  const items = [];
  let group = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line === '---' || /^(New Year Gift|Good luck|You're welcome)/.test(line)) continue;
    const item = line.match(/^- (.+?) -(?: https:\/\/leetcode\.com\/problems\/([a-z0-9-]+)\/?)?$/);
    if (!item) {
      group = line;
      continue;
    }
    if (!group) throw new Error(`Blind post: ${line} before any category`);
    let slug = item[2];
    if (!slug) slug = byTitle.get(item[1].toLowerCase());
    if (!slug) throw new Error(`Blind post: no link and no known title for ${item[1]}`);
    items.push([group, BLIND_RENAMED[slug] || slug]);
  }
  return grouped(items);
}

async function blind() {
  const groups = blindGroups(blindPostText(await get(BLIND_URL)));
  const header = `Source: the original Blind 75 post, ${BLIND_URL} (2018-12-31), fetched ${today()}. Format: "#Category" then one slug per line, the post's categories and order. The post links Combination Sum to combination-sum-iv, lists Merge K Sorted Lists under both Linked List and Heap (76 lines, 75 problems), gives Longest Common Subsequence no link, and links the old slug add-and-search-word-data-structure-design (now design-add-and-search-words-data-structure).`;
  return render(header, [['blind-75', groups]]);
}

// ---- Grind 75 ---------------------------------------------------------------

// The site's own defaults and arithmetic (its Next.js bundle): 8 weeks at 8
// hours a week, questions taken by priority while 1.96 minutes per minute of a
// question's duration still fit 60 * weeks * hours, then ordered by
// difficulty (a stable sort), then cut into weeks of at most 60 * hours such
// minutes, the last week taking the rest.
export function grindSchedule(questions, { weeks = 8, hours = 8 } = {}) {
  const level = { Easy: 0, Medium: 1, Hard: 2 };
  let budget = 60 * weeks * hours;
  const chosen = [];
  for (const q of [...questions].sort((a, b) => a.priority - b.priority)) {
    if ((budget -= 1.96 * q.duration) < 0) break;
    chosen.push(q);
  }
  const ordered = [...chosen].sort((a, b) => level[a.difficulty] - level[b.difficulty]);
  const result = [[`Week 1`, []]];
  let used = 0;
  for (const q of ordered) {
    const cost = 1.96 * q.duration;
    if (result.length < weeks && used + cost > 60 * hours) {
      result.push([`Week ${result.length + 1}`, []]);
      used = 0;
    }
    result.at(-1)[1].push(q);
    used += cost;
  }
  return result;
}

async function grind() {
  // techinterviewhandbook.org/grind75 is served from this origin (the
  // repository's apps/website/functions/grind75 proxy) and sits behind a
  // browser challenge; the origin does not.
  const base = 'https://grind75.pages.dev';
  const page = await get(`${base}/grind75`);
  let questions = null;
  let code = '';
  for (const [, src] of page.matchAll(/src="(\/grind75\/_next\/static\/chunks\/[^"]+\.js)"/g)) {
    const js = await get(base + src);
    code += js;
    const data = js.match(/JSON\.parse\('(\[\{"slug":.*?\}\])'\)/);
    if (data) questions = JSON.parse(data[1].replace(/\\'/g, '\''));
  }
  if (!questions) throw new Error('grind75: no question data in the page\'s chunks');
  // Fail loudly if the site's defaults or arithmetic change.
  for (const needle of ['t.weeks??8', 't.hours??8', 't.order??"difficulty"', 't.grouping??"weeks"', '1.96*']) {
    if (!code.includes(needle)) throw new Error(`grind75: the site's code no longer has ${needle}; re-read its schedule`);
  }
  const weeks = grindSchedule(questions);
  const header = `Source: Grind 75, https://www.techinterviewhandbook.org/grind75 (served from ${base}/grind75), fetched ${today()}: the site's own data (${questions.length} questions) scheduled the way its code does at its defaults (8 weeks, 8 hours a week, order by difficulty, group by weeks). Format: "#Week n" then "slug|difficulty|the site's topic", difficulty as the site has it.`;
  return render(header, [['grind-75', weeks.map(([title, qs]) => [title, qs.map((q) => `${q.slug}|${D(q.difficulty)}|${q.topic}`)])]]);
}

// ---- LeetCode's study plans -------------------------------------------------

async function leetcode() {
  const sections = [];
  for (const plan of ['top-100-liked', 'top-interview-150', 'top-sql-50']) {
    await pause();
    const res = await fetch('https://leetcode.com/graphql/', {
      method: 'POST',
      headers: { ...UA, 'content-type': 'application/json', referer: 'https://leetcode.com/studyplan/' },
      body: JSON.stringify({ query: `query { studyPlanV2Detail(planSlug: ${JSON.stringify(plan)}) { planSubGroups { name questions { titleSlug difficulty } } } }` }),
    });
    const detail = (await res.json()).data?.studyPlanV2Detail;
    if (!detail) throw new Error(`LeetCode: no study plan ${plan}`);
    sections.push([plan, detail.planSubGroups.map((g) => [g.name, g.questions.map((q) => `${q.titleSlug}|${D(q.difficulty)}`)])]);
  }
  return render(`Source: LeetCode GraphQL studyPlanV2Detail (https://leetcode.com/graphql/, no login), fetched ${today()}. Format: "#Group" then "slug|difficulty" in LeetCode's own order.`, sections);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let differs = 0;
  for (const [file, make] of [['neetcode-lists.txt', neetcode], ['blind-75.txt', blind], ['grind-75.txt', grind], ['leetcode-study-plans.txt', leetcode]]) {
    const fresh = await make();
    const target = path.join(E2E, file);
    const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const same = old.split('\n').slice(1).join('\n') === fresh.split('\n').slice(1).join('\n');
    if (!same) differs += 1;
    if (check) console.log(`${file}: ${same ? 'matches the site' : 'DIFFERS from the site'}`);
    else {
      fs.writeFileSync(target, fresh);
      console.log(`${file}: written${same ? ' (same lists)' : ' (lists changed)'}`);
    }
  }
  if (check && differs) process.exitCode = 1;
}
