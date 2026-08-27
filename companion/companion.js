#!/usr/bin/env node
// companion/companion.js - single-process companion that owns a live chat
// conversation directly (no tmux, no CLI-pane scraping).
//
// Replaces the old start.sh + watch.js pair. This program:
//   - Tails relay-server/data/captures.jsonl for new Run/Submit captures,
//     the same way watch.js used to (byte-offset tracking, tail-not-backfill
//     on first run).
//   - Runs a normal readline chat loop on stdin/stdout so Thomson can type
//     into it directly at any time.
//   - Sends each new capture into the same ongoing conversation through a
//     swappable backend, then prints the real response - no pane, nothing
//     to scrape.
//
// Backends (set COMPANION_BACKEND):
//   - "claude" (default): the Claude Agent SDK (@anthropic-ai/claude-agent-sdk),
//     a real programmatic session - not the `claude` CLI driven by keystrokes.
//   - "local": plain HTTP against an OpenAI-compatible chat-completions
//     endpoint (e.g. a local Ollama install). No extra dependency - Node's
//     built-in fetch.
//
// See the "Companion" section of the top-level README.md for setup,
// environment variables, and exactly what credentials each backend needs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  prepareVaultContext,
  extractVaultBlock,
  writeVaultAutoSummary,
  resolveVaultConfig,
  validateVaultPath,
} from './vault-summary.js';
import {
  stylingEnabled,
  dim,
  promptString,
  turnMarker,
  boxRule,
  renderMarkdown,
  spinnerFrame,
  createMarkdownStreamer,
  refreshWidth,
  indentContinuation,
} from './terminal-format.js';
import { ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING, createMouseFilter } from './mouse-input.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// --- alternate screen buffer -------------------------------------------
//
// The same mechanism vim/less/htop use: swap to a separate screen buffer
// for the whole session, so nothing companion.js prints ever mixes into
// the terminal's normal scrollback, and exiting - any path: /exit, Ctrl+C,
// a crash - restores the terminal to exactly what was on screen before
// companion.js ever ran. TTY-only: makes no sense (and would corrupt
// output) when piped. Entered and the matching cleanup registered
// together, synchronously, so there's never a window where the terminal
// could be left stuck in the alternate buffer with nothing to restore it.
//
// Most terminals (xterm and its many descendants, including kitty)
// automatically turn on "alternate scroll mode" (DECSET 1007) the moment
// the alternate screen buffer is active: with no native scrollback to show
// while in the alternate buffer, a mouse wheel notch gets translated into
// an Up/Down arrow keypress instead, on the theory that a full-screen
// alt-screen app (a pager, an editor) will handle its own scrolling with
// the arrow keys it already reads. Readline has no idea any of this is
// happening - it just sees an arrow key, which is *also* its own built-in
// binding for cycling through previously-typed input lines. The result:
// scrolling the wheel to read back through the conversation instead
// silently replaces whatever's in the prompt with an old typed message.
// Explicitly disabling 1007 stops the wheel-to-arrow-key translation, so
// scrolling no longer collides with readline's input history - though
// what the wheel does *instead* (the terminal's own alt-screen scrollback,
// if it has one, or nothing at all) is then up to the terminal, not
// something this program can fully control from here. Not restored on
// exit: 1007 only has any effect while also inside the alternate screen
// buffer (1049), so once that's left, this can't affect normal terminal
// use afterward either way.
// Mouse-wheel scrolling *inside* the alternate screen (see mouse-input.js
// and the "scrollback viewport" section further down) needs the terminal's
// own SGR mouse-reporting mode (1000+1006) turned on for the duration too -
// entered/exited in the same breath as the alternate screen itself, for
// the same reason: never leave the shell in a mode it didn't ask for once
// this program exits. process.stdin.setRawMode(true) is required for
// this - normally readline manages that on its own for a TTY input, but
// stdin here gets wired through a filtering PassThrough instead (see
// "raw input / mouse-wheel scrollback" below), which isn't a TTY, so readline
// would never touch stdin's raw mode at all left to its own devices.
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[?1049h');
  process.stdout.write('\x1b[?1007l');
  process.stdout.write(ENABLE_MOUSE_TRACKING);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.on('exit', () => {
    process.stdout.write(DISABLE_MOUSE_TRACKING);
    process.stdout.write('\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });
}

// --- config ---------------------------------------------------------------

const BACKEND = process.env.COMPANION_BACKEND || 'claude';
const MODEL = process.env.COMPANION_MODEL || null;
// Ollama's own default OpenAI-compat address - also used below to decide
// whether COMPANION_LOCAL_API's "auto" default should prefer Ollama's native
// chat API (see the LOCAL_API/LOCAL_NUM_CTX comment).
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const BASE_URL = process.env.COMPANION_BASE_URL || DEFAULT_BASE_URL;
const API_KEY = process.env.COMPANION_API_KEY || null;

// Which HTTP API LocalBackend actually speaks: 'openai' (the standard
// /v1/chat/completions shape, the only thing any non-Ollama OpenAI-compatible
// server understands) or 'native' (Ollama's own /api/chat, which - unlike the
// compat endpoint - actually honors a `num_ctx` option; see LOCAL_NUM_CTX and
// LocalBackend's class comment for why that matters). 'auto' (the default)
// picks 'native' only when BASE_URL is still Ollama's own out-of-the-box
// default above - i.e. nothing has pointed this companion at some other
// server - and 'openai' otherwise, so anyone who has set COMPANION_BASE_URL
// to a different, genuinely OpenAI-compatible server keeps working exactly
// as before with zero behavior change. Explicit "openai"/"native" (case-
// insensitive) always overrides the heuristic.
const LOCAL_API_RAW = (process.env.COMPANION_LOCAL_API || 'auto').toLowerCase();
const LOCAL_API =
  LOCAL_API_RAW === 'openai' || LOCAL_API_RAW === 'native'
    ? LOCAL_API_RAW
    : BASE_URL === DEFAULT_BASE_URL
      ? 'native'
      : 'openai';

// Context window (in tokens) requested from Ollama's native /api/chat via
// `options.num_ctx` - only used when LOCAL_API resolves to 'native'; the
// OpenAI-compat endpoint ignores this entirely (see LocalBackend's class
// comment). 8192 is double the 4096 this project's configured Ollama model
// (gemma4:26b) actually runs with by default, and was confirmed live to turn
// a real single-capture failure (a normal ~150-line solution plus its problem
// description, no prior history) into a normal completed reply with the
// exact same input - raise it further if an even larger real capture still
// gets cut off.
const LOCAL_NUM_CTX = Number(process.env.COMPANION_LOCAL_NUM_CTX || 8192);

// Off by default: a portable checkout of this repo for someone other than
// Thomson won't have this vault's Study/Algorithms structure, or even use
// Obsidian. Thomson turns this on in his own untracked environment. See the
// "Vault auto-summary" section below and README.md for what it does.
const VAULT_AUTO_SUMMARY = /^(1|true|yes)$/i.test(process.env.VAULT_AUTO_SUMMARY || '');

// On by default (opposite of VAULT_AUTO_SUMMARY above) - see the
// "automatic context reset on problem switch" section below for what this
// does and why leaving it on is the safer default: without it, a stale
// problem's full code/discussion keeps getting resent as context on every
// turn even long after the conversation has moved on to something else, with
// only the system prompt's own soft wording asking the model to notice.
// Explicit "0"/"false"/"no" (case-insensitive) turns it off; anything else,
// including unset, leaves it on.
const AUTO_CLEAR_CONTEXT = !/^(0|false|no)$/i.test(process.env.COMPANION_AUTO_CLEAR_CONTEXT || '');

// How many user+assistant turn-pairs LocalBackend.history keeps before
// dropping the oldest ones - see LocalBackend.trimHistory for what this
// fixes and why trimming (rather than a bigger num_ctx) is the portable
// choice here. AUTO_CLEAR_CONTEXT above already resets history to nothing
// on a problem switch; this is the additional bound *within* one still-
// current problem's own back-and-forth, which AUTO_CLEAR_CONTEXT alone
// doesn't touch. A whole number of turns, not a token/character budget -
// simpler to reason about and tune, and already sufficient to keep resent
// history bounded regardless of how large any individual capture is.
// Defaults to 6 (6 full Run/Submit exchanges) - comfortably more than a
// typical single-problem session needs, while still capping the worst case
// long before it can exhaust a small local model's context window the way
// unbounded growth did. 0 (or unset to a non-number) disables trimming
// entirely, restoring the old unbounded behavior - not the default, since
// that's exactly the failure mode this exists to prevent.
const LOCAL_MAX_HISTORY_TURNS = Number(process.env.COMPANION_LOCAL_MAX_HISTORY_TURNS || 6);

const { vaultPath: VAULT_PATH, algorithmsSubfolder: VAULT_ALGORITHMS_SUBFOLDER } = resolveVaultConfig();
// Fail loudly at startup, not on the first Submit - a wrong or unset vault
// path should never silently fabricate a new folder tree (see
// vault-notes.js's validateVaultPath). Only checked when the feature is
// actually on, so a portable checkout with it off never needs a real vault.
if (VAULT_AUTO_SUMMARY) validateVaultPath(VAULT_PATH);

// The tutor persona both backends share. Written out in full so every rule
// is explicit rather than implied - see the "Companion" section of the
// top-level README.md for the full rationale and how each backend wires
// this in.
const TUTOR_SYSTEM_PROMPT = `You are a patient coding tutor holding office hours for a student working through LeetCode problems. You are a teacher, not a solution generator: your job is to help the student understand and improve their own code, never to solve the problem for them.

Each message you receive is either the student's own code from a Run/Submit attempt (a "capture") or an ordinary chat message. Every capture message tells you explicitly, near the top, whether it was a Run or a Submit - always follow that label, not any guess of your own about which one it is.

On a Submit capture, respond following these steps every time, in order:

1. Start by acknowledging that you received their code.
2. Look back over the conversation so far. If this is the first capture you've seen for this specific problem (Run or Submit), briefly introduce it: name the problem and describe its general category or pattern, e.g. "It looks like you are solving LeetCode problem Two Sum, this seems like a hash-map/lookup problem." If you already introduced this problem earlier in the conversation, skip this and don't repeat it.
3. Describe, in your own words, the approach their code appears to take. Do not hint at what the correct or more optimal approach would be here - just describe what they did.
4. Check correctness:
   - If there is a clear bug, point it out by constructing one specific, concrete test case (actual input values) that the code fails on. Don't just assert that a bug exists - show the input. Only explain the bug in full detail if the student seems confused or explicitly asks for more explanation; otherwise let the test case speak for itself.
   - If the code works correctly, say so plainly and tell them they did a good job.
5. Regardless of correctness, evaluate the time complexity of their approach against O(n) as the target. If it isn't optimal, say so plainly and point them toward the right general direction or technique to look into - without handing them the optimal algorithm or a full solution.
6. Never give the actual answer, the optimal algorithm, or a strong hint toward either unless the student explicitly asks for it. Until they ask, let them work it out themselves.
7. Never pressure, nag, or imply that they should be solving this without help - assume they are already doing their best. Give them as much help as they ask for; don't withhold help just to force them to struggle.

On a Run capture, do not do the full Submit breakdown above - no approach description, no correctness check, no complexity evaluation. Just:

1. Briefly acknowledge that you received the code and are standing by, e.g. "Got your run - let me know if you want to talk through it." If this is the first capture you've seen for this specific problem (Run or Submit), also briefly introduce the problem as in step 2 above; otherwise skip that.
2. Stop there. Don't volunteer analysis of the code. If the student then asks a direct question about that attempt, answer it normally, drawing on the full code you were given - the restriction is only on unprompted analysis of a Run, not on your ability to discuss it when asked.

Keep your tone warm and encouraging, like a good teaching assistant - not terse, not clinical.`;

// Two of Thomson's general writing-style preferences (from his global agent
// instructions, ~/.claude/CLAUDE.md) that are actually about what the model
// says out loud, unlike the rest of that file, which is engineering-workflow
// guidance (commit message conventions, CHANGELOG.md handling, and the like)
// that has no bearing on a chat companion. Used by both backends - shared
// rather than folded into TUTOR_SYSTEM_PROMPT above only because it's a
// Thomson-specific preference, not an inherent property of the tutor persona
// itself. This used to be LocalBackend-only, on the reasoning that
// ClaudeBackend "already inherits these independently from Thomson's real
// global Claude preferences" via the Agent SDK loading his user-level
// settings/CLAUDE.md by default - true before the `settingSources: []`
// isolation below (see ClaudeBackend.sendMessage's own comment), confirmed
// live: an identical prompt reliably avoided an em dash with the SDK's old
// default settings-loading, then used one once `settingSources: []` was
// added. Rather than leave that isolation in place and lose the preference,
// both backends now say so explicitly - cheap (a couple dozen tokens) next
// to the isolation's own ~98% reduction, and doesn't depend on inheriting
// the rest of that file's unrelated engineering guidance, which was never
// meant for this persona in the first place.
const STYLE_ADDENDUM = `Two additional style rules for your responses:
- Never use an em dash ("—"). Use a plain dash ("-") instead.
- Never use emojis.`;

const SCRATCH_DIR =
  process.env.LEETCODE_COMPANION_SCRATCH ||
  path.join(os.homedir(), '.local', 'state', 'leetcode-companion', 'scratch');
const CAPTURES_PATH =
  process.env.LEETCODE_CAPTURES_FILE ||
  path.join(REPO_ROOT, 'relay-server', 'data', 'captures.jsonl');
const STATE_PATH =
  process.env.LEETCODE_COMPANION_STATE_FILE || path.join(__dirname, '.companion-state.json');
const POLL_MS = Number(process.env.LEETCODE_COMPANION_POLL_MS || 1000);

// Mirrors server.js's own HOST/PORT resolution exactly (127.0.0.1, and
// CAPTURE_PORT if set) so the health check below asks the same address the
// relay server actually binds to.
const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = process.env.CAPTURE_PORT ? Number(process.env.CAPTURE_PORT) : 8135;
const RELAY_SERVER_DIR = path.join(REPO_ROOT, 'relay-server');

// --- backend adapters -------------------------------------------------------
//
// Shared shape: async sendMessage(text) -> Promise<string>. Each backend
// manages its own conversation continuity however is natural for it (the
// Claude backend resumes its own SDK session by id; the local backend keeps
// an explicit messages array and resends it in full, OpenAI-chat style).

class ClaudeBackend {
  constructor({ model }) {
    this.model = model;
    this.sessionId = undefined;
    this.queryFn = null;
  }

  async ensureLoaded() {
    if (this.queryFn) return;
    let mod;
    try {
      mod = await import('@anthropic-ai/claude-agent-sdk');
    } catch (err) {
      throw new Error(
        `could not load @anthropic-ai/claude-agent-sdk (run "npm install" in companion/ first): ${err.message}`
      );
    }
    this.queryFn = mod.query;
  }

  async sendMessage(text, { onChunk } = {}) {
    await this.ensureLoaded();
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });

    // A plain string here fully replaces Claude Code's own default system
    // prompt rather than appending to it - the SDK only preserves the
    // default when systemPrompt is `{ type: 'preset', preset: 'claude_code' }`
    // (see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts). That's the
    // right call here: this companion has no tools configured and isn't
    // acting as a coding agent over this repo, so the Claude Code framing
    // (tool-use conventions, CLI-oriented tone) would only get in the way of
    // the tutor persona.
    //
    // systemPrompt only controls the system-prompt *text* though - it says
    // nothing about which tools get defined in the model's context or which
    // filesystem settings (project/user/local CLAUDE.md, .mcp.json, plugins)
    // get loaded, both of which default to "everything available" when left
    // unset (see sdk.d.ts's `tools`/`mcpServers`/`settingSources`). Measured
    // live via a direct SDK call matching this shape (custom cwd, this same
    // plain-string systemPrompt, nothing else set): the resulting turn
    // carried ~12,500 tokens of context that had nothing to do with the
    // tutor conversation at all - the SDK's ~25 built-in tools (Task, Bash,
    // Edit, Write, Read, and the rest) plus, in an environment with any MCP
    // connectors configured (this one had Gmail/Calendar/Drive), every one
    // of *their* tool definitions too - none of which this companion ever
    // calls. `tools: []` is the specific fix for the built-in set - note
    // `allowedTools: []` looked like the obvious option but does NOT do
    // this: per sdk.d.ts it only skips the permission prompt for listed
    // tools, it doesn't remove anything from context, confirmed live (still
    // ~10,800 tokens with `allowedTools: []` alone, tool list unchanged).
    // `mcpServers: {}` plus `strictMcpConfig: true` is the equivalent fix for
    // MCP-server tool definitions - `strictMcpConfig` is required, not just
    // `mcpServers: {}` alone, since without it the SDK still merges in
    // whatever a user's own project/user config declares. `settingSources:
    // []` additionally opts out of loading any CLAUDE.md/AGENTS.md at all
    // (filesystem settings default to "load everything" too, independent of
    // the systemPrompt override above) - defense in depth on top of `cwd`
    // already pointing at SCRATCH_DIR, a dedicated non-project directory, so
    // this repo's own 53KB CLAUDE.md was never actually reachable from here
    // in practice (confirmed: no CLAUDE.md exists anywhere in SCRATCH_DIR's
    // own directory-ancestor chain either) - but making the isolation
    // explicit here means that stays true regardless of where SCRATCH_DIR
    // ever points. With all four set, the same measured call dropped to 197
    // tokens total, zero cache overhead - a ~98% reduction - confirming the
    // ~12,500 tokens above really was unused tool/settings scaffolding, not
    // anything the tutor persona needed.
    const options = {
      cwd: SCRATCH_DIR,
      systemPrompt: `${TUTOR_SYSTEM_PROMPT}\n\n${STYLE_ADDENDUM}`,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
    };
    if (this.model) options.model = this.model;
    if (this.sessionId) options.resume = this.sessionId;
    // Only opt into partial-message events when a caller actually wants
    // them - onReply's vault-block-stripping path (see sendAndPrint) calls
    // this with no onChunk at all, and this stays a plain, unchanged
    // request in that case.
    if (onChunk) options.includePartialMessages = true;

    let resultText = null;
    let errorNote = null;
    for await (const message of this.queryFn({ prompt: text, options })) {
      if (message.session_id) this.sessionId = message.session_id;
      // A `stream_event` message wraps a raw Anthropic API stream event
      // (see SDKPartialAssistantMessage in sdk.d.ts); only its text deltas
      // are relevant here - tool-use/thinking/citation deltas never appear
      // for this backend, since it's configured with no tools.
      if (onChunk && message.type === 'stream_event') {
        const event = message.event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          onChunk(event.delta.text);
        }
      }
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = message.result;
        } else {
          errorNote = `query ended with ${message.subtype}${
            message.errors && message.errors.length ? `: ${message.errors.join('; ')}` : ''
          }`;
        }
      }
    }
    if (resultText !== null && resultText.trim()) return resultText;
    if (resultText !== null) {
      throw new Error('Agent SDK query succeeded but returned an empty result');
    }
    throw new Error(errorNote || 'no result message received from the Agent SDK');
  }

  // Drops the resumed session id so the next sendMessage starts a fresh SDK
  // session (options.resume is only set at all when this.sessionId is
  // truthy - see sendMessage above) rather than continuing the old one.
  resetContext() {
    this.sessionId = undefined;
  }
}

