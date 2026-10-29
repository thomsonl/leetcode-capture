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
//   - Sends a changed Submit (never a Run) and every typed message into the
//     same ongoing conversation through a swappable backend, the code as a
//     diff against what the tutor already holds (see code-ledger.js), then
//     prints the real response - no pane, nothing to scrape.
//
// Providers (chosen on the extension's options page, saved by settings.js, or
// with COMPANION_BACKEND, which wins):
//   - "claude" (default): the Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
//     on the Claude Code sign-in, a real programmatic session - not the
//     `claude` CLI driven by keystrokes. "anthropic" is the same backend with
//     an API key.
//   - "local": plain HTTP against an OpenAI-compatible chat-completions
//     endpoint (e.g. a local Ollama install). No extra dependency - Node's
//     built-in fetch. "openai" is the same backend against OpenAI's API.
//   - "chatgpt": the Codex CLI on a ChatGPT sign-in (codex-backend.js).
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
import { LocalBackend } from '../extension/shared/local-backend.js';
import {
  TUTOR_SYSTEM_MESSAGE,
  SUBMIT_ADDENDUM,
  triggerLabel,
  captureHeaderLine,
  captureProblemId,
  captureProblemContext,
} from '../extension/shared/tutor-prompt.js';
import { createPanelBridge } from './panel-bridge.js';
import {
  loadSettings,
  resolveEffective,
  settingsPath,
  statusSummary,
  claudeBackendEnv,
  OLLAMA_BASE_URL,
  PROVIDERS,
} from './settings.js';
import { createSettingsRpc } from './settings-rpc.js';
import { CodexBackend } from './codex-backend.js';
import { requestCaptureTrim, pendingTrimFor, pendingTrimHappened, isPendingTrim } from './capture-log.js';
import { stripControlChars, oneLine, sanitizeCapture } from '../extension/shared/sanitize.js';
import {
  createCodeLedger,
  sendsToTutor,
  buildSubmitMessage,
  buildChatMessage,
  DEFAULT_MAX_PROBLEMS,
} from '../extension/shared/code-ledger.js';

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

// Which LLM the tutor talks to and how comes from settings.js: per field, an
// environment variable wins over the saved settings file (written by the
// extension's options page through settings-rpc.js), which wins over the
// default. A set environment variable locks its field in the options page.
// `effective` is replaced as a whole after each save from the options page
// (applySettings, below), so everything that reads it sees the new values
// from the next turn on. It carries the API key, so it is never published.
const SETTINGS_FILE = settingsPath(process.env);
const loadedSettings = loadSettings(SETTINGS_FILE);
let storedSettings = loadedSettings.settings;
let effective = resolveEffective(storedSettings, process.env);

// Ollama's own default OpenAI-compat address, used when nothing else is set.
// Any OpenAI-compatible server works (LM Studio, llama.cpp server, vLLM,
// text-generation-webui, LocalAI, ...).
const DEFAULT_BASE_URL = OLLAMA_BASE_URL;

// Which HTTP API LocalBackend actually speaks: 'openai' (the standard
// /v1/chat/completions shape every OpenAI-compatible server understands) or
// 'native' (Ollama's own /api/chat, which, unlike any OpenAI-compatible
// endpoint, honors a requested context window, `num_ctx`; see LOCAL_NUM_CTX
// and LocalBackend's class comment). 'auto' (the default, null here) probes
// the server once (local-server.js: Ollama answers GET /api/version) and uses
// 'native' only for a server that answers like Ollama, whatever its address
// or port; anything else, or a failed probe, is 'openai'. Explicit
// "openai"/"native" (case-insensitive) always wins.
const LOCAL_API_RAW = (process.env.COMPANION_LOCAL_API || 'auto').toLowerCase();
const LOCAL_API = LOCAL_API_RAW === 'openai' || LOCAL_API_RAW === 'native' ? LOCAL_API_RAW : null;

// The configured context window in tokens. It is what Ollama's native API is
// asked for (`options.num_ctx`), and the most LocalBackend ever budgets for
// on any server: the window actually used is the smallest of this, what the
// server reports when probed, and what a reply shows the server really kept
// (see resolveContextWindow in context-budget.js). 8192 is double the 4096
// this project's configured Ollama model (gemma4:26b) runs with by default,
// and was confirmed live to turn a real single-capture failure (a normal
// ~150-line solution plus its problem description, no prior history) into a
// normal completed reply with the exact same input.
// From settings.js: the "Context window (tokens)" field of the local
// provider, or COMPANION_LOCAL_NUM_CTX, which wins over it.
const DEFAULT_LOCAL_NUM_CTX = 8192;

