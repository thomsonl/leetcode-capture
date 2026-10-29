// End-to-end check of the Native Messaging helper with the REAL extension,
// the REAL helper (installed by helper/install.js into a temporary home) and
// the REAL relay and companion, in Playwright's cached Chromium.
//
// Nothing is written to the real browser folders: Chromium also reads
// per-user Native Messaging registrations from <user-data-dir>/
// NativeMessagingHosts, and the user data dir here is a temporary profile.
// The relay runs on a free port (CAPTURE_PORT, inherited from the browser by
// the host and its children), and the extension copy's relay address is
// rewritten to that port. The companion's settings file
// is a temporary one, and no message is ever sent to a model.
//
// What it checks, as a user would see it:
//   - with nativeMessaging not granted, the options page's Helper section
//     asks for it (a second browser grants it in the manifest, since a
//     headless browser cannot answer the prompt);
//   - with the helper not installed, the options page shows the install
//     command with this extension's id;
//   - after installing, "Check again" starts the relay and companion, the
//     panel connects, the options page says Running, and Claude can be saved;
//   - closing the last problem tab stops both 30 s later, not before;
//   - with Claude saved and the helper uninstalled again, the panel is
//     offline and points to Settings.
//
// Run with:  node extension/e2e/helper-launch.e2e.mjs   (about a minute)

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';
import { install, layout, uninstall } from '../../helper/install.js';
import { HOST_NAME } from '../../helper/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const repo = path.resolve(extensionDir, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-helper-shots';
fs.mkdirSync(shots, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
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
const relayPort = await freePort();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-helper-e2e-'));
const capturesPath = path.join(scratch, 'captures.jsonl');
fs.writeFileSync(capturesPath, '');
const env = {
  CAPTURE_PORT: String(relayPort),
  CAPTURE_LOG_PATH: capturesPath,
  LEETCODE_CAPTURES_FILE: capturesPath,
  LEETCODE_CAPTURE_SETTINGS: path.join(scratch, 'settings.json'),
  LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
  LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'companion-scratch'),
  LEETCODE_CAPTURE_HELPER_LOG_DIR: scratch,
  VAULT_AUTO_SUMMARY: '0',
};
const seenPids = new Set();

async function openOptions(browser) {
  const options = await browser.openPage('about:blank');
  await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
  await options.waitFor(`document.querySelector('input[name="provider"][value="claude"]')`, { what: 'the options page' });
  await options.eval(`document.querySelector('input[name="provider"][value="claude"]').click()`);
  await options.waitFor(`!document.getElementById('helper-card').hidden`, { what: 'the Helper section' });
  return options;
}

