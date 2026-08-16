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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareVaultContext, extractVaultBlock, writeVaultAutoSummary, defaultVaultPath } from './vault-summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// --- config ---------------------------------------------------------------

const BACKEND = process.env.COMPANION_BACKEND || 'claude';
const MODEL = process.env.COMPANION_MODEL || null;
const BASE_URL = process.env.COMPANION_BASE_URL || 'http://localhost:11434/v1';
const API_KEY = process.env.COMPANION_API_KEY || null;

// Off by default: a portable checkout of this repo for someone other than
// Thomson won't have this vault's Study/Algorithms structure, or even use
// Obsidian. Thomson turns this on in his own untracked environment. See the
// "Vault auto-summary" section below and README.md for what it does.
const VAULT_AUTO_SUMMARY = /^(1|true|yes)$/i.test(process.env.VAULT_AUTO_SUMMARY || '');
const VAULT_PATH = process.env.VAULT_PATH || defaultVaultPath();

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

// Local-backend-only style addendum: two of Thomson's general writing-style
// preferences (from his global agent instructions) that are actually about
// what the model says out loud, unlike the rest of that file which is
// engineering-workflow guidance that doesn't apply to a chat companion. The
// Claude backend already inherits these independently from Thomson's real
// global Claude preferences, so they're kept separate here rather than
// folded into the shared TUTOR_SYSTEM_PROMPT above.
const LOCAL_STYLE_ADDENDUM = `Two additional style rules for your responses:
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

  async sendMessage(text) {
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
    const options = { cwd: SCRATCH_DIR, systemPrompt: TUTOR_SYSTEM_PROMPT };
    if (this.model) options.model = this.model;
    if (this.sessionId) options.resume = this.sessionId;

    let resultText = null;
    let errorNote = null;
    for await (const message of this.queryFn({ prompt: text, options })) {
      if (message.session_id) this.sessionId = message.session_id;
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
    if (resultText !== null) return resultText;
    throw new Error(errorNote || 'no result message received from the Agent SDK');
  }
}

class LocalBackend {
  constructor({ baseUrl, model, apiKey }) {
    if (!model) {
      throw new Error(
        'COMPANION_MODEL is required for COMPANION_BACKEND=local (e.g. COMPANION_MODEL=llama3.2)'
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
    // Standard OpenAI chat-completions shape: a leading `role: 'system'`
    // message, resent in full on every turn along with the rest of history.
    // Local-backend-only: append the style addendum (see LOCAL_STYLE_ADDENDUM).
    this.history = [{ role: 'system', content: `${TUTOR_SYSTEM_PROMPT}\n\n${LOCAL_STYLE_ADDENDUM}` }];
  }

  async sendMessage(text) {
    this.history.push({ role: 'user', content: text });

    let response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, messages: this.history }),
      });
    } catch (err) {
      this.history.pop(); // don't leave a dangling user turn with no reply
      throw new Error(`could not reach ${this.baseUrl} (${err.message})`);
    }

    if (!response.ok) {
      this.history.pop();
      const bodyText = await response.text().catch(() => '');
      throw new Error(`local backend request failed: ${response.status} ${response.statusText} ${bodyText}`);
    }

    const data = await response.json();
    const replyText = data?.choices?.[0]?.message?.content ?? '';
    this.history.push({ role: 'assistant', content: replyText });
    return replyText;
  }
}

function makeBackend() {
  if (BACKEND === 'claude') return new ClaudeBackend({ model: MODEL });
  if (BACKEND === 'local') return new LocalBackend({ baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY });
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
  console.log('companion: relay server not detected, starting it now');

  // Wait (bounded) for it to actually come up, so the very first capture
  // isn't lost to a race between spawning it and its listen() callback.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await isRelayServerUp()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  console.error(
    `companion: warning: started the relay server but it hasn't answered on http://${RELAY_HOST}:${RELAY_PORT} yet - continuing anyway`
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
// Thomson is mid-way through typing a line. Node's readline has no built-in
// "print without disturbing the current input line" call, so printAboveInput
// saves the in-progress line + cursor, clears the rendered prompt, prints the
// new text, then redraws the prompt with the saved line reinserted. Both
// captures and normal replies to typed input go through this same path.

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
let stopping = false;

