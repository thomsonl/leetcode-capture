// companion/codex-backend.js - tutor backend for a ChatGPT subscription,
// driven through OpenAI's Codex CLI.
//
// OpenAI has no public API for a ChatGPT plan, but the Codex CLI signs in with
// one ("codex login") and `codex exec` runs a single non-interactive turn that
// reuses that saved sign-in. This backend shells out to it, one process per
// turn, the same way ClaudeBackend rides the Claude Code sign-in.
//
// Reference (OpenAI's non-interactive mode docs): the prompt is read from stdin
// when the argument is `-`; `--json` turns stdout into JSON Lines whose
// `item.completed` events carry `item.type === "agent_message"` with a `text`;
// `turn.failed` and `error` events carry failures; `--sandbox read-only`,
// `--skip-git-repo-check`, `--ephemeral` and `-C <dir>` keep it from touching
// anything. The tutor needs none of Codex's agent tooling, so it runs in an
// empty scratch directory with a read-only sandbox.
//
// Experimental: Codex is a coding agent, so its own instructions sit under the
// tutor prompt this backend sends; and unlike the other backends there is no
// token streaming (a reply arrives whole).
//
// `codex` is spawned per turn and sees the whole conversation each time
// (--ephemeral keeps no session), so this backend keeps its own bounded
// history like LocalBackend does: past `maxHistoryTurns` exchanges, the older
// ones are condensed into one short summary (context-summary.js) by one extra
// codex call, or a deterministic digest when that call fails.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { buildMessages } from './context-budget.js';
import { formatPinnedCode } from './code-ledger.js';
import { SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS, condense, condenseCount, summaryBodyChars } from './context-summary.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_STDERR_CHARS = 2000;

// Environment variables that would make codex bill an API key instead of the
// ChatGPT sign-in the user picked this provider for.
const API_KEY_ENV = ['CODEX_API_KEY', 'OPENAI_API_KEY'];

export function codexSubscriptionEnv(env = process.env) {
  const out = { ...env };
  for (const name of API_KEY_ENV) delete out[name];
  return out;
}

export function buildCodexArgs({ model, cwd }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', cwd];
  if (model) args.push('-m', model);
  args.push('-'); // read the prompt from stdin
  return args;
}

// Pulls the reply out of codex's JSON Lines output. Returns { text, error }.
export function parseCodexOutput(stdout) {
  let text = null;
  let error = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      text = event.item.text;
    } else if (event.type === 'turn.failed') {
      error = (event.error && event.error.message) || 'the turn failed';
    } else if (event.type === 'error' && !error) {
      error = event.message || (event.error && event.error.message) || 'codex reported an error';
    }
  }
  return { text, error };
}

export class CodexBackend {
  constructor({
    model = null,
    cwd,
    systemPrompt,
    maxHistoryTurns = 6,
    command = 'codex',
    commandArgs = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    summaryTimeoutMs = SUMMARY_TIMEOUT_MS,
    env = process.env,
  }) {
    if (!cwd) throw new Error('CodexBackend needs a scratch directory (cwd)');
    this.model = model;
    this.cwd = cwd;
    this.systemPrompt = systemPrompt;
    this.maxHistoryTurns = maxHistoryTurns;
    this.command = command;
    this.commandArgs = commandArgs;
    this.timeoutMs = timeoutMs;
    this.summaryTimeoutMs = summaryTimeoutMs;
    this.env = env;
    this.history = []; // [{ role: 'student' | 'tutor', text, compactText? }]
    this.pinnedProblemContext = null;
    // The code the tutor holds (see code-ledger.js), pinned like the problem
    // statement so dropping the old turn that carried the full code never
    // loses it; later turns only carry diffs against it. `{ text }` or null.
    this.pinnedCode = null;
    // The "earlier in this session" summary of condensed exchanges, or null.
    this.summary = null;
  }

  resetContext() {
    this.history = [];
    this.pinnedProblemContext = null;
    this.pinnedCode = null;
    this.summary = null;
  }