async function openProblem(browser) {
  const page = await browser.openPage('about:blank');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }] });
  page.on('Fetch.requestPaused', async (p) => {
    const url = new URL(p.request.url);
    const isPage = url.pathname.startsWith('/problems/');
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

// The panel follows the relay only while its tab is visible, as in a real
// browser, so the problem tab is brought to the front first.
async function showPanel(page) {
  await page.send('Page.bringToFront');
  await page.eval(`(() => {
    window.__q = (sel) => document.getElementById('lc-tutor-panel-host').shadowRoot.querySelector(sel);
    document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  })()`);
}


// ---- 1. nativeMessaging not granted ---------------------------------------
{
  const browser = await launch({ extensionDir });
  try {
    await scenario('without the permission, the Helper section asks for it', async () => {
      const options = await openOptions(browser);
      await options.waitFor(`document.getElementById('helper-state-text').textContent === 'Not allowed yet'`, { what: 'the not-allowed state' });
      const info = await options.eval(`({ button: !!document.getElementById('helper-permission'), command: !!document.querySelector('.helper-command') })`);
      check(info.button && !info.command, JSON.stringify(info));
      await options.screenshot(path.join(shots, 'helper-not-allowed.png'), { width: 900, height: 1100 });
      options.close();
    });
  } finally {
    await browser.close();
  }
}

// ---- 2. granted: not installed, then installed ----------------------------
const copy = extensionCopy(extensionDir, { extraPermissions: ['nativeMessaging'], extraHosts: [`http://localhost:${relayPort}/*`] });
// Requests a content script makes do not pass through the page's CDP Fetch
// interception, so the copy's relay address itself points at the test port.
for (const file of ['panel.js', 'content.js', 'settings.js']) {
  const target = path.join(copy.dir, file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('http://localhost:8135', `http://localhost:${relayPort}`));
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-helper-e2e-home-'));
// A real browser asks once before leetcode.com may reach localhost (Local
// Network Access); a headless one cannot ask, so the check is off here.
const browser = await launch({ extensionDir: copy.dir, env, args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
let page = null;
try {
  const options = await openOptions(browser);

  await scenario('granted but not installed: the options page shows the install command with this extension id', async () => {
    await options.waitFor(`document.getElementById('helper-state-text').textContent === 'Not installed'`, { what: 'Not installed', timeout: 10000 });
    const command = await options.eval(`document.querySelector('.helper-command code').textContent`);
    check(command === `npx leetcode-capture-helper install --chrome-id ${browser.extensionId}`, command);
    // The rest of the form is greyed out and inert while the helper is
    // missing; this card must not be.
    const style = await options.eval(`(() => { const s = getComputedStyle(document.getElementById('helper-card')); return { form: document.getElementById('form').hasAttribute('data-disabled'), pe: s.pointerEvents, opacity: s.opacity }; })()`);
    check(style.form && style.pe !== 'none' && style.opacity === '1', JSON.stringify(style));
    await options.screenshot(path.join(shots, 'helper-not-installed.png'), { width: 900, height: 1100 });
  });

  await scenario('not installed and nothing chosen yet: the panel asks for a model', async () => {
    page = await openProblem(browser);
    await page.waitFor(`window.__q('.status span') && window.__q('.status span').textContent === 'Not set up'`, { what: 'Not set up', timeout: 12000 });
  });

  const offlineWithPointer = async () => {
    await page.waitFor(`window.__q('.status span') && window.__q('.status span').textContent === 'Offline'`, { what: 'Offline', timeout: 12000 }).catch(async (err) => {
      throw new Error(`${err.message}: ${await page.eval(`JSON.stringify({ s: window.__q('.status') && window.__q('.status').textContent, b: window.__q('.banner') && window.__q('.banner').textContent })`)} ${page.console.join(' | ')}`);
    });
    await page.waitFor(`/set up the helper app in Settings/.test(window.__q('.banner').textContent)`, { what: 'the Settings pointer', timeout: 10000 });
    await page.screenshot(path.join(shots, 'panel-not-installed.png'), { width: 1100, height: 760 });
  };

  await scenario('after installing, Check again starts the relay and companion and the panel connects', async () => {
    // The real installer, into a temporary home; its Chromium registration
    // is then placed where this temporary profile looks.
    const result = install({ platform: 'linux', home, env: {}, root: repo, chromeIds: [browser.extensionId], browsers: ['chromium'] });
    check(result.registered.includes('Chromium'), JSON.stringify(result));
    const registration = layout({ platform: 'linux', home, env: {} }).targets.find((t) => t.id === 'chromium').manifestPath;
    fs.mkdirSync(path.join(browser.profile, 'NativeMessagingHosts'), { recursive: true });
    fs.copyFileSync(registration, path.join(browser.profile, 'NativeMessagingHosts', `${HOST_NAME}.json`));

    await options.eval(`document.getElementById('helper-check').click()`);
    await showPanel(page);
    await options.waitFor(`document.getElementById('helper-state-text').textContent === 'Running'`, { what: 'Running', timeout: 15000 });
    await page.waitFor(`window.__q('.status span').textContent === 'Connected'`, { what: 'the panel to connect', timeout: 20000 }).catch(async (err) => {
      const log = fs.existsSync(path.join(scratch, 'helper.log')) ? fs.readFileSync(path.join(scratch, 'helper.log'), 'utf8').slice(-1500) : '(no log)';
      throw new Error(`${err.message}: ${await page.eval(`window.__q('.status').textContent`)}\n${log}`);
    });
    const view = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
    check(view.host.relay.state === 'running' && view.host.companion.state === 'running', JSON.stringify(view.host));
    seenPids.add(view.host.relay.pid);
    seenPids.add(view.host.companion.pid);
    check(view.host.port === relayPort, `port ${view.host.port}`);
    check(!(await portFree(relayPort)), 'the relay is listening');
    await options.screenshot(path.join(shots, 'helper-running.png'), { width: 900, height: 1100 });
    await page.screenshot(path.join(shots, 'panel-connected.png'), { width: 1100, height: 760 });
  });

  await scenario('with the helper running, the Claude subscription can be saved', async () => {
    await options.waitFor(`!document.getElementById('save').disabled`, { what: 'Save to be enabled', timeout: 15000 });
    await options.click('#save');
    await options.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the save', timeout: 15000 });
  });

  await scenario('closing the last problem tab stops everything after the 30 s grace, not before', async () => {
    await page.send('Page.close');
    page = null;
    await sleep(3000);
    const view = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
    check(view.tabs === 0 && view.state === 'running', `right after closing: ${JSON.stringify(view)}`);
    await sleep(17000);
    check([...seenPids].every(isAlive), 'stopped before the grace ran out');
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && [...seenPids].some(isAlive)) await sleep(250);
    check(![...seenPids].some(isAlive), `the relay or companion is still running: ${JSON.stringify(await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`))}\n${fs.readFileSync(path.join(scratch, 'helper.log'), 'utf8').slice(-600)}`);
    check(await portFree(relayPort), 'the port is still held');
    await options.waitFor(`document.getElementById('helper-state-text').textContent === 'Installed'`, { what: 'Installed', timeout: 12000 });
  });

  await scenario('Claude saved, helper uninstalled: the panel is offline and points to Settings', async () => {
    uninstall({ platform: 'linux', home, env: {} });
    fs.rmSync(path.join(browser.profile, 'NativeMessagingHosts'), { recursive: true, force: true });
    page = await openProblem(browser);
    await offlineWithPointer();
    await options.eval(`document.getElementById('helper-check').click()`);
    await options.waitFor(`document.getElementById('helper-state-text').textContent === 'Not installed'`, { what: 'Not installed again', timeout: 10000 });
  });

  await scenario('no exceptions in the options page', async () => {
    const errors = options.console.filter((l) => /exception|error/i.test(l));
    check(errors.length === 0, errors.join('\n'));
  });
  options.close();
} finally {
  await browser.close();
  copy.cleanup();
  // Only the processes this run's helper reported as its own children.
  await sleep(500);
  for (const pid of seenPids) {
    if (isAlive(pid)) {
      console.log(`warning: stopping leftover pid ${pid}`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