function printAboveInput(text) {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (!process.stdout.isTTY) {
    process.stdout.write(body);
    return;
  }
  const savedLine = rl.line;
  const savedCursor = rl.cursor;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(body);
  rl.prompt(true);
  if (savedLine) {
    rl.write(savedLine);
    if (savedCursor < savedLine.length) {
      readline.moveCursor(process.stdout, -(savedLine.length - savedCursor), 0);
    }
  }
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

// onReply, when given, runs on the raw reply before it's printed and may
// return a transformed string - used by handleCaptureLine to peel the vault
// auto-summary's JSON block back off a Submit reply (see extractVaultBlock)
// before it ever reaches the terminal.
function sendAndPrint(label, text, { onReply } = {}) {
  return enqueue(async () => {
    let reply;
    try {
      reply = await backend.sendMessage(text);
    } catch (err) {
      printAboveInput(`${label ? `${label}\n` : ''}companion: error talking to backend (${BACKEND}): ${err.message}`);
      return;
    }
    const displayText = onReply ? onReply(reply) : reply;
    printAboveInput(`${label ? `${label}\n` : ''}${displayText}`);
  });
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }
  if (text === '/exit' || text === '/quit') {
    rl.close();
    return;
  }
  sendAndPrint(null, text);
});

rl.on('close', () => {
  stopping = true;
  process.stdout.write('\ncompanion: goodbye\n');
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
      console.error(`companion: warning: could not read state file (${err.message}); starting fresh`);
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
  const trimmed = line.trim();
  if (!trimmed) return;
  let capture;
  try {
    capture = JSON.parse(trimmed);
  } catch (err) {
    printAboveInput(`companion: warning: skipping malformed capture JSON: ${err.message}`);
    return;
  }
  const label = `[capture] ${triggerLabel(capture.trigger)} - ${capture.problemTitle || capture.problemSlug || 'unknown'} (attempt ${capture.attemptSeq ?? '?'})`;

  // Only Submits (not Runs) drive the vault auto-summary, and only when the
  // toggle is on - see the "vault auto-summary" section above. When active,
  // one extra instruction is appended to the same message so the single
  // reply carries both the tutoring commentary and the structured vault
  // data; no second LLM call.
  let vaultContext = null;
  if (VAULT_AUTO_SUMMARY && capture.trigger === 'submit') {
    try {
      vaultContext = prepareVaultContext({ capture, vaultPath: VAULT_PATH });
    } catch (err) {
      printAboveInput(`companion: warning: could not prepare vault auto-summary context (${err.message})`);
    }
  }
  const message = formatCaptureMessage(capture) + (vaultContext ? vaultContext.addendum : '');

  await sendAndPrint(label, message, {
    onReply: vaultContext
      ? (reply) => {
          const { displayText, vaultData } = extractVaultBlock(reply, {
            warn: (msg) => printAboveInput(`companion: warning: ${msg}`),
          });
          if (vaultData) {
            try {
              writeVaultAutoSummary({ capture, vaultContext, vaultData });
            } catch (err) {
              printAboveInput(`companion: warning: vault auto-summary write failed (${err.message})`);
            }
          } else {
            printAboveInput('companion: warning: vault auto-summary was on but the reply had no vault data block; skipping this write');
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
    printAboveInput('companion: capture log shrank; resetting offset to 0');
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
      printAboveInput(`companion: error during capture poll: ${err.stack || err.message}`);
    }
    if (stopping) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => rl.close());
}

await ensureRelayServer();

console.log(`companion: backend=${BACKEND}${MODEL ? ` model=${MODEL}` : ''}`);
console.log(`companion: watching ${CAPTURES_PATH} (starting offset=${offset})`);
console.log(
  VAULT_AUTO_SUMMARY
    ? `companion: vault auto-summary ON - writing to ${VAULT_PATH}`
    : 'companion: vault auto-summary off (set VAULT_AUTO_SUMMARY=1 to enable)'
);
console.log('companion: type to chat directly; captures are injected automatically. /exit to quit.');
rl.prompt();

pollLoop().catch((err) => {
  console.error(`companion: fatal: ${err.stack || err.message}`);
  process.exit(1);
});