  // The same pinning rules as LocalBackend (context-budget.js's
  // buildMessages): the statement and the held code come first, and an older
  // student turn whose code is now pinned is sent as its compact form.
  buildPrompt(text, { compactText } = {}) {
    const history = [
      { role: 'system', content: this.systemPrompt },
      ...this.history.map((h) => ({
        role: h.role === 'student' ? 'user' : 'assistant',
        content: h.text,
        ...(typeof h.compactText === 'string' ? { compactContent: h.compactText } : {}),
      })),
      { role: 'user', content: text, ...(typeof compactText === 'string' ? { compactContent: compactText } : {}) },
    ];
    const messages = buildMessages({
      history,
      pinnedProblemContext: this.pinnedProblemContext,
      pinnedCode: this.pinnedCode,
      summary: this.summary,
    });
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const turns = messages.filter((m) => m.role !== 'system');
    const current = turns.pop();
    const parts = [...system];
    if (turns.length) {
      parts.push(
        `Conversation so far:\n\n${turns.map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content}`).join('\n\n')}`
      );
    }
    parts.push(`Student: ${current.content}\n\nReply now as the tutor, following the rules above. Do not run commands or read files.`);
    return parts.join('\n\n---\n\n');
  }

  // `heldCode` is the code the tutor held before this turn and `compactText`
  // what this turn becomes once its code is pinned instead (see
  // LocalBackend.sendMessage, which takes the same options).
  async sendMessage(text, { problemContext, heldCode, compactText } = {}) {
    if (problemContext?.description && (!this.pinnedProblemContext || problemContext.problemId !== this.pinnedProblemContext.problemId)) {
      this.pinnedProblemContext = problemContext;
    }
    const pinnedText = formatPinnedCode(heldCode);
    this.pinnedCode = pinnedText ? { text: pinnedText } : null;
    fs.mkdirSync(this.cwd, { recursive: true });
    await this.condenseIfNeeded();
    const prompt = this.buildPrompt(text, { compactText });
    const reply = await this.runCodex(prompt);
    this.history.push(
      { role: 'student', text, ...(typeof compactText === 'string' && compactText !== text ? { compactText } : {}) },
      { role: 'tutor', text: reply }
    );
    return reply;
  }

  // Past maxHistoryTurns exchanges, condenses the older ones (at least the
  // older half) into the summary instead of dropping them. Runs at the start
  // of a turn, inside the companion's turn queue, and prints nothing.
  async condenseIfNeeded() {
    const pairs = this.history.length / 2;
    if (!(this.maxHistoryTurns > 0) || pairs <= this.maxHistoryTurns) return;
    const k = condenseCount(pairs, pairs - this.maxHistoryTurns);
    const dropped = [];
    for (let i = 0; i < k; i += 1) {
      const student = this.history[2 * i];
      const tutor = this.history[2 * i + 1];
      const compact = Boolean(this.pinnedCode) && typeof student.compactText === 'string';
      dropped.push({ student: compact ? student.compactText : student.text, tutor: tutor.text });
    }
    const { summary } = await condense({
      existing: this.summary,
      dropped,
      maxChars: summaryBodyChars(SUMMARY_MAX_TOKENS),
      summarize: (messages) =>
        this.runCodex(
          `${messages.map((m) => m.content).join('\n\n---\n\n')}\n\nDo not run commands or read files.`,
          { timeoutMs: this.summaryTimeoutMs }
        ),
      timeoutMs: this.summaryTimeoutMs,
    });
    this.summary = summary;
    this.history = this.history.slice(2 * k);
  }

  runCodex(prompt, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const args = [...this.commandArgs, ...buildCodexArgs({ model: this.model, cwd: this.cwd })];
      const child = spawn(this.command, args, { env: codexSubscriptionEnv(this.env), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new Error(`codex did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString();
      });
      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          finish(
            reject,
            new Error('the Codex CLI was not found. Install it (npm install -g @openai/codex), then run "codex login" and choose ChatGPT')
          );
        } else {
          finish(reject, new Error(`could not start codex: ${err.message}`));
        }
      });
      child.on('close', (code) => {
        const { text, error } = parseCodexOutput(stdout);
        if (text && text.trim()) return finish(resolve, text);
        if (error) return finish(reject, new Error(`codex: ${error}`));
        const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
        return finish(
          reject,
          new Error(`codex exited with code ${code} and no reply${tail ? ` (${tail})` : ''}. Run "codex login" if you have not signed in`)
        );
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}

// `codex login status` exits 0 when signed in. Used by the options page's
// "Test connection" so a missing sign-in is explained before any tutor turn.
export function checkCodexLogin({ command = 'codex', commandArgs = [], env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, [...commandArgs, 'login', 'status'], { env: codexSubscriptionEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, message: err.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, message: 'codex login status did not answer' });
    }, timeoutMs);
    child.stdout.on('data', (c) => (output += c.toString()));
    child.stderr.on('data', (c) => (output += c.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        message: err.code === 'ENOENT' ? 'the Codex CLI was not found (npm install -g @openai/codex)' : err.message,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, message: output.trim().split('\n')[0] || (code === 0 ? 'signed in' : 'not signed in; run "codex login"') });
    });
  });
}