// Picks the actual reply text out of an OpenAI-compatible chat-completion
// response (or accumulated stream), used by both LocalBackend.sendMessage
// (non-streaming) and streamReply (streaming) so the two paths can't drift.
//
// The `reasoning`-when-`content`-is-empty fallback (see sendMessage's own
// comment) was built for a model that puts its whole, *finished* answer in
// `reasoning` and leaves `content` empty on an otherwise normal turn
// (finish_reason "stop"). It does NOT hold when the response was cut off
// before the model ever got past its own internal thinking
// (finish_reason "length"): in that case `reasoning` isn't a finished
// answer at all, just a raw, mid-thought scratchpad - handing it to
// sendAndPrint would print the model's own thinking process as if it were
// the tutor's actual reply, indistinguishable from a real one since it's
// still just text in the terminal.
//
// Confirmed live against the real Ollama gemma4:26b model this companion is
// actually configured for: a normal-length capture completes fine (content
// non-empty, or a complete reasoning-only answer on finish_reason "stop"),
// but a big Submit capture - a long solution, a long problem description,
// and/or several turns of resent history piling up in one session - eats
// most of Ollama's default 4096-token context window for this model (no
// num_ctx override; confirmed neither a top-level nor a nested `options`
// num_ctx field is honored by this Ollama version's /v1/chat/completions
// endpoint - only its native /api/chat does), leaving too little of the
// window for a real answer. The model then gets cut off mid-`reasoning`
// (finish_reason "length", content still empty), and the existing fallback
// printed that raw, truncated internal monologue as the "reply" - matching
// what grows more frequent as a session's conversation (and therefore its
// resent history) grows, not a rare fluke. Rather than ever surface that
// text, this throws a distinct, clearly-worded error instead - surfaced via
// the same "companion: error talking to backend" path as any other backend
// failure - so the failure is visible instead of silently masquerading as a
// real tutoring reply.
//
// This also fires on the very first turn of a brand-new conversation, with
// no accumulated history at all: one capture's own content (system prompt +
// problem description + submitted code) can by itself already exceed a
// small model's context window - a genuinely different failure from the
// multi-turn growth `trimHistory` guards against, and confirmed live to
// happen with a perfectly normal-sized real submission (a description plus a
// ~150-line solution), not just a synthetic worst case. See LocalBackend's
// class comment for the actual fix (a bigger real context window via
// Ollama's native chat API) - `advice` lets the caller phrase this error
// according to which API path is actually in play, since the fix differs.
function resolveReplyText({ content, reasoning, finishReason, advice }) {
  const trimmedContent = content && content.trim();
  if (trimmedContent) return trimmedContent;
  const trimmedReasoning = reasoning && reasoning.trim();
  if (trimmedReasoning && finishReason === 'length') {
    throw new Error(
      'local backend reply was cut off before finishing (likely ran out of context while still ' +
        '"thinking") - discarding it rather than showing incomplete internal reasoning as the reply; ' +
        (advice ||
          'try a shorter capture, clearing context, or a model/server configuration with more context')
    );
  }
  return trimmedReasoning || '';
}