// How many tokens of LOCAL_NUM_CTX to hold back for the model's own
// thinking + answer when pre-flight checking a request's estimated size
// (see estimateTokens/LocalBackend.sendMessage below) - the request itself
// only gets the remainder as budget. Chosen from live investigation data
// (data/companion-context-capacity-test in the firstmate repo): eval_count
// (thinking+answer combined) ranged 1,141-2,607 tokens across a wide sweep
// of real prompt sizes against this project's configured model, largely
// independent of prompt length. 2600 sits just above that observed max, so
// an unusually long "thinking" pass still has room without needing a
// per-request guess.
const LOCAL_RESERVE_TOKENS = Number(process.env.COMPANION_LOCAL_RESERVE_TOKENS || 2600);

// The other options also come from settings.js (`effective.options`):
//   - vaultAutoSummary (VAULT_AUTO_SUMMARY), off by default: a portable
//     checkout won't have this vault's Study/Algorithms structure, or even
//     use Obsidian. See "Vault auto-summary" below and README.md.
//   - autoClearContext (COMPANION_AUTO_CLEAR_CONTEXT), on by default: see the
//     "automatic context reset on problem switch" section below for why
//     leaving it on is the safer default (a stale problem's code and
//     discussion would otherwise keep being resent long after the
//     conversation moved on).
//   - localMaxHistoryTurns (COMPANION_LOCAL_MAX_HISTORY_TURNS), 6 by default:
//     how many user+assistant pairs LocalBackend and CodexBackend keep in
//     full; older ones are condensed into one short summary
//     (context-summary.js). Only a cap on the count: every local request is
//     also fitted to the token budget before it is sent (fitWithSummary).
//     0 turns the count cap off.
// In-page tutor panel (the extension's "Tutor" tab on leetcode.com): mirrors
// this conversation to the browser through the relay server and accepts
// messages typed there. On by default; COMPANION_PANEL=0 turns the bridge off
// and leaves the terminal chat exactly as it was. See panel-bridge.js.
const PANEL_ENABLED = !/^(0|false|no)$/i.test(process.env.COMPANION_PANEL || '');
// Run by the Native Messaging helper (helper/host.js) instead of from a
// terminal: stdin is the helper's pipe (it writes commands such as /reset,
// and closing it is the signal to quit), output goes to the helper's log
// file, and the helper owns the relay. A closed terminal's SIGHUP does not
// apply; the helper ends this process with SIGTERM or by closing stdin.
const HEADLESS = /^(1|true|yes)$/i.test(process.env.COMPANION_HEADLESS || '');
// With nothing heard from the relay (so no panel and no extension behind
// it) for this long, quit on our own, so a browser or helper that vanished
// cannot leave this process behind. Headless only by default; 0 turns it off.
const IDLE_EXIT_MS = Number(process.env.COMPANION_IDLE_EXIT_MS ?? (HEADLESS ? 3 * 60 * 1000 : 0)) || 0;

const { vaultPath: VAULT_PATH, algorithmsSubfolder: VAULT_ALGORITHMS_SUBFOLDER } = resolveVaultConfig();
// Fail loudly at startup, not on the first Submit - a wrong or unset vault
// path should never silently fabricate a new folder tree (see
// vault-notes.js's validateVaultPath). Only checked when the feature is
// actually on, so a portable checkout with it off never needs a real vault.
// A save from the options page is checked the same way (settings-rpc.js's
// validateVault) and refused instead.
if (effective.options.vaultAutoSummary) validateVaultPath(VAULT_PATH);

const SCRATCH_DIR =
  process.env.LEETCODE_COMPANION_SCRATCH ||
  path.join(os.homedir(), '.local', 'state', 'leetcode-companion', 'scratch');
const CAPTURES_PATH =
  process.env.LEETCODE_CAPTURES_FILE ||
  path.join(REPO_ROOT, 'relay-server', 'data', 'captures.jsonl');
const STATE_PATH =
  process.env.LEETCODE_COMPANION_STATE_FILE || path.join(__dirname, '.companion-state.json');
