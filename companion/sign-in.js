// companion/sign-in.js - telling "the subscription CLI is not signed in"
// apart from every other backend failure, so the student gets one plain
// instruction instead of the CLI's own text behind a developer prefix.
//
// The Claude subscription runs Claude Code through the Agent SDK, which
// throws "Claude Code returned an error result: Not logged in · Please run
// /login" (seen live on 2026-11-06); the ChatGPT subscription runs the Codex
// CLI, which needs "codex login". An error made here carries
// `code: 'signin'` and the provider, and its message is the instruction
// itself: companion.js shows it without a prefix and marks the tutor as
// needing a sign-in (the panel and the options page show that instead of
// a green light) until a request succeeds.

export const SIGN_IN_CODE = 'signin';

// What the student is told. `then` is the step after signing in.
export function signInMessage(provider, then = 'send your message again') {
  if (provider === 'chatgpt') {
    return `The Codex CLI is not signed in to ChatGPT. In a terminal, run codex login and choose ChatGPT, then ${then}.`;
  }
  return `Claude Code is not signed in. In a terminal, run claude and type /login, then ${then}.`;
}

// Claude Code's own wording for a missing or expired sign-in.
const CLAUDE_SIGN_IN_RE = /not logged in|please run \/login|oauth token (?:has )?expired|invalid bearer token/i;
// The Codex CLI's (its exact text varies by version, so this is broad, but
// it is only matched against what codex itself printed).
const CODEX_SIGN_IN_RE = /not logged in|not signed in|not authenticated|log ?in required|please (?:run|use) .?codex login|unauthorized|\b401\b/i;

export function signInError(provider) {
  return Object.assign(new Error(signInMessage(provider)), { code: SIGN_IN_CODE, provider });
}

// `text` is what the backend's CLI reported; true when it means the
// subscription's sign-in is missing or expired.
export function isSignInText(provider, text) {
  if (typeof text !== 'string' || !text) return false;
  return (provider === 'chatgpt' ? CODEX_SIGN_IN_RE : CLAUDE_SIGN_IN_RE).test(text);
}

export function isSignInError(err) {
  return Boolean(err && err.code === SIGN_IN_CODE);
}
