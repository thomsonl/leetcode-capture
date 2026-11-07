// End-to-end check of the Tutor panel during the extension's one restart to
// finish the helper's setup (shared/native-setup.js, panel.js's
// setupRestartStep): an open problem tab says "Finishing setup", reloads
// itself once the extension is back (after a Run being judged, keeping an
// unsent message), never twice, and asks the user to reload when the
// extension does not come back. A real update or manual reload keeps its own
// message.
//
// The REAL unpacked extension (a copy whose manifest pre-grants
// nativeMessaging, the state an Allow leaves) runs in Playwright's cached
// Chromium; leetcode.com is the panel fixture served through CDP Fetch. The
// worker's runtime.connectNative is removed (as in a context running when
// the user allowed it) and its runtime.reload() is replaced by a counter:
// this headless browser unloads an extension that calls runtime.reload() and
// never loads it again, so the reload itself is done the way
// chrome://extensions does it (browser.reloadExtension). The one scenario
// that wants the extension gone for good calls the real runtime.reload().
//
// Run with:  node extension/e2e/setup-reload.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-setup-reload-shots).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-setup-reload-shots';
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8');
const copy = extensionCopy(extensionDir, { extraPermissions: ['nativeMessaging'] });
const browser = await launch({ extensionDir: copy.dir, args: ['--enable-unsafe-extension-debugging'] });

// The panel's status label and banner, read through its open shadow root.
const PANEL = `(() => {
  const root = document.getElementById('lc-tutor-panel-host') && document.getElementById('lc-tutor-panel-host').shadowRoot;
  const q = (sel) => root && root.querySelector(sel);
  return { label: q('.status span') ? q('.status span').textContent : null, banner: q('.banner') && !q('.banner').hidden ? q('.banner').textContent : '', draft: q('textarea') ? q('textarea').value : null };
})()`;

// Every status label the page shows, kept in sessionStorage so a reload of
// the page does not lose them. `__marker` tells whether the page reloaded.
async function watchPanel(page) {
  await page.waitFor(`document.getElementById('lc-tutor-panel-host') && document.getElementById('lc-tutor-panel-host').shadowRoot.querySelector('.status span')`, { what: 'the panel' });
  await page.eval(`(() => {
    window.__marker = 1;
    const span = document.getElementById('lc-tutor-panel-host').shadowRoot.querySelector('.status span');
    const note = () => {
      const seen = JSON.parse(sessionStorage.getItem('__labels') || '[]');
      if (seen[seen.length - 1] !== span.textContent) seen.push(span.textContent);
      sessionStorage.setItem('__labels', JSON.stringify(seen));
    };
    note();
    new MutationObserver(note).observe(span, { childList: true, characterData: true, subtree: true });
  })()`);
}

async function openProblem() {
  const page = await browser.openPage('about:blank');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }] });
  page.on('Fetch.requestPaused', async (p) => {
    const isPage = new URL(p.request.url).pathname.startsWith('/problems/');
    await page.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: isPage ? 200 : 404,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(isPage ? fixture : '').toString('base64'),
    });
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: 'https://leetcode.com/problems/two-sum/description/' });
  await page.waitFor(`document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the problem page' });
  await showPanel(page);
  return page;
}

async function showPanel(page) {
  await page.send('Page.bringToFront');
  await page.eval(`document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
  await page.waitFor(`${PANEL}.label === 'Not set up'`, { what: 'the panel connected to the worker', timeout: 12000 });
}