const POLL_MS = Number(process.env.LEETCODE_COMPANION_POLL_MS || 1000);
// The size backstop for clearing the capture log (see "capture tailing"
// below): once the handled part passes this, it is dropped even without a
// problem switch.
const CAPTURE_LOG_TRIM_BYTES = Number(process.env.LEETCODE_CAPTURES_TRIM_BYTES || 4 * 1024 * 1024);

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
  constructor({ model, apiKey = null }) {
    this.model = model;
    this.apiKey = apiKey;
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

  // `problemContext` (see companion.js's captureProblemContext) is supplied
  // whenever a problem is known - only actually used below on a fresh SDK
  // session's very first message (see promptText). `heldCode`/`compactText`
  // (LocalBackend's code pinning) are not needed here: a resumed session
  // keeps the first full code and every later diff, and a reset starts a
  // new session.
  async sendMessage(text, { onChunk, problemContext } = {}) {
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
      systemPrompt: TUTOR_SYSTEM_MESSAGE,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      env: claudeBackendEnv(this.apiKey),
    };
    if (this.model) options.model = this.model;
    if (this.sessionId) options.resume = this.sessionId;
    // Only opt into partial-message events when a caller actually wants
    // them - onReply's vault-block-stripping path (see sendAndPrint) calls
    // this with no onChunk at all, and this stays a plain, unchanged
    // request in that case.
    if (onChunk) options.includePartialMessages = true;

    // A fresh SDK session (no resumed session id yet) needs the problem
    // description inline, once - unlike LocalBackend, this backend's own
    // continuity is a resumed server-side session with no trimming (see
    // resetContext below), so the description only needs supplying once per
    // session, right at its start, and stays available for the rest of this
    // problem's captures until AUTO_CLEAR_CONTEXT resets sessionId on a
    // genuine problem switch - no separate pinning/reconstruction logic
    // needed the way LocalBackend.buildMessages requires.
    let promptText = text;
    if (!this.sessionId && problemContext?.description) {
      promptText =
        `Problem currently being discussed: ${problemContext.title} (${problemContext.slug})\n\n` +
        `${problemContext.description}\n\n${text}`;
    }

    let resultText = null;
    let errorNote = null;
    for await (const message of this.queryFn({ prompt: promptText, options })) {
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

// LocalBackend (any OpenAI-compatible server, or Ollama's native API) lives
// in extension/shared/local-backend.js, shared with the extension's own
// engine.

// Builds the backend for an effective configuration (settings.js's
// resolveEffective). Throws, with a message fit for the options page, when
// one cannot be built from it. Used at startup and by every options-page
// save or connection test (settings-rpc.js), so all of them agree.
function makeBackend(config) {
  const { provider } = config;
  if (provider === 'claude') return new ClaudeBackend({ model: config.model });
  if (provider === 'anthropic') {
    if (!config.apiKey) throw new Error('Anthropic API key needs an API key (or ANTHROPIC_API_KEY)');
    return new ClaudeBackend({ model: config.model, apiKey: config.apiKey });
  }
  if (provider === 'local' || provider === 'openai') {
    return new LocalBackend({
      baseUrl: config.baseUrl || DEFAULT_BASE_URL,
      model: config.model,
      apiKey: config.apiKey,
      maxHistoryTurns: config.options.localMaxHistoryTurns,
      // A hosted OpenAI API always speaks the OpenAI shape; never probe it
      // for Ollama's native API.
      apiStyle: provider === 'openai' ? 'openai' : LOCAL_API,
      numCtx: config.contextTokens || DEFAULT_LOCAL_NUM_CTX,
      reserveTokens: LOCAL_RESERVE_TOKENS,
    });
  }
  if (provider === 'chatgpt') {
    return new CodexBackend({
      model: config.model,
      cwd: path.join(SCRATCH_DIR, 'codex'),
      systemPrompt: TUTOR_SYSTEM_MESSAGE,
      maxHistoryTurns: config.options.localMaxHistoryTurns,
    });
  }
  throw new Error(`unknown provider "${provider}" (expected one of ${Object.keys(PROVIDERS).join(', ')})`);
}

// Swappable: an options-page save replaces it through the turn queue (see
// applySettings), so a swap never lands in the middle of a turn.
let backend = makeBackend(effective);

// The label used in "error talking to backend (...)" lines.
function backendLabel() {
  return effective.provider;
}

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
  // The helper starts the relay before this process and stops it after, so a
  // relay started from here would outlive both.
  if (HEADLESS) {
    printBanner(dim(`companion: warning: the relay is not answering on http://${RELAY_HOST}:${RELAY_PORT}`), console.error);
    return;
  }

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

// --- in-page panel bridge ----------------------------------------------------
//
// Everything printed to the terminal for the tutor conversation is also
// published as small structured events (user message, capture, turn
// start/chunk/end, notice) so the panel can render the same conversation in
// the browser. The terminal path stays the source of truth: every publish is
// fire-and-forget through panelPublish, and a missing/slow relay can never
// block or alter what the terminal does.
let panelBridge = null;
// The problem the conversation is currently about, as the panel's own
// per-problem transcript key. Updated by captures and by panel messages.
let panelProblemSlug = null;
let panelTurnCounter = 0;
// What code the tutor has been shown, the newest code per problem, and which
// problem is active (see code-ledger.js). In memory only: a restart starts
// the backends from nothing too.
const ledger = createCodeLedger({ maxProblems: DEFAULT_MAX_PROBLEMS });

// The panel's "Processing" light: how many tutor turns are running or
// queued. A typed message counts from the moment it is queued, a Submit from
// when it turns out to need the tutor (a Run, or an unchanged Submit, never
// does). Going idle is told a moment late, so the gap between two queued
// turns does not flash "Connected" in between.
let busyTurns = 0;
let busyIdleTimer = null;
const BUSY_IDLE_DELAY_MS = 100;
function holdBusy() {
  busyTurns += 1;
  if (busyIdleTimer) {
    clearTimeout(busyIdleTimer);
    busyIdleTimer = null;
  }
  if (panelBridge) panelBridge.setBusy(true);
  let released = false;
  return function releaseBusy() {
    if (released) return;
    released = true;
    busyTurns -= 1;
    if (busyTurns > 0 || busyIdleTimer) return;
    busyIdleTimer = setTimeout(() => {
      busyIdleTimer = null;
      if (busyTurns === 0 && panelBridge) panelBridge.setBusy(false);
    }, BUSY_IDLE_DELAY_MS);
    busyIdleTimer.unref();
  };
}

function panelPublish(event) {
  if (!panelBridge) return;
  // The panel keeps one transcript per problem and only shows the one for the
  // page it is on, so an event that belongs to no problem (a message typed in
  // the terminal before any capture, say) would be stored under an empty key
  // that no page ever displays: dead weight in the relay's replay buffer and
  // in every panel. Not sending it is the honest outcome. Chunks carry no slug
  // of their own; sendAndPrintTurn skips those for such a turn.
  if ('problemSlug' in event && !event.problemSlug) return;
  panelBridge.publish(event);
}

function newPanelTurnId() {
  panelTurnCounter += 1;
  return `t${Date.now().toString(36)}-${panelTurnCounter}`;
}

// Capture formatting (triggerLabel, captureHeaderLine, SUBMIT_ADDENDUM,
// captureProblemId, captureProblemContext) lives in
// extension/shared/tutor-prompt.js, shared with the extension's own engine.

// --- automatic context reset on problem switch (AUTO_CLEAR_CONTEXT) --------
//
// The active problem is whichever one the student last sent a message, Run
// or Submit from. Activity on a different problem hard-resets the backend's
// own continuity (see each backend's resetContext, above) instead of leaving
// it to the model to notice the switch, drops what the ledger knew about the
// old problem (code-ledger.js's activate), and asks the relay to drop the old
// problem's buffered chat. The part of captures.jsonl already handled is
// dropped too (see "capture tailing" below); nothing about an old problem is
// kept.
//
// Identifier: capture.problemSlug, falling back to capture.problemTitle when
// slug is absent. The very first problem this process sees resets nothing
// (there is no prior context to clear), so a restart needs no persisted
// state either.

// Makes problemId the active problem, resetting everything about the old one
// when it changed (and AUTO_CLEAR_CONTEXT is on). Runs inside the turn queue,
// so a reset never lands in the middle of a backend call.
function activateProblem(problemId, slug) {
  const result = ledger.activate(problemId, { slug, resetOnSwitch: effective.options.autoClearContext });
  if (!result.reset) return result;
  backend.resetContext();
  if (result.dropped && result.dropped.slug && panelBridge) panelBridge.dropProblem(result.dropped.slug);
  // The old problem's captures are no longer needed either: the handled
  // part of the log goes at the end of the current poll (see pollLoop).
  captureTrimWanted = true;
  printAboveInput(
    consumeTurnBoundary() + dim(`companion: new problem detected (${oneLine(problemId) || 'unknown'}) - clearing tutor context`)
  );
  panelPublish({ type: 'notice', problemSlug: slug || null, text: 'New problem detected. Started a fresh tutor session.' });
  return result;
}

// `/reset` (typed, or written by the helper when the active problem's tab
// stayed closed for its grace period): the tutor forgets the conversation and
// the code it held, so the next message starts fresh with the full code. The
// relay, the panel feed and the process itself stay as they are.
function resetTutorContext() {
  backend.resetContext();
  ledger.forgetHeld();
  printAboveInput(consumeTurnBoundary() + dim('companion: tutor context cleared'));
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

// Runs one queued task as a turn: the view snaps back to the live bottom
// first (new activity, even if the user was scrolled up reading history),
// and turnActive is set while it runs. Every capture, panel message and typed
// message goes through here, so the ledger's reads and writes, context
// resets and backend calls all happen in arrival order, one at a time.
function queueTurn(task) {
  resetScrollIfNeeded();
  return enqueue(async () => {
    turnActive = true;
    try {
      return await task();
    } finally {
      turnActive = false;
    }
  });
}

// Sends one message and prints (and mirrors to the panel) the reply.
// Resolves true once the backend answered with a real reply, false on an
// error or an empty reply, so the caller only records the code as held by
// the tutor when it really got it.
//
// onReply, when given, runs on the raw reply before it's printed and may
// return a transformed string - used by handleCaptureLine to peel the vault
// auto-summary's JSON block back off a Submit reply (see extractVaultBlock)
// before it ever reaches the terminal. That stripping can only happen once
// the reply is complete, so a turn with onReply set never streams - see the
// non-streaming branch below.
async function sendAndPrintTurn(label, text, options = {}) {
  try {
    return await sendAndPrintTurnBody(label, text, options);
  } finally {
    // A backend's own warnings from this turn (LocalBackend's silent-
    // truncation guard), printed below the reply or error they are about.
    for (const warning of backend.takeWarnings?.() || []) {
      printAboveInput(dim(`companion: warning: ${warning}`));
    }
  }
}

async function sendAndPrintTurnBody(label, text, { onReply, problemContext, heldCode, compactText, panelMeta } = {}) {
  // Mirrors this turn to the in-page panel (see "in-page panel bridge"
  // above): a start marker, each streamed chunk, then one end event carrying
  // the authoritative full text (or the error), so a panel that connects
  // mid-turn or reloads still ends up with the right transcript.
  const panelTurnId = newPanelTurnId();
  const panelSlug = (panelMeta && panelMeta.problemSlug) || panelProblemSlug;
  // No problem, no panel transcript to put this turn in (see panelPublish).
  const mirrorChunks = Boolean(panelSlug);
  panelPublish({ type: 'turn-start', turnId: panelTurnId, problemSlug: panelSlug });
  const panelEnd = (fields) => panelPublish({ type: 'turn-end', turnId: panelTurnId, problemSlug: panelSlug, ...fields });
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
          if (mirrorChunks) panelPublish({ type: 'chunk', turnId: panelTurnId, text: chunk });
          writeReplyPiece(streamer.push(chunk));
        },
        problemContext,
        heldCode,
        compactText,
      });
    } catch (err) {
      stopSpinner();
      clearBottomRows();
      const errorLine = `${dim(`companion: error talking to backend (${backendLabel()}): ${err.message}`)}\n`;
      recordHistory(errorLine);
      process.stdout.write(errorLine);
      drawBox();
      turnBoundaryPending = true;
      panelEnd({ error: `Error talking to the backend (${backendLabel()}): ${err.message}` });
      return false;
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
      panelEnd({ error: 'The backend returned an empty reply.' });
    } else {
      panelEnd({ text: reply });
    }
    turnBoundaryPending = true;
    return !isEmpty;
  }

  // Non-streaming path (vault auto-summary's Submit turns): the whole
  // transformed reply prints as one block once it's fully ready, same
  // shape as before streaming existed.
  let reply;
  try {
    reply = await backend.sendMessage(text, { problemContext, heldCode, compactText });
  } catch (err) {
    stopSpinner();
    clearBottomRows();
    const errorLine = `${dim(`companion: error talking to backend (${backendLabel()}): ${err.message}`)}\n`;
    recordHistory(errorLine);
    process.stdout.write(errorLine);
    drawBox();
    turnBoundaryPending = true;
    panelEnd({ error: `Error talking to the backend (${backendLabel()}): ${err.message}` });
    return false;
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
  if (isEmpty) panelEnd({ error: 'The backend returned an empty reply.' });
  else panelEnd({ text: displayText });
  // The tutor got the code even if the vault block was all it wrote back.
  return typeof reply === 'string' && reply.trim() !== '';
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
  if (text === '/reset') {
    queueTurn(async () => resetTutorContext()).catch(() => {});
    return;
  }
  // Readline's own echo already put this line on screen (that's what was
  // just committed to permanent scrollback, above) - this is purely for
  // history/showHistory's benefit, since readline's echo never goes
  // through printAboveInput or anything else that records it.
  if (process.stdout.isTTY) recordHistory(`${promptString()}${text}\n`);
  panelPublish({ type: 'user', text, problemSlug: panelProblemSlug });
  // The terminal cannot read the live editor, so the code reference is the
  // newest Run or Submit recorded for the active problem.
  const releaseBusy = holdBusy();
  queueTurn(() => sendChatTurn({ label: null, text, problemId: ledger.activeProblemId })).finally(releaseBusy);
});