// Phrases resolveReplyText's cut-off advice according to which API path
// LocalBackend actually used, so the message always points at something that
// can genuinely help rather than generic advice that may not apply -
// COMPANION_LOCAL_NUM_CTX only does anything under 'native', and
// COMPANION_LOCAL_API=native only does anything when starting from 'openai'.
function contextAdviceFor(apiStyle, numCtx) {
  if (apiStyle === 'native') {
    return (
      `try a shorter capture, clearing context, or raising COMPANION_LOCAL_NUM_CTX ` +
      `(currently ${numCtx}) if your model/machine has room for a bigger context window`
    );
  }
  return (
    'try a shorter capture, clearing context, or setting COMPANION_LOCAL_API=native if the ' +
    'server at COMPANION_BASE_URL is actually Ollama (its native chat API allows a real, ' +
    'larger context window via COMPANION_LOCAL_NUM_CTX; the standard OpenAI-compatible ' +
    'endpoint used here cannot)'
  );
}

class LocalBackend {
  // Talks to either a standard OpenAI-compatible /v1/chat/completions
  // endpoint (`apiStyle: 'openai'`, portable to any such server) or Ollama's
  // own native /api/chat (`apiStyle: 'native'`) - see companion.js's
  // LOCAL_API/LOCAL_NUM_CTX config comment for how that choice gets made and
  // why it matters: the native API is the only one of the two that actually
  // honors a `num_ctx` (context window size) option. This project's own
  // configured model (Ollama, gemma4:26b) runs with a 4096-token window by
  // default, and that alone - not just accumulated multi-turn history, which
  // trimHistory (below) already bounds - can be too small for a single
  // capture: confirmed live that a perfectly normal, single Submit capture
  // (a real problem description plus a ~150-line solution, no prior history
  // at all) already exhausts it, because the model's own "thinking" burns
  // through whatever's left after the system prompt and capture content, and
  // a longer capture also means more for the model to reason about - so
  // trimming the capture's own content can't reliably guarantee safety
  // either, short of cutting the student's code short (which would make the
  // tutor review incomplete code, undermining the one thing this tool exists
  // to do). Raising the actual context window is the only thing confirmed
  // live to fix this without touching capture content: the exact request
  // that failed against the openai-style endpoint's default 4096 completed
  // normally once resent to /api/chat with `num_ctx: 8192`.
  constructor({ baseUrl, model, apiKey, maxHistoryTurns, apiStyle, numCtx }) {
    if (!model) {
      throw new Error(
        'COMPANION_MODEL is required for COMPANION_BACKEND=local (e.g. COMPANION_MODEL=llama3.2)'
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.maxHistoryTurns = maxHistoryTurns;
    this.apiStyle = apiStyle === 'native' ? 'native' : 'openai';
    this.numCtx = numCtx;
    // Ollama's native API lives at the server root (e.g.
    // http://localhost:11434/api/chat), not under the OpenAI-compat prefix -
    // strip a trailing /v1 from baseUrl (its default value has one) so both
    // API styles can share the same COMPANION_BASE_URL. If a custom baseUrl
    // doesn't end in /v1, this is a no-op and native mode is used as-is.
    this.nativeBaseUrl = this.baseUrl.replace(/\/v1$/, '');
    // Standard OpenAI chat-completions shape: a leading `role: 'system'`
    // message, resent in full on every turn along with the rest of history.
    // Includes the shared style addendum (see STYLE_ADDENDUM) - this backend
    // never inherits it any other way, unlike ClaudeBackend which has its own
    // ambient settings it could (and, before this file's isolation fix, did)
    // ride along on. Kept on its own so resetContext (below) can restore
    // exactly this, rather than re-deriving it or leaving stale history
    // entries behind. Ollama's native /api/chat accepts this exact same
    // messages shape too, so history/resetContext/trimHistory are all
    // shared unchanged between both API styles.
    this.systemMessage = { role: 'system', content: `${TUTOR_SYSTEM_PROMPT}\n\n${STYLE_ADDENDUM}` };
    this.history = [this.systemMessage];
  }

  async sendMessage(text, { onChunk } = {}) {
    this.history.push({ role: 'user', content: text });

    // resolveReplyText (called by both request paths, directly or via their
    // own stream readers) can throw - e.g. the cut-off-mid-thought case - so
    // every failure path here pops the dangling user turn before propagating,
    // rather than leaving history with a user message that was never
    // actually answered.
    let replyText;
    try {
      replyText =
        this.apiStyle === 'native' ? await this.requestNative(onChunk) : await this.requestOpenAI(onChunk);
    } catch (err) {
      this.history.pop();
      throw err;
    }

    if (!replyText) {
      this.history.pop();
      throw new Error('local backend returned an empty reply (no content or reasoning in the response)');
    }
    this.history.push({ role: 'assistant', content: replyText });
    // Only runs once this turn is fully resolved and paired (the user
    // message pushed above, now matched by this assistant reply) - see
    // trimHistory's own comment for why that matters.
    this.trimHistory();
    return replyText;
  }

  // Standard OpenAI-compatible /v1/chat/completions request/response shape -
  // portable to any server that speaks it, including but not limited to
  // Ollama. Unchanged from before native-mode support existed.
  async requestOpenAI(onChunk) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, messages: this.history, stream: Boolean(onChunk) }),
      });
    } catch (err) {
      throw new Error(`could not reach ${this.baseUrl} (${err.message})`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`local backend request failed: ${response.status} ${response.statusText} ${bodyText}`);
    }

    // Some locally-hosted "thinking" models (e.g. Ollama's gemma-family
    // thinking variants) put their whole answer in a separate `reasoning`
    // field and leave `content` empty, especially on the longer responses a
    // Submit's full breakdown asks for - a plain `content ?? ''` here would
    // silently hand sendAndPrint an empty string, which prints nothing but
    // the capture's label, looking exactly like "the reply never arrived"
    // even though the backend technically succeeded. Fall back to
    // `reasoning` before giving up - in both the streamed and non-streamed
    // shapes below, via resolveReplyText.
    if (onChunk) return this.streamReply(response, onChunk);
    const data = await response.json();
    const choice = data?.choices?.[0];
    return resolveReplyText({
      content: choice?.message?.content,
      reasoning: choice?.message?.reasoning,
      finishReason: choice?.finish_reason,
      advice: contextAdviceFor('openai', this.numCtx),
    });
  }

  // Ollama's native /api/chat - same messages shape in, but a different
  // response shape out: a single JSON object (non-streaming) or newline-
  // delimited JSON objects (streaming), `message: { content, thinking }`
  // instead of `choices[0].message`, and `done_reason` at the top level
  // instead of `finish_reason` per-choice. The only reason to use this over
  // requestOpenAI is `options.num_ctx`, below - confirmed live this is
  // honored here and nowhere on the compat endpoint. Response shapes
  // confirmed live against a real Ollama server (gemma4:26b).
  async requestNative(onChunk) {
    let response;
    try {
      response = await fetch(`${this.nativeBaseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: this.history,
          stream: Boolean(onChunk),
          options: { num_ctx: this.numCtx },
        }),
      });
    } catch (err) {
      throw new Error(`could not reach ${this.nativeBaseUrl} (${err.message})`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`local backend request failed: ${response.status} ${response.statusText} ${bodyText}`);
    }

    if (onChunk) return this.streamReplyNative(response, onChunk);
    const data = await response.json();
    return resolveReplyText({
      content: data?.message?.content,
      reasoning: data?.message?.thinking,
      finishReason: data?.done_reason === 'length' ? 'length' : data?.done_reason,
      advice: contextAdviceFor('native', this.numCtx),
    });
  }

  // Drops the oldest complete user+assistant pairs once history holds more
  // than maxHistoryTurns of them, so LocalBackend.history - resent in full on
  // every turn (see the class comment above sendMessage) - stays bounded
  // across a long single-problem conversation instead of growing without
  // limit turn over turn, which is what actually exhausts a small local
  // model's context window (see resolveReplyText's own comment for the live-
  // confirmed failure this causes). This is deliberately a *different* bound
  // than COMPANION_AUTO_CLEAR_CONTEXT's full reset on a problem switch (see
  // companion.js's "automatic context reset on problem switch" section): that
  // one clears everything the instant the problem changes, this one caps how
  // much of one still-current problem's own back-and-forth stays resent.
  //
  // Only ever called right after sendMessage pushes a successful assistant
  // reply (never mid-turn, and never on an error path - every error path
  // above pops the dangling user message first instead), so this.history is
  // always exactly [system, user, assistant, user, assistant, ...] when it
  // runs - splicing out the oldest pair (indices 1 and 2, right after the
  // system message) can never cut a turn in half or separate a capture's own
  // code from its own reply, since a "pair" here is always a whole exchange.
  trimHistory() {
    if (!this.maxHistoryTurns || this.maxHistoryTurns <= 0) return; // 0/unset: unbounded, trimming off
    const keepMessages = 1 + this.maxHistoryTurns * 2; // system + N whole pairs
    while (this.history.length > keepMessages) {
      this.history.splice(1, 2);
    }
  }

  // Reads an OpenAI-compatible chat-completions SSE stream (one `data:
  // {...}` event per chunk, terminated by `data: [DONE]`), calling onChunk
  // for each piece of visible `delta.content` as it arrives. `delta.reasoning`
  // is accumulated the same way but never handed to onChunk - a "thinking"
  // model's internal trace isn't what streaming is meant to surface live; it
  // only matters as the same empty-content fallback used by the
  // non-streaming path above, via resolveReplyText.
  async streamReply(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finishReason = null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // a malformed/partial SSE line - ignore rather than crash the stream
        }
        const choice = event?.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          onChunk(delta.content);
        }
        if (delta?.reasoning) reasoning += delta.reasoning;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
    return resolveReplyText({ content, reasoning, finishReason, advice: contextAdviceFor('openai', this.numCtx) });
  }

  // Reads Ollama's native /api/chat streaming shape: newline-delimited JSON
  // objects (no `data:`/SSE framing, no `[DONE]` sentinel), each carrying an
  // incremental `message.content` and/or `message.thinking`, with the final
  // object marked `done: true` and carrying `done_reason` - confirmed live
  // against a real Ollama server. Mirrors streamReply's onChunk/reasoning
  // handling exactly: `thinking` deltas accumulate the same way `reasoning`
  // deltas do above, but are never handed to onChunk.
  async streamReplyNative(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let doneReason = null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // a malformed/partial line - ignore rather than crash the stream
        }
        const delta = event?.message;
        if (delta?.content) {
          content += delta.content;
          onChunk(delta.content);
        }
        if (delta?.thinking) reasoning += delta.thinking;
        if (event?.done) doneReason = event.done_reason || 'stop';
      }
    }
    return resolveReplyText({
      content,
      reasoning,
      finishReason: doneReason === 'length' ? 'length' : doneReason,
      advice: contextAdviceFor('native', this.numCtx),
    });
  }

  // Truncates history back to just the leading system message, so the next
  // sendMessage resends none of the prior conversation.
  resetContext() {
    this.history = [this.systemMessage];
  }
}

