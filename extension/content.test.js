// Regression test for the Run/Submit button matchers in content.js.
//
// The Run button on the live page is icon-only (a FontAwesome play-icon
// SVG, no visible text) - btn.textContent.trim() is empty for it, so the
// old text-only match (`text === "run" || text === "run code"`) never
// fired and Run captures were silently never sent at all. Confirmed via
// live DOM inspection against a real leetcode.com problem page.
//
// content.js has no build step and isn't a module in the browser, so it
// exports matchesRunButton/matchesSubmitButton via a CommonJS
// `module.exports` guarded to be a no-op when `module` is undefined (i.e.
// in the real browser content-script context) - see the bottom of
// content.js. Button objects here are plain mocks (getAttribute /
// querySelector / textContent) rather than a real DOM/jsdom, since that's
// all the matchers touch.
//
// Run with: node --test content.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  matchesRunButton,
  matchesSubmitButton,
  requestModelCode,
  matchesRunShortcut,
  matchesSubmitShortcut,
  isDuplicateCapture,
  answerSnapshotRequest,
  sendCapture,
  handToBackground,
} = require(path.join(__dirname, 'content.js'));

// Minimal EventTarget-like mock so requestModelCode's CustomEvent
// request/response round-trip (normally against `document`, shared between
// content.js's isolated world and inject.js's page world) is testable
// without a real DOM. Node's built-in EventTarget already implements
// addEventListener/removeEventListener/dispatchEvent correctly, so this
// just aliases it rather than reimplementing event dispatch.
function mockEventTarget() {
  return new EventTarget();
}

function mockButton({ locator = null, ariaLabel = null, hasPlayIcon = false, text = '' } = {}) {
  return {
    getAttribute(name) {
      if (name === 'data-e2e-locator') return locator;
      if (name === 'aria-label') return ariaLabel;
      return null;
    },
    querySelector(selector) {
      return hasPlayIcon && /fa-play|data-icon="play"/.test(selector) ? {} : null;
    },
    textContent: text,
  };
}

// Plain mock of the KeyboardEvent fields matchesRunShortcut/matchesSubmitShortcut
// actually read - no real DOM/Event needed, matching mockButton's approach above.
function mockKeyboardEvent({ key = '', code = '', ctrlKey = false, metaKey = false, shiftKey = false, altKey = false, repeat = false } = {}) {
  return { key, code, ctrlKey, metaKey, shiftKey, altKey, repeat };
}

test('matchesRunButton matches an icon-only Run button with no visible text', () => {
  // The actual live-page shape: no text, no aria-label, no e2e locator -
  // just the play-icon SVG. This is exactly the case that silently
  // dropped every Run capture before this fix.
  const btn = mockButton({ hasPlayIcon: true, text: '' });
  assert.equal(matchesRunButton(btn), true);
  assert.equal(matchesSubmitButton(btn), false);
});

test('matchesRunButton matches via data-e2e-locator when present', () => {
  const btn = mockButton({ locator: 'console-run-button', text: '' });
  assert.equal(matchesRunButton(btn), true);
});

test('matchesRunButton matches via aria-label when present', () => {
  const btn = mockButton({ ariaLabel: 'Run Code', text: '' });
  assert.equal(matchesRunButton(btn), true);
});

test('matchesRunButton still matches on visible text as a last resort', () => {
  const btn = mockButton({ text: 'Run' });
  assert.equal(matchesRunButton(btn), true);
});

test('matchesSubmitButton matches via data-e2e-locator when present', () => {
  const btn = mockButton({ locator: 'console-submit-button', text: '' });
  assert.equal(matchesSubmitButton(btn), true);
  assert.equal(matchesRunButton(btn), false);
});

test('matchesSubmitButton still matches on visible "Submit" text', () => {
  const btn = mockButton({ text: 'Submit' });
  assert.equal(matchesSubmitButton(btn), true);
});

test('an unrelated button (no locator, no aria-label, no play icon, no matching text) matches neither', () => {
  const btn = mockButton({ text: 'Reset' });
  assert.equal(matchesRunButton(btn), false);
  assert.equal(matchesSubmitButton(btn), false);
});

