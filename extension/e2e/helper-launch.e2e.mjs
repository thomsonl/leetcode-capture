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
//     offline and points to Settings;
//   - with a local model saved first, choosing Claude in the form starts
//     the helper by itself (saving needs it running), switching the form back
//     lets it stop, and choosing Claude again can be saved;
//   - with nothing saved, an open problem tab does not start the helper
//     (its companion would run a default nobody chose), and Settings says
//     the helper's default is not saved instead of "Tutor running";
//   - with the permission granted while the worker and the options page
//     were running (no connectNative in either), Settings says Finishing
//     setup (never Not installed), the worker reloads once keeping the
//     unsaved choice, the next worker start opens Settings with it and the
//     helper runs, nothing saved; a page alone behind reloads itself; and an
//     API still missing after the reload asks for a browser restart without
//     reloading again.
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
    await options.waitFor(`document.getElementById('helper-state-text').textContent === 'Not installed'`, { what: 'Not installed', timeout: 10000 }).catch(async (err) => {
      // Say what the page and the worker showed, so a timeout is diagnosable.
      const seen = await options.eval(`JSON.stringify({ text: document.getElementById('helper-state-text') && document.getElementById('helper-state-text').textContent, connectNative: typeof chrome.runtime.connectNative, href: location.href })`).catch((e) => String(e));
      const view = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' }).then((v) => JSON.stringify(v))`).catch((e) => String(e));
      throw new Error(`${err.message}: page ${seen}, worker ${view}, console ${(options.console || []).join(' | ')}`);
    });
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
    // The options page holds the helper while its form shows a provider that
    // runs through it, so the form leaves that provider first.
    await options.click('input[name=provider][value=local]');
    await sleep(3000);
    const view = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
    check(view.tabs === 0 && view.state === 'running', `right after closing: ${JSON.stringify(view)}`);
    await sleep(17000);
    check([...seenPids].every(isAlive), 'stopped before the grace ran out');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && [...seenPids].some(isAlive)) await sleep(250);
    check(![...seenPids].some(isAlive), `the relay or companion is still running: ${JSON.stringify(await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`))}\n${fs.readFileSync(path.join(scratch, 'helper.log'), 'utf8').slice(-600)}`);
    check(await portFree(relayPort), 'the port is still held');
    const idle = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
    check(idle.state !== 'running' && idle.tabs === 0, `after the stop: ${JSON.stringify({ state: idle.state, tabs: idle.tabs })}`);
  });

  await scenario('Claude saved, helper uninstalled: the panel is offline and points to Settings', async () => {
    uninstall({ platform: 'linux', home, env: {} });
    fs.rmSync(path.join(browser.profile, 'NativeMessagingHosts'), { recursive: true, force: true });
    page = await openProblem(browser);
    await offlineWithPointer();
    await options.click('input[name=provider][value=claude]');
    await options.waitFor(`document.getElementById('helper-check')`, { what: 'the Helper section', timeout: 10000 });
    await options.eval(`document.getElementById('helper-check').click()`);
    // A press must visibly do something: busy button right away, then a note.
    const busy = await options.eval(`({ text: document.getElementById('helper-check').textContent, disabled: document.getElementById('helper-check').disabled })`);
    check(busy.text === 'Checking...' && busy.disabled, `busy button: ${JSON.stringify(busy)}`);
    await options.waitFor(`document.getElementById('helper-state-text').textContent === 'Not installed'`, { what: 'Not installed again', timeout: 10000 });
    await options.waitFor(`/Still not installed/.test(document.getElementById('helper-check-note')?.textContent || '')`, { what: 'the Check again note', timeout: 10000 });
    const after = await options.eval(`document.getElementById('helper-check').textContent`);
    check(after === 'Check again', `button after: ${after}`);
  });

  // A user who first saved a local model (so the saved runtime is the
  // browser's) and then picks the Claude subscription in the form: the helper
  // must start before the provider is saved, since saving needs it running.
  let second = null;
  const stateText = (o) => o.eval(`document.getElementById('helper-state-text').textContent`);
  const helperPids = async (o) => {
    const view = await o.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
    const pids = view && view.host ? [view.host.relay && view.host.relay.pid, view.host.companion && view.host.companion.pid].filter(Boolean) : [];
    for (const pid of pids) seenPids.add(pid);
    return pids;
  };
  await scenario('a local model saved, then Claude chosen in the form: the helper starts by itself and Save enables', async () => {
    const saved = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:settings-save', params: { patch: { provider: 'local', runtime: 'extension', providers: { local: { baseUrl: 'http://localhost:${relayPort}/v1', model: 'llama3.2' } } } } })`);
    check(saved && saved.ok, `saved local: ${JSON.stringify(saved)}`);
    const before = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
    check(before.runtime === 'extension', `runtime: ${before.runtime}`);
    // Its Helper section would keep asking for the helper while open.
    await options.send('Page.close');
    install({ platform: 'linux', home, env: {}, root: repo, chromeIds: [browser.extensionId], browsers: ['chromium'] });
    const registration = layout({ platform: 'linux', home, env: {} }).targets.find((t) => t.id === 'chromium').manifestPath;
    fs.mkdirSync(path.join(browser.profile, 'NativeMessagingHosts'), { recursive: true });
    fs.copyFileSync(registration, path.join(browser.profile, 'NativeMessagingHosts', `${HOST_NAME}.json`));
    // The problem tab from the last scenario is still open; the form now
    // shows Claude, and nobody presses Check again.
    second = await openOptions(browser);
    await second.waitFor(`document.getElementById('helper-state-text').textContent === 'Running'`, { what: 'Running', timeout: 20000 }).catch(async (err) => {
      throw new Error(`${err.message}: ${await stateText(second)}`);
    });
    const pids = await helperPids(second);
    check(pids.length === 2 && pids.every(isAlive), `relay and companion: ${JSON.stringify(pids)}`);
    await second.waitFor(`!document.getElementById('save').disabled`, { what: 'Save to be enabled', timeout: 15000 });
  });

  await scenario('switching the form back to the local model lets the helper stop, with nothing saved', async () => {
    const pids = await helperPids(second);
    await second.click('input[name=provider][value=local]');
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && pids.some(isAlive)) await sleep(250);
    check(!pids.some(isAlive), `the helper still runs for a local model user: ${JSON.stringify(await second.eval(`({ card: document.getElementById('helper-card').hidden, ext: (document.getElementById('local-runtime-extension') || {}).checked, help: (document.getElementById('local-runtime-helper') || {}).checked })`))} ${JSON.stringify(await second.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`))}`);
    const view = await second.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
    check(view.runtime === 'extension', `runtime: ${view.runtime}`);
  });

  await scenario('choosing Claude again starts the helper, and saving it makes the helper the runtime', async () => {
    await second.click('input[name=provider][value=claude]');
    await second.waitFor(`document.getElementById('helper-state-text').textContent === 'Running'`, { what: 'Running again', timeout: 20000 });
    // The page still holds the companion's answer from before the helper
    // stopped, so Save is enabled at once; wait for the new relay and
    // companion, as a user would after the Running light.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const view = await second.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
      if (view.host && view.host.companion && view.host.companion.state === 'running' && !(await portFree(relayPort))) break;
      await sleep(250);
    }
    await helperPids(second);
    await second.waitFor(`fetch('http://localhost:${relayPort}/settings/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'get', params: {} }) }).then((r) => r.ok, () => false)`, { what: 'the companion to answer', timeout: 15000 });
    await second.waitFor(`!document.getElementById('save').disabled`, { what: 'Save to be enabled', timeout: 15000 });
    await second.click('#save');
    await second.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the save', timeout: 30000 }).catch(async (err) => {
      throw new Error(`${err.message}: ${await second.eval(`document.getElementById('save-result').textContent + ' | ' + document.getElementById('helper-state-text').textContent`)}`);
    });
    const view = await second.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
    check(view.runtime === 'helper' && view.state === 'running', JSON.stringify({ runtime: view.runtime, state: view.state }));
    await second.screenshot(path.join(shots, 'helper-saved-after-local.png'), { width: 900, height: 1100 });
  });

  await scenario('Save with the helper gone starts it first, then saves', async () => {
    const pids = await helperPids(second);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    await sleep(500);
    await second.click('#save');
    await second.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the save after a restart', timeout: 40000 }).catch(async (err) => {
      throw new Error(`${err.message}: ${await second.eval(`document.getElementById('save-result').textContent`)}`);
    });
  });

  await scenario('no exceptions in the second options page', async () => {
    const errors = (second ? second.console : []).filter((l) => /exception|error/i.test(l));
    check(errors.length === 0, errors.join('\n'));
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
}

// ---- 3. the permission granted while the worker and the page were running --
// Chrome gives a context that was already running when the user clicked
// Allow no runtime.connectNative until it starts again (seen in a real
// Chrome on 2026-11-06). A headless browser cannot answer the prompt, so the
// permission comes from the manifest and the API is removed from the running
// worker and options page, which is the state a real grant leaves them in.
// This headless Chromium blocks any extension that calls runtime.reload()
// (even a two-file one), so the worker's reload is counted instead of done,
// and the worker start after it is a second browser on a copy of the
// profile, which runs the same start-up code.
const copy3 = extensionCopy(extensionDir, { extraPermissions: ['nativeMessaging'], extraHosts: [`http://localhost:${relayPort}/*`] });
for (const file of ['panel.js', 'content.js', 'settings.js']) {
  const target = path.join(copy3.dir, file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('http://localhost:8135', `http://localhost:${relayPort}`));
}
const lnaArgs = ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'];
// A new user: the companion has nothing saved either (section 2 saved Claude).
const env3 = { ...env, LEETCODE_CAPTURE_SETTINGS: path.join(scratch, 'settings-fresh.json') };
// Every label the Helper card shows, so a passing "Not installed" is caught.
const watchLabels = (o) =>
  o.eval(`(() => {
    window.__labels = [document.getElementById('helper-state-text').textContent];
    new MutationObserver(() => window.__labels.push(document.getElementById('helper-state-text').textContent)).observe(document.getElementById('helper-state-text'), { childList: true, characterData: true, subtree: true });
  })()`);
let browser3 = await launch({ extensionDir: copy3.dir, env: env3, args: lnaArgs });
let oldProfile = null;
try {
  install({ platform: 'linux', home, env: {}, root: repo, chromeIds: [browser3.extensionId], browsers: ['chromium'] });
  const registration = layout({ platform: 'linux', home, env: {} }).targets.find((t) => t.id === 'chromium').manifestPath;
  fs.mkdirSync(path.join(browser3.profile, 'NativeMessagingHosts'), { recursive: true });
  fs.copyFileSync(registration, path.join(browser3.profile, 'NativeMessagingHosts', `${HOST_NAME}.json`));
  const problem3 = await openProblem(browser3);

  await scenario('nothing saved: an open problem tab does not start the helper, so no default provider runs unchosen', async () => {
    await problem3.waitFor(`window.__q('.status span') && window.__q('.status span').textContent === 'Not set up'`, { what: 'Not set up', timeout: 12000 });
    await sleep(4000);
    check(await portFree(relayPort), 'the helper started a relay for a problem tab with no provider saved');
    check((await problem3.eval(`window.__q('.status span').textContent`)) === 'Not set up', 'the panel connected');
  });

  let options3 = await openOptions(browser3);
  await options3.eval(`(() => { const s = document.getElementById('claude-model'); s.value = 'opus'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await browser3.serviceWorkerEval(`(() => { self.__reloads = 0; chrome.runtime.reload = () => { self.__reloads += 1; }; delete chrome.runtime.connectNative; })()`);
  await options3.eval(`delete chrome.runtime.connectNative`);
  await watchLabels(options3);

  await scenario('granted while running: Settings says Finishing setup, never Not installed', async () => {
    await options3.waitFor(`document.getElementById('helper-state-text').textContent === 'Finishing setup'`, { what: 'Finishing setup', timeout: 12000 });
    const info = await options3.eval(`({ labels: window.__labels, body: document.getElementById('helper-body').textContent })`);
    check(!info.labels.includes('Not installed'), JSON.stringify(info.labels));
    check(/opens again by itself/.test(info.body), info.body);
    await options3.eval(`document.getElementById('helper-card').scrollIntoView({ block: 'center' })`);
    await options3.screenshot(path.join(shots, 'helper-finishing-setup.png'), { width: 900, height: 1100 });
  });

  await scenario('the worker reloads the extension once, keeping the unsaved choice to reopen Settings with', async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (await browser3.serviceWorkerEval('self.__reloads')) === 0) await sleep(200);
    // Two more 5 s polls of the page: still one reload.
    await sleep(11000);
    check((await browser3.serviceWorkerEval('self.__reloads')) === 1, `reloads: ${await browser3.serviceWorkerEval('self.__reloads')}`);
    const stored = await options3.eval(`chrome.storage.local.get(null)`);
    check(stored.nativeReload && typeof stored.nativeReload.at === 'number', JSON.stringify(stored.nativeReload));
    const r = stored.settingsResume || {};
    check(r.provider === 'claude' && r.model === 'opus' && r.runtime === 'helper' && r.reopen === true, JSON.stringify(r));
  });

  // What the reload would do next: the options page closes and the worker
  // starts again, now with connectNative.
  await browser3.close({ keepProfile: true });
  oldProfile = browser3.profile;
  browser3 = await launch({ extensionDir: copy3.dir, env: env3, args: lnaArgs, setupProfile: (dir) =>
    // The lock files name the old process, which a new one refuses to share.
    fs.cpSync(oldProfile, dir, { recursive: true, filter: (src) => !/^Singleton/.test(path.basename(src)) }),
});

  await scenario('the started worker opens Settings again with the unsaved choice, and the helper runs', async () => {
    const deadline = Date.now() + 15000;
    let target = null;
    while (Date.now() < deadline && !target) {
      target = (await browser3.listTargets()).find((t) => t.type === 'page' && t.url.includes(`${browser3.extensionId}/settings.html`));
      if (!target) await sleep(200);
    }
    check(target, 'the options page did not open');
    options3 = await browser3.attachPage((url) => url === target.url);
    await options3.waitFor(`document.querySelector('input[name="provider"][value="claude"]') && document.querySelector('input[name="provider"][value="claude"]').checked`, { what: 'Claude chosen again', timeout: 10000 }).catch(async (err) => {
      // Say what the reopened page held, so a timeout is diagnosable.
      const seen = await options3.eval(`JSON.stringify({ checked: [...document.querySelectorAll('input[name="provider"]')].filter((r) => r.checked).map((r) => r.value), note: document.getElementById('save-result') && document.getElementById('save-result').textContent, helper: document.getElementById('helper-state-text') && document.getElementById('helper-state-text').textContent, ready: document.readyState })`).catch((e) => String(e));
      const stored = await options3.eval(`chrome.storage.local.get(null).then((v) => JSON.stringify({ resume: v.settingsResume, reload: v.nativeReload }))`).catch((e) => String(e));
      throw new Error(`${err.message}: page ${seen}, storage ${stored}, console ${(options3.console || []).join(' | ')}`);
    });
    const note = await options3.eval(`document.getElementById('save-result').textContent`);
    check(/not saved yet/.test(note), note);
    await options3.waitFor(`document.getElementById('helper-state-text').textContent === 'Running'`, { what: 'Running', timeout: 20000 });
    // The model field fills in once the helper answers (it shows the helper's settings).
    await options3.waitFor(`document.getElementById('claude-model').value === 'opus'`, { what: 'the carried model', timeout: 15000 }).catch(async (err) => {
      throw new Error(`${err.message}: ${await options3.eval(`document.getElementById('claude-model').value`)}`);
    });
    const stored = await options3.eval(`chrome.storage.local.get(null)`);
    check(!stored.settingsResume, `resume record left: ${JSON.stringify(stored.settingsResume)}`);
    check(!stored.nativeReload, `reload guard left: ${JSON.stringify(stored.nativeReload)}`);
    const saved = await options3.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:settings-get' })`);
    check(saved.ok && !saved.result.settings.provider, `something was saved: ${JSON.stringify(saved.result && saved.result.settings.provider)}`);
    // The companion runs its built-in default while the page holds it up;
    // the header must not present that as a saved choice.
    const header = await options3.eval(`({ text: document.getElementById('connection-text').textContent, green: document.getElementById('connection').hasAttribute('data-ok') })`);
    check(/^Not saved yet: Claude subscription/.test(header.text) && !header.green, `header: ${JSON.stringify(header)}`);
    await helperPidsOf(options3);
    await options3.eval(`document.getElementById('helper-card').scrollIntoView({ block: 'center' })`);
    await options3.screenshot(path.join(shots, 'helper-after-setup-reload.png'), { width: 900, height: 1100 });
  });

  await scenario('only the options page behind: it reloads itself and keeps the choice', async () => {
    await options3.eval(`(() => { const s = document.getElementById('claude-model'); s.value = 'haiku'; s.dispatchEvent(new Event('change', { bubbles: true })); window.__before = 1; delete chrome.runtime.connectNative; })()`);
    await options3.waitFor(`window.__before === undefined && document.readyState === 'complete' && document.getElementById('claude-model') && document.getElementById('claude-model').value === 'haiku'`, { what: 'the page to reload with the choice', timeout: 15000 });
    await options3.waitFor(`document.getElementById('helper-state-text').textContent === 'Running'`, { what: 'Running', timeout: 15000 });
  });

  await scenario('still no API after the one reload: Settings asks for a browser restart and nothing reloads again', async () => {
    await options3.eval(`chrome.storage.local.set({ nativeReload: { at: Date.now() } })`);
    await browser3.serviceWorkerEval(`(() => { self.__reloads = 0; chrome.runtime.reload = () => { self.__reloads += 1; }; delete chrome.runtime.connectNative; })()`);
    await options3.eval(`window.__still = 1`);
    await options3.waitFor(`document.getElementById('helper-state-text').textContent === 'Restart the browser'`, { what: 'the restart note', timeout: 12000 });
    const body = await options3.eval(`document.getElementById('helper-body').textContent`);
    check(/Close every browser window/.test(body), body);
    await sleep(6000);
    check((await options3.eval(`window.__still`)) === 1, 'the page was reloaded');
    check((await browser3.serviceWorkerEval('self.__reloads')) === 0, 'the worker reloaded again');
    await options3.eval(`document.getElementById('helper-card').scrollIntoView({ block: 'center' })`);
    await options3.screenshot(path.join(shots, 'helper-restart-browser.png'), { width: 900, height: 1100 });
  });

  await scenario('no exceptions in the reopened options page', async () => {
    const errors = options3.console.filter((l) => /exception|error/i.test(l));
    check(errors.length === 0, errors.join('\n'));
  });
} finally {
  await browser3.close();
  if (oldProfile) fs.rmSync(oldProfile, { recursive: true, force: true });
  copy3.cleanup();
  await sleep(500);
  for (const pid of seenPids) {
    if (isAlive(pid)) {
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

async function helperPidsOf(o) {
  const view = await o.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:helper-status' })`);
  for (const pid of view && view.host ? [view.host.relay && view.host.relay.pid, view.host.companion && view.host.companion.pid].filter(Boolean) : []) seenPids.add(pid);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
