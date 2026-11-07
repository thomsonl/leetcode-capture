// End-to-end check of the extension's options page, running the REAL unpacked
// extension in Playwright's cached Chromium, a fresh browser (and so fresh
// extension storage) per scenario.
//
// Helper runtime: the page's calls to the relay (localhost:8135/settings/rpc)
// are answered by a scripted stand-in for the companion that uses the real
// settings.js, so the data shapes are the real ones and the assertions are
// about what the page sends and shows.
//
// Browser runtime: the page talks only to the extension's own background
// worker, which reaches stub model servers on ephemeral ports; every request
// to localhost:8135 fails as if no relay ran, so these scenarios prove the
// relay is not needed. The extension is a copy whose manifest pre-grants
// 127.0.0.1 and api.anthropic.com, since a headless browser cannot answer the
// permission prompt (a denied prompt is simulated in the page).
//
// The last scenario is live instead: a real companion.js (with a temporary
// settings file and two stub models) and the real relay it starts on a free
// port, with the page's requests to localhost:8135 sent to that port by the
// browser itself, so the relay sees the page's real extension Origin.
//
// Run with:  node extension/e2e/settings-page.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-settings-shots).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';
import {
  applyPatch,
  emptySettings,
  missingRequirement,
  publicView,
  resolveEffective,
  statusSummary,
} from '../../companion/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-settings-shots';
fs.mkdirSync(shots, { recursive: true });

const SETTINGS_FILE = '/home/you/.config/leetcode-capture/settings.json';

// A scripted companion: real settings logic, canned model list and test result.
function companion({ env = {}, stored = emptySettings(), models = ['gpt-oss:20b', 'llama3.2:latest'], testResult, saveError, httpStatus } = {}) {
  let st = stored;
  // Like the companion, a test that finds no sign-in marks it until one passes.
  let attention = null;
  const view = () => ({
    settings: publicView(st, env, SETTINGS_FILE),
    active: statusSummary(resolveEffective(st, env)),
    attention,
  });
  return {
    handler: async ({ body }) => {
      if (httpStatus) return { status: httpStatus, json: { error: 'x' } };
      const ok = (result) => ({ json: { ok: true, result } });
      const fail = (message, field) => ({ json: { ok: false, error: { message, field } } });
      switch (body.method) {
        case 'get':
          return ok(view());
        case 'save': {
          if (saveError) return fail(saveError.message, saveError.field);
          try {
            const next = applyPatch(st, body.params.patch);
            const problem = missingRequirement(resolveEffective(next, env));
            if (problem) return fail(problem, 'provider');
            st = next;
            return ok({ ...view(), saved: true });
          } catch (err) {
            return fail(err.message, err.field);
          }
        }
        case 'test': {
          const result = typeof testResult === 'function' ? testResult() : testResult || { ok: true, message: 'Connected in 0.4s', reply: 'OK' };
          attention = result.signIn ? 'signin' : result.ok ? null : attention;
          return ok(result);
        }
        case 'models':
          return ok({ models });
        case 'setProfiles':
          st = applyPatch(st, { profiles: body.params.profiles });
          return ok({ ...view(), saved: true });
        default:
          return fail('unknown method');
      }
    },
  };
}

const copy = extensionCopy(extensionDir, { extraHosts: ['http://127.0.0.1/*', 'https://api.anthropic.com/*'] });
let browser = null;
let failures = 0;

