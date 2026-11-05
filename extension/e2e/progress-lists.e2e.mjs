// End-to-end check of the Progress tab's lists in the REAL unpacked
// extension (Playwright's cached Chromium): the "Problem Sets" choice (first
// run default, every list with its size and description, mouse and
// keyboard, stored in storage.local through the worker, never touching the
// solved problems, kept across a reload, followed when another page changes
// it), NeetCode 250 on the NeetCode roadmap, the grouped layout every list
// without a roadmap graph gets (group cards in the list's order with counts
// and difficulty bars, the Next group, the side panel, marking and
// unmarking, the keyboard, light and dark, and widths from 400 px) and
// Grind 75's switch between its weeks and subjects.
//
// Run with:  node extension/e2e/progress-lists.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-lists-shots).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { BLIND_75, GRIND_75, LISTS, NEETCODE_250, SQL_50, TOP_100_LIKED, TOP_INTERVIEW_150, nextOnRoadmap, progress } from '../shared/roadmap.js';

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
const focused = (page) => page.eval(`(() => { const a = document.activeElement; return a ? (a.dataset.topic || ((a.id === 'list-select' || a.id === 'list-options') && 'list:' + (document.getElementById('list-select').dataset.value)) || (a.dataset.slug && a.dataset.role + ':' + a.dataset.slug) || a.id || a.className || a.tagName) : null; })()`);

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
    await page.waitFor(`document.querySelectorAll('.title-option').length === ${LISTS.length} && document.querySelector('.total-done')`, { what: 'the Progress tab' });
    await sleep(150);
  };
  await open();

  await scenario('first run: NeetCode 150 is chosen, every list is a plain name in one menu', async () => {
    const m = await page.eval(`({
      label: document.getElementById('list-options').getAttribute('aria-label'),
      options: [...document.querySelectorAll('.title-option')].map((o) => ({ id: o.dataset.list, name: o.textContent })),
      value: document.getElementById('list-select').dataset.value,
      descriptions: document.querySelectorAll('.list-desc, .list-size').length,
      nodes: document.querySelectorAll('.node').length,
      sub: document.getElementById('page-sub').textContent,
      title: document.querySelector('#list-select .title-text').textContent,
      tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent),
    })`);
    check(m.label === 'Problem Sets', m.label);
    check(m.tabs.join() === 'Progress,Settings', `tab order: ${m.tabs}`);
    check(m.options.map((o) => o.id).join() === LISTS.map((l) => l.id).join(), `order: ${m.options.map((o) => o.id)}`);
    for (const [i, o] of m.options.entries()) check(o.name === LISTS[i].title, JSON.stringify(o));
    check(m.options.find((o) => o.id === 'top-100-liked').name === 'Top 100 Liked by LeetCode' && m.options.find((o) => o.id === 'top-interview-150').name === 'Top Interview 150 by LeetCode', 'by LeetCode names');
    check(m.value === 'neetcode-150' && m.descriptions === 0, JSON.stringify(m));
    check(m.nodes === 18 && m.sub === 'Your NeetCode 150 progress' && m.title === 'NeetCode 150', JSON.stringify(m));
    check((await stored()).activeProgressList === undefined, 'nothing stored before a choice');
    await page.screenshot(path.join(shots, 'picker-neetcode-dark.png'), { width: 1280, height: 700, scheme: 'dark' });
  });

  // Every list's name shows whole on the title button with its arrow right after it, at any width.
  await scenario('each list name shows whole in the title menu at 1280 and 400 px', async () => {
    for (const width of [1280, 400]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      for (const list of LISTS) {
        await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-${list.id}').click(); })()`);
        await page.waitFor(`document.getElementById('list-select').dataset.value === '${list.id}' && document.querySelector('.total-done')`, { what: list.title });
        await sleep(120);
        const m = await page.eval(`(() => {
          const t = document.querySelector('#list-select .title-text');
          const box = document.getElementById('summary').getBoundingClientRect();
          const r = document.getElementById('list-select').getBoundingClientRect();
          return { text: t.textContent, cut: t.scrollWidth > t.clientWidth + 1, out: r.right > box.right || r.left < box.left, chevronAfter: document.querySelector('#list-select svg').getBoundingClientRect().left - t.getBoundingClientRect().right };
        })()`);
        check(m.text === list.title && !m.cut && !m.out && m.chevronAfter >= 0 && m.chevronAfter <= 8, `${width} ${list.title}: ${JSON.stringify(m)}`);
      }
    }
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-neetcode-150').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.node').length === 18`, { what: 'NeetCode 150 again' });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  });

  // The title is the menu: no extra card, and the sync button sits under the count.
  for (const width of [1280, 720, 400]) {
    await scenario(`the title menu and the sync button at ${width} px`, async () => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      const m = await page.eval(`(() => {
        const box = document.getElementById('summary').getBoundingClientRect();
        const select = document.getElementById('list-select').getBoundingClientRect();
        const total = document.querySelector('.total').getBoundingClientRect();
        const button = document.getElementById('sync-btn').getBoundingClientRect();
        return { cards: document.querySelectorAll('.card.lists').length, out: select.right > box.right + 0.5 || button.right > box.right + 0.5 || button.left < box.left - 0.5, below: button.right <= total.left, sameColumn: Math.abs(total.right - box.right) < 24 || ${width} < 761 };
      })()`);
      check(m.cards === 0 && !m.out && m.below && m.sameColumn, `${width}: ${JSON.stringify(m)}`);
      await page.screenshot(path.join(shots, `picker-${width}-dark.png`), { width, height: width === 400 ? 700 : 500, scheme: 'dark' });
    });
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  await scenario('the open menu is the page\'s own: all names, the chosen one marked, Escape and an outside click close it', async () => {
    await page.eval(`document.getElementById('list-select').click()`);
    await page.waitFor(`!document.getElementById('list-options').hidden`, { what: 'the open menu' });
    const m = await page.eval(`(() => {
      const list = document.getElementById('list-options').getBoundingClientRect();
      const st = getComputedStyle(document.getElementById('list-options'));
      return { names: [...document.querySelectorAll('.title-option')].map((o) => o.textContent), chosen: [...document.querySelectorAll('.title-option[aria-selected="true"]')].map((o) => o.dataset.list), radius: st.borderTopLeftRadius, bg: st.backgroundColor, native: document.querySelectorAll('#summary select').length, inView: list.bottom <= window.innerHeight && list.right <= window.innerWidth };
    })()`);
    check(m.names.join() === LISTS.map((l) => l.title).join() && m.chosen.join() === 'neetcode-150' && m.radius === '8px' && m.native === 0 && m.inView, JSON.stringify(m));
    await page.screenshot(path.join(shots, 'menu-open-dark.png'), { width: 1280, height: 600, scheme: 'dark' });
    await key(page, 'Escape');
    await page.waitFor(`document.getElementById('list-options').hidden`, { what: 'Escape closing it' });
    check((await focused(page)) === 'list:neetcode-150', `focus back on the title: ${await focused(page)}`);
    await page.eval(`document.getElementById('list-select').click()`);
    await page.waitFor(`!document.getElementById('list-options').hidden`, { what: 'reopening' });
    await page.eval(`document.getElementById('roadmap-heading').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await page.waitFor(`document.getElementById('list-options').hidden`, { what: 'an outside click closing it' });
  });

  await scenario('choosing Blind 75 with the mouse: grouped layout, summary, Next group; stored, solved problems untouched', async () => {
    const before = await stored();
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-blind-75').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.group').length === 10`, { what: 'the Blind 75 groups' });
    await sleep(200);
    const after = await stored();
    check(after.activeProgressList === 'blind-75', `stored: ${after.activeProgressList}`);
    check(JSON.stringify(after.solvedProblems) === JSON.stringify(before.solvedProblems), 'the solved problems changed');
    const all = progress(BLIND_75, Object.keys(seed));
    const next = nextOnRoadmap(BLIND_75, Object.keys(seed))[0];
    const m = await page.eval(`({
      sub: document.getElementById('page-sub').textContent,
      title: document.querySelector('#list-select .title-text').textContent,
      help: document.querySelectorAll('#summary .help').length,
      total: document.querySelector('.total').textContent,
      next: document.querySelector('.next-up').textContent,
      nodes: document.querySelectorAll('.node').length,
      cards: [...document.querySelectorAll('.group')].map((g) => ({ id: g.dataset.topic, step: g.querySelector('.group-step').textContent, title: g.querySelector('.group-title').textContent, count: g.querySelector('.node-count').textContent, next: g.hasAttribute('data-next'), complete: g.hasAttribute('data-complete'), levels: [...g.querySelectorAll('.group-level')].filter((l) => !l.hidden).map((l) => l.querySelector('.group-level-text').textContent), label: g.getAttribute('aria-label') })),
      foot: document.querySelectorAll('#progress-foot').length,
    })`);
    check(m.sub === 'Your Blind 75 progress' && m.title === 'Blind 75' && m.nodes === 0, JSON.stringify(m));
    check(m.help === 0, 'no description under the title');
    check(m.total === `${all.solved} / 75 solved`, `total: ${m.total}`);
    check(m.next === `Next up${next.title}${next.difficulty}inArray`, `next: ${m.next}`);
    check(m.cards.map((c) => c.title).join() === BLIND_75.topics.map((t) => t.title).join(), 'cards in the list order');
    check(m.cards.map((c) => c.step).join() === '1,2,3,4,5,6,7,8,9,10', 'numbered');
    check(m.cards[0].count === '9 / 10' && m.cards[0].next && m.cards.filter((c) => c.next).length === 1, JSON.stringify(m.cards[0]));
    check(m.cards[2].count === '2 / 11', `DP counts Climbing Stairs and Combination Sum IV: ${m.cards[2].count}`);
    check(JSON.stringify(m.cards[0].levels) === JSON.stringify(['E 3/3', 'M 6/7']), `difficulty parts: ${m.cards[0].levels}`);
    check(m.cards[0].label === 'Array, category 1 of 10, 9 of 10 solved, recommended next. Easy 3 of 3, Medium 6 of 7', m.cards[0].label);
    check(m.foot === 0, 'no description at the bottom');
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

  await scenario('keyboard on the list menu: arrows move it, the layout and storage follow, Tab leaves it', async () => {
    await page.eval(`document.getElementById('list-select').focus()`);
    check((await focused(page)) === 'list:blind-75', `focus: ${await focused(page)}`);
    await key(page, 'ArrowDown');
    await page.waitFor(`!document.getElementById('list-options').hidden && document.getElementById('list-select').getAttribute('aria-expanded') === 'true'`, { what: 'the menu opening' });
    await key(page, 'ArrowDown');
    await key(page, 'Enter');
    await page.waitFor(`document.querySelectorAll('.group').length === 8`, { what: 'Grind 75' });
    check((await focused(page)) === 'list:grind-75', `focus returns to the title: ${await focused(page)}`);
    await sleep(150);
    check((await stored()).activeProgressList === 'grind-75', 'stored');
    const m = await page.eval(`({ titles: [...document.querySelectorAll('.group-title')].map((n) => n.textContent), sub: document.getElementById('page-sub').textContent, next: document.querySelector('.next-up').textContent })`);
    const next = nextOnRoadmap(GRIND_75, Object.keys(seed))[0];
    check(m.titles.join() === 'Week 1,Week 2,Week 3,Week 4,Week 5,Week 6,Week 7,Week 8' && m.sub === 'Your Grind 75 progress', JSON.stringify(m));
    check(m.next === `Next up${next.title}${next.difficulty}inWeek 1`, m.next);
    await key(page, 'Tab');
    check((await focused(page)) !== null && !(await focused(page)).startsWith('list:'), `Tab leaves the menu: ${await focused(page)}`);
    await page.screenshot(path.join(shots, 'grind-dark.png'), { width: 1280, height: 1000, scheme: 'dark' });
  });

  await scenario('Grind 75 by subject: the switch, one card per subject, Next where the weekly order puts it, remembered, no "Comes after"', async () => {
    const before = await stored();
    let m = await page.eval(`({ bar: !document.getElementById('view-bar').hidden, legend: document.querySelector('.view-switch legend').textContent, segments: [...document.querySelectorAll('.segment')].map((s) => s.textContent + (s.querySelector('input').checked ? '*' : '')) })`);
    check(m.bar && m.legend === 'Group by' && m.segments.join() === 'Week*,Subject', JSON.stringify(m));
    await page.eval(`document.querySelector('.segment[data-view="subject"]').click()`);
    await page.waitFor(`document.querySelectorAll('.group').length === ${GRIND_75.subjects.length}`, { what: 'the subjects' });
    const next = nextOnRoadmap(GRIND_75, Object.keys(seed))[0];
    const subject = GRIND_75.subjects.find((t) => t.id === next.subject);
    m = await page.eval(`({
      titles: [...document.querySelectorAll('.group-title')].map((n) => n.textContent),
      counts: [...document.querySelectorAll('.group')].map((g) => g.dataset.topic + ':' + g.querySelector('.node-count').textContent),
      nextCards: [...document.querySelectorAll('.group[data-next]')].map((g) => g.dataset.topic),
      next: document.querySelector('.next-up').textContent,
      help: document.querySelectorAll('#summary .help').length,
      heading: document.getElementById('roadmap-heading').textContent,
      label: document.querySelector('.group').getAttribute('aria-label'),
      saved: localStorage.getItem('lc-progress-view'),
    })`);
    check(m.titles.join() === GRIND_75.subjects.map((t) => t.title).join(), `titles: ${m.titles}`);
    const want = progress({ topics: GRIND_75.subjects }, Object.keys(seed)).topics.map((t) => `${t.id}:${t.solved} / ${t.total}`);
    check(m.counts.join() === want.join(), `counts: ${m.counts}`);
    check(m.nextCards.join() === next.subject && m.next === `Next up${next.title}${next.difficulty}in${subject.title}`, JSON.stringify(m));
    check(m.help === 0 && m.heading === 'Grind 75 subjects', JSON.stringify(m));
    check(m.label.startsWith(`Arrays & Hashing, subject 1 of ${GRIND_75.subjects.length},`), m.label);
    check(m.saved === '{"grind-75":"subject"}', `remembered: ${m.saved}`);
    check(JSON.stringify(await stored()) === JSON.stringify(before), 'the switch wrote to storage.local');
    await page.screenshot(path.join(shots, 'grind-subjects-dark.png'), { width: 1280, height: 1300, scheme: 'dark' });
    await page.screenshot(path.join(shots, 'grind-subjects-light.png'), { width: 1280, height: 1300, scheme: 'light' });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    // The Next card opens on its problems, with no group order to show.
    await page.eval(`document.querySelector('.next-up .linkbtn').click()`);
    await page.waitFor(`!document.getElementById('drawer').hidden`, { what: 'the subject panel' });
    m = await page.eval(`({ title: document.getElementById('drawer-title').textContent, h3: document.querySelectorAll('#drawer h3').length, prereqs: document.querySelectorAll('#drawer .prereq').length, rows: [...document.querySelectorAll('#drawer tbody tr')].map((tr) => tr.dataset.slug), next: [...document.querySelectorAll('#drawer tr[data-next]')].map((tr) => tr.dataset.slug) })`);
    check(m.title.startsWith(subject.title) && m.h3 === 0 && m.prereqs === 0, JSON.stringify(m));
    check(m.rows.join() === subject.problems.map((p) => p.slug).join() && m.next.join() === next.slug, JSON.stringify(m));
    await page.screenshot(path.join(shots, 'grind-subject-drawer-dark.png'), { width: 1280, height: 900, scheme: 'dark' });
    await key(page, 'Escape');
    // The keyboard moves the switch like any radio group.
    await page.eval(`document.querySelector('.segment input:checked').focus()`);
    await key(page, 'ArrowLeft');
    await page.waitFor(`document.querySelectorAll('.group').length === 8`, { what: 'the weeks again' });
    check((await page.eval(`localStorage.getItem('lc-progress-view')`)) === '{"grind-75":"list"}', 'remembered weeks');
    await key(page, 'ArrowRight');
    await page.waitFor(`document.querySelectorAll('.group').length === ${GRIND_75.subjects.length}`, { what: 'the subjects again' });
    // Remembered across a reload; another list has no switch; back to Grind 75 keeps it.
    await open();
    check((await page.eval(`document.querySelectorAll('.group').length`)) === GRIND_75.subjects.length, 'subjects after a reload');
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-blind-75').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.group').length === 10`, { what: 'Blind 75' });
    check(await page.eval(`document.getElementById('view-bar').hidden`), 'Blind 75 has no switch');
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-grind-75').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.group').length === ${GRIND_75.subjects.length}`, { what: 'Grind 75 by subject' });
    for (const width of [400, 720]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      const fit = await page.eval(`(() => { const bar = document.getElementById('view-bar').getBoundingClientRect(); const seg = document.querySelector('.segments').getBoundingClientRect(); return { page: document.scrollingElement.scrollWidth - window.innerWidth, inside: seg.right <= bar.right && seg.left >= bar.left }; })()`);
      check(fit.page <= 0 && fit.inside, `switch at ${width}: ${JSON.stringify(fit)}`);
      await page.screenshot(path.join(shots, `grind-subjects-${width}-dark.png`), { width, height: 1100, scheme: 'dark' });
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.eval(`document.querySelector('.segment[data-view="list"]').click()`);
    await page.waitFor(`document.querySelectorAll('.group').length === 8`, { what: 'the weeks' });
  });

  await scenario('the choice survives a reload, and a change made elsewhere is followed at once', async () => {
    await open();
    let m = await page.eval(`({ checked: document.getElementById('list-select').dataset.value, groups: document.querySelectorAll('.group').length, nodes: document.querySelectorAll('.node').length })`);
    check(m.checked === 'grind-75' && m.groups === 8 && m.nodes === 0, `after reload: ${JSON.stringify(m)}`);
    await browser.serviceWorkerEval(`chrome.storage.local.set({ activeProgressList: 'sql-50' })`);
    await page.waitFor(`document.querySelectorAll('.group').length === 7 && document.getElementById('list-select').dataset.value === 'sql-50'`, { what: 'SQL 50 from elsewhere' });
    m = await page.eval(`({ total: document.querySelector('.total').textContent, first: document.querySelector('.group .node-count').textContent, title: document.querySelector('.group[data-topic="advanced-string"] .group-title').textContent })`);
    check(m.total === '1 / 50 solved' && m.first === '1 / 5' && m.title === 'Advanced String Functions / Regex / Clause', JSON.stringify(m));
    await page.screenshot(path.join(shots, 'sql-dark.png'), { width: 1280, height: 1000, scheme: 'dark' });
    // A damaged stored value means the default, and nothing breaks.
    await browser.serviceWorkerEval(`chrome.storage.local.set({ activeProgressList: 'no-such-list' })`);
    await page.waitFor(`document.querySelectorAll('.node').length === 18`, { what: 'NeetCode 150 for an unknown id' });
  });

  await scenario('Top Interview 150: 23 sections fit, the longest titles wrap inside their cards', async () => {
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-top-interview-150').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.group').length === ${TOP_INTERVIEW_150.topics.length}`, { what: 'Top Interview 150' });
    const m = await page.eval(`[...document.querySelectorAll('.group-title')].filter((n) => n.getBoundingClientRect().right > n.closest('.group').getBoundingClientRect().right - 13).map((n) => n.textContent)`);
    check(m.length === 0, `overflowing titles: ${m}`);
    await page.screenshot(path.join(shots, 'top-interview-dark.png'), { width: 1280, height: 1500, scheme: 'dark' });
    await page.screenshot(path.join(shots, 'top-interview-light.png'), { width: 1280, height: 1500, scheme: 'light' });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  });

  await scenario('Top 100 Liked: LeetCode\'s 15 groups in its order', async () => {
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-top-100-liked').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.group').length === ${TOP_100_LIKED.topics.length}`, { what: 'Top 100 Liked' });
    const m = await page.eval(`({ titles: [...document.querySelectorAll('.group-title')].map((n) => n.textContent), total: document.querySelector('.total').textContent })`);
    const all = progress(TOP_100_LIKED, Object.keys(seed));
    check(m.titles.join() === TOP_100_LIKED.topics.map((t) => t.title).join() && m.total === `${all.solved} / 100 solved`, JSON.stringify(m));
    await page.screenshot(path.join(shots, 'top-100-liked-dark.png'), { width: 1280, height: 1300, scheme: 'dark' });
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-top-interview-150').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.group').length === ${TOP_INTERVIEW_150.topics.length}`, { what: 'Top Interview 150' });
  });

  await scenario('NeetCode 250: the NeetCode roadmap with its own counts, nothing cut', async () => {
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-neetcode-250').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.node').length === 18 && document.querySelectorAll('.edge').length > 0`, { what: 'the NeetCode 250 graph' });
    const all = progress(NEETCODE_250, Object.keys(seed));
    const m = await page.eval(`({
      counts: [...document.querySelectorAll('.node')].map((n) => n.dataset.topic + ':' + n.querySelector('.node-count').textContent),
      total: document.querySelector('.total').textContent,
      help: document.querySelectorAll('#summary .help').length,
      cut: [...document.querySelectorAll('.node-title, .node-count')].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent),
      bar: document.getElementById('view-bar').hidden,
      next: document.querySelector('.next-up').textContent,
    })`);
    const want = Object.fromEntries(all.topics.map((t) => [t.id, `${t.solved} / ${t.total}`]));
    check(m.counts.every((c) => { const [id, text] = c.split(':'); return want[id] === text; }), `counts: ${m.counts}`);
    check(m.total === `${all.solved} / 250 solved` && m.help === 0 && m.cut.length === 0 && m.bar, JSON.stringify(m));
    const next = nextOnRoadmap(NEETCODE_250, Object.keys(seed))[0];
    check(m.next.startsWith(`Next up${next.title}`), m.next);
    await page.screenshot(path.join(shots, 'neetcode-250-dark.png'), { width: 1280, height: 1400, scheme: 'dark' });
    await page.screenshot(path.join(shots, 'neetcode-250-light.png'), { width: 1280, height: 1400, scheme: 'light' });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-top-interview-150').click(); })()`);
    await page.waitFor(`document.querySelectorAll('.group').length === ${TOP_INTERVIEW_150.topics.length}`, { what: 'Top Interview 150' });
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
          options: out(document.getElementById('list-select'), document.getElementById('summary')) ? 1 : 0,
          cut: [...document.querySelectorAll('.group-title, .node-count, .group-level-text')].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent),
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
    await page.eval(`(() => { const b = document.getElementById('list-select'); b.click(); document.getElementById('list-option-neetcode-150').click(); })()`);
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
