// extension/e2e/panel-render.e2e.mjs - the Tutor panel's DOM behavior in a
// real (headless) Chromium: the real extension/panel.js injected into a local
// fixture page (panel-fixture.html) that copies the bits of LeetCode's
// flexlayout DOM it mounts into, with fetch replaced by a scripted relay.
//
// Covers what the unit tests cannot: the feed is patched in place (a text
// selection and a code block's horizontal scroll survive streamed chunks and
// events for other problems), the header row (dark and light), which native pane is
// made inert, the relay-restart (epoch) flow over a reconnect, sending
// (double Enter, the too-long hint), the live editor code a send carries
// (the real content.js and inject.js answering against a stand-in Monaco),
// and some CSS metrics.
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

// Serves the fixture at any /problems/<slug>/ path, on a random free port.
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/problems/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixture);
  } else if (req.url === '/ext/inject.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(injectSource);
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
        right: window.__q('.head > .head-right > .provider[hidden]') !== null && window.__q('.head > .head-right > button.gear') !== null,
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

  await scenario('the header names the tutor model on the right, in the row text style, with a settings gear', async () => {
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: false, epoch: 'e1', openTurns: [] })`);
    await page.eval(`window.__event({ type: 'config', provider: 'local', label: 'Local model', model: 'gpt-oss:20b', epoch: 'e1' })`);
    await settle();
    const m = await page.eval(`(() => {
      const host = document.getElementById('lc-tutor-panel-host').getBoundingClientRect();
      const head = window.__q('.head').getBoundingClientRect();
      const provider = window.__q('.provider');
      const gear = window.__q('button.gear');
      const pr = provider.getBoundingClientRect();
      const gr = gear.getBoundingClientRect();
      const ps = getComputedStyle(provider);
      const gs = getComputedStyle(gear);
      const icon = gear.querySelector('svg').getBoundingClientRect();
      return {
        text: provider.textContent,
        hidden: provider.hidden,
        title: provider.title,
        font: ps.fontSize + '/' + ps.lineHeight,
        color: ps.color,
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
    check(m.font === '12px/16px' && m.color === m.statusColor, `provider text style: ${m.font} ${m.color} vs ${m.statusColor}`);
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
    const m = await page.eval(`({ hidden: window.__q('.provider').hidden, display: getComputedStyle(window.__q('.provider')).display, gear: getComputedStyle(window.__q('button.gear')).display })`);
    check(m.hidden && m.display === 'none' && m.gear !== 'none', `offline header: ${JSON.stringify(m)}`);
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: false, epoch: 'e1', openTurns: [] })`);
    await settle();
    check(!(await page.eval(`window.__q('.provider').hidden`)), 'the label comes back when the companion does');
  });

  await scenario('light mode: the model label and the gear take the light row color', async () => {
    await page.eval(`document.documentElement.classList.add('light')`);
    await settle();
    const m = await page.eval(`({
      provider: getComputedStyle(window.__q('.provider')).color,
      gear: getComputedStyle(window.__q('button.gear')).color,
      row: getComputedStyle(document.querySelector('#pane-subs .row-label')).color,
    })`);
    await page.screenshot(path.join(SHOTS, '02g-header-provider-light.png'), { width: 1100, height: 760 });
    await page.eval(`document.documentElement.classList.remove('light')`);
    await settle();
    check(m.row === 'rgba(26, 26, 26, 0.6)' && m.provider === m.row && m.gear === m.row, `light: ${JSON.stringify(m)}`);
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
    check(max === 8000, `maxlength: ${max}`);
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

  const exceptions = page.console.filter((line) => line.startsWith('exception'));
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
