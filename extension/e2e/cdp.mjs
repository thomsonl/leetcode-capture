// extension/e2e/cdp.mjs - a tiny Chrome DevTools Protocol harness for loading
// the real unpacked extension in Playwright's cached Chromium and driving its
// pages. No dependencies (Node's built-in WebSocket and fetch).
//
// Why: the options page and background worker only exist inside a real
// extension, and Chrome 137+ refuses --load-extension in branded builds, so the
// cached Chromium is the way to exercise them end to end in this project. See
// AGENTS.md ("Settings").
//
// These scripts are manual end-to-end checks, not part of `npm test`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findChromium() {
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort();
  if (!dirs.length) throw new Error(`no Playwright Chromium under ${root}`);
  return path.join(root, dirs[dirs.length - 1], 'chrome-linux64', 'chrome');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Page {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.console = [];
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      // A paused request whose page navigated away (a link opened in the same
      // tab) is dropped by the browser, so answering it fails with "Invalid
      // InterceptionId"; that is not a test failure. Anything else still is.
      const tolerate = (err) => {
        if (msg.method === 'Fetch.requestPaused' && /Invalid InterceptionId/.test(err?.message)) return;
        throw err;
      };
      if (msg.method && this.listeners.has(msg.method)) for (const fn of this.listeners.get(msg.method)) Promise.resolve(fn(msg.params)).catch(tolerate);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.console.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.console.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  // Answers requests matching `urlPattern` in the page itself (no network, no
  // port): handler({ url, method, body }) -> { status, json }. Lets a page be
  // tested against a scripted stand-in for the relay.
  async mockFetch(urlPattern, handler) {
    this.mockedRequests = [];
    await this.send('Fetch.enable', { patterns: [{ urlPattern }] });
    this.on('Fetch.requestPaused', async (p) => {
      const body = p.request.postData ? JSON.parse(p.request.postData) : null;
      this.mockedRequests.push({ url: p.request.url, method: p.request.method, body });
      if (p.request.method === 'OPTIONS') {
        await this.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'Content-Type' }] });
        return;
      }
      const out = await handler({ url: p.request.url, method: p.request.method, body });
      await this.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: out.status || 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(JSON.stringify(out.json ?? {})).toString('base64'),
      });
    });
  }

  // Sends requests matching `urlPattern` somewhere else instead, unchanged
  // apart from the URL (the browser's own Origin and Sec-Fetch-* headers
  // stay): rewrite(url) -> new url. Lets the real page talk to a real relay
  // on a test port without either side knowing.
  async redirectFetch(urlPattern, rewrite) {
    this.redirectedRequests = [];
    await this.send('Fetch.enable', { patterns: [{ urlPattern }] });
    this.on('Fetch.requestPaused', async (p) => {
      this.redirectedRequests.push({ url: p.request.url, method: p.request.method, headers: p.request.headers });
      await this.send('Fetch.continueRequest', { requestId: p.requestId, url: rewrite(p.request.url) });
    });
  }

  // Makes requests matching `urlPattern` fail as a network error, as if
  // nothing listened there (a page must never reach a real local relay that
  // happens to be running on the default port).
  async failFetch(urlPattern) {
    this.failedRequests = [];
    await this.send('Fetch.enable', { patterns: [{ urlPattern }] });
    this.on('Fetch.requestPaused', async (p) => {
      this.failedRequests.push({ url: p.request.url, method: p.request.method });
      await this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    // userGesture: a click made this way counts as the user's own, as the
    // browser requires before it asks for a permission.
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async waitFor(expression, { timeout = 8000, what = expression } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let value;
      try {
        value = await this.eval(expression);
      } catch {
        value = false;
      }
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  async click(selector) {
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }

  async type(selector, text) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }

  async screenshot(file, { width = 1100, height = 900, scheme = 'dark' } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await sleep(150);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

// Without `extensionDir`, launches a plain browser (no extension, no worker to
// wait for), for scripts that inject a content script into a local fixture.
// `env` is added to the browser's environment (a Native Messaging host it
// starts inherits it), and `setupProfile(dir)` runs on the fresh profile
// folder before the browser starts. `args` are extra command-line switches.
export async function launch({ extensionDir = null, port = 9300 + Math.floor(Math.random() * 600), env = {}, setupProfile = null, args = [] } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-e2e-profile-'));
  if (setupProfile) setupProfile(profile);
  const child = spawn(
    findChromium(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...(extensionDir ? [`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`] : []),
      ...args,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } }
  );
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));
  // A script that throws must not leave a headless browser behind holding its
  // port and profile directory.
  const reap = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  };
  process.once('exit', reap);

  const json = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  const deadline = Date.now() + 15000;
  let extensionId = null;
  // Chromium ships built-in extensions with their own workers, so identify ours
  // by asking each worker for its manifest name and matching the name in the
  // loaded folder's manifest (so a rename never needs a change here).
  const ourName = extensionDir ? JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')).name : null;
  const nameOf = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      const page = new Page(ws);
      return await page.eval('chrome.runtime.getManifest().name');
    } catch {
      return null;
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };
  if (!extensionDir) {
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await json('/json/version');
        break;
      } catch {
        if (Date.now() > deadline) {
          child.kill();
          throw new Error(`Chromium did not start. stderr:\n${stderr.slice(-1500)}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(200);
      }
    }
  }
  while (extensionDir && Date.now() < deadline && !extensionId) {
    try {
      const targets = await json('/json/list');
      for (const t of targets.filter((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
        // eslint-disable-next-line no-await-in-loop
        if ((await nameOf(t)) === ourName) {
          extensionId = new URL(t.url).host;
          break;
        }
      }
    } catch {
      // not up yet
    }
    if (!extensionId) await sleep(300);
  }
  if (extensionDir && !extensionId) {
    child.kill();
    throw new Error(`the extension did not load (no service worker). Chromium stderr:\n${stderr.slice(-1500)}`);
  }

  const pages = [];
  return {
    extensionId,
    stderr: () => stderr,
    async openPage(url) {
      // Creating a target directly at a chrome-extension:// URL lands on an
      // error page; open a blank one and navigate it over the protocol instead.
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      const page = new Page(ws);
      await page.send('Runtime.enable');
      await page.send('Page.enable');
      pages.push(page);
      if (url && url !== 'about:blank') {
        const nav = await page.send('Page.navigate', { url });
        if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`);
        await page.waitFor(`document.readyState === 'complete'`, { what: `${url} to load` });
      }
      return page;
    },
    async serviceWorkerEval(expression) {
      const targets = await json('/json/list');
      const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
      const ws = new WebSocket(sw.webSocketDebuggerUrl);
      await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
      const page = new Page(ws);
      const value = await page.eval(expression);
      page.close();
      return value;
    },
    async listTargets() {
      return json('/json/list');
    },
    profile,
    async close() {
      for (const p of pages) p.close();
      process.removeListener('exit', reap);
      child.kill('SIGKILL');
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

// A copy of the extension for a test run, with `extraHosts` added to its
// host_permissions and `extraPermissions` to its permissions, so permission
// checks pass without the browser's permission prompt (which a headless
// browser cannot answer).
// Returns { dir, cleanup }.
export function extensionCopy(extensionDir, { extraHosts = [], extraPermissions = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-e2e-extension-'));
  fs.cpSync(extensionDir, dir, {
    recursive: true,
    filter: (src) => !/[\\/](e2e|node_modules|web-ext-artifacts)([\\/]|$)/.test(path.relative(extensionDir, src) ? `/${path.relative(extensionDir, src)}` : ''),
  });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), ...extraHosts];
  manifest.permissions = [...(manifest.permissions || []), ...extraPermissions];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
