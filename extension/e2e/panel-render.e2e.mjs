// extension/e2e/panel-render.e2e.mjs - the Tutor panel's DOM behavior in a
// real (headless) Chromium: the real extension/panel.js injected into a local
// fixture page (panel-fixture.html) that copies the bits of LeetCode's
// flexlayout DOM it mounts into, with fetch replaced by a scripted relay.
//
// Covers what the unit tests cannot: the feed is patched in place (a text
// selection and a code block's horizontal scroll survive streamed chunks and
// events for other problems), the compact header row, which native pane is
// made inert, the relay-restart (epoch) flow over a reconnect, sending
// (double Enter, the too-long hint), and some CSS metrics.
//
// Nothing here talks to the real relay: the fixture's fetch never reaches the
// network, and as a second guard the injected copy of panel.js points at a
// port nothing listens on. Manual check, not part of `npm test`:
//
//   node extension/e2e/panel-render.e2e.mjs
//   PANEL_JS=/tmp/old-panel.js node extension/e2e/panel-render.e2e.mjs
//
// Screenshots go to /tmp/lc-panel-shots.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = '/tmp/lc-panel-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8');
// PANEL_JS=<file> runs the scenarios against another copy (for example the
// version before a fix, to see the scenarios catch the bug).
const panelSource = fs
  .readFileSync(process.env.PANEL_JS || path.join(here, '..', 'panel.js'), 'utf8')
  .replace('const RELAY_BASE = "http://localhost:8135";', 'const RELAY_BASE = "http://127.0.0.1:9";');
if (!panelSource.includes('http://127.0.0.1:9')) throw new Error('could not repoint RELAY_BASE in the injected panel.js');

