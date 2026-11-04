// extension/e2e/model-switcher.e2e.mjs - the Tutor panel's model switcher in a
// real (headless) Chromium: the real panel.js (and content.js) injected into
// the panel fixture, with a scripted stand-in for the background worker on
// the extension port (chrome.runtime.connect) and the fixture's scripted
// relay (fetch). Covers what the unit tests cannot: how the button and its
// listbox render (styled from the page's language selector, dark and light,
// a narrow pane), the keyboard (arrows, Home, End, Enter, Escape, focus back
// on the button), disabled entries with their reason, "Manage models...",
// and the switch itself through both transports: the worker for the browser
// runtime and POST /panel/switch-profile for the helper, with the light on
// "Switching" until a switch held behind a running reply lands, and a refusal
// shown in the panel.
//
// The worker's and the companion's own rules (only saved ids, history and
// held code moving over) are covered by engine.test.mjs,
// companion/settings-rpc.test.js and companion/panel-bridge.test.js; the real
// extension's switch by extension-runtime.e2e.mjs.
//
//   node extension/e2e/model-switcher.e2e.mjs
//
// Screenshots go to /tmp/lc-switcher-shots.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = '/tmp/lc-switcher-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8');
const panelSource = fs
  .readFileSync(path.join(here, '..', 'panel.js'), 'utf8')
  .replace('const RELAY_BASE = "http://localhost:8135";', 'const RELAY_BASE = "http://127.0.0.1:9";');
if (!panelSource.includes('http://127.0.0.1:9')) throw new Error('could not repoint RELAY_BASE in the injected panel.js');
const contentSource = fs
  .readFileSync(path.join(here, '..', 'content.js'), 'utf8')
  .replace('const RELAY_URL = "http://localhost:8135/capture";', 'const RELAY_URL = "http://127.0.0.1:9/capture";');
