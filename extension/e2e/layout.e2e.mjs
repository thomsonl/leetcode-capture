// extension/e2e/layout.e2e.mjs - the Tutor tab inside a page built with the
// REAL flexlayout-react (extension/e2e/flexlayout/, version in its
// package.json; LeetCode's own version is unknown and may differ), driven by
// real mouse input over CDP: HTML5 drags of tab buttons, splitter drags and
// toolbar clicks.
//
// Native mode (layout-bridge.js adds a real tab to the page's Model): the
// Tutor tab moves to another tabset, splits into its own, is maximized and
// restored, survives Description moving away and back, a React rebuild of
// the layout, a "Default layout" reset (a new Model), Description being
// deleted and a tiny pane, and the layout JSON the page saves never contains
// it. Clone mode (the bridge blocked): the injected tab still works over the
// same real layout.
//
// Every scenario runs twice, once per fixture variant (see fixture.jsx): a
// layout whose tabs have names, and one like leetcode.com's, whose tabs are
// known only by component, whose onRenderTab draws nothing for the Tutor
// tab and whose older Model has no addChangeListener. Each variant runs in
// its own child process (LAYOUT_VARIANT), with its own browser and port.
//
// Setup once (dev only, never packaged):
//   (cd extension/e2e/flexlayout && npm install)
// Run (manual, not part of `npm test`):
//   node extension/e2e/layout.e2e.mjs
//
// Screenshots go to /tmp/lc-layout-shots.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

if (!process.env.LAYOUT_VARIANT) {
  let failures = 0;
  for (const variant of ['named', 'leetcode']) {
    console.log(`\n==== fixture variant: ${variant}`);
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, LAYOUT_VARIANT: variant } });
    if (run.status !== 0) failures += 1;
  }
  process.exit(failures ? 1 : 0);
}
const LEETCODE = process.env.LAYOUT_VARIANT === 'leetcode';
const QUERY = LEETCODE ? '?leetcode' : '';
// What the bridge stores to name a native tab: its component.
const COMPONENTS = { Description: 'description', Editorial: 'editorial', Solutions: 'solutions', Submissions: 'submissions', Code: 'code', Testcase: 'testcase', 'Test Result': 'result' };
const anchor = (label) => COMPONENTS[label] || label;

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = '/tmp/lc-layout-shots';
fs.mkdirSync(SHOTS, { recursive: true });

if (!fs.existsSync(path.join(here, 'flexlayout', 'node_modules', 'flexlayout-react'))) {
  console.error('run `npm install` in extension/e2e/flexlayout first');
  process.exit(2);
}
const { buildFixture } = await import('./flexlayout/build.mjs');
const fx = await buildFixture();
console.log(`fixture: flexlayout-react ${fx.version}`);

// PANEL_JS=<file> runs the scenarios against another copy of panel.js (for
// example the version before a fix, to see the scenarios catch the bug).
const panelSource = fs
  .readFileSync(process.env.PANEL_JS || path.join(here, '..', 'panel.js'), 'utf8')
  .replace('const RELAY_BASE = "http://localhost:8135";', 'const RELAY_BASE = "http://127.0.0.1:9";');
if (!panelSource.includes('http://127.0.0.1:9')) throw new Error('could not repoint RELAY_BASE in the injected panel.js');
const bridgeSource = fs.readFileSync(path.join(here, '..', 'layout-bridge.js'), 'utf8');

// The relay stand-in: /panel/events is a stream the test writes into.
const FETCH_STUB = `
  (() => {
    let controller = null;
    const encoder = new TextEncoder();
    window.__event = (obj) => controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\\n\\n'));
    window.__streamOpen = () => controller !== null;
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/panel/events') {
        const body = new ReadableStream({ start(c) { controller = c; } });
        if (options.signal) options.signal.addEventListener('abort', () => { controller = null; });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new TypeError('fixture: no network for ' + url.href);
    };
  })();
`;

