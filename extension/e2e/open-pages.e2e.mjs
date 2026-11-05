// End-to-end check of the Tutor panel's header buttons in the REAL unpacked
// extension (Playwright's cached Chromium): a leetcode.com problem page is
// served by the browser itself (CDP Fetch fulfils it with panel-fixture.html).
//
// Proves: the new "Your progress" button sits between "Practice a skill" and
// the gear; it opens the extension page on its Progress tab; the gear opens
// (or moves the same page to) its Settings tab, and a page already open is
// reused, never duplicated.
//
// Run with:  node extension/e2e/open-pages.e2e.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8');

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
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const copy = extensionCopy(extensionDir, {});
const browser = await launch({ extensionDir: copy.dir });
try {
  const tab = await browser.openPage('about:blank');
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }] });
  tab.on('Fetch.requestPaused', async (p) => {
    const url = new URL(p.request.url);
    const isPage = url.pathname.startsWith('/problems/');
    await tab.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: isPage ? 200 : 404,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(isPage ? fixture : '').toString('base64'),
    });
  });
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await tab.send('Page.navigate', { url: 'https://leetcode.com/problems/two-sum/description/' });
  await tab.waitFor(`document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the problem page' });
  await tab.eval(`document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
  const q = (sel) => `document.getElementById('lc-tutor-panel-host').shadowRoot.querySelector(${JSON.stringify(sel)})`;
  await tab.waitFor(`${q('.head-right')} !== null && !${q('button.progress-open')}.hidden`, { what: 'the header buttons' });
  const optionsTabs = () => browser.serviceWorkerEval(`chrome.runtime.getContexts({ contextTypes: ['TAB'] }).then((c) => c.map((x) => x.documentUrl).filter((u) => u && u.split('#')[0] === chrome.runtime.getURL('settings.html')))`);

  await scenario('the Progress button sits between Practice a skill and the gear, same size and look', async () => {
    const m = await tab.eval(`(() => {
      const kids = [...${q('.head-right')}.children];
      const names = kids.filter((k) => !k.hidden).map((k) => k.className.split(' ')[0]);
      const b = ${q('button.progress-open')}; const pr = ${q('button.practice-open')}; const g = ${q('button.gear')};
      const rb = b.getBoundingClientRect(); const rg = g.getBoundingClientRect();
      return { names, size: [rb.width, rb.height], label: b.getAttribute('aria-label'), title: b.title, color: getComputedStyle(b).color === getComputedStyle(g).color, gap: Math.round(rg.left - rb.right), practiceFirst: pr.getBoundingClientRect().right <= rb.left };
    })()`);
    check(m.names.filter((n) => n !== 'model').join() === 'practice-open,progress-open,gear', JSON.stringify(m));
    check(m.size.join() === '24,24' && m.label === 'Your progress' && m.title === 'Your progress' && m.color && m.practiceFirst, JSON.stringify(m));
  });

  await scenario('the Progress button opens the extension page on its Progress tab', async () => {
    check((await optionsTabs()).length === 0, 'no options page yet');
    await tab.eval(`${q('button.progress-open')}.click()`);
    for (let i = 0; i < 30 && (await optionsTabs()).length === 0; i += 1) await sleep(100);
    const urls = await optionsTabs();
    check(urls.length === 1 && urls[0].endsWith('settings.html#progress'), JSON.stringify(urls));
  });

  await scenario('the gear moves that same page to Settings, and the Progress button back, with no second tab', async () => {
    await tab.eval(`${q('button.gear')}.click()`);
    for (let i = 0; i < 30 && !(await optionsTabs())[0].endsWith('#settings'); i += 1) await sleep(100);
    let urls = await optionsTabs();
    check(urls.length === 1 && urls[0].endsWith('settings.html#settings'), JSON.stringify(urls));
    await tab.eval(`${q('button.progress-open')}.click()`);
    for (let i = 0; i < 30 && !(await optionsTabs())[0].endsWith('#progress'); i += 1) await sleep(100);
    urls = await optionsTabs();
    check(urls.length === 1 && urls[0].endsWith('#progress'), JSON.stringify(urls));
  });

  await scenario('the page shows the tab it was sent to', async () => {
    const page = await browser.attachPage((u) => /settings\.html/.test(u));
    await tab.eval(`${q('button.gear')}.click()`);
    await page.waitFor(`document.getElementById('tab-settings').getAttribute('aria-selected') === 'true' && !document.getElementById('panel-settings').hidden`, { what: 'the Settings tab' });
    await tab.eval(`${q('button.progress-open')}.click()`);
    await page.waitFor(`document.getElementById('tab-progress').getAttribute('aria-selected') === 'true' && !document.getElementById('panel-progress').hidden`, { what: 'the Progress tab' });
  });
} finally {
  await browser.close();
  copy.cleanup && copy.cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