// `mock` answers the relay; null means no relay at all (every request to it
// fails).
async function scenario(name, mock, run) {
  browser = await launch({ extensionDir: copy.dir });
  const page = await browser.openPage('about:blank');
  try {
    if (mock) await page.mockFetch('http://localhost:8135/*', mock.handler);
    else await page.failFetch('http://localhost:8135/*');
    const nav = await page.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
    assert.ok(!nav.errorText, nav.errorText);
    await page.waitFor(`document.readyState === 'complete'`);
    await page.waitFor(`document.getElementById('connection-text').textContent !== 'Connecting'`, { what: 'the page to finish loading' });
    await run(page, mock);
    assert.deepEqual(page.console.filter((l) => /error|exception/i.test(l)), [], 'console errors');
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${err.stack.split('\n').slice(0, 4).join('\n      ')}`);
    await page.screenshot(path.join(shots, `FAIL-${name.replace(/\W+/g, '-')}.png`)).catch(() => {});
  } finally {
    page.close();
    await browser.close();
  }
}

// "Saving..." is shown while a request is in flight; a result replaces it.
const SAVE_DONE = `(() => { const t = document.getElementById('save-result').textContent; return t.length > 0 && t !== 'Saving...'; })()`;
const text = (page, selector) => page.eval(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
// The local model is a dropdown; a name the list lacks goes through "Other".
const pickLocalModel = async (page, name) => {
  await page.eval(`(() => {
    const s = document.getElementById('local-model');
    if (s.tagName !== 'SELECT') return;
    const has = [...s.options].some((o) => o.value === ${JSON.stringify(name)});
    s.value = has ? ${JSON.stringify(name)} : '__other__';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  if (await page.eval(`document.getElementById('local-model').tagName === 'INPUT'`)) await page.type('#local-model', name);
};
const value = (page, selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).value`);
const lastCall = (page, method) => [...page.mockedRequests].reverse().find((r) => r.body && r.body.method === method);

await scenario('first run shows the historic default (Claude subscription) and the running provider', companion(), async (page) => {
  assert.equal(await page.eval(`document.querySelector('input[name=provider]:checked').value`), 'claude');
  // The page carries the store name (the manifest's), in its heading and tab title.
  assert.equal(await text(page, 'h1'), "Thomson's LeetCode Tutor");
  assert.equal(await page.eval('document.title'), "Thomson's LeetCode Tutor settings");
  // Nothing is saved anywhere: the companion runs its built-in default, which
  // the form starts on, but the header must not call it a saved choice.
  assert.match(await text(page, '#connection-text'), /^Not saved yet: Claude subscription/);
  assert.equal(await page.eval(`document.getElementById('connection').hasAttribute('data-ok')`), false);
  assert.equal(await page.eval(`document.querySelectorAll('input[name=provider]').length`), 5);
  assert.match(await text(page, '#path'), /settings\.json/);
  await page.screenshot(path.join(shots, 'first-run-dark.png'), { scheme: 'dark' });
  await page.screenshot(path.join(shots, 'first-run-light.png'), { scheme: 'light' });
});

const localStored = applyPatch(emptySettings(), { provider: 'local', providers: { local: { model: 'gpt-oss:20b' } }, options: { vaultAutoSummary: true } });
await scenario('a saved local model fills the form, and "Find models" suggests what the server has', companion({ stored: localStored }), async (page) => {
  assert.equal(await value(page, '#local-model'), 'gpt-oss:20b');
  assert.equal(await value(page, '#local-baseUrl'), 'http://localhost:11434/v1');
  assert.equal(await value(page, '#local-contextTokens'), '8192');
  assert.equal(await page.eval(`document.getElementById('vaultAutoSummary').checked`), true);
  await page.click('#local-find');
  await page.waitFor(`/Found 2/.test(document.getElementById('local-models-note').textContent)`, { what: 'model suggestions' });
  assert.equal(await page.eval(`document.getElementById('local-model').tagName`), 'SELECT', 'the model is a dropdown');
  assert.equal(await page.eval(`document.getElementById('local-model').value`), 'gpt-oss:20b', 'the saved model stays selected after a refresh');
  assert.equal(await page.eval(`[...document.getElementById('local-model').options].some((o) => o.value === '__other__')`), true);
  const sent = lastCall(page, 'models').body.params;
  assert.deepEqual([sent.provider, sent.baseUrl], ['local', 'http://localhost:11434/v1']);
  await page.screenshot(path.join(shots, 'local-dark.png'), { scheme: 'dark' });
  await page.screenshot(path.join(shots, 'local-light.png'), { scheme: 'light' });
});

await scenario('typing an API key tests and saves it, sends only the chosen provider, and never shows it back', companion(), async (page) => {
  const secret = 'sk-ant-TYPED-SECRET-1234567890';
  await page.click('input[name=provider][value=anthropic]');
  await page.click('#anthropic-runtime-helper');
  await page.type('#anthropic-apiKey', secret);
  assert.equal(await page.eval(`document.getElementById('anthropic-apiKey').type`), 'password');
  await page.click('#test');
  await page.waitFor(`document.getElementById('test-result').textContent.includes('Connected')`, { what: 'the test result' });
  const tested = lastCall(page, 'test').body.params.patch;
  assert.equal(tested.provider, 'anthropic');
  assert.equal(tested.providers.anthropic.apiKey, secret);
  assert.deepEqual(Object.keys(tested.providers), ['anthropic'], 'only the selected provider is sent');
  await page.click('#save');
  await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'save confirmation' });
  assert.match(await text(page, '#save-result'), /Anthropic API key/);
  assert.match(await text(page, '#connection-text'), /Tutor running: Anthropic API key/);
  // After saving, the page knows a key exists but is never given it.
  assert.match(await text(page, '#anthropic-apiKey') + (await page.eval(`document.getElementById('providers').textContent`)), /A key is saved/);
  assert.equal(await page.eval(`document.documentElement.outerHTML.includes(${JSON.stringify(secret)})`), false, 'the key is not in the page');
  assert.equal(await page.eval(`document.getElementById('anthropic-apiKey')`), null, 'the key box is replaced by the saved-key line');
  // The extension only remembers that this provider runs through the helper.
  const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
  assert.deepEqual([stored.tutorSettings.provider, stored.tutorSettings.runtimes.anthropic], ['anthropic', 'helper']);
  assert.equal(JSON.stringify(stored).includes(secret), false, 'a helper key is never stored in the extension');
  await page.screenshot(path.join(shots, 'anthropic-saved-dark.png'), { scheme: 'dark' });
});

await scenario('a saved key can be replaced or removed; an environment key is shown but not editable', companion({
  stored: applyPatch(emptySettings(), { provider: 'anthropic', providers: { anthropic: { apiKey: 'sk-ant-saved-key-9999' } } }),
}), async (page) => {
  assert.match(await text(page, '#providers'), /A key is saved/);
  await page.eval(`[...document.querySelectorAll('.linkbtn')].find((b) => b.textContent === 'Remove').click()`);
  assert.match(await text(page, '#providers'), /will be removed when you save/);
  await page.click('#save');
  await page.waitFor(SAVE_DONE);
  assert.equal(lastCall(page, 'save').body.params.patch.providers.anthropic.apiKey, null, 'a removal is sent as null');
});

await scenario('an API key from the environment is reported with its source and offers no Replace/Remove', companion({
  stored: applyPatch(emptySettings(), { provider: 'openai' }),
  env: { OPENAI_API_KEY: 'sk-env-key-abcdef' },
}), async (page) => {
  assert.match(await text(page, '#providers'), /Using OPENAI_API_KEY from your environment/);
  assert.equal(await page.eval(`[...document.querySelectorAll('.linkbtn')].length`), 0);
  assert.equal(await page.eval(`document.documentElement.outerHTML.includes('sk-env-key-abcdef')`), false);
});

await scenario('environment variables lock their fields and are never sent back as edits', companion({
  stored: applyPatch(emptySettings(), { providers: { local: { model: 'saved-model' } } }),
  env: { COMPANION_BACKEND: 'local', COMPANION_MODEL: 'env-model', VAULT_AUTO_SUMMARY: '1' },
}), async (page) => {
  assert.equal(await value(page, '#local-model'), 'saved-model', 'the saved value is shown');
  assert.equal(await page.eval(`document.getElementById('local-model').disabled`), true);
  assert.match(await text(page, '#providers'), /Set by COMPANION_MODEL in your environment/);
  // The helper's provider is pinned; the ones that can run in the browser
  // stay choosable, since the environment only pins the helper.
  assert.equal(await page.eval(`[...document.querySelectorAll('input[name=provider]')].filter((r) => !r.disabled).map((r) => r.value).join()`), 'local,anthropic,openai', 'the helper provider is pinned');
  assert.equal(await page.eval(`document.getElementById('local-runtime-helper').checked`), true, 'an existing helper setup stays on the helper');
  assert.equal(await page.eval(`document.getElementById('vaultAutoSummary').disabled`), true);
  await page.click('#save');
  await page.waitFor(SAVE_DONE);
  const patch = lastCall(page, 'save').body.params.patch;
  assert.equal(patch.provider, undefined, 'a locked provider is not sent');
  assert.equal('model' in patch.providers.local, false, 'a locked model is not sent');
  assert.equal('vaultAutoSummary' in patch.options, false, 'a locked option is not sent');
  await page.screenshot(path.join(shots, 'locked-dark.png'), { scheme: 'dark' });
});

await scenario('a refused save shows the reason and focuses the offending field', companion({ saveError: { message: 'model can\'t be empty', field: 'model' } }), async (page) => {
  await page.click('input[name=provider][value=local]');
  await page.click('#local-runtime-helper');
  await page.click('#save');
  await page.waitFor(SAVE_DONE);
  assert.equal(await text(page, '#save-result'), 'Model can\'t be empty');
  assert.equal(await page.eval(`document.getElementById('save-result').getAttribute('data-kind')`), 'error');
  assert.equal(await page.eval(`document.activeElement && document.activeElement.id`), 'local-model');
});

await scenario('a failing connection test is reported as an error, not as success', companion({ testResult: { ok: false, message: 'ChatGPT sign-in: not logged in. Run "codex login".' } }), async (page) => {
  await page.click('input[name=provider][value=chatgpt]');
  assert.match(await text(page, '#providers'), /Experimental/);
  await page.click('#test');
  await page.waitFor(`document.getElementById('test-result').textContent.includes('codex login')`);
  assert.equal(await page.eval(`document.getElementById('test-result').getAttribute('data-kind')`), 'error');
});

{
  const SIGN_IN = 'Claude Code is not signed in. In a terminal, run claude and type /login, then press Test connection again.';
  let signedIn = false;
  await scenario('not signed in to Claude: Test connection says how to sign in, the header turns amber until a test passes', companion({
    stored: applyPatch(emptySettings(), { provider: 'claude' }),
    testResult: () => (signedIn ? { ok: true, message: 'Connected in 2.1s', reply: 'OK' } : { ok: false, signIn: true, message: SIGN_IN }),
  }), async (page) => {
    // The card says the same thing the error does.
    assert.match(await text(page, '#providers'), /To sign in, run claude in a terminal and type \/login\./);
    assert.match(await text(page, '#connection-text'), /^Tutor running: Claude subscription/);
    await page.click('#test');
    await page.waitFor(`document.getElementById('test-result').textContent.includes('/login')`);
    assert.equal(await text(page, '#test-result'), SIGN_IN);
    await page.waitFor(`document.getElementById('connection-text').textContent.startsWith('Sign-in needed')`, { what: 'the amber header' });
    const head = await page.eval(`(() => { const c = document.getElementById('connection'); return { state: c.getAttribute('data-state'), green: c.hasAttribute('data-ok'), dot: getComputedStyle(c.querySelector('.dot')).backgroundColor }; })()`);
    assert.deepEqual(head, { state: 'warn', green: false, dot: 'rgb(255, 161, 22)' });
    await page.screenshot(path.join(shots, 'sign-in-needed.png'), { scheme: 'dark', width: 900, height: 700 });
    signedIn = true;
    await page.click('#test');
    await page.waitFor(`document.getElementById('test-result').textContent.startsWith('Connected')`);
    await page.waitFor(`document.getElementById('connection-text').textContent.startsWith('Tutor running')`, { what: 'the header to turn green again' });
  });
}

await scenario('layout: Test connection keeps its width beside a long message, and the Save bar hides what scrolls under it', null, async (page) => {
  await page.click('input[name=provider][value=claude]');
  await page.waitFor(`!document.getElementById('helper-card').hidden`, { what: 'the Helper section' });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  const size = () => page.eval(`(() => { const r = document.getElementById('test').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const before = await size();
  await page.eval(`document.getElementById('test-result').textContent = 'Claude Code is not signed in. In a terminal, run claude and type /login, then press Test connection again.'`);
  const after = await size();
  assert.deepEqual(after, before, 'the button kept its one-line size');
  assert.equal(after.h, 32);
  // The Helper card's status line scrolled to where the bar floats: the bar
  // covers it (nothing shows through next to Save).
  await page.eval(`(() => { const r = document.getElementById('helper-state').getBoundingClientRect(); window.scrollBy(0, r.top + r.height / 2 - (innerHeight - 28)); })()`);
  // (Hit testing skips the bar while the form is greyed out, so it takes
  // pointer events for the probe only.)
  const hit = await page.eval(`(() => {
    const bar = document.querySelector('.savebar');
    bar.style.pointerEvents = 'auto';
    const r = document.getElementById('helper-state').getBoundingClientRect();
    const el = document.elementFromPoint(r.left + 4, r.top + r.height / 2);
    bar.style.pointerEvents = '';
    return { inBar: Boolean(el && el.closest('.savebar')), bg: getComputedStyle(bar).backgroundColor, opacity: getComputedStyle(bar).opacity };
  })()`);
  assert.equal(hit.inBar, true, JSON.stringify(hit));
  assert.equal(hit.opacity, '1', JSON.stringify(hit));
  assert.doesNotMatch(hit.bg, /rgba\(.*, 0\)|transparent/, JSON.stringify(hit));
  await page.screenshot(path.join(shots, 'savebar-over-helper.png'), { scheme: 'dark', width: 900, height: 700 });
});

await scenario('behavior options round-trip', companion(), async (page) => {
  await page.eval(`document.getElementById('autoClearContext').click()`);
  await page.type('#localMaxHistoryTurns', '3');
  await page.click('#save');
  await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`);
  const options = lastCall(page, 'save').body.params.patch.options;
  assert.deepEqual(options, { autoClearContext: false, vaultAutoSummary: false, localMaxHistoryTurns: 3 });
  assert.equal(await page.eval(`document.getElementById('autoClearContext').checked`), false);
});

await scenario('"Saved" shows only right after a Save: any edit clears it, a reload never brings it back, an error stays', companion(), async (page) => {
  const result = () => page.eval(`({ text: document.getElementById('save-result').textContent, kind: document.getElementById('save-result').getAttribute('data-kind') })`);
  const saveNow = async () => {
    await page.click('#save');
    await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'Saved' });
  };
  // A toggle in Behavior.
  await saveNow();
  await page.screenshot(path.join(shots, 'saved-dark.png'), { scheme: 'dark' });
  await page.eval(`document.getElementById('autoClearContext').click()`);
  assert.deepEqual(await result(), { text: '', kind: null });
  // Typing in a field.
  await saveNow();
  await page.type('#localMaxHistoryTurns', '4');
  assert.deepEqual(await result(), { text: '', kind: null });
  // A change in the models list (a button, no input event).
  await saveNow();
  const removed = await page.eval(`(() => { const b = document.querySelector('#profiles button[id$="-remove"]:not([disabled])'); if (b) b.click(); return Boolean(b); })()`);
  assert.ok(removed, 'no model to remove');
  assert.deepEqual(await result(), { text: '', kind: null });
  // Setting up the helper changes nothing Save saves, so it keeps the note.
  await saveNow();
  await page.eval(`document.getElementById('helper-card').dispatchEvent(new Event('change', { bubbles: true }))`);
  assert.match((await result()).text, /^Saved/);
  // A reload starts with no note.
  await page.send('Page.reload');
  await page.waitFor(`document.readyState === 'complete' && document.getElementById('connection-text').textContent !== 'Connecting'`, { what: 'the reloaded page' });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(await result(), { text: '', kind: null });
  // An error is not hidden by the next edit.
  await page.eval(`(() => { const r = document.getElementById('save-result'); r.textContent = 'The helper refused it.'; r.setAttribute('data-kind', 'error'); })()`);
  await page.type('#localMaxHistoryTurns', '5');
  assert.deepEqual(await result(), { text: 'The helper refused it.', kind: 'error' });
});

for (const [status, pattern, kind] of [
  [503, /relay is running but the tutor isn't/, 'tutor not running'],
  [404, /older version without settings support/, 'old relay'],
]) {
  await scenario(`offline: ${kind}`, companion({ httpStatus: status }), async (page) => {
    // With no helper, a fresh page starts on a local model in the browser,
    // which needs no helper: nothing is disabled and no warning shows.
    assert.equal(await page.eval(`document.querySelector('input[name=provider]:checked').value`), 'local');
    assert.equal(await page.eval(`document.getElementById('offline').hidden`), true);
    assert.equal(await page.eval(`document.getElementById('save').disabled`), false);
    await page.click('input[name=provider][value=claude]');
    assert.match(await text(page, '#offline'), pattern);
    assert.equal(await page.eval(`document.getElementById('save').disabled`), true);
    assert.equal(await page.eval(`document.getElementById('form').hasAttribute('data-disabled')`), true);
    await page.screenshot(path.join(shots, `offline-${status}-dark.png`), { scheme: 'dark' });
  });
}

await scenario('no helper at all: a subscription points to the Helper section, the form waits for it, and another provider can still be picked', null, async (page) => {
  await page.click('input[name=provider][value=claude]');
  await page.waitFor(`!document.getElementById('offline').hidden`, { what: 'the helper note' });
  const note = await text(page, '#offline');
  assert.match(note, /^Claude subscription runs through the helper app, which isn't set up or running yet\. Set it up in the Helper section below\./);
  // The terminal hint is a separate, secondary line, and names only the launcher.
  assert.equal(await text(page, '#offline .aside'), 'Running the tutor from a terminal instead? Start it with leetcode.');
  assert.doesNotMatch(note, /localhost:8135|companion\.js/);
  assert.equal(await page.eval(`document.getElementById('save').disabled`), true);
  assert.equal(await page.eval(`document.getElementById('form').hasAttribute('data-disabled')`), true);
  assert.equal(await page.eval(`document.getElementById('wait-note').hidden`), false);
  assert.match(await text(page, '#wait-note'), /^Waiting for the helper app/);
  await page.eval(`document.getElementById('wait-note').scrollIntoView({ block: 'end' })`);
  await page.screenshot(path.join(shots, 'helper-missing-dark.png'), { scheme: 'dark' });
  await page.screenshot(path.join(shots, 'helper-missing-light.png'), { scheme: 'light' });
  // A real mouse click (not a scripted one) still reaches another provider.
  const at = await page.eval(`(() => { const r = document.querySelector('input[name=provider][value=local]'); r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await page.waitFor(`document.querySelector('input[name=provider][value=local]').checked`, { what: 'the local model chosen by a click' });
  assert.equal(await page.eval(`document.getElementById('form').hasAttribute('data-disabled')`), false);
  assert.equal(await page.eval(`document.getElementById('wait-note').hidden`), true);
  assert.equal(await page.eval(`document.getElementById('offline').hidden`), true);
});

// ---- browser runtime: the worker runs the tutor, no relay ---------------------

// An OpenAI-compatible stub (Ollama-style /api/tags too) on an ephemeral port.
// `status` makes chat requests fail with that HTTP status.
function stubServer({ status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, origin: req.headers.origin, body: body ? JSON.parse(body) : null });
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'gemma4:26b' }] }));
      }
      if (!/\/chat\/completions$/.test(req.url)) return void res.writeHead(404).end();
      if (status !== 200) return void res.writeHead(status, { 'Content-Type': 'text/plain' }).end('Forbidden');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

