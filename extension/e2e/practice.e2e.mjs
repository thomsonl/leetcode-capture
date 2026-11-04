// End-to-end check of "Practice a skill" in the REAL unpacked extension
// (Playwright's cached Chromium): https://leetcode.com/problems/... is served
// by the browser itself (CDP Fetch fulfils it with panel-fixture.html plus a
// fake Monaco), and so is one accepted submission's result poll, so the real
// inject.js, content.js, worker (with the bundled problem index) and panel
// do the rest.
//
// Proves: the "nice job" card offers the fixed skill chips; a chip shows the
// three problems the ranking module ranks first for that skill near the
// solved problem's difficulty, with links, difficulty colors and a reason
// line; "Show 3 more" and "Other skill" work, by mouse and keyboard, with
// focus where the student expects it; solved problems are left out, also
// ones marked after the card appeared; the header's button opens the same
// picker without a submission (reference from the page's problem, or none
// for a problem the index lacks), only once, and closes again; nothing of
// it reaches the model; it fits from 240 to 1280 px, dark and light.
//
// Run with:  node extension/e2e/practice.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-practice-shots).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';
import { practiceSuggestions, skillChoices } from '../shared/practice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-practice-shots';
fs.mkdirSync(shots, { recursive: true });

const NO_NETWORK = 'throw new TypeError(`fixture: no network for ${url.href}`);';
const fixtureSource = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8');
if (!fixtureSource.includes(NO_NETWORK) || !fixtureSource.includes('<head>')) throw new Error('the fixture changed: update this script');
const fixture = fixtureSource
  .replace('<head>', '<head><script>window.__nativeFetch = window.fetch.bind(window);</script>')
  .replace(NO_NETWORK, `if (url.pathname.startsWith("/submissions/")) return window.__nativeFetch(input, options);\n      ${NO_NETWORK}`)
  .replace(
    '</head>',
    `<script>
  window.__editorCode = 'class Solution:\\n    pass\\n';
  window.monaco = { editor: { getEditors: () => [{
    getDomNode: () => document.getElementById('pane-code'),
    getModel: () => ({ getValue: () => window.__editorCode, getLanguageId: () => 'python' }),
  }] } };
</script>
</head>`
  );

const model = { requests: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) return void res.writeHead(404).end();
    const parsed = JSON.parse(body);
    model.requests.push(parsed);
    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A short reply.' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${server.address().port}/v1`;

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
const titles = (list) => list.map((s) => s.title);

const ACCEPTED = { state: 'SUCCESS', status_msg: 'Accepted', status_code: 10, task_name: 'judger.judgetask.Judge', total_correct: 63, total_testcases: 63, run_success: true };
const judge = { 9001: [{ state: 'STARTED' }, ACCEPTED] };

