// extension/e2e/panel-render.e2e.mjs - the Tutor panel's DOM behavior in a
// real (headless) Chromium: the real extension/panel.js injected into a local
// fixture page (panel-fixture.html) that copies the bits of LeetCode's
// flexlayout DOM it mounts into, with fetch replaced by a scripted relay.
//
// Covers what the unit tests cannot: the feed is patched in place (a text
// selection and a code block's horizontal scroll survive streamed chunks and
// events for other problems), the header row (dark and light), which native pane is
// made inert, the injected tab's spot right after Description as tabs come
// and go, the relay-restart (epoch) flow over a reconnect, sending (double
// Enter, the too-long hint, a real click on the box around the textarea), the live editor code a send carries
// (the real content.js and inject.js answering against a stand-in Monaco),
// some CSS metrics, and tutor diagrams, tables, long URLs and identifiers
// across live pane resizes (240 to 1000 px wide, 200 to 700 px tall, a
// splitter drag moving the tabset and its pane together), including the
// feed's scroll anchor while a reply streams.
//
// Nothing here talks to the real relay: the fixture's fetch never reaches the
// network, and as a second guard the injected copy of panel.js points at a
// port nothing listens on. Manual check, not part of `npm test`:
//
//   node extension/e2e/panel-render.e2e.mjs
//   PANEL_JS=/tmp/old-panel.js node extension/e2e/panel-render.e2e.mjs
//
// Screenshots go to /tmp/lc-panel-shots.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = '/tmp/lc-panel-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8');
// PANEL_JS=<file> runs the scenarios against another copy (for example the
// version before a fix, to see the scenarios catch the bug).
const panelSource = fs
  .readFileSync(process.env.PANEL_JS || path.join(here, '..', 'panel.js'), 'utf8')
  .replace('const RELAY_BASE = "http://localhost:8135";', 'const RELAY_BASE = "http://127.0.0.1:9";');
if (!panelSource.includes('http://127.0.0.1:9')) throw new Error('could not repoint RELAY_BASE in the injected panel.js');
// The real content script too (it answers the panel's request for the live
// editor code, through the real inject.js), pointed at the same dead port.
const contentSource = fs
  .readFileSync(path.join(here, '..', 'content.js'), 'utf8')
  .replace('const RELAY_URL = "http://localhost:8135/capture";', 'const RELAY_URL = "http://127.0.0.1:9/capture";');
