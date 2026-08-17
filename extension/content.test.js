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

const { matchesRunButton, matchesSubmitButton, requestModelCode } = require(path.join(__dirname, 'content.js'));

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
