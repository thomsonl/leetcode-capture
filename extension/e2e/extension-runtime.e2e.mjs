// End-to-end check of the "extension" runtime: the REAL unpacked extension in
// Playwright's cached Chromium runs the tutor in its own background worker,
// with no relay and no companion anywhere. The only server is a stub
// OpenAI-compatible model on an ephemeral port that streams its replies
// slowly, so streaming is visible.
//
// The model is set up the way a user would, on the options page. The problem
// page is https://leetcode.com/problems/two-sum/ served by the browser itself
// (CDP Fetch fulfils it with panel-fixture.html plus a fake Monaco), so the
// extension's real content scripts load on it exactly as on the real site.
// Every request to localhost:8135 from that page fails and is recorded, to
// prove the relay is never used.
//
// The extension is a copy whose manifest pre-grants 127.0.0.1 (a headless
// browser cannot answer the permission prompt).
//
// Run with:  node extension/e2e/extension-runtime.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-runtime-shots).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';
import { TUTOR_SYSTEM_MESSAGE } from '../shared/tutor-prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-runtime-shots';
fs.mkdirSync(shots, { recursive: true });

// The fixture with a stand-in for LeetCode's Monaco, defined in the page's
// own world where inject.js looks for it.
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

// The stub model: streams "Reply N: part one ... part three." in pieces.
const model = { requests: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) return void res.writeHead(404).end();
    const parsed = JSON.parse(body);
    model.requests.push({ origin: req.headers.origin, body: parsed });
    const n = model.requests.length;
    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const pieces = [`Reply ${n}: part one`, ', part two', ', part three.'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < pieces.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] })}\n\n`);
        i += 1;
        return;
      }
      clearInterval(timer);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    }, 400);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${server.address().port}/v1`;

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