test('data-e2e-locator, when present, is authoritative even if text would otherwise suggest the other button', () => {
  // Guards against a future page where the locator is present but
  // momentarily mismatched with stale text mid-render - locator wins.
  const btn = mockButton({ locator: 'console-run-button', text: 'Submit' });
  assert.equal(matchesRunButton(btn), true);
  assert.equal(matchesSubmitButton(btn), false);
});

test('requestModelCode resolves with the responder\'s result when inject.js answers', async () => {
  // Simulates inject.js: on the request event, synchronously dispatch a
  // matching response carrying the model's code.
  const events = mockEventTarget();
  events.addEventListener('leetcode-capture:request-code', (event) => {
    const { requestId } = JSON.parse(event.detail);
    events.dispatchEvent(new CustomEvent('leetcode-capture:code-response', {
      detail: JSON.stringify({ requestId, result: { code: 'def solve():\n    pass', language: 'python' } }),
    }));
  });

  const result = await requestModelCode(events, events, 500);
  assert.deepEqual(result, { code: 'def solve():\n    pass', language: 'python' });
});

test('requestModelCode ignores a response carrying a mismatched requestId', async () => {
  // Guards against a stale/duplicate response (e.g. from an overlapping
  // in-flight request) being mistaken for the current one.
  const events = mockEventTarget();
  events.addEventListener('leetcode-capture:request-code', () => {
    events.dispatchEvent(new CustomEvent('leetcode-capture:code-response', {
      detail: JSON.stringify({ requestId: 'stale-id', result: { code: 'wrong', language: 'python' } }),
    }));
  });

  const result = await requestModelCode(events, events, 50);
  assert.equal(result, null);
});

// Regression test for the Firefox-specific bug fixed alongside this test:
// Firefox's Xray wrapper boundary throws "Permission denied to access
// property" when reading a property off a CustomEvent `detail` object
// created in the *other* JS realm (content script <-> page script).
// requestModelCode() now JSON-stringifies `detail` on the request side and
// JSON.parses it on the response side specifically to avoid ever touching
// a property on a cross-realm object. This test guards the parse side: a
// response event whose `detail` isn't valid JSON (as would happen if
// something upstream regressed back to passing a raw object, which
// JSON.parse would reject rather than silently "work" the way property
// access on a raw object might in Chrome) must be ignored, not throw.
test('requestModelCode ignores (and does not throw on) a malformed non-JSON response detail', async () => {
  const events = mockEventTarget();
  events.addEventListener('leetcode-capture:request-code', () => {
    events.dispatchEvent(new CustomEvent('leetcode-capture:code-response', {
      detail: 'not valid json',
    }));
  });

  const result = await requestModelCode(events, events, 50);
  assert.equal(result, null);
});

test('requestModelCode resolves to null on timeout when nothing responds', async () => {
  // The case that matters most for the fallback path: inject.js never
  // loaded, or Monaco wasn't reachable, so no response ever arrives.
  const events = mockEventTarget();
  const result = await requestModelCode(events, events, 50);
  assert.equal(result, null);
});

// Regression test for the truncation bug PR #16 claimed to fix but didn't:
// manifest.json's web_accessible_resources[0].matches was set to the exact
// same match pattern as content_scripts[0].matches
// (`https://leetcode.com/problems/*`). Verified live against a real Chrome
// build in the PR that added this test: a content script and a
// web_accessible_resources entry sharing that identical narrow match
// pattern string causes Chrome to reject the whole extension at load time
// ("Invalid value for 'web_accessible_resources[0]'. Invalid match
// pattern.") - broadening web_accessible_resources's matches to
// `https://leetcode.com/*` (a strict superset of the content script's
// pattern, not the same string) makes it load clean. This is why the
// assertion below requires WAR's pattern to strictly cover - not just
// equal - the content script's pattern: reintroducing an identical pair is
// exactly what silently broke PR #16's fix in the first place.
// Regression tests for the keyboard-shortcut support: Ctrl/Cmd+' triggers a
// Run capture, Ctrl/Cmd+Enter triggers a Submit capture. This mapping is the
// opposite of what an early draft of the task assumed - live investigation
// found real leetcode.com Cloudflare-blocked in the environment that added
// this feature, and external research (LeetCode's own removed-then-missed
// native Ctrl+Enter-submits-code binding, and the well-known third-party
// "LeetCode Shortcuts" extension) turned up Ctrl+'=Run / Ctrl+Enter=Submit
// as the real-world convention. See content.js's own comment above
// matchesRunShortcut for the full story.
test('matchesRunShortcut matches Ctrl+apostrophe', () => {
  const event = mockKeyboardEvent({ key: "'", ctrlKey: true });
  assert.equal(matchesRunShortcut(event), true);
  assert.equal(matchesSubmitShortcut(event), false);
});