function makeBackend() {
  if (BACKEND === 'claude') return new ClaudeBackend({ model: MODEL });
  if (BACKEND === 'local') {
    return new LocalBackend({
      baseUrl: BASE_URL,
      model: MODEL,
      apiKey: API_KEY,
      maxHistoryTurns: LOCAL_MAX_HISTORY_TURNS,
      apiStyle: LOCAL_API,
      numCtx: LOCAL_NUM_CTX,
    });
  }
  throw new Error(`unknown COMPANION_BACKEND "${BACKEND}" (expected "claude" or "local")`);
}

const backend = makeBackend();

// --- relay server lifecycle -------------------------------------------------
//
// companion.js now owns the relay server's lifecycle: it starts one on
// launch if nothing is already listening, and stops the one it started when
// it exits - one command instead of two. If a server was already running
// (started separately, or left over from another companion instance), this
// instance leaves it alone on both ends: it doesn't spawn a second one, and
// it doesn't stop it on exit. See the "Companion" section of the top-level
// README.md for the durability tradeoff this implies (captures during a gap
// where companion.js isn't running are no longer durably logged).

// Set only if *this* process spawned the relay server; stays null if an
// already-running server was found instead, so the exit handler below knows
// whether it's allowed to stop it.
let relayServerChild = null;