if (!contentSource.includes('http://127.0.0.1:9/capture')) throw new Error('could not repoint RELAY_URL in the injected content.js');
const injectSource = fs.readFileSync(path.join(here, '..', 'inject.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(here, '..', 'layout-bridge.js'), 'utf8');

// Serves the fixture at any /problems/<slug>/ path, on a random free port.
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/problems/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixture);
  } else if (req.url === '/ext/inject.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(injectSource);
  } else if (req.url === '/ext/layout-bridge.js') {
    // The real bridge: this fixture has no React, so it answers
    // { native: false } and the panel uses its injected tab.
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

const browser = await launch();
try {
  const page = await browser.openPage(`${origin}/problems/two-sum/description/`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });

  // Page-side helpers.
  await page.eval(`(() => {
    window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
    window.__q = (sel) => window.__root().querySelector(sel);
    window.__qa = (sel) => [...window.__root().querySelectorAll(sel)];
    window.__settle = () => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 30));
    window.__openTutor = () => {
      const tab = document.querySelector('[data-lc-tutor-tab]');
      tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    };
    window.__seq = 0;
    window.__ev = (obj) => window.__event({ seq: ++window.__seq, epoch: window.__epoch, ...obj });
    window.__epoch = 'e1';
  })()`);
  // A stand-in for LeetCode's Monaco (the visible editor is #pane-code) and
  // for chrome.runtime.getURL, which content.js uses to inject inject.js.
  await page.eval(`(() => {
    window.__editorCode = 'class Solution:\\n    def twoSum(self, nums, target):\\n        return []\\n';
    window.__noEditor = false;
    window.monaco = { editor: { getEditors: () => window.__noEditor ? [] : [{
      getDomNode: () => document.getElementById('pane-code'),
      getModel: () => ({ getValue: () => window.__editorCode, getLanguageId: () => 'python' }),
    }] } };
    window.chrome = { runtime: { getURL: (file) => '/ext/' + file } };
  })()`);
  await page.eval(`new Function(${JSON.stringify(contentSource)})()`);
  await page.eval(`new Function(${JSON.stringify(panelSource)})()`);
  await page.waitFor(`document.querySelector('[data-lc-tutor-tab]') && window.__streamOpen()`, { what: 'the Tutor tab and its event stream' });
  const settle = () => page.eval('window.__settle()');

  await scenario('offline: the empty state does not invite a question, the composer is disabled', async () => {
    await page.eval(`window.__event({ type: 'status', companionOnline: false, epoch: 'e1' })`);
    await page.eval('window.__openTutor()');
    await settle();
    const info = await page.eval(`({
      empty: window.__q('.empty p').textContent,
      label: window.__q('.status span').textContent,
      disabled: window.__q('textarea').disabled,
      banner: !window.__q('.banner').hidden,
    })`);
    check(info.label === 'Tutor offline', `status label: ${info.label}`);
    const light = await page.eval(`(() => { const l = window.__q('.status .light'); return { state: window.__q('.status').dataset.state, color: getComputedStyle(l).backgroundColor, muted: getComputedStyle(window.__q('.status')).color }; })()`);
    check(light.state === 'neutral' && light.color === light.muted, `tutor offline light: ${JSON.stringify(light)}`);
    check(!/ask a question/i.test(info.empty) && /Once the companion is running/.test(info.empty), `empty copy: ${info.empty}`);
    check(info.disabled && info.banner, JSON.stringify(info));
    await page.screenshot(path.join(SHOTS, '01-offline.png'), { width: 1100, height: 760 });
  });

  await scenario('header row: like the Submissions row, flush at the top, 32px, 1px in from each side, a hairline below', async () => {
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e1' })`);
    await settle();
    const m = await page.eval(`(() => {
      const host = document.getElementById('lc-tutor-panel-host').getBoundingClientRect();
      const headNode = window.__q('.head');
      const head = headNode.getBoundingClientRect();
      const hs = getComputedStyle(headNode);
      const status = window.__q('.status');
      const cs = getComputedStyle(status);
      const scroll = window.__q('.scroll');
      return {
        title: window.__qa('h1, h2, .title').length,
        left: window.__q('.head > .head-left > .status') !== null,
        right: window.__q('.head > .head-right > button.model[hidden] > .provider') !== null && window.__q('.head > .head-right > button.gear') !== null,
        // The header stays put while the transcript scrolls under it.
        outsideScroll: !scroll.contains(headNode),
        role: status.getAttribute('role'),
        text: status.textContent,
        lightFirst: status.firstElementChild.classList.contains('light') && status.firstElementChild.getAttribute('aria-hidden') === 'true',
        light: (() => { const r = status.firstElementChild.getBoundingClientRect(); return { w: r.width, h: r.height, mid: r.top + r.height / 2 - (head.top + head.height / 2), radius: getComputedStyle(status.firstElementChild).borderRadius }; })(),
        font: cs.fontSize + '/' + cs.lineHeight,
        statusColor: cs.color,
        headColor: hs.color,
        rowColor: getComputedStyle(document.querySelector('#pane-subs .row-label')).color,
        rect: { top: head.top - host.top, left: head.left - host.left, width: head.width, hostWidth: host.width, height: head.height },
        padding: hs.paddingLeft + ' ' + hs.paddingRight,
        statusLeft: status.getBoundingClientRect().left - host.left,
        border: hs.borderBottomWidth + ' ' + hs.borderBottomStyle + ' ' + hs.borderBottomColor,
        otherBorders: [hs.borderTopWidth, hs.borderLeftWidth, hs.borderRightWidth].join(' '),
        scrollTop: scroll.getBoundingClientRect().top - head.bottom,
        empty: window.__q('.empty p').textContent,
        emptyColor: getComputedStyle(window.__q('.empty')).color,
        emptyFont: getComputedStyle(window.__q('.empty')).fontSize + '/' + getComputedStyle(window.__q('.empty')).lineHeight,
      };
    })()`);
    check(m.title === 0, 'a heading is still in the panel');
    check(m.left && m.right, `header structure: ${JSON.stringify(m)}`);
    check(m.outsideScroll, 'the header scrolls away with the transcript');
    check(m.role === 'status', `status role: ${m.role}`);
    check(m.text === 'Connected' && m.lightFirst, `status: ${m.text}`);
    check(m.light.w === 8 && m.light.h === 8 && m.light.radius === '50%' && Math.abs(m.light.mid) <= 0.5, `status light: ${JSON.stringify(m.light)}`);
    check(m.font === '14px/20px', `status font: ${m.font}`);
    const r = m.rect;
    // The real Submissions row sits 1px in from each side of the pane (x=11,
    // width 776 in a pane at x=10, width 778), so its text starts at 13px.
    check(r.top === 0 && r.left === 1 && r.width === r.hostWidth - 2 && r.height === 32, `header box: ${JSON.stringify(r)}`);
    check(m.padding === '12px 12px' && m.statusLeft === 13, `header padding: ${m.padding}, status at ${m.statusLeft}`);
    // color-mix(in srgb, <the Description pane's white body text> 10%, transparent)
    check(/^1px solid (rgba\(255, 255, 255, 0\.1\)|color\(srgb 1 1 1 \/ 0\.1\))$/.test(m.border), `header border: ${m.border}`);
    check(m.otherBorders === '0px 0px 0px', `only a bottom border: ${m.otherBorders}`);
    // The text color is the Submissions row's own (sampled, not hardcoded).
    check(m.rowColor === 'rgba(239, 242, 246, 0.6)', `fixture row color: ${m.rowColor}`);
    check(m.headColor === m.rowColor && m.statusColor === m.rowColor, `header text ${m.headColor} / status ${m.statusColor} vs the Submissions row ${m.rowColor}`);
    check(m.scrollTop === 0, `gap under the header: ${m.scrollTop}`);
    check(/ask a question/.test(m.empty), `online empty copy: ${m.empty}`);
    // color-mix(in srgb, rgb(245,245,245) 30%, transparent)
    check(/^(rgba\(245, 245, 245, 0\.3\)|color\(srgb 0\.96\d* 0\.96\d* 0\.96\d* \/ 0\.3\))$/.test(m.emptyColor), `empty color: ${m.emptyColor}`);
    check(m.emptyFont === '14px/21px', `empty font: ${m.emptyFont}`);
    await page.screenshot(path.join(SHOTS, '02-header-empty.png'), { width: 1100, height: 760 });
  });

  await scenario('the status light: green and Connected when idle, yellow and Processing while the tutor works, green again after', async () => {
    const read = () => page.eval(`(() => {
      const status = window.__q('.status');
      return { text: status.querySelector('span').textContent, state: status.dataset.state, color: getComputedStyle(status.querySelector('.light')).backgroundColor, role: status.getAttribute('role') };
    })()`);
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: false, epoch: 'e1', openTurns: [] })`);
    await settle();
    const idle = await read();
    check(idle.text === 'Connected' && idle.state === 'ok' && idle.color === 'rgb(44, 187, 93)', `idle: ${JSON.stringify(idle)}`);
    // A message waiting in the queue, then its turn: Processing until the companion is idle again.
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: true, epoch: 'e1', openTurns: [] })`);
    await settle();
    const busy = await read();
    check(busy.text === 'Processing' && busy.state === 'busy' && busy.color === 'rgb(255, 192, 30)' && busy.role === 'status', `busy: ${JSON.stringify(busy)}`);
    check(!(await page.eval(`window.__q('textarea').disabled`)), 'the composer stays usable while the tutor works');
    await page.screenshot(path.join(SHOTS, '02c-processing.png'), { width: 1100, height: 760 });
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: false, epoch: 'e1', openTurns: [] })`);
    await settle();
    const after = await read();
    check(after.text === 'Connected' && after.state === 'ok', `after: ${JSON.stringify(after)}`);
  });

  await scenario('header row in light mode: the hairline and text follow the page theme', async () => {
    await page.eval(`document.documentElement.classList.add('light')`);
    await settle();
    const lightColor = () => page.eval(`getComputedStyle(window.__q('.status .light')).backgroundColor`);
    const okLight = await lightColor();
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: true, epoch: 'e1', openTurns: [] })`);
    await settle();
    const busyLight = await lightColor();
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: false, epoch: 'e1', openTurns: [] })`);
    await settle();
    // Darker shades on white (at least 3:1 for a graphic).
    check(okLight === 'rgb(14, 138, 58)' && busyLight === 'rgb(185, 124, 0)', `light theme lights: ${okLight} / ${busyLight}`);
    const m = await page.eval(`(() => {
      const hs = getComputedStyle(window.__q('.head'));
      return {
        border: hs.borderBottomColor,
        color: hs.color,
        rowColor: getComputedStyle(document.querySelector('#pane-subs .row-label')).color,
      };
    })()`);
    await page.screenshot(path.join(SHOTS, '02b-header-light.png'), { width: 1100, height: 760 });
    await page.eval(`document.documentElement.classList.remove('light')`);
    await settle();
    // The light fixture's Description text is rgb(38, 38, 38).
    check(/^(rgba\(38, 38, 38, 0\.1\)|color\(srgb 0\.149\d* 0\.149\d* 0\.149\d* \/ 0\.1\))$/.test(m.border), `light border: ${m.border}`);
    check(m.rowColor === 'rgba(26, 26, 26, 0.6)' && m.color === m.rowColor, `light header text ${m.color} vs the Submissions row ${m.rowColor}`);
  });

  await scenario('the header names the tutor model on the right, in the language selector\'s text style, with a settings gear', async () => {
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: false, epoch: 'e1', openTurns: [] })`);
    await page.eval(`window.__event({ type: 'config', provider: 'local', label: 'Local model', model: 'gpt-oss:20b', epoch: 'e1' })`);
    await settle();
    const m = await page.eval(`(() => {
      const host = document.getElementById('lc-tutor-panel-host').getBoundingClientRect();
      const head = window.__q('.head').getBoundingClientRect();
      const provider = window.__q('.provider');
      const button = window.__q('button.model');
      const gear = window.__q('button.gear');
      const pr = button.getBoundingClientRect();
      const gr = gear.getBoundingClientRect();
      const ps = getComputedStyle(provider);
      const gs = getComputedStyle(gear);
      const icon = gear.querySelector('svg').getBoundingClientRect();
      return {
        text: provider.textContent,
        hidden: button.hidden,
        title: button.title,
        font: ps.fontSize + '/' + ps.lineHeight,
        color: ps.color,
        langFont: getComputedStyle(document.getElementById('lang-button')).fontSize + '/' + getComputedStyle(document.getElementById('lang-button')).lineHeight,
        langColor: getComputedStyle(document.getElementById('lang-button')).color,
        statusColor: getComputedStyle(window.__q('.status')).color,
        providerMid: pr.top + pr.height / 2 - (head.top + head.height / 2),
        gap: gr.left - pr.right,
        gear: { w: gr.width, h: gr.height, mid: gr.top + gr.height / 2 - (head.top + head.height / 2), right: host.right - gr.right, radius: gs.borderRadius, color: gs.color, bg: gs.backgroundColor },
        icon: { w: icon.width, h: icon.height, dx: icon.left + icon.width / 2 - (gr.left + gr.width / 2), dy: icon.top + icon.height / 2 - (gr.top + gr.height / 2) },
        label: gear.getAttribute('aria-label'),
        tip: gear.title,
        type: gear.type,
      };
    })()`);
    check(m.text === 'Local model · gpt-oss:20b' && !m.hidden, `provider label: ${JSON.stringify(m)}`);
    check(m.title === 'The tutor uses Local model, gpt-oss:20b', `provider tooltip: ${m.title}`);
    // Without a list of saved models (no worker here) the switcher shows what
    // the tutor reported, in the language selector's text style.
    check(m.font === m.langFont && m.color === m.langColor, `provider text style: ${m.font} ${m.color} vs the language selector ${m.langFont} ${m.langColor}`);
    check(Math.abs(m.providerMid) <= 0.5, `provider label centered: ${m.providerMid}`);
    check(m.label === 'Tutor settings' && m.tip === 'Tutor settings' && m.type === 'button', `gear a11y: ${JSON.stringify(m)}`);
    // 1px header margin plus 12px padding, less the 4px the icon sits inside
    // its hover box: the icon ends 13px from the pane edge, where the status
    // text starts on the left.
    check(m.gear.w === 24 && m.gear.h === 24 && Math.abs(m.gear.mid) <= 0.5 && m.gear.right === 9, `gear box: ${JSON.stringify(m.gear)}`);
    check(m.gear.radius === '4px' && m.gear.color === m.statusColor && m.gear.bg === 'rgba(0, 0, 0, 0)', `gear at rest: ${JSON.stringify(m.gear)}`);
    check(m.icon.w === 16 && m.icon.h === 16 && Math.abs(m.icon.dx) <= 0.5 && Math.abs(m.icon.dy) <= 0.5, `gear icon: ${JSON.stringify(m.icon)}`);
    check(m.gap === 4, `label to gear gap: ${m.gap}`);
    // Hover: the label color brightens to the tab text and a faint fill shows.
    const center = await page.eval(`(() => { const r = window.__q('button.gear').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
    await settle();
    const hover = await page.eval(`(() => { const g = getComputedStyle(window.__q('button.gear')); return { color: g.color, bg: g.backgroundColor, fg: getComputedStyle(window.__q('.wrap')).getPropertyValue('--fg') || document.getElementById('lc-tutor-panel-host').style.getPropertyValue('--fg') }; })()`);
    check(hover.color === hover.fg.trim() && hover.bg !== 'rgba(0, 0, 0, 0)', `gear hover: ${JSON.stringify(hover)}`);
    await page.screenshot(path.join(SHOTS, '02d-header-provider-gear-hover.png'), { width: 1100, height: 760 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await settle();
    await page.screenshot(path.join(SHOTS, '02e-header-provider-gear.png'), { width: 1100, height: 760 });
  });

  await scenario('the gear asks the background worker to open the options page, and does nothing without an extension runtime', async () => {
    // As injected here (no extension), chrome.runtime has no id: a click must not throw.
    await page.eval(`window.__q('button.gear').click()`);
    const sent = await page.eval(`(() => {
      const saved = window.chrome.runtime;
      const messages = [];
      window.chrome.runtime = { ...saved, id: 'abcdefghijklmnopabcdefghijklmnop', sendMessage: (m) => { messages.push(m); return Promise.resolve(); } };
      window.__q('button.gear').click();
      window.chrome.runtime = saved;
      return messages;
    })()`);
    check(JSON.stringify(sent) === JSON.stringify([{ type: 'lc-tutor:open-settings' }]), `messages sent: ${JSON.stringify(sent)}`);
    const rejected = await page.eval(`(async () => {
      const saved = window.chrome.runtime;
      window.chrome.runtime = { ...saved, id: 'abcdefghijklmnopabcdefghijklmnop', sendMessage: () => Promise.reject(new Error('Extension context invalidated.')) };
      window.__q('button.gear').click();
      await new Promise((r) => setTimeout(r, 50));
      window.chrome.runtime = saved;
      return 'ok';
    })()`);
    check(rejected === 'ok', 'a rejected sendMessage escaped');
  });

  await scenario('a long model name is cut with an ellipsis, never pushing the status or the gear', async () => {
    const statusBefore = await page.eval(`window.__q('.status').getBoundingClientRect().width`);
    await page.eval(`window.__event({ type: 'config', provider: 'openai', label: 'OpenAI API key', model: 'a-very-long-fine-tuned-model-name-that-goes-on-and-on-and-on-and-on-and-on-and-on-and-on-and-on-and-on-forever', epoch: 'e1' })`);
    await settle();
    const m = await page.eval(`(() => {
      const head = window.__q('.head').getBoundingClientRect();
      const p = window.__q('.provider');
      const pr = p.getBoundingClientRect();
      const sr = window.__q('.status').getBoundingClientRect();
      const gr = window.__q('button.gear').getBoundingClientRect();
      return { overflow: getComputedStyle(p).textOverflow, clipped: p.scrollWidth > p.clientWidth, providerLeft: pr.left, statusRight: sr.right, statusWidth: sr.width, gearRight: gr.right, headRight: head.right, gearWidth: gr.width, headHeight: head.height };
    })()`);
    check(m.overflow === 'ellipsis' && m.clipped, `long name: ${JSON.stringify(m)}`);
    check(m.providerLeft >= m.statusRight + 12 && m.statusWidth === statusBefore, `the label crowds the status: ${JSON.stringify(m)}`);
    check(m.gearWidth === 24 && m.headRight - m.gearRight === 8 && m.headHeight === 32, `the gear moved or the row grew: ${JSON.stringify(m)}`);
    await page.screenshot(path.join(SHOTS, '02f-header-long-model.png'), { width: 1100, height: 760 });
    await page.eval(`window.__event({ type: 'config', provider: 'claude', label: 'Claude subscription', model: null, epoch: 'e1' })`);
    await settle();
    const plain = await page.eval(`window.__q('.provider').textContent`);
    check(plain === 'Claude subscription', `no model: ${plain}`);
  });

  await scenario('offline, the model is not named (it may be stale) but the gear stays', async () => {
    await page.eval(`window.__event({ type: 'status', companionOnline: false, epoch: 'e1' })`);
    await settle();
    const m = await page.eval(`({ hidden: window.__q('button.model').hidden, display: getComputedStyle(window.__q('button.model')).display, gear: getComputedStyle(window.__q('button.gear')).display })`);
    check(m.hidden && m.display === 'none' && m.gear !== 'none', `offline header: ${JSON.stringify(m)}`);
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: false, epoch: 'e1', openTurns: [] })`);
    await settle();
    check(!(await page.eval(`window.__q('button.model').hidden`)), 'the label comes back when the companion does');
  });

  await scenario('light mode: the model button follows the language selector and the gear the light row color', async () => {
    await page.eval(`document.documentElement.classList.add('light')`);
    await settle();
    const m = await page.eval(`({
      provider: getComputedStyle(window.__q('button.model')).color,
      lang: getComputedStyle(document.getElementById('lang-button')).color,
      gear: getComputedStyle(window.__q('button.gear')).color,
      row: getComputedStyle(document.querySelector('#pane-subs .row-label')).color,
    })`);
    await page.screenshot(path.join(SHOTS, '02g-header-provider-light.png'), { width: 1100, height: 760 });
    await page.eval(`document.documentElement.classList.remove('light')`);
    await settle();
    check(m.row === 'rgba(26, 26, 26, 0.6)' && m.provider === m.lang && m.gear === m.row, `light: ${JSON.stringify(m)}`);
  });

  await scenario('header text before Submissions was ever opened: the measured row color in dark, the tab strip in light', async () => {
    const colors = () => page.eval(`({
      head: getComputedStyle(window.__q('.head')).color,
      tab: getComputedStyle(document.querySelector('.flexlayout__tab_button--unselected:not([data-lc-tutor-tab])')).color,
    })`);
    // No Submissions pane yet (LeetCode mounts it on first open). A theme
    // change makes the panel sample again.
    await page.eval(`(() => { window.__subs = document.getElementById('pane-subs'); window.__subs.remove(); document.documentElement.classList.add('light'); })()`);
    await settle();
    const light = await colors();
    await page.eval(`document.documentElement.classList.remove('light')`);
    await settle();
    const dark = await colors();
    await page.eval(`(() => { document.querySelector('.flexlayout__layout').appendChild(window.__subs); document.documentElement.classList.add('light'); })()`);
    await settle();
    await page.eval(`document.documentElement.classList.remove('light')`);
    await settle();
    const back = await colors();
    check(dark.head === 'rgba(239, 242, 246, 0.6)', `dark fallback: ${dark.head}`);
    check(light.head === light.tab && light.tab === 'rgba(38, 38, 38, 0.6)', `light fallback: ${JSON.stringify(light)}`);
    check(back.head === 'rgba(239, 242, 246, 0.6)', `with the pane back: ${back.head}`);
  });

  await scenario('while the Tutor tab is selected, the native selected label takes the tab strip color, not the row color', async () => {
    const c = await page.eval(`({
      selected: getComputedStyle(document.querySelector('.flexlayout__tab_button--selected:not([data-lc-tutor-tab])')).color,
      tab: getComputedStyle(document.querySelector('.flexlayout__tab_button--unselected:not([data-lc-tutor-tab])')).color,
    })`);
    check(c.selected === c.tab && c.tab === 'rgba(255, 255, 255, 0.6)', JSON.stringify(c));
  });

  await scenario('while the Tutor tab is selected, the native selected label takes the unselected weight, and gets it back after', async () => {
    // The visible copy of each label (the first leaf), as the student sees it.
    const weights = () =>
      page.eval(`(() => {
        const label = (sel) => getComputedStyle(document.querySelector(sel + ':not([data-lc-tutor-tab]) .label > div')).fontWeight;
        return { selected: label('.flexlayout__tab_button--selected'), tab: label('.flexlayout__tab_button--unselected') };
      })()`);
    const dimmed = await weights();
    check(dimmed.selected === dimmed.tab && dimmed.tab === '400', `with the Tutor tab active: ${JSON.stringify(dimmed)}`);
    await page.eval(`document.querySelectorAll('.flexlayout__tab_button')[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    await settle();
    const restored = await weights();
    check(restored.selected === '600', `back on Description: ${JSON.stringify(restored)}`);
    await page.eval('window.__openTutor()');
    await settle();
  });

  await scenario('the pane made inert is the one under the tabset, not the first in DOM order', async () => {
    const inert = await page.eval(`({ code: document.getElementById('pane-code').inert, desc: document.getElementById('pane-desc').inert })`);
    check(inert.desc === true && inert.code === false, JSON.stringify(inert));
    // The body color is sampled from that same pane.
    const body = await page.eval(`document.getElementById('lc-tutor-panel-host').style.getPropertyValue('--body')`);
    check(body === 'rgb(255, 255, 255)', `--body sampled from the wrong pane: ${body}`);
  });

  await scenario('a selection in an earlier paragraph survives a streamed chunk', async () => {
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'r1', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'r1', text: 'The first paragraph explains the idea in plain words.\\n\\nThe second one is still stre' })`);
    await settle();
    await page.eval(`(() => {
      const p = window.__q('.tutor p');
      p.__marker = 'original';
      const text = p.firstChild;
      const range = document.createRange();
      range.setStart(text, 4);
      range.setEnd(text, 19);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    })()`);
    const before = await page.eval(`window.__root().getSelection().toString()`);
    check(before === 'first paragraph', `could not set up the selection: ${JSON.stringify(before)}`);
    for (const piece of ['aming in', ' as we speak.', '\\n\\nAnd a third.']) {
      // eslint-disable-next-line no-await-in-loop
      await page.eval(`window.__ev({ type: 'chunk', turnId: 'r1', text: '${piece}' })`);
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }
    const after = await page.eval(`({
      sel: window.__root().getSelection().toString(),
      same: window.__q('.tutor p').__marker === 'original',
      paras: window.__qa('.tutor p').map((p) => p.textContent),
    })`);
    check(after.same, 'the first paragraph node was replaced');
    check(after.sel === 'first paragraph', `selection lost: ${JSON.stringify(after.sel)}`);
    check(after.paras.length === 3 && after.paras[1] === 'The second one is still streaming in as we speak.', JSON.stringify(after.paras));
    // Control: the detector itself works (replacing the node drops the selection).
    const control = await page.eval(`(() => {
      const p = window.__q('.tutor p');
      const copy = p.cloneNode(true);
      p.replaceWith(copy);
      const lost = window.__root().getSelection().toString() !== 'first paragraph';
      copy.replaceWith(p);
      return lost;
    })()`);
    check(control, 'control failed: replacing the node kept the selection, so this check proves nothing');
  });

  await scenario('a code block keeps its horizontal scroll through other problems, status and new items', async () => {
    const wide = 'x = [' + Array.from({ length: 60 }, (_, i) => i).join(', ') + ']';
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'r1', problemSlug: 'two-sum', text: ${JSON.stringify(`Look at this:\n\n\`\`\`python\n${wide}\n\`\`\`\n\nDone.`)} })`);
    await settle();
    await page.eval(`(() => { const pre = window.__q('pre'); pre.__marker = 'original'; pre.scrollLeft = 120; })()`);
    const start = await page.eval(`window.__q('pre').scrollLeft`);
    check(start === 120, `could not scroll the code block (scrollWidth too small?): ${start}`);
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'valid-parentheses', text: 'elsewhere' })`);
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'other', problemSlug: 'valid-parentheses' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'other', text: 'streaming somewhere else' })`);
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e1' })`);
    await settle();
    const mid = await page.eval(`({ left: window.__q('pre').scrollLeft, same: window.__q('pre').__marker === 'original' })`);
    check(mid.same && mid.left === 120, `after other-problem events: ${JSON.stringify(mid)}`);
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'two-sum', text: 'a new message here' })`);
    await settle();
    const end = await page.eval(`({ left: window.__q('pre').scrollLeft, same: window.__q('pre').__marker === 'original', users: window.__qa('.user').length })`);
    check(end.same && end.left === 120 && end.users === 1, `after an appended item: ${JSON.stringify(end)}`);
    await page.eval(`window.__q('pre').scrollLeft = 0`);
  });

  await scenario('markdown: aligned table cells, strikethrough, list metrics, a code scrollbar without buttons', async () => {
    const md = [
      'Steps:',
      '',
      '- one',
      '- two',
      '- three',
      '',
      '| Approach | Time | Space |',
      '| :-- | :-: | --: |',
      '| Hash map | O(n) | O(n) |',
      '',
      'This is ~~wrong~~ right.',
      '',
      '```',
      'y = "' + 'z'.repeat(200) + '"',
      '```',
    ].join('\n');
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'md', problemSlug: 'two-sum', text: ${JSON.stringify(md)} })`);
    await settle();
    const m = await page.eval(`(() => {
      const tutor = window.__qa('.tutor').at(-1);
      const lis = [...tutor.querySelectorAll('li')];
      const ul = tutor.querySelector('ul');
      const cells = [...tutor.querySelectorAll('td')].map((c) => getComputedStyle(c).textAlign);
      const pre = tutor.querySelector('pre');
      return {
        liIndent: lis[0].getBoundingClientRect().left - ul.getBoundingClientRect().left,
        pitch: lis[1].getBoundingClientRect().top - lis[0].getBoundingClientRect().top,
        lastLiMargin: getComputedStyle(lis[2]).marginBottom,
        cells,
        del: tutor.querySelector('del') && tutor.querySelector('del').textContent,
        webkitScrollbar: CSS.supports('selector(::-webkit-scrollbar)'),
        preScrollbarWidth: getComputedStyle(pre).scrollbarWidth,
        preScrollable: pre.scrollWidth > pre.clientWidth,
        barHeight: pre.offsetHeight - pre.clientHeight - 2,
      };
    })()`);
    check(m.liIndent === 16, `list item indent: ${m.liIndent}`);
    check(m.pitch === 33, `list item pitch: ${m.pitch}`);
    check(m.lastLiMargin === '0px', `last item margin: ${m.lastLiMargin}`);
    check(JSON.stringify(m.cells) === JSON.stringify(['left', 'center', 'right']), `cell alignment: ${m.cells}`);
    check(m.del === 'wrong', `strikethrough: ${m.del}`);
    check(m.webkitScrollbar && m.preScrollbarWidth === 'auto', `the styled scrollbar is switched off: ${JSON.stringify(m)}`);
    check(m.preScrollable && m.barHeight === 8, `code block scrollbar height: ${m.barHeight}`);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await settle();
    await page.screenshot(path.join(SHOTS, '03-markdown.png'), { width: 1100, height: 760 });
  });

  await scenario('table cells render br variants as DOM breaks without parsing other HTML', async () => {
    const markdown = '| First | Second | Third | Unsafe |\n| --- | --- | --- | --- |\n| A<br>B | C<br/>D | E<br />F | <img src=x> |';
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'table-breaks', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'table-breaks', problemSlug: 'two-sum', text: ${JSON.stringify(markdown)} })`);
    await settle();
    const m = await page.eval(`(() => {
      const cells = [...window.__qa('.tutor').at(-1).querySelectorAll('td')];
      return { breaks: cells.map((c) => c.querySelectorAll('br').length),
        text: cells.map((c) => c.textContent), images: cells[3].querySelectorAll('img').length };
    })()`);
    check(JSON.stringify(m.breaks) === JSON.stringify([1, 1, 1, 0]), JSON.stringify(m));
    check(JSON.stringify(m.text) === JSON.stringify(['AB', 'CD', 'EF', '<img src=x>']) && m.images === 0, JSON.stringify(m));
  });

  await scenario('raw LaTeX in a reply reads as plain math, and code keeps it verbatim', async () => {
    // What gpt-oss:20b sent live, plus the other delimiters and commands.
    const markdown = [
      'The pairs are \\[ \\frac{n(n-1)}{2} = O(n^2). \\]',
      '',
      'So \\( a \\cdot b \\le c \\), $O(n \\log n)$ and \\(\\sqrt{n+1}\\) at $5 a call.',
      '',
      'Keep `\\frac{a}{b}` as typed:',
      '',
      '```',
      '\\frac{a}{b} $x$',
      '```',
    ].join('\n');
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'latex', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'latex', problemSlug: 'two-sum', text: ${JSON.stringify(markdown)} })`);
    await settle();
    const m = await page.eval(`(() => {
      const reply = window.__qa('.tutor').at(-1);
      return { paras: [...reply.querySelectorAll('p')].map((p) => p.textContent),
        code: [...reply.querySelectorAll('p code')].map((c) => c.textContent),
        pre: [...reply.querySelectorAll('pre')].map((p) => p.textContent),
        elements: [...reply.querySelectorAll('p *')].map((e) => e.tagName.toLowerCase()) };
    })()`);
    check(m.paras[0] === 'The pairs are n(n-1)/2 = O(n²).', JSON.stringify(m.paras[0]));
    check(m.paras[1] === 'So a · b ≤ c, O(n log n) and √(n+1) at $5 a call.', JSON.stringify(m.paras[1]));
    check(JSON.stringify(m.code) === JSON.stringify(['\\frac{a}{b}']), JSON.stringify(m.code));
    check(m.pre.length === 1 && m.pre[0].includes('\\frac{a}{b} $x$'), JSON.stringify(m.pre));
    // Text only: the paragraphs hold no element but the code span.
    check(m.elements.every((t) => t === 'code'), JSON.stringify(m.elements));
  });

  await scenario('an 8000-character user message collapses and can expand', async () => {
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'two-sum', text: 'x'.repeat(8000) })`);
    await settle();
    const before = await page.eval(`(() => { const n = window.__qa('.user').at(-1); return { height: n.getBoundingClientRect().height,
      button: n.querySelector('button')?.textContent || '' }; })()`);
    check(before.height < 500 && before.button === 'Show more', JSON.stringify(before));
    await page.eval(`window.__qa('.user').at(-1).querySelector('button').click()`);
    await settle();
    const after = await page.eval(`(() => { const n = window.__qa('.user').at(-1); return { height: n.getBoundingClientRect().height,
      button: n.querySelector('button')?.textContent || '', text: n.textContent.length }; })()`);
    check(after.height > before.height && after.button === 'Show less' && after.text >= 8000, JSON.stringify(after));
  });

  await scenario('double Enter sends once, and the textarea is read-only while the POST is in flight', async () => {
    await page.eval(`(() => { window.__postDelayMs = 400; window.__posts.length = 0; })()`);
    await page.eval(`(() => {
      const t = window.__q('textarea');
      t.focus();
      t.value = 'what is the complexity?';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      const enter = () => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      enter();
      enter();
      window.__duringSend = { readOnly: t.readOnly, sendDisabled: window.__q('.box button').disabled };
      enter();
    })()`);
    const during = await page.eval('window.__duringSend');
    await page.waitFor(`window.__q('textarea').readOnly === false`, { what: 'the send to finish' });
    const after = await page.eval(`({ posts: window.__posts.length, value: window.__q('textarea').value, body: window.__posts[0] })`);
    check(during.readOnly && during.sendDisabled, `during the send: ${JSON.stringify(during)}`);
    check(after.posts === 1, `sent ${after.posts} times`);
    check(after.value === '' && after.body.problemSlug === 'two-sum', JSON.stringify(after));
    await page.eval('window.__postDelayMs = 0');
  });

  await scenario('a send carries the live editor code read through content.js and inject.js', async () => {
    await page.eval(`(() => {
      window.__posts.length = 0;
      window.__editorCode = 'class Solution:\\n    def twoSum(self, nums, target):\\n        seen = {}  # edited, not run\\n';
      const t = window.__q('textarea');
      t.value = 'is this better?';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor(`window.__posts.length === 1`, { what: 'the message POST' });
    const body = await page.eval('window.__posts[0]');
    check(body.text === 'is this better?' && body.problemSlug === 'two-sum', JSON.stringify(body));
    check(body.snapshot && body.snapshot.code === await page.eval('window.__editorCode'), `snapshot code: ${JSON.stringify(body.snapshot)}`);
    check(body.snapshot.language === 'Python3', `language: ${body.snapshot.language}`);
    check(body.snapshot.problemTitle === 'Fixture problem page', `title: ${body.snapshot.problemTitle}`);
    check(/^Given an array of integers/.test(body.snapshot.problemDescription || ''), `statement: ${body.snapshot.problemDescription}`);
    check(!!(await page.eval(`document.getElementById('leetcode-capture-inject')`)), 'inject.js was not injected');
  });

  await scenario('a Run is captured from the editor model', async () => {
    await page.eval(`(() => {
      window.__captures.length = 0;
      document.getElementById('editor-button').dispatchEvent(new KeyboardEvent('keydown', { key: "'", ctrlKey: true, bubbles: true }));
    })()`);
    await page.waitFor(`window.__captures.length === 1`, { what: 'the capture POST' });
    const capture = await page.eval('window.__captures[0]');
    check(capture.trigger === 'run' && capture.code === await page.eval('window.__editorCode'), JSON.stringify(capture));
    await page.eval('window.__openTutor()');
  });

  await scenario('a Run whose editor cannot be read is not captured, and the panel says so', async () => {
    // Past content.js's 300 ms guard against a double capture of one Run.
    await page.eval('new Promise((r) => setTimeout(r, 400))');
    await page.eval(`(() => {
      window.__captures.length = 0;
      window.__noEditor = true;
      document.getElementById('editor-button').dispatchEvent(new KeyboardEvent('keydown', { key: "'", ctrlKey: true, bubbles: true }));
    })()`);
    // Past content.js's 500 ms model-read timeout.
    await page.eval('new Promise((r) => setTimeout(r, 1200))');
    check(await page.eval(`document.querySelector('[data-lc-tutor-tab]').hasAttribute('data-unread')`), 'no unread dot for the error');
    check((await page.eval('window.__captures.length')) === 0, `sent: ${JSON.stringify(await page.eval('window.__captures'))}`);
    await page.eval('window.__openTutor()');
    await settle();
    const notices = await page.eval(`window.__qa('.notice').map((n) => n.textContent)`);
    check(notices[notices.length - 1] === "Couldn't read your editor, so the tutor has not seen this code.", `notices: ${JSON.stringify(notices)}`);
    await page.eval('window.__noEditor = false');
  });

  await scenario('with no editor to read, the message goes without a snapshot', async () => {
    await page.eval(`(() => {
      window.__posts.length = 0;
      window.__noEditor = true;
      const t = window.__q('textarea');
      t.value = 'no editor here';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor(`window.__posts.length === 1`, { what: 'the message POST' });
    const body = await page.eval('window.__posts[0]');
    check(body.text === 'no editor here' && !('snapshot' in body), JSON.stringify(body));
    await page.waitFor(`!window.__q('.hint').hidden`, { what: 'the error' });
    const hint = await page.eval(`window.__q('.hint').textContent`);
    check(hint === "Couldn't read your editor, so the tutor has not seen this code.", `hint: ${hint}`);
    await page.eval('window.__noEditor = false');
  });

  await scenario('code past the cap: the message goes without the snapshot (never a cut copy) and a note says so', async () => {
    await page.eval(`(() => {
      window.__posts.length = 0;
      window.__savedEditorCode = window.__editorCode;
      window.__editorCode = 'x = 1\\n'.repeat(20000);
      const t = window.__q('textarea');
      t.value = 'huge file';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor(`window.__posts.length === 1`, { what: 'the message POST' });
    const body = await page.eval('window.__posts[0]');
    check(body.text === 'huge file' && !('snapshot' in body), `body keys: ${Object.keys(body)}`);
    await page.waitFor(`!window.__q('.hint').hidden`, { what: 'the note' });
    const hint = await page.eval(`window.__q('.hint').textContent`);
    check(hint === 'Your code is too long to send with a message, so the tutor has not seen this code.', `hint: ${hint}`);
    check((await page.eval(`window.__q('textarea').value`)) === '', 'the message was not cleared after the send');
    await page.eval(`(() => { window.__editorCode = window.__savedEditorCode; const t = window.__q('textarea'); t.value = 'a'; t.dispatchEvent(new Event('input', { bubbles: true })); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check(await page.eval(`window.__q('.hint').hidden`), 'typing did not clear the note');
  });

  await scenario('a Run shows no chip, and a sent Submit\'s chip carries no note', async () => {
    const before = await page.eval(`window.__qa('.chip').length`);
    await page.eval(`window.__ev({ type: 'capture', problemSlug: 'two-sum', problemTitle: 'Two Sum', trigger: 'run', attemptSeq: 7, note: 'Kept for your next message' })`);
    await settle();
    check((await page.eval(`window.__qa('.chip').length`)) === before, 'a Run (from an older companion) rendered a chip');
    await page.eval(`window.__ev({ type: 'capture', problemSlug: 'two-sum', problemTitle: 'Two Sum', trigger: 'submit', attemptSeq: 8, note: 'Kept for your next message' })`);
    await settle();
    const m = await page.eval(`(() => {
      const chip = window.__qa('.chip').pop();
      return { text: chip.textContent, notes: chip.querySelectorAll('.chip-note').length, height: chip.getBoundingClientRect().height };
    })()`);
    check(/Submit/.test(m.text) && /Attempt 8/.test(m.text), `chip text: ${m.text}`);
    check(m.notes === 0 && !/Kept for your next message/.test(m.text), JSON.stringify(m));
    check(m.height === 24, `the chip stays one line: ${m.height}`);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await settle();
    await page.screenshot(path.join(SHOTS, '04-submit-chip.png'), { width: 1100, height: 760 });
  });

  await scenario('a 413 says the message is too long, and typing clears the hint', async () => {
    const max = await page.eval(`window.__q('textarea').maxLength`);
    check(max === -1, `maxlength silently truncates pasted text: ${max}`);
    await page.eval(`(() => {
      window.__postStatus = 413;
      const t = window.__q('textarea');
      t.value = 'long one';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor(`!window.__q('.hint').hidden`, { what: 'the hint' });
    const hint = await page.eval(`window.__q('.hint').textContent`);
    check(hint === 'That message is too long (8000 characters at most).', `hint: ${hint}`);
    await page.eval(`(() => { window.__postStatus = 202; const t = window.__q('textarea'); t.value += '!'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check(await page.eval(`window.__q('.hint').hidden`), 'typing did not clear the hint');
  });

  await scenario('pasting more than 8000 characters preserves the text and disables Send', async () => {
    const pasted = 'p'.repeat(8101);
    await page.eval(`(() => { const t = window.__q('textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await page.send('Browser.grantPermissions', {
      origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    // The clipboard refuses a page without focus ("Document is not focused"),
    // which another scenario's screenshot or a slow start can leave behind.
    await page.send('Page.bringToFront');
    await page.eval(`(() => { window.focus(); window.__q('textarea').focus(); })()`);
    await page.eval(`navigator.clipboard.writeText(${JSON.stringify(pasted)})`);
    await page.eval(`window.__q('textarea').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await settle();
    const m = await page.eval(`({ length: window.__q('textarea').value.length,
      disabled: window.__q('button[aria-label="Send"]').disabled,
      counter: window.__q('.counter')?.textContent || '',
      visible: !window.__q('.counter').hidden, over: window.__q('.counter').classList.contains('over') })`);
    check(m.length === 8101 && m.disabled && m.visible && m.over && /8101 \/ 8000/.test(m.counter), JSON.stringify(m));
    await page.eval(`(() => { const t = window.__q('textarea'); t.value = t.value.slice(0, 6400); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const under = await page.eval(`({ disabled: window.__q('button[aria-label="Send"]').disabled,
      counter: window.__q('.counter')?.textContent || '', visible: !window.__q('.counter').hidden })`);
    check(!under.disabled && under.visible && /6400 \/ 8000/.test(under.counter), JSON.stringify(under));
    await page.eval(`(() => { const t = window.__q('textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  });

  await scenario('a relay restart: the reconnect names the epoch, a pending reply stops typing, the new run shows', async () => {
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'stuck', problemSlug: 'two-sum' })`);
    await settle();
    check(await page.eval(`window.__qa('.dots').length === 1`), 'the pending turn shows no typing indicator');
    const urlsBefore = await page.eval('window.__eventsUrls.length');
    await page.eval('window.__dropStream()');
    await page.waitFor(`window.__q('.status span').textContent === 'Offline'`, { what: 'the panel to notice the relay is gone' });
    const offline = await page.eval(`({ state: window.__q('.status').dataset.state, color: getComputedStyle(window.__q('.status .light')).backgroundColor })`);
    check(offline.state === 'bad' && offline.color === 'rgb(239, 71, 67)', `relay unreachable light: ${JSON.stringify(offline)}`);
    await page.waitFor(`window.__eventsUrls.length > ${urlsBefore} && window.__streamOpen()`, { timeout: 5000, what: 'the reconnect' });
    const url = await page.eval('window.__eventsUrls.at(-1)');
    check(/[?&]epoch=e1(&|$)/.test(url) && /after=\d+/.test(url) && !/after=0/.test(url), `reconnect URL: ${url}`);
    // The new run: numbering starts over, replay first, status last.
    await page.eval(`(() => { window.__epoch = 'e2'; window.__seq = 0; })()`);
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'two-sum', text: 'after the restart' })`);
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e2' })`);
    await settle();
    const m = await page.eval(`({
      dots: window.__qa('.dots').length,
      note: window.__qa('.tutor .note').map((n) => n.textContent),
      notices: window.__qa('.notice').map((n) => n.textContent),
      lastUser: window.__qa('.user').at(-1).textContent,
      status: window.__q('.status span').textContent,
    })`);
    check(m.dots === 0, 'the interrupted turn still shows the typing indicator');
    check(m.note.length === 1, `interruption note: ${JSON.stringify(m.note)}`);
    check(m.notices.includes('Session restarted'), `notices: ${JSON.stringify(m.notices)}`);
    check(m.lastUser === 'after the restart', `the new run's first event was dropped: ${m.lastUser}`);
    check(m.status === 'Connected', m.status);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await settle();
    await page.screenshot(path.join(SHOTS, '04-restart.png'), { width: 1100, height: 760 });
  });

  await scenario('a cut-off reply keeps partial text and points panel users to Settings', async () => {
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'cutoff-panel', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'cutoff-panel', text: 'The first part of my answer.' })`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'cutoff-panel', problemSlug: 'two-sum',
      error: 'local backend reply was cut off before finishing; raise COMPANION_LOCAL_NUM_CTX' })`);
    await settle();
    const m = await page.eval(`(() => { const t = window.__qa('.tutor').at(-1); return { text: t.textContent, error: t.querySelector('.err')?.textContent || '' }; })()`);
    check(m.text.includes('The first part of my answer.'), JSON.stringify(m));
    check(m.error.includes('The reply was cut off because the model ran out of room'), JSON.stringify(m));
    check(m.error.includes('Context window (tokens)') && !m.error.includes('COMPANION_LOCAL_NUM_CTX'), JSON.stringify(m));
  });

  await scenario('the companion exiting mid-reply: a cut reply and a not-yet-started one stop typing and say so', async () => {
    const NOTE = 'The tutor stopped before this reply finished.';
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'cut', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'cut', text: 'Half of a' })`);
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'never', problemSlug: 'two-sum' })`);
    await settle();
    check(await page.eval(`window.__qa('.dots').length === 1`), 'the not-yet-started reply shows no typing indicator');
    const notesBefore = await page.eval(`window.__qa('.tutor .note').length`);
    // What the relay sends when the last companion leaves: a turn-end marked
    // interrupted for each open reply, then the offline status.
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'cut', problemSlug: 'two-sum', text: 'Half of a', interrupted: true })`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'never', problemSlug: 'two-sum', text: '', interrupted: true })`);
    await page.eval(`window.__event({ type: 'status', companionOnline: false, epoch: 'e2' })`);
    await settle();
    const m = await page.eval(`({
      dots: window.__qa('.dots').length,
      notes: window.__qa('.tutor .note').map((n) => n.textContent),
      cut: window.__qa('.tutor').at(-2).textContent,
      status: window.__q('.status span').textContent,
    })`);
    check(m.dots === 0, 'a reply cut off by the companion exiting still shows the typing indicator');
    check(m.notes.length === notesBefore + 2 && m.notes.slice(-2).every((n) => n === NOTE), `notes: ${JSON.stringify(m.notes)}`);
    check(m.cut === `Half of a${NOTE}`, `cut reply: ${m.cut}`);
    check(m.status === 'Tutor offline', m.status);
    // An older relay sends no turn-end: the offline status alone does it.
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e2' })`);
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'old-relay', problemSlug: 'two-sum' })`);
    await settle();
    await page.eval(`window.__event({ type: 'status', companionOnline: false, epoch: 'e2' })`);
    await settle();
    check(await page.eval(`window.__qa('.dots').length === 0 && window.__qa('.tutor').at(-1).textContent === ${JSON.stringify(NOTE)}`), 'offline status did not interrupt the pending reply');
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await settle();
    await page.screenshot(path.join(SHOTS, '05-companion-exit.png'), { width: 1100, height: 760 });
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e2' })`);
    await settle();
  });

  const NOTE = 'The tutor stopped before this reply finished.';
  const replyState = (id) => `(() => {
    const node = window.__qa('.tutor').find((t) => t.__turn === ${JSON.stringify(id)});
    return node ? { text: node.textContent, dots: node.querySelectorAll('.dots').length, note: node.querySelectorAll('.note').length } : null;
  })()`;
  // Tags the newest tutor node so replyState can find it after more items arrive.
  const tagLastReply = (id) => page.eval(`window.__qa('.tutor').at(-1).__turn = ${JSON.stringify(id)}`);

  await scenario('the companion exiting takes the relay it started with it: open replies stop typing and say so', async () => {
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'own-cut', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'own-cut', text: 'Partly there' })`);
    await settle();
    await tagLastReply('own-cut');
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'own-none', problemSlug: 'two-sum' })`);
    await settle();
    await tagLastReply('own-none');
    check(JSON.stringify(await page.eval(replyState('own-none'))) === JSON.stringify({ text: '', dots: 1, note: 0 }), 'setup: the reply with no text yet shows no typing indicator');
    // In the default setup the companion spawned the relay and kills it on
    // exit, so no interrupted turn-end and no offline status ever arrive:
    // the stream just ends and nothing listens on the port any more.
    const urlsBefore = await page.eval('window.__eventsUrls.length');
    await page.eval('(() => { window.__relayDown = true; window.__dropStream(); })()');
    await page.waitFor(`window.__q('.status span').textContent === 'Offline'`, { what: 'the panel to notice the relay is gone' });
    // ...and stays gone through a failed reconnect.
    await page.waitFor(`window.__eventsUrls.length > ${urlsBefore}`, { timeout: 5000, what: 'a reconnect attempt' });
    await settle();
    const cut = await page.eval(replyState('own-cut'));
    const none = await page.eval(replyState('own-none'));
    check(cut && cut.dots === 0 && cut.note === 1 && cut.text === `Partly there${NOTE}`, `cut reply: ${JSON.stringify(cut)}`);
    check(none && none.dots === 0 && none.note === 1 && none.text === NOTE, `reply with no text yet: ${JSON.stringify(none)}`);
    check(await page.eval(`window.__qa('.dots').length === 0`), 'a typing indicator is still showing while Offline');
    check(await page.eval(`window.__q('.status span').textContent === 'Offline'`), 'the header left Offline');
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await settle();
    await page.screenshot(path.join(SHOTS, '06-companion-took-relay.png'), { width: 1100, height: 760 });
  });

  await scenario('the relay killed under a live companion: the open reply stops typing, and comes back if the companion keeps streaming', async () => {
    // A relay started again: a new run.
    await page.eval(`(() => { window.__epoch = 'e3'; window.__seq = 0; window.__relayDown = false; })()`);
    await page.waitFor('window.__streamOpen()', { timeout: 15000, what: 'the reconnect to the new relay' });
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e3' })`);
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'killed', problemSlug: 'two-sum' })`);
    await settle();
    await tagLastReply('killed');
    check(JSON.stringify(await page.eval(replyState('killed'))) === JSON.stringify({ text: '', dots: 1, note: 0 }), 'setup: no typing indicator');
    await page.eval('(() => { window.__relayDown = true; window.__dropStream(); })()');
    await page.waitFor(`window.__q('.status span').textContent === 'Offline'`, { what: 'the panel to notice the relay is gone' });
    await settle();
    const gone = await page.eval(replyState('killed'));
    check(gone && gone.dots === 0 && gone.note === 1, `while the relay is down: ${JSON.stringify(gone)}`);
    // The relay comes back (a new run) and the companion, which never left,
    // keeps streaming the same reply into it: the chunk revives it.
    await page.eval(`(() => { window.__epoch = 'e4'; window.__seq = 0; window.__relayDown = false; })()`);
    await page.waitFor('window.__streamOpen()', { timeout: 15000, what: 'the reconnect to the restarted relay' });
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e4' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'killed', text: 'Back again' })`);
    await settle();
    const back = await page.eval(replyState('killed'));
    check(back && back.note === 0 && back.text === 'Back again', `after the companion kept streaming: ${JSON.stringify(back)}`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'killed', problemSlug: 'two-sum', text: 'Back again, done.' })`);
    await settle();
    const done = await page.eval(replyState('killed'));
    check(done && done.dots === 0 && done.note === 0 && done.text === 'Back again, done.', `finished reply: ${JSON.stringify(done)}`);
  });

  await scenario('a stream blip with the relay and companion alive leaves no falsely interrupted reply', async () => {
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'blip', problemSlug: 'two-sum' })`);
    await settle();
    await tagLastReply('blip');
    // Ended as interrupted by the relay itself: must stay interrupted.
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'really-cut', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'really-cut', problemSlug: 'two-sum', text: 'Cut', interrupted: true })`);
    await settle();
    await tagLastReply('really-cut');
    const urlsBefore = await page.eval('window.__eventsUrls.length');
    await page.eval('window.__dropStream()');
    await page.waitFor(`window.__eventsUrls.length > ${urlsBefore} && window.__streamOpen()`, { timeout: 15000, what: 'the reconnect' });
    // Same relay run: nothing new to replay (the model is still thinking),
    // then the status, which lists the replies still open.
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e4', openTurns: ['blip'] })`);
    await settle();
    const blip = await page.eval(replyState('blip'));
    check(JSON.stringify(blip) === JSON.stringify({ text: '', dots: 1, note: 0 }), `the still-open reply after the blip: ${JSON.stringify(blip)}`);
    const cut = await page.eval(replyState('really-cut'));
    check(cut && cut.note === 1 && cut.dots === 0, `the reply the relay ended as interrupted: ${JSON.stringify(cut)}`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'blip', problemSlug: 'two-sum', text: 'All good.' })`);
    await settle();
    check(JSON.stringify(await page.eval(replyState('blip'))) === JSON.stringify({ text: 'All good.', dots: 0, note: 0 }), 'the blip reply did not finish normally');
  });

  await scenario('switching problems shows the other transcript, and coming back reuses the old nodes', async () => {
    await page.eval(`window.__q('.tutor p').__marker = 'kept'`);
    await page.eval(`history.pushState(null, '', '/problems/valid-parentheses/description/')`);
    // ensureMounted notices the new slug within its 2 s interval and closes the tab.
    await page.waitFor(`!document.getElementById('lc-tutor-panel-host').hasAttribute('data-active')`, { timeout: 5000, what: 'the panel to close on navigation' });
    await page.eval('window.__openTutor()');
    await settle();
    const other = await page.eval(`window.__qa('.user').map((u) => u.textContent)`);
    check(JSON.stringify(other) === JSON.stringify(['elsewhere']), `other problem: ${JSON.stringify(other)}`);
    await page.eval(`history.pushState(null, '', '/problems/two-sum/description/')`);
    await page.waitFor(`!document.getElementById('lc-tutor-panel-host').hasAttribute('data-active')`, { timeout: 5000, what: 'the panel to close again' });
    await page.eval('window.__openTutor()');
    await settle();
    check(await page.eval(`window.__q('.tutor p').__marker === 'kept'`), 'coming back rebuilt the transcript');
  });

  await scenario('activating the tab clears a stale send hint', async () => {
    await page.eval(`(() => { const h = window.__q('.hint'); h.textContent = 'old'; h.hidden = false; })()`);
    await page.eval(`document.querySelectorAll('.flexlayout__tab_button')[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    await page.eval('window.__openTutor()');
    check(await page.eval(`window.__q('.hint').hidden`), 'the hint survived re-activation');
  });

  await scenario('after a send, a deliberate scroll up stops the feed following the reply at once', async () => {
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'long1', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'long1', problemSlug: 'two-sum', text: Array.from({ length: 40 }, (_, i) => 'Paragraph ' + i + ' of an earlier reply.').join('\\n\\n') })`);
    await settle();
    const fromBottom = `(() => { const s = window.__q('.scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight; })()`;
    const sendOne = async (text, turnId) => {
      const before = await page.eval('window.__posts.length');
      await page.eval(`(() => {
        const t = window.__q('textarea');
        t.value = ${JSON.stringify(text)};
        t.dispatchEvent(new Event('input', { bubbles: true }));
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
      await page.waitFor(`window.__posts.length > ${before} && window.__q('textarea').readOnly === false`, { what: 'the send' });
      await page.eval(`window.__ev({ type: 'user', problemSlug: 'two-sum', text: ${JSON.stringify(text)} })`);
      await page.eval(`window.__ev({ type: 'turn-start', turnId: '${turnId}', problemSlug: 'two-sum' })`);
      await settle();
      check((await page.eval(fromBottom)) < 2, 'the send did not bring the feed to the bottom');
    };
    const grow = async (turnId) => {
      await page.eval(`window.__ev({ type: 'chunk', turnId: '${turnId}', text: Array.from({ length: 12 }, (_, i) => 'Streamed line ' + i + '.').join('\\n\\n') + '\\n\\n' })`);
      await settle();
    };

    // A real mouse wheel notch up, then more of the reply streams in.
    await sendOne('follow me', 'follow1');
    const rect = await page.eval(`(() => { const r = window.__q('.scroll').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: -60 });
    await settle();
    const wheeled = await page.eval(`window.__q('.scroll').scrollTop`);
    await grow('follow1');
    check((await page.eval(`window.__q('.scroll').scrollTop`)) === wheeled, 'a wheel scroll up was undone by the stream');
    check((await page.eval(fromBottom)) > 80, 'the feed kept following after a wheel scroll up');
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'follow1', problemSlug: 'two-sum', text: 'done' })`);

    // A scrollbar drag or a keyboard scroll (the scroll position moved by
    // something other than the panel itself).
    await sendOne('and again', 'follow2');
    await page.eval(`(() => { const s = window.__q('.scroll'); s.scrollTop = s.scrollTop - 300; })()`);
    await settle();
    const dragged = await page.eval(`window.__q('.scroll').scrollTop`);
    await grow('follow2');
    check((await page.eval(`window.__q('.scroll').scrollTop`)) === dragged, 'a scrollbar scroll up was undone by the stream');

    // Back at the bottom, following resumes.
    await page.eval(`(() => { const s = window.__q('.scroll'); s.scrollTop = s.scrollHeight; })()`);
    await settle();
    await grow('follow2');
    check((await page.eval(fromBottom)) < 2, 'following did not resume at the bottom');
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'follow2', problemSlug: 'two-sum', text: 'done' })`);
    await settle();
  });

  // ---- diagrams, wrapping and live resizing -----------------------------
  //
  // A splitter drag resizes the tabset and the native pane under it together
  // (as flexlayout does); the panel must follow both live. Sizes below are
  // the pane's own (the tabset is 36px taller, for its tab strip).
  const resizePane = async (w, h) => {
    await page.eval(`(() => {
      const ts = document.querySelector('.flexlayout__tabset');
      ts.style.width = '${w}px';
      ts.style.height = '${h + 36}px';
      const desc = document.getElementById('pane-desc');
      desc.style.width = '${w}px';
      desc.style.height = '${h}px';
      const code = document.getElementById('pane-code');
      code.style.left = '${w + 16}px';
    })()`);
    await settle();
  };
  await scenario('the panel fits 240, 292 and 400 px panes despite LeetCode minimum width', async () => {
    for (const width of [240, 292, 400]) {
      await resizePane(width, 420);
      const m = await page.eval(`(() => {
        const host = document.getElementById('lc-tutor-panel-host');
        const originalParent = host.parentElement;
        const probe = document.createElement('div');
        probe.className = 'flexlayout__tab';
        probe.style.cssText = 'position:absolute;left:0;top:0;width:${width}px;height:420px;padding:0';
        document.body.appendChild(probe);
        probe.appendChild(host);
        const wrap = window.__q('.wrap');
        const pane = document.getElementById('pane-desc');
        const result = { host: host.getBoundingClientRect().width, wrap: wrap.getBoundingClientRect().width,
          pane: pane.getBoundingClientRect().width, hostMin: getComputedStyle(host).minWidth,
          wrapMin: getComputedStyle(wrap).minWidth };
        originalParent.appendChild(host);
        probe.remove();
        return result;
      })()`);
      check(m.host <= width + 1 && m.wrap <= width + 1 && m.pane === width, `${width}px: ${JSON.stringify(m)}`);
    }
  });
  const DIAGRAM_SLUG = 'diagram-lab';
  const TREE = ['        1', '      ┌─┴─┐', '      2   3', '     ┌┴┐  └┐', '     4 5   6'].join('\n');
  const GRAPH = ['A ──▶ B ──▶ C', '│     │     ▲', '▼     ▼     │', 'D ──▶ E ────┘'].join('\n');
  const TRACE = [
    'step  nums = [2, 7, 11, 15]   target = 9',
    '1     l=0 ^             ^ r=3   sum 17 > 9, r--',
    '2     l=0 ^         ^ r=2       sum 13 > 9, r--',
    '3     l=0 ^  ^ r=1              sum 9, found',
    '\ttab-indented note (four columns)',
  ].join('\n');
  const WIDE = '|' + '-'.repeat(158) + '|';
  const URL = 'https://leetcode.com/problems/two-sum/solutions/' + 'a1b2c3d4'.repeat(25) + '/';
  const IDENT = 'maximumSubarraySumAfterRemovingAtMostOneElementWithPrefixAndSuffixKadaneArrays'.repeat(2);
  const diagramMd = [
    'Here is the tree:',
    '',
    '```',
    TREE,
    '```',
    '',
    'And the graph, as a `text` block:',
    '',
    '```text',
    GRAPH,
    '```',
    '',
    '1. Walk the two pointers:',
    '   ```',
    TRACE.split('\n').map((l) => '   ' + l).join('\n'),
    '   ```   ',
    '2. Then compare approaches:',
    '',
    '| Approach | Time | Space | Idea | Notes |',
    '| --- | --- | --- | --- | --- |',
    '| Brute force | O(n^2) | O(1) | try every pair | too slow for 10^4 |',
    '| Hash map | O(n) | O(n) | complement lookup | one pass |',
    '| Two pointers | O(n log n) | O(1) | sort, then squeeze | loses indices |',
    '',
    '```',
    WIDE,
    '```',
    '',
    `See ${URL} for more.`,
    '',
    `- The helper \`${IDENT}\` is long.`,
    `- So is ${IDENT} written plainly.`,
    '',
    `## ${IDENT}`,
  ].join('\n');
  const SIZES = [];
  for (const w of [240, 320, 480, 640, 1000]) for (const h of [200, 420, 700]) SIZES.push([w, h]);

  // Every metric the wrapping rules promise, for the newest reply.
  const layoutMetrics = `(() => {
    const host = document.getElementById('lc-tutor-panel-host').getBoundingClientRect();
    const desc = document.getElementById('pane-desc').getBoundingClientRect();
    const scroll = window.__q('.scroll');
    const ss = getComputedStyle(scroll);
    const sr = scroll.getBoundingClientRect();
    const contentLeft = sr.left + parseFloat(ss.paddingLeft);
    const contentRight = sr.left + scroll.clientWidth - parseFloat(ss.paddingRight);
    const tutor = window.__qa('.tutor').at(-1);
    const outside = [];
    for (const el of tutor.querySelectorAll('*')) {
      if (el.closest('pre') && el.tagName !== 'PRE') continue;
      if (el.closest('.table-wrap') && !el.classList.contains('table-wrap')) continue;
      const r = el.getBoundingClientRect();
      if (r.right > contentRight + 0.5 || r.left < contentLeft - 0.5) outside.push(el.tagName + '.' + el.className + ' ' + r.left + '..' + r.right);
      for (const cr of el.getClientRects()) if (cr.right > contentRight + 0.5) outside.push('line of ' + el.tagName + ' ' + cr.right);
    }
    const textOverflow = [...tutor.querySelectorAll('p, li, td, th')].filter((el) => el.scrollWidth > el.clientWidth + 0.5).map((el) => el.tagName);
    const pres = [...tutor.querySelectorAll('pre')].map((pre) => {
      const code = pre.querySelector('code');
      const cs = getComputedStyle(code);
      const lines = code.textContent.split('\\n').length;
      const lh = parseFloat(cs.lineHeight);
      const before = pre.scrollLeft;
      pre.scrollLeft = 40;
      const moved = pre.scrollLeft;
      pre.scrollLeft = before;
      return {
        cls: pre.className, text: code.textContent, ws: cs.whiteSpace, ox: getComputedStyle(pre).overflowX,
        lh, fs: cs.fontSize, lig: cs.fontVariantLigatures, tab: cs.tabSize, wrapped: Math.abs(code.getBoundingClientRect().height - lines * lh) > 0.5,
        scrollable: pre.scrollWidth > pre.clientWidth, moved, right: pre.getBoundingClientRect().right,
      };
    });
    const tw = tutor.querySelector('.table-wrap');
    const table = tw.querySelector('table');
    const cell = tw.querySelector('td');
    const url = [...tutor.querySelectorAll('p')].find((p) => p.textContent.startsWith('See '));
    const ident = tutor.querySelector('li code');
    const head = window.__q('.head');
    const hr = head.getBoundingClientRect();
    const light = window.__q('.status .light').getBoundingClientRect();
    const gear = window.__q('button.gear').getBoundingClientRect();
    const ta = window.__q('textarea');
    const send = window.__q('.box button').getBoundingClientRect();
    const box = window.__q('.box').getBoundingClientRect();
    const composer = window.__q('.composer').getBoundingClientRect();
    return {
      host: [host.left, host.top, host.width, host.height], desc: [desc.left, desc.top, desc.width, desc.height],
      descInert: document.getElementById('pane-desc').inert,
      feedScrollsSideways: scroll.scrollWidth > scroll.clientWidth, ox: ss.overflowX,
      outside, textOverflow, pres,
      table: { wider: table.offsetWidth > tw.clientWidth, scrollable: tw.scrollWidth > tw.clientWidth, ox: getComputedStyle(tw).overflowX, wrap: getComputedStyle(cell).overflowWrap, right: tw.getBoundingClientRect().right },
      urlLines: url.getClientRects().length && Math.round(url.getBoundingClientRect().height / 21), urlWrap: getComputedStyle(url).overflowWrap,
      identRects: ident.getClientRects().length, contentRight, contentLeft,
      head: { h: hr.height, sideways: head.scrollWidth > head.clientWidth, lightW: light.width, lightIn: light.left >= hr.left && light.right <= hr.right, gearW: gear.width, gearIn: gear.left >= hr.left && gear.right <= hr.right + 4.5, overlap: light.right > gear.left },
      composer: { taW: ta.clientWidth, sendIn: send.right <= box.right + 0.5 && send.width === 28, bottom: composer.bottom, hostBottom: host.bottom },
      scrollH: scroll.clientHeight,
    };
  })()`;

  await scenario('diagrams, a wide table, a long URL and identifier lay out right from 240 to 1000 px wide and 200 to 700 px tall', async () => {
    await page.eval(`history.pushState(null, '', '/problems/${DIAGRAM_SLUG}/description/')`);
    await page.waitFor(`!document.getElementById('lc-tutor-panel-host').hasAttribute('data-active')`, { timeout: 5000, what: 'the panel to close on navigation' });
    await page.eval('window.__openTutor()');
    await page.eval(`window.__event({ type: 'config', provider: 'openai', label: 'OpenAI API key', model: 'gpt-5.5-a-long-fine-tuned-tutor-model-name', epoch: 'e1' })`);
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'dg1', problemSlug: '${DIAGRAM_SLUG}' })`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'dg1', problemSlug: '${DIAGRAM_SLUG}', text: ${JSON.stringify(diagramMd)} })`);
    await settle();
    const expected = [TREE, GRAPH, TRACE, WIDE];
    for (const [w, h] of SIZES) {
      await resizePane(w, h);
      const m = await page.eval(layoutMetrics);
      const at = `at ${w}x${h}`;
      check(m.host.every((v, i) => Math.abs(v - m.desc[i]) <= 0.5), `${at} the panel left the Description pane rect: ${m.host} vs ${m.desc}`);
      check(m.descInert, `${at} the Description pane is no longer inert`);
      check(!m.feedScrollsSideways && m.ox === 'hidden', `${at} the feed scrolls sideways (${m.ox})`);
      check(m.outside.length === 0, `${at} content runs past the feed: ${m.outside.slice(0, 4).join('; ')}`);
      check(m.textOverflow.length === 0, `${at} text overflows its box: ${m.textOverflow}`);
      check(m.pres.length === 4, `${at} code blocks: ${m.pres.length}`);
      for (const [i, pre] of m.pres.entries()) {
        check(pre.text === expected[i], `${at} block ${i} text changed: ${JSON.stringify(pre.text)}`);
        check(pre.ws === 'pre' && pre.ox === 'auto' && !pre.wrapped, `${at} block ${i} wraps: ${JSON.stringify(pre)}`);
        check(pre.cls === 'plain' && pre.lh === 14 && pre.fs === '12px', `${at} block ${i} line height: ${JSON.stringify(pre)}`);
        check(pre.lig === 'none' && pre.tab === '4', `${at} block ${i} ligatures/tabs: ${pre.lig} ${pre.tab}`);
        check(pre.right <= m.contentRight + 0.5, `${at} block ${i} sticks out: ${pre.right} > ${m.contentRight}`);
        check(pre.scrollable === (pre.moved > 0), `${at} block ${i} scrollable but does not scroll: ${JSON.stringify(pre)}`);
      }
      // The 158-dash rule never fits; the 56-column diagrams fit a wide pane
      // and scroll in a narrow one.
      check(m.pres[3].scrollable, `${at} the wide block does not scroll`);
      if (w >= 640) check(m.pres.slice(0, 3).every((p) => !p.scrollable), `${at} a diagram within 56 columns scrolls in a wide pane`);
      if (w <= 320) check(m.pres[2].scrollable, `${at} the trace does not scroll in a narrow pane`);
      check(m.table.ox === 'auto' && m.table.wrap === 'break-word' && m.table.right <= m.contentRight + 0.5, `${at} table wrapper: ${JSON.stringify(m.table)}`);
      check(m.table.wider === m.table.scrollable, `${at} a wide table does not scroll: ${JSON.stringify(m.table)}`);
      if (w <= 320) check(m.table.scrollable, `${at} the five-column table should scroll in a narrow pane`);
      if (w >= 1000) check(!m.table.scrollable, `${at} the table scrolls in a wide pane`);
      check(m.urlWrap === 'anywhere' && m.urlLines >= (w <= 480 ? 3 : 2), `${at} the long URL did not wrap: ${m.urlLines} lines`);
      check(m.identRects >= 2, `${at} the long inline identifier did not break: ${m.identRects}`);
      check(m.head.h === 32 && !m.head.sideways && m.head.lightW === 8 && m.head.lightIn && m.head.gearW === 24 && m.head.gearIn && !m.head.overlap, `${at} header: ${JSON.stringify(m.head)}`);
      check(m.composer.taW >= 100 && m.composer.sendIn && Math.abs(m.composer.bottom - m.composer.hostBottom) <= 0.5, `${at} composer: ${JSON.stringify(m.composer)}`);
      check(m.scrollH >= 60, `${at} the feed is squeezed to ${m.scrollH}px`);
      if (w === 240 && h === 420) await page.screenshot(path.join(SHOTS, '10-diagrams-240.png'), { width: 1100, height: 760 });
      if (w === 1000 && h === 700) await page.screenshot(path.join(SHOTS, '11-diagrams-1000.png'), { width: 1100, height: 760 });
    }
  });

  await scenario('diagram blocks use a monospace face that has the box-drawing glyphs', async () => {
    await resizePane(480, 600);
    await page.send('DOM.enable');
    await page.send('CSS.enable');
    await page.send('DOM.getDocument', { depth: -1, pierce: true });
    const fontsOf = async (expr) => {
      const { result } = await page.send('Runtime.evaluate', { expression: expr });
      const { nodeId } = await page.send('DOM.requestNode', { objectId: result.objectId });
      const { fonts } = await page.send('CSS.getPlatformFontsForNode', { nodeId });
      return fonts;
    };
    const fonts = await fontsOf(`window.__qa('.tutor').at(-1).querySelector('pre code')`);
    check(fonts.length === 1, `the tree diagram mixes fonts (a glyph fell back): ${JSON.stringify(fonts)}`);
    const m = await page.eval(`(() => {
      const code = window.__qa('.tutor').at(-1).querySelector('pre code');
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = getComputedStyle(code).fontSize + ' ' + getComputedStyle(code).fontFamily;
      const bar = ctx.measureText('│');
      return { family: getComputedStyle(code).fontFamily, i: ctx.measureText('iiii').width, M: ctx.measureText('MMMM').width, box: ctx.measureText('┌─┴─┐').width / 5, bar: bar.fontBoundingBoxAscent + bar.fontBoundingBoxDescent };
    })()`);
    check(Math.abs(m.i - m.M) < 0.01 && Math.abs(m.box - m.M / 4) < 0.01, `not monospace (${fonts[0].familyName}): ${JSON.stringify(m)}`);
    // The vertical bar spans the whole font box, so a 14px line (the box at
    // 12px is about 14px) leaves no visible gap between rows.
    check(m.bar >= 13.5 && m.bar <= 14.5, `line height 14px vs the ${fonts[0].familyName} box: ${m.bar}`);
    check(/^Menlo, Menlo-fallback, .*monospace$/.test(m.family), `font stack: ${m.family}`);
  });

  await scenario('the header keeps the light and the gear at any width, cutting the label first', async () => {
    await resizePane(240, 420);
    const at240 = await page.eval(`(() => {
      const p = window.__q('.provider');
      const t = window.__q('.status span');
      return { providerClipped: p.scrollWidth > p.clientWidth, providerOverflow: getComputedStyle(p).textOverflow, statusClipped: t.scrollWidth > t.clientWidth };
    })()`);
    check(at240.providerClipped && at240.providerOverflow === 'ellipsis' && !at240.statusClipped, `at 240: ${JSON.stringify(at240)}`);
    // Narrower than anyone should drag it: the status text gives way too, the
    // light and gear never do.
    await resizePane(110, 300);
    const tiny = await page.eval(`(() => {
      const head = window.__q('.head').getBoundingClientRect();
      const t = window.__q('.status span');
      const light = window.__q('.status .light').getBoundingClientRect();
      const gear = window.__q('button.gear').getBoundingClientRect();
      return { statusClipped: t.scrollWidth > t.clientWidth, overflow: getComputedStyle(t).textOverflow, lightW: light.width, gearW: gear.width, lightLeft: light.left - head.left, gearRight: head.right - gear.right, overlap: light.right > gear.left, h: head.height };
    })()`);
    check(tiny.statusClipped && tiny.overflow === 'ellipsis', `status text at 110: ${JSON.stringify(tiny)}`);
    check(tiny.lightW === 8 && tiny.gearW === 24 && !tiny.overlap && tiny.lightLeft >= 12 && tiny.gearRight >= 8 && tiny.h === 32, `light or gear lost at 110: ${JSON.stringify(tiny)}`);
    await resizePane(480, 600);
    const back = await page.eval(`(() => { const t = window.__q('.status span'); return t.scrollWidth > t.clientWidth; })()`);
    check(!back, 'the status text stays cut after widening');
  });

  await scenario('the composer re-fits its text to the pane width and height, and the hint wraps', async () => {
    await resizePane(480, 700);
    const oneLine = await page.eval(`window.__q('textarea').getBoundingClientRect().height`);
    const typed = Array.from({ length: 12 }, (_, i) => 'line ' + i + ' of a long question about the two pointers').join(' ');
    await page.eval(`(() => { const t = window.__q('textarea'); t.value = ${JSON.stringify(typed)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle();
    const tall = await page.eval(`window.__q('textarea').getBoundingClientRect().height`);
    check(tall === 140, `a long question at 480x700 should take the 140px cap: ${tall}`);
    await resizePane(480, 200);
    const short = await page.eval(`(() => { const t = window.__q('textarea'); return { h: t.getBoundingClientRect().height, scroll: window.__q('.scroll').clientHeight }; })()`);
    check(short.h === 60 && short.scroll >= 60, `at 480x200 the composer should give way (30% of the pane): ${JSON.stringify(short)}`);
    await resizePane(1000, 700);
    const wide = await page.eval(`(() => { const t = window.__q('textarea'); return { h: t.getBoundingClientRect().height, sh: t.scrollHeight }; })()`);
    check(wide.h === Math.min(140, wide.sh) && wide.h < 140, `widening did not re-fit the composer: ${JSON.stringify(wide)}`);
    await page.eval(`(() => { const t = window.__q('textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await resizePane(240, 420);
    await page.eval(`(() => { const h = window.__q('.hint'); h.textContent = 'Your code is too long to send with a message, so the tutor has not seen this code.'; h.hidden = false; })()`);
    await settle();
    const hint = await page.eval(`(() => { const h = window.__q('.hint'); const c = window.__q('.composer'); const hr = h.getBoundingClientRect(); const cr = c.getBoundingClientRect(); return { sideways: h.scrollWidth > h.clientWidth, inside: hr.right <= cr.right && hr.bottom <= cr.bottom, lines: Math.round(hr.height / 16), empty: window.__q('textarea').getBoundingClientRect().height }; })()`);
    check(!hint.sideways && hint.inside && hint.lines >= 2, `hint at 240: ${JSON.stringify(hint)}`);
    check(hint.empty === oneLine && oneLine < 30, `an empty composer should be one line (${oneLine}px): ${hint.empty}`);
    await page.eval(`window.__q('.hint').hidden = true`);
  });

  await scenario('a streaming reply ending inside a fence shows an open code block that settles when the fence closes', async () => {
    await resizePane(320, 500);
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'dg2', problemSlug: '${DIAGRAM_SLUG}' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'dg2', text: 'Trace:\\n\\n\`\`\`\\ni=0  [2, 7]\\n     ^' })`);
    await settle();
    const open = await page.eval(`(() => {
      const t = window.__qa('.tutor').at(-1);
      const pre = t.querySelector('pre');
      return { kids: [...t.children].map((c) => c.tagName + (c.hasAttribute('data-open') ? '[open]' : '')), text: pre && pre.textContent, cls: pre && pre.className, ws: pre && getComputedStyle(pre.firstChild).whiteSpace };
    })()`);
    check(JSON.stringify(open.kids.filter((k) => k !== 'DIV')) === JSON.stringify(['P', 'PRE[open]']) && open.text === 'i=0  [2, 7]\n     ^' && open.cls === 'plain' && open.ws === 'pre', `mid-fence: ${JSON.stringify(open)}`);
    await page.screenshot(path.join(SHOTS, '12-open-fence-320.png'), { width: 1100, height: 760 });
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'dg2', text: '\\n\`\`\`\\n\\nSo **l** moves right.' })`);
    await settle();
    const closed = await page.eval(`(() => {
      const t = window.__qa('.tutor').at(-1);
      const pre = t.querySelector('pre');
      const last = [...t.children].filter((c) => c.tagName === 'P').at(-1);
      return { kids: [...t.children].map((c) => c.tagName + (c.hasAttribute('data-open') ? '[open]' : '')), text: pre.textContent, last: last.textContent, strong: last.querySelector('strong') && last.querySelector('strong').textContent, lastFont: getComputedStyle(last).fontFamily === getComputedStyle(t).fontFamily };
    })()`);
    check(JSON.stringify(closed.kids.filter((k) => k !== 'DIV')) === JSON.stringify(['P', 'PRE', 'P']) && closed.text === 'i=0  [2, 7]\n     ^', `closed: ${JSON.stringify(closed)}`);
    check(closed.last === 'So l moves right.' && closed.strong === 'l' && closed.lastFont, `the text after the fence: ${JSON.stringify(closed)}`);
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'dg2', problemSlug: '${DIAGRAM_SLUG}', text: 'Trace:\\n\\n\`\`\`\\ni=0  [2, 7]\\n     ^\\n\`\`\`\\n\\nSo **l** moves right.' })`);
    await settle();
  });

  await scenario('a live resize during a streaming reply keeps the feed at the bottom while following, and the text in place when scrolled up', async () => {
    await resizePane(640, 600);
    const fromBottom = `(() => { const s = window.__q('.scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight; })()`;
    const long = Array.from({ length: 30 }, (_, i) => 'Paragraph ' + i + ' explains the pointer movement in enough words that a narrow pane wraps it onto several lines.').join('\n\n');
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'dg3', problemSlug: '${DIAGRAM_SLUG}' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'dg3', text: ${JSON.stringify(long + '\n\n')} })`);
    await settle();
    let n = 0;
    const chunk = async () => {
      n += 1;
      await page.eval(`window.__ev({ type: 'chunk', turnId: 'dg3', text: 'Streamed ${n}.\\n\\n\`\`\`\\n[${n}, ${n + 1}]\\n ^\\n\`\`\`\\n\\n' })`);
      await settle();
    };
    check((await page.eval(fromBottom)) < 1, `the reply did not open at the bottom: ${await page.eval(fromBottom)}`);
    // Following: every resize, between chunks, leaves it at the very bottom.
    for (const [w, h] of [[300, 600], [300, 220], [1000, 220], [1000, 700], [240, 200], [640, 600]]) {
      await resizePane(w, h);
      check((await page.eval(fromBottom)) < 1, `following, a resize to ${w}x${h} left the feed off the bottom by ${await page.eval(fromBottom)}`);
      await chunk();
      check((await page.eval(fromBottom)) < 1, `following, a chunk after ${w}x${h} left the feed off the bottom`);
    }
    // Scrolled up: a real wheel scroll, then a paragraph near the top edge
    // must stay put through width and height changes and more chunks.
    const rect = await page.eval(`(() => { const r = window.__q('.scroll').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: -900 });
    await settle();
    // Line a paragraph's top up just under the edge (as reading would), with
    // a scrollbar-style scroll the panel did not cause.
    await page.eval(`(() => {
      const s = window.__q('.scroll');
      const top = s.getBoundingClientRect().top;
      const p = [...window.__qa('.tutor').at(-1).querySelectorAll('p')].find((el) => el.getBoundingClientRect().top > top + 40);
      s.scrollTop += p.getBoundingClientRect().top - top - 10;
      window.__anchor = p;
    })()`);
    await settle();
    const offset = `(() => window.__anchor.getBoundingClientRect().top - window.__q('.scroll').getBoundingClientRect().top)()`;
    const start = await page.eval(offset);
    check(Math.abs(start - 10) <= 1 && (await page.eval(fromBottom)) > 200, `could not scroll up: offset ${start}`);
    for (const [w, h] of [[320, 600], [320, 260], [1000, 260], [240, 700], [640, 600]]) {
      await resizePane(w, h);
      const now = await page.eval(offset);
      check(Math.abs(now - start) <= 1, `scrolled up, a resize to ${w}x${h} moved the text being read from ${start} to ${now}`);
      await chunk();
      check(Math.abs((await page.eval(offset)) - start) <= 1, `scrolled up, a chunk after ${w}x${h} moved the text being read`);
      check((await page.eval(fromBottom)) > 80, `scrolled up, the feed started following again at ${w}x${h}`);
    }
    await page.screenshot(path.join(SHOTS, '13-scrolled-up-640.png'), { width: 1100, height: 760 });
    // Back to the bottom: following resumes through the next resize.
    await page.eval(`(() => { const s = window.__q('.scroll'); s.scrollTop = s.scrollHeight; })()`);
    await settle();
    await resizePane(300, 400);
    await chunk();
    check((await page.eval(fromBottom)) < 1, 'following did not resume at the bottom');
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'dg3', problemSlug: '${DIAGRAM_SLUG}', text: 'done' })`);
    await settle();
  });

  await scenario('a pane that catches up with the tabset only after the drag is still made inert', async () => {
    await page.eval(`document.querySelectorAll('.flexlayout__tab_button')[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    // The tabset moved but its pane has not yet (one frame of a drag).
    await page.eval(`document.getElementById('pane-desc').style.width = '470px'`);
    await page.eval('window.__openTutor()');
    await settle();
    check(!(await page.eval(`document.getElementById('pane-desc').inert`)), 'a pane that does not match the tabset was made inert');
    await resizePane(500, 600);
    check(await page.eval(`document.getElementById('pane-desc').inert`), 'the Description pane was not made inert once it matched');
    check(!(await page.eval(`document.getElementById('pane-code').inert`)), 'the editor was made inert');
    // Restore the fixture's own layout for anything after this.
    await resizePane(560, 664);
    await page.eval(`(() => { document.getElementById('pane-code').style.left = '576px'; })()`);
    await page.eval(`history.pushState(null, '', '/problems/two-sum/description/')`);
    await page.waitFor(`!document.getElementById('lc-tutor-panel-host').hasAttribute('data-active')`, { timeout: 5000, what: 'the panel to close on navigation' });
  });

  const exceptions = page.console.filter((line) => line.startsWith('exception'));
  await scenario('the injected Tutor tab sits right after Description, and stays there as LeetCode adds and removes tabs', async () => {
    await page.eval(`(() => {
      const container = document.querySelector('.flexlayout__tabset_tabbar_inner_tab_container');
      window.__strip = () => [...container.children].map((n) => n.classList.contains('flexlayout__tabset_tab_divider') ? '|'
        : ([...n.querySelectorAll('*')].find((c) => !c.children.length && c.textContent.trim()) || n).textContent.trim());
      window.__nativeTab = (label) => {
        const b = [...container.children].find((n) => n.matches('.flexlayout__tab_button:not([data-lc-tutor-tab])') && n.textContent.includes('Submissions')).cloneNode(true);
        b.removeAttribute('data-layout-path');
        for (const leaf of b.querySelectorAll('.label > div')) leaf.textContent = label;
        b.dataset.added = '';
        const d = document.createElement('div');
        d.className = 'flexlayout__tabset_tab_divider';
        d.dataset.added = '';
        return [d, b];
      };
      // Counts strip mutations after things settle: a placement that keeps
      // re-moving itself would never stop.
      window.__quiet = () => new Promise((resolve) => {
        let n = 0;
        const o = new MutationObserver((records) => { n += records.length; window.__dbg = records.map((r) => r.type + ':' + (r.target.className || r.target.nodeName) + ':+' + [...r.addedNodes].map((x) => x.className || x.nodeName) + '-' + [...r.removedNodes].map((x) => x.className || x.nodeName)); });
        o.observe(container, { childList: true, subtree: true });
        setTimeout(() => { o.disconnect(); resolve(n); }, 150);
      });
    })()`);
    const at = (what) => page.eval('window.__strip().join(" ")').then((s) => ({ what, s }));
    let r = await at('mounted');
    check(r.s === 'Description | Tutor | Submissions', `${r.what}: ${r.s}`);
    // LeetCode's own "Accepted" tab after a submit, added at the end.
    await page.eval(`(() => { const c = document.querySelector('.flexlayout__tabset_tabbar_inner_tab_container'); c.append(...window.__nativeTab('Accepted')); })()`);
    await settle();
    r = await at('Accepted appended');
    check(r.s === 'Description | Tutor | Submissions | Accepted', `${r.what}: ${r.s}`);
    // A tab inserted right after Description and its divider (as React puts
    // a new keyed tab before the next native one) goes after the Tutor tab.
    await page.eval(`(() => { const d = [...document.querySelectorAll('.flexlayout__tab_button')].find((b) => b.textContent.includes('Description')); const [dv, b] = window.__nativeTab('Editorial'); d.nextElementSibling.after(b, dv); })()`);
    await settle();
    r = await at('Editorial after Description');
    check(r.s === 'Description | Tutor | Editorial | Submissions | Accepted', `${r.what}: ${r.s}`);
    check((await page.eval('window.__quiet()')) === 0, 'the strip kept changing after the Tutor tab was placed: ' + JSON.stringify(await page.eval('window.__dbg')));
    await page.eval(`document.querySelectorAll('[data-added]').forEach((n) => n.remove())`);
    await settle();
    r = await at('added tabs removed');
    check(r.s === 'Description | Tutor | Submissions', `${r.what}: ${r.s}`);
    check((await page.eval('window.__quiet()')) === 0, 'the strip kept changing after the tabs were removed');
  });

  await scenario('a real click anywhere on the composer box focuses the textarea, without breaking selection inside it', async () => {
    await page.eval('window.__openTutor()');
    await settle();
    const g = await page.eval(`(() => {
      const t = window.__q('textarea');
      const r = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
      return { disabled: t.disabled, box: r(window.__q('.box')), input: r(t), send: r(window.__q('.box button')) };
    })()`);
    check(!g.disabled, 'the composer is disabled');
    const click = async (x, y) => {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    const state = () => page.eval(`(() => { const t = window.__q('textarea'); return { focused: window.__root().activeElement === t, start: t.selectionStart, end: t.selectionEnd, value: t.value }; })()`);
    const midY = (g.input.top + g.input.bottom) / 2;
    const midX = (g.input.left + g.input.right) / 2;
    const spots = {
      'left padding': [g.box.left + 4, midY],
      'top rim': [midX, g.box.top + 2],
      'bottom rim': [midX, g.box.bottom - 2],
      'gap before Send': [g.send.left - 3, midY],
    };
    for (const [name, [x, y]] of Object.entries(spots)) {
      await page.eval(`(() => { const t = window.__q('textarea'); t.value = 'abc'; t.setSelectionRange(0, 0); t.blur(); })()`);
      await click(x, y);
      await settle();
      let s = await state();
      check(s.focused && s.start === 3 && s.end === 3, `${name} (${x}, ${y}): ${JSON.stringify(s)}`);
      await page.send('Input.insertText', { text: 'd' });
      s = await state();
      check(s.value === 'abcd', `${name}: typing after the click gave ${JSON.stringify(s.value)}`);
    }
    // Already focused, the caret stays where it was.
    await page.eval(`(() => { const t = window.__q('textarea'); t.value = 'abc'; t.focus(); t.setSelectionRange(1, 1); })()`);
    await click(...spots['left padding']);
    let s = await state();
    check(s.focused && s.start === 1 && s.end === 1, `focused click on the padding moved the caret: ${JSON.stringify(s)}`);
    // Inside the textarea a click still places the caret, and a drag selects.
    await page.eval(`(() => { const t = window.__q('textarea'); t.value = 'hello world'; t.blur(); })()`);
    await click(g.input.left + 1, midY);
    s = await state();
    check(s.focused && s.start === 0 && s.end === 0, `a click at the text start: ${JSON.stringify(s)}`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.input.left + 1, y: midY, button: 'left', clickCount: 1, buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.input.left + 60, y: midY, button: 'left', buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.input.left + 60, y: midY, button: 'left', clickCount: 1 });
    s = await state();
    check(s.focused && s.start === 0 && s.end > 2, `a drag in the textarea: ${JSON.stringify(s)}`);
    await page.eval(`(() => { const t = window.__q('textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()`);
  });

  await scenario('the model label changes after the old reply ends', async () => {
    await page.eval(`window.__ev({ type: 'config', provider: 'local', label: 'Local model', model: 'old-model' })`);
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'model-switch', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'config', provider: 'local', label: 'Local model', model: 'new-model' })`);
    await settle();
    check(await page.eval(`window.__q('.provider').textContent`) === 'Local model · old-model', 'the header changed mid-reply');
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'model-switch', problemSlug: 'two-sum', text: 'done' })`);
    await settle();
    check(await page.eval(`window.__q('.provider').textContent`) === 'Local model · new-model', 'the header did not update after the reply');
  });

  // Last, since a switch drops every transcript the panel holds.
  await scenario('over the relay, a problem switch empties a panel on the old problem at once, and a switch back starts with the notice', async () => {
    const feed = () => page.eval(`window.__qa('.feed > *').map((n) => n.className.split(' ')[0] + ': ' + n.textContent)`);
    const QUIET = 'empty: Another problem is active now. Send a message or Run here to switch to this one.';
    const NOTICE = 'notice: New problem detected. Started a fresh tutor session.';
    check((await feed()).length > 3, `the two-sum chat is on screen first: ${JSON.stringify(await feed())}`);
    await page.eval(`window.__ev({ type: 'notice', problemSlug: 'valid-parentheses', text: 'New problem detected. Started a fresh tutor session.', switch: true })`);
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'valid-parentheses', text: 'SECRET-OTHER-PROBLEM' })`);
    await settle();
    check(JSON.stringify(await feed()) === JSON.stringify([QUIET]), `two-sum after the switch: ${JSON.stringify(await feed())}`);
    await page.screenshot(path.join(SHOTS, 'another-problem-active-dark.png'), { width: 1100, height: 760 });
    // Back on two-sum: the notice, then the message, nothing older.
    await page.eval(`window.__ev({ type: 'notice', problemSlug: 'two-sum', text: 'New problem detected. Started a fresh tutor session.', switch: true })`);
    await settle();
    check((await feed())[0].startsWith('empty: Submit your code'), `a dangling notice before anything follows it: ${JSON.stringify(await feed())}`);
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'two-sum', text: 'back again' })`);
    await settle();
    check(JSON.stringify(await feed()) === JSON.stringify([NOTICE, 'user: back again']), `two-sum after switching back: ${JSON.stringify(await feed())}`);
  });

  await scenario('no exceptions in the page', async () => {
    check(exceptions.length === 0, exceptions.join('\n'));
  });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