const copy = extensionCopy(extensionDir, { extraHosts: ['http://127.0.0.1/*'] });
const browser = await launch({ extensionDir: copy.dir });
const pages = [];
try {
  const options = await browser.openPage('about:blank');
  await options.failFetch('http://localhost:8135/*');
  await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
  await options.waitFor(`document.getElementById('connection-text').textContent === 'Not set up'`, { what: 'the options page' });
  const saved = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:settings-save', params: ${JSON.stringify({ patch: { provider: 'local', runtimes: { local: 'extension' }, providers: { local: { baseUrl: modelUrl, model: 'stub-model' } } } })} })`);
  if (!saved.ok) throw new Error(`could not set up the stub model: ${JSON.stringify(saved)}`);

  // Solved before this run: the top Easy hash map problem after Two Sum
  // (whatever the index says it is), so the card must skip it.
  const preSolved = practiceSuggestions({ skill: 'hash-maps', reference: 'Easy', solved: ['two-sum'], exclude: 'two-sum' }).suggestions[0].slug;
  await browser.serviceWorkerEval(`chrome.storage.local.set({ solvedProblems: { ${JSON.stringify(preSolved)}: { at: '2026-11-01T00:00:00.000Z', count: 1 } } })`);
  const solvedNow = () => browser.serviceWorkerEval(`chrome.storage.local.get('solvedProblems').then((s) => Object.keys(s.solvedProblems || {}))`);

  const helpers = `(() => {
    window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
    window.__q = (sel) => window.__root().querySelector(sel);
    window.__qa = (sel) => [...window.__root().querySelectorAll(sel)];
    window.__openTutor = () => document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    window.__focused = () => { const a = window.__root().activeElement; return a ? (a.textContent || a.getAttribute('aria-label') || a.tagName) : null; };
    window.__practice = (scope) => {
      const b = scope.querySelector('.practice');
      const chips = b.querySelector('.skill-chips');
      return {
        chipsShown: !chips.hidden,
        chips: [...chips.querySelectorAll('.skill-chip')].map((c) => ({ label: c.textContent, pressed: c.getAttribute('aria-pressed'), tab: c.tabIndex })),
        title: b.querySelector('.practice-title').hidden ? null : b.querySelector('.practice-title').textContent,
        items: b.querySelector('.practice-list').hidden ? [] : [...b.querySelectorAll('.practice-list li')].map((li) => ({
          title: li.querySelector('a').textContent, href: li.querySelector('a').getAttribute('href'), target: li.querySelector('a').target,
          difficulty: li.querySelector('.diff')?.textContent, color: getComputedStyle(li.querySelector('.diff')).color,
          reason: li.querySelector('.practice-reason')?.textContent || '',
        })),
        more: !b.querySelector('.practice-foot').hidden && !b.querySelector('.practice-foot .practice-link').hidden,
        foot: !b.querySelector('.practice-foot').hidden,
        note: b.querySelector('.practice-note').hidden ? null : b.querySelector('.practice-note').textContent,
        live: b.querySelector('[aria-live]').textContent,
        busy: b.getAttribute('aria-busy'),
      };
    };
    window.__chip = (scope, label) => [...scope.querySelectorAll('.skill-chip')].find((c) => c.textContent === label);
    window.__send = (text) => {
      const t = window.__q('textarea');
      t.value = text;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
  })()`;

  async function openProblem(slug) {
    const tab = await browser.openPage('about:blank');
    pages.push(tab);
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }, { urlPattern: 'http://localhost:8135/*' }] });
    tab.on('Fetch.requestPaused', async (p) => {
      const url = new URL(p.request.url);
      if (url.host === 'localhost:8135') return void (await tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' }));
      const poll = /^\/submissions\/detail\/([^/]+)\/(?:v2\/)?check\/$/.exec(url.pathname);
      if (poll && judge[poll[1]]) {
        const answers = judge[poll[1]];
        const body = answers.length > 1 ? answers.shift() : answers[0];
        return void (await tab.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }));
      }
      const isPage = url.pathname.startsWith('/problems/');
      await tab.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: isPage ? 200 : 404, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(isPage ? fixture : '').toString('base64') });
    });
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await tab.send('Page.navigate', { url: `https://leetcode.com/problems/${slug}/description/` });
    await tab.waitFor(`document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: `the ${slug} page` });
    await tab.eval(helpers);
    await tab.waitFor(`document.getElementById('leetcode-capture-inject') && fetch.__lcCaptureWrapped === true`, { what: 'inject.js' });
    await tab.eval('window.__openTutor()');
    await tab.waitFor(`window.__q('.status span') && window.__q('.status span').textContent === 'Connected'`, { what: 'the panel connected' });
    return tab;
  }
  const key = async (tab, k, code = k, vk = 0) => {
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k === 'Enter' ? { text: '\r' } : {}) });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };
  const resizePane = async (tab, w, h) => {
    await tab.eval(`(() => {
      const ts = document.querySelector('.flexlayout__tabset');
      ts.style.width = '${w}px';
      ts.style.height = '${h + 36}px';
      const desc = document.getElementById('pane-desc');
      desc.style.width = '${w}px';
      desc.style.height = '${h}px';
      document.getElementById('pane-code').style.left = '${w + 16}px';
    })()`);
    await sleep(250);
  };
  const fits = (tab, sel) => tab.eval(`(() => {
    const c = window.__qa(${JSON.stringify(sel)}).at(-1);
    const s = window.__q('.scroll');
    const box = c.getBoundingClientRect();
    const out = [...c.querySelectorAll('*')].filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > box.right + 0.5).map((n) => n.className || n.tagName);
    return { sideways: s.scrollWidth > s.clientWidth, out, width: Math.round(box.width) };
  })()`);

  const page = await openProblem('two-sum');
  const card = `window.__qa('.feed .solved').at(-1)`;

  await scenario('the "nice job" card offers the fixed skill chips, none chosen, the first one tabbable', async () => {
    check((await page.eval(`fetch('/submissions/detail/9001/v2/check/').then((r) => r.json()).then(() => fetch('/submissions/detail/9001/v2/check/')).then((r) => r.json()).then((r) => r.status_msg)`)) === 'Accepted', 'the poll');
    await page.waitFor(`window.__qa('.feed .solved .skill-chip').length > 0`, { what: 'the card with chips' });
    const m = await page.eval(`window.__practice(${card})`);
    check(JSON.stringify(m.chips.map((c) => c.label)) === JSON.stringify(skillChoices().map((s) => s.label)), `chips: ${m.chips.map((c) => c.label)}`);
    check(m.chips.every((c) => c.pressed === 'false'), 'a chip starts chosen');
    check(m.chips.map((c) => c.tab).join() === [0, ...Array(m.chips.length - 1).fill(-1)].join(), `roving tabindex: ${m.chips.map((c) => c.tab)}`);
    check(m.title === 'Practice a skill' && !m.foot && m.items.length === 0, JSON.stringify(m));
    check((await page.eval(`${card}.querySelector('.skill-chips').getAttribute('role') + '|' + ${card}.querySelector('.skill-chips').getAttribute('aria-label')`)) === 'toolbar|Skills to practice', 'toolbar semantics');
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await page.screenshot(path.join(shots, 'card-chips-dark.png'), { width: 1100, height: 760 });
  });

  const expected = (offset) => practiceSuggestions({ skill: 'hash-maps', reference: 'Easy', solved: ['two-sum', preSolved], exclude: 'two-sum', offset }).suggestions;

  await scenario('a chip shows the top three for the skill near the solved problem\'s level, solved ones left out, focus on the first', async () => {
    await page.eval(`window.__chip(${card}, 'Hash maps').click()`);
    await page.waitFor(`window.__practice(${card}).items.length === 3`, { what: 'three suggestions' });
    const m = await page.eval(`window.__practice(${card})`);
    const want = expected(0);
    check(JSON.stringify(m.items.map((i) => i.title)) === JSON.stringify(titles(want)), `got ${m.items.map((i) => i.title)}, want ${titles(want)}`);
    check(!m.items.some((i) => i.href.includes(`/${preSolved}/`) || i.href.includes('/two-sum/')), `a solved problem: ${JSON.stringify(m.items)}`);
    check(m.items.every((i, k) => i.href === `https://leetcode.com/problems/${want[k].slug}/` && i.target === ''), 'plain same-tab links');
    check(m.items.every((i) => i.difficulty === 'Easy' && i.color === 'rgb(44, 187, 93)'), `difficulties: ${JSON.stringify(m.items.map((i) => [i.difficulty, i.color]))}`);
    check(m.items.every((i, k) => i.reason === want[k].reason && /^Same level · /.test(i.reason)), `reasons: ${m.items.map((i) => i.reason)}`);
    check(m.title === 'PracticeHash maps' && !m.chipsShown && m.more && m.live === '3 Hash maps problems' && m.busy === null, JSON.stringify(m));
    check((await page.eval('window.__focused()')) === want[0].title, `focus: ${await page.eval('window.__focused()')}`);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await page.screenshot(path.join(shots, 'card-suggestions-dark.png'), { width: 1100, height: 760 });
  });

  await scenario('"Show 3 more" brings the next three and focuses the first of them; "Other skill" goes back to the chips', async () => {
    await page.eval(`${card}.querySelector('.practice-foot .practice-link').click()`);
    const want = expected(3);
    await page.waitFor(`window.__practice(${card}).items[0]?.title === ${JSON.stringify(want[0].title)}`, { what: 'the next three' });
    const m = await page.eval(`window.__practice(${card})`);
    check(JSON.stringify(m.items.map((i) => i.title)) === JSON.stringify(titles(want)), `next: ${m.items.map((i) => i.title)}`);
    check((await page.eval('window.__focused()')) === want[0].title, `focus after more: ${await page.eval('window.__focused()')}`);
    await page.eval(`[...${card}.querySelectorAll('.practice-foot .practice-link')].find((b) => b.textContent === 'Other skill').click()`);
    const back = await page.eval(`window.__practice(${card})`);
    check(back.chipsShown && back.items.length === 0 && !back.foot && back.title === 'Practice a skill', JSON.stringify(back));
    check(back.chips.find((c) => c.label === 'Hash maps').pressed === 'true' && back.chips.find((c) => c.label === 'Hash maps').tab === 0, 'the chosen chip is marked and tabbable');
    check((await page.eval('window.__focused()')) === 'Hash maps', `focus after other: ${await page.eval('window.__focused()')}`);
  });

  await scenario('the keyboard: arrows, Home and End move along the chips, Enter chooses one', async () => {
    await key(page, 'ArrowRight', 'ArrowRight', 39);
    check((await page.eval('window.__focused()')) === 'Strings', `ArrowRight: ${await page.eval('window.__focused()')}`);
    await key(page, 'End', 'End', 35);
    check((await page.eval('window.__focused()')) === skillChoices().at(-1).label, `End: ${await page.eval('window.__focused()')}`);
    await key(page, 'ArrowRight', 'ArrowRight', 39);
    check((await page.eval('window.__focused()')) === 'Arrays', `wraps: ${await page.eval('window.__focused()')}`);
    await key(page, 'Home', 'Home', 36);
    await key(page, 'ArrowLeft', 'ArrowLeft', 37);
    check((await page.eval('window.__focused()')) === skillChoices().at(-1).label, `ArrowLeft wraps: ${await page.eval('window.__focused()')}`);
    await key(page, 'Home', 'Home', 36);
    const tabs = await page.eval(`window.__practice(${card}).chips.filter((c) => c.tab === 0).map((c) => c.label)`);
    check(JSON.stringify(tabs) === '["Arrays"]', `one tabbable chip follows the focus: ${tabs}`);
    await key(page, 'Enter', 'Enter', 13);
    const want = practiceSuggestions({ skill: 'arrays', reference: 'Easy', solved: ['two-sum', preSolved], exclude: 'two-sum' }).suggestions;
    await page.waitFor(`window.__practice(${card}).items[0]?.title === ${JSON.stringify(want[0].title)}`, { what: 'Arrays by keyboard' });
    check((await page.eval('window.__focused()')) === want[0].title, 'focus on the first suggestion');
  });

  await scenario('a problem solved after the card appeared is left out the next time', async () => {
    const first = practiceSuggestions({ skill: 'arrays', reference: 'Easy', solved: ['two-sum', preSolved], exclude: 'two-sum' }).suggestions[0];
    await browser.serviceWorkerEval(`chrome.storage.local.get('solvedProblems').then((s) => chrome.storage.local.set({ solvedProblems: { ...s.solvedProblems, ${JSON.stringify(first.slug)}: { at: '2026-11-04T00:00:00.000Z', count: 0, manual: true } } }))`);
    await page.eval(`[...${card}.querySelectorAll('.practice-foot .practice-link')].find((b) => b.textContent === 'Other skill').click()`);
    await page.eval(`window.__chip(${card}, 'Arrays').click()`);
    const want = practiceSuggestions({ skill: 'arrays', reference: 'Easy', solved: ['two-sum', preSolved, first.slug], exclude: 'two-sum' }).suggestions;
    await page.waitFor(`window.__practice(${card}).items[0]?.title === ${JSON.stringify(want[0].title)}`, { what: 'the list without the new solve' });
    const m = await page.eval(`window.__practice(${card})`);
    check(!m.items.some((i) => i.title === first.title), `${first.title} still offered`);
    check(JSON.stringify((await solvedNow()).sort()) === JSON.stringify(['two-sum', preSolved, first.slug].sort()), 'practice changed the solved problems');
  });

  await scenario('the header button opens the picker without a submission, once, for the page\'s problem; Close puts focus back', async () => {
    const mid = await openProblem('group-anagrams');
    const button = await mid.eval(`(() => { const b = window.__q('button.practice-open'); const r = b.getBoundingClientRect(); const g = window.__q('button.gear').getBoundingClientRect(); return { hidden: b.hidden, label: b.getAttribute('aria-label'), title: b.title, size: [r.width, r.height], gap: g.left - r.right, top: r.top - g.top }; })()`);
    check(!button.hidden && button.label === 'Practice a skill' && button.title === 'Practice a skill', JSON.stringify(button));
    check(button.size.join() === '24,24' && button.top === 0 && button.gap === 4, `beside the gear: ${JSON.stringify(button)}`);
    await mid.eval(`window.__q('button.practice-open').click()`);
    await mid.waitFor(`window.__qa('.feed .practice-card .skill-chip').length > 0`, { what: 'the practice card' });
    await mid.waitFor(`window.__focused() === 'Arrays'`, { what: 'focus on the first chip' });
    await mid.eval(`window.__q('button.practice-open').click()`);
    await sleep(200);
    check((await mid.eval(`window.__qa('.feed .practice-card').length`)) === 1, 'a second click adds a second card');
    const head = await mid.eval(`window.__qa('.feed .practice-card')[0].querySelector('.solved-head').textContent`);
    check(head === 'Practice a skill', `head: ${head}`);
    const cardSel = `window.__qa('.feed .practice-card').at(-1)`;
    check((await mid.eval(`window.__practice(${cardSel}).title`)) === null, 'the card\'s own head names it; no second label');
    await mid.eval(`window.__chip(${cardSel}, 'Trees').click()`);
    const solved = await solvedNow();
    const want = practiceSuggestions({ skill: 'trees', reference: 'Medium', solved, exclude: 'group-anagrams' }).suggestions;
    await mid.waitFor(`window.__practice(${cardSel}).items.length === 3`, { what: 'Trees' });
    const m = await mid.eval(`window.__practice(${cardSel})`);
    check(JSON.stringify(m.items.map((i) => i.title)) === JSON.stringify(titles(want)), `trees: ${m.items.map((i) => i.title)} vs ${titles(want)}`);
    check(m.items.every((i) => i.difficulty === 'Medium' && i.color === 'rgb(255, 161, 22)'), 'Medium near a Medium problem');
    check(m.title === 'Trees', `title: ${m.title}`);
    await mid.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await mid.screenshot(path.join(shots, 'on-demand-dark.png'), { width: 1100, height: 760 });
    await mid.eval(`document.documentElement.classList.add('light')`);
    await sleep(300);
    const light = await mid.eval(`(() => { const c = window.__qa('.feed .practice-card').at(-1); return { diff: getComputedStyle(c.querySelector('.diff')).color, link: getComputedStyle(c.querySelector('a')).color }; })()`);
    check(light.diff === 'rgb(194, 94, 0)' && light.link === 'rgb(11, 99, 229)', `light: ${JSON.stringify(light)}`);
    await mid.screenshot(path.join(shots, 'on-demand-light.png'), { width: 1100, height: 760, scheme: 'light' });
    await mid.eval(`[...${cardSel}.querySelectorAll('.practice-foot .practice-link')].find((b) => b.textContent === 'Other skill').click()`);
    await mid.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await mid.screenshot(path.join(shots, 'on-demand-chips-light.png'), { width: 1100, height: 760, scheme: 'light' });
    const chipColors = await mid.eval(`(() => { const st = (label) => getComputedStyle(window.__chip(${cardSel}, label)); return { pressed: [st('Trees').color, st('Trees').backgroundColor], plain: [st('Tries').color, st('Tries').backgroundColor] }; })()`);
    check(chipColors.pressed[0] === chipColors.plain[0] && chipColors.pressed[1] !== chipColors.plain[1], `the chosen chip keeps the text color and gets a stronger fill: ${JSON.stringify(chipColors)}`);
    await mid.eval(`document.documentElement.classList.remove('light')`);
    await mid.eval(`${cardSel}.querySelector('.practice-close').click()`);
    await sleep(200);
    check((await mid.eval(`window.__qa('.feed .practice-card').length`)) === 0, 'the card closed');
    check((await mid.eval('window.__focused()')) === 'Practice a skill', `focus after close: ${await mid.eval('window.__focused()')}`);
    check((await mid.eval(`window.__qa('.feed .empty').length`)) === 1, 'the empty state is back');
  });

  await scenario('a problem the index does not have: every level, by popularity alone, and no level in the reason', async () => {
    const odd = await openProblem('a-problem-from-next-week');
    await odd.eval(`window.__q('button.practice-open').click()`);
    await odd.waitFor(`window.__qa('.feed .practice-card .skill-chip').length > 0`, { what: 'the practice card' });
    await odd.eval(`window.__chip(window.__qa('.feed .practice-card').at(-1), 'Graphs').click()`);
    const want = practiceSuggestions({ skill: 'graphs', reference: null, solved: await solvedNow(), exclude: 'a-problem-from-next-week' }).suggestions;
    await odd.waitFor(`window.__practice(window.__qa('.feed .practice-card').at(-1)).items.length === 3`, { what: 'Graphs' });
    const m = await odd.eval(`window.__practice(window.__qa('.feed .practice-card').at(-1))`);
    check(JSON.stringify(m.items.map((i) => i.title)) === JSON.stringify(titles(want)), `graphs: ${m.items.map((i) => i.title)}`);
    check(m.items.every((i) => !/level/.test(i.reason)), `reasons: ${m.items.map((i) => i.reason)}`);
  });

  await scenario('it fits the pane from 240 to 1280 px, the card and the on-demand picker, chips and suggestions', async () => {
    // A tab in the background draws no frames.
    await page.send('Page.bringToFront');
    await page.eval(`[...${card}.querySelectorAll('.practice-foot .practice-link')].find((b) => b.textContent === 'Other skill').click()`);
    await page.eval(`window.__q('button.practice-open').click()`);
    await page.waitFor(`window.__qa('.feed .practice-card .skill-chip').length > 0`, { what: 'the practice card' });
    const menu = await page.eval(`getComputedStyle(${card}.querySelector('.solved-switch')).display`);
    check(menu !== 'none', 'a practice card after it hides the newest card\'s list menu');
    check((await page.eval(`window.__qa('.feed .practice-card').at(-1).getAttribute('role')`)) === 'region', 'the practice card is a labelled region');
    for (const width of [240, 320, 480, 760, 1280]) {
      await resizePane(page, width, 620);
      await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
      for (const sel of ['.feed .solved', '.feed .practice-card']) {
        const f = await fits(page, sel);
        check(!f.sideways && f.out.length === 0, `${sel} at ${width}: ${JSON.stringify(f)}`);
      }
      await page.screenshot(path.join(shots, `chips-${width}-dark.png`), { width: Math.max(1100, width + 560), height: 760 });
    }
    await page.eval(`window.__chip(window.__qa('.feed .practice-card').at(-1), 'Dynamic programming').click()`);
    await page.waitFor(`window.__practice(window.__qa('.feed .practice-card').at(-1)).items.length === 3`, { what: 'DP' });
    for (const width of [240, 320, 480, 1280]) {
      await resizePane(page, width, 620);
      await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
      const f = await fits(page, '.feed .practice-card');
      check(!f.sideways && f.out.length === 0, `suggestions at ${width}: ${JSON.stringify(f)}`);
      await page.screenshot(path.join(shots, `suggestions-${width}-dark.png`), { width: Math.max(1100, width + 560), height: 760 });
    }
    await page.eval(`document.documentElement.classList.add('light')`);
    await resizePane(page, 240, 620);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await page.screenshot(path.join(shots, 'suggestions-240-light.png'), { width: 1100, height: 760, scheme: 'light' });
    await page.eval(`document.documentElement.classList.remove('light')`);
    await resizePane(page, 560, 664);
  });

  await scenario('the header keeps the light, the practice button and the gear in the row at any width, cutting labels first', async () => {
    for (const width of [110, 160, 240, 320]) {
      await resizePane(page, width, 400);
      const h = await page.eval(`(() => {
        const head = window.__q('.head').getBoundingClientRect();
        const r = (sel) => window.__q(sel).getBoundingClientRect();
        const light = r('.status .light'), practice = r('button.practice-open'), gear = r('button.gear');
        return { h: head.height, light: [light.left, light.width], practice: [practice.left, practice.right, practice.width], gear: [gear.left, gear.right, gear.width], headRight: head.right };
      })()`);
      check(h.h === 32 && h.light[1] === 8 && h.practice[2] === 24 && h.gear[2] === 24, `${width}: ${JSON.stringify(h)}`);
      check(h.light[0] + 8 <= h.practice[0] && h.practice[1] + 4 <= h.gear[0] + 0.5 && h.gear[1] <= h.headRight, `${width}: overlap or overflow ${JSON.stringify(h)}`);
    }
    await page.screenshot(path.join(shots, 'header-320-dark.png'), { width: 1100, height: 500 });
    await resizePane(page, 560, 664);
  });

  await scenario('nothing of it reaches the model: the next message carries no skill, title or reason', async () => {
    const shown = await page.eval(`window.__qa('.feed .practice-list li').map((li) => li.textContent)`);
    check(shown.length > 0, 'suggestions on screen');
    await page.eval(`window.__send('what should I try?')`);
    await page.waitFor(`window.__qa('.feed .tutor').some((n) => n.textContent.includes('A short reply.'))`, { what: 'the reply', timeout: 10000 }).catch(async (err) => {
      throw new Error(`${err.message}; requests: ${model.requests.length}; console: ${JSON.stringify(page.console.slice(-8))}; feed: ${JSON.stringify(await page.eval(`window.__qa('.feed > *').map((n) => n.className + ': ' + n.textContent.slice(0, 80))`))}; input: ${await page.eval(`window.__q('textarea').disabled + ' ' + window.__q('textarea').value`)}`);
    });
    const all = JSON.stringify(model.requests.filter((r) => r.stream).map((r) => r.messages));
    check(all.includes('what should I try?'), 'the message went');
    const leaks = [...(await page.eval(`window.__qa('.feed .practice-list a').map((a) => a.textContent)`)), 'Practice a skill', 'Dynamic programming', 'Hash maps', 'likes', 'Same level'].filter((t) => all.includes(t));
    check(leaks.length === 0, `reached the model: ${leaks}`);
  });

  await scenario('no exceptions in the pages', async () => {
    const exceptions = pages.flatMap((p) => p.console.filter((line) => line.startsWith('exception')));
    check(exceptions.length === 0, exceptions.join('\n'));
  });
} finally {
  await browser.close();
  copy.cleanup();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