// Serves the fixture at any /problems/<slug>/ path, on a random free port.
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/problems/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixture);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await launch();
try {
  const page = await browser.openPage(`${origin}/problems/two-sum/description/`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });

  // Page-side helpers.
  await page.eval(`(() => {
    window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
    window.__q = (sel) => window.__root().querySelector(sel);
    window.__qa = (sel) => [...window.__root().querySelectorAll(sel)];
    window.__settle = () => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 30));
    window.__openTutor = () => {
      const tab = document.querySelector('[data-lc-tutor-tab]');
      tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    };
    window.__seq = 0;
    window.__ev = (obj) => window.__event({ seq: ++window.__seq, epoch: window.__epoch, ...obj });
    window.__epoch = 'e1';
  })()`);
  await page.eval(`new Function(${JSON.stringify(panelSource)})()`);
  await page.waitFor(`document.querySelector('[data-lc-tutor-tab]') && window.__streamOpen()`, { what: 'the Tutor tab and its event stream' });
  const settle = () => page.eval('window.__settle()');

  await scenario('offline: the empty state does not invite a question, the composer is disabled', async () => {
    await page.eval(`window.__event({ type: 'status', companionOnline: false, epoch: 'e1' })`);
    await page.eval('window.__openTutor()');
    await settle();
    const info = await page.eval(`({
      empty: window.__q('.empty p').textContent,
      label: window.__q('.status span').textContent,
      disabled: window.__q('textarea').disabled,
      banner: !window.__q('.banner').hidden,
    })`);
    check(info.label === 'Tutor offline', `status label: ${info.label}`);
    check(!/ask a question/i.test(info.empty) && /Once the companion is running/.test(info.empty), `empty copy: ${info.empty}`);
    check(info.disabled && info.banner, JSON.stringify(info));
    await page.screenshot(path.join(SHOTS, '01-offline.png'), { width: 1100, height: 760 });
  });

  await scenario('compact header: no title, status on the left, an empty right group, native insets', async () => {
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e1' })`);
    await settle();
    const m = await page.eval(`(() => {
      const host = document.getElementById('lc-tutor-panel-host').getBoundingClientRect();
      const head = window.__q('.head').getBoundingClientRect();
      const status = window.__q('.status');
      const cs = getComputedStyle(status);
      return {
        title: window.__qa('h1, h2, .title').length,
        left: window.__q('.head > .head-left > .status') !== null,
        right: window.__q('.head > .head-right') !== null && window.__q('.head-right').children.length === 0,
        role: status.getAttribute('role'),
        text: status.textContent,
        iconFirst: status.firstElementChild.tagName.toLowerCase() === 'svg',
        font: cs.fontSize + '/' + cs.lineHeight,
        muted: cs.color,
        topInset: head.top - host.top,
        leftInset: head.left - host.left,
        height: head.height,
        empty: window.__q('.empty p').textContent,
        emptyColor: getComputedStyle(window.__q('.empty')).color,
        emptyFont: getComputedStyle(window.__q('.empty')).fontSize + '/' + getComputedStyle(window.__q('.empty')).lineHeight,
      };
    })()`);
    check(m.title === 0, 'a heading is still in the panel');
    check(m.left && m.right, `header structure: ${JSON.stringify(m)}`);
    check(m.role === 'status', `status role: ${m.role}`);
    check(m.text === 'Connected' && m.iconFirst, `status: ${m.text}`);
    check(m.font === '14px/20px', `status font: ${m.font}`);
    check(m.topInset === 20 && m.leftInset === 16 && m.height === 20, `insets: ${JSON.stringify(m)}`);
    check(/ask a question/.test(m.empty), `online empty copy: ${m.empty}`);
    // color-mix(in srgb, rgb(245,245,245) 30%, transparent)
    check(/^(rgba\(245, 245, 245, 0\.3\)|color\(srgb 0\.96\d* 0\.96\d* 0\.96\d* \/ 0\.3\))$/.test(m.emptyColor), `empty color: ${m.emptyColor}`);
    check(m.emptyFont === '14px/21px', `empty font: ${m.emptyFont}`);
    await page.screenshot(path.join(SHOTS, '02-header-empty.png'), { width: 1100, height: 760 });
  });

  await scenario('the pane made inert is the one under the tabset, not the first in DOM order', async () => {
    const inert = await page.eval(`({ code: document.getElementById('pane-code').inert, desc: document.getElementById('pane-desc').inert })`);
    check(inert.desc === true && inert.code === false, JSON.stringify(inert));
    // The body color is sampled from that same pane.
    const body = await page.eval(`document.getElementById('lc-tutor-panel-host').style.getPropertyValue('--body')`);
    check(body === 'rgb(255, 255, 255)', `--body sampled from the wrong pane: ${body}`);
  });

  await scenario('a selection in an earlier paragraph survives a streamed chunk', async () => {
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'r1', problemSlug: 'two-sum' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'r1', text: 'The first paragraph explains the idea in plain words.\\n\\nThe second one is still stre' })`);
    await settle();
    await page.eval(`(() => {
      const p = window.__q('.tutor p');
      p.__marker = 'original';
      const text = p.firstChild;
      const range = document.createRange();
      range.setStart(text, 4);
      range.setEnd(text, 19);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    })()`);
    const before = await page.eval(`window.__root().getSelection().toString()`);
    check(before === 'first paragraph', `could not set up the selection: ${JSON.stringify(before)}`);
    for (const piece of ['aming in', ' as we speak.', '\\n\\nAnd a third.']) {
      // eslint-disable-next-line no-await-in-loop
      await page.eval(`window.__ev({ type: 'chunk', turnId: 'r1', text: '${piece}' })`);
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }
    const after = await page.eval(`({
      sel: window.__root().getSelection().toString(),
      same: window.__q('.tutor p').__marker === 'original',
      paras: window.__qa('.tutor p').map((p) => p.textContent),
    })`);
    check(after.same, 'the first paragraph node was replaced');
    check(after.sel === 'first paragraph', `selection lost: ${JSON.stringify(after.sel)}`);
    check(after.paras.length === 3 && after.paras[1] === 'The second one is still streaming in as we speak.', JSON.stringify(after.paras));
    // Control: the detector itself works (replacing the node drops the selection).
    const control = await page.eval(`(() => {
      const p = window.__q('.tutor p');
      const copy = p.cloneNode(true);
      p.replaceWith(copy);
      const lost = window.__root().getSelection().toString() !== 'first paragraph';
      copy.replaceWith(p);
      return lost;
    })()`);
    check(control, 'control failed: replacing the node kept the selection, so this check proves nothing');
  });

  await scenario('a code block keeps its horizontal scroll through other problems, status and new items', async () => {
    const wide = 'x = [' + Array.from({ length: 60 }, (_, i) => i).join(', ') + ']';
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'r1', problemSlug: 'two-sum', text: ${JSON.stringify(`Look at this:\n\n\`\`\`python\n${wide}\n\`\`\`\n\nDone.`)} })`);
    await settle();
    await page.eval(`(() => { const pre = window.__q('pre'); pre.__marker = 'original'; pre.scrollLeft = 120; })()`);
    const start = await page.eval(`window.__q('pre').scrollLeft`);
    check(start === 120, `could not scroll the code block (scrollWidth too small?): ${start}`);
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'valid-parentheses', text: 'elsewhere' })`);
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'other', problemSlug: 'valid-parentheses' })`);
    await page.eval(`window.__ev({ type: 'chunk', turnId: 'other', text: 'streaming somewhere else' })`);
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e1' })`);
    await settle();
    const mid = await page.eval(`({ left: window.__q('pre').scrollLeft, same: window.__q('pre').__marker === 'original' })`);
    check(mid.same && mid.left === 120, `after other-problem events: ${JSON.stringify(mid)}`);
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'two-sum', text: 'a new message here' })`);
    await settle();
    const end = await page.eval(`({ left: window.__q('pre').scrollLeft, same: window.__q('pre').__marker === 'original', users: window.__qa('.user').length })`);
    check(end.same && end.left === 120 && end.users === 1, `after an appended item: ${JSON.stringify(end)}`);
    await page.eval(`window.__q('pre').scrollLeft = 0`);
  });

  await scenario('markdown: aligned table cells, strikethrough, list metrics, a code scrollbar without buttons', async () => {
    const md = [
      'Steps:',
      '',
      '- one',
      '- two',
      '- three',
      '',
      '| Approach | Time | Space |',
      '| :-- | :-: | --: |',
      '| Hash map | O(n) | O(n) |',
      '',
      'This is ~~wrong~~ right.',
      '',
      '```',
      'y = "' + 'z'.repeat(200) + '"',
      '```',
    ].join('\n');
    await page.eval(`window.__ev({ type: 'turn-end', turnId: 'md', problemSlug: 'two-sum', text: ${JSON.stringify(md)} })`);
    await settle();
    const m = await page.eval(`(() => {
      const tutor = window.__qa('.tutor').at(-1);
      const lis = [...tutor.querySelectorAll('li')];
      const ul = tutor.querySelector('ul');
      const cells = [...tutor.querySelectorAll('td')].map((c) => getComputedStyle(c).textAlign);
      const pre = tutor.querySelector('pre');
      return {
        liIndent: lis[0].getBoundingClientRect().left - ul.getBoundingClientRect().left,
        pitch: lis[1].getBoundingClientRect().top - lis[0].getBoundingClientRect().top,
        lastLiMargin: getComputedStyle(lis[2]).marginBottom,
        cells,
        del: tutor.querySelector('del') && tutor.querySelector('del').textContent,
        webkitScrollbar: CSS.supports('selector(::-webkit-scrollbar)'),
        preScrollbarWidth: getComputedStyle(pre).scrollbarWidth,
        preScrollable: pre.scrollWidth > pre.clientWidth,
        barHeight: pre.offsetHeight - pre.clientHeight - 2,
      };
    })()`);
    check(m.liIndent === 16, `list item indent: ${m.liIndent}`);
    check(m.pitch === 33, `list item pitch: ${m.pitch}`);
    check(m.lastLiMargin === '0px', `last item margin: ${m.lastLiMargin}`);
    check(JSON.stringify(m.cells) === JSON.stringify(['left', 'center', 'right']), `cell alignment: ${m.cells}`);
    check(m.del === 'wrong', `strikethrough: ${m.del}`);
    check(m.webkitScrollbar && m.preScrollbarWidth === 'auto', `the styled scrollbar is switched off: ${JSON.stringify(m)}`);
    check(m.preScrollable && m.barHeight === 8, `code block scrollbar height: ${m.barHeight}`);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await settle();
    await page.screenshot(path.join(SHOTS, '03-markdown.png'), { width: 1100, height: 760 });
  });

  await scenario('double Enter sends once, and the textarea is read-only while the POST is in flight', async () => {
    await page.eval(`(() => { window.__postDelayMs = 400; window.__posts.length = 0; })()`);
    await page.eval(`(() => {
      const t = window.__q('textarea');
      t.focus();
      t.value = 'what is the complexity?';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      const enter = () => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      enter();
      enter();
      window.__duringSend = { readOnly: t.readOnly, sendDisabled: window.__q('button').disabled };
      enter();
    })()`);
    const during = await page.eval('window.__duringSend');
    await page.waitFor(`window.__q('textarea').readOnly === false`, { what: 'the send to finish' });
    const after = await page.eval(`({ posts: window.__posts.length, value: window.__q('textarea').value, body: window.__posts[0] })`);
    check(during.readOnly && during.sendDisabled, `during the send: ${JSON.stringify(during)}`);
    check(after.posts === 1, `sent ${after.posts} times`);
    check(after.value === '' && after.body.problemSlug === 'two-sum', JSON.stringify(after));
    await page.eval('window.__postDelayMs = 0');
  });

  await scenario('a 413 says the message is too long, and typing clears the hint', async () => {
    const max = await page.eval(`window.__q('textarea').maxLength`);
    check(max === 8000, `maxlength: ${max}`);
    await page.eval(`(() => {
      window.__postStatus = 413;
      const t = window.__q('textarea');
      t.value = 'long one';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await page.waitFor(`!window.__q('.hint').hidden`, { what: 'the hint' });
    const hint = await page.eval(`window.__q('.hint').textContent`);
    check(hint === 'That message is too long (8000 characters at most).', `hint: ${hint}`);
    await page.eval(`(() => { window.__postStatus = 202; const t = window.__q('textarea'); t.value += '!'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check(await page.eval(`window.__q('.hint').hidden`), 'typing did not clear the hint');
  });

  await scenario('a relay restart: the reconnect names the epoch, a pending reply stops typing, the new run shows', async () => {
    await page.eval(`window.__ev({ type: 'turn-start', turnId: 'stuck', problemSlug: 'two-sum' })`);
    await settle();
    check(await page.eval(`window.__qa('.dots').length === 1`), 'the pending turn shows no typing indicator');
    const urlsBefore = await page.eval('window.__eventsUrls.length');
    await page.eval('window.__dropStream()');
    await page.waitFor(`window.__q('.status span').textContent === 'Offline'`, { what: 'the panel to notice the relay is gone' });
    await page.waitFor(`window.__eventsUrls.length > ${urlsBefore} && window.__streamOpen()`, { timeout: 5000, what: 'the reconnect' });
    const url = await page.eval('window.__eventsUrls.at(-1)');
    check(/[?&]epoch=e1(&|$)/.test(url) && /after=\d+/.test(url) && !/after=0/.test(url), `reconnect URL: ${url}`);
    // The new run: numbering starts over, replay first, status last.
    await page.eval(`(() => { window.__epoch = 'e2'; window.__seq = 0; })()`);
    await page.eval(`window.__ev({ type: 'user', problemSlug: 'two-sum', text: 'after the restart' })`);
    await page.eval(`window.__event({ type: 'status', companionOnline: true, epoch: 'e2' })`);
    await settle();
    const m = await page.eval(`({
      dots: window.__qa('.dots').length,
      note: window.__qa('.tutor .note').map((n) => n.textContent),
      notices: window.__qa('.notice').map((n) => n.textContent),
      lastUser: window.__qa('.user').at(-1).textContent,
      status: window.__q('.status span').textContent,
    })`);
    check(m.dots === 0, 'the interrupted turn still shows the typing indicator');
    check(m.note.length === 1, `interruption note: ${JSON.stringify(m.note)}`);
    check(m.notices.includes('Session restarted'), `notices: ${JSON.stringify(m.notices)}`);
    check(m.lastUser === 'after the restart', `the new run's first event was dropped: ${m.lastUser}`);
    check(m.status === 'Connected', m.status);
    await page.eval(`window.__q('.scroll').scrollTop = 1e6`);
    await settle();
    await page.screenshot(path.join(SHOTS, '04-restart.png'), { width: 1100, height: 760 });
  });

  await scenario('switching problems shows the other transcript, and coming back reuses the old nodes', async () => {
    await page.eval(`window.__q('.tutor p').__marker = 'kept'`);
    await page.eval(`history.pushState(null, '', '/problems/valid-parentheses/description/')`);
    // ensureMounted notices the new slug within its 2 s interval and closes the tab.
    await page.waitFor(`!document.getElementById('lc-tutor-panel-host').hasAttribute('data-active')`, { timeout: 5000, what: 'the panel to close on navigation' });
    await page.eval('window.__openTutor()');
    await settle();
    const other = await page.eval(`window.__qa('.user').map((u) => u.textContent)`);
    check(JSON.stringify(other) === JSON.stringify(['elsewhere']), `other problem: ${JSON.stringify(other)}`);
    await page.eval(`history.pushState(null, '', '/problems/two-sum/description/')`);
    await page.waitFor(`!document.getElementById('lc-tutor-panel-host').hasAttribute('data-active')`, { timeout: 5000, what: 'the panel to close again' });
    await page.eval('window.__openTutor()');
    await settle();
    check(await page.eval(`window.__q('.tutor p').__marker === 'kept'`), 'coming back rebuilt the transcript');
  });

  await scenario('activating the tab clears a stale send hint', async () => {
    await page.eval(`(() => { const h = window.__q('.hint'); h.textContent = 'old'; h.hidden = false; })()`);
    await page.eval(`document.querySelectorAll('.flexlayout__tab_button')[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
    await page.eval('window.__openTutor()');
    check(await page.eval(`window.__q('.hint').hidden`), 'the hint survived re-activation');
  });

  const exceptions = page.console.filter((line) => line.startsWith('exception'));
  await scenario('no exceptions in the page', async () => {
    check(exceptions.length === 0, exceptions.join('\n'));
  });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
