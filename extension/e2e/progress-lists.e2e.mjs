// End-to-end check of the Progress tab's lists in the REAL unpacked
// extension (Playwright's cached Chromium): the "Working on" choice (first
// run default, every list with its size and description, mouse and
// keyboard, stored in storage.local through the worker, never touching the
// solved problems, kept across a reload, followed when another page changes
// it) and the grouped layout every list without a roadmap graph gets (group
// cards in the list's order with counts and difficulty bars, the Next group,
// the side panel, marking and unmarking, the keyboard, light and dark, and
// widths from 400 px).
//
// Run with:  node extension/e2e/progress-lists.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-lists-shots).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { BLIND_75, GRIND_75, LISTS, SQL_50, TOP_INTERVIEW_150, nextOnRoadmap, progress } from '../shared/roadmap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-lists-shots';
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

const KEYS = { Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32 };
async function key(page, name, { shift = false } = {}) {
  const base = { key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: KEYS[name], modifiers: shift ? 8 : 0 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(name === 'Enter' ? { text: '\r' } : name === ' ' ? { text: ' ' } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(40);
}
const focused = (page) => page.eval(`(() => { const a = document.activeElement; return a ? (a.dataset.topic || (a.name === 'progress-list' && 'list:' + a.value) || (a.dataset.slug && a.dataset.role + ':' + a.dataset.slug) || a.id || a.className || a.tagName) : null; })()`);

// Shared solves: Two Sum and Best Time (on most lists), Climbing Stairs, one
// SQL problem, Combination Sum IV (Blind 75 only), and the rest of Blind 75's
// Array group but one.
const AT = '2026-11-02T18:30:00.000Z';
const seed = {};
for (const p of BLIND_75.topics[0].problems.slice(0, 9)) seed[p.slug] = { at: AT, count: 1 };
seed['climbing-stairs'] = { at: AT, count: 1 };
seed['combination-sum-iv'] = { at: AT, count: 0, manual: true };
seed['big-countries'] = { at: AT, count: 2 };

const browser = await launch({ extensionDir });
const stored = () => browser.serviceWorkerEval(`chrome.storage.local.get(['solvedProblems', 'starredProblems', 'activeProgressList'])`);
try {
  await browser.serviceWorkerEval(`chrome.storage.local.set(${JSON.stringify({ solvedProblems: seed })})`);
  const page = await browser.openPage('about:blank');
  await page.failFetch('http://localhost:8135/*');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const open = async () => {
    await page.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html#progress` });
    await page.waitFor(`document.querySelectorAll('.list-option').length === ${LISTS.length} && document.querySelector('.total-done')`, { what: 'the Progress tab' });
    await sleep(150);
  };
  await open();

  await scenario('first run: NeetCode 150 is chosen, every list is offered with its size and description', async () => {
    const m = await page.eval(`({
      legend: document.querySelector('#list-picker legend').textContent,
      options: [...document.querySelectorAll('.list-option')].map((o) => ({ id: o.dataset.list, name: o.querySelector('.list-name').textContent, size: o.querySelector('.list-size').textContent, desc: o.querySelector('.list-desc').textContent, checked: o.querySelector('input').checked, selected: o.hasAttribute('data-selected'), described: document.getElementById(o.querySelector('input').getAttribute('aria-describedby'))?.textContent })),
      nodes: document.querySelectorAll('.node').length,
      sub: document.getElementById('page-sub').textContent,
      title: document.getElementById('summary-heading').textContent,
    })`);
    check(m.legend === 'Working on', m.legend);
    check(m.options.map((o) => o.id).join() === LISTS.map((l) => l.id).join(), `order: ${m.options.map((o) => o.id)}`);
    for (const [i, o] of m.options.entries()) {
      check(o.name === LISTS[i].title && o.size === `${LISTS[i].size} problems` && o.desc === LISTS[i].description && o.described === o.desc, JSON.stringify(o));
      check(o.checked === (i === 0) && o.selected === (i === 0), `checked: ${JSON.stringify(o)}`);
    }
    check(/Blind 150/.test(m.options[0].desc) && /NeetCode 150 extends it/.test(m.options[1].desc), 'the Blind 150 alias and the Blind 75 note');
    check(m.nodes === 18 && m.sub === 'Your NeetCode 150 progress' && m.title === 'NeetCode 150', JSON.stringify(m));
    check((await stored()).activeProgressList === undefined, 'nothing stored before a choice');
    await page.screenshot(path.join(shots, 'picker-neetcode-dark.png'), { width: 1280, height: 700, scheme: 'dark' });
  });

  await scenario('choosing Blind 75 with the mouse: grouped layout, summary, Next group; stored, solved problems untouched', async () => {
    const before = await stored();
    await page.eval(`document.querySelector('.list-option[data-list="blind-75"]').click()`);
    await page.waitFor(`document.querySelectorAll('.group').length === 10`, { what: 'the Blind 75 groups' });
    await sleep(200);
    const after = await stored();
    check(after.activeProgressList === 'blind-75', `stored: ${after.activeProgressList}`);
    check(JSON.stringify(after.solvedProblems) === JSON.stringify(before.solvedProblems), 'the solved problems changed');
    const all = progress(BLIND_75, Object.keys(seed));
    const next = nextOnRoadmap(BLIND_75, Object.keys(seed))[0];
    const m = await page.eval(`({
      sub: document.getElementById('page-sub').textContent,
      title: document.getElementById('summary-heading').textContent,
      help: document.querySelector('#summary .help').textContent,
      total: document.querySelector('.total').textContent,
      next: document.querySelector('.next-up').textContent,
      nodes: document.querySelectorAll('.node').length,
      cards: [...document.querySelectorAll('.group')].map((g) => ({ id: g.dataset.topic, step: g.querySelector('.group-step').textContent, title: g.querySelector('.group-title').textContent, count: g.querySelector('.node-count').textContent, next: g.hasAttribute('data-next'), complete: g.hasAttribute('data-complete'), levels: [...g.querySelectorAll('.group-level')].filter((l) => !l.hidden).map((l) => l.querySelector('.group-level-text').textContent), label: g.getAttribute('aria-label') })),
      foot: document.getElementById('progress-foot').textContent,
    })`);
    check(m.sub === 'Your Blind 75 progress' && m.title === 'Blind 75' && m.nodes === 0, JSON.stringify(m));
    check(m.help.startsWith('10 categories of 75 problems'), m.help);
    check(m.total === `${all.solved} / 75 solved`, `total: ${m.total}`);
    check(m.next === `Next up${next.title}${next.difficulty}inArray`, `next: ${m.next}`);
    check(m.cards.map((c) => c.title).join() === BLIND_75.topics.map((t) => t.title).join(), 'cards in the list order');
    check(m.cards.map((c) => c.step).join() === '1,2,3,4,5,6,7,8,9,10', 'numbered');
    check(m.cards[0].count === '9 / 10' && m.cards[0].next && m.cards.filter((c) => c.next).length === 1, JSON.stringify(m.cards[0]));
    check(m.cards[2].count === '2 / 11', `DP counts Climbing Stairs and Combination Sum IV: ${m.cards[2].count}`);
    check(JSON.stringify(m.cards[0].levels) === JSON.stringify(['E 3/3', 'M 6/7']), `difficulty parts: ${m.cards[0].levels}`);
    check(m.cards[0].label === 'Array, category 1 of 10, 9 of 10 solved, recommended next. Easy 3 of 3, Medium 6 of 7', m.cards[0].label);
    check(/open a category and click a status mark/.test(m.foot) && /count in every list/.test(m.foot), m.foot);
    await page.screenshot(path.join(shots, 'blind-dark.png'), { width: 1280, height: 1100, scheme: 'dark' });
    await page.screenshot(path.join(shots, 'blind-light.png'), { width: 1280, height: 1100, scheme: 'light' });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  });

  await scenario('no group title or count is cut, and the cards line up in rows', async () => {
    const m = await page.eval(`(() => {
      const cards = [...document.querySelectorAll('.group')];
      const cut = cards.flatMap((c) => [...c.querySelectorAll('.group-title, .node-count, .group-level-text')]).filter((n) => n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > n.closest('.group').getBoundingClientRect().right - 1).map((n) => n.textContent);
      const tops = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)))];
      const heights = cards.map((c) => Math.round(c.getBoundingClientRect().height));
      return { cut, rows: tops.length, perRow: cards.filter((c) => Math.round(c.getBoundingClientRect().top) === tops[0]).length, sameHeight: new Set(heights).size <= tops.length };
    })()`);
    check(m.cut.length === 0, `cut: ${m.cut}`);
    check(m.perRow === 4 && m.rows === 3, `grid: ${JSON.stringify(m)}`);
  });

  await scenario('a group opens the side panel: count, the group before it, the problems in order with links', async () => {
    await page.eval(`document.querySelector('.group[data-topic="dynamic-programming"]').click()`);
    await page.waitFor(`!document.getElementById('drawer').hidden`, { what: 'the side panel' });
    const m = await page.eval(`(() => {
      const d = document.getElementById('drawer');
      return {
        title: document.getElementById('drawer-title').textContent,
        h3: d.querySelector('h3').textContent,
        prereqs: [...d.querySelectorAll('.prereq')].map((b) => b.textContent),
        rows: [...d.querySelectorAll('tbody tr')].map((tr) => tr.dataset.slug + ':' + tr.querySelector('.mark').getAttribute('aria-pressed')),
        hrefs: [...d.querySelectorAll('.col-title a')].map((a) => a.href),
        focus: document.activeElement.id,
      };
    })()`);
    const dp = BLIND_75.topics.find((t) => t.id === 'dynamic-programming').problems;
    check(m.title === 'Dynamic Programming (2 / 11)' && m.focus === 'drawer-title', JSON.stringify(m));
    check(m.h3 === 'Comes after' && JSON.stringify(m.prereqs) === JSON.stringify(['Binary0 / 5']), `before: ${JSON.stringify(m)}`);
    check(m.rows.join() === dp.map((p) => `${p.slug}:${seed[p.slug] ? 'true' : 'false'}`).join(), `rows: ${m.rows}`);
    check(m.hrefs.every((h, i) => h === `https://leetcode.com/problems/${dp[i].slug}/`), 'links');
    await page.screenshot(path.join(shots, 'blind-drawer-dark.png'), { width: 1280, height: 900, scheme: 'dark' });
    await page.screenshot(path.join(shots, 'blind-drawer-light.png'), { width: 1280, height: 900, scheme: 'light' });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await page.eval(`document.querySelector('#drawer .prereq').click()`);
    await sleep(100);
    const first = await page.eval(`({ title: document.getElementById('drawer-title').textContent })`);
    check(first.title === 'Binary (0 / 5)', first.title);
    await page.eval(`document.querySelector('#drawer .prereq').click()`);
    await sleep(100);
    const start = await page.eval(`({ title: document.getElementById('drawer-title').textContent, hint: document.querySelector('#drawer .hint')?.textContent, next: [...document.querySelectorAll('#drawer tr[data-next]')].map((tr) => tr.dataset.slug) })`);
    check(start.title === 'Array (9 / 10)' && start.hint === 'Nothing. This is where Blind 75 starts.', JSON.stringify(start));
    check(JSON.stringify(start.next) === JSON.stringify(['container-with-most-water']), `next row: ${start.next}`);
  });

  await scenario('marking the last Array problem moves Next to Binary; unmarking brings it back; storage follows', async () => {
    await page.eval(`(() => { const b = document.querySelector('#drawer .mark[data-slug="container-with-most-water"]'); b.focus(); b.click(); })()`);
    await page.waitFor(`document.getElementById('drawer-title').textContent === 'Array (10 / 10)'`, { what: 'the count to go up' });
    let s = await stored();
    check(s.solvedProblems['container-with-most-water']?.manual === true && s.activeProgressList === 'blind-75', JSON.stringify(s.solvedProblems['container-with-most-water']));
    let m = await page.eval(`({ next: [...document.querySelectorAll('.group[data-next]')].map((g) => g.dataset.topic), done: document.querySelector('.group[data-topic="array"]').hasAttribute('data-complete'), focus: document.activeElement.dataset.slug })`);
    check(m.next.join() === 'binary' && m.done && m.focus === 'container-with-most-water', JSON.stringify(m));
    await page.screenshot(path.join(shots, 'blind-complete-dark.png'), { width: 1280, height: 900, scheme: 'dark' });
    await page.eval(`document.querySelector('#drawer .mark[data-slug="container-with-most-water"]').click()`);
    await page.waitFor(`document.getElementById('drawer-title').textContent === 'Array (9 / 10)'`, { what: 'the count to go down' });
    s = await stored();
    check(!s.solvedProblems['container-with-most-water'], 'unmarked in storage');
    m = await page.eval(`[...document.querySelectorAll('.group[data-next]')].map((g) => g.dataset.topic).join()`);
    check(m === 'array', `next back on Array: ${m}`);
    await key(page, 'Escape');
  });

  await scenario('keyboard on the groups: arrows, Home and End move between cards; Enter opens; Escape returns', async () => {
    await page.eval(`document.querySelector('.group[data-topic="array"]').focus()`);
    await key(page, 'ArrowRight');
    check((await focused(page)) === 'binary', `ArrowRight: ${await focused(page)}`);
    await key(page, 'ArrowDown');
    check((await focused(page)) === 'linked-list', `ArrowDown from Binary (column 2): ${await focused(page)}`);
    await key(page, 'ArrowLeft');
    check((await focused(page)) === 'interval', `ArrowLeft: ${await focused(page)}`);
    await key(page, 'ArrowUp');
    check((await focused(page)) === 'array', `ArrowUp: ${await focused(page)}`);
    await key(page, 'End');
    check((await focused(page)) === 'heap', `End: ${await focused(page)}`);
    await key(page, 'ArrowRight');
    check((await focused(page)) === 'heap', 'ArrowRight at the end stays');
    await key(page, 'Home');
    check((await focused(page)) === 'array', `Home: ${await focused(page)}`);
    await key(page, 'Tab');
    check((await focused(page)) === 'binary', `Tab in list order: ${await focused(page)}`);
    await key(page, 'Enter');
    await page.waitFor(`!document.getElementById('drawer').hidden && document.getElementById('drawer-title').textContent.startsWith('Binary')`, { what: 'Enter to open' });
    await key(page, 'Escape');
    check((await focused(page)) === 'binary', 'focus back on the card');
  });

  await scenario('keyboard on the list choice: arrows move it, the layout and storage follow, Tab leaves the group', async () => {
    await page.eval(`document.querySelector('.list-option input:checked').focus()`);
    check((await focused(page)) === 'list:blind-75', `focus: ${await focused(page)}`);
    await key(page, 'ArrowRight');
    await page.waitFor(`document.querySelectorAll('.group').length === 8`, { what: 'Grind 75' });
    check((await focused(page)) === 'list:grind-75', `focus follows: ${await focused(page)}`);
    await sleep(150);
    check((await stored()).activeProgressList === 'grind-75', 'stored');
    const m = await page.eval(`({ titles: [...document.querySelectorAll('.group-title')].map((n) => n.textContent), sub: document.getElementById('page-sub').textContent, next: document.querySelector('.next-up').textContent })`);
    const next = nextOnRoadmap(GRIND_75, Object.keys(seed))[0];
    check(m.titles.join() === 'Week 1,Week 2,Week 3,Week 4,Week 5,Week 6,Week 7,Week 8' && m.sub === 'Your Grind 75 progress', JSON.stringify(m));
    check(m.next === `Next up${next.title}${next.difficulty}inWeek 1`, m.next);
    await key(page, 'Tab');
    check((await focused(page)) !== null && !(await focused(page)).startsWith('list:'), `Tab leaves the radio group: ${await focused(page)}`);
    await page.screenshot(path.join(shots, 'grind-dark.png'), { width: 1280, height: 1000, scheme: 'dark' });
  });

  await scenario('the choice survives a reload, and a change made elsewhere is followed at once', async () => {
    await open();
    let m = await page.eval(`({ checked: document.querySelector('.list-option input:checked').value, groups: document.querySelectorAll('.group').length, nodes: document.querySelectorAll('.node').length })`);
    check(m.checked === 'grind-75' && m.groups === 8 && m.nodes === 0, `after reload: ${JSON.stringify(m)}`);
    await browser.serviceWorkerEval(`chrome.storage.local.set({ activeProgressList: 'sql-50' })`);
    await page.waitFor(`document.querySelectorAll('.group').length === 7 && document.querySelector('.list-option input:checked').value === 'sql-50'`, { what: 'SQL 50 from elsewhere' });
    m = await page.eval(`({ total: document.querySelector('.total').textContent, first: document.querySelector('.group .node-count').textContent, title: document.querySelector('.group[data-topic="advanced-string"] .group-title').textContent })`);
    check(m.total === '1 / 50 solved' && m.first === '1 / 5' && m.title === 'Advanced String Functions / Regex / Clause', JSON.stringify(m));
    await page.screenshot(path.join(shots, 'sql-dark.png'), { width: 1280, height: 1000, scheme: 'dark' });
    // A damaged stored value means the default, and nothing breaks.
    await browser.serviceWorkerEval(`chrome.storage.local.set({ activeProgressList: 'no-such-list' })`);
    await page.waitFor(`document.querySelectorAll('.node').length === 18`, { what: 'NeetCode 150 for an unknown id' });
  });

  await scenario('Top Interview 150: 23 sections fit, the longest titles wrap inside their cards', async () => {
    await page.eval(`document.querySelector('.list-option[data-list="top-interview-150"]').click()`);
    await page.waitFor(`document.querySelectorAll('.group').length === ${TOP_INTERVIEW_150.topics.length}`, { what: 'Top Interview 150' });
    const m = await page.eval(`[...document.querySelectorAll('.group-title')].filter((n) => n.getBoundingClientRect().right > n.closest('.group').getBoundingClientRect().right - 13).map((n) => n.textContent)`);
    check(m.length === 0, `overflowing titles: ${m}`);
    await page.screenshot(path.join(shots, 'top-interview-dark.png'), { width: 1280, height: 1500, scheme: 'dark' });
    await page.screenshot(path.join(shots, 'top-interview-light.png'), { width: 1280, height: 1500, scheme: 'light' });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  });

  for (const width of [400, 600, 900]) {
    await scenario(`${width} px wide: no sideways page scroll, the picker and the groups fit, the panel fits`, async () => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      const m = await page.eval(`(() => {
        const canvas = document.getElementById('canvas');
        const cards = [...document.querySelectorAll('.group')];
        const out = (n, box) => n.getBoundingClientRect().right > box.getBoundingClientRect().right + 0.5 || n.getBoundingClientRect().left < box.getBoundingClientRect().left - 0.5;
        return {
          page: document.scrollingElement.scrollWidth - window.innerWidth,
          canvasScrolls: canvas.scrollWidth > canvas.clientWidth,
          cardsOut: cards.filter((c) => out(c, canvas)).length,
          perRow: cards.filter((c) => Math.round(c.getBoundingClientRect().top) === Math.round(cards[0].getBoundingClientRect().top)).length,
          options: [...document.querySelectorAll('.list-option')].filter((o) => out(o, document.getElementById('list-picker'))).length,
          cut: [...document.querySelectorAll('.group-title, .node-count, .group-level-text, .list-name, .list-size')].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent),
        };
      })()`);
      check(m.page <= 0 && !m.canvasScrolls && m.cardsOut === 0 && m.options === 0, `at ${width}: ${JSON.stringify(m)}`);
      check(m.cut.length === 0, `cut at ${width}: ${m.cut}`);
      if (width === 400) check(m.perRow === 1, `one column at 400: ${m.perRow}`);
      await page.screenshot(path.join(shots, `groups-${width}-dark.png`), { width, height: 1400, scheme: 'dark' });
      await page.screenshot(path.join(shots, `groups-${width}-light.png`), { width, height: 1400, scheme: 'light' });
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await page.eval(`document.querySelector('.group[data-topic="binary-tree-general"]').click()`);
      await sleep(150);
      const d = await page.eval(`(() => {
        const drawer = document.getElementById('drawer');
        const cells = [...drawer.querySelectorAll('td, th')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent);
        return { width: drawer.getBoundingClientRect().width, sideways: drawer.scrollWidth > drawer.clientWidth, cells };
      })()`);
      check(!d.sideways && d.cells.length === 0, `panel at ${width}: ${JSON.stringify(d)}`);
      if (width <= 560) check(d.width === width, `full width panel: ${d.width}`);
      await page.screenshot(path.join(shots, `groups-drawer-${width}-dark.png`), { width, height: 900, scheme: 'dark' });
      await key(page, 'Escape');
    });
  }

  await scenario('back to NeetCode 150: the graph returns, with its lines', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.eval(`document.querySelector('.list-option[data-list="neetcode-150"]').click()`);
    await page.waitFor(`document.querySelectorAll('.node').length === 18 && document.querySelectorAll('.edge').length > 0`, { what: 'the graph' });
    const m = await page.eval(`({ groups: document.querySelectorAll('.group').length, size: document.getElementById('graph').dataset.size, sub: document.getElementById('page-sub').textContent })`);
    check(m.groups === 0 && m.size === 'wide' && m.sub === 'Your NeetCode 150 progress', JSON.stringify(m));
    const s = await stored();
    check(s.activeProgressList === 'neetcode-150' && JSON.stringify(Object.keys(s.solvedProblems).sort()) === JSON.stringify(Object.keys(seed).sort()), JSON.stringify(s));
    check(SQL_50.size === 50, 'sizes');
  });

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