test('matchesRunShortcut matches Cmd+apostrophe (metaKey, for Mac)', () => {
  const event = mockKeyboardEvent({ key: "'", metaKey: true });
  assert.equal(matchesRunShortcut(event), true);
});

test('matchesRunShortcut matches via event.code "Quote" as a layout fallback even if event.key differs', () => {
  const event = mockKeyboardEvent({ key: 'Dead', code: 'Quote', ctrlKey: true });
  assert.equal(matchesRunShortcut(event), true);
});

test('matchesRunShortcut does not match plain apostrophe with no modifier held', () => {
  // The common case while just typing a string literal containing a quote.
  const event = mockKeyboardEvent({ key: "'" });
  assert.equal(matchesRunShortcut(event), false);
});

test('matchesRunShortcut does not match Ctrl+Shift+apostrophe', () => {
  const event = mockKeyboardEvent({ key: "'", ctrlKey: true, shiftKey: true });
  assert.equal(matchesRunShortcut(event), false);
});

test('matchesSubmitShortcut matches Ctrl+Enter', () => {
  const event = mockKeyboardEvent({ key: 'Enter', ctrlKey: true });
  assert.equal(matchesSubmitShortcut(event), true);
  assert.equal(matchesRunShortcut(event), false);
});

test('matchesSubmitShortcut matches Cmd+Enter (metaKey, for Mac)', () => {
  const event = mockKeyboardEvent({ key: 'Enter', metaKey: true });
  assert.equal(matchesSubmitShortcut(event), true);
});

test('matchesSubmitShortcut does not match plain Enter with no modifier held', () => {
  // The overwhelmingly common case: every newline typed while writing code.
  // This must never accidentally match, or every Enter keystroke would fire
  // a Submit capture.
  const event = mockKeyboardEvent({ key: 'Enter' });
  assert.equal(matchesSubmitShortcut(event), false);
});

test('matchesSubmitShortcut does not match Ctrl+Alt+Enter', () => {
  const event = mockKeyboardEvent({ key: 'Enter', ctrlKey: true, altKey: true });
  assert.equal(matchesSubmitShortcut(event), false);
});

// Regression tests for the auto-repeat gap: holding a key combo down makes
// the browser fire repeated keydown events (event.repeat === true) - the
// first of which lands well outside sendCapture's 300ms dedup window (an
// initial ~500ms delay before repeats start), so without an explicit
// event.repeat check, briefly holding the combo down would produce a second
// real capture. Only the genuine initial (non-repeat) press should match.
test('matchesRunShortcut does not match an auto-repeat Ctrl+apostrophe from a held-down key', () => {
  const event = mockKeyboardEvent({ key: "'", ctrlKey: true, repeat: true });
  assert.equal(matchesRunShortcut(event), false);
});

test('matchesSubmitShortcut does not match an auto-repeat Ctrl+Enter from a held-down key', () => {
  const event = mockKeyboardEvent({ key: 'Enter', ctrlKey: true, repeat: true });
  assert.equal(matchesSubmitShortcut(event), false);
});

