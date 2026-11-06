// Tests for sign-in.js: telling a missing subscription sign-in apart from
// every other backend failure.
//
// Run with: node --test sign-in.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSignInError, isSignInText, signInError, signInMessage } from './sign-in.js';

test('Claude Code\'s own sign-in wording is recognized, and nothing else', () => {
  // As the Agent SDK threw it on 2026-11-06 with no sign-in.
  assert.equal(isSignInText('claude', 'Claude Code returned an error result: Not logged in · Please run /login'), true);
  assert.equal(isSignInText('claude', 'Invalid API key · Please run /login'), true);
  assert.equal(isSignInText('claude', 'OAuth token has expired. Please obtain a new token or refresh your existing token.'), true);
  assert.equal(isSignInText('claude', 'query ended with error_max_turns'), false);
  assert.equal(isSignInText('claude', 'Overloaded'), false);
  assert.equal(isSignInText('claude', undefined), false);
});

test('the Codex CLI\'s sign-in wording is recognized, and other failures are not', () => {
  for (const text of ['You are not logged in', 'Not signed in', 'boom: not authenticated', 'Please run `codex login`', '401 Unauthorized']) {
    assert.equal(isSignInText('chatgpt', text), true, text);
  }
  for (const text of ['rate limit reached', 'stream error', 'boom: disk full']) {
    assert.equal(isSignInText('chatgpt', text), false, text);
  }
});

test('the error is the instruction itself, with where to sign in, and is marked', () => {
  const claude = signInError('claude');
  assert.equal(isSignInError(claude), true);
  assert.equal(claude.provider, 'claude');
  assert.equal(claude.message, 'Claude Code is not signed in. In a terminal, run claude and type /login, then send your message again.');
  assert.equal(signInMessage('chatgpt', 'press Test connection again'), 'The Codex CLI is not signed in to ChatGPT. In a terminal, run codex login and choose ChatGPT, then press Test connection again.');
  assert.equal(isSignInError(new Error('Not logged in')), false);
  assert.doesNotMatch(claude.message + signInMessage('chatgpt'), /\u2014/);
});