// A typed message (terminal or panel), inside the turn queue: prefixed with
// the code update when the code changed since the tutor last saw it (see
// code-ledger.js), and the code counted as held once the reply came back.
// codeUnavailable: a panel message whose editor code could not be read. It
// goes with no code update at all (the newest Run or Submit does not stand
// in for the live code), and the tutor is told why.
async function sendChatTurn({ label, text, problemId, preamble = null, codeUnavailable = false }) {
  const plan = problemId && !codeUnavailable ? ledger.planUpdate(problemId) : { kind: 'none' };
  const message = buildChatMessage({
    text,
    plan,
    preamble: typeof preamble === 'function' ? preamble(plan) : preamble,
  });
  const ok = await sendAndPrintTurn(label, message.text, {
    problemContext: (problemId && ledger.context(problemId)) || undefined,
    heldCode: problemId ? ledger.held(problemId) : null,
    compactText: message.compactText,
    panelMeta: { problemSlug: panelProblemSlug },
  });
  if (ok && (plan.kind === 'full' || plan.kind === 'diff')) ledger.commit(problemId, plan);
}

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
//
// The log is a short-lived delivery queue from the relay, and it is cleared
// as it is consumed (see capture-log.js): the handled prefix is dropped at
// start, after a problem switch, and once it passes CAPTURE_LOG_TRIM_BYTES.
// Always between polls (pollLoop), so `offset` then marks exactly the lines
// already handled, and never while a poll is reading the file.