// Regression tests for sendCapture's dedup guard, which collapses a second
// capture for the same trigger arriving shortly after the first into a
// no-op - guarding against the shortcut listener and handleDelegatedClick
// both firing for what's really one logical Run/Submit event (see
// content.js's own comment above isDuplicateCapture for the full
// reasoning). isDuplicateCapture is a pure function so this is tested
// directly, without going through sendCapture's real fetch/DOM-reading side
// effects.
test('isDuplicateCapture is false for a trigger with no prior capture recorded', () => {
  assert.equal(isDuplicateCapture('run', 1000, {}), false);
});

test('isDuplicateCapture is true for the same trigger arriving just after a prior capture', () => {
  const lastCaptureAt = { submit: 1000 };
  assert.equal(isDuplicateCapture('submit', 1200, lastCaptureAt), true);
});

test('isDuplicateCapture is false once the dedup window has fully elapsed', () => {
  const lastCaptureAt = { submit: 1000 };
  assert.equal(isDuplicateCapture('submit', 1301, lastCaptureAt), false);
});

test('isDuplicateCapture tracks each trigger independently - a recent "run" capture does not suppress a "submit" capture', () => {
  const lastCaptureAt = { run: 1000 };
  assert.equal(isDuplicateCapture('submit', 1050, lastCaptureAt), false);
});

test("manifest's web_accessible_resources matches strictly cover (are broader than) content_scripts matches", () => {
  const manifest = require(path.join(__dirname, 'manifest.json'));

  const contentScriptMatches = manifest.content_scripts.flatMap((cs) => cs.matches);
  const warMatches = manifest.web_accessible_resources.flatMap((war) => war.matches);

  // Only handles the "broader path wildcard on the same origin" case this
  // extension actually relies on (e.g. ".../*" strictly covering
  // ".../problems/*") - deliberately excludes an exact-string match, since
  // that's the exact shape of the bug this test guards against.
  function patternStrictlyCovers(warPattern, csPattern) {
    if (warPattern === csPattern) return false;
    const warPrefix = warPattern.replace(/\*$/, '');
    return warPattern.endsWith('*') && csPattern.startsWith(warPrefix);
  }

  for (const csPattern of contentScriptMatches) {
    const covered = warMatches.some((warPattern) => patternStrictlyCovers(warPattern, csPattern));
    assert.ok(
      covered,
      `content_scripts match "${csPattern}" has no strictly-broader web_accessible_resources match ` +
        '- an identical pattern pair reproduces the live-verified Chrome load failure this test guards against'
    );
  }
});

// answerSnapshotRequest reads the page the same way a capture does, so these
// tests give it a stand-in `document` with just what those reads touch.
function withFakeDocument(fn) {
  const previous = globalThis.document;
  globalThis.document = {
    title: 'Two Sum - LeetCode',
    querySelectorAll: (selector) => (selector === 'button' ? [{ textContent: ' Python3 ' }] : []),
    querySelector: (selector) =>
      selector === '[data-track-load="description_content"]' ? { textContent: ' Given an array... ' } : null,
  };
  return Promise.resolve(fn()).finally(() => {
    globalThis.document = previous;
  });
}

function snapshotRequest(requestId) {
  return new CustomEvent('leetcode-capture:snapshot-request', { detail: JSON.stringify({ requestId }) });
}

function nextSnapshotResponse(events) {
  return new Promise((resolve) => {
    events.addEventListener('leetcode-capture:snapshot-response', (event) => resolve(JSON.parse(event.detail)), { once: true });
  });
}

test('answerSnapshotRequest answers with the Monaco model code and the page details', () =>
  withFakeDocument(async () => {
    const events = mockEventTarget();
    const response = nextSnapshotResponse(events);
    await answerSnapshotRequest(snapshotRequest('r1'), events, async () => ({ code: 'x = 1', language: 'python' }));
    assert.deepEqual(await response, {
      requestId: 'r1',
      snapshot: { code: 'x = 1', language: 'Python3', problemTitle: 'Two Sum', problemDescription: 'Given an array...' },
    });
  }));

