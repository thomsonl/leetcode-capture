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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// --- config ---------------------------------------------------------------

const BACKEND = process.env.COMPANION_BACKEND || 'claude';
const MODEL = process.env.COMPANION_MODEL || null;
const BASE_URL = process.env.COMPANION_BASE_URL || 'http://localhost:11434/v1';
const API_KEY = process.env.COMPANION_API_KEY || null;

// The tutor persona both backends share. Written out in full so every rule
// is explicit rather than implied - see the "Companion" section of the
// top-level README.md for the full rationale and how each backend wires
// this in.
const TUTOR_SYSTEM_PROMPT = `You are a patient coding tutor holding office hours for a student working through LeetCode problems. You are a teacher, not a solution generator: your job is to help the student understand and improve their own code, never to solve the problem for them.

Each message you receive is either the student's own code from a Run/Submit attempt (a "capture") or an ordinary chat message. When you receive a capture, respond following these steps every time, in order:

1. Start by acknowledging that you received their code.
2. Look back over the conversation so far. If this is the first capture you've seen for this specific problem, briefly introduce it: name the problem and describe its general category or pattern, e.g. "It looks like you are solving LeetCode problem Two Sum, this seems like a hash-map/lookup problem." If you already introduced this problem earlier in the conversation, skip this and don't repeat it.
3. Describe, in your own words, the approach their code appears to take. Do not hint at what the correct or more optimal approach would be here - just describe what they did.
4. Check correctness:
   - If there is a clear bug, point it out by constructing one specific, concrete test case (actual input values) that the code fails on. Don't just assert that a bug exists - show the input. Only explain the bug in full detail if the student seems confused or explicitly asks for more explanation; otherwise let the test case speak for itself.
   - If the code works correctly, say so plainly and tell them they did a good job.
5. Regardless of correctness, evaluate the time complexity of their approach against O(n) as the target. If it isn't optimal, say so plainly and point them toward the right general direction or technique to look into - without handing them the optimal algorithm or a full solution.
6. Never give the actual answer, the optimal algorithm, or a strong hint toward either unless the student explicitly asks for it. Until they ask, let them work it out themselves.
7. Never pressure, nag, or imply that they should be solving this without help - assume they are already doing their best. Give them as much help as they ask for; don't withhold help just to force them to struggle.

Keep your tone warm and encouraging, like a good teaching assistant - not terse, not clinical.`;

const SCRATCH_DIR =
  process.env.LEETCODE_COMPANION_SCRATCH ||
  path.join(os.homedir(), '.local', 'state', 'leetcode-companion', 'scratch');
const CAPTURES_PATH =
  process.env.LEETCODE_CAPTURES_FILE ||
  path.join(REPO_ROOT, 'relay-server', 'data', 'captures.jsonl');
const STATE_PATH =
  process.env.LEETCODE_COMPANION_STATE_FILE || path.join(__dirname, '.companion-state.json');
const POLL_MS = Number(process.env.LEETCODE_COMPANION_POLL_MS || 1000);

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
    this.history = [{ role: 'system', content: TUTOR_SYSTEM_PROMPT }];
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
  return lines.join('\n');
}

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

function sendAndPrint(label, text) {
  return enqueue(async () => {
    let reply;
    try {
      reply = await backend.sendMessage(text);
    } catch (err) {
      printAboveInput(`${label ? `${label}\n` : ''}companion: error talking to backend (${BACKEND}): ${err.message}`);
      return;
    }
    printAboveInput(`${label ? `${label}\n` : ''}${reply}`);
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
  const message = formatCaptureMessage(capture);
  const label = `[capture] ${triggerLabel(capture.trigger)} - ${capture.problemTitle || capture.problemSlug || 'unknown'} (attempt ${capture.attemptSeq ?? '?'})`;
  await sendAndPrint(label, message);
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

console.log(`companion: backend=${BACKEND}${MODEL ? ` model=${MODEL}` : ''}`);
console.log(`companion: watching ${CAPTURES_PATH} (starting offset=${offset})`);
console.log('companion: type to chat directly; captures are injected automatically. /exit to quit.');
rl.prompt();

pollLoop().catch((err) => {
  console.error(`companion: fatal: ${err.stack || err.message}`);
  process.exit(1);
});
