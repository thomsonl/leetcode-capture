// End-to-end check of "Sync from LeetCode" in the REAL unpacked extension
// (Playwright's cached Chromium): a leetcode.com problem page is served by the
// browser itself (CDP Fetch fulfils it with panel-fixture.html) and so is
// LeetCode's /graphql/ problem list, scripted per scenario.
//
// Proves: with no LeetCode tab open the button says to open one; opening a
// problem page syncs on its own once (the worker is asked whether one is
// due); the button adds only what is missing and keeps hand marks and
// detected solves; a signed-out tab is reported; a second page load inside
// 12 hours does not sync again; the tab order is Progress then Settings.
//
// Run with:  node extension/e2e/sync.e2e.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8').replace('<head>', '<head><script>window.__nativeFetch = window.fetch.bind(window);</script>');

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

// What the account has accepted, and whether it is signed in.
const account = { signedIn: true, slugs: Array.from({ length: 130 }, (_, i) => `synced-problem-${i}`) };
const graphqlCalls = [];

const copy = extensionCopy(extensionDir, {});
const browser = await launch({ extensionDir: copy.dir });
try {
  const options = await browser.openPage('about:blank');
  await options.failFetch('http://localhost:8135/*');
  await options.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html#progress` });
  await options.waitFor(`document.getElementById('sync-btn')`, { what: 'the Progress tab' });
  const stored = () => browser.serviceWorkerEval(`chrome.storage.local.get(['solvedProblems', 'solvedSyncedAt']).then((s) => s)`);
  const sync = async () => {
    await options.eval(`document.getElementById('sync-status').textContent = ''; document.getElementById('sync-btn').click()`);
    await options.waitFor(`document.getElementById('sync-status').textContent && !/Syncing/.test(document.getElementById('sync-status').textContent)`, { what: 'the sync answer' });
    return options.eval(`document.getElementById('sync-status').textContent`);
  };

  await scenario('the tabs read Progress then Settings', async () => {
    const tabs = await options.eval(`[...document.querySelectorAll('.tab')].map((t) => t.textContent).join()`);
    check(tabs === 'Progress,Settings', tabs);
  });

  await scenario('with no LeetCode tab open the button says to open one', async () => {
    const text = await sync();
    check(/Open any LeetCode problem page/.test(text), text);
    check(!(await stored()).solvedProblems, 'nothing is stored');
  });

  const openProblem = async (slug) => {
    const tab = await browser.openPage('about:blank');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }] });
    tab.on('Fetch.requestPaused', async (p) => {
      const url = new URL(p.request.url);
      if (url.pathname === '/graphql/') {
        const { query, variables } = JSON.parse(p.request.postData);
        // LeetCode rejects an inline enum string (status: "AC"): it must be a typed variable.
        if (/status:\s*"/.test(query) || !/\$filters: QuestionListFilterInput/.test(query) || variables.filters.status !== 'AC') {
          await tab.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 400, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"errors":[{"message":"invalid filters"}]}').toString('base64') });
          return;
        }
        graphqlCalls.push(variables.skip);
        const questions = account.slugs.slice(variables.skip, variables.skip + variables.limit).map((titleSlug) => ({ titleSlug, status: 'ac' }));
        const data = { userStatus: { isSignedIn: account.signedIn }, problemsetQuestionList: { total: account.slugs.length, questions } };
        await tab.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify({ data })).toString('base64'),
        });
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
    await tab.send('Page.navigate', { url: `https://leetcode.com/problems/${slug}/description/` });
    await tab.waitFor(`document.readyState === 'complete'`, { what: `the ${slug} page` });
    return tab;
  };

  const tab = await openProblem('two-sum');
  await scenario('opening a problem page syncs on its own, 100 at a time', async () => {
    for (let i = 0; i < 40 && !(await stored()).solvedSyncedAt; i += 1) await new Promise((r) => setTimeout(r, 150));
    const s = await stored();
    check(s.solvedSyncedAt, 'no sync time stored');
    check(Object.keys(s.solvedProblems).length === 130, `solved: ${Object.keys(s.solvedProblems).length}`);
    check(s.solvedProblems['synced-problem-0'].synced === true && s.solvedProblems['synced-problem-0'].count === 0, JSON.stringify(s.solvedProblems['synced-problem-0']));
    check(graphqlCalls.join() === '0,100', `pages: ${graphqlCalls}`);
  });

  await scenario('the button adds only what is missing and keeps hand marks and detected solves', async () => {
    await browser.serviceWorkerEval(`chrome.storage.local.get('solvedProblems').then((s) => chrome.storage.local.set({ solvedProblems: { ...s.solvedProblems, 'by-hand': { at: '2026-11-01T00:00:00.000Z', count: 0, manual: true }, 'synced-problem-1': { at: '2026-11-02T00:00:00.000Z', count: 3 } } }))`);
    account.slugs.push('brand-new-solve');
    const text = await sync();
    check(/Added 1 problem from LeetCode \(131 solved there\)/.test(text), text);
    const s = (await stored()).solvedProblems;
    check(s['by-hand'].manual === true && s['synced-problem-1'].count === 3 && !s['synced-problem-1'].synced, 'marks changed');
    check(s['brand-new-solve'].synced === true && Object.keys(s).length === 132, `count ${Object.keys(s).length}`);
    check(/Up to date: 131 problems/.test(await sync()), 'a second press adds nothing');
  });

  await scenario('a signed-out LeetCode tab is reported and nothing is added', async () => {
    account.signedIn = false;
    account.slugs.push('would-be-added');
    const text = await sync();
    check(/Sign in to LeetCode/.test(text), text);
    check(!(await stored()).solvedProblems['would-be-added'], 'added while signed out');
    account.signedIn = true;
  });

  await scenario('a synced problem shows its own tip on the Progress tab', async () => {
    await options.send('Page.reload');
    await options.waitFor(`document.getElementById('sync-btn')`, { what: 'the reloaded tab' });
    const shown = await options.eval(`(async () => { document.querySelector('.node, .group').click(); await new Promise((r) => setTimeout(r, 200)); return [...document.querySelectorAll('.mark')].map((m) => m.title).filter(Boolean).length > 0; })()`);
    check(shown === true, 'no marks in the panel');
  });

  await scenario('a page load inside 12 hours does not sync again', async () => {
    const before = graphqlCalls.length;
    await tab.send('Page.reload');
    await tab.waitFor(`document.readyState === 'complete'`, { what: 'the reload' });
    await new Promise((r) => setTimeout(r, 800));
    check(graphqlCalls.length === before, `${graphqlCalls.length - before} new calls`);
  });
} finally {
  await browser.close();
  copy.cleanup && copy.cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