test('answerSnapshotRequest answers null when the model cannot be read (never a truncated DOM scrape)', () =>
  withFakeDocument(async () => {
    const events = mockEventTarget();
    const response = nextSnapshotResponse(events);
    await answerSnapshotRequest(snapshotRequest('r2'), events, async () => null);
    assert.deepEqual(await response, { requestId: 'r2', snapshot: null });
    const failing = nextSnapshotResponse(events);
    await answerSnapshotRequest(snapshotRequest('r3'), events, async () => {
      throw new Error('inject.js blocked');
    });
    assert.deepEqual(await failing, { requestId: 'r3', snapshot: null });
  }));

test('answerSnapshotRequest ignores a request it cannot parse', async () => {
  const events = mockEventTarget();
  let answered = false;
  events.addEventListener('leetcode-capture:snapshot-response', () => (answered = true));
  await answerSnapshotRequest({ detail: 'not json' }, events, async () => ({ code: 'x' }));
  await answerSnapshotRequest({ detail: JSON.stringify({}) }, events, async () => ({ code: 'x' }));
  assert.equal(answered, false);
});

test('sendCapture sends nothing when the editor model cannot be read, and tells the panel (no DOM scrape)', async (t) => {
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    posted.push(options && options.body);
    return new Response('{}');
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const events = new EventTarget();
  const seen = [];
  events.addEventListener('leetcode-capture:capture-start', () => seen.push('start'));
  events.addEventListener('leetcode-capture:editor-read-failed', (event) => seen.push(JSON.parse(event.detail)));
  await sendCapture('run', { events, readCode: async () => null });
  assert.deepEqual(seen, ['start', { trigger: 'run' }]);
  assert.deepEqual(posted, [], 'nothing reaches the relay');
});

test('a capture goes to the background worker when it runs the tutor, and to the relay otherwise', async (t) => {
  const sent = [];
  let answer = { handled: true };
  globalThis.chrome = {
    runtime: {
      id: 'ext',
      sendMessage: async (message) => {
        sent.push(message);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
  t.after(() => {
    delete globalThis.chrome;
  });
  const capture = { trigger: 'submit', code: 'x', problemSlug: 'two-sum' };
  assert.equal(await handToBackground(capture), true);
  assert.deepEqual(sent, [{ type: 'lc-tutor:capture', capture }]);
  answer = { handled: false };
  assert.equal(await handToBackground(capture), false, 'the helper runtime leaves it to the relay');
  answer = new Error('Extension context invalidated.');
  assert.equal(await handToBackground(capture), false, 'a reloaded extension falls back to the relay');
  delete globalThis.chrome;
  assert.equal(await handToBackground(capture), false, 'no extension API at all');
});

// A stand-in for the real description element: just nodeType, tagName,
// childNodes and textContent, which is all a DOM walk touches.
function fakeText(value) {
  return { nodeType: 3, nodeValue: value, textContent: value };
}
function fakeElement(tagName, ...childNodes) {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes,
    get textContent() {
      return childNodes.map((n) => n.textContent).join('');
    },
  };
}
// The constraints the way LeetCode renders them: exponents in <sup>.
const SUPERSCRIPT_DESCRIPTION = fakeElement(
  'div',
  fakeElement('p', fakeText(' Given an array nums.')),
  fakeElement(
    'ul',
    fakeElement('li', fakeElement('code', fakeText('2 <= nums.length <= 10'), fakeElement('sup', fakeText('4')))),
    fakeElement(
      'li',
      fakeElement('code', fakeText('-10'), fakeElement('sup', fakeText('9')), fakeText(' <= nums[i] <= 10'), fakeElement('sup', fakeText('9')))
    ),
    fakeElement('li', fakeText('x'), fakeElement('sub', fakeText('i')), fakeText(' is distinct '))
  )
);
const SUPERSCRIPT_TEXT = 'Given an array nums.2 <= nums.length <= 10^4-10^9 <= nums[i] <= 10^9x_i is distinct';

function withDescription(descEl, fn) {
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    title: 'Two Sum - LeetCode',
    querySelectorAll: () => [],
    querySelector: (selector) => (selector === '[data-track-load="description_content"]' ? descEl : null),
  };
  globalThis.window = { location: { href: 'https://leetcode.com/problems/two-sum/', pathname: '/problems/two-sum/' } };
  return Promise.resolve(fn()).finally(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  });
}

