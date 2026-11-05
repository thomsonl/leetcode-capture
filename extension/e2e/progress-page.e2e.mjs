// End-to-end check of the options page's Progress tab in the REAL unpacked
// extension (Playwright's cached Chromium): the tab bar, the NeetCode 150
// graph (nodes, counts, the prerequisite lines and how they are routed), a
// topic's side panel (prerequisites, the problem table, links), marking and
// unmarking through the worker into storage.local, stars, live updates from
// storage, the keyboard, light and dark, and widths from 400 px to wide.
//
// Run with:  node extension/e2e/progress-page.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-progress-shots).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { NEETCODE_150, nextOnRoadmap } from '../shared/roadmap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-progress-shots';
fs.mkdirSync(shots, { recursive: true });

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = {
  Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32,
};
async function key(page, name, { shift = false } = {}) {
  const base = { key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: KEYS[name], modifiers: shift ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(name === 'Enter' ? { text: '\r' } : name === ' ' ? { text: ' ' } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(40);
}
const focused = (page) => page.eval(`(() => { const a = document.activeElement; return a ? (a.dataset.topic || a.dataset.slug && a.dataset.role + ':' + a.dataset.slug || a.id || a.className || a.tagName) : null; })()`);

// Seeded progress: all of Arrays & Hashing but one, two Two Pointers, one
// Stack problem (detected and by hand), and one problem off the roadmap.
const AT = '2026-11-02T18:30:00.000Z';
const seed = {};
for (const p of NEETCODE_150.topics[0].problems.slice(0, 8)) seed[p.slug] = { at: AT, count: 1 };
seed['valid-palindrome'] = { at: AT, count: 2 };
seed['3sum'] = { at: AT, count: 0, manual: true };
seed['valid-parentheses'] = { at: AT, count: 1 };
seed['add-binary'] = { at: AT, count: 1 };

const browser = await launch({ extensionDir });
try {
  await browser.serviceWorkerEval(`chrome.storage.local.set(${JSON.stringify({ solvedProblems: seed, starredProblems: { 'trapping-rain-water': true } })})`);
  const page = await browser.openPage('about:blank');
  // The options page asks the relay for the helper's settings; nothing may
  // reach a real one.
  await page.failFetch('http://localhost:8135/*');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html#progress` });
  await page.waitFor(`document.querySelectorAll('.node').length === 18 && document.querySelector('.node-count').textContent !== '0 / 9'`, { what: 'the graph with stored progress' });
  await sleep(200);

  const expectedNext = nextOnRoadmap(NEETCODE_150, Object.keys(seed), { count: 1 })[0];

  await scenario('#progress opens the Progress tab: tab bar state, summary counts and the next problem', async () => {
    const m = await page.eval(`({
      settingsSelected: document.getElementById('tab-settings').getAttribute('aria-selected'),
      progressSelected: document.getElementById('tab-progress').getAttribute('aria-selected'),
      settingsHidden: document.getElementById('panel-settings').hidden,
      sub: document.getElementById('page-sub').textContent,
      total: document.querySelector('.total').textContent,
      levels: [...document.querySelectorAll('.levels li')].map((li) => li.textContent),
      next: document.querySelector('.next-up').textContent,
      nextHref: document.querySelector('.next-up a').href,
      connection: getComputedStyle(document.getElementById('connection')).display,
    })`);
    check(m.settingsSelected === 'false' && m.progressSelected === 'true' && m.settingsHidden, `tabs: ${JSON.stringify(m)}`);
    check(m.sub === 'Your NeetCode 150 progress' && m.connection === 'none', `header: ${JSON.stringify(m)}`);
    check(m.total === '11 / 150 solved', `total (the problem off the roadmap does not count): ${m.total}`);
    const easy = NEETCODE_150.topics.flatMap((t) => t.problems).filter((p) => p.difficulty === 'Easy');
    check(m.levels[0] === `Easy${easy.filter((p) => seed[p.slug]).length} / ${easy.length}`, `levels: ${JSON.stringify(m.levels)}`);
    check(m.next === `Next up${expectedNext.title}inArrays & Hashing`, `next: ${m.next}`);
    check(m.nextHref === `https://leetcode.com/problems/${expectedNext.slug}/`, `next link: ${m.nextHref}`);
  });

  await scenario('the graph: 18 topic nodes with solved counts, the recommended topic marked, every prerequisite line', async () => {
    const m = await page.eval(`({
      nodes: [...document.querySelectorAll('.node')].map((n) => ({ id: n.dataset.topic, count: n.querySelector('.node-count').textContent, next: n.hasAttribute('data-next'), label: n.getAttribute('aria-label') })),
      edges: [...document.querySelectorAll('.edge')].map((e) => e.dataset.from + '>' + e.dataset.to + (e.classList.contains('lit') ? '*' : '')),
    })`);
    const byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
    check(byId['arrays-hashing'].count === '8 / 9' && byId['two-pointers'].count === '2 / 5' && byId.stack.count === '1 / 6' && byId.trees.count === '0 / 15', JSON.stringify(m.nodes));
    check(m.nodes.filter((n) => n.next).map((n) => n.id).join() === expectedNext.topic, `next topic: ${JSON.stringify(m.nodes.filter((n) => n.next))}`);
    check(byId['arrays-hashing'].label === 'Arrays & Hashing, 8 of 9 solved, recommended next', byId['arrays-hashing'].label);
    check(m.edges.length === NEETCODE_150.edges.length, `edges: ${m.edges.length}`);
    check(m.edges.includes('arrays-hashing>two-pointers*') && m.edges.includes('trees>heap') && !m.edges.includes('trees>heap*'), `lit edges follow started topics: ${m.edges}`);
    // Reading order for Tab: top to bottom, then left to right.
    check(m.nodes[0].id === 'arrays-hashing' && m.nodes[1].id === 'two-pointers' && m.nodes[2].id === 'stack' && m.nodes.at(-1).id === 'math-geometry', `order: ${m.nodes.map((n) => n.id)}`);
  });

  // Every line starts at the middle of its topic's bottom edge, ends at the
  // middle of the next one's top edge, and crosses no other node.
  const routing = () =>
    page.eval(`(() => {
      const graph = document.getElementById('graph').getBoundingClientRect();
      const rects = Object.fromEntries([...document.querySelectorAll('.node')].map((n) => [n.dataset.topic, n.getBoundingClientRect()]));
      const problems = [];
      for (const path of document.querySelectorAll('.edge')) {
        const from = rects[path.dataset.from];
        const to = rects[path.dataset.to];
        const len = path.getTotalLength();
        const start = path.getPointAtLength(0);
        const end = path.getPointAtLength(len);
        const near = (a, b) => Math.abs(a - b) <= 0.5;
        if (!near(graph.left + start.x, from.left + from.width / 2) || !near(graph.top + start.y, from.bottom)) problems.push('start ' + path.dataset.from);
        if (!near(graph.left + end.x, to.left + to.width / 2) || !near(graph.top + end.y, to.top)) problems.push('end ' + path.dataset.to);
        for (let i = 1; i < 60; i += 1) {
          const p = path.getPointAtLength((len * i) / 60);
          const x = graph.left + p.x;
          const y = graph.top + p.y;
          for (const [id, r] of Object.entries(rects)) {
            if (x > r.left + 2 && x < r.right - 2 && y > r.top + 2 && y < r.bottom - 2) problems.push(path.dataset.from + '>' + path.dataset.to + ' crosses ' + id);
          }
        }
      }
      const titles = [...document.querySelectorAll('.node-title')].filter((t) => t.scrollWidth > t.clientWidth).map((t) => t.textContent);
      return { problems: [...new Set(problems)], clipped: titles, size: document.getElementById('graph').dataset.size };
    })()`);

  await scenario('lines are routed from bottom middle to top middle and never cross another node; no title is cut (wide)', async () => {
    const r = await routing();
    check(r.size === 'wide', `size: ${r.size}`);
    check(r.problems.length === 0, r.problems.join('; '));
    check(r.clipped.length === 0, `cut titles: ${r.clipped}`);
  });

  await scenario('screenshots: dark and light, wide', async () => {
    await page.screenshot(path.join(shots, 'progress-dark.png'), { width: 1280, height: 1300, scheme: 'dark' });
    await page.screenshot(path.join(shots, 'progress-light.png'), { width: 1280, height: 1300, scheme: 'light' });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  });

  await scenario('a click on a node opens its side panel: title, count, prerequisites, problem table with links and colors', async () => {
    await page.eval(`document.querySelector('.node[data-topic="two-pointers"]').click()`);
    await page.waitFor(`!document.getElementById('drawer').hidden`, { what: 'the side panel' });
    const m = await page.eval(`(() => {
      const d = document.getElementById('drawer');
      return {
        title: document.getElementById('drawer-title').textContent,
        focus: document.activeElement.id,
        prereqs: [...d.querySelectorAll('.prereq')].map((b) => b.textContent),
        heads: [...d.querySelectorAll('th')].map((t) => t.textContent),
        rows: [...d.querySelectorAll('tbody tr')].map((tr) => ({
          slug: tr.dataset.slug,
          solved: tr.querySelector('.mark').getAttribute('aria-pressed'),
          star: tr.querySelector('.star').getAttribute('aria-pressed'),
          title: tr.querySelector('.col-title a').textContent,
          href: tr.querySelector('.col-title a').href,
          target: tr.querySelector('.col-title a').target,
          rel: tr.querySelector('.col-title a').rel,
          diff: tr.querySelector('.diff').textContent,
          color: getComputedStyle(tr.querySelector('.diff')).color,
          tip: tr.querySelector('.mark').title,
        })),
        backdrop: !document.getElementById('backdrop').hidden,
        scrollLocked: getComputedStyle(document.documentElement).overflow,
      };
    })()`);
    check(m.title === 'Two Pointers (2 / 5)', `title: ${m.title}`);
    check(m.focus === 'drawer-title' && m.backdrop && m.scrollLocked === 'hidden', JSON.stringify(m));
    check(JSON.stringify(m.prereqs) === JSON.stringify(['Arrays & Hashing8 / 9']), `prerequisites: ${m.prereqs}`);
    check(JSON.stringify(m.heads) === JSON.stringify(['Status', 'Star', 'Problem', 'Difficulty']), `headers: ${m.heads}`);
    const tp = NEETCODE_150.topics.find((t) => t.id === 'two-pointers').problems;
    check(m.rows.map((r) => r.slug).join() === tp.map((p) => p.slug).join(), 'rows in roadmap order');
    for (const [i, r] of m.rows.entries()) {
      check(r.href === `https://leetcode.com/problems/${tp[i].slug}/` && r.target === '_blank' && r.rel.includes('noopener'), `link: ${JSON.stringify(r)}`);
      check(r.title === tp[i].title && r.diff === tp[i].difficulty, `row: ${JSON.stringify(r)}`);
    }
    const colors = Object.fromEntries(m.rows.map((r) => [r.diff, r.color]));
    check(colors.Easy === 'rgb(44, 187, 93)' && colors.Medium === 'rgb(255, 161, 22)' && colors.Hard === 'rgb(248, 97, 92)', `dark colors: ${JSON.stringify(colors)}`);
    check(m.rows[0].solved === 'true' && m.rows[2].solved === 'true' && m.rows[1].solved === 'false', `marks: ${JSON.stringify(m.rows.map((r) => r.solved))}`);
    check(/^Accepted on Nov 2, 2026/.test(m.rows[0].tip) && /by hand/.test(m.rows[2].tip), `tips: ${m.rows[0].tip} / ${m.rows[2].tip}`);
    check(m.rows[4].star === 'true' && m.rows[0].star === 'false', 'stars');
    await page.screenshot(path.join(shots, 'drawer-dark.png'), { width: 1280, height: 900, scheme: 'dark' });
    await page.screenshot(path.join(shots, 'drawer-light.png'), { width: 1280, height: 900, scheme: 'light' });
    const light = await page.eval(`[...document.querySelectorAll('#drawer .diff')].map((d) => d.textContent + ':' + getComputedStyle(d).color)`);
    check(light.includes('Easy:rgb(14, 138, 58)') && light.includes('Medium:rgb(179, 83, 0)') && light.includes('Hard:rgb(211, 47, 47)'), `light colors: ${light}`);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  });

  await scenario('a prerequisite card opens that topic, and the recommended problem is marked in its table', async () => {
    await page.eval(`document.querySelector('#drawer .prereq').click()`);
    await sleep(100);
    const m = await page.eval(`({ title: document.getElementById('drawer-title').textContent, focus: document.activeElement.id, prereqs: document.querySelector('#drawer .hint')?.textContent, next: [...document.querySelectorAll('#drawer tr[data-next]')].map((tr) => tr.dataset.slug + ':' + tr.querySelector('.next-pill').textContent) })`);
    check(m.title === 'Arrays & Hashing (8 / 9)' && m.focus === 'drawer-title', JSON.stringify(m));
    check(m.prereqs === 'None. This is where the roadmap starts.', `no prerequisites: ${m.prereqs}`);
    check(JSON.stringify(m.next) === JSON.stringify([`${expectedNext.slug}:Next`]), `next row: ${JSON.stringify(m.next)}`);
  });

  const stored = () => browser.serviceWorkerEval(`chrome.storage.local.get(['solvedProblems', 'starredProblems'])`);

  await scenario('marking a problem solved and unmarking it go through the worker into storage, and the graph follows', async () => {
    const slug = expectedNext.slug;
    await page.eval(`(() => { const b = document.querySelector('#drawer .mark[data-slug="${slug}"]'); b.focus(); b.click(); })()`);
    await page.waitFor(`document.getElementById('drawer-title').textContent === 'Arrays & Hashing (9 / 9)'`, { what: 'the count to go up' });
    let s = await stored();
    check(s.solvedProblems[slug] && s.solvedProblems[slug].manual === true && s.solvedProblems[slug].count === 0, `stored: ${JSON.stringify(s.solvedProblems[slug])}`);
    const m = await page.eval(`({ node: document.querySelector('.node[data-topic="arrays-hashing"]').getAttribute('aria-label'), complete: document.querySelector('.node[data-topic="arrays-hashing"]').hasAttribute('data-complete'), focus: document.activeElement.dataset.role + ':' + document.activeElement.dataset.slug, total: document.querySelector('.total').textContent })`);
    check(m.node === 'Arrays & Hashing, 9 of 9 solved, complete' && m.complete, `node: ${JSON.stringify(m)}`);
    check(m.focus === `mark:${slug}`, `focus stays on the mark: ${m.focus}`);
    check(m.total === '12 / 150 solved', m.total);
    await page.screenshot(path.join(shots, 'drawer-complete-dark.png'), { width: 1280, height: 900, scheme: 'dark' });
    // A detected problem can be unmarked too.
    await page.eval(`document.querySelector('#drawer .mark[data-slug="contains-duplicate"]').click()`);
    await page.waitFor(`document.getElementById('drawer-title').textContent === 'Arrays & Hashing (8 / 9)'`, { what: 'the count to go down' });
    s = await stored();
    check(!s.solvedProblems['contains-duplicate'] && s.solvedProblems[slug], `after unmarking: ${Object.keys(s.solvedProblems)}`);
    await page.eval(`document.querySelector('#drawer .mark[data-slug="contains-duplicate"]').click()`);
    await page.waitFor(`document.getElementById('drawer-title').textContent === 'Arrays & Hashing (9 / 9)'`, { what: 'marked again' });
  });

  await scenario('a star toggles in storage', async () => {
    await page.eval(`document.querySelector('#drawer .star[data-slug="two-sum"]').click()`);
    await page.waitFor(`document.querySelector('#drawer .star[data-slug="two-sum"]').getAttribute('aria-pressed') === 'true'`, { what: 'the star' });
    await sleep(150);
    let s = await stored();
    check(s.starredProblems['two-sum'] === true && s.starredProblems['trapping-rain-water'] === true, JSON.stringify(s.starredProblems));
    await page.eval(`document.querySelector('#drawer .star[data-slug="two-sum"]').click()`);
    await sleep(200);
    s = await stored();
    check(!s.starredProblems['two-sum'], JSON.stringify(s.starredProblems));
  });

  await scenario('a change the worker does not save goes back to what storage holds, keeping a later one that was saved', async () => {
    // The unmark of two-sum fails after a while; the unmark of
    // contains-duplicate, pressed meanwhile, is saved.
    await page.eval(`(() => {
      window.__plainSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (m) => {
        if (m && m.slug === 'two-sum') {
          await new Promise((r) => setTimeout(r, 400));
          return { ok: false };
        }
        return window.__plainSend(m);
      };
    })()`);
    const pressed = (slug, role = 'mark') => page.eval(`document.querySelector('#drawer .${role}[data-slug="${slug}"]').getAttribute('aria-pressed')`);
    try {
      await page.eval(`document.querySelector('#drawer .mark[data-slug="two-sum"]').click()`);
      await page.eval(`document.querySelector('#drawer .mark[data-slug="contains-duplicate"]').click()`);
      await page.waitFor(`/did not save/.test(document.body.textContent)`, { what: 'the note' });
      await sleep(100);
      const s = await stored();
      check(s.solvedProblems['two-sum'] && !s.solvedProblems['contains-duplicate'], `stored: ${Object.keys(s.solvedProblems)}`);
      check((await pressed('two-sum')) === 'true', 'the failed unmark is undone');
      check((await pressed('contains-duplicate')) === 'false', 'the saved unmark stays');
      // The same for a star.
      await page.eval(`document.querySelector('#drawer .star[data-slug="two-sum"]').click()`);
      await page.eval(`document.querySelector('#drawer .star[data-slug="contains-duplicate"]').click()`);
      await sleep(700);
      const t = await stored();
      check(!t.starredProblems['two-sum'] && t.starredProblems['contains-duplicate'] === true, `starred: ${JSON.stringify(t.starredProblems)}`);
      check((await pressed('two-sum', 'star')) === 'false' && (await pressed('contains-duplicate', 'star')) === 'true', 'stars follow storage');
    } finally {
      await page.eval(`chrome.runtime.sendMessage = window.__plainSend`);
    }
    // Back as before for the rest of the run.
    await page.eval(`document.querySelector('#drawer .mark[data-slug="contains-duplicate"]').click()`);
    await page.eval(`document.querySelector('#drawer .star[data-slug="contains-duplicate"]').click()`);
    await page.waitFor(`document.getElementById('drawer-title').textContent === 'Arrays & Hashing (9 / 9)'`, { what: 'marked again' });
    await sleep(200);
  });

  await scenario('an accepted submission stored while the page is open shows up at once', async () => {
    await browser.serviceWorkerEval(`chrome.storage.local.get('solvedProblems').then((s) => chrome.storage.local.set({ solvedProblems: { ...s.solvedProblems, 'valid-sudoku': { at: new Date().toISOString(), count: 1 } } }))`);
    await page.waitFor(`document.querySelector('#drawer tr[data-slug="valid-sudoku"] .mark').getAttribute('aria-pressed') === 'true'`, { what: 'the live update' });
  });

  await scenario('keyboard: Escape closes and gives focus back to the node; Tab stays inside the open panel', async () => {
    await key(page, 'Escape');
    let m = await page.eval(`({ hidden: document.getElementById('drawer').hidden, focus: document.activeElement.dataset.topic, locked: getComputedStyle(document.documentElement).overflow })`);
    check(m.hidden && m.focus === 'two-pointers' && m.locked !== 'hidden', `after Escape: ${JSON.stringify(m)}`);
    // Arrow keys walk the graph.
    await key(page, 'ArrowDown');
    check((await focused(page)) === 'binary-search', `ArrowDown from Two Pointers: ${await focused(page)}`);
    await key(page, 'ArrowLeft');
    check((await focused(page)) === 'sliding-window', `ArrowLeft: ${await focused(page)}`);
    await key(page, 'ArrowUp');
    check((await focused(page)) === 'two-pointers', `ArrowUp: ${await focused(page)}`);
    await key(page, 'ArrowRight');
    check((await focused(page)) === 'stack', `ArrowRight: ${await focused(page)}`);
    await key(page, 'Tab');
    check((await focused(page)) === 'sliding-window', `Tab goes in reading order: ${await focused(page)}`);
    await key(page, 'Enter');
    await page.waitFor(`!document.getElementById('drawer').hidden && document.getElementById('drawer-title').textContent.startsWith('Sliding Window')`, { what: 'Enter to open' });
    check((await focused(page)) === 'drawer-title', 'focus on the title');
    const seen = [];
    for (let i = 0; i < 24; i += 1) {
      await key(page, 'Tab');
      seen.push(await focused(page));
    }
    const inside = await page.eval(`document.getElementById('drawer').contains(document.activeElement)`);
    check(inside, `focus left the panel: ${seen}`);
    check(seen[0] === 'iconbtn close' && seen.includes('mark:best-time-to-buy-and-sell-stock') && seen.filter((s) => s === 'iconbtn close').length >= 2, `Tab order wraps: ${seen}`);
    await key(page, 'Tab', { shift: true });
    await key(page, 'Escape');
    check((await focused(page)) === 'sliding-window', 'focus back on the node');
    // Space on a mark toggles it.
    await key(page, 'Enter');
    await page.eval(`document.querySelector('#drawer .mark[data-slug="sliding-window-maximum"]').focus()`);
    await key(page, ' ');
    await page.waitFor(`document.querySelector('#drawer .mark[data-slug="sliding-window-maximum"]').getAttribute('aria-pressed') === 'true'`, { what: 'Space to mark' });
    await key(page, ' ');
    await page.waitFor(`document.querySelector('#drawer .mark[data-slug="sliding-window-maximum"]').getAttribute('aria-pressed') === 'false'`, { what: 'Space to unmark' });
    await key(page, 'Escape');
  });

  await scenario('the tab bar: arrow keys switch tabs, the address follows, the settings come back intact', async () => {
    await page.eval(`document.getElementById('tab-progress').focus()`);
    await key(page, 'ArrowLeft');
    const m = await page.eval(`({ hash: location.hash, focus: document.activeElement.id, settings: !document.getElementById('panel-settings').hidden, progress: document.getElementById('panel-progress').hidden, form: document.getElementById('form').getBoundingClientRect().height > 100, conn: getComputedStyle(document.getElementById('connection')).display, sub: document.getElementById('page-sub').textContent, tabindex: [document.getElementById('tab-settings').tabIndex, document.getElementById('tab-progress').tabIndex] })`);
    check(m.hash === '' && m.focus === 'tab-settings' && m.settings && m.progress && m.form && m.conn === 'flex' && m.sub === 'Tutor settings', JSON.stringify(m));
    check(JSON.stringify(m.tabindex) === '[0,-1]', `roving tabindex: ${m.tabindex}`);
    await page.screenshot(path.join(shots, 'settings-tab-dark.png'), { width: 1280, height: 700, scheme: 'dark' });
    await key(page, 'ArrowRight');
    check(await page.eval(`location.hash === '#progress' && !document.getElementById('panel-progress').hidden`), 'back to Progress');
  });

  for (const width of [400, 600, 900]) {
    await scenario(`${width} px wide: no sideways page scroll; the graph scrolls inside its own box; the panel fits`, async () => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      const m = await page.eval(`(() => {
        const canvas = document.getElementById('canvas');
        const next = document.querySelector('.node[data-next]') || document.querySelector('.node');
        const nr = next.getBoundingClientRect();
        const cr = canvas.getBoundingClientRect();
        return {
          page: document.scrollingElement.scrollWidth - window.innerWidth,
          canvasScrolls: canvas.scrollWidth > canvas.clientWidth,
          nextVisible: nr.left >= cr.left - 1 && nr.right <= cr.right + 1,
          size: document.getElementById('graph').dataset.size,
          tabs: document.querySelector('.tabs').scrollWidth <= document.querySelector('.tabs').clientWidth,
        };
      })()`);
      check(m.page <= 0, `the page scrolls sideways by ${m.page}px`);
      check(m.size === (width >= 1088 ? 'wide' : 'compact'), `size: ${m.size}`);
      check(m.canvasScrolls === (width < 880), `canvas scroll: ${JSON.stringify(m)}`);
      check(m.nextVisible, `the recommended topic starts in view: ${JSON.stringify(m)}`);
      const r = await routing();
      check(r.problems.length === 0 && r.clipped.length === 0, `routing at ${width}: ${JSON.stringify(r)}`);
      await page.screenshot(path.join(shots, `progress-${width}-dark.png`), { width, height: 900, scheme: 'dark' });
      await page.eval(`document.querySelector('.node[data-topic="trees"]').click()`);
      await sleep(150);
      const d = await page.eval(`(() => {
        const drawer = document.getElementById('drawer');
        const table = drawer.querySelector('table');
        const cells = [...drawer.querySelectorAll('td, th')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent);
        return { drawer: drawer.getBoundingClientRect().width, table: table.getBoundingClientRect().right <= drawer.getBoundingClientRect().right, sideways: drawer.scrollWidth > drawer.clientWidth, cells, page: document.scrollingElement.scrollWidth - window.innerWidth };
      })()`);
      check(d.table && !d.sideways && d.cells.length === 0 && d.page <= 0, `panel at ${width}: ${JSON.stringify(d)}`);
      if (width <= 560) check(d.drawer === width, `full width panel: ${d.drawer}`);
      await page.screenshot(path.join(shots, `drawer-${width}-dark.png`), { width, height: 900, scheme: 'dark' });
      await page.screenshot(path.join(shots, `drawer-${width}-light.png`), { width, height: 900, scheme: 'light' });
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await key(page, 'Escape');
    });
  }

  await scenario('no exceptions on the page', async () => {
    const errors = page.console.filter((l) => /exception|error/i.test(l) && !/localhost:8135|ERR_CONNECTION_REFUSED|Failed to fetch/.test(l));
    check(errors.length === 0, errors.join('\n'));
  });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