// The log's bytes at [position, position + length), fewer at its end.
function readCaptureBytes(position, length) {
  let fd;
  try {
    fd = fs.openSync(CAPTURES_PATH, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, Math.max(0, position));
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function loadOffset() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.offset === 'number' && parsed.offset >= 0) {
      // A trim this companion asked for before it last stopped, with no
      // record of how it ended: the bytes before the cut tell.
      if (isPendingTrim(parsed.pendingTrim)) {
        const happened = pendingTrimHappened(parsed.pendingTrim, readCaptureBytes);
        const resolved = happened ? Math.max(0, parsed.offset - parsed.pendingTrim.before) : parsed.offset;
        saveOffset(resolved);
        return resolved;
      }
      return parsed.offset;
    }
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

function saveOffset(offset, pendingTrim) {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pendingTrim ? { offset, pendingTrim } : { offset }), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

let offset = loadOffset();
let captureTrimWanted = false;
// Set once the relay turns out not to support trimming (or refuses), so the
// warning is printed once and the request not repeated every poll.
let captureTrimDisabled = false;

// Asks the relay to drop the handled prefix of the log (everything before
// `offset`), and moves `offset` back by what it removed once it confirms.
// Only called from pollLoop, between polls.
async function trimHandledCaptures() {
  captureTrimWanted = false;
  if (captureTrimDisabled || offset === 0) return;
  const before = offset;
  const pending = pendingTrimFor(before, readCaptureBytes);
  saveOffset(offset, pending);
  const result = await requestCaptureTrim({
    baseUrl: `http://${RELAY_HOST}:${RELAY_PORT}`,
    before,
    logPath: path.resolve(CAPTURES_PATH),
  });
  if (result.outcome === 'trimmed') {
    offset -= result.removed;
  } else if (result.outcome === 'unknown') {
    // No answer (a timeout, the relay restarting): whether it cut the file
    // is read off the file itself, the same way a restart would.
    if (pendingTrimHappened(pending, readCaptureBytes)) offset = Math.max(0, offset - before);
  } else {
    captureTrimDisabled = true;
    printAboveInput(
      dim(
        result.outcome === 'unsupported'
          ? 'companion: warning: the running relay server cannot clear the capture log; restart it to enable that'
          : `companion: warning: the relay would not clear the capture log (${oneLine(result.error)}); is CAPTURE_LOG_PATH the same file as LEETCODE_CAPTURES_FILE?`
      )
    );
  }
  saveOffset(offset);
}

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
    // Every capture field that gets printed, published to the panel or put
    // in the model's prompt label is attacker-controlled: /capture is CORS
    // `*`, so any website can post one. Sanitized once, here (see
    // sanitize.js).
    capture = sanitizeCapture(JSON.parse(trimmed));
  } catch (err) {
    // V8's JSON.parse message quotes part of the input, escapes included.
    printAboveInput(dim(`companion: warning: skipping malformed capture JSON: ${oneLine(err.message)}`));
    return;
  }
  const label = dim(
    `[capture] ${triggerLabel(capture.trigger)} - ${capture.problemTitle || capture.problemSlug || 'unknown'} (attempt ${capture.attemptSeq ?? '?'})`
  );
  const problemId = captureProblemId(capture);
  const sends = sendsToTutor(capture.trigger);
  if (capture.problemSlug) panelProblemSlug = capture.problemSlug;
  const shownTitle = capture.problemTitle || capture.problemSlug || 'this problem';

  // Everything else happens in the turn queue, in arrival order: the reset
  // (if this capture is for another problem) first, then recording the code,
  // then (a changed Submit only) the backend call.
  await queueTurn(async () => {
    if (problemId) {
      activateProblem(problemId, capture.problemSlug || null);
      ledger.record(problemId, {
        code: typeof capture.code === 'string' ? capture.code : undefined,
        language: capture.language || null,
        slug: capture.problemSlug || null,
        context: captureProblemContext(capture),
      });
    }

    // A Run (or anything else that is not a Submit) is only recorded: the
    // tutor sees what changed with the student's next message.
    if (!sends) {
      printAboveInput(
        consumeTurnBoundary() +
          dim(
            `companion: recorded your ${triggerLabel(capture.trigger)} for ${shownTitle} (attempt ${capture.attemptSeq ?? '?'}) - not sent to the tutor; it sees the changes with your next message`
          )
      );
      turnBoundaryPending = true;
      return;
    }

    const plan = problemId ? ledger.planUpdate(problemId) : { kind: 'none' };
    if (plan.kind === 'unchanged' || plan.kind === 'none') {
      const why = plan.kind === 'unchanged' ? 'is unchanged since the tutor last saw it' : 'carried no code';
      printAboveInput(
        consumeTurnBoundary() +
          dim(`companion: your Submit for ${shownTitle} (attempt ${capture.attemptSeq ?? '?'}) ${why} - not sent`)
      );
      turnBoundaryPending = true;
      return;
    }

    // Only a capture the tutor is about to see shows its chip in the panel:
    // a Run or an unchanged Submit shows nothing there.
    panelPublish({
      type: 'capture',
      problemSlug: capture.problemSlug || null,
      problemTitle: capture.problemTitle || null,
      trigger: capture.trigger,
      attemptSeq: Number.isInteger(capture.attemptSeq) ? capture.attemptSeq : null,
    });

    // From here on the tutor is working on this Submit (the panel's
    // "Processing" light, see holdBusy).
    const releaseBusy = holdBusy();
    try {
      // An instant, local, non-LLM acknowledgement before the backend call
      // starts: the tutor's own acknowledgement is baked into its reply and can
      // lag several seconds behind.
      printAboveInput(consumeTurnBoundary() + dim(`companion: got your Submit for ${shownTitle} - taking a look...`));

      // Only Submits drive the vault auto-summary, and only when the toggle is
      // on - see the "vault auto-summary" section above. One extra instruction
      // rides on the same message; no second LLM call.
      let vaultContext = null;
      if (effective.options.vaultAutoSummary) {
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
      const message = buildSubmitMessage({
        headerLine: captureHeaderLine(capture),
        plan,
        addendum: SUBMIT_ADDENDUM + (vaultContext ? vaultContext.addendum : ''),
      });
      const ok = await sendAndPrintTurn(label, message.text, {
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
        problemContext: ledger.context(problemId) || captureProblemContext(capture),
        heldCode: ledger.held(problemId),
        compactText: message.compactText,
        panelMeta: { problemSlug: capture.problemSlug || null },
      });
      if (ok) ledger.commit(problemId, plan);
    } finally {
      releaseBusy();
    }
  });
}