const injectSource = fs.readFileSync(path.join(here, '..', 'inject.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(here, '..', 'layout-bridge.js'), 'utf8');

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/problems/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixture);
  } else if (req.url === '/ext/inject.js' || req.url === '/ext/layout-bridge.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(req.url === '/ext/inject.js' ? injectSource : bridgeSource);
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

const PROFILES = [
  { id: 'gpt', name: 'gpt-oss:20b', provider: 'local', providerLabel: 'Local model', model: 'gpt-oss:20b', runtime: 'extension', available: true, reason: null },
  { id: 'gemma', name: 'Gemma', provider: 'local', providerLabel: 'Local model', model: 'gemma4:26b', runtime: 'extension', available: true, reason: null },
  { id: 'opus', name: 'claude-opus-5-5', provider: 'anthropic', providerLabel: 'Anthropic API key', model: 'claude-opus-5-5', runtime: 'extension', available: false, reason: 'No API key saved' },
  { id: 'haiku', name: 'Haiku, the quick one with a long name', provider: 'claude', providerLabel: 'Claude subscription', model: 'claude-haiku-5-5', runtime: 'helper', available: true, reason: null },
];

const browser = await launch();
try {
  const page = await browser.openPage(`${origin}/problems/two-sum/description/`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  // The stand-in worker: records what the panel posts, and the test answers.
  await page.eval(`(() => {
    window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
    window.__q = (sel) => window.__root().querySelector(sel);
    window.__qa = (sel) => [...window.__root().querySelectorAll(sel)];
    window.__settle = () => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 30));
    window.__posted = [];
    window.__sent = [];
    const listeners = [];
    window.__toPanel = (m) => listeners.forEach((fn) => fn(m));
    window.__workerSeq = 0;
    window.__workerEvent = (event) => window.__toPanel({ type: 'event', event: { seq: ++window.__workerSeq, epoch: 'w1', ...event } });
    const port = {
      postMessage: (m) => {
        window.__posted.push(JSON.parse(JSON.stringify(m)));
        if (m.type === 'subscribe') {
          window.__toPanel({ type: 'event', event: { type: 'config', provider: 'local', label: 'Local model', model: 'gpt-oss:20b', epoch: 'w1' } });
          window.__toPanel({ type: 'event', event: { type: 'status', companionOnline: true, busy: false, epoch: 'w1', openTurns: [] } });
        }
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: () => {} },
    };
    window.__editorCode = 'class Solution:\\n    pass\\n';
    window.monaco = { editor: { getEditors: () => [{ getDomNode: () => document.getElementById('pane-code'), getModel: () => ({ getValue: () => window.__editorCode, getLanguageId: () => 'python' }) }] } };
    window.chrome = { runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (file) => '/ext/' + file,
      connect: () => port,
      sendMessage: (m) => { window.__sent.push(m); return Promise.resolve(m.type === 'lc-tutor:capture' ? { handled: true } : undefined); },
    } };
    window.__openTutor = () => document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  })()`);
  // The lang button gets LeetCode's chevron like the real one.
  await page.eval(`document.getElementById('lang-button').insertAdjacentHTML('beforeend', '<svg width="12" height="12" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" stroke="currentColor" fill="none"/></svg>')`);
  await page.eval(`new Function(${JSON.stringify(contentSource)})()`);
  await page.eval(`new Function(${JSON.stringify(panelSource)})()`);
  await page.waitFor(`document.querySelector('[data-lc-tutor-tab]')`, { what: 'the Tutor tab' });
  await page.eval(`window.__toPanel({ type: 'runtime', runtime: 'extension', chosen: true })`);
  await page.eval(`window.__toPanel({ type: 'profiles', profiles: ${JSON.stringify(PROFILES)}, active: 'gpt' })`);
  await page.eval('window.__openTutor()');
  const settle = () => page.eval('window.__settle()');
  await settle();
  const key = async (k, mods = 0) => {
    const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Tab: 9, ' ': 32 };
    const code = k === ' ' ? 'Space' : k;
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: codes[k], modifiers: mods, ...(k === 'Enter' ? { text: '\r' } : k === ' ' ? { text: ' ' } : {}) });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: codes[k], modifiers: mods });
    await settle();
  };
  const focused = () => page.eval(`(() => { const a = window.__root().activeElement; return a ? (a.dataset.id || a.className) : null; })()`);
  const clickAt = async (selector) => {
    const c = await page.eval(`(() => { const r = window.__q(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
    }
    await settle();
  };
  const status = () => page.eval(`({ text: window.__q('.status span').textContent, state: window.__q('.status').dataset.state })`);

  await scenario('the button names the active model, ends in a chevron, and copies the language selector\'s style', async () => {
    const m = await page.eval(`(() => {
      const b = window.__q('button.model');
      const cs = getComputedStyle(b);
      const lang = getComputedStyle(document.getElementById('lang-button'));
      const head = window.__q('.head').getBoundingClientRect();
      const r = b.getBoundingClientRect();
      const gear = window.__q('button.gear').getBoundingClientRect();
      const chev = b.querySelector('svg').getBoundingClientRect();
      const name = b.querySelector('.provider').getBoundingClientRect();
      return {
        text: b.textContent, hidden: b.hidden, popup: b.getAttribute('aria-haspopup'), expanded: b.getAttribute('aria-expanded'),
        label: b.getAttribute('aria-label'), title: b.title,
        style: [cs.fontSize, cs.lineHeight, cs.fontWeight, cs.padding, cs.borderRadius, cs.color].join(' | '),
        lang: [lang.fontSize, lang.lineHeight, lang.fontWeight, lang.padding, lang.borderRadius, lang.color].join(' | '),
        mid: r.top + r.height / 2 - (head.top + head.height / 2), height: r.height,
        gap: gear.left - r.right, chev: { w: chev.width, gap: chev.left - name.right, mid: chev.top + chev.height / 2 - (r.top + r.height / 2) },
      };
    })()`);
    check(m.text === 'gpt-oss:20b' && !m.hidden, `button text: ${JSON.stringify(m)}`);
    check(m.popup === 'listbox' && m.expanded === 'false' && m.label === 'Tutor model: gpt-oss:20b', `a11y: ${JSON.stringify(m)}`);
    check(m.title === 'The tutor uses gpt-oss:20b (Local model). Click to switch.', `title: ${m.title}`);
    check(m.style === m.lang, `style ${m.style} vs the language selector ${m.lang}`);
    check(Math.abs(m.mid) <= 0.5 && m.height === 24, `centered in the 32px row: ${JSON.stringify(m)}`);
    check(m.gap === 4, `gap to the gear: ${m.gap}`);
    check(m.chev.w === 12 && m.chev.gap === 4 && Math.abs(m.chev.mid) <= 0.5, `chevron: ${JSON.stringify(m.chev)}`);
    await page.screenshot(path.join(SHOTS, '01-button-dark.png'), { width: 1100, height: 760 });
  });

  await scenario('clicking opens the listbox: a check on the active model, a disabled entry with its reason, Manage models', async () => {
    await clickAt('button.model');
    const m = await page.eval(`(() => {
      const menu = window.__q('.menu');
      const r = menu.getBoundingClientRect();
      const host = document.getElementById('lc-tutor-panel-host').getBoundingClientRect();
      const opts = window.__qa('.menu .opt').map((o) => ({
        id: o.dataset.id, role: o.getAttribute('role'), selected: o.getAttribute('aria-selected'), disabled: o.getAttribute('aria-disabled'),
        name: (o.querySelector('.opt-name') || o.querySelector('.opt-text')).textContent, meta: o.querySelector('.opt-meta') ? o.querySelector('.opt-meta').textContent : null,
        check: getComputedStyle(o.querySelector('.check')).visibility,
      }));
      return { hidden: menu.hidden, role: menu.getAttribute('role'), expanded: window.__q('button.model').getAttribute('aria-expanded'), opts,
        inside: r.right <= host.right - 8 + 0.5 && r.left >= host.left, top: r.top - window.__q('.head').getBoundingClientRect().bottom,
        bg: getComputedStyle(menu).backgroundColor, sep: window.__qa('.menu .sep').length };
    })()`);
    check(!m.hidden && m.role === 'listbox' && m.expanded === 'true', `open: ${JSON.stringify(m)}`);
    check(m.opts.map((o) => o.name).join('|') === 'gpt-oss:20b|Gemma|claude-opus-5-5|Haiku, the quick one with a long name|Manage models...', `entries: ${m.opts.map((o) => o.name)}`);
    check(m.opts[0].selected === 'true' && m.opts[0].check === 'visible' && m.opts[1].check === 'hidden', `check: ${JSON.stringify(m.opts.slice(0, 2))}`);
    check(m.opts[2].disabled === 'true' && m.opts[2].meta === 'No API key saved', `disabled entry: ${JSON.stringify(m.opts[2])}`);
    check(m.opts[1].meta === 'Local model · gemma4:26b' && m.opts[0].meta === 'Local model', `meta: ${m.opts[0].meta} / ${m.opts[1].meta}`);
    check(m.opts.every((o) => o.role === 'option') && m.sep === 1, 'roles');
    check(m.inside && m.top <= 0, `placement: ${JSON.stringify(m)}`);
    check(m.bg === 'rgb(48, 48, 48)', `popover surface: ${m.bg}`);
    check((await focused()) === 'gpt', `focus on the active entry: ${await focused()}`);
    await page.screenshot(path.join(SHOTS, '02-open-dark.png'), { width: 1100, height: 760 });
    // A press outside closes it.
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 400, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 400, button: 'left', clickCount: 1 });
    await settle();
    check(await page.eval(`window.__q('.menu').hidden`), 'a press outside closes it');
  });

  await scenario('the keyboard: arrows skip the disabled entry, Home and End, Escape closes and focus returns to the button', async () => {
    await page.eval(`window.__q('button.model').focus()`);
    await key('ArrowDown');
    check(!(await page.eval(`window.__q('.menu').hidden`)), 'ArrowDown opens');
    check((await focused()) === 'gpt', `starts on the active one: ${await focused()}`);
    await key('ArrowDown');
    check((await focused()) === 'gemma', `down: ${await focused()}`);
    await key('ArrowDown');
    check((await focused()) === 'haiku', `the disabled entry is skipped: ${await focused()}`);
    await key('End');
    check((await focused()) === '\u0000manage', `End: ${await focused()}`);
    await key('ArrowDown');
    check((await focused()) === 'gpt', `wraps: ${await focused()}`);
    await key('Home');
    check((await focused()) === 'gpt', 'Home');
    await key('ArrowUp');
    check((await focused()) === '\u0000manage', `up wraps: ${await focused()}`);
    await key('Escape');
    check(await page.eval(`window.__q('.menu').hidden`), 'Escape closes');
    check((await page.eval(`window.__root().activeElement === window.__q('button.model')`)), 'focus back on the button');
    check((await page.eval(`window.__q('button.model').getAttribute('aria-expanded')`)) === 'false', 'collapsed');
    // Enter on the button opens it too; Tab closes without choosing and goes
    // on to the gear, inside the panel (the listbox comes after the composer
    // in the page, so a plain Tab would leave the Tutor panel).
    await key('Enter');
    check(!(await page.eval(`window.__q('.menu').hidden`)), 'Enter opens');
    await key('ArrowDown');
    await key('Tab');
    check(await page.eval(`window.__q('.menu').hidden`), 'Tab closes');
    check(await page.eval(`window.__root().activeElement === window.__q('button.gear')`), `Tab goes on to the gear: ${await focused()}`);
    check((await page.eval(`window.__q('button.model').textContent`)) === 'gpt-oss:20b', 'nothing was chosen');
    // Shift+Tab closes and stays on the button.
    await page.eval(`window.__q('button.model').focus()`);
    await key('Enter');
    await key('Tab', 8);
    check(await page.eval(`window.__q('.menu').hidden`), 'Shift+Tab closes');
    check(await page.eval(`window.__root().activeElement === window.__q('button.model')`), `Shift+Tab stays on the button: ${await focused()}`);
  });

  await scenario('Enter on an entry switches through the worker; "Switching" until a reply already running ends', async () => {
    // A reply is streaming.
    await page.eval(`window.__workerEvent({ type: 'user', problemSlug: 'two-sum', text: 'why is this slow?' })`);
    await page.eval(`window.__workerEvent({ type: 'turn-start', problemSlug: 'two-sum', turnId: 't1' })`);
    await page.eval(`window.__workerEvent({ type: 'chunk', turnId: 't1', text: 'Because the inner' })`);
    await page.eval(`window.__q('button.model').focus()`);
    await key('Enter');
    await key('ArrowDown');
    await key('Enter');
    const posted = await page.eval(`window.__posted.filter((m) => m.type === 'switch-profile')`);
    check(posted.length === 1 && posted[0].id === 'gemma', `posted: ${JSON.stringify(posted)}`);
    check(await page.eval(`window.__q('.menu').hidden`), 'choosing closes the menu');
    check(await page.eval(`window.__root().activeElement === window.__q('button.model')`), 'focus back on the button');
    const during = await status();
    check(during.text === 'Switching' && during.state === 'busy', `while waiting: ${JSON.stringify(during)}`);
    const light = await page.eval(`getComputedStyle(window.__q('.status .light')).backgroundColor`);
    check(light === 'rgb(255, 192, 30)', `yellow light: ${light}`);
    check(await page.eval(`window.__q('button.model').textContent`) === 'gpt-oss:20b', 'the old model is still named while it answers');
    check(!(await page.eval(`window.__q('textarea').disabled`)), 'the composer stays usable');
    await page.screenshot(path.join(SHOTS, '03-switching-dark.png'), { width: 1100, height: 760 });
    // The reply ends, then the worker's swap lands and it answers.
    await page.eval(`window.__workerEvent({ type: 'turn-end', problemSlug: 'two-sum', turnId: 't1', text: 'Because the inner loop is quadratic.' })`);
    const reqId = posted[0].reqId;
    await page.eval(`window.__toPanel({ type: 'event', event: { type: 'config', provider: 'local', label: 'Local model', model: 'gemma4:26b', epoch: 'w1' } })`);
    await page.eval(`window.__toPanel({ type: 'switch-result', reqId: ${reqId}, ok: true, runtime: 'extension' })`);
    await page.eval(`window.__toPanel({ type: 'profiles', profiles: ${JSON.stringify(PROFILES)}, active: 'gemma' })`);
    await settle();
    const after = await status();
    check(after.text === 'Connected', `after: ${JSON.stringify(after)}`);
    check(await page.eval(`window.__q('button.model').textContent`) === 'Gemma', 'the new model is named');
    const feed = await page.eval(`window.__qa('.feed > *').map((n) => n.textContent).join(' / ')`);
    check(/why is this slow\?/.test(feed) && /inner loop is quadratic/.test(feed), `the chat is still there: ${feed}`);
  });

  await scenario('a refused switch says why in the panel and keeps the model', async () => {
    await clickAt('button.model');
    await clickAt('.opt[data-id="gpt"]');
    const posted = await page.eval(`window.__posted.filter((m) => m.type === 'switch-profile').pop()`);
    check(posted.id === 'gpt', 'posted');
    await page.eval(`window.__toPanel({ type: 'switch-result', reqId: ${posted.reqId}, ok: false, code: 'unknown', message: 'That model is no longer saved. Open Manage models to add it again.' })`);
    await settle();
    const hint = await page.eval(`({ text: window.__q('.hint').textContent, hidden: window.__q('.hint').hidden })`);
    check(!hint.hidden && /no longer saved/.test(hint.text), `hint: ${JSON.stringify(hint)}`);
    check(await page.eval(`window.__q('button.model').textContent`) === 'Gemma', 'unchanged');
    check((await status()).text === 'Connected', 'not stuck on Switching');
    // A click on the disabled entry does nothing.
    await clickAt('button.model');
    await clickAt('.opt[data-id="opus"]');
    check(!(await page.eval(`window.__q('.menu').hidden`)), 'a disabled entry does not close the menu');
    check((await page.eval(`window.__posted.filter((m) => m.type === 'switch-profile').length`)) === 2, 'nor switch');
    await key('Escape');
  });

  await scenario('"Manage models..." opens the options page', async () => {
    await clickAt('button.model');
    await clickAt('.opt.manage');
    check(await page.eval(`window.__sent.some((m) => m.type === 'lc-tutor:open-settings')`), 'asked the worker to open the options page');
    check(await page.eval(`window.__q('.menu').hidden`), 'closed');
  });

  await scenario('light theme: the button and the popover follow the page', async () => {
    await page.eval(`document.documentElement.classList.add('light')`);
    await settle();
    const closed = await page.eval(`({ color: getComputedStyle(window.__q('button.model')).color, lang: getComputedStyle(document.getElementById('lang-button')).color })`);
    await page.eval(`window.__q('button.model').click()`);
    await settle();
    const m = { ...closed, ...(await page.eval(`({ bg: getComputedStyle(window.__q('.menu')).backgroundColor, name: getComputedStyle(window.__q('.opt-name')).color })`)) };
    check(m.bg === 'rgb(255, 255, 255)', `light popover: ${m.bg}`);
    check(m.color === m.lang, `button color follows the language selector: ${m.color} vs ${m.lang}`);
    await page.screenshot(path.join(SHOTS, '04-open-light.png'), { width: 1100, height: 760, scheme: 'light' });
    await key('Escape');
    await page.eval(`document.documentElement.classList.remove('light')`);
    await settle();
  });

  await scenario('a narrow pane: the name ellipsizes, the light, status and gear stay, the popover fits', async () => {
    const resize = async (w) => {
      await page.eval(`(() => {
        const ts = document.querySelector('.flexlayout__tabset'); ts.style.width = '${w}px';
        const desc = document.getElementById('pane-desc'); desc.style.width = '${w}px';
      })()`);
      await settle();
      await page.eval('new Promise((r) => setTimeout(r, 300))');
      await settle();
    };
    await page.eval(`window.__toPanel({ type: 'profiles', profiles: ${JSON.stringify(PROFILES)}, active: 'haiku' })`);
    for (const w of [300, 240]) {
      await resize(w);
      await page.eval(`window.__q('button.model').click()`);
      await settle();
      const m = await page.eval(`(() => {
        const host = document.getElementById('lc-tutor-panel-host').getBoundingClientRect();
        const name = window.__q('button.model .provider');
        const gear = window.__q('button.gear').getBoundingClientRect();
        const light = window.__q('.status .light').getBoundingClientRect();
        const menu = window.__q('.menu').getBoundingClientRect();
        const chev = window.__q('button.model svg').getBoundingClientRect();
        return { cut: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow,
          gearIn: gear.right <= host.right && gear.width === 24, lightIn: light.width === 8 && light.left >= host.left,
          chevIn: chev.width === 12 && chev.right <= gear.left, menuIn: menu.left >= host.left + 7.5 && menu.right <= host.right - 7.5,
          optCut: window.__qa('.opt-name').some((n) => n.scrollWidth > n.clientWidth),
          rects: { host: [host.left, host.right], menu: [menu.left, menu.right] } };
      })()`);
      check(m.cut && m.ellipsis === 'ellipsis', `name ellipsized at ${w}: ${JSON.stringify(m)}`);
      check(m.gearIn && m.lightIn && m.chevIn, `kept at ${w}: ${JSON.stringify(m)}`);
      check(m.menuIn && m.optCut, `popover at ${w}: ${JSON.stringify(m)}`);
      await page.screenshot(path.join(SHOTS, `05-narrow-${w}.png`), { width: 600, height: 760 });
      await key('Escape');
    }
    await resize(560);
  });

  await scenario('the helper runtime: a helper model switches through the relay, a refusal is shown, and the worker hears of it', async () => {
    await page.eval(`window.__toPanel({ type: 'runtime', runtime: 'helper', chosen: true })`);
    await page.waitFor('window.__streamOpen()', { what: 'the relay stream' });
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: false, epoch: 'r1', openTurns: [] })`);
    await page.eval(`window.__event({ type: 'config', provider: 'claude', label: 'Claude subscription', model: 'claude-sonnet-5', epoch: 'r1' })`);
    const helperProfiles = [
      ...PROFILES,
      { id: 'sonnet', name: 'Sonnet', provider: 'claude', providerLabel: 'Claude subscription', model: 'claude-sonnet-5', runtime: 'helper', available: true, reason: null },
    ];
    await page.eval(`window.__toPanel({ type: 'profiles', profiles: ${JSON.stringify(helperProfiles)}, active: 'sonnet' })`);
    await settle();
    await page.eval(`(() => { window.__switchDelayMs = 400; window.__switchBody = { ok: true, profile: 'haiku', active: { provider: 'claude', label: 'Claude subscription', model: 'claude-haiku-5-5' } }; })()`);
    await clickAt('button.model');
    await clickAt('.opt[data-id="haiku"]');
    const during = await status();
    check(during.text === 'Switching', `while the companion swaps: ${JSON.stringify(during)}`);
    await page.waitFor(`window.__q('.status span').textContent === 'Connected'`, { what: 'the switch to land' });
    check(await page.eval(`JSON.stringify(window.__switches)`) === '[{"id":"haiku"}]', 'only the id is posted');
    check(await page.eval(`window.__posted.some((m) => m.type === 'profile-switched' && m.id === 'haiku')`), 'the worker hears of it');
    check(!(await page.eval(`window.__posted.some((m) => m.type === 'switch-profile' && m.id === 'haiku')`)), 'not through the worker');
    // The companion refuses an id it does not have.
    await page.eval(`(() => { window.__switchDelayMs = 0; window.__switchStatus = 404; window.__switchBody = { ok: false, error: { code: 'unknown', message: 'The helper app does not have that model saved. Open Manage models and press Save.' } }; })()`);
    await clickAt('button.model');
    await clickAt('.opt[data-id="sonnet"]');
    await page.waitFor(`!window.__q('.hint').hidden`, { what: 'the refusal' });
    check(/does not have that model saved/.test(await page.eval(`window.__q('.hint').textContent`)), 'refusal shown');
    // With the helper's tutor offline, its models cannot be chosen.
    await page.eval(`window.__event({ type: 'status', companionOnline: false, busy: false, epoch: 'r1', openTurns: [] })`);
    await settle();
    await page.eval(`window.__q('button.model').click()`);
    await settle();
    const off = await page.eval(`window.__qa('.opt[data-id="sonnet"]').map((o) => [o.getAttribute('aria-disabled'), o.querySelector('.opt-meta').textContent])[0]`);
    check(off[0] === 'true' && off[1] === "Helper app isn't running", `offline helper entry: ${JSON.stringify(off)}`);
    check(!(await page.eval(`window.__q('button.model').hidden`)), 'the button stays, so another model can be chosen');
    await page.screenshot(path.join(SHOTS, '06-helper-offline-dark.png'), { width: 1100, height: 760 });
    await key('Escape');
  });

  await scenario('a helper switch the relay stopped waiting for is taken from the companion\'s next config event', async () => {
    await page.eval(`window.__event({ type: 'status', companionOnline: true, busy: true, epoch: 'r1', openTurns: [] })`);
    await settle();
    check(await page.eval(`window.__q('button.model').textContent`) === 'Haiku, the quick one with a long name', 'starts on haiku');
    await page.eval(`(() => { window.__switchDelayMs = 0; window.__switchStatus = 504; window.__switchBody = { ok: false, error: { message: 'The tutor did not answer within 190 seconds.' } }; })()`);
    await clickAt('button.model');
    await clickAt('.opt[data-id="sonnet"]');
    await page.waitFor(`!window.__q('.hint').hidden`, { what: 'the waiting hint' });
    check(/waiting for the tutor's current reply/.test(await page.eval(`window.__q('.hint').textContent`)), 'says it is still waiting');
    check(await page.eval(`window.__q('button.model').textContent`) === 'Haiku, the quick one with a long name', 'not switched yet');
    // The companion finishes the switch after its reply and says so.
    await page.eval(`window.__event({ type: 'config', provider: 'claude', label: 'Claude subscription', model: 'claude-sonnet-5', profile: 'sonnet', epoch: 'r1' })`);
    await settle();
    check(await page.eval(`window.__q('button.model').textContent`) === 'Sonnet', 'the switch is taken from the config event');
    check(await page.eval(`window.__posted.some((m) => m.type === 'profile-switched' && m.id === 'sonnet')`), 'the worker hears of it');
    check(await page.eval(`window.__q('.hint').hidden`), 'the waiting hint goes away');
    // Without a switch left unsettled, a config event never moves the choice.
    await page.eval(`window.__event({ type: 'config', provider: 'claude', label: 'Claude subscription', model: 'claude-haiku-5-5', profile: 'haiku', epoch: 'r1' })`);
    await settle();
    check(await page.eval(`window.__q('button.model').textContent`) === 'Sonnet', 'an unrelated config event changes nothing');
    check(!(await page.eval(`window.__posted.some((m) => m.type === 'profile-switched' && m.id === 'haiku' && window.__posted.indexOf(m) > window.__posted.findIndex((x) => x.type === 'profile-switched' && x.id === 'sonnet'))`)), 'nor tells the worker');
    await page.eval(`window.__switchStatus = 200`);
  });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
