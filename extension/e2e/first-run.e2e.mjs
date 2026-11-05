// End-to-end check of what a brand new store user meets: the PRODUCTION
// chrome build (scripts/build.mjs, no dev seed, the manifest as shipped) in
// Playwright's cached Chromium, with empty storage, and then the error paths
// of a first setup.
//
// Part one loads the build unmodified: the Tutor tab before any model is
// chosen, the gear, the options page and the Progress tab on a first run,
// problem page address variants, corrupt storage, and the extension being
// reloaded (as on an update or a disable) under an open problem page.
// Part two loads a copy that pre-grants the stub servers' hosts (a headless
// browser cannot answer the permission prompt) for the first-setup errors:
// no local server, a 403, invalid OpenAI and Anthropic keys, and a
// subscription provider without the helper.
//
// No request may reach a real model server: the local server scenarios use a
// port nothing listens on or a stub, OpenAI uses a stub address, and
// api.anthropic.com is answered by CDP Fetch inside the worker.
//
// Run with:  node extension/e2e/first-run.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-first-run-shots).

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';
import { build } from '../scripts/build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-first-run-shots';
fs.mkdirSync(shots, { recursive: true });

const buildDir = build({ browser: 'chrome', out: fs.mkdtempSync(path.join(os.tmpdir(), 'lc-first-run-build-')) });

const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8').replace(
  '</head>',
  `<script>
  window.__editorCode = 'class Solution:\\n    def twoSum(self, nums, target):\\n        return []\\n';
  window.monaco = { editor: { getEditors: () => [{
    getDomNode: () => document.getElementById('pane-code'),
    getModel: () => ({ getValue: () => window.__editorCode, getLanguageId: () => 'python' }),
  }] } };
</script>
</head>`
);

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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const helpers = `(() => {
  window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
  window.__q = (sel) => window.__root().querySelector(sel);
  window.__openTutor = () => document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  window.__status = () => (window.__q('.status span') || {}).textContent || '';
  window.__banner = () => { const b = window.__q('.banner'); return b && !b.hidden ? b.textContent : ''; };
})()`;

// A problem page at `pathname`, served from the fixture; every request to
// the relay fails, as with no helper installed.
async function openProblem(browser, pathname, relayRequests = []) {
  const tab = await browser.openPage('about:blank');
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }, { urlPattern: 'http://localhost:8135/*' }] });
  tab.on('Fetch.requestPaused', async (p) => {
    const url = new URL(p.request.url);
    if (url.host === 'localhost:8135') {
      relayRequests.push(p.request.url);
      await tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
      return;
    }
    const isPage = url.pathname.startsWith('/problems/');
    await tab.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: isPage ? 200 : 404,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(isPage ? fixture : '').toString('base64'),
    });
  });
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await tab.send('Page.navigate', { url: `https://leetcode.com${pathname}` });
  await tab.waitFor(`document.readyState === 'complete'`, { what: `${pathname} to load` });
  await tab.eval(helpers);
  return tab;
}

async function openOptions(browser, hash = '') {
  const options = await browser.openPage('about:blank');
  await options.failFetch('http://localhost:8135/*');
  await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html${hash}` });
  await options.waitFor(`document.readyState === 'complete'`, { what: 'the options page' });
  return options;
}

const exceptions = (...pages) => pages.flatMap((p) => p.console).filter((l) => /exception|error/i.test(l));

// ---- part one: the production build, unmodified ------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8'));
await scenario('the production build: no dev seed, no extra hosts, no background.scripts', async () => {
  check(!fs.existsSync(path.join(buildDir, 'dev-seed.json')), 'dev-seed.json is in the build');
  check(JSON.stringify(manifest.host_permissions) === JSON.stringify(['http://localhost:8135/*']), `host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
  check(!('scripts' in manifest.background), 'background.scripts is in the chrome build');
  check(!('key' in manifest), 'the manifest carries a key');
});

