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

const { matchesRunButton, matchesSubmitButton } = require(path.join(__dirname, 'content.js'));

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