// The live editor code the panel read at send time (see extension/panel.js
// and content.js), or null. Only the fields the tutor needs, made safe the
// same way a capture is; the code itself is left exactly as typed.
function panelSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string') return null;
  const clean = sanitizeCapture({
    code: raw.code,
    language: typeof raw.language === 'string' ? raw.language : null,
    problemTitle: typeof raw.problemTitle === 'string' ? raw.problemTitle : null,
    problemDescription: typeof raw.problemDescription === 'string' ? raw.problemDescription : null,
  });
  return clean;
}

// A message typed into the in-page panel (delivered by panel-bridge.js). It
// joins the same queue as terminal-typed messages and captures, and is echoed
// in the terminal under a [panel] label so the two views never diverge. The
// panel sends the live editor code with it when it could read it; without
// that the message goes with no code at all (a terminal message, which has no
// editor to read, uses the newest Run or Submit instead).
function handlePanelMessage(message) {
  resetScrollIfNeeded();
  // The relay already strips control characters from panel messages, but
  // this process is the one writing to the terminal, so it does not rely on
  // that (see sanitize.js).
  const text = stripControlChars(message.text).trim();
  const problemSlug = oneLine(message.problemSlug) || null;
  if (!text) return;
  const snapshot = panelSnapshot(message.snapshot);
  if (problemSlug) panelProblemSlug = problemSlug;
  panelPublish({ type: 'user', text, problemSlug: panelProblemSlug });
  const label = dim(`[panel] ${text}`);
  const releaseBusy = holdBusy();
  queueTurn(async () => {
    if (!problemSlug) {
      await sendChatTurn({ label, text, problemId: ledger.activeProblemId });
      return;
    }
    // A message from another problem than the active one resets the tutor
    // (see activateProblem), and the tutor is told which problem is on screen.
    const { previousId } = activateProblem(problemSlug, problemSlug);
    if (snapshot) {
      ledger.record(problemSlug, {
        code: snapshot.code,
        language: snapshot.language,
        slug: problemSlug,
        context: {
          problemId: problemSlug,
          title: snapshot.problemTitle || problemSlug,
          slug: problemSlug,
          description:
            snapshot.problemDescription && snapshot.problemDescription.trim() ? snapshot.problemDescription : null,
        },
      });
    }
    const codeUnavailable = !snapshot;
    const preamble = () => {
      const notes = [];
      if (previousId !== problemSlug) notes.push(`(The student is now working on the LeetCode problem "${problemSlug}".)`);
      if (codeUnavailable) notes.push("(The student's editor could not be read, so their current code is not included.)");
      return notes.length ? notes.join('\n') : null;
    };
    await sendChatTurn({ label, text, problemId: problemSlug, preamble, codeUnavailable });
  }).finally(releaseBusy);
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
  // Captures from before this start are not needed (an unread tail after the
  // saved offset still is, and stays).
  captureTrimWanted = true;
  while (!stopping) {
    try {
      if (captureTrimWanted || offset > CAPTURE_LOG_TRIM_BYTES) {
        // eslint-disable-next-line no-await-in-loop
        await trimHandledCaptures();
      }
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

// SIGHUP is what a terminal sends when its window is closed. Node's default
// for it ends the process without running 'exit' handlers, which left the
// relay server this companion started running (and holding its port) after
// the window was gone.
// Run by the helper, there is no terminal to close: SIGHUP is ignored, and
// the helper's SIGTERM or closed stdin ends this process.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (sig === 'SIGHUP' && HEADLESS) return;
    rl.close();
  });
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

// --- settings from the extension's options page ----------------------------
//
// The options page calls settings-rpc.js through the relay (POST
// /settings/rpc, forwarded down the inbox stream; see panel-bridge.js). A
// save is validated and a backend is built from it before anything is
// written, then applySettings swaps it in.

// The non-secret summary of what the tutor runs on, for the panel's header.
function publishConfig() {
  if (panelBridge) panelBridge.setConfig(statusSummary(effective));
}

// What a backend is built from; when none of it changed (only an option such
// as the vault auto-summary did), the running backend and its conversation
// are kept.
function backendKey(config) {
  return JSON.stringify([
    config.provider,
    config.model,
    config.baseUrl,
    config.apiKey,
    config.contextTokens,
    config.options.localMaxHistoryTurns,
  ]);
}

// Swaps in a saved configuration through the turn queue, so it lands between
// turns and never in the middle of one (a message queued after the save goes
// to the new backend). The new backend holds nothing, so the code the tutor
// held is forgotten and the next message carries the full code. Not awaited
// by the save itself: the options page hears "saved" at once even while a
// long reply is still running.
function applySettings(nextEffective, nextBackend) {
  queueTurn(async () => {
    const swap = backendKey(nextEffective) !== backendKey(effective);
    effective = nextEffective;
    if (swap) {
      backend = nextBackend;
      ledger.forgetHeld();
    }
    const now = statusSummary(effective);
    printAboveInput(
      dim(
        `companion: settings saved - ${swap ? 'now using' : 'still using'} ${now.label}${
          now.model ? ` (${oneLine(now.model)})` : ''
        }${swap ? ', starting a fresh tutor session' : ''}`
      )
    );
    publishConfig();
  }).catch((err) => {
    printAboveInput(dim(`companion: error applying settings: ${err.message}`));
  });
}

const settingsRpc = createSettingsRpc({
  file: SETTINGS_FILE,
  env: process.env,
  getStored: () => storedSettings,
  setStored: (next) => {
    storedSettings = next;
  },
  buildBackend: (config) => makeBackend(config),
  apply: applySettings,
  validateVault: () => validateVaultPath(VAULT_PATH),
});

// For the idle exit: whether the panel bridge's inbox stream to the relay is
// up, and when it last was.
let relayConnected = false;
let relayLastSeen = Date.now();
function noteRelayState(state) {
  if (relayConnected) relayLastSeen = Date.now();
  relayConnected = state === 'connected';
  if (relayConnected) relayLastSeen = Date.now();
}

await ensureRelayServer();

if (PANEL_ENABLED) {
  let announced = false;
  panelBridge = createPanelBridge({
    baseUrl: `http://${RELAY_HOST}:${RELAY_PORT}`,
    onMessage: handlePanelMessage,
    onRpc: (method, params) => settingsRpc.handle(method, params),
    onState: (state) => {
      noteRelayState(state);
      if (state === 'connected' && !announced) {
        announced = true;
        printAboveInput(dim('companion: in-page panel connected (the Tutor tab on leetcode.com)'));
      } else if (state === 'unsupported') {
        printAboveInput(
          dim('companion: warning: the running relay server predates the in-page panel; restart it to enable the Tutor tab')
        );
      }
    },
  });
  panelBridge.start();
  publishConfig();
  if (IDLE_EXIT_MS > 0) {
    setInterval(() => {
      if (relayConnected || Date.now() - relayLastSeen < IDLE_EXIT_MS) return;
      printAboveInput(dim(`companion: nothing heard from the relay for ${Math.round(IDLE_EXIT_MS / 1000)} s, exiting`));
      rl.close();
    }, Math.min(IDLE_EXIT_MS, 10000)).unref();
  }
  process.on('exit', () => panelBridge.stop());
}

{
  const active = statusSummary(effective);
  printBanner(
    dim(`companion: backend=${active.provider} (${active.label})${active.model ? ` model=${oneLine(active.model)}` : ''}`)
  );
  if (loadedSettings.warning) printBanner(dim(`companion: warning: settings: ${oneLine(loadedSettings.warning)}`));
}
printBanner(dim(`companion: watching ${CAPTURES_PATH} (starting offset=${offset})`));
printBanner(
  dim(
    effective.options.vaultAutoSummary
      ? `companion: vault auto-summary ON - writing to ${VAULT_PATH}`
      : 'companion: vault auto-summary off (turn it on in the Tutor settings, or set VAULT_AUTO_SUMMARY=1)'
  )
);
printBanner(
  dim(
    effective.options.autoClearContext
      ? 'companion: auto-clear-context ON - a message, Run or Submit on a different problem resets the tutor session (set COMPANION_AUTO_CLEAR_CONTEXT=0 to disable)'
      : 'companion: auto-clear-context off (COMPANION_AUTO_CLEAR_CONTEXT=0)'
  )
);
printBanner(
  dim('companion: type to chat directly; a changed Submit goes to the tutor, a Run waits for your next message. Page Up for history, /exit to quit.')
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