async function isRelayServerUp() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    // OPTIONS /capture is answered unconditionally by server.js (see its
    // CORS_HEADERS comment) regardless of body or other headers, making it
    // the cheapest real request to probe with - a plain TCP connect would
    // also tell us *something* is listening on the port, but not that it's
    // actually this relay server.
    await fetch(`http://${RELAY_HOST}:${RELAY_PORT}/capture`, {
      method: 'OPTIONS',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureRelayServer() {
  if (await isRelayServerUp()) return;

  // Pass the environment through unchanged: if Thomson set CAPTURE_PORT or
  // CAPTURE_LOG_PATH for this companion invocation, server.js reads those
  // same variables itself, so the spawned server naturally stays in sync
  // with whatever this companion process is configured for.
  const child = spawn(process.execPath, ['server.js'], {
    cwd: RELAY_SERVER_DIR,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  relayServerChild = child;
  printBanner(dim('companion: relay server not detected, starting it now'));

  // Wait (bounded) for it to actually come up, so the very first capture
  // isn't lost to a race between spawning it and its listen() callback.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await isRelayServerUp()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  printBanner(
    dim(
      `companion: warning: started the relay server but it hasn't answered on http://${RELAY_HOST}:${RELAY_PORT} yet - continuing anyway`
    ),
    console.error
  );
}

function stopRelayServerIfOwned() {
  if (!relayServerChild) return;
  try {
    process.kill(relayServerChild.pid, 'SIGTERM');
  } catch {
    // Already gone (e.g. it crashed on its own) - nothing to do.
  }
  relayServerChild = null;
}

// A synchronous 'exit' handler is the one place guaranteed to run
// regardless of which path led there - rl.close() -> process.exit(0) after
// /exit, /quit, or Ctrl+C; the pollLoop fatal-error process.exit(1); or a
// plain fall-through exit - so it's the single point of truth for "did this
// instance start the server, and if so, stop it."
process.on('exit', stopRelayServerIfOwned);

// --- capture formatting (adapted from the old watch.js) --------------------

function triggerLabel(trigger) {
  if (trigger === 'run') return 'Run';
  if (trigger === 'submit') return 'Submit';
  return trigger || 'unknown trigger';
}

function languageFenceHint(language) {
  const known = {
    python: 'python',
    python3: 'python',
    javascript: 'javascript',
    typescript: 'typescript',
    java: 'java',
    'c++': 'cpp',
    c: 'c',
    'c#': 'csharp',
    go: 'go',
    golang: 'go',
    rust: 'rust',
    kotlin: 'kotlin',
    swift: 'swift',
    ruby: 'ruby',
    scala: 'scala',
    php: 'php',
  };
  return known[String(language).toLowerCase()] || '';
}

// Explicit, unconditional instruction appended to every capture message
// telling the model which of TUTOR_SYSTEM_PROMPT's two response modes
// applies - the code branches on capture.trigger itself rather than relying
// on the model to infer Run vs Submit purely from the header text.
const RUN_ADDENDUM =
  '\n\nThis was a Run, not a Submit. Per your instructions: acknowledge only and stand by (plus the first-capture problem introduction, if this is the first capture for this problem) - do not give the approach description, correctness check, or complexity evaluation unless asked.';
const SUBMIT_ADDENDUM =
  '\n\nThis was a Submit. Per your instructions: give the full breakdown - approach description, correctness check, and complexity evaluation.';

function formatCaptureMessage(capture) {
  const title = capture.problemTitle || capture.problemSlug || '(unknown problem)';
  const slug = capture.problemSlug || 'unknown-slug';
  const language = capture.language || 'unknown language';
  const label = triggerLabel(capture.trigger);
  const code = typeof capture.code === 'string' ? capture.code : '';
  const description = typeof capture.problemDescription === 'string' ? capture.problemDescription : null;
  const fence = '```';

  const lines = [`[LeetCode capture] ${label} - ${title} (${slug})`, `Language: ${language}`];
  if (description) lines.push('', 'Problem:', description);
  lines.push('', `${fence}${languageFenceHint(language)}`, code, fence);
  const addendum = capture.trigger === 'submit' ? SUBMIT_ADDENDUM : RUN_ADDENDUM;
  return lines.join('\n') + addendum;
}

// --- automatic context reset on problem switch (AUTO_CLEAR_CONTEXT) --------
//
// TUTOR_SYSTEM_PROMPT's own "if this is the first capture you've seen for
// this specific problem" wording is a soft, prompt-level ask - the model is
// trusted to notice a switch and treat it as a fresh introduction, but
// nothing actually stops the old problem's full code/discussion from being
// resent as context on every turn (ClaudeBackend's resumed session,
// LocalBackend's resent history array) forever, even long after the
// conversation has moved on. This tracks the identifier of the problem
// currently being discussed and hard-resets the backend's own continuity
// mechanism (see each backend's resetContext, above) the instant a capture
// for a different one arrives, rather than leaving it to the model's
// judgment alone.
//
// Identifier: capture.problemSlug, falling back to capture.problemTitle when
// slug is absent - slug preferred as the more stable/canonical identifier
// (matches formatCaptureMessage's own title/slug fallback, just in the
// opposite preference order, since that one is choosing what to *display*).
//
// In-memory only, not persisted to .companion-state.json (unlike the
// capture-log tail offset): a restart already gives both backends a
// completely fresh session/history regardless of what problem they're later
// told about - ClaudeBackend's sessionId and LocalBackend's history are
// themselves never persisted - so tracking this across a restart wouldn't
// change the backend's actual behavior, only whether the first capture
// after a restart happens to print a reset notice. The "previousId === null"
// case below (this process's very first capture) already skips the notice
// and the resetContext call for exactly that reason, so a restart already
// behaves correctly without persistence. Persisting it would add
// bookkeeping to reproduce behavior that already falls out for free.
let currentProblemId = null;

function captureProblemId(capture) {
  return capture.problemSlug || capture.problemTitle || null;
}

// Updates the tracked problem and, if this capture is for a different one
// than last seen, resets the backend's context. Returns a notice line to
// print via printAboveInput (so it takes part in the same
// turn-boundary/history recording as everything else), or null if nothing
// happened - same problem, the very first capture this process has seen (no
// prior context to reset), or the toggle is off.
function maybeResetContextForCapture(capture) {
  const problemId = captureProblemId(capture);
  const previousId = currentProblemId;
  currentProblemId = problemId;
  if (previousId === null || problemId === previousId) return null;
  if (!AUTO_CLEAR_CONTEXT) return null;
  backend.resetContext();
  return dim(`companion: new problem detected (${problemId || 'unknown'}) - clearing tutor context`);
}

// --- vault auto-summary (VAULT_AUTO_SUMMARY) --------------------------------
//
// Turns the companion's own tutoring response to a Submit into a durable,
// structured note in Thomson's Obsidian vault, updated in place as the
// session progresses. The actual logic (building the addendum, parsing the
// model's reply, writing the notes) lives in vault-summary.js, split out so
// it can be unit-tested without booting this file's readline loop / relay
// server lifecycle - see that file's header for the full design, and
// README.md → "Vault auto-summary" for user-facing docs.

// --- terminal chat loop ------------------------------------------------------
//
// A capture can arrive from the file tailer at any moment, including while
// Thomson is mid-way through typing a line. The input area is a small
// pinned box - a thin rule, then the "> " prompt - that stays the last
// thing on screen: printAboveInput clears the box, prints the new text
// above where it was, then redraws the box fresh (see drawBox - readline's
// own rl.prompt(true) already renders the current line/cursor correctly on
// its own, so there's nothing to save and reinsert). Both captures and
// normal replies to typed input go through this same path, including each
// individually-streamed piece of a reply, so the box stays visible (pinned
// at the bottom) throughout a reply rather than only reappearing once it's
// fully done.

// --- raw input / mouse-wheel scrollback -------------------------------
//
// In a real terminal, readline reads from `readlineInput` - a filtered
// copy of stdin - rather than process.stdin directly. Mouse-wheel SGR
// reports (enabled above, alongside the alternate screen) arrive on stdin
// interleaved with ordinary keystrokes, and readline's own keypress
// decoder has no understanding of that protocol at all: fed one directly,
// it doesn't ignore it, it shreds it into a run of spurious single-
// character keypresses that get inserted straight into whatever's being
// typed (confirmed live - see mouse-input.js's header). createMouseFilter
// sits in front of readline instead: every byte that isn't part of a
// wheel report passes through to `filteredStdin` unchanged and in order,
// so readline's own line editing, arrow-key history, Ctrl+C handling, and
// Page Up detection all keep working exactly as before against a stream
// that's identical to stdin minus wheel reports. handleWheel (defined
// further down, alongside the scrollback viewport it drives) is only ever
// invoked once a real wheel event arrives, well after the rest of this
// file's top-level code has finished running, so referencing it here
// ahead of its own definition is safe. Non-TTY mode is untouched -
// readline reads process.stdin directly there, same as before this
// feature existed, and none of this wiring runs.
const filteredStdin = process.stdout.isTTY ? new PassThrough() : null;
if (filteredStdin) {
  const mouseFilter = createMouseFilter({ output: filteredStdin, onWheel: handleWheel });
  process.stdin.on('data', (chunk) => mouseFilter.push(chunk));
  process.stdin.on('end', () => filteredStdin.end());
}

const rl = readline.createInterface({
  input: filteredStdin || process.stdin,
  output: process.stdout,
  prompt: promptString(),
});
let stopping = false;

// How many terminal rows, ending at the cursor's current row and extending
// upward, are occupied by whatever's reserved at the bottom right now that
// *isn't* the box itself - i.e. the 1-row spinner, or 0 when nothing's
// reserved (mid content-write, or right after readline's own native Enter
// handling already claimed the row). 0 until anything is first drawn. See
// boxShown below for why the box's own row count is never stored here.
// Only meaningful in styled/TTY mode; non-TTY output never reserves any
// rows at all.
let bottomRowsShown = 0;

// True exactly when the box (the blank breathing-room line, the rule, and
// the prompt - see drawBoxRaw) is currently the thing occupying the bottom
// reserved rows, as opposed to the spinner or nothing. Unlike
// bottomRowsShown, the box's own row count is never cached in a variable -
// it's always computed fresh, on demand, via promptRowCount() (see
// reservedBottomRows below). That distinction matters: readline redraws its
// own prompt - correctly reflecting how many physical rows a long typed/
// pasted line currently wraps to - on every keystroke, entirely on its own,
// with no call into any of this file's own drawing code. A row count cached
// at the box's last *drawBoxRaw* call goes stale the instant the user types
// past (or back under) a wrap boundary afterward; confirmed live: typing a
// line long enough to wrap to a second terminal row, then triggering an
// ordinary redraw (a capture arriving), cleared only the row count cached
// from before typing started, leaving part of the actual on-screen wrapped
// prompt behind as leftover garbage that the new content got written on top
// of - corrupting everything drawn afterward, including the box's own next
// redraw. Computing promptRowCount() fresh every time avoids this entirely,
// since rl.line (and the terminal's actual on-screen rendering of it) is
// always already current by the time anything here runs.
let boxShown = false;

// The number of rows clearBottomRows needs to clear right now: the box's
// own current height (2 fixed rows - the blank line and the rule - plus
// however many rows its prompt currently wraps to, computed fresh; see
// boxShown above) when the box is what's on screen, or bottomRowsShown
// (the spinner's fixed 1 row, or 0) otherwise. Deliberately does NOT count
// the extra blank breathing-room row currentVisibleRows() reserves below
// the prompt (see that function) - this is "rows at and above the cursor's
// own row," and that reserved row sits below the cursor, never touched by
// clearBottomRows's own upward-clearing loop.
function reservedBottomRows() {
  return boxShown ? 2 + promptRowCount() : bottomRowsShown;
}

// True for the duration of one sendAndPrint call (a typed message's reply,
// or a capture's whole exchange) - two independent things check this before
// touching the screen outside the normal print flow: the resize handler
// (near the bottom of this file), and Page Up/showHistory (below). Mid-turn,
// bottomRowsShown might mean "a 1-row spinner" rather than "a 2-row box" at
// any given moment, so forcing a redraw or spawning a pager there would
// corrupt whatever's actually on screen - the resize handler falls back to
// only updating the width for future draws, and Page Up is simply ignored,
// until the turn's own writes catch up naturally. Idle (turnActive false),
// the box's state is simple and known, so both are safe to act on
// immediately.
let turnActive = false;

// Every line of actual conversation content (captures, replies, warnings,
// errors - not the box's own rule/prompt, not the transient spinner) is
// also recorded here, verbatim, ANSI codes included, in addition to being
// printed live - this is the only durable record of anything that's
// scrolled off screen, since the alternate screen buffer this program runs
// in (see the top of this file) has no native scrollback of its own in
// most terminals once content exceeds one screen's height. Page Up opens
// it in a real pager (`less`) rather than a hand-rolled scroll view -
// less already gets wrapping, search, and its own Page Up/Down exactly
// right. Capped by character count, not line count, so one enormous
// unbroken piece of content can't make the trim loop below do
// disproportionate work for how much it actually frees.
const HISTORY_MAX_CHARS = 2_000_000;
let historyChars = 0;
const historyBuffer = [];
function recordHistory(text) {
  if (!text) return;
  historyBuffer.push(text);
  historyChars += text.length;
  while (historyChars > HISTORY_MAX_CHARS && historyBuffer.length > 1) {
    historyChars -= historyBuffer.shift().length;
  }
}

// Startup/relay-server-lifecycle notices (below and near ensureRelayServer)
// print via this instead of a bare console.log/console.error - they're real
// on-screen rows just like anything else, so they need to be recorded (for
// Page Up, and so redrawViewport's own padding math below counts them) the
// same as every other line this program ever prints. logFn defaults to
// console.log;
// ensureRelayServer's own warning passes console.error to keep that line's
// existing stream, since both still land on the same physical terminal
// either way.
function printBanner(text, logFn = console.log) {
  logFn(text);
  if (process.stdout.isTTY) recordHistory(`${text}\n`);
}

// historyBuffer's own chunks are always newline-terminated (every caller of
// recordHistory ends its text with exactly one trailing '\n' - see each call
// site) - so joining and naively splitting on '\n' leaves one trailing empty
// string that isn't a real displayed row. Dropping it keeps this an exact
// count of on-screen lines, not off by one - which matters below, since an
// off-by-one here would just reproduce a smaller version of the bug this is
// fixing.
function historyLines() {
  const joined = historyBuffer.join('');
  if (!joined) return [];
  const lines = joined.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// True once the box has been pinned flush to the terminal's actual last row
// with the screen genuinely full of real content behind it (contentRows >=
// visibleRows) - see drawBox/redrawViewport, both of which set this only
// under that real condition now, not merely "a draw happened."
let screenFilledToBox = false;

// clearBottomRows clears exactly whatever's currently reserved at the
// bottom right now (reservedBottomRows - the box, freshly measured, or the
// spinner) and nothing more - it does not know or care whether the screen
// has genuinely filled with real content yet. That distinction belongs
// entirely to drawBox, right below.
function clearBottomRows() {
  if (!stylingEnabled()) return;
  const total = reservedBottomRows();
  for (let i = 0; i < total; i += 1) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    if (i < total - 1) readline.moveCursor(process.stdout, 0, -1);
  }
  bottomRowsShown = 0;
  boxShown = false;
}

// How many physical terminal rows readline's own current prompt line
// (promptString() plus whatever's typed so far) actually occupies once the
// terminal's own soft-wrap kicks in - normally 1, but more once a
// typed/pasted line is long enough to wrap on its own. Every piece of this
// file's box-pinning math (bottomRowsShown, clearBottomRows, drawBoxRaw,
// currentVisibleRows) used to assume this was always exactly 1 - confirmed
// live: pasting a line longer than one terminal row, then triggering a
// redraw (a capture arriving, or the reply to a normal typed message),
// cleared only the single row the old code assumed the prompt occupied,
// leaving the wrapped-over remainder of the old prompt line sitting as
// leftover garbage above the freshly redrawn box. Node's readline has no
// public API for this, so it's derived the same way readline derives it
// internally: total character count (the plain prompt marker - ANSI codes
// in it don't occupy a column, so they're stripped first - plus the raw
// typed text) divided by the terminal's current column count. An
// approximation, not a byte-exact match for every terminal's own wrapping
// quirks (e.g. deferred/"pending" wrap at an exact multiple of the column
// count), but Math.ceil errs on the side of clearing one row too many
// rather than too few, which self-corrects on the very next redraw rather
// than leaving stray content behind.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function promptRowCount() {
  const cols = process.stdout.columns || 80;
  const plainPromptLength = promptString().replace(ANSI_RE, '').length;
  const totalLength = plainPromptLength + rl.line.length;
  return Math.max(1, Math.ceil(totalLength / cols));
}

// Draws just the box itself (a blank breathing-room line, the rule, then the
// prompt - see promptRowCount above for why the prompt can be more than one
// physical row) at the cursor's current position, with no
// padding logic of its own - callers are responsible for the cursor already
// being at the correct row. Both of drawBox's two branches below end here:
// the fast incremental path (cursor left wherever clearBottomRows +
// newly-written content put it) and redrawViewport's full repaint (cursor at
// the end of its freshly-painted history slice). rl.prompt(true) alone
// already renders readline's own current line and cursor position correctly
// on its own (verified live: it reflects whatever was typed, including
// mid-line edits and a wrapped multi-row line, with no help needed) - no
// manual re-insertion of a "saved" line, which matters here specifically
// because a turn no longer pauses readline for its duration (see
// sendAndPrint): a keystroke can land between two box redraws, and manually
// re-inserting a previously-saved line back into a buffer readline's own
// keypress handling has since updated would duplicate it. A no-op in
// non-styled mode: the plain '> ' prompt there is just readline's own,
// undecorated, and never needs a rule or an explicit redraw of its own.
function drawBoxRaw() {
  if (!stylingEnabled()) return;
  process.stdout.write(`\n${boxRule()}\n`);
  // Reserve the blank breathing-room row below the prompt (symmetric with
  // the blank line above the rule, just written) *before* rendering the
  // prompt itself, while the cursor sits at a known, unambiguous position:
  // column 0 of the prompt's own first row. Writing promptRowCount() plain
  // newlines forces the terminal to scroll if it's already at its bottom
  // margin - the only way to genuinely create a new row there; a relative
  // cursor-down move (readline.moveCursor with a positive dy, i.e. CSI
  // "...B") does *not* scroll, it just clamps uselessly at the last row,
  // which would silently skip the reservation exactly when it's needed
  // most (the steady-state, screen-already-full case this function mostly
  // runs in). clearLine then guards against stale content left over from a
  // taller previous draw landing at this same spot (e.g. right after a
  // resize). moveCursor back up the same count is a pure relative vertical
  // move (unlike another plain '\n', which most terminals' own output
  // processing also treats as an implicit carriage return) - paired with
  // the explicit cursorTo(0) after it, this returns the cursor to exactly
  // where it started, so rl.prompt(true) below renders into unchanged,
  // correctly-positioned space, unaware any of this happened. Doing this
  // *before* rl.prompt(true) - rather than after, relative to wherever it
  // leaves the cursor - sidesteps having to know precisely where within a
  // multi-row wrapped prompt the cursor ends up (e.g. mid-line editing
  // after arrowing left): that position is genuinely ambiguous from here,
  // while "column 0 of the prompt's first row" is not.
  const promptRows = promptRowCount();
  process.stdout.write('\n'.repeat(promptRows));
  readline.clearLine(process.stdout, 0);
  readline.moveCursor(process.stdout, 0, -promptRows);
  readline.cursorTo(process.stdout, 0);
  // Reset readline's own internal "how many rows did my last render take"
  // bookkeeping (rl.prevRows - an undocumented but stable, directly-
  // readable property; see node's lib/internal/readline/interface.js
  // _refreshLine) before letting it redraw. rl.prompt(true) doesn't just
  // paint at the cursor's current position - internally it moves the
  // cursor *up* by rl.prevRows first (to reach what it believes was the
  // start of its own previous multi-row render), then clearScreenDown()s
  // from there before writing the new prompt. That's fine as long as
  // readline is the only thing that's touched the screen since its last
  // render - but it isn't: clearBottomRows just repositioned the cursor
  // using this file's own row math, to the correct spot for a *fresh*
  // render. If rl.prevRows is left stale from readline's last render of
  // this same long/wrapped line (e.g. 2, for a cursor sitting on the third
  // row of a 3-row wrapped prompt), rl.prompt(true) moves up 2 *more* rows
  // than it should - straight into content clearBottomRows never touched
  // (the ack/label lines this turn already printed above the box) - and
  // then clearScreenDown() erases all of it before redrawing the box 2 rows
  // too high. Confirmed live: this is the actual mechanism behind "a
  // capture arriving while a long typed line sits in the prompt corrupts
  // everything above the box," not a row-*counting* bug (promptRowCount
  // above was already correct throughout) - forcing rl.prevRows to 0 here
  // makes _refreshLine's own upward move a no-op, so it just clears
  // (harmlessly - the box's own rows are already blank) from the cursor's
  // actual current position downward and draws fresh there, matching what
  // clearBottomRows already prepared.
  rl.prevRows = 0;
  rl.prompt(true);
  boxShown = true;
}

// The box is pinned to the terminal's actual last row(s) - not wherever the
// cursor happens to be after whatever's been printed so far. Two phases:
//
// While the screen hasn't genuinely filled with real content yet
// (screenFilledToBox false), every redraw goes through a full repaint
// (redrawViewport) instead of the incremental clear/write path below. This
// is the real fix for "chat ends up clustered at the bottom with the box
// instead of starting from the top and growing down, with padding sitting
// between it and the box": the incremental path only ever cleared the box's
// own rows (clearBottomRows) and then wrote new content immediately adjacent
// to wherever the box already was - which, since the box is pinned to the
// terminal's actual last row, always means writing right at that last row.
// Doing that forces the *terminal itself* to scroll on every single
// redraw (there's nowhere left to print a trailing newline without
// overflowing the last row) - which silently drops exactly one row off the
// *top* of the screen each time, even while genuine blank padding still sits
// untouched in the middle, never being consumed by it. The old
// padToBottomIfNeeded compounded this by only ever padding once (an
// unconditional `screenFilledToBox = true` after its very first call,
// regardless of whether the screen had actually filled) - confirmed live:
// a short conversation in a tall window showed new content clustered
// directly above the box while the padding above stayed frozen at whatever
// it was after the very first startup draw, and the window's original
// startup banner silently scrolled off the top within the first couple of
// capture exchanges. redrawViewport, in contrast, was already correct - it
// repaints the whole visible window fresh from historyBuffer (the true,
// never-lost record of everything printed) on every call, which is exactly
// why Thomson's own live testing found that a single wheel-scroll tick
// "snapped" a broken-looking screen to the correct layout: it was the first
// full repaint since the bug's incremental drawBox calls had been silently
// scrolling real content away. Using that same full-repaint path for every
// redraw during the fill phase costs a full-screen clear per redraw, but
// that phase is inherently bounded (at most visibleRows lines of content),
// unlike the conversation itself - once the screen has genuinely filled
// (contentRows >= visibleRows), natural terminal scrolling is exactly the
// desired behavior forever after, so the cheap incremental path (clear only
// the box's own rows, write, redraw in place) takes back over, unchanged
// from before this fix and already verified correct for that case.
function drawBox() {
  if (!stylingEnabled()) return;
  if (!screenFilledToBox) {
    redrawViewport();
    return;
  }
  drawBoxRaw();
}

function printAboveInput(text) {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (!process.stdout.isTTY) {
    process.stdout.write(body);
    return;
  }
  recordHistory(body);
  clearBottomRows();
  process.stdout.write(body);
  drawBox();
}

// Marks the start of a new turn (a capture's whole exchange, or a typed
// message's reply) so exactly one blank line separates it from whatever
// came before - never more, never none. Set at the end of every turn;
// consumed (and cleared) by whichever print happens first for the next one,
// wherever that is - a capture's local ack, or a typed reply's own first
// output - so it's correct regardless of which of those runs first, without
// each needing to know about the other. Styled/TTY only, like every other
// decoration in this file - piped output stays exactly the raw text stream
// it's always been, with no separators inserted.
let turnBoundaryPending = false;
function consumeTurnBoundary() {
  if (!stylingEnabled() || !turnBoundaryPending) return '';
  turnBoundaryPending = false;
  return '\n';
}

// Serializes every backend call (typed messages and injected captures alike)
// through one queue, so a capture landing mid-response to a typed message -
// or vice versa - never sends two overlapping requests to a backend that
// keeps its own session/history state.
let queueTail = Promise.resolve();
function enqueue(task) {
  const result = queueTail.then(() => task());
  queueTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// The "waiting for the backend" indicator: temporarily replaces the box
// with a single animated line until the first content is ready, redrawn in
// place on that same line each tick. A plain no-op whenever styling is off,
// so a piped/non-TTY invocation is never touched by it - see
// terminal-format.js's stylingEnabled.
function startSpinner() {
  if (!stylingEnabled()) return () => {};
  clearBottomRows();
  let i = 0;
  let stopped = false;
  process.stdout.write(spinnerFrame(i));
  bottomRowsShown = 1;
  const timer = setInterval(() => {
    i += 1;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(spinnerFrame(i));
  }, 120);
  return function stopSpinner() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    // Leaves an empty, still-reserved row - clearBottomRows (bottomRowsShown
    // stays 1) picks it up cleanly on whatever prints next, same as if a
    // one-line box were there.
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  };
}

// onReply, when given, runs on the raw reply before it's printed and may
// return a transformed string - used by handleCaptureLine to peel the vault
// auto-summary's JSON block back off a Submit reply (see extractVaultBlock)
// before it ever reaches the terminal. That stripping can only happen once
// the reply is complete, so a turn with onReply set never streams - see the
// non-streaming branch below.
function sendAndPrint(label, text, { onReply } = {}) {
  // Same reasoning as handleCaptureLine's own call to this: a typed
  // message is new activity too, so it always returns the view to the
  // live bottom first if the user was scrolled up reading history.
  resetScrollIfNeeded();
  return enqueue(async () => {
    turnActive = true;
    try {
      await sendAndPrintTurn(label, text, onReply);
    } finally {
      turnActive = false;
    }
  });
}

async function sendAndPrintTurn(label, text, onReply) {
  const separator = consumeTurnBoundary();
  if (label) printAboveInput(separator + label);
  else if (separator) printAboveInput(''); // separator alone - printAboveInput('') is exactly one blank line

  const streaming = !onReply;
  const stopSpinner = startSpinner();

  if (streaming) {
    let wroteMarker = false;
    let anyChunk = false;
    const streamer = createMarkdownStreamer();

    // Writes one flushed piece of the reply above the box, then redraws
    // the box fresh below it - each call is its own printAboveInput-style
    // clear/print/redraw cycle, throttled by the streamer to real
    // markdown block boundaries (not raw network chunks), so the box
    // stays visibly pinned through a whole reply without flickering on
    // every tiny piece. The turn marker (•) opens the very first piece;
    // consecutive blocks are separated by a blank line, since each is
    // rendered independently and trimmed at its own boundary - without
    // this the paragraph spacing between them would be lost. In
    // non-styled mode a piece is raw, possibly mid-word text - no marker,
    // no separator, straight pass-through.
    function writeReplyPiece(piece) {
      if (!piece) return;
      if (!stylingEnabled()) {
        // Raw, possibly mid-word pass-through - no marker, no separator,
        // and critically no newline added: a chunk boundary can fall
        // anywhere, and injecting one here would corrupt piped output.
        process.stdout.write(piece);
        return;
      }
      stopSpinner();
      clearBottomRows();
      // Each piece always ends with its own trailing newline (added
      // below, so the box's rule has a fresh line to start on) - that
      // newline already accounts for the first half of a blank-line
      // separator, so only one more newline (not two) is needed here to
      // leave exactly one blank row before a second-or-later piece.
      const separatorOrMarker = wroteMarker ? '\n' : turnMarker();
      // The very first piece's own first line sits right after turnMarker()
      // itself, so only that one line stays unindented; every later piece
      // starts on a fresh line of its own (following the blank-line
      // separator above) and needs the same hanging indent as any other
      // continuation line - see indentContinuation.
      const indentedPiece = indentContinuation(piece, { indentFirstLine: wroteMarker });
      const fullPiece = indentedPiece.endsWith('\n') ? indentedPiece : `${indentedPiece}\n`;
      recordHistory(separatorOrMarker + fullPiece);
      process.stdout.write(separatorOrMarker);
      wroteMarker = true;
      process.stdout.write(fullPiece);
      drawBox();
    }

    let reply;
    try {
      reply = await backend.sendMessage(text, {
        onChunk: (chunk) => {
          anyChunk = true;
          writeReplyPiece(streamer.push(chunk));
        },
      });
    } catch (err) {
      stopSpinner();
      clearBottomRows();
      const errorLine = `${dim(`companion: error talking to backend (${BACKEND}): ${err.message}`)}\n`;
      recordHistory(errorLine);
      process.stdout.write(errorLine);
      drawBox();
      turnBoundaryPending = true;
      return;
    }

    // Defense in depth: even if the backend resolves with an
    // empty/whitespace-only reply without throwing, never let that render
    // as total silence - indistinguishable from "the reply never arrived"
    // (see LocalBackend.sendMessage's own empty-reply guard).
    const isEmpty = !(typeof reply === 'string' && reply.trim());
    // A backend/model that ignored the streaming request entirely (no
    // onChunk call ever fired) still has a real reply to show - feed it
    // to the streamer as one final push, exactly like a real chunk would
    // be, so it renders instead of being lost.
    if (!anyChunk && !isEmpty) writeReplyPiece(streamer.push(reply));
    writeReplyPiece(streamer.finish());
    if (isEmpty) {
      stopSpinner();
      clearBottomRows();
      const warningLine = `${dim('companion: warning: backend returned an empty reply')}\n`;
      recordHistory(warningLine);
      process.stdout.write(warningLine);
      drawBox();
    }
    turnBoundaryPending = true;
    return;
  }

  // Non-streaming path (vault auto-summary's Submit turns): the whole
  // transformed reply prints as one block once it's fully ready, same
  // shape as before streaming existed.
  let reply;
  try {
    reply = await backend.sendMessage(text);
  } catch (err) {
    stopSpinner();
    clearBottomRows();
    const errorLine = `${dim(`companion: error talking to backend (${BACKEND}): ${err.message}`)}\n`;
    recordHistory(errorLine);
    process.stdout.write(errorLine);
    drawBox();
    turnBoundaryPending = true;
    return;
  }
  stopSpinner();
  clearBottomRows();
  const displayText = onReply(reply);
  const isEmpty = !(typeof displayText === 'string' && displayText.trim());
  const marker = stylingEnabled() && !isEmpty ? turnMarker() : '';
  // Same hanging-indent treatment as the streaming path's first piece
  // (writeReplyPiece) - the whole reply prints as one block here, so its
  // own first line sits right after the marker and only that one line
  // stays unindented; see indentContinuation.
  const body = isEmpty
    ? dim('companion: warning: backend returned an empty reply')
    : indentContinuation(renderMarkdown(displayText));
  const fullBody = `${marker}${body.endsWith('\n') ? body : `${body}\n`}`;
  recordHistory(fullBody);
  process.stdout.write(fullBody);
  drawBox();
  turnBoundaryPending = true;
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) {
    // Ignore an empty submission entirely. Pressing Enter is readline's
    // own native handling, not ours - it already committed the (empty)
    // prompt row as permanent scrollback and moved the cursor to a fresh
    // row before this listener ever ran. A naive drawBox() here would draw
    // a whole new rule+prompt under that leftover row instead of reusing
    // it - meaning every empty Enter would permanently grow the screen by
    // two lines, and the rule (meant to be the single, unique break
    // between chat history and the live input) would duplicate itself
    // once per press. Reclaim that row instead (move up, clear) and redraw
    // only the prompt, still empty - the rule and blank-breathing-room
    // rows above it were never touched by readline's own handling and are
    // already correct, so the box ends up looking exactly as it did before
    // Enter was pressed, not just similar to it.
    //
    // While the screen hasn't genuinely filled yet, though, that reclaim
    // isn't enough on its own: readline's own commit-and-move-to-a-fresh-row
    // handling for Enter still emits a raw newline at whatever the terminal's
    // current last row is (the prompt's own row, since the box is always
    // pinned there) - the exact same last-row-overflow mechanism drawBox's
    // own fill-phase branch above exists to work around, so it forces a real
    // terminal scroll here too, silently dropping a row off the top, even
    // though an empty submission adds nothing to historyBuffer to justify
    // it. A full repaint recovers correctly, the same as drawBox's own
    // fill-phase branch - there's no typed content to preserve either way,
    // since the submission was empty.
    if (stylingEnabled()) {
      if (!screenFilledToBox) {
        redrawViewport();
      } else {
        readline.moveCursor(process.stdout, 0, -1);
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        rl.prompt(true);
      }
    } else {
      rl.prompt();
    }
    return;
  }
  // A non-empty submission, in contrast, must keep the row(s) readline just
  // committed - that's Thomson's own message, and it's meant to become part
  // of permanent chat history. Whatever the box was (boxShown/
  // reservedBottomRows) is now stale: readline's own native Enter handling
  // already committed and cleared all of it on its own. Reset both to
  // "nothing reserved" before the reply's own printAboveInput/box calls run.
  bottomRowsShown = 0;
  boxShown = false;
  if (text === '/exit' || text === '/quit') {
    rl.close();
    return;
  }
  // Readline's own echo already put this line on screen (that's what was
  // just committed to permanent scrollback, above) - this is purely for
  // history/showHistory's benefit, since readline's echo never goes
  // through printAboveInput or anything else that records it.
  if (process.stdout.isTTY) recordHistory(`${promptString()}${text}\n`);
  sendAndPrint(null, text);
});