test('the description keeps exponents and subscripts (10^4, not 104) in a snapshot and a capture', (t) =>
  withDescription(SUPERSCRIPT_DESCRIPTION, async () => {
    const events = mockEventTarget();
    const response = nextSnapshotResponse(events);
    await answerSnapshotRequest(snapshotRequest('sup'), events, async () => ({ code: 'x = 1', language: 'python' }));
    assert.equal((await response).snapshot.problemDescription, SUPERSCRIPT_TEXT);

    const sent = [];
    globalThis.chrome = { runtime: { id: 'ext', sendMessage: async (message) => (sent.push(message), { handled: true }) } };
    t.after(() => {
      delete globalThis.chrome;
    });
    await sendCapture('submit', { events: new EventTarget(), readCode: async () => 'x = 1' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].capture.problemDescription, SUPERSCRIPT_TEXT);
  }));

// ---- syncing the solved problems -------------------------------------------

const { fetchSolvedSlugs, autoSync } = require(path.join(__dirname, 'content.js'));

function graphqlPages(pages, { signedIn = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    assert.ok(!/status:\s*"/.test(query) && /\$filters: QuestionListFilterInput/.test(query) && variables.filters.status === 'AC', 'the filter is a typed variable');
    calls.push({ url, skip: variables.skip, limit: variables.limit, credentials: init.credentials });
    const questions = pages[variables.skip / variables.limit] || [];
    const total = pages.flat().length;
    return { ok: true, json: async () => ({ data: { userStatus: { isSignedIn: signedIn }, problemsetQuestionList: { total, questions } } }) };
  };
  return { fetchImpl, calls };
}

test('fetchSolvedSlugs pages through every accepted problem with the page session', async () => {
  const page = (from, n) => Array.from({ length: n }, (_, i) => ({ titleSlug: `p-${from + i}`, status: 'ac' }));
  const { fetchImpl, calls } = graphqlPages([page(0, 100), page(100, 100), [...page(200, 22), { titleSlug: 'tried', status: 'notac' }]]);
  const result = await fetchSolvedSlugs(fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.slugs.length, 222);
  assert.ok(!result.slugs.includes('tried'));
  assert.deepEqual(calls.map((c) => c.skip), [0, 100, 200]);
  assert.ok(calls.every((c) => c.url === '/graphql/' && c.credentials === 'include'));
});

test('fetchSolvedSlugs tells a signed-out page and a failing one apart', async () => {
  assert.deepEqual(await fetchSolvedSlugs(graphqlPages([[]], { signedIn: false }).fetchImpl), { ok: false, reason: 'signed-out' });
  assert.deepEqual(await fetchSolvedSlugs(async () => ({ ok: false })), { ok: false, reason: 'failed' });
  assert.deepEqual(await fetchSolvedSlugs(async () => { throw new Error('offline'); }), { ok: false, reason: 'failed' });
  assert.deepEqual(await fetchSolvedSlugs(async () => ({ ok: true, json: async () => ({ errors: [{ message: 'x' }] }) })), { ok: false, reason: 'failed' });
});

test('autoSync fetches and reports only when the worker says a sync is due', async () => {
  const sent = [];
  const fetchSolved = async () => ({ ok: true, slugs: ['two-sum'] });
  const notDue = async (m) => (sent.push(m.type), { ok: true, due: false });
  assert.equal(await autoSync({ send: notDue, fetchSolved }), false);
  assert.deepEqual(sent, ['lc-tutor:sync-check']);
  sent.length = 0;
  const due = async (m) => (sent.push(m), m.type === 'lc-tutor:sync-check' ? { ok: true, due: true } : { ok: true, added: 1, total: 1 });
  assert.equal(await autoSync({ send: due, fetchSolved }), true);
  assert.deepEqual(sent[1], { type: 'lc-tutor:sync-solved', slugs: ['two-sum'] });
  assert.equal(await autoSync({ send: due, fetchSolved: async () => ({ ok: false, reason: 'signed-out' }) }), false);
});
