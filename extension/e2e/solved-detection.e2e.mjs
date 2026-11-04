// End-to-end check of solved-problem detection in the REAL unpacked
// extension (Playwright's cached Chromium): https://leetcode.com/problems/...
// is served by the browser itself (CDP Fetch fulfils it with
// panel-fixture.html plus a fake Monaco), and so are LeetCode's submission
// result polls (/submissions/detail/<id>/check/ and /v2/check/), scripted per submission.
// The page polls them the way LeetCode does (fetch and XMLHttpRequest, from
// the page's own world), and the extension's real inject.js, content.js,
// worker and panel do the rest.
//
// Proves: an accepted submission is stored exactly once under the slug of
// the page address (a repeated poll, a Run and a wrong answer change
// nothing); the Tutor panel shows the "nice job" card with working links and
// a "See your progress" button; the card follows the list chosen on the
// Progress tab, and its own list menu switches lists without touching the
// solved problems; the card never reaches the model; it all
// works the same with the helper runtime chosen; nothing goes to the relay.
//
// Run with:  node extension/e2e/solved-detection.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-solved-shots).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';
import { LISTS } from '../shared/roadmap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-solved-shots';
fs.mkdirSync(shots, { recursive: true });

// The fixture stands in a scripted relay for the page's fetch; LeetCode's
// own result polls pass through it to the browser (and so to CDP Fetch).
const NO_NETWORK = 'throw new TypeError(`fixture: no network for ${url.href}`);';
const fixtureSource = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8');
if (!fixtureSource.includes(NO_NETWORK) || !fixtureSource.includes('<head>')) throw new Error('the fixture changed: update this script');
const fixture = fixtureSource
  .replace('<head>', '<head><script>window.__nativeFetch = window.fetch.bind(window);</script>')
  .replace(NO_NETWORK, `if (url.pathname.startsWith("/submissions/")) return window.__nativeFetch(input, options);\n      ${NO_NETWORK}`)
  .replace(
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

// A stub model that answers every chat with one short streamed reply.
const model = { requests: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) return void res.writeHead(404).end();
    const parsed = JSON.parse(body);
    model.requests.push(parsed);
    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A short reply.' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The judge's answers, per submission id, one per poll (the last repeats).
const ACCEPTED = { state: 'SUCCESS', status_msg: 'Accepted', status_code: 10, task_name: 'judger.judgetask.Judge', total_correct: 63, total_testcases: 63, run_success: true };
const judge = {
  7001: [{ state: 'PENDING' }, { state: 'STARTED' }, ACCEPTED],
  7002: [{ state: 'STARTED' }, { state: 'SUCCESS', status_msg: 'Wrong Answer', status_code: 11, task_name: 'judger.judgetask.Judge' }],
  'runcode_1730000000.1_abc': [{ state: 'SUCCESS', status_msg: 'Accepted', status_code: 10, task_name: 'judger.runcodetask.RunCode', code_answer: ['[0,1]'] }],
  7003: [{ state: 'STARTED' }, ACCEPTED],
  7004: [ACCEPTED],
  7005: [{ state: 'STARTED' }, ACCEPTED],
  7006: [{ state: 'STARTED' }, ACCEPTED],
  7007: [{ state: 'STARTED' }, ACCEPTED],
  8001: [ACCEPTED],
};
const polls = {};
const relayRequests = [];

const copy = extensionCopy(extensionDir, { extraHosts: ['http://127.0.0.1/*'] });
const browser = await launch({ extensionDir: copy.dir });
try {
  const options = await browser.openPage('about:blank');
  await options.failFetch('http://localhost:8135/*');
  await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
  await options.waitFor(`document.getElementById('connection-text').textContent === 'Not set up'`, { what: 'the options page' });
  const ask = (type, params) => options.eval(`chrome.runtime.sendMessage({ type: ${JSON.stringify(type)}, params: ${JSON.stringify(params)} })`);
  const saved = await ask('lc-tutor:settings-save', { patch: { provider: 'local', runtimes: { local: 'extension' }, providers: { local: { baseUrl: modelUrl, model: 'stub-model' } } } });
  if (!saved.ok) throw new Error(`could not set up the stub model: ${JSON.stringify(saved)}`);

  const helpers = `(() => {
    window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
    window.__q = (sel) => window.__root().querySelector(sel);
    window.__qa = (sel) => [...window.__root().querySelectorAll(sel)];
    window.__openTutor = () => document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    window.__cards = () => window.__qa('.feed .solved').map((n) => n.textContent);
    // Polls the way LeetCode's page does, until the judge is done.
    window.__pollFetch = async (id) => {
      for (let i = 0; i < 6; i += 1) {
        const r = await (await fetch('/submissions/detail/' + id + '/check/', { credentials: 'include' })).json();
        if (r.state === 'SUCCESS') return r.status_msg;
      }
      return 'never';
    };
    window.__pollXhr = (id) => new Promise((resolve) => {
      const once = () => {
        const x = new XMLHttpRequest();
        x.open('GET', '/submissions/detail/' + id + '/check/');
        x.onload = () => { const r = JSON.parse(x.responseText); if (r.state === 'SUCCESS') resolve(r.status_msg); else once(); };
        x.send();
      };
      once();
    });
    // LeetCode today polls the /v2/ path.
    window.__pollV2 = async (id) => (await (await fetch('/submissions/detail/' + id + '/v2/check/', { credentials: 'include' })).json()).state;
    window.__send = (text) => {
      const t = window.__q('textarea');
      t.value = text;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
  })()`;
  async function openProblem(slug) {
    const tab = await browser.openPage('about:blank');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }, { urlPattern: 'http://localhost:8135/*' }] });
    tab.on('Fetch.requestPaused', async (p) => {
      const url = new URL(p.request.url);
      if (url.host === 'localhost:8135') {
        relayRequests.push({ method: p.request.method, url: p.request.url, body: p.request.postData || '' });
        await tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
        return;
      }
      const check = /^\/submissions\/detail\/([^/]+)\/(?:v2\/)?check\/$/.exec(url.pathname);
      if (check && judge[check[1]]) {
        const n = (polls[check[1]] = (polls[check[1]] || 0) + 1);
        const answers = judge[check[1]];
        const body = answers[Math.min(n, answers.length) - 1];
        await tab.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify(body)).toString('base64'),
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
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await tab.send('Page.navigate', { url: `https://leetcode.com/problems/${slug}/description/` });
    await tab.waitFor(`document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: `the ${slug} page` });
    await tab.eval(helpers);
    // content.js injects inject.js at once; the wrappers must be in place
    // before the first poll.
    await tab.waitFor(`document.getElementById('leetcode-capture-inject') && fetch.__lcCaptureWrapped === true`, { what: 'inject.js' });
    return tab;
  }
  const stored = () => browser.serviceWorkerEval(`chrome.storage.local.get('solvedProblems').then((s) => s.solvedProblems || {})`);

  const page = await openProblem('two-sum');
  await page.eval('window.__openTutor()');
  await page.waitFor(`window.__q('.status span') && window.__q('.status span').textContent === 'Connected'`, { what: 'the panel connected' });

  await scenario('an accepted submission (fetch polling) is stored once, under the page address slug', async () => {
    check((await page.eval(`window.__pollFetch(7001)`)) === 'Accepted', 'the page saw its own result unchanged');
    await page.waitFor(`window.__cards().length === 1`, { what: 'the card' });
    // LeetCode polling again (or the page asking for the same result) is not a new solve.
    await page.eval(`fetch('/submissions/detail/7001/check/').then((r) => r.json())`);
    await sleep(500);
    const s = await stored();
    check(Object.keys(s).join() === 'two-sum' && s['two-sum'].count === 1 && !s['two-sum'].manual, `stored: ${JSON.stringify(s)}`);
    check(Math.abs(Date.parse(s['two-sum'].at) - Date.now()) < 60_000, `time: ${s['two-sum'].at}`);
    check((await page.eval(`window.__cards().length`)) === 1, 'a second card for the same submission');
  });

  await scenario('the panel shows the "nice job" card with the next roadmap problem and one more of the topic', async () => {
    const m = await page.eval(`(() => {
      const c = window.__qa('.feed .solved')[0];
      return { text: c.textContent, links: [...c.querySelectorAll('a')].map((a) => [a.textContent, a.href, a.target]), more: c.querySelector('.solved-more')?.textContent };
    })()`);
    check(m.text.startsWith('Nice job completing Two Sum.Next up on NeetCode 150Contains DuplicateEasyMore Arrays & Hashing problemsValid AnagramEasy'), m.text);
    check(JSON.stringify(m.links) === JSON.stringify([
      ['Contains Duplicate', 'https://leetcode.com/problems/contains-duplicate/', ''],
      ['Valid Anagram', 'https://leetcode.com/problems/valid-anagram/', ''],
    ]), `links: ${JSON.stringify(m.links)}`);
    check(m.more === 'See your progress', `progress button: ${m.more}`);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await page.screenshot(path.join(shots, 'card-dark.png'), { width: 1100, height: 760 });
  });

  await scenario('a wrong answer and a Run that passes record nothing', async () => {
    check((await page.eval(`window.__pollFetch(7002)`)) === 'Wrong Answer', 'wrong answer poll');
    check((await page.eval(`window.__pollFetch('runcode_1730000000.1_abc')`)) === 'Accepted', 'run poll');
    await sleep(500);
    const s = await stored();
    check(s['two-sum'].count === 1, `stored: ${JSON.stringify(s)}`);
    check((await page.eval(`window.__cards().length`)) === 1, 'a card for a Run or a wrong answer');
  });

  await scenario('a second accepted submission (XMLHttpRequest polling) counts up and adds a card', async () => {
    check((await page.eval(`window.__pollXhr(7003)`)) === 'Accepted', 'xhr poll');
    await page.waitFor(`window.__cards().length === 2`, { what: 'the second card' });
    const s = await stored();
    check(s['two-sum'].count === 2, `stored: ${JSON.stringify(s)}`);
  });

  const listState = () => browser.serviceWorkerEval(`chrome.storage.local.get(['activeProgressList', 'solvedProblems'])`);
  const lastCard = () => page.eval(`(() => { const c = window.__qa('.feed .solved').at(-1); const sel = c.querySelector('.solved-switch select'); return { text: c.querySelector('.solved-head').textContent + c.querySelector('.solved-list').textContent, select: sel && sel.value, options: sel ? [...sel.options].map((o) => o.value + ':' + o.textContent) : [], label: c.querySelector('.solved-switch')?.textContent.replace(sel?.textContent || '', ''), focus: window.__root().activeElement === sel }; })()`);
  const pickList = (id) => page.eval(`(() => { const sel = window.__qa('.feed .solved').at(-1).querySelector('.solved-switch select'); sel.focus(); sel.value = ${JSON.stringify(id)}; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  await scenario('the card follows the list chosen on the Progress tab, and names it', async () => {
    const before = await listState();
    check(before.activeProgressList === undefined, `first run has no stored list: ${JSON.stringify(before.activeProgressList)}`);
    const m = await lastCard();
    check(m.select === 'neetcode-150', `first run default: ${m.select}`);
    check(m.label === 'Working on', `menu label: ${m.label}`);
    check(JSON.stringify(m.options) === JSON.stringify(LISTS.map((l) => `${l.id}:${l.title}`)) && m.options.length === 7, `options: ${m.options}`);
    await browser.serviceWorkerEval(`chrome.storage.local.set({ activeProgressList: 'blind-75' })`);
    check((await page.eval(`window.__pollFetch(7004)`)) === 'Accepted', 'poll');
    await page.waitFor(`window.__cards().length === 3`, { what: 'the third card' });
    const b = await lastCard();
    check(b.text === 'Nice job completing Two Sum.Next up on Blind 75Best Time to Buy and Sell StockEasyMore Array problemsContains DuplicateEasy', b.text);
    check(b.select === 'blind-75', `menu shows the stored list: ${b.select}`);
  });

  await scenario('the card\'s list menu switches lists: the card follows in place, only the choice is stored', async () => {
    const before = await listState();
    await pickList('sql-50');
    await page.waitFor(`window.__qa('.feed .solved').at(-1).textContent.includes('Next up on SQL 50')`, { what: 'the card to follow' });
    const m = await lastCard();
    // Two Sum is not on SQL 50: the agenda only.
    check(m.text === 'Nice job completing Two Sum.Next up on SQL 50Recyclable and Low Fat ProductsEasy', m.text);
    check(m.select === 'sql-50' && m.focus, `menu value and focus: ${JSON.stringify(m)}`);
    const after = await listState();
    check(after.activeProgressList === 'sql-50', `stored: ${after.activeProgressList}`);
    check(JSON.stringify(after.solvedProblems) === JSON.stringify(before.solvedProblems), 'the solved problems changed');
    check((await page.eval(`window.__cards().length`)) === 3, 'a switch adds no card');
    const first = await page.eval(`window.__cards()[0]`);
    check(first.includes('Next up on NeetCode 150'), `older cards keep what they said: ${first}`);
    const menus = await page.eval(`window.__qa('.feed .solved .solved-switch').map((n) => getComputedStyle(n).display)`);
    check(menus.length === 3 && menus[0] === 'none' && menus[1] === 'none' && menus[2] !== 'none', `only the newest card has the menu: ${menus}`);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await page.screenshot(path.join(shots, 'card-list-menu-dark.png'), { width: 1100, height: 760 });
    // The keyboard: arrow keys on the focused menu move the choice.
    await page.eval(`window.__qa('.feed .solved').at(-1).querySelector('.solved-switch select').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
    await page.waitFor(`window.__qa('.feed .solved').at(-1).textContent.includes('Next up on Top Interview 150')`, { what: 'ArrowUp to pick the list above' });
    check((await listState()).activeProgressList === 'top-interview-150', 'stored after the keyboard');
    // Back to the default for the rest of the run.
    await pickList('neetcode-150');
    await page.waitFor(`window.__qa('.feed .solved').at(-1).textContent.includes('Next up on NeetCode 150')`, { what: 'back to NeetCode 150' });
    check((await listState()).activeProgressList === 'neetcode-150', 'stored');
  });

  await scenario('the card never reaches the model: the next message carries no trace of it', async () => {
    await page.eval(`window.__send('what next?')`);
    await page.waitFor(`window.__qa('.feed .tutor').some((n) => n.textContent.includes('A short reply.'))`, { what: 'the reply', timeout: 10000 });
    const last = model.requests.filter((r) => r.stream).at(-1);
    const all = JSON.stringify(last.messages);
    check(all.includes('what next?'), 'the message went');
    check(!/Nice job|Contains Duplicate|Valid Anagram|Accepted|NeetCode|Blind 75|SQL 50|Working on/.test(all), `the card reached the model: ${all.slice(0, 400)}`);
  });

  await scenario('"See your progress" opens the options page on its Progress tab, showing the problem solved', async () => {
    await page.eval(`window.__qa('.feed .solved-more')[0].click()`);
    let target = null;
    for (let i = 0; i < 40 && !target; i += 1) {
      target = (await browser.listTargets()).find((t) => t.type === 'page' && t.url === `chrome-extension://${browser.extensionId}/settings.html#progress`);
      if (!target) await sleep(100);
    }
    check(target, 'no options tab on #progress');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    // A bare evaluation over the target's socket.
    let id = 0;
    const evaluate = (expression) =>
      new Promise((resolve) => {
        const my = ++id;
        ws.addEventListener('message', function on(ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id !== my) return;
          ws.removeEventListener('message', on);
          resolve(msg.result && msg.result.result ? msg.result.result.value : null);
        });
        ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      });
    let label = null;
    for (let i = 0; i < 40 && !(label && label.includes('1 of 9')); i += 1) {
      label = await evaluate(`document.querySelector('.node[data-topic="arrays-hashing"]')?.getAttribute('aria-label') || null`);
      if (!(label && label.includes('1 of 9'))) await sleep(100);
    }
    ws.close();
    check(label === 'Arrays & Hashing, 1 of 9 solved, recommended next', `node: ${label}`);
  });

  await scenario('a card link is an ordinary link: it opens the problem in the same tab', async () => {
    await page.send('Page.bringToFront');
    await page.eval(`window.__openTutor()`);
    await sleep(200);
    await page.eval(`window.__qa('.feed .solved a')[0].click()`);
    await page.waitFor(`location.pathname === '/problems/contains-duplicate/' && document.readyState === 'complete'`, { what: 'the navigation' });
  });

  await scenario('with the helper runtime chosen, detection still records and the card still shows', async () => {
    const res = await ask('lc-tutor:settings-save', { patch: { provider: 'claude', runtimes: { claude: 'helper' } } });
    check(res.ok, `switch to the helper runtime: ${JSON.stringify(res)}`);
    const tab = await openProblem('valid-parentheses');
    await tab.eval('window.__openTutor()');
    check((await tab.eval(`window.__pollFetch(8001)`)) === 'Accepted', 'poll');
    await tab.waitFor(`window.__cards().length === 1`, { what: 'the card with the helper runtime' });
    const s = await stored();
    check(s['valid-parentheses'] && s['valid-parentheses'].count === 1 && s['two-sum'].count === 3, `stored: ${JSON.stringify(s)}`);
    const text = await tab.eval(`window.__cards()[0]`);
    check(text.startsWith('Nice job completing Valid Parentheses.Next up on NeetCode 150Contains DuplicateEasyMore Stack problemsMin StackMedium'), text);
    await tab.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await tab.screenshot(path.join(shots, 'card-helper-runtime-dark.png'), { width: 1100, height: 760 });
  });

  await scenario('a verdict that arrives after an in-app move marks neither problem solved; a submission after the move counts for the new one', async () => {
    // A tab of its own (the helper runtime is still chosen, which detection
    // does not mind).
    const page = await openProblem('two-sum');
    await page.send('Page.bringToFront');
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__q('.feed')`, { what: 'the panel' });
    const before = await stored();
    const cards = await page.eval(`window.__cards().length`);
    // The first poll starts on two-sum; LeetCode's router moves to 3sum
    // before the next poll brings the verdict.
    check((await page.eval(`window.__pollV2(7005)`)) === 'STARTED', 'first poll');
    await page.eval(`history.pushState({}, '', '/problems/3sum/description/')`);
    check((await page.eval(`window.__pollV2(7005)`)) === 'SUCCESS', 'the verdict');
    // XMLHttpRequest polling too.
    await page.eval(`history.pushState({}, '', '/problems/two-sum/description/')`);
    await page.eval(`new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('GET', '/submissions/detail/7006/v2/check/'); x.onload = resolve; x.send(); })`);
    await page.eval(`history.pushState({}, '', '/problems/3sum/description/')`);
    await page.eval(`new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('GET', '/submissions/detail/7006/v2/check/'); x.onload = resolve; x.send(); })`);
    await sleep(700);
    const after = await stored();
    check(JSON.stringify(after) === JSON.stringify(before), `stored: ${JSON.stringify(after)}`);
    check((await page.eval(`window.__cards().length`)) === cards, 'no card');
    // A submission made after the move counts for the problem moved to.
    check((await page.eval(`window.__pollV2(7007)`)) === 'STARTED', 'first poll on 3sum');
    check((await page.eval(`window.__pollV2(7007)`)) === 'SUCCESS', 'the verdict on 3sum');
    await sleep(700);
    const moved = await stored();
    check(moved['3sum'] && moved['3sum'].count === 1, `stored: ${JSON.stringify(moved)}`);
    // The panel steps aside on a problem change (ensureMounted in panel.js).
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__cards().length === 1`, { what: 'the card for 3sum' });
    page.close();
  });

  await scenario('nothing about a solve went to the relay', async () => {
    const posts = relayRequests.filter((r) => r.method !== 'GET');
    check(posts.length === 0, `relay POSTs: ${JSON.stringify(posts)}`);
    check(!relayRequests.some((r) => /7001|7003|8001|solved|accepted/i.test(r.url + r.body)), JSON.stringify(relayRequests));
  });

  await scenario('no exceptions in the pages', async () => {
    const errors = page.console.filter((l) => /exception/i.test(l));
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