rl.on('close', () => {
  stopping = true;
  // No "goodbye" line here - the alternate-screen restore (see the top of
  // this file) fires immediately after process.exit() below and erases
  // whatever's on screen anyway, so printing one would only ever flash
  // briefly, if it rendered at all, working against "exiting restores
  // exactly what was there before" rather than serving any purpose.
  process.exit(0);
});

// --- capture tailing (offset tracking adapted from the old watch.js) -------

function loadOffset() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.offset === 'number' && parsed.offset >= 0) return parsed.offset;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(dim(`companion: warning: could not read state file (${err.message}); starting fresh`));
    }
  }
  // No usable state: this is effectively a first run. Start at the current
  // end of the log (if it exists) so we tail forward, not replay history.
  try {
    return fs.statSync(CAPTURES_PATH).size;
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ offset }), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

let offset = loadOffset();

async function handleCaptureLine(line) {
  // A capture is new activity, not something the user asked for - if
  // they're mid-scroll reading back through history (see the scrollback
  // viewport section below), snap back to the live view first so every
  // write this function and the turn it triggers make below lands where
  // the existing rendering code has always assumed it would: at the live
  // bottom. Keeps that rendering code (printAboveInput, the streaming
  // writer, the spinner) entirely unaware scrolling exists at all.
  resetScrollIfNeeded();
  const trimmed = line.trim();
  if (!trimmed) return;
  let capture;
  try {
    capture = JSON.parse(trimmed);
  } catch (err) {
    printAboveInput(dim(`companion: warning: skipping malformed capture JSON: ${err.message}`));
    return;
  }
  const label = dim(
    `[capture] ${triggerLabel(capture.trigger)} - ${capture.problemTitle || capture.problemSlug || 'unknown'} (attempt ${capture.attemptSeq ?? '?'})`
  );

  // Detected and (if AUTO_CLEAR_CONTEXT is on) acted on before anything else
  // for this capture, so a reset - if one happens - is this turn's true
  // first output rather than something that shows up after the ack line
  // below. See "automatic context reset on problem switch" above.
  const resetNotice = maybeResetContextForCapture(capture);
  let turnPrefix = consumeTurnBoundary();
  if (resetNotice) {
    printAboveInput(turnPrefix + resetNotice);
    turnPrefix = '';
  }

  // Print an instant, local, non-LLM acknowledgement before the backend call
  // below even starts - the tutor persona's own step 1 (acknowledging receipt
  // in its own words) still happens too, but that's baked into the real reply
  // and can lag several seconds behind, longer for Submit. This line is just
  // a deterministic confirmation that the capture arrived, and (absent a
  // reset notice above) is this capture-driven turn's true first output, so
  // it's what consumes the pending turn-boundary blank line (see
  // consumeTurnBoundary) - sendAndPrint itself won't add a second one before
  // the label that follows.
  printAboveInput(
    turnPrefix +
      dim(
        `companion: got your ${triggerLabel(capture.trigger)} for ${capture.problemTitle || capture.problemSlug || 'this problem'} - taking a look...`
      ),
  );

  // Only Submits (not Runs) drive the vault auto-summary, and only when the
  // toggle is on - see the "vault auto-summary" section above. When active,
  // one extra instruction is appended to the same message so the single
  // reply carries both the tutoring commentary and the structured vault
  // data; no second LLM call.
  let vaultContext = null;
  if (VAULT_AUTO_SUMMARY && capture.trigger === 'submit') {
    try {
      vaultContext = prepareVaultContext({
        capture,
        vaultPath: VAULT_PATH,
        algorithmsSubfolder: VAULT_ALGORITHMS_SUBFOLDER,
      });
    } catch (err) {
      printAboveInput(dim(`companion: warning: could not prepare vault auto-summary context (${err.message})`));
    }
  }
  const message = formatCaptureMessage(capture) + (vaultContext ? vaultContext.addendum : '');

  await sendAndPrint(label, message, {
    onReply: vaultContext
      ? (reply) => {
          const { displayText, vaultData } = extractVaultBlock(reply, {
            warn: (msg) => printAboveInput(dim(`companion: warning: ${msg}`)),
          });
          if (vaultData) {
            try {
              writeVaultAutoSummary({ capture, vaultContext, vaultData });
            } catch (err) {
              printAboveInput(dim(`companion: warning: vault auto-summary write failed (${err.message})`));
            }
          } else {
            printAboveInput(
              dim('companion: warning: vault auto-summary was on but the reply had no vault data block; skipping this write')
            );
          }
          return displayText;
        }
      : undefined,
  });
}