{
  const model = await stubServer();
  await scenario('browser runtime: with no helper, a local model is set up, tested and saved without the relay', null, async (page) => {
    assert.equal(await page.eval(`document.querySelector('input[name=provider]:checked').value`), 'local');
    assert.equal(await page.eval(`document.getElementById('local-runtime-extension').checked`), true);
    assert.equal(await text(page, '#connection-text'), 'Not set up');
    assert.equal(await page.eval(`document.getElementById('offline').hidden`), true, 'no helper warning');
    assert.match(await text(page, '#providers'), /OLLAMA_ORIGINS=chrome-extension:\/\//);
    assert.match(await text(page, '#foot'), /extension storage/);
    await page.type('#local-baseUrl', model.url);
    await page.click('#local-find');
    await page.waitFor(`/Found 2/.test(document.getElementById('local-models-note').textContent)`, { what: 'model suggestions from the stub' });
    await pickLocalModel(page, 'qwen3:8b');
    await page.click('#test');
    await page.waitFor(`document.getElementById('test-result').textContent.includes('Connected')`, { what: 'the connection test', timeout: 20000 });
    assert.equal(await page.eval(`document.getElementById('test-result').getAttribute('data-kind')`), 'ok');
    const chat = model.requests.find((r) => /chat\/completions$/.test(r.url));
    assert.equal(chat.body.model, 'qwen3:8b');
    assert.match(chat.origin, /^chrome-extension:\/\//, 'the worker itself made the request');
    await page.click('#save');
    await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the save' });
    assert.equal(await text(page, '#save-result'), 'Saved. The tutor now runs in the browser with Local model, qwen3:8b.');
    assert.equal(await text(page, '#connection-text'), 'Tutor running in the browser: Local model, qwen3:8b');
    const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
    assert.deepEqual([stored.tutorSettings.provider, stored.tutorSettings.runtimes.local, stored.tutorSettings.providers.local.model], ['local', 'extension', 'qwen3:8b']);
    assert.ok(page.failedRequests.length > 0, 'the page did look for a helper');
    assert.ok(page.failedRequests.every((r) => /\/settings\/rpc$/.test(r.url)), 'and only asked it for settings');
    await page.screenshot(path.join(shots, 'browser-local-dark.png'), { scheme: 'dark' });
    await page.screenshot(path.join(shots, 'browser-local-light.png'), { scheme: 'light' });
  });
  model.server.close();
}

await scenario('browser runtime: an Anthropic key is saved in extension storage only, and never shown back', null, async (page) => {
  const secret = 'sk-ant-BROWSER-SECRET-0987654321';
  await page.click('input[name=provider][value=anthropic]');
  assert.equal(await page.eval(`document.getElementById('anthropic-runtime-extension').checked`), true);
  await page.type('#anthropic-apiKey', secret);
  await page.click('#save');
  await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the save' });
  assert.match(await text(page, '#save-result'), /Anthropic API key, claude-opus-5-5/);
  assert.match(await text(page, '#providers'), /A key is saved/);
  assert.equal(await page.eval(`document.documentElement.outerHTML.includes(${JSON.stringify(secret)})`), false, 'the key is not in the page');
  const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
  assert.equal(stored.tutorSecrets.anthropic, secret, 'the key is in the extension storage');
  assert.equal(JSON.stringify(stored.tutorSettings).includes(secret), false, 'and not in the settings record');
  // Reloading the page gets only hasKey back.
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('connection-text').textContent.startsWith('Tutor running in the browser')`, { what: 'the reload' });
  assert.equal(await page.eval(`document.documentElement.outerHTML.includes(${JSON.stringify(secret)})`), false);
  // Remove it again.
  await page.eval(`[...document.querySelectorAll('.linkbtn')].find((b) => b.textContent === 'Remove').click()`);
  await page.click('#save');
  await page.waitFor(SAVE_DONE);
  assert.equal(await page.eval(`document.getElementById('save-result').getAttribute('data-kind')`), 'error', 'the provider needs a key');
  assert.match(await text(page, '#save-result'), /needs an API key/);
  await page.screenshot(path.join(shots, 'browser-anthropic-dark.png'), { scheme: 'dark' });
});

await scenario('browser runtime: a denied permission prompt says what happened and saves nothing', null, async (page) => {
  await page.eval(`chrome.permissions.request = () => Promise.resolve(false)`);
  await page.type('#local-baseUrl', 'http://192.0.2.10:11434/v1');
  await pickLocalModel(page, 'llama3.2');
  await page.click('#save');
  await page.waitFor(SAVE_DONE);
  assert.equal(await page.eval(`document.getElementById('save-result').getAttribute('data-kind')`), 'error');
  assert.equal(await text(page, '#save-result'), 'The browser did not allow the extension to reach http://192.0.2.10, so the tutor can\'t use it. Press the button again and choose Allow.');
  const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
  assert.equal(stored.tutorSettings, undefined, 'nothing was saved');
  await page.click('#test');
  await page.waitFor(`document.getElementById('test-result').getAttribute('data-kind') === 'error'`);
  assert.match(await text(page, '#test-result'), /did not allow/);
});

{
  const model = await stubServer({ status: 403 });
  await scenario('browser runtime: an Ollama that refuses the extension (403) gets the OLLAMA_ORIGINS fix in the test result', null, async (page) => {
    await page.type('#local-baseUrl', model.url);
    await pickLocalModel(page, 'llama3.2');
    await page.click('#test');
    await page.waitFor(`document.getElementById('test-result').getAttribute('data-kind') === 'error'`, { what: 'the failed test', timeout: 20000 });
    const result = await text(page, '#test-result');
    assert.match(result, /refused the request \(403\)/);
    assert.match(result, new RegExp(`OLLAMA_ORIGINS=chrome-extension://${browser.extensionId}`));
  });
  model.server.close();
}


// ---- models in the Tutor tab (profiles) ----------------------------------------

const profileRows = (page) => page.eval(`[...document.querySelectorAll('#profiles .profile')].map((r) => ({
  id: r.dataset.id,
  name: r.querySelector('.profile-name') ? r.querySelector('.profile-name').textContent : null,
  meta: r.querySelector('.profile-meta') ? r.querySelector('.profile-meta').textContent : null,
  isDefault: r.hasAttribute('data-default'),
}))`);
const pickAddModel = async (page, name) => {
  await page.eval(`(() => {
    const s = document.getElementById('add-model');
    if (s.tagName === 'SELECT') { s.value = ${JSON.stringify(name)}; s.dispatchEvent(new Event('change', { bubbles: true })); }
    else s.value = ${JSON.stringify(name)};
  })()`);
};
const keyOn = async (page, selector, key) => {
  await page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key], ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
  }
};

