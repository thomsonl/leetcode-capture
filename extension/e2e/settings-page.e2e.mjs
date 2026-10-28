// End-to-end check of the extension's options page, running the REAL unpacked
// extension in Playwright's cached Chromium. The page's calls to the relay
// (localhost:8135/settings/rpc) are answered by a scripted stand-in for the
// companion that uses the real settings.js, so the data shapes are the real
// ones and the assertions are about what the page sends and shows.
//
// Run with:  node extension/e2e/settings-page.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-settings-shots).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
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
  const view = () => ({
    settings: publicView(st, env, SETTINGS_FILE),
    active: statusSummary(resolveEffective(st, env)),
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
        case 'test':
          return ok(testResult || { ok: true, message: 'Connected in 0.4s', reply: 'OK' });
        case 'models':
          return ok({ models });
        default:
          return fail('unknown method');
      }
    },
  };
}

const browser = await launch({ extensionDir });
let failures = 0;

async function scenario(name, mock, run) {
  const page = await browser.openPage('about:blank');
  try {
    await page.mockFetch('http://localhost:8135/*', mock.handler);
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
  }
}

// "Saving..." is shown while a request is in flight; a result replaces it.
const SAVE_DONE = `(() => { const t = document.getElementById('save-result').textContent; return t.length > 0 && t !== 'Saving...'; })()`;
const text = (page, selector) => page.eval(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
const value = (page, selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).value`);
const lastCall = (page, method) => [...page.mockedRequests].reverse().find((r) => r.body && r.body.method === method);

await scenario('first run shows the historic default (Claude subscription) and the running provider', companion(), async (page) => {
  assert.equal(await page.eval(`document.querySelector('input[name=provider]:checked').value`), 'claude');
  assert.match(await text(page, '#connection-text'), /Tutor running: Claude subscription/);
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
  await page.waitFor(`document.querySelectorAll('#local-models option').length === 2`, { what: 'model suggestions' });
  assert.match(await text(page, '#local-models-note'), /Found 2/);
  const sent = lastCall(page, 'models').body.params;
  assert.deepEqual([sent.provider, sent.baseUrl], ['local', 'http://localhost:11434/v1']);
  await page.screenshot(path.join(shots, 'local-dark.png'), { scheme: 'dark' });
  await page.screenshot(path.join(shots, 'local-light.png'), { scheme: 'light' });
});

await scenario('typing an API key tests and saves it, sends only the chosen provider, and never shows it back', companion(), async (page) => {
  const secret = 'sk-ant-TYPED-SECRET-1234567890';
  await page.click('input[name=provider][value=anthropic]');
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
  assert.equal(await page.eval(`[...document.querySelectorAll('input[name=provider]')].filter((r) => !r.disabled).map((r) => r.value).join()`), 'local', 'the provider is pinned');
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
  await page.click('#save');
  await page.waitFor(SAVE_DONE);
  assert.equal(await text(page, '#save-result'), 'model can\'t be empty');
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

await scenario('behavior options round-trip', companion(), async (page) => {
  await page.eval(`document.getElementById('autoClearContext').click()`);
  await page.type('#localMaxHistoryTurns', '3');
  await page.click('#save');
  await page.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`);
  const options = lastCall(page, 'save').body.params.patch.options;
  assert.deepEqual(options, { autoClearContext: false, vaultAutoSummary: false, localMaxHistoryTurns: 3 });
  assert.equal(await page.eval(`document.getElementById('autoClearContext').checked`), false);
});

for (const [status, pattern, kind] of [
  [503, /relay is running but the tutor isn't/, 'tutor not running'],
  [404, /older version without settings support/, 'old relay'],
]) {
  await scenario(`offline: ${kind}`, companion({ httpStatus: status }), async (page) => {
    assert.match(await text(page, '#offline'), pattern);
    assert.equal(await page.eval(`document.getElementById('save').disabled`), true);
    assert.equal(await page.eval(`document.getElementById('form').hasAttribute('data-disabled')`), true);
    await page.screenshot(path.join(shots, `offline-${status}-dark.png`), { scheme: 'dark' });
  });
}

await browser.close();
console.log(failures ? `\n${failures} scenario(s) FAILED` : `\nall scenarios passed; screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