const browser = await launch({ extensionDir: buildDir });
const allPages = [];
try {
  await scenario('the worker starts with empty storage and no seed', async () => {
    const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
    check(Object.keys(stored).length === 0, `storage after install: ${JSON.stringify(stored)}`);
  });

  const relayRequests = [];
  const page = await openProblem(browser, '/problems/two-sum/description/', relayRequests);
  allPages.push(page);

  await scenario('a problem page before any model is chosen: the Tutor tab says "Not set up" and points to the gear', async () => {
    await page.waitFor(`document.querySelector('[data-lc-tutor-tab]')`, { what: 'the Tutor tab' });
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__status() === 'Not set up'`, { what: '"Not set up"', timeout: 10000 });
    const banner = await page.eval('window.__banner()');
    check(/extension options \(the gear above\)/.test(banner) && /nothing else installed/.test(banner), `banner: ${banner}`);
    const composer = await page.eval(`({ disabled: window.__q('textarea').disabled, placeholder: window.__q('textarea').placeholder })`);
    check(composer.disabled && composer.placeholder === 'Choose a model to chat', `composer: ${JSON.stringify(composer)}`);
    await page.screenshot(path.join(shots, 'not-set-up-dark.png'), { width: 1100, height: 760 });
  });

  await scenario('the gear opens the options page', async () => {
    const before = (await browser.listTargets()).filter((t) => /\/settings\.html(#settings)?$/.test(t.url)).length;
    await page.eval(`window.__q('.gear').click()`);
    const deadline = Date.now() + 5000;
    let after = before;
    while (Date.now() < deadline && after === before) {
      await pause(200);
      after = (await browser.listTargets()).filter((t) => /\/settings\.html(#settings)?$/.test(t.url)).length;
    }
    check(after === before + 1, `options pages: ${before} then ${after}`);
  });

  await scenario('the options page on a first run: "Not set up", Local model picked, the real extension id in the Ollama hint', async () => {
    const options = await openOptions(browser);
    allPages.push(options);
    await options.waitFor(`document.getElementById('connection-text').textContent === 'Not set up'`, { what: '"Not set up"' });
    check((await options.eval(`document.querySelector('input[name=provider]:checked').value`)) === 'local', 'Local model is not the first choice');
    const providers = await options.eval(`document.getElementById('providers').textContent`);
    check(providers.includes(`OLLAMA_ORIGINS=chrome-extension://${browser.extensionId}`), 'the hint does not carry this extension id');
    await options.screenshot(path.join(shots, 'options-first-run-dark.png'), { width: 1280, height: 900 });
    options.close();
  });

  await scenario('the Progress tab with empty storage: NeetCode 150, nothing solved, a first problem to start with', async () => {
    const progress = await openOptions(browser, '#progress');
    allPages.push(progress);
    await progress.waitFor(`document.querySelector('#panel-progress') && !document.querySelector('#panel-progress').hidden && document.querySelectorAll('#panel-progress .node, #panel-progress [data-topic]').length > 0`, { what: 'the Progress graph', timeout: 10000 });
    const text = await progress.eval(`document.getElementById('panel-progress').textContent`);
    check(/NeetCode 150/.test(text), 'NeetCode 150 is not shown');
    check(/0\s*(of|\/)\s*150/.test(text), `no "0 of 150": ${text.slice(0, 400)}`);
    await progress.screenshot(path.join(shots, 'progress-empty-dark.png'), { width: 1280, height: 900 });
    progress.close();
  });

  await scenario('address variants: the tab mounts on every problem path and reads the slug from it', async () => {
    for (const pathname of ['/problems/two-sum', '/problems/two-sum/', '/problems/two-sum/submissions/', '/problems/two-sum/submissions/1234567/', '/problems/two-sum/editorial/', '/problems/two-sum/solutions/', '/problems/two-sum/description/?envType=study-plan-v2&envId=top-interview-150']) {
      const tab = await openProblem(browser, pathname);
      allPages.push(tab);
      await tab.waitFor(`document.querySelector('[data-lc-tutor-tab]')`, { what: `the Tutor tab on ${pathname}` });
      await tab.eval('window.__openTutor()');
      await tab.waitFor(`window.__status() === 'Not set up'`, { what: `"Not set up" on ${pathname}` });
      tab.close();
    }
  });

  await scenario('corrupt storage: the panel, the options page and the Progress tab still work', async () => {
    await browser.serviceWorkerEval(`chrome.storage.local.set({
      tutorSettings: 'garbage', tutorSecrets: 5, solvedProblems: ['two-sum'], starredProblems: null,
      activeProgressList: 42, tutorTabPosition: { mode: 'tabset', anchors: 'x' },
    })`);
    const tab = await openProblem(browser, '/problems/two-sum/');
    allPages.push(tab);
    await tab.waitFor(`document.querySelector('[data-lc-tutor-tab]')`, { what: 'the Tutor tab' });
    await tab.eval('window.__openTutor()');
    await tab.waitFor(`window.__status() === 'Not set up'`, { what: '"Not set up" with corrupt storage' });
    const options = await openOptions(browser);
    allPages.push(options);
    await options.waitFor(`document.getElementById('connection-text').textContent === 'Not set up'`, { what: 'the options page with corrupt storage' });
    const progress = await openOptions(browser, '#progress');
    allPages.push(progress);
    await progress.waitFor(`/NeetCode 150/.test(document.getElementById('panel-progress').textContent)`, { what: 'the Progress tab with corrupt storage', timeout: 10000 });
    await browser.serviceWorkerEval(`chrome.storage.local.clear()`);
    tab.close();
    options.close();
    progress.close();
  });

  await scenario('the extension reloaded under an open page (an update or a disable): the panel says to reload the page', async () => {
    await page.send('Page.bringToFront');
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__status() === 'Not set up'`, { what: 'the panel before the reload' });
    await browser.serviceWorkerEval(`setTimeout(() => chrome.runtime.reload(), 50), true`).catch(() => {});
    await page.waitFor(`window.__status() !== 'Not set up'`, { what: 'the panel to notice', timeout: 10000 });
    await pause(1500);
    const seen = await page.eval(`({ status: window.__status(), banner: window.__banner(), placeholder: window.__q('textarea').placeholder })`);
    check(/was updated, reloaded or turned off\. Reload this page/.test(seen.banner) && seen.placeholder === 'Reload the page to chat', `after the reload: ${JSON.stringify(seen)}`);
    await page.screenshot(path.join(shots, 'extension-reloaded-dark.png'), { width: 1100, height: 760 });
  });

  await scenario('the problem pages only looked for a terminal tutor on the relay, and threw nothing', async () => {
    // With nothing chosen the panel looks for a tutor started from a terminal
    // (the relay's event stream), and for nothing else.
    check(relayRequests.every((u) => /^http:\/\/localhost:8135\/panel\/events\?/.test(u)), `relay requests: ${JSON.stringify(relayRequests)}`);
    const errors = exceptions(...allPages);
    check(errors.length === 0, errors.join('\n'));
  });
} finally {
  await browser.close();
}

// ---- part two: first-setup errors, with the stub hosts pre-granted -------------

// A port nothing listens on.
const closedPort = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// A stub that answers every request with `status` and an error body shaped
// like the provider's.
function stub(status, body) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const copy = extensionCopy(buildDir, { extraHosts: ['http://127.0.0.1/*', 'https://api.anthropic.com/*'] });
const browser2 = await launch({ extensionDir: copy.dir });
const pages2 = [];
const testResult = (options) => options.eval(`({ kind: document.getElementById('test-result').getAttribute('data-kind'), text: document.getElementById('test-result').textContent })`);
async function testWith(options, setup) {
  await options.eval(`document.getElementById('test-result').textContent = ''`);
  await setup();
  await options.click('#test');
  await options.waitFor(`['ok', 'error'].includes(document.getElementById('test-result').getAttribute('data-kind'))`, { what: 'the connection test', timeout: 30000 });
  return testResult(options);
}
async function pickLocal(options, baseUrl) {
  await options.click('input[name=provider][value=local]');
  await options.type('#local-baseUrl', baseUrl);
  await options.eval(`(() => { const s = document.getElementById('local-model'); if (s.tagName === 'SELECT') { s.value = '__other__'; s.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await options.type('#local-model', 'llama3.2');
}
try {
  const options = await openOptions(browser2);
  pages2.push(options);
  await options.waitFor(`document.getElementById('connection-text').textContent === 'Not set up'`, { what: 'the options page' });

  await scenario('a local model with no server running: says so, with the OLLAMA_ORIGINS fix for this extension id', async () => {
    const r = await testWith(options, () => pickLocal(options, `http://127.0.0.1:${closedPort}/v1`));
    check(r.kind === 'error', JSON.stringify(r));
    check(r.text.includes(`Couldn't reach the local server at http://127.0.0.1:${closedPort}/v1`), r.text);
    check(r.text.includes(`OLLAMA_ORIGINS=chrome-extension://${browser2.extensionId}`), r.text);
    await options.screenshot(path.join(shots, 'local-unreachable-dark.png'), { width: 1280, height: 900 });
  });

  await scenario('a local server answering 403: the refusal and the same fix', async () => {
    const s = await stub(403, { error: 'forbidden' });
    try {
      const r = await testWith(options, () => pickLocal(options, s.url));
      check(r.kind === 'error' && /refused the request \(403\)/.test(r.text), JSON.stringify(r));
      check(r.text.includes(`OLLAMA_ORIGINS=chrome-extension://${browser2.extensionId}`), r.text);
    } finally {
      s.server.close();
    }
  });

  await scenario('an invalid OpenAI key: the provider\'s own reason, and nothing saved', async () => {
    const s = await stub(401, { error: { message: 'Incorrect API key provided: sk-bad. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', code: 'invalid_api_key' } });
    try {
      const r = await testWith(options, async () => {
        await options.click('input[name=provider][value=openai]');
        await options.type('#openai-apiKey', 'sk-bad');
        await options.type('#openai-baseUrl', s.url);
        await options.type('#openai-model', 'gpt-5-mini');
      });
      check(r.kind === 'error' && /Incorrect API key/.test(r.text) && /401/.test(r.text), JSON.stringify(r));
      check(!r.text.includes('OLLAMA_ORIGINS'), 'the Ollama fix shows for OpenAI');
      const stored = await browser2.serviceWorkerEval(`chrome.storage.local.get(null)`);
      check(!stored.tutorSecrets, `a key was stored by a test: ${JSON.stringify(stored)}`);
    } finally {
      s.server.close();
    }
  });

  await scenario('an invalid Anthropic key: the provider\'s own reason', async () => {
    // api.anthropic.com is answered inside the worker by CDP Fetch.
    const sw = (await browser2.listTargets()).find((t) => t.type === 'service_worker' && t.url.includes(browser2.extensionId));
    const ws = new WebSocket(sw.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    let id = 1;
    const seen = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method !== 'Fetch.requestPaused') return;
      seen.push(msg.params.request.url);
      const headers = [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }];
      if (msg.params.request.method === 'OPTIONS') {
        ws.send(JSON.stringify({ id: id++, method: 'Fetch.fulfillRequest', params: { requestId: msg.params.requestId, responseCode: 204, responseHeaders: [...headers, { name: 'Access-Control-Allow-Headers', value: '*' }] } }));
        return;
      }
      const body = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })).toString('base64');
      ws.send(JSON.stringify({ id: id++, method: 'Fetch.fulfillRequest', params: { requestId: msg.params.requestId, responseCode: 401, responseHeaders: headers, body } }));
    });
    ws.send(JSON.stringify({ id: id++, method: 'Fetch.enable', params: { patterns: [{ urlPattern: 'https://api.anthropic.com/*' }] } }));
    await pause(300);
    try {
      const r = await testWith(options, async () => {
        await options.click('input[name=provider][value=anthropic]');
        await options.type('#anthropic-apiKey', 'sk-ant-bad');
      });
      check(seen.length > 0, 'nothing reached api.anthropic.com');
      check(r.kind === 'error' && r.text === 'The Anthropic API key was refused (401). Check the key in the options page.', JSON.stringify(r));
      await options.screenshot(path.join(shots, 'anthropic-bad-key-dark.png'), { width: 1280, height: 900 });
    } finally {
      ws.close();
    }
  });

  await scenario('a subscription provider without the helper: the page points to the Helper section, which asks for the permission first', async () => {
    await options.click('input[name=provider][value=claude]');
    await options.waitFor(`!document.getElementById('offline').hidden`, { what: 'the offline note' });
    const seen = await options.eval(`({
      offline: document.getElementById('offline').textContent,
      helperHidden: document.getElementById('helper-card').hidden,
      helper: document.getElementById('helper-card').textContent,
      allow: !!document.getElementById('helper-permission'),
      saveDisabled: document.getElementById('save').disabled,
    })`);
    check(/Set it up in the Helper section below/.test(seen.offline), `offline note: ${seen.offline}`);
    check(!seen.helperHidden && seen.allow && /needs Node/.test(seen.helper), `helper section: ${seen.helper}`);
    check(seen.saveDisabled, 'Save is enabled with nothing to save to');
    await options.screenshot(path.join(shots, 'subscription-no-helper-dark.png'), { width: 1280, height: 1300 });
  });

  await scenario('no exceptions in the options page', async () => {
    const errors = exceptions(...pages2);
    check(errors.length === 0, errors.join('\n'));
  });
  await scenario('with a model chosen, an update under an open page: the panel goes offline and says to reload', async () => {
    const saved = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:settings-save', params: { patch: { provider: 'local', runtime: 'extension', providers: { local: { baseUrl: 'http://127.0.0.1:${closedPort}/v1', model: 'llama3.2' } } } } })`);
    check(saved && saved.ok, `saved: ${JSON.stringify(saved)}`);
    const tab = await openProblem(browser2, '/problems/two-sum/description/');
    pages2.push(tab);
    await tab.waitFor(`document.querySelector('[data-lc-tutor-tab]')`, { what: 'the Tutor tab' });
    await tab.eval('window.__openTutor()');
    await tab.waitFor(`window.__status() === 'Connected'`, { what: 'Connected', timeout: 10000 });
    await browser2.serviceWorkerEval(`setTimeout(() => chrome.runtime.reload(), 50), true`).catch(() => {});
    await tab.waitFor(`/was updated, reloaded or turned off/.test(window.__banner())`, { what: 'the reload note', timeout: 10000 });
    const seen = await tab.eval(`({ status: window.__status(), disabled: window.__q('textarea').disabled, placeholder: window.__q('textarea').placeholder, empty: (window.__q('.feed .empty') || {}).textContent })`);
    check(seen.status === 'Offline' && seen.disabled && seen.placeholder === 'Reload the page to chat' && /After you reload this page/.test(seen.empty), JSON.stringify(seen));
    await tab.screenshot(path.join(shots, 'extension-updated-with-model-dark.png'), { width: 1100, height: 760 });
  });
} finally {
  await browser2.close();
  copy.cleanup();
  fs.rmSync(buildDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