const page = (css, js) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Layout fixture</title>
<style>${css}
  html { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: rgb(26, 26, 26); color: #fff; font-family: -apple-system, "Segoe UI", sans-serif; }
  .app { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .nav { height: 40px; display: flex; align-items: center; padding: 0 8px; }
  .main { position: relative; flex: 1; }
  .label { position: relative; }
  .label .ghost { position: absolute; inset: 0; visibility: hidden; font-weight: 400; }
  .flexlayout__tab_button--selected .label > div:first-child { font-weight: 600; }
  .pane { padding: 20px 16px; font-size: 14px; line-height: 21px; }
  .border-b { height: 32px; border-bottom: 1px solid rgba(255,255,255,.1); }
  .row-label { color: rgba(239, 242, 246, 0.6); }
</style>
<script>${FETCH_STUB}</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const html = page(fx.css, fx.js);

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/problems/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/ext/layout-bridge.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(bridgeSource);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Page-side helpers, shared by both modes.
const HELPERS = `(() => {
  window.__clicks = [];
  for (const t of ['pointerdown', 'click', 'mousedown']) document.addEventListener(t, (e) => window.__clicks.push(t + ':' + (e.target.className && e.target.className.baseVal === undefined ? e.target.className : e.target.tagName) + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)), true);
  window.__bridgeStates = [];
  document.addEventListener('lc-tutor:layout-state', (e) => window.__bridgeStates.push(e.detail));
  window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
  window.__q = (sel) => window.__root().querySelector(sel);
  window.__settle = () => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 60));
  window.__seq = 0;
  window.__ev = (obj) => window.__event({ seq: ++window.__seq, epoch: 'e1', ...obj });
  window.__labelOf = (b) => { const leaf = [...b.querySelectorAll('*')].find((n) => n.children.length === 0 && n.textContent.trim()); return leaf ? leaf.textContent.trim() : b.textContent.trim(); };
  window.__button = (label) => [...document.querySelectorAll('.flexlayout__tab_button')].find((b) => window.__labelOf(b) === label && !b.closest('.flexlayout__layout_tab_stamps'));
  window.__tutorButtons = () => [...document.querySelectorAll('.flexlayout__tab_button')].filter((b) => !b.closest('.flexlayout__layout_tab_stamps') && (b.hasAttribute('data-lc-tutor-tab') || window.__labelOf(b) === 'Tutor'));
  window.__rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  // The middle of the part of an element on screen. A tab button can sit
  // partly under the tabset's toolbar when the strip overflows; it is
  // scrolled into view first, as the student would scroll the strip.
  window.__center = (el) => {
    const strip = el.closest('.flexlayout__tabset_tabbar_inner');
    const toolbar = el.closest('.flexlayout__tabset') && el.closest('.flexlayout__tabset').querySelector('.flexlayout__tab_toolbar');
    if (strip && toolbar) {
      const over = el.getBoundingClientRect().right - toolbar.getBoundingClientRect().left;
      if (over > 0) strip.scrollLeft += over + 4;
    }
    const r = el.getBoundingClientRect();
    let right = r.right;
    if (strip) right = Math.min(right, strip.getBoundingClientRect().right);
    if (toolbar && el.closest('.flexlayout__tabset_tabbar_inner')) right = Math.min(right, toolbar.getBoundingClientRect().left);
    return { x: (r.left + right) / 2, y: r.top + r.height / 2 };
  };
  window.__json = () => JSON.stringify(window.__fx.model().toJson());
  // The deep check: what the page saves while the Tutor tab is anywhere
  // must be the layout as it was without the tab (window.__base, read
  // before the tab was ever added), byte for byte once only which tab and
  // tabset are selected (selected, active) are left out.
  window.__norm = (s) => JSON.stringify(JSON.parse(s), (k, v) => (k === 'active' || k === 'selected' ? undefined : v));
  window.__deep = () => ({ now: window.__norm(window.__json()), base: window.__norm(window.__base), saved: window.__fx.saved.length ? window.__norm(window.__fx.saved[window.__fx.saved.length - 1]) : null });
  // The rendered size of every native tabset, by the tab labels in it.
  window.__sizes = () => [...document.querySelectorAll('.flexlayout__tabset')].filter((t) => t.querySelector('.flexlayout__tab_button:not([data-lc-tutor-button])')).map((t) => { const r = t.getBoundingClientRect(); return [...t.querySelectorAll('.flexlayout__tab_button:not([data-lc-tutor-button])')].map(window.__labelOf).join('+') + ':' + Math.round(r.width) + 'x' + Math.round(r.height); }).sort().join(' ');
  // Everything about where the Tutor tab and its panel are, in one read.
  window.__where = () => {
    const tutors = window.__tutorButtons();
    const host = document.getElementById('lc-tutor-panel-host');
    const tab = tutors[0] || null;
    const tabset = tab ? tab.closest('.flexlayout__tabset') : null;
    const desc = window.__button('Description');
    const pane = host ? host.parentElement : null;
    const content = tabset ? tabset.querySelector('.flexlayout__tabset_content') : null;
    const shown = !!host && host.getBoundingClientRect().width > 0;
    return {
      tutors: tutors.length,
      hosts: document.querySelectorAll('#lc-tutor-panel-host').length,
      tabset: tabset ? tabset.getAttribute('data-layout-path') : null,
      tabsetLabels: tabset ? [...tabset.querySelectorAll('.flexlayout__tab_button')].map(window.__labelOf) : [],
      descTabset: desc ? desc.closest('.flexlayout__tabset').getAttribute('data-layout-path') : null,
      selected: tab ? tab.classList.contains('flexlayout__tab_button--selected') : false,
      shown,
      hostRect: host && shown ? window.__rect(host) : null,
      paneRect: pane && pane.classList.contains('flexlayout__tab') ? window.__rect(pane) : null,
      contentRect: content ? window.__rect(content) : null,
      paneExists: !!document.querySelector('[data-lc-tutor-pane]'),
      inPane: !!pane && pane.classList.contains('flexlayout__tab') && pane.hasAttribute('data-lc-tutor-pane'),
      inert: [...document.querySelectorAll('[inert]')].length,
      bodyActive: document.body.hasAttribute('data-lc-tutor-active'),
      emptyTabsets: [...document.querySelectorAll('.flexlayout__tabset')].filter((t) => !t.querySelector('.flexlayout__tab_button')).length,
      items: host ? window.__root().querySelectorAll('.feed > *').length : 0,
      scrollTop: host ? Math.round(window.__q('.scroll').scrollTop) : null,
    };
  };
})()`;

// Real input. Clicks and splitter drags are mouse events; tab drags are
// HTML5 drag and drop (flexlayout-react 0.8 and later), which headless
// Chromium only performs through Input.setInterceptDrags.
function input(p) {
  const mouse = (type, x, y, extra = {}) => p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...extra });
  return {
    async click(x, y) {
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
      await mouse('mousePressed', x, y);
      await mouse('mouseReleased', x, y);
    },
    async pointerDrag(from, to, steps = 12) {
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 });
      await mouse('mousePressed', from.x, from.y);
      for (let i = 1; i <= steps; i++) {
        await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
        await sleep(16);
      }
      await mouse('mouseReleased', to.x, to.y);
    },
    async htmlDrag(from, to) {
      await p.send('Input.setInterceptDrags', { enabled: true });
      let gotData = null;
      const got = new Promise((resolve) => {
        gotData = resolve;
      });
      p.dragWaiter = gotData;
      if (!p.dragHooked) {
        p.dragHooked = true;
        p.on('Input.dragIntercepted', (params) => p.dragWaiter && p.dragWaiter(params.data));
      }
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 });
      await mouse('mousePressed', from.x, from.y);
      for (let i = 1; i <= 6; i++) await mouse('mouseMoved', from.x + i * 3, from.y + i * 2);
      const data = await Promise.race([got, sleep(3000).then(() => null)]);
      if (!data) throw new Error('the browser never started a drag');
      const steps = 8;
      await p.send('Input.dispatchDragEvent', { type: 'dragEnter', x: from.x, y: from.y, data });
      for (let i = 1; i <= steps; i++) {
        await p.send('Input.dispatchDragEvent', { type: 'dragOver', x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, data });
        await sleep(20);
      }
      await p.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
      await sleep(30);
      await p.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
      await mouse('mouseReleased', to.x, to.y);
      await p.send('Input.setInterceptDrags', { enabled: false });
      p.dragWaiter = null;
    },
  };
}