// The worker as a grant leaves it: no connectNative, and runtime.reload()
// counted instead of done (unless `real`). Then the options page's Helper
// section asks for the helper's state, which makes the worker notice.
let options = null;
let page = null;
async function stageSetupReload({ real = false } = {}) {
  if (options) options.close();
  await browser.serviceWorkerEval(`(async () => {
    self.__reloads = 0;
    const realReload = chrome.runtime.reload.bind(chrome.runtime);
    chrome.runtime.reload = () => { self.__reloads += 1; if (${real}) realReload(); };
    delete chrome.runtime.connectNative;
    await chrome.storage.local.remove('nativeReload');
  })()`);
  options = await browser.openPage('about:blank');
  await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
  await options.waitFor(`document.querySelector('input[name="provider"][value="claude"]')`, { what: 'the options page' });
  await options.eval(`document.querySelector('input[name="provider"][value="claude"]').click()`);
  // The user comes back to the problem tab (a hidden tab draws nothing).
  await page.send('Page.bringToFront');
}
// A hidden tab draws nothing, and the extension's start opens Settings in
// front of the problem tab, so the user's coming back is repeated while
// waiting for what the panel shows.
async function waitShown(expression, { what, timeout }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await page.send('Page.bringToFront').catch(() => {});
    if (await page.eval(expression).catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await page.eval(PANEL).catch((e) => String(e)))}`);
    await sleep(250);
  }
}
async function waitForWorkerReload() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const n = await browser.serviceWorkerEval('self.__reloads').catch(() => 0);
    if (n > 0) return n;
    await sleep(200);
  }
  throw new Error('the worker never reloaded for the setup');
}

try {
  page = await openProblem();
  await watchPanel(page);

  await scenario('the setup restart: Finishing setup, held for a Run being judged, then the page reloads itself once with the unsent message', async () => {
    await page.eval(`(() => {
      const box = document.getElementById('lc-tutor-panel-host').shadowRoot.querySelector('textarea');
      box.value = 'why is my loop off by one?';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      // A Run just started: LeetCode's result is on its way.
      document.dispatchEvent(new Event('leetcode-capture:capture-start'));
    })()`);
    await showPanel(page);
    await stageSetupReload();
    await waitForWorkerReload();
    await browser.reloadExtension();
    await waitShown(`${PANEL}.label === 'Finishing setup' && /reloads by itself once/.test(${PANEL}.banner)`, { what: 'Finishing setup, held for the Run', timeout: 10000 });
    check((await page.eval('window.__marker')) === 1, 'the page reloaded while a Run was being judged');
    await page.screenshot(path.join(shots, 'setup-reload-holding.png'), { width: 1100, height: 760 });
    // The Run's 20 s pass, then the page reloads itself.
    await page.waitFor(`window.__marker === undefined && document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the page to reload itself', timeout: 30000 });
    await watchPanel(page);
    await showPanel(page);
    const panel = await page.eval(PANEL);
    check(panel.draft === 'why is my loop off by one?', `draft: ${JSON.stringify(panel.draft)}`);
    const labels = JSON.parse(await page.eval(`sessionStorage.getItem('__labels')`));
    check(labels.includes('Finishing setup') && !labels.includes('Offline'), JSON.stringify(labels));
    check(!(await page.eval(`sessionStorage.getItem('lc-tutor-setup-draft')`)), 'the carried message was left in storage');
    await page.screenshot(path.join(shots, 'setup-reload-after.png'), { width: 1100, height: 760 });
    // Nothing reloads it again.
    await sleep(3000);
    check((await page.eval('window.__marker')) === 1, 'the page reloaded a second time');
  });

  await scenario('a manual reload or update (no setup notice) keeps its own message and no page reload', async () => {
    await browser.reloadExtension();
    await waitShown(`${PANEL}.label === 'Offline'`, { what: 'Offline', timeout: 10000 });
    const panel = await page.eval(PANEL);
    check(/was updated, reloaded or turned off\. Reload this page/.test(panel.banner), panel.banner);
    await sleep(3000);
    check((await page.eval('window.__marker')) === 1, 'the page reloaded by itself');
  });

  // A fresh page in the same tab (the guard from the first reload stays).
  await page.send('Page.reload');
  await page.waitFor(`window.__marker === undefined && document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the page reloaded by the test' });
  await showPanel(page);
  await watchPanel(page);

  await scenario('a second setup restart within the guard: the page asks for a reload instead of reloading again', async () => {
    await stageSetupReload();
    await waitForWorkerReload();
    await browser.reloadExtension();
    await waitShown(`/restarted once to finish setting up the helper app\\. Reload this page/.test(${PANEL}.banner)`, { what: 'the setup reload message', timeout: 10000 });
    await sleep(3000);
    check((await page.eval('window.__marker')) === 1, 'the page reloaded again within the guard');
    check((await page.eval(PANEL)).label === 'Offline', 'label');
    await page.screenshot(path.join(shots, 'setup-reload-guarded.png'), { width: 1100, height: 760 });
  });

  await page.send('Page.reload');
  await page.waitFor(`window.__marker === undefined && document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the page reloaded by the test' });
  await page.eval(`sessionStorage.removeItem('lc-tutor-setup-reload')`);
  await showPanel(page);
  await watchPanel(page);

  await scenario('the extension never comes back: Finishing setup, then the plain reload instruction, never a page reload', async () => {
    await stageSetupReload({ real: true });
    await waitShown(`${PANEL}.label === 'Finishing setup'`, { what: 'Finishing setup', timeout: 15000 });
    await page.screenshot(path.join(shots, 'setup-reload-waiting.png'), { width: 1100, height: 760 });
    const started = Date.now();
    await waitShown(`/Reload this page to use the tutor again/.test(${PANEL}.banner)`, { what: 'the reload instruction', timeout: 45000 });
    const waited = Date.now() - started;
    check(waited > 20000, `gave up after only ${waited} ms`);
    check((await page.eval('window.__marker')) === 1, 'the page reloaded with no extension to come back to');
    await page.screenshot(path.join(shots, 'setup-reload-gave-up.png'), { width: 1100, height: 760 });
  });

  await scenario('no exceptions in the problem page', async () => {
    const errors = page.console.filter((l) => /exception/i.test(l));
    check(errors.length === 0, errors.join('\n'));
  });
} finally {
  await browser.close();
  copy.cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