// A real mouse click (press and release at the element's middle), so focus
// moves and blur fires as for a user; page.click only calls click().
const mouseClick = async (page, selector) => {
  const c = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
  }
};
const focusedId = (page) => page.eval(`document.activeElement ? document.activeElement.id : null`);

{
  const model = await stubServer();
  await scenario('models card: add several local models, rename, reorder, remove, choose the default and save', null, async (page) => {
    await page.type('#local-baseUrl', model.url);
    await page.click('#local-find');
    await page.waitFor(`/Found 2/.test(document.getElementById('local-models-note').textContent)`, { what: 'model suggestions' });
    await pickLocalModel(page, 'qwen3:8b');
    await page.click('#save');
    await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the first save', timeout: 20000 });
    let rows = await profileRows(page);
    assert.deepEqual(rows.map((r) => [r.name, r.isDefault]), [['qwen3:8b', true]], 'the first save makes one default model');
    assert.equal(rows[0].meta, 'Local model · in the browser');

    // Add a second local model from the same dropdown of the server's models, with a name.
    assert.equal(await page.eval(`document.getElementById('add-model').tagName`), 'SELECT', 'the add row reuses the model dropdown');
    await pickAddModel(page, 'gemma4:26b');
    await page.type('#add-label', 'Gemma');
    await page.click('#add-profile-button');
    // A model the list already has is refused.
    await pickAddModel(page, 'qwen3:8b');
    await page.click('#add-profile-button');
    assert.match(await text(page, '#profiles-note'), /already in the list/);
    // A model a provider needs must be chosen.
    await page.eval(`(() => { const s = document.getElementById('add-provider'); s.value = 'openai'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await page.click('#add-profile-button');
    assert.match(await text(page, '#profiles-note'), /Choose a model for OpenAI API key/);
    await page.eval(`(() => { const s = document.getElementById('add-provider'); s.value = 'anthropic'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await page.click('#add-profile-button');
    rows = await profileRows(page);
    assert.deepEqual(rows.map((r) => r.name), ['qwen3:8b', 'Gemma', 'claude-opus-5-5']);
    assert.equal(rows[1].meta, 'Local model · gemma4:26b · in the browser');

    // Rename with the keyboard: Enter keeps it, and focus returns to the rename button.
    const qwen = rows[0].id;
    await page.click(`#profile-${qwen}-rename`);
    assert.equal(await page.eval(`document.activeElement.id`), `profile-${qwen}-label`);
    await page.type(`#profile-${qwen}-label`, 'Qwen');
    await keyOn(page, `#profile-${qwen}-label`, 'Enter');
    assert.equal(await page.eval(`document.activeElement.id`), `profile-${qwen}-rename`);
    // Escape leaves a name as it was.
    await page.click(`#profile-${qwen}-rename`);
    await page.type(`#profile-${qwen}-label`, 'Nope');
    await keyOn(page, `#profile-${qwen}-label`, 'Escape');
    // Reorder, remove.
    const gemma = rows[1].id;
    assert.equal(await page.eval(`document.getElementById('profile-${qwen}-up').disabled`), true, 'the first cannot move up');
    await page.click(`#profile-${gemma}-up`);
    await page.click(`#profile-${rows[2].id}-remove`);
    rows = await profileRows(page);
    assert.deepEqual(rows.map((r) => r.name), ['Gemma', 'Qwen']);
    await page.screenshot(path.join(shots, 'models-card-dark.png'), { scheme: 'dark' });
    await page.screenshot(path.join(shots, 'models-card-light.png'), { scheme: 'light' });
    await page.screenshot(path.join(shots, 'models-card-narrow.png'), { scheme: 'dark', width: 420 });

    // Choosing the default moves the provider card to that model.
    await page.click(`#profile-${gemma}-radio`);
    assert.equal(await value(page, '#local-model'), 'gemma4:26b');
    await page.click('#save');
    await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the save', timeout: 20000 });
    assert.equal(await text(page, '#connection-text'), 'Tutor running in the browser: Local model, gemma4:26b');
    const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
    assert.deepEqual(stored.tutorSettings.profiles.map((p) => [p.provider, p.model, p.label]), [['local', 'gemma4:26b', 'Gemma'], ['local', 'qwen3:8b', 'Qwen']]);
    assert.equal(stored.tutorSettings.activeProfile, gemma);
    assert.equal(stored.tutorSettings.providers.local.model, 'gemma4:26b');
    // Editing the default's model in its card edits that entry.
    await pickLocalModel(page, 'qwen3:8b');
    await page.click('#save');
    await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved') && document.getElementById('connection-text').textContent.endsWith('qwen3:8b')`, { what: 'the save of an existing model', timeout: 20000 });
    const again = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
    assert.equal(again.tutorSettings.profiles.length, 2, 'picking a model already saved makes it the default, no duplicate');
    assert.equal(again.tutorSettings.profiles.find((p) => p.id === again.tutorSettings.activeProfile).label, 'Qwen');

    // A name being typed is kept when another row's rename starts, and by Save.
    await mouseClick(page, `#profile-${qwen}-rename`);
    await page.type(`#profile-${qwen}-label`, 'Qwen 3');
    await mouseClick(page, `#profile-${gemma}-rename`);
    assert.equal(await focusedId(page), `profile-${gemma}-label`, 'the other row\'s rename opened with one click');
    assert.equal((await profileRows(page)).find((r) => r.id === qwen).name, 'Qwen 3', 'the first name was kept');
    await page.type(`#profile-${gemma}-label`, 'Gemma 4');
    await mouseClick(page, '#save');
    await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved') && !document.querySelector('#profiles input[type=text]')`, { what: 'the save with a rename open', timeout: 20000 });
    const named = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
    assert.deepEqual(named.tutorSettings.profiles.map((p) => p.label).sort(), ['Gemma 4', 'Qwen 3']);
    // Tab out of a rename keeps it too.
    await mouseClick(page, `#profile-${gemma}-rename`);
    await page.type(`#profile-${gemma}-label`, 'Gemma four');
    await page.eval(`document.getElementById('add-provider').focus()`);
    assert.equal((await profileRows(page)).find((r) => r.id === gemma).name, 'Gemma four', 'leaving the field keeps the name');
    assert.equal(await focusedId(page), 'add-provider', 'and focus stays where it went');

    // The keyboard keeps its place when a choice redraws the list or the cards.
    const order = (await profileRows(page)).map((r) => r.id);
    await keyOn(page, `#profile-${order[0]}-radio`, 'ArrowDown');
    assert.equal(await focusedId(page), `profile-${order[1]}-radio`, 'an arrow on the default radios moves focus with the choice');
    assert.equal((await profileRows(page)).find((r) => r.isDefault).id, order[1]);
    const providerBefore = await page.eval(`document.querySelector('input[name=provider]:checked').id`);
    await keyOn(page, `#${providerBefore}`, 'ArrowDown');
    const providerAfter = await page.eval(`({ focused: document.activeElement.id, checked: document.querySelector('input[name=provider]:checked').id })`);
    assert.notEqual(providerAfter.checked, providerBefore);
    assert.equal(providerAfter.focused, providerAfter.checked, 'an arrow on the provider radios keeps focus on the chosen one');
    await keyOn(page, `#${providerAfter.checked}`, 'ArrowUp');
    await mouseClick(page, `#profile-${order[0]}-remove`);
    assert.equal(await focusedId(page), `profile-${order[1]}-radio`, 'removing a row focuses the row that took its place');
    await mouseClick(page, `#profile-${order[1]}-remove`);
    assert.equal(await focusedId(page), 'add-provider', 'removing the last row focuses the add row');
  });
  model.server.close();
}

await scenario('models card: subscription models are kept by the helper too, and an old single setting shows as one model', companion({
  stored: applyPatch(emptySettings(), { provider: 'claude', providers: { claude: { model: 'claude-haiku-5-5' } } }),
}), async (page) => {
  let rows = await profileRows(page);
  assert.deepEqual(rows.map((r) => [r.name, r.isDefault]), [['claude-haiku-5-5', true]], 'the old setting is one default model');
  await page.eval(`(() => { const s = document.getElementById('add-provider'); s.value = 'claude'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.deepEqual(await page.eval(`[...document.getElementById('add-model').options].map((o) => o.textContent)`), ['Default', 'Sonnet (latest)', 'Opus (latest)', 'Haiku (latest)', 'Other (type a name)...'], 'the Claude subscription offers its models in a dropdown');
  await page.eval(`(() => { const s = document.getElementById('add-model'); s.value = 'sonnet'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await page.type('#add-label', 'Sonnet');
  await page.click('#add-profile-button');
  await page.eval(`(() => { const s = document.getElementById('add-provider'); s.value = 'local'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await page.eval(`(() => { const s = document.getElementById('add-model'); s.value = '__other__'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await page.eval(`document.getElementById('add-model').tagName`), 'INPUT', '"Other" types a name in the add row');
  assert.equal(await page.eval(`document.getElementById('local-model').tagName`), 'SELECT', 'and leaves the card\'s dropdown alone');
  await page.type('#add-model', 'llama3.2');
  await page.click('#add-profile-button');
  rows = await profileRows(page);
  assert.deepEqual(rows.map((r) => r.name), ['claude-haiku-5-5', 'Sonnet', 'llama3.2']);
  assert.match(rows[1].meta, /through the helper app/);
  assert.match(rows[2].meta, /in the browser/);
  await page.click('#save');
  await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'save confirmation' });
  const patch = lastCall(page, 'save').body.params.patch;
  assert.deepEqual(patch.profiles.map((p) => p.model), ['claude-haiku-5-5', 'sonnet'], 'only the helper\'s models go to the helper');
  assert.equal(patch.activeProfile, rows[0].id);
  const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
  assert.deepEqual(stored.tutorSettings.profiles.map((p) => p.model), ['claude-haiku-5-5', 'sonnet', 'llama3.2'], 'the extension keeps the whole list');
  assert.equal(stored.tutorSettings.activeProfile, rows[0].id);
  await page.screenshot(path.join(shots, 'models-card-helper-dark.png'), { scheme: 'dark' });
});

await scenario('the Claude subscription card: a dropdown of Claude Code model names, a saved alias is selected, Other types one', companion({
  stored: applyPatch(emptySettings(), { provider: 'claude', providers: { claude: { model: 'opus' } } }),
}), async (page) => {
  const m = await page.eval(`(() => { const s = document.getElementById('claude-model'); return { tag: s.tagName, value: s.value, options: [...s.options].map((o) => o.textContent) }; })()`);
  assert.equal(m.tag, 'SELECT');
  assert.equal(m.value, 'opus', 'a saved alias is the selected one');
  assert.deepEqual(m.options, ['Default', 'Sonnet (latest)', 'Opus (latest)', 'Haiku (latest)', 'Other (type a name)...']);
  await page.eval(`(() => { const s = document.getElementById('claude-model'); s.value = '__other__'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await page.eval(`document.getElementById('claude-model').tagName`), 'INPUT', '"Other" turns it into a text box');
  await page.screenshot(path.join(shots, 'claude-model-dark.png'), { scheme: 'dark' });
});

// ---- live: the real relay and companion ------------------------------------------

function stubModel(name) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) return void res.writeHead(404).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `OK from ${name}` }, finish_reason: 'stop' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function liveScenario(name, run) {
  const modelA = await stubModel('A');
  const modelB = await stubModel('B');
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-settings-live-'));
  const settingsFile = path.join(scratch, 'config', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, provider: 'local', providers: { local: { model: 'model-a', baseUrl: modelA.url } } }));
  const captures = path.join(scratch, 'captures.jsonl');
  fs.writeFileSync(captures, '');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(COMPANION_|VAULT_AUTO_SUMMARY|ANTHROPIC_|OPENAI_)/.test(k)) delete env[k];
  const child = spawn(process.execPath, [path.resolve(here, '../../companion/companion.js')], {
    env: {
      ...env,
      LEETCODE_CAPTURE_SETTINGS: settingsFile,
      COMPANION_LOCAL_API: 'openai',
      CAPTURE_PORT: String(port),
      CAPTURE_LOG_PATH: captures,
      LEETCODE_CAPTURES_FILE: captures,
      LEETCODE_COMPANION_STATE_FILE: path.join(scratch, 'state.json'),
      LEETCODE_COMPANION_SCRATCH: path.join(scratch, 'scratch'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  browser = await launch({ extensionDir: copy.dir });
  const page = await browser.openPage('about:blank');
  try {
    const deadline = Date.now() + 15000;
    while (!out.includes('in-page panel connected')) {
      if (Date.now() > deadline) throw new Error(`the companion did not connect to its relay:\n${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.redirectFetch('http://localhost:8135/*', (url) => url.replace('http://localhost:8135', `http://localhost:${port}`));
    const nav = await page.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
    assert.ok(!nav.errorText, nav.errorText);
    await page.waitFor(`document.getElementById('connection-text').textContent !== 'Connecting'`, { what: 'the page to finish loading' });
    await run(page, { modelA, modelB, settingsFile, out: () => out });
    assert.deepEqual(page.console.filter((l) => /error|exception/i.test(l)), [], 'console errors');
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${err.stack.split('\n').slice(0, 4).join('\n      ')}`);
    await page.screenshot(path.join(shots, `FAIL-${name.replace(/\W+/g, '-')}.png`)).catch(() => {});
  } finally {
    page.close();
    await browser.close();
    child.kill();
    await exited;
    modelA.server.close();
    modelB.server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

await liveScenario('live: the page reads, tests and saves through the real relay and companion, and the companion switches models', async (page, live) => {
  assert.match(await text(page, '#connection-text'), /Tutor running: Local model, model-a/);
  const origins = new Set(page.redirectedRequests.map((r) => r.headers.Origin || r.headers.origin));
  assert.deepEqual([...origins], [`chrome-extension://${browser.extensionId}`], 'the page sends its extension origin');
  assert.equal(await value(page, '#local-model'), 'model-a');
  await pickLocalModel(page, 'model-b');
  await page.type('#local-baseUrl', live.modelB.url);
  await page.click('#test');
  await page.waitFor(`document.getElementById('test-result').textContent.includes('Connected')`, { what: 'the live connection test', timeout: 20000 });
  assert.equal(live.modelB.requests.length, 1, 'the test went to the draft model');
  assert.equal(live.modelB.requests[0].model, 'model-b');
  assert.equal(JSON.parse(fs.readFileSync(live.settingsFile, 'utf8')).providers.local.model, 'model-a', 'a test saves nothing');
  await page.click('#save');
  await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the live save', timeout: 20000 });
  assert.match(await text(page, '#connection-text'), /Tutor running: Local model, model-b/);
  const saved = JSON.parse(fs.readFileSync(live.settingsFile, 'utf8'));
  assert.deepEqual([saved.provider, saved.providers.local.model, saved.providers.local.baseUrl], ['local', 'model-b', live.modelB.url]);
  // The default saved model became model-b in place, and the companion keeps the list.
  assert.deepEqual(saved.profiles.map((p) => [p.provider, p.model]), [['local', 'model-b']]);
  assert.equal(saved.activeProfile, saved.profiles[0].id);
  assert.equal(fs.statSync(live.settingsFile).mode & 0o777, 0o600);
  const deadline = Date.now() + 5000;
  while (!live.out().includes('settings saved - now using Local model (model-b)')) {
    if (Date.now() > deadline) throw new Error(`the companion did not switch:\n${live.out()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(live.modelA.requests.length, 0);
  await page.screenshot(path.join(shots, 'live-saved-dark.png'), { scheme: 'dark' });
});

copy.cleanup();
console.log(failures ? `\n${failures} scenario(s) FAILED` : `\nall scenarios passed; screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