const browser = await launch();
try {
  // ---- native mode ------------------------------------------------------
  const p = await browser.openPage(`${origin}/problems/two-sum/description/${QUERY}`);
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await p.waitFor(`!!(window.__fx && document.querySelector('.flexlayout__tab_button'))`, { what: 'the flexlayout fixture' });
  await p.eval(HELPERS);
  await p.eval(`window.chrome = { runtime: { getURL: (file) => '/ext/' + file } }`);
  await p.eval(`window.__base = window.__json(); window.__baseSizes = window.__sizes()`);
  await p.eval(`new Function(${JSON.stringify(panelSource)})()`);
  try {
    await p.waitFor(`!!document.querySelector('[data-lc-tutor-button]') && window.__streamOpen()`, { what: 'the native Tutor tab' });
  } catch (err) {
    console.log(p.console.join('\n'));
    console.log(await p.eval(`JSON.stringify({ pane: !!document.querySelector('[data-lc-tutor-pane]'), button: !!document.querySelector('[data-lc-tutor-button]'), host: !!document.getElementById('lc-tutor-panel-host'), states: window.__bridgeStates, keys: Object.keys(document.querySelector('.flexlayout__layout')).filter((k) => k.startsWith('__react')), clone: !!document.querySelector('[data-lc-tutor-tab]'), node: !!window.__fx.model().getNodeById('lc-tutor-tab'), stream: window.__streamOpen() })`));
    throw err;
  }
  const io = input(p);
  const settle = () => p.eval('window.__settle()');
  const where = () => p.eval('window.__where()');
  const center = (expr) => p.eval(`window.__center(${expr})`);

  // The invariants every scenario ends with. `home` is where the Tutor tab
  // should be (a tabset path), or null to skip that check.
  async function deepCheck(label) {
    const d = await p.eval('window.__deep()');
    check(d.now === d.base, `${label}: toJson() is not the layout without the Tutor\n     now  ${d.now}\n     base ${d.base}`);
    check(d.saved === null || d.saved === d.base, `${label}: the page saved a layout that is not the one without the Tutor\n     saved ${d.saved}\n     base  ${d.base}`);
  }
  // After a scenario that moved native tabs or splitters itself, the
  // layout without the Tutor is the one now.
  const rebase = () => p.eval(`window.__base = window.__json()`);
  async function invariants(label, { shown = null, deep = true } = {}) {
    await settle();
    const w = await where();
    const json = await p.eval('window.__json()');
    const saved = await p.eval(`window.__fx.saved.filter((s) => s.includes('lc-tutor')).length`);
    check(w.tutors === 1, `${label}: ${w.tutors} Tutor tabs`);
    // flexlayout renders a tab's pane the first time it is shown.
    if (w.paneExists) {
      check(w.hosts === 1, `${label}: ${w.hosts} panel hosts`);
      check(w.inPane, `${label}: the panel is not inside the Tutor tab's pane`);
    } else {
      check(w.hosts === 0, `${label}: a panel host outside any pane`);
    }
    check(w.inert === 0 && !w.bodyActive, `${label}: leaked state ${JSON.stringify({ inert: w.inert, body: w.bodyActive })}`);
    check(w.emptyTabsets === 0, `${label}: ${w.emptyTabsets} empty tabsets`);
    check(!json.includes('lc-tutor'), `${label}: model.toJson() carries the Tutor tab`);
    check(saved === 0, `${label}: the page saved a layout with the Tutor tab in it`);
    if (deep) await deepCheck(label);
    if (shown !== null && w.shown !== shown) {
      const states = await p.eval('window.__bridgeStates.slice(-3)');
      console.log(await p.eval('JSON.stringify({ clicks: window.__clicks.slice(-6), btn: window.__rect(window.__tutorButtons()[0]) })'));
      throw new Error(`${label}: shown ${w.shown}, expected ${shown} ${JSON.stringify({ ...w, states })}`);
    }
    if (w.shown) {
      check(JSON.stringify(w.hostRect) === JSON.stringify(w.paneRect), `${label}: panel ${JSON.stringify(w.hostRect)} vs pane ${JSON.stringify(w.paneRect)}`);
      check(JSON.stringify(w.paneRect) === JSON.stringify(w.contentRect), `${label}: pane ${JSON.stringify(w.paneRect)} vs its tabset content ${JSON.stringify(w.contentRect)}`);
    }
    return w;
  }
  const tutorButton = `window.__tutorButtons()[0]`;
  async function selectTutor() {
    const c = await center(tutorButton);
    await io.click(c.x, c.y);
    await settle();
  }
  // The selected tab's tabset content, as a drop point at a fraction of it.
  // A tabset is named by a tab label in it (paths change as tabsets come
  // and go).
  const tabsetOf = (label) => `window.__button(${JSON.stringify(label)}).closest('.flexlayout__tabset')`;
  async function contentPoint(label, fx = 0.5, fy = 0.5) {
    return p.eval(`(() => { const t = ${tabsetOf(label)}; const r = t.querySelector('.flexlayout__tabset_content').getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }; })()`);
  }
  async function stripPoint(label) {
    return p.eval(`(() => { const t = ${tabsetOf(label)}; const r = t.querySelector('.flexlayout__tabset_tabbar_outer').getBoundingClientRect(); return { x: r.right - 60, y: r.top + r.height / 2 }; })()`);
  }
  // The first feed item on screen, to tell the scroll survived a move.
  const firstVisible = () => p.eval(`(() => { const s = window.__q('.scroll'); const top = s.getBoundingClientRect().top; const item = [...window.__root().querySelectorAll('.feed > *')].find((n) => n.getBoundingClientRect().bottom > top + 1); return item ? item.textContent.slice(0, 40) : null; })()`);

  await scenario('native: one real Tutor tab, right after Description, unselected, nothing saved', async () => {
    const w = await invariants('start', { shown: false });
    check(w.tabset === w.descTabset, `Tutor in ${w.tabset}, Description in ${w.descTabset}`);
    check(w.tabsetLabels.indexOf('Tutor') === w.tabsetLabels.indexOf('Description') + 1, `labels ${w.tabsetLabels}`);
    const attrs = await p.eval(`(() => { const b = ${tutorButton}; return { draggable: b.getAttribute('draggable'), native: b.hasAttribute('data-lc-tutor-button'), icon: getComputedStyle(b, '::before').content }; })()`);
    check(attrs.draggable === 'true' && attrs.native, JSON.stringify(attrs));
    check(attrs.icon !== 'none', `no Tutor icon: ${attrs.icon}`);
    if (LEETCODE) {
      const fork = await p.eval(`(() => { const m = window.__fx.model(); let named = 0; m.visitNodes((n) => { if (n.getType() === 'tab' && n.getName() !== '[Unnamed Tab]') named += 1; }); return { named, json: m.toJson().layout.children[0].children[0].name === undefined, add: typeof m.addChangeListener, hook: typeof m._setChangeListener }; })()`);
      // Only the Tutor tab carries a name; this script is not the bridge, so it sees addChangeListener.
      check(fork.named === 1 && fork.json && fork.hook === 'function', `not LeetCode-like: ${JSON.stringify(fork)}`);
      // The bridge watched moves by wrapping the instance's doAction.
      check(await p.eval(`Object.prototype.hasOwnProperty.call(window.__fx.model(), 'doAction')`), 'the bridge did not wrap doAction');
      // The page drew nothing in the button; the bridge's label is there,
      // and comes back when something wipes the button's content.
      await p.eval(`window.__tutorButtons()[0].querySelector('[data-lc-tutor-label]').remove()`);
      await settle();
      check((await p.eval(`window.__labelOf(window.__tutorButtons()[0])`)) === 'Tutor', 'the label did not come back');
      await p.eval('window.__fx.rerender()');
      await settle();
      check((await p.eval(`window.__tutorButtons()[0].textContent`)) === 'Tutor', 'the label after a re-render');
    }
  });

  // Enough feed to scroll.
  await p.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e1' })`);
  for (let i = 1; i <= 14; i++) {
    await p.eval(`window.__ev({ type: 'user', problemSlug: 'two-sum', text: 'question ${i}' })`);
    await p.eval(`window.__ev({ type: 'turn-start', turnId: 't${i}', problemSlug: 'two-sum' })`);
    await p.eval(`window.__ev({ type: 'turn-end', turnId: 't${i}', problemSlug: 'two-sum', text: 'answer ${i}: ' + 'a fairly long line of tutor text that wraps. '.repeat(4) })`);
  }
  await settle();

  await scenario('native: unread dot while hidden, cleared once shown', async () => {
    const dot = await p.eval(`(() => { const b = ${tutorButton}; return { attr: b.hasAttribute('data-unread'), after: getComputedStyle(b, '::after').backgroundColor }; })()`);
    check(dot.attr && dot.after === 'rgb(239, 71, 67)', JSON.stringify(dot));
    await selectTutor();
    const w = await invariants('selected', { shown: true });
    check(w.selected, 'the Tutor button is not selected');
    check(w.items >= 28, `feed items ${w.items}`);
    const after = await p.eval(`({ unread: ${tutorButton}.hasAttribute('data-unread'), focus: document.activeElement && document.activeElement.id === 'lc-tutor-panel-host' && window.__root().activeElement === window.__q('textarea') })`);
    check(!after.unread, 'still unread');
    check(after.focus, 'the composer did not get focus');
    await p.screenshot(path.join(SHOTS, '01-native-selected.png'), { width: 1200, height: 800 });
  });

  await scenario('native: selecting a native tab in the same tabset switches back, and again', async () => {
    let c = await center(`window.__button('Submissions')`);
    await io.click(c.x, c.y);
    let w = await invariants('submissions', { shown: false });
    check(!w.selected, 'Tutor still selected');
    const subsShown = await p.eval(`document.getElementById('pane-subs').getBoundingClientRect().width > 0`);
    check(subsShown, 'Submissions pane not shown');
    await selectTutor();
    w = await invariants('tutor again', { shown: true });
  });

  // Scrolled up a little: moves must keep the place.
  await p.eval(`(() => { const s = window.__q('.scroll'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 })); s.scrollTop = Math.round(s.scrollHeight / 3); })()`);
  await settle();
  const readingBefore = await firstVisible();
  const scrollBefore = (await where()).scrollTop;

  // Every side of the Code tabset (a row of its own on two sides, a sibling
  // in its column on the other two), then the Tutor's own splitter dragged
  // wide and narrow, maximize and restore, and back home: the saved layout
  // never changes, and the native tabsets end at their old sizes.
  const CODE_SIDES = { left: [0.04, 0.5], right: [0.96, 0.5], top: [0.5, 0.04], bottom: [0.5, 0.96] };
  for (const side of Object.keys(CODE_SIDES)) {
    await scenario(`native: split ${side} of Code, its own splitter dragged wide and narrow, maximized: the saved layout never changes`, async () => {
      const [fx, fy] = CODE_SIDES[side];
      await p.eval('window.__baseSizes = window.__sizes()');
      await io.htmlDrag(await center(tutorButton), await contentPoint('Code', fx, fy));
      let w = await invariants(`split ${side} of Code`, { shown: true });
      check(JSON.stringify(w.tabsetLabels) === '["Tutor"]', `own tabset labels ${w.tabsetLabels}`);
      // The splitter between the Tutor tabset and Code.
      const own = await p.eval(`(() => { const t = window.__tutorButtons()[0].closest('.flexlayout__tabset').getBoundingClientRect(); const c = ${tabsetOf('Code')}.getBoundingClientRect(); const s = [...document.querySelectorAll('.flexlayout__splitter')].map((e) => e.getBoundingClientRect()).find((r) => ${side === 'left' || side === 'right'} ? Math.abs(r.left - Math.min(t.right, c.right)) < 12 && r.height > 50 : Math.abs(r.top - Math.min(t.bottom, c.bottom)) < 12 && r.width > 50); return s ? { x: s.left + s.width / 2, y: s.top + s.height / 2, horizontal: ${side === 'left' || side === 'right'} } : null; })()`);
      check(own, `no splitter between the Tutor and Code (${side})`);
      for (const delta of [160, -260, 120]) {
        const s = await p.eval(`(() => { const t = window.__tutorButtons()[0].closest('.flexlayout__tabset').getBoundingClientRect(); const c = ${tabsetOf('Code')}.getBoundingClientRect(); const e = [...document.querySelectorAll('.flexlayout__splitter')].map((x) => x.getBoundingClientRect()).find((r) => ${own.horizontal} ? Math.abs(r.left - Math.min(t.right, c.right)) < 12 && r.height > 50 : Math.abs(r.top - Math.min(t.bottom, c.bottom)) < 12 && r.width > 50); return { x: e.left + e.width / 2, y: e.top + e.height / 2 }; })()`);
        await io.pointerDrag(s, own.horizontal ? { x: s.x + delta, y: s.y } : { x: s.x, y: s.y + delta / 2 });
        w = await invariants(`${side}: its splitter dragged ${delta}`, { shown: true });
      }
      const max = `window.__tutorButtons()[0].closest('.flexlayout__tabset').querySelector('[data-layout-path$="/button/max"]')`;
      let c = await center(max);
      await io.click(c.x, c.y);
      await invariants(`${side}: maximized`, { shown: true });
      c = await center(max);
      await io.click(c.x, c.y);
      await invariants(`${side}: restored`, { shown: true });
      await io.htmlDrag(await center(tutorButton), await stripPoint('Description'));
      w = await invariants(`${side}: back home`, { shown: true });
      check(w.tabset === w.descTabset, `Tutor in ${w.tabset}, Description in ${w.descTabset}`);
      const sizes = await p.eval('[window.__sizes(), window.__baseSizes]');
      check(sizes[0] === sizes[1], `${side}: the native tabsets did not get their space back: ${sizes[0]} vs ${sizes[1]}`);
    });
  }

  await scenario('native: drag the Tutor tab into the Code tabset', async () => {
    const before = await where();
    const from = await center(tutorButton);
    const to = await stripPoint('Code');
    await io.htmlDrag(from, to);
    const w = await invariants('dragged to Code', { shown: true });
    check(w.tabset !== before.tabset && w.tabsetLabels.includes('Code'), `Tutor in ${w.tabset}: ${w.tabsetLabels}`);
    check(w.items === before.items, `feed items ${before.items} -> ${w.items}`);
    const reading = await firstVisible();
    check(reading === readingBefore, `reading ${JSON.stringify(readingBefore)} -> ${JSON.stringify(reading)} (scrollTop ${scrollBefore} -> ${w.scrollTop})`);
    await p.screenshot(path.join(SHOTS, '02-native-in-code.png'), { width: 1200, height: 800 });
  });

  await scenario('native: split the Tutor tab into its own tabset (dropped on a pane edge)', async () => {
    const from = await center(tutorButton);
    const to = await contentPoint('Description', 0.5, 0.92);
    await io.htmlDrag(from, to);
    const w = await invariants('split', { shown: true });
    check(JSON.stringify(w.tabsetLabels) === '["Tutor"]', `own tabset labels ${w.tabsetLabels}`);
    const json = JSON.parse(await p.eval('window.__json()'));
    let tabsets = 0;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'tabset') {
        tabsets += 1;
        check(n.children.length > 0, 'an empty tabset in the saved layout');
      }
      for (const c of n.children || []) walk(c);
    };
    walk(json.layout);
    check(tabsets === 3, `saved layout has ${tabsets} tabsets (the Tutor's own must be left out)`);
    check((await firstVisible()) === readingBefore, 'the reading position moved');
    await p.screenshot(path.join(SHOTS, '03-native-split.png'), { width: 1200, height: 800 });
  });

  await scenario('native: maximize the Tutor tabset and restore it', async () => {
    const before = await where();
    const max = `window.__tutorButtons()[0].closest('.flexlayout__tabset').querySelector('[data-layout-path$="/button/max"]')`;
    let c = await center(max);
    await io.click(c.x, c.y);
    const w = await invariants('maximized', { shown: true });
    check(w.hostRect.w > before.hostRect.w && w.hostRect.h > before.hostRect.h, `not bigger: ${JSON.stringify(before.hostRect)} -> ${JSON.stringify(w.hostRect)}`);
    await p.screenshot(path.join(SHOTS, '04-native-maximized.png'), { width: 1200, height: 800 });
    c = await center(max);
    await io.click(c.x, c.y);
    const back = await invariants('restored', { shown: true });
    check(JSON.stringify(back.hostRect) === JSON.stringify(before.hostRect), `restored ${JSON.stringify(back.hostRect)} vs ${JSON.stringify(before.hostRect)}`);
  });

  await scenario('native: a splitter drag resizes the Tutor pane live, down to tiny and back', async () => {
    const splitter = `[...document.querySelectorAll('.flexlayout__splitter')].find((s) => s.getAttribute('data-layout-path') === '/s0')`;
    const c = await center(splitter);
    await io.pointerDrag(c, { x: 1190, y: c.y });
    let w = await invariants('splitter right', { shown: true, deep: false });
    await io.pointerDrag({ x: (await center(splitter)).x, y: c.y }, { x: 5, y: c.y });
    w = await invariants('splitter far left', { deep: false });
    await p.screenshot(path.join(SHOTS, '05-native-tiny.png'), { width: 1200, height: 800 });
    await io.pointerDrag({ x: (await center(splitter)).x, y: c.y }, c);
    w = await invariants('splitter back', { shown: true, deep: false });
    check(Math.abs(w.hostRect.w - 0) > 100, `pane width ${w.hostRect.w}`);
    await rebase();
  });

  await scenario('native: Description dragged into the Tutor tabset and back out', async () => {
    let from = await center(`window.__button('Description')`);
    await io.htmlDrag(from, await stripPoint('Tutor'));
    let w = await invariants('description joined', { deep: false });
    check(w.tabsetLabels.includes('Description') && w.tabsetLabels.includes('Tutor'), `labels ${w.tabsetLabels}`);
    from = await center(`window.__button('Description')`);
    await io.htmlDrag(from, await stripPoint('Editorial'));
    w = await invariants('description back', { deep: false });
    await rebase();
    check(w.descTabset !== w.tabset, 'Description did not leave');
    await selectTutor();
    await invariants('tutor reselected', { shown: true });
  });

  await scenario('native: the Tutor tab dragged out of its own tabset leaves no empty tabset', async () => {
    const from = await center(tutorButton);
    await io.htmlDrag(from, await stripPoint('Description'));
    const w = await invariants('back home', { shown: true });
    check(w.tabset === w.descTabset, `Tutor in ${w.tabset}, Description in ${w.descTabset}`);
    const tabsets = await p.eval(`document.querySelectorAll('.flexlayout__tabset').length`);
    check(tabsets === 3, `${tabsets} tabsets in the DOM`);
  });

  await scenario('native: React rebuilds the whole layout DOM (a new <Layout>, same model)', async () => {
    const before = await where();
    await p.eval('window.__fx.remount()');
    await p.waitFor(`!!document.querySelector('[data-lc-tutor-pane] #lc-tutor-panel-host')`, { what: 'the panel back in the rebuilt pane' });
    const w = await invariants('remounted');
    check(w.items === before.items, `feed items ${before.items} -> ${w.items}`);
    await p.eval('window.__fx.rerender()');
    await invariants('rerendered');
  });

  await scenario('native: Default layout reset (a new Model) brings the tab back to its last spot, here beside Description', async () => {
    const c = await center(`document.getElementById('default-layout')`);
    await io.click(c.x, c.y);
    await p.waitFor(`!!document.querySelector('[data-lc-tutor-button]')`, { what: 'the Tutor tab after a reset' });
    const w = await invariants('reset', { shown: false, deep: false });
    await rebase();
    check(w.tabset === w.descTabset, `Tutor in ${w.tabset}, Description in ${w.descTabset}`);
    const own = await p.eval(`window.__fx.model().toJson === Object.getPrototypeOf(window.__fx.model()).toJson`);
    check(!own, "the new model's toJson is not wrapped");
    await selectTutor();
    await invariants('reset then selected', { shown: true });
  });

  await scenario('native: Description deleted entirely, the Tutor tab and its feed stay', async () => {
    const before = await where();
    await p.eval(`window.__fx.model().doAction(window.__fx.Actions.deleteTab('description'))`);
    const w = await invariants('no description', { deep: false });
    await rebase();
    check(w.items === before.items, `feed items ${before.items} -> ${w.items}`);
    await selectTutor();
    await invariants('no description, selected', { shown: true });
  });

  await scenario('native: pagehide takes the tab out, pageshow (back-forward cache) puts it back', async () => {
    // Split beside Code and widened first: what the page saves on the way
    // out must still be the layout without the Tutor.
    await p.eval('window.__baseSizes = window.__sizes()');
    await io.htmlDrag(await center(tutorButton), await contentPoint('Code', 0.96, 0.5));
    await invariants('split before pagehide', { shown: true });
    const s = await p.eval(`(() => { const t = window.__tutorButtons()[0].closest('.flexlayout__tabset').getBoundingClientRect(); return { x: t.left - 4, y: t.top + t.height / 2 }; })()`);
    await io.pointerDrag(s, { x: s.x - 250, y: s.y });
    await invariants('widened before pagehide', { shown: true });
    await p.eval('new Promise((r) => setTimeout(r, 400))');
    await p.eval(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))`);
    await settle();
    await deepCheck('after pagehide');
    const sizes = await p.eval('[window.__sizes(), window.__baseSizes]');
    check(sizes[0] === sizes[1], `after pagehide the native tabsets did not get their space back: ${sizes[0]} vs ${sizes[1]}`);
    const gone = await p.eval(`({ node: !!window.__fx.model().getNodeById('lc-tutor-tab'), buttons: window.__tutorButtons().length })`);
    check(!gone.node && gone.buttons === 0, `after pagehide ${JSON.stringify(gone)}`);
    await p.eval(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    await p.waitFor(`!!document.querySelector('[data-lc-tutor-button]')`, { what: 'the Tutor tab after pageshow' });
    await invariants('after pageshow');
  });

  await scenario('native: no console errors', async () => {
    const errors = p.console.filter((l) => /^(error|exception)/.test(l));
    check(errors.length === 0, errors.join('\n'));
  });
  p.close();

  // ---- the remembered spot ------------------------------------------------
  //
  // chrome.storage.local is stood in for by the fixture origin's
  // localStorage (so it outlives a reload), or by one that always fails.
  const STORAGE_OK = `{
    get: async (key) => { const v = localStorage.getItem('__ext:' + key); return v ? { [key]: JSON.parse(v) } : {}; },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) localStorage.setItem('__ext:' + k, JSON.stringify(v)); },
  }`;
  const STORAGE_FAILS = `{
    get: () => Promise.reject(new Error('storage is unavailable')),
    set: () => { throw new Error('storage is unavailable'); },
  }`;
  const q = await browser.openPage('about:blank');
  await q.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  const qio = input(q);
  async function boot(storage = STORAGE_OK) {
    const nav = await q.send('Page.navigate', { url: `${origin}/problems/two-sum/description/${QUERY}` });
    if (nav.errorText) throw new Error(nav.errorText);
    await q.waitFor(`!!(window.__fx && document.querySelector('.flexlayout__tab_button'))`, { what: 'the flexlayout fixture' });
    await q.eval(HELPERS);
    await q.eval(`window.chrome = { runtime: { getURL: (file) => '/ext/' + file }, storage: { local: ${storage} } }`);
    await q.eval(`new Function(${JSON.stringify(panelSource)})()`);
    await q.waitFor(`!!document.querySelector('[data-lc-tutor-button]') && window.__streamOpen()`, { what: 'the native Tutor tab' });
    await q.eval('window.__settle()');
  }
  const stored = () => q.eval(`JSON.parse(localStorage.getItem('__ext:tutorTabPosition'))`);
  const qwhere = () => q.eval('window.__where()');
  const qcenter = (expr) => q.eval(`window.__center(${expr})`);
  const qtabset = (label) => `window.__button(${JSON.stringify(label)}).closest('.flexlayout__tabset')`;
  const qstrip = (label) => q.eval(`(() => { const r = ${qtabset(label)}.querySelector('.flexlayout__tabset_tabbar_outer').getBoundingClientRect(); return { x: r.right - 60, y: r.top + r.height / 2 }; })()`);
  const qcontent = (label, fx, fy) => q.eval(`(() => { const r = ${qtabset(label)}.querySelector('.flexlayout__tabset_content').getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }; })()`);
  // Waits out the bridge's debounce and the storage write.
  const afterMove = () => q.eval('new Promise((r) => setTimeout(r, 700))');
  async function clean(label) {
    const w = await qwhere();
    check(w.tutors === 1 && w.inert === 0 && !w.bodyActive && w.emptyTabsets === 0, `${label}: ${JSON.stringify(w)}`);
    check(!(await q.eval('window.__json()')).includes('lc-tutor'), `${label}: model.toJson() carries the Tutor tab`);
    check(!(await q.eval(`window.__fx.saved.some((x) => x.includes('lc-tutor') || x.includes('tutorTabPosition'))`)), `${label}: the page saved the tab or its spot`);
    const errors = q.console.filter((l) => /^(error|exception)/.test(l));
    check(errors.length === 0, `${label}: ${errors.join('\n')}`);
    return w;
  }
  const tutorLabels = () => q.eval(`[...window.__tutorButtons()[0].closest('.flexlayout__tabset').querySelectorAll('.flexlayout__tab_button')].map(window.__labelOf)`);

  await q.eval(`localStorage.clear()`).catch(() => {});
  await boot();
  await q.eval(`localStorage.clear()`);

  await scenario('spot: moved into the Code tabset, remembered by tab components, restored after a reload', async () => {
    await qio.htmlDrag(await qcenter('window.__tutorButtons()[0]'), await qstrip('Code'));
    await afterMove();
    const value = await stored();
    check(value && value.mode === 'tabset' && JSON.stringify(value.anchors) === JSON.stringify([anchor('Code')]) && value.after === anchor('Code'), `stored ${JSON.stringify(value)}`);
    const text = JSON.stringify(value);
    check(!/two-sum|class Solution|lc-tutor|tabset_|\/ts\d|ts-left|ts-code/.test(text), `stored value carries page data or ids: ${text}`);
    check(Object.keys(value).every((k) => ['v', 'mode', 'anchors', 'after', 'index', 'side', 'ratio'].includes(k)), text);
    await boot();
    check(JSON.stringify(await tutorLabels()) === '["Code","Tutor"]', `after reload: ${await tutorLabels()}`);
    await clean('reloaded into Code');
  });

  await scenario('spot: reordered among native tabs (before Submissions), restored after a reload', async () => {
    const to = await q.eval(`(() => { const r = window.__button('Submissions').getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2 }; })()`);
    await qio.htmlDrag(await qcenter('window.__tutorButtons()[0]'), to);
    await afterMove();
    const value = await stored();
    check(value.mode === 'tabset' && value.after === anchor('Solutions') && value.index === 3, `stored ${JSON.stringify(value)}`);
    await boot();
    check(JSON.stringify(await tutorLabels()) === '["Description","Editorial","Solutions","Tutor","Submissions"]', `after reload: ${await tutorLabels()}`);
    await clean('reloaded reordered');
  });

  const SIDE_POINTS = { left: [0.04, 0.5], right: [0.96, 0.5], top: [0.5, 0.04], bottom: [0.5, 0.96] };
  for (const side of ['left', 'right', 'top', 'bottom']) {
    await scenario(`spot: split to the ${side} of the Description tabset, restored on that side after a reload`, async () => {
      const [fx, fy] = SIDE_POINTS[side];
      await qio.htmlDrag(await qcenter('window.__tutorButtons()[0]'), await qcontent('Description', fx, fy));
      await afterMove();
      const value = await stored();
      check(value.mode === 'dock' && value.side === side && value.anchors.includes(anchor('Description')), `stored ${JSON.stringify(value)}`);
      await boot();
      check(JSON.stringify(await tutorLabels()) === '["Tutor"]', `after reload: ${await tutorLabels()}`);
      const rel = await q.eval(`(() => { const t = window.__tutorButtons()[0].closest('.flexlayout__tabset').getBoundingClientRect(); const d = ${qtabset('Description')}.getBoundingClientRect(); return { dx: (t.left + t.width / 2) - (d.left + d.width / 2), dy: (t.top + t.height / 2) - (d.top + d.height / 2), tw: t.width, th: t.height, dw: d.width, dh: d.height }; })()`);
      const ok = { left: rel.dx < 0 && Math.abs(rel.dx) > Math.abs(rel.dy), right: rel.dx > 0 && Math.abs(rel.dx) > Math.abs(rel.dy), top: rel.dy < 0 && Math.abs(rel.dy) > Math.abs(rel.dx), bottom: rel.dy > 0 && Math.abs(rel.dy) > Math.abs(rel.dx) }[side];
      check(ok, `${side}: ${JSON.stringify(rel)}`);
      await clean(`reloaded ${side}`);
      // Back home for the next side.
      await qio.htmlDrag(await qcenter('window.__tutorButtons()[0]'), await qstrip('Description'));
      await afterMove();
    });
  }

  await scenario('spot: the split keeps its share of the space after a reload', async () => {
    await qio.htmlDrag(await qcenter('window.__tutorButtons()[0]'), await qcontent('Description', 0.5, 0.96));
    await afterMove();
    // Make the Tutor pane taller with the splitter between the two.
    const split = await q.eval(`(() => { const t = window.__tutorButtons()[0].closest('.flexlayout__tabset').getBoundingClientRect(); return { x: t.left + t.width / 2, y: t.top - 4 }; })()`);
    await qio.pointerDrag(split, { x: split.x, y: split.y - 200 });
    await afterMove();
    const value = await stored();
    const before = await q.eval(`Math.round(window.__tutorButtons()[0].closest('.flexlayout__tabset').getBoundingClientRect().height)`);
    check(value.mode === 'dock' && value.side === 'bottom' && value.ratio > 0.55, `stored ${JSON.stringify(value)}`);
    await boot();
    const after = await q.eval(`Math.round(window.__tutorButtons()[0].closest('.flexlayout__tabset').getBoundingClientRect().height)`);
    check(Math.abs(after - before) <= 3, `height ${before} -> ${after}`);
    await clean('reloaded with its share');
  });

  await scenario('spot: a Default layout reset puts the tab back where it was moved to', async () => {
    const c = await qcenter(`document.getElementById('default-layout')`);
    await qio.click(c.x, c.y);
    await q.waitFor(`!!document.querySelector('[data-lc-tutor-button]') && !!window.__fx.model().getNodeById('lc-tutor-tab')`, { what: 'the tab after a reset' });
    await q.eval('window.__settle()');
    check(JSON.stringify(await tutorLabels()) === '["Tutor"]', `after reset: ${await tutorLabels()}`);
    const value = await stored();
    check(value.mode === 'dock' && value.side === 'bottom', `the reset changed the stored spot: ${JSON.stringify(value)}`);
    await clean('reset restored');
  });

  await scenario('spot: anchors that no longer exist fall back to the default spot', async () => {
    await q.eval(`localStorage.setItem('__ext:tutorTabPosition', JSON.stringify({ v: 1, mode: 'tabset', anchors: ['Renamed tab'], after: 'Renamed tab', index: 1 }))`);
    await boot();
    check(JSON.stringify(await tutorLabels()) === '["Description","Tutor","Editorial","Solutions","Submissions"]', `missing anchors: ${await tutorLabels()}`);
    await clean('missing anchors');
    await q.eval(`localStorage.setItem('__ext:tutorTabPosition', JSON.stringify({ v: 1, mode: 'dock', anchors: ['Gone'], side: 'left' }))`);
    await boot();
    check(JSON.stringify(await tutorLabels()) === '["Description","Tutor","Editorial","Solutions","Submissions"]', `missing dock anchor: ${await tutorLabels()}`);
    await q.eval(`localStorage.setItem('__ext:tutorTabPosition', JSON.stringify({ v: 9, junk: '<img src=x>' }))`);
    await boot();
    check(JSON.stringify(await tutorLabels()) === '["Description","Tutor","Editorial","Solutions","Submissions"]', `junk: ${await tutorLabels()}`);
    await clean('junk value');
  });

  await scenario('spot: storage that fails means the default spot, and the tab still moves', async () => {
    await q.eval(`localStorage.setItem('__ext:tutorTabPosition', JSON.stringify({ v: 1, mode: 'tabset', anchors: ${JSON.stringify([anchor('Code')])}, after: ${JSON.stringify(anchor('Code'))}, index: 1 }))`);
    await boot(STORAGE_FAILS);
    check(JSON.stringify(await tutorLabels()) === '["Description","Tutor","Editorial","Solutions","Submissions"]', `failing storage: ${await tutorLabels()}`);
    await qio.htmlDrag(await qcenter('window.__tutorButtons()[0]'), await qstrip('Code'));
    await afterMove();
    check(JSON.stringify(await tutorLabels()) === '["Code","Tutor"]', `moved: ${await tutorLabels()}`);
    await clean('failing storage');
  });
  q.close();

  // ---- clone mode (the bridge cannot load) --------------------------------
  const c = await browser.openPage(`${origin}/problems/two-sum/description/${QUERY}`);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await c.waitFor(`!!(window.__fx && document.querySelector('.flexlayout__tab_button'))`, { what: 'the flexlayout fixture' });
  await c.eval(HELPERS);
  await c.eval(`window.chrome = { runtime: { getURL: (file) => '/blocked/' + file } }`);
  await c.eval(`new Function(${JSON.stringify(panelSource)})()`);
  await c.waitFor(`!!document.querySelector('.flexlayout__tab_button[data-lc-tutor-tab]:not([data-lc-tutor-button])')`, { what: 'the injected Tutor tab' });
  const cio = input(c);

  await scenario('clone fallback: the injected tab sits right after Description, not after the last tab', async () => {
    const strip = await c.eval(`(() => {
      const t = window.__tutorButtons()[0];
      const label = (n) => n.classList.contains('flexlayout__tabset_tab_divider') ? '|' : n === t ? 'Tutor' : n.classList.contains('flexlayout__tab_button') ? n.textContent.trim() : '?';
      return [...t.parentElement.children].map(label);
    })()`);
    const at = strip.indexOf('Tutor');
    const before = strip.slice(0, at).filter((l) => l !== '|' && l !== '?');
    check(before.length === 1 && before[0].startsWith('Description') && at < strip.length - 1, `strip: ${JSON.stringify(strip)}`);
  });

  await scenario('clone fallback: the injected tab opens over the real layout, and native tabs switch back', async () => {
    const t = await c.eval(`window.__center(window.__tutorButtons()[0])`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.x, y: t.y, button: 'left', clickCount: 1, buttons: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.x, y: t.y, button: 'left', clickCount: 1 });
    await c.eval('window.__settle()');
    let w = await c.eval('window.__where()');
    check(w.tutors === 1 && w.shown, JSON.stringify(w));
    check(JSON.stringify(w.hostRect) === JSON.stringify(w.contentRect), `panel ${JSON.stringify(w.hostRect)} vs content ${JSON.stringify(w.contentRect)}`);
    check(w.inert === 1 && w.bodyActive, `inert ${w.inert}, body ${w.bodyActive}`);
    check(!(await c.eval('window.__json()')).includes('lc-tutor'), 'the clone reached the model');
    const s = await c.eval(`window.__center(window.__button('Submissions'))`);
    await cio.click(s.x, s.y);
    await c.eval('window.__settle()');
    w = await c.eval('window.__where()');
    check(!w.shown && w.inert === 0 && !w.bodyActive, JSON.stringify(w));
    const errors = c.console.filter((l) => /^(error|exception)/.test(l));
    check(errors.length === 0, errors.join('\n'));
  });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