async function poll() {
  let stats;
  try {
    stats = fs.statSync(CAPTURES_PATH);
  } catch {
    return; // log file doesn't exist yet
  }

  if (stats.size < offset) {
    printAboveInput(dim('companion: capture log shrank; resetting offset to 0'));
    offset = 0;
  }
  if (stats.size <= offset) return;

  const fd = fs.openSync(CAPTURES_PATH, 'r');
  let buf;
  try {
    const length = stats.size - offset;
    buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) return; // no complete line yet

  const complete = text.slice(0, lastNewline);
  const consumedBytes = Buffer.byteLength(complete, 'utf8') + 1;
  const lines = complete.split('\n');

  for (const line of lines) {
    // eslint-disable-next-line no-await-in-loop
    await handleCaptureLine(line);
  }

  offset += consumedBytes;
  saveOffset(offset);
}

async function pollLoop() {
  while (!stopping) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await poll();
    } catch (err) {
      printAboveInput(dim(`companion: error during capture poll: ${err.stack || err.message}`));
    }
    if (stopping) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => rl.close());
}

// --- mouse-wheel scrollback viewport ------------------------------------
//
// The alternate screen buffer has no native scrollback (see the top of
// this file), so this program keeps its own: historyBuffer already records
// every line of real conversation content verbatim (for Page Up/less
// below); scrollOffset is how many lines up from the live bottom the
// visible window currently sits, and redrawViewport paints exactly that
// window - a real, application-level scrollback, not reliance on anything
// the terminal provides. 0 means "the live tail" - the normal, default
// view, following new content exactly like before this feature existed.
// Only ever changed while idle (turnActive false) - see handleWheel and
// resetScrollIfNeeded below for why a turn in progress and a nonzero
// scrollOffset can never coincide, which is what lets the rest of this
// file's rendering code (printAboveInput, the streaming writer, the
// spinner) stay entirely unaware scrolling exists at all.
let scrollOffset = 0;

// How many lines a single wheel notch moves the viewport - most terminals
// send one SGR wheel report per physical notch (not per pixel), so this is
// "lines per notch," matching the common OS-level default of a few lines
// per click rather than a full screen.
const WHEEL_SCROLL_LINES = 3;