const copy = extensionCopy(extensionDir, { extraHosts: ['http://127.0.0.1/*'] });
const browser = await launch({ extensionDir: copy.dir });
try {
  await scenario('the options page sets up a local model in the browser, with no relay', async () => {
    const options = await browser.openPage('about:blank');
    await options.failFetch('http://localhost:8135/*');
    await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
    await options.waitFor(`document.getElementById('connection-text').textContent === 'Not set up'`, { what: 'the options page' });
    await options.type('#local-baseUrl', modelUrl);
    // The model is a dropdown of what the server lists; this stub lists
    // nothing, so it is typed through "Other".
    await options.eval(`(() => { const s = document.getElementById('local-model'); s.value = '__other__'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await options.type('#local-model', 'stub-model');
    await options.click('#save');
    await options.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the save' });
    options.close();
  });

  // A problem page, served by the browser from the fixture. Every page
  // records its requests to the relay in relayRequests.
  const relayRequests = [];
  const helpers = `(() => {
    window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
    window.__q = (sel) => window.__root().querySelector(sel);
    window.__qa = (sel) => [...window.__root().querySelectorAll(sel)];
    window.__openTutor = () => document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    window.__replies = () => window.__qa('.feed .tutor').map((n) => n.textContent);
    window.__feed = () => window.__qa('.feed > *').map((n) => n.className.split(' ')[0] + ': ' + n.textContent);
    window.__send = (text) => {
      const t = window.__q('textarea');
      t.value = text;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    window.__run = () => document.getElementById('editor-button').dispatchEvent(new KeyboardEvent('keydown', { key: "'", ctrlKey: true, bubbles: true }));
  })()`;
  async function openProblem(slug) {
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
    await tab.send('Page.navigate', { url: `https://leetcode.com/problems/${slug}/description/` });
    await tab.waitFor(`document.readyState === 'complete'`, { what: `the ${slug} page` });
    await tab.eval(helpers);
    return tab;
  }
  // A background tab draws nothing (the panel renders on animation frames),
  // so a tab is brought to the front before its feed is read.
  async function front(tab) {
    await tab.send('Page.bringToFront');
    await new Promise((r) => setTimeout(r, 200));
    await tab.eval('window.__openTutor()');
    await new Promise((r) => setTimeout(r, 200));
  }
  const page = await openProblem('two-sum');

  await scenario('the real content scripts mount the Tutor tab, connected to the worker', async () => {
    await page.waitFor(`document.querySelector('[data-lc-tutor-tab]')`, { what: 'the Tutor tab' });
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__q('.status span') && window.__q('.status span').textContent === 'Connected'`, { what: 'the Connected status' });
    const info = await page.eval(`({ model: (window.__q('.provider') || {}).textContent || '', disabled: window.__q('textarea').disabled, banner: !window.__q('.banner').hidden })`);
    check(/stub-model/.test(info.model), `header model: ${JSON.stringify(info)}`);
    check(!info.disabled && !info.banner, JSON.stringify(info));
  });

  await scenario('a typed message carries the live editor code, and the reply streams in', async () => {
    await page.eval(`window.__send('why does this return nothing?')`);
    // Part of the reply first, then all of it.
    await page.waitFor(`window.__replies().some((t) => t.includes('part one') && !t.includes('part three'))`, { what: 'a partly streamed reply', timeout: 10000 });
    await page.waitFor(`window.__replies().some((t) => t.includes('Reply 1: part one, part two, part three.'))`, { what: 'the whole reply', timeout: 10000 });
    const sent = model.requests.find((r) => r.body.stream);
    check(sent.origin && sent.origin.startsWith('chrome-extension://'), `the request came from the worker: ${sent.origin}`);
    const last = sent.body.messages[sent.body.messages.length - 1].content;
    check(last.includes('why does this return nothing?'), `message: ${last}`);
    check(last.includes('return []'), `the editor code went with it: ${last}`);
    const system = sent.body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    check(system.includes(TUTOR_SYSTEM_MESSAGE), 'the shared tutor prompt is the system message');
    check(/Given an array of integers/.test(system), 'the problem statement is pinned');
    check(system.includes('2 <= nums.length <= 10^4, -10^9 <= nums[i] <= 10^9'), `exponents survive in the statement: ${system}`);
    await page.screenshot(path.join(shots, 'reply-dark.png'), { width: 1100, height: 760 });
  });

  await scenario('a Run is recorded but never sent; a changed Submit goes to the tutor as a diff', async () => {
    const before = model.requests.length;
    await page.eval(`(() => {
      window.__editorCode = 'class Solution:\\n    def twoSum(self, nums, target):\\n        seen = {}\\n        return []\\n';
      document.getElementById('editor-button').dispatchEvent(new KeyboardEvent('keydown', { key: "'", ctrlKey: true, bubbles: true }));
    })()`);
    // A Run or Submit steps the panel aside for LeetCode's result tab; open
    // it again to look.
    await new Promise((r) => setTimeout(r, 300));
    await page.eval('window.__openTutor()');
    await new Promise((r) => setTimeout(r, 800));
    check(model.requests.length === before, 'a Run reached the model');
    const chips = () => page.eval(`window.__qa('.feed .chip').map((n) => n.textContent)`);
    check((await chips()).length === 0, `a Run showed a chip: ${JSON.stringify(await chips())}`);
    await page.eval(`document.getElementById('editor-button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__replies().some((t) => t.includes('Reply 2: part one, part two, part three.'))`, { what: 'the Submit review', timeout: 10000 });
    const submit = model.requests[model.requests.length - 1].body.messages.at(-1).content;
    check(/\[LeetCode capture\] Submit/.test(submit), `submit header: ${submit}`);
    check(/seen = \{\}/.test(submit) && !/def twoSum/.test(submit.split('\n').filter((l) => !l.startsWith(' ')).join('\n')) , `a diff, not the whole code: ${submit}`);
    check(JSON.stringify(await chips()) === JSON.stringify(['SubmitAttempt 2']), `the Submit's chip: ${JSON.stringify(await chips())}`);
    await page.screenshot(path.join(shots, 'submit-dark.png'), { width: 1100, height: 760 });
    // The same code submitted again is not sent.
    const count = model.requests.length;
    await page.eval(`document.getElementById('editor-button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 1200));
    check(model.requests.length === count, 'an unchanged Submit reached the model');
    check((await chips()).length === 1, `an unchanged Submit showed a chip: ${JSON.stringify(await chips())}`);
  });

  await scenario('a reload replays the conversation from the worker', async () => {
    await page.send('Page.reload');
    await page.waitFor(`document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the reloaded page' });
    await page.eval(helpers);
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__replies().length === 2`, { what: 'the replayed replies' });
  });

  await scenario('the model switcher: a switch asked for mid-reply waits for it, and the chat and the held code move to the new model', async () => {
    // A second saved model, through the options page's own call to the worker.
    const stored = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
    const first = stored.tutorSettings.profiles[0];
    check(stored.tutorSettings.profiles.length === 1 && first.model === 'stub-model', `one profile after the first save: ${JSON.stringify(stored.tutorSettings.profiles)}`);
    const options = await browser.openPage('about:blank');
    await options.failFetch('http://localhost:8135/*');
    await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
    await options.waitFor(`document.getElementById('connection-text').textContent.startsWith('Tutor running')`, { what: 'the options page' });
    const saved = await options.eval(`chrome.runtime.sendMessage({ type: 'lc-tutor:settings-save', params: { patch: {
      profiles: [${JSON.stringify(first)}, { id: 'second', provider: 'local', model: 'stub-model-b', label: 'Second' }], activeProfile: ${JSON.stringify(first.id)} } } })`);
    check(saved.ok, `saved: ${JSON.stringify(saved)}`);
    options.close();
    await front(page);
    await page.waitFor(`window.__qa('.opt').length >= 0 && window.__q('button.model .provider').textContent === 'stub-model'`, { what: 'the switcher button' });
    const before = model.requests.length;
    // Long enough that a one-line change goes as a diff (a diff past 80
    // percent of the code is sent whole).
    await page.eval(`window.__editorCode = 'class Solution:\\n    def twoSum(self, nums, target):\\n' + Array.from({ length: 30 }, (_, i) => '        x' + i + ' = ' + i + '\\n').join('') + '        return [0, 1]\\n'`);
    await page.eval(`window.__send('is this right now?')`);
    await page.waitFor(`window.__replies().some((t) => t.includes('part one') && !t.includes('part three'))`, { what: 'a reply in progress', timeout: 10000 });
    await page.eval(`window.__q('button.model').click()`);
    await page.eval(`window.__q('.opt[data-id="second"]').click()`);
    await page.waitFor(`window.__q('.status span').textContent === 'Switching' && window.__replies().at(-1).indexOf('part three') < 0`, { what: '"Switching" while the reply still runs', timeout: 3000 });
    await page.waitFor(`window.__q('button.model .provider').textContent === 'Second' && window.__q('.status span').textContent === 'Connected'`, { what: 'the switch to land', timeout: 15000 });
    const replyDone = await page.eval(`window.__replies().at(-1)`);
    check(/part three\.$/.test(replyDone), `the running reply finished first: ${replyDone}`);
    check(model.requests.slice(before).every((r) => r.body.model === 'stub-model'), 'the reply ran on the first model');
    // The next message goes to the new model with the whole chat and only a diff of the code.
    await page.eval(`window.__editorCode = window.__editorCode.replace('return [0, 1]', 'return [1, 0]')`);
    await page.eval(`window.__send('and now?')`);
    await page.waitFor(`window.__feed().includes('user: and now?') && window.__feed().at(-1).endsWith('part three.')`, { what: 'the reply from the new model', timeout: 10000 });
    const next = model.requests.filter((r) => r.body.stream).at(-1).body;
    check(next.model === 'stub-model-b', `the new model answered: ${next.model}`);
    const chat = next.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
    check(chat.includes('why does this return nothing?') && chat.includes('is this right now?'), 'the earlier chat moved to the new model');
    const system = next.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    check(/return \[1, 0\]/.test(system) && /Given an array of integers/.test(system), `the current code and the statement are pinned: ${system.slice(-600)}`);
    const last = next.messages.at(-1).content;
    check(/return \[1, 0\]/.test(last) && !/def twoSum/.test(last.split('\n').filter((l) => !/^\s*\d/.test(l)).join('\n')), `a diff against the held code, not the whole code: ${last}`);
    const after = await browser.serviceWorkerEval(`chrome.storage.local.get(null)`);
    check(after.tutorSettings.activeProfile === 'second' && after.tutorSettings.providers.local.model === 'stub-model-b', 'the switch is saved');
    await page.eval(`window.__q('button.model').click()`);
    await page.screenshot(path.join(shots, 'switcher-open-dark.png'), { width: 1100, height: 760 });
    await page.eval(`window.__q('button.model').click()`);
  });

  // A second tab on another problem, on the same extension (one worker, one
  // tutor). The active problem is whichever one the last message, Run or
  // Submit came from.
  const other = await openProblem('valid-parentheses');
  const NOTICE = 'notice: New problem detected. Started a fresh tutor session.';
  const settle = () => new Promise((r) => setTimeout(r, 1000));
  const QUIET = 'empty: Another problem is active now. Send a message or Run here to switch to this one.';

  await scenario("switching problems drops the old problem's chat from the panel, not only from the worker", async () => {
    await front(other);
    await other.waitFor(`window.__q('.status span') && window.__q('.status span').textContent === 'Connected'`, { what: 'the second tab' });
    await other.eval(`window.__send('what about brackets?')`);
    await other.waitFor(`window.__feed().at(-1).startsWith('tutor: Reply') && window.__feed().at(-1).endsWith('part three.')`, { what: 'the reply in the second tab', timeout: 10000 });
    const first = await other.eval('window.__feed()');
    check(first.length === 3 && first[0] === NOTICE && first[1] === 'user: what about brackets?', `the second tab: ${JSON.stringify(first)}`);
  });

  await scenario('a panel on a problem that is no longer active empties at once and says so, without sending anything', async () => {
    await front(page);
    const quiet = await page.eval('window.__feed()');
    check(JSON.stringify(quiet) === JSON.stringify([QUIET]), `the first tab: ${JSON.stringify(quiet)}`);
    await page.screenshot(path.join(shots, 'another-problem-active-dark.png'), { width: 1100, height: 760 });
  });

  await scenario('a message from the old tab switches back: its notice comes first, and the other tab empties', async () => {
    await front(page);
    await page.eval(`window.__send('back to two sum')`);
    await page.waitFor(`window.__feed().at(-1).endsWith('part three.') && window.__feed().includes('user: back to two sum')`, { what: 'the reply back on two-sum', timeout: 10000 });
    const back = await page.eval('window.__feed()');
    check(back.length === 3 && back[0] === NOTICE && back[1] === 'user: back to two sum', `the old two-sum chat stayed: ${JSON.stringify(back)}`);
    await page.screenshot(path.join(shots, 'switch-back-dark.png'), { width: 1100, height: 760 });
    // A reload shows the same.
    await page.send('Page.reload');
    await page.waitFor(`document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the reloaded page' });
    await page.eval(helpers);
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__replies().length === 1`, { what: 'the replayed reply' });
    const replayed = await page.eval('window.__feed()');
    check(JSON.stringify(replayed) === JSON.stringify(back), `the reload replays something else: ${JSON.stringify(replayed)}`);
    await front(other);
    const emptied = await other.eval('window.__feed()');
    check(JSON.stringify(emptied) === JSON.stringify([QUIET]), `the second tab: ${JSON.stringify(emptied)}`);
  });

  await scenario('a Run that switches problems leaves no dangling notice, and one on the active problem none at all', async () => {
    // The Run switches the tutor to valid-parentheses: nothing to show yet.
    await front(other);
    await other.eval('window.__run()');
    await settle();
    await front(other);
    const afterRun = await other.eval('window.__feed()');
    check(afterRun.length === 1 && afterRun[0].startsWith('empty: Submit your code'), `a dangling notice, or not the usual empty state: ${JSON.stringify(afterRun)}`);
    await front(page);
    const firstTab = await page.eval('window.__feed()');
    check(JSON.stringify(firstTab) === JSON.stringify([QUIET]), `the first tab after the Run: ${JSON.stringify(firstTab)}`);
    // The next message shows the notice right before it.
    await front(other);
    await other.eval(`window.__send('one more')`);
    await other.waitFor(`window.__feed().at(-1).endsWith('part three.') && window.__feed().includes('user: one more')`, { what: 'the reply after the Run', timeout: 10000 });
    const afterMessage = await other.eval('window.__feed()');
    check(afterMessage.length === 3 && afterMessage[0] === NOTICE && afterMessage[1] === 'user: one more', `the notice is not right before the message: ${JSON.stringify(afterMessage)}`);
    await other.screenshot(path.join(shots, 'switch-after-run-dark.png'), { width: 1100, height: 760 });
    // A Run on the problem already active changes nothing.
    await other.eval('window.__run()');
    await settle();
    await front(other);
    const unchanged = await other.eval('window.__feed()');
    check(JSON.stringify(unchanged) === JSON.stringify(afterMessage), `a Run on the active problem changed the feed: ${JSON.stringify(unchanged)}`);
  });

  await scenario('the problem page never contacted the relay', async () => {
    check(relayRequests.length === 0, `relay requests: ${JSON.stringify(relayRequests)}`);
  });

  await scenario('no exceptions in the page', async () => {
    const errors = [...page.console, ...other.console].filter((l) => /exception|error/i.test(l));
    check(errors.length === 0, errors.join('\n'));
  });
} finally {
  await browser.close();
  copy.cleanup();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
