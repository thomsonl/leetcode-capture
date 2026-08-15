#!/usr/bin/env node
// companion/watch.js - tail relay-server/data/captures.jsonl and inject each
// new capture into the companion's tmux pane as a chat message, as if
// Thomson had typed and submitted it himself.
//
// The companion tmux session (companion/start.sh) runs a real interactive
// `claude` process attached to a terminal. This script never touches that
// process's stdin directly - it only drives tmux from the outside (paste a
// buffer into the pane, then send Enter), so the pane stays fully usable for
// direct interactive typing at any time, including while this watcher is
// running.
//
// State: a small JSON file tracks the byte offset already processed, so
// restarting this script does not replay captures it already injected. On
// first-ever run (no state file), the current end of the log is treated as
// the starting point - this is a tail, not a backfill - so an existing
// history of captures does not get dumped into the chat all at once.
//
// No dependencies beyond Node's standard library and the `tmux` binary.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

const SESSION_NAME = process.env.LEETCODE_COMPANION_SESSION || 'leetcode-companion';
const CAPTURES_PATH =
  process.env.LEETCODE_CAPTURES_FILE ||
  path.join(REPO_ROOT, 'relay-server', 'data', 'captures.jsonl');
const STATE_PATH =
  process.env.LEETCODE_COMPANION_STATE_FILE || path.join(__dirname, '.watch-state.json');
const POLL_MS = Number(process.env.LEETCODE_COMPANION_POLL_MS || 1000);
const RUN_ONCE = process.argv.includes('--once');

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadOffset() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.offset === 'number' && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`companion/watch.js: warning: could not read state file (${err.message}); starting fresh`);
    }
  }
  // No usable state: this is effectively a first run. Start at the current
  // end of the log (if it exists) so we tail forward, not replay history.
  try {
    const stats = fs.statSync(CAPTURES_PATH);
    return stats.size;
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
console.error(`companion/watch.js: watching ${CAPTURES_PATH} (session=${SESSION_NAME}, starting offset=${offset})`);

// --- formatting -------------------------------------------------------

function triggerLabel(trigger) {
  if (trigger === 'run') return 'Run';
  if (trigger === 'submit') return 'Submit';
  return trigger || 'unknown trigger';
}

function formatMessage(capture) {
  const title = capture.problemTitle || capture.problemSlug || '(unknown problem)';
  const slug = capture.problemSlug || 'unknown-slug';
  const language = capture.language || 'unknown language';
  const label = triggerLabel(capture.trigger);
  const code = typeof capture.code === 'string' ? capture.code : '';
  const description = typeof capture.problemDescription === 'string' ? capture.problemDescription : null;
  const fence = '```';

  const lines = [
    `[LeetCode capture] ${label} - ${title} (${slug})`,
    `Language: ${language}`,
  ];
  if (description) {
    lines.push('', 'Problem:', description);
  }
  lines.push(
    '',
    `${fence}${languageFenceHint(language)}`,
    code,
    fence,
  );
  return lines.join('\n');
}

// Best-effort hint for the markdown fence's language tag. Falls back to no
// hint rather than guessing wrong.
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

// --- tmux injection -----------------------------------------------------

async function sessionExists() {
  try {
    await execFileP('tmux', ['has-session', '-t', SESSION_NAME]);
    return true;
  } catch {
    return false;
  }
}

// Inject `text` into the companion's tmux pane as if it had been pasted and
// then submitted with Enter.
//
// Naively `tmux send-keys` of a raw multi-line string sends each embedded
// newline as its own Enter keystroke, which would submit the message after
// its first line and mangle any indentation-sensitive code. Instead this
// loads the text into a tmux paste buffer and pastes it as one unit
// (`load-buffer` + `paste-buffer`): tmux's paste-buffer wraps the content in
// bracketed-paste escapes when the destination program has requested
// bracketed paste (an interactive `claude` session does), so the receiving
// line editor treats embedded newlines as literal characters inserted into
// the input, not as submits - line breaks and indentation survive intact.
// Enter is then sent as one separate, real keystroke to submit the whole
// pasted message.
async function injectIntoTmux(text) {
  const tmpFile = path.join(
    os.tmpdir(),
    `leetcode-companion-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  const bufferName = `leetcode-companion-${Date.now()}`;
  fs.writeFileSync(tmpFile, text, 'utf8');
  try {
    await execFileP('tmux', ['load-buffer', '-b', bufferName, tmpFile]);
    try {
      await execFileP('tmux', ['paste-buffer', '-d', '-b', bufferName, '-t', SESSION_NAME]);
    } catch (err) {
      // paste-buffer failed - make sure we don't leak the named buffer.
      await execFileP('tmux', ['delete-buffer', '-b', bufferName]).catch(() => {});
      throw err;
    }
    // Give the composer a beat to finish rendering the pasted text before
    // Enter submits it - matters for longer code blocks.
    await sleep(400);
    await execFileP('tmux', ['send-keys', '-t', SESSION_NAME, 'Enter']);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let capture;
  try {
    capture = JSON.parse(trimmed);
  } catch (err) {
    console.error(`companion/watch.js: warning: skipping malformed JSON line: ${err.message}`);
    return;
  }

  const message = formatMessage(capture);

  if (!(await sessionExists())) {
    console.error(
      `companion/watch.js: warning: tmux session '${SESSION_NAME}' is not running (run companion/start.sh); dropping capture for ${capture.problemSlug || 'unknown'}`
    );
    return;
  }

  try {
    await injectIntoTmux(message);
    console.error(
      `companion/watch.js: injected ${triggerLabel(capture.trigger)} capture for ${capture.problemSlug || 'unknown'} (attemptSeq=${capture.attemptSeq ?? '?'})`
    );
  } catch (err) {
    console.error(`companion/watch.js: error: failed to inject capture into tmux: ${err.message}`);
  }
}

// --- tailing --------------------------------------------------------------

// Reads any newly-appended, *complete* lines since `offset`, processes them
// in order, and advances/persists `offset` only past bytes that formed
// complete lines. An in-progress partial line (the writer mid-append) is
// left unconsumed and picked up whole on the next poll.
async function poll() {
  let stats;
  try {
    stats = fs.statSync(CAPTURES_PATH);
  } catch {
    return; // log file doesn't exist yet - nothing to do
  }

  if (stats.size < offset) {
    // File was truncated or replaced (e.g. rotated) - restart from the top.
    console.error('companion/watch.js: capture log shrank; resetting offset to 0');
    offset = 0;
  }

  if (stats.size <= offset) return; // nothing new

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
  const consumedBytes = Buffer.byteLength(complete, 'utf8') + 1; // + the newline itself
  const lines = complete.split('\n');

  for (const line of lines) {
    // eslint-disable-next-line no-await-in-loop
    await handleLine(line);
  }

  offset += consumedBytes;
  saveOffset(offset);
}

let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await poll();
    } catch (err) {
      console.error(`companion/watch.js: error during poll: ${err.stack || err.message}`);
    }
    if (RUN_ONCE) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    process.exit(0);
  });
}

loop().catch((err) => {
  console.error(`companion/watch.js: fatal: ${err.stack || err.message}`);
  process.exit(1);
});