// Leaves room for the box's own rows: a blank breathing-room line, the
// rule, however many physical rows the prompt itself currently needs (see
// promptRowCount - normally 1, more once a long typed/pasted line has
// wrapped), and one more blank breathing-room row below the prompt,
// symmetric with the one above the rule (see drawBoxRaw's own reservation
// of that below-row, right before it renders the prompt). Reserving it here
// too, so redrawViewport's own padding math leaves the box's bottom pinned
// one row higher than the terminal's actual last row, is what makes the
// *fill-phase* draws (before the screen has genuinely filled with real
// content) agree with drawBoxRaw's own steady-state reservation, rather
// than the two disagreeing about where the box's bottom belongs.
// clearBottomRows/reservedBottomRows deliberately keep counting only "the
// rule plus the prompt" rows, since those are the rows at-and-above the
// cursor's own row - the reserved row below the cursor is never part of
// that upward count. Recomputed on every call rather than assumed fixed, so
// a long typed line correctly shrinks the space left for chat content
// instead of the box's extra wrapped row silently overlapping it.
function currentVisibleRows() {
  const rows = process.stdout.rows || 24;
  return Math.max(1, rows - 3 - promptRowCount());
}

// Repaints the screen from historyBuffer at the current scrollOffset, sized
// to the terminal's current height, then the box - the one place that
// actually turns "recorded history + an offset" into pixels. Used to
// return to the live view after the pager (see showHistory) closes, to
// respond to a wheel event, to reflow the current window after a resize,
// and (see drawBox above) as the fill-phase repaint for every ordinary
// redraw until the screen has genuinely filled with real content. Because
// it always repaints the *entire* visible window fresh from historyBuffer -
// the true, never-lost record of everything ever printed - rather than
// incrementally editing whatever the physical terminal screen currently
// shows, it can't inherit whatever an unrelated stray scroll (this
// program's own, or readline's own newline-at-the-last-row on a plain
// Enter) already did to the physical screen; it always recomputes the
// correct layout from scratch. scrollOffset is clamped here (not at the
// call sites) so it can never point past either end of the buffer
// regardless of how it got there - a shrunk terminal window, or history
// that's grown shorter than a previously-valid offset (e.g. after the
// capture log's own trim).
function redrawViewport() {
  const visibleRows = currentVisibleRows();
  const allLines = historyLines();
  const total = allLines.length;
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, total - visibleRows)));
  const end = total - scrollOffset;
  const start = Math.max(0, end - visibleRows);
  const slice = allLines.slice(start, end);
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen, cursor to top-left
  if (slice.length) process.stdout.write(`${slice.join('\n')}\n`);
  if (slice.length < visibleRows) {
    process.stdout.write('\n'.repeat(visibleRows - slice.length));
  }
  // Only latch "the screen has genuinely filled" when the *real* content
  // (not padding) actually reaches visibleRows - unlike the old code, which
  // set this unconditionally after any repaint. Latching unconditionally is
  // exactly what made drawBox's old incremental path silently corrupt a
  // short conversation: after the very first draw, drawBox would never pad
  // again regardless of how little real content there actually was, so
  // every later redraw's own newline-at-the-last-row forced a real terminal
  // scroll that dropped a row off the top instead. total >= visibleRows is
  // the one condition under which that natural scrolling is actually
  // correct and desired (see drawBox's own comment) - so that's the only
  // condition allowed to turn the incremental path back on.
  screenFilledToBox = total >= visibleRows;
  bottomRowsShown = 0;
  // drawBoxRaw directly, not drawBox - this *is* the fill-phase repaint
  // drawBox would otherwise delegate back to, so calling drawBox here would
  // either recurse into this same function again (screenFilledToBox still
  // false) or silently skip a row of padding this call already accounted
  // for (screenFilledToBox just turned true) by drawing the box a second,
  // redundant time.
  drawBoxRaw();
}

// Called by anything that represents new activity (a capture, a typed
// message) before it writes a single byte - if the user was scrolled up
// reading history, this always returns them to the live view first, so
// nothing else in this file ever has to reason about "what if we're
// mid-scroll right now." A no-op when already at the live bottom.
function resetScrollIfNeeded() {
  if (scrollOffset === 0) return;
  scrollOffset = 0;
  redrawViewport();
}

// The mouse-filter's onWheel callback (wired up where readlineInput is
// built, near the top of this file) - ignored entirely while a turn is
// active, same as Page Up already is below: mid-turn, bottomRowsShown
// might mean "a 1-row spinner" or a still-streaming piece rather than a
// settled 2-row box, and redrawViewport's full-screen clear would corrupt
// whatever that turn's own writes are tracking. Idle, scrolling is always
// safe: resetScrollIfNeeded (above) guarantees scrollOffset is already 0
// by the time any turn begins, so there's no state to reconcile once one
// does.
function handleWheel(direction) {
  if (!process.stdout.isTTY || turnActive) return;
  scrollOffset += direction === 'up' ? WHEEL_SCROLL_LINES : -WHEEL_SCROLL_LINES;
  scrollOffset = Math.max(0, scrollOffset);
  redrawViewport();
}

// Page Up opens the full conversation history in `less` rather than a
// hand-rolled scroll view - a real pager already gets wrapping, search,
// and its own Page Up/Down exactly right, which a from-scratch
// implementation would have to earn the hard way. `-X` specifically
// disables less's own terminal init/deinit (its own alternate-screen
// enter/exit) - without it, less entering *its own* alternate screen while
// this program is already in one, then leaving it, would drop the
// terminal straight back to the normal buffer under it instead of back to
// this program's own alternate screen, since 1049 isn't a stack (see the
// comment at the top of this file on why 1049 is used at all). With -X,
// less paints directly into the screen this program already owns, and
// handing it real terminal-attached stdio (not a pipe) is what makes its
// own scrolling/search interactive rather than just dumping the content.
// Still worth keeping now that the wheel scrolls the box's own viewport
// natively: `less` adds real search (`/`), unbounded scroll speed, and
// works even on a terminal that doesn't support SGR mouse reporting at
// all, none of which the lightweight windowed viewport above attempts to
// replace - both draw from the same historyBuffer regardless, so Page Up
// is now best thought of as "open the exact same history in a real pager"
// rather than the wheel's only fallback.
// Ignored while a turn is active (a spinner or a streamed piece is still
// mid-write to the same terminal - spawning a pager on top of that would
// corrupt both) and while there's nothing to show yet.
function showHistory() {
  if (!process.stdout.isTTY || turnActive || historyBuffer.length === 0) return;
  const content = historyBuffer.join('');
  rl.pause();
  // Mouse tracking is a terminal-wide mode, not scoped to any one file
  // descriptor - `less` reads its own keyboard input directly from
  // /dev/tty (the standard pager trick for staying interactive even when
  // its content comes in over a pipe, as it does here), completely
  // bypassing this process's stdin. Left enabled, a wheel scroll while
  // `less` is open would still generate SGR reports, just delivered to
  // `less` instead - which doesn't understand them any better than
  // readline does - so they're turned off for the duration and restored
  // once `less` returns.
  process.stdout.write(DISABLE_MOUSE_TRACKING);
  // spawnSync doesn't throw for a missing binary (ENOENT) or any other
  // spawn-time failure - it returns normally with .error set instead, so
  // that's what needs checking here, not a try/catch.
  const result = spawnSync('less', ['-RX'], { input: content, stdio: ['pipe', 'inherit', 'inherit'] });
  process.stdout.write(ENABLE_MOUSE_TRACKING);
  rl.resume();
  if (result.error) {
    printAboveInput(dim(`companion: warning: could not open history in "less" (${result.error.message})`));
    return;
  }
  scrollOffset = 0;
  redrawViewport();
}

if (process.stdout.isTTY) {
  // Attached to filteredStdin, not process.stdin directly - see the "raw
  // input / mouse-wheel scrollback" section near the top of this file for
  // why: readline's own keypress decoder (and this listener, sharing the
  // same decoder) only ever sees the filtered stream in a real terminal.
  filteredStdin.on('keypress', (str, key) => {
    if (key && key.name === 'pageup') showHistory();
  });
}

await ensureRelayServer();

printBanner(dim(`companion: backend=${BACKEND}${MODEL ? ` model=${MODEL}` : ''}`));
printBanner(dim(`companion: watching ${CAPTURES_PATH} (starting offset=${offset})`));
printBanner(
  dim(
    VAULT_AUTO_SUMMARY
      ? `companion: vault auto-summary ON - writing to ${VAULT_PATH}`
      : 'companion: vault auto-summary off (set VAULT_AUTO_SUMMARY=1 to enable)'
  )
);
printBanner(
  dim(
    AUTO_CLEAR_CONTEXT
      ? 'companion: auto-clear-context ON - a capture for a different problem resets the tutor session (set COMPANION_AUTO_CLEAR_CONTEXT=0 to disable)'
      : 'companion: auto-clear-context off (COMPANION_AUTO_CLEAR_CONTEXT=0)'
  )
);
printBanner(
  dim('companion: type to chat directly; captures are injected automatically. Page Up for history, /exit to quit.')
);
if (stylingEnabled()) drawBox();
else rl.prompt();

// Node updates process.stdout.columns/rows (from the terminal's SIGWINCH)
// and emits 'resize' before this fires, so refreshWidth() below - which
// just re-reads process.stdout.columns - already picks up the new size.
// Always safe to do regardless of what's on screen right now. Redrawing
// the box itself to *show* the new width immediately is only safe when
// idle (turnActive false): mid-turn, bottomRowsShown might mean "a 1-row
// spinner" rather than "a 2-row box" at any given moment, and forcing a
// 2-row box there would corrupt whatever the turn's own writes are
// tracking. Idle, the box's state is simple and known, so it can just be
// redrawn on the spot; mid-turn, the new width still takes effect - just
// only visibly once the turn's own next write happens, rather than
// instantly. Registered only after the box above is first drawn, so there's
// no window where a resize could fire before there's a box to redraw.
if (process.stdout.isTTY) {
  process.stdout.on('resize', () => {
    refreshWidth();
    // Rows may have changed too, not just columns. redrawViewport (below)
    // already recomputes its own padding fresh on every call regardless of
    // this latch's prior value, so this reset only actually matters for the
    // turnActive branch: mid-turn, redrawViewport doesn't run yet (see
    // below), so drop the latch now so the turn's own next incremental
    // drawBox call - once it does run - re-evaluates against the new size
    // instead of trusting a conclusion reached at the old one.
    screenFilledToBox = false;
    if (!turnActive) {
      // Always a full repaint (not just the box's own row), whether idle at
      // the live tail or scrolled - redrawViewport already handles both
      // (scrollOffset 0 is simply "show the live tail"), and it's what
      // makes the box actually move to the new last row rather than only
      // updating in place where it already was. It replays already-
      // rendered content from historyBuffer rather than re-wrapping it to
      // the new width (only markdown rendered *after* this point picks up
      // the new width - see refreshWidth's own comment), so this is safe
      // for a plain column-only resize too; the cost is a full-screen
      // clear on every resize rather than only when scrolled, which is an
      // acceptable trade for a resize actually pinning correctly.
      redrawViewport();
    }
    // Mid-turn, the new size still takes effect - just only visibly once
    // the turn's own next write calls drawBox again (screenFilledToBox was
    // just cleared above, so that draw will pad correctly too).
  });
}

pollLoop().catch((err) => {
  console.error(dim(`companion: fatal: ${err.stack || err.message}`));
  process.exit(1);
});
