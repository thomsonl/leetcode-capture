// companion/terminal-format.js - color/prompt styling and markdown rendering
// for companion.js's terminal output.
//
// Deliberately isolated from companion.js so the styling decision (TTY or
// not, NO_COLOR or not) is made in exactly one place, computed once at
// import time, and every exported helper already honors it internally - no
// caller needs its own isTTY branch. This also keeps companion.js's own
// stdout-vs-pipe branch (printAboveInput) untouched: it still just receives
// an opaque string to print, whether or not that string carries ANSI codes.
//
// Why the styling decision is made ourselves rather than left to chalk's or
// marked-terminal's own auto-detection: this environment sometimes runs
// with FORCE_COLOR set even when stdout is a plain pipe (confirmed via
// `node -e '...' | cat` still reporting chalk level 3), which would defeat
// the "stay plain in pipes" requirement if we trusted ambient detection.
// process.stdout.isTTY is checked directly instead, plus the NO_COLOR
// (https://no-color.org) convention.

import { Chalk } from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

export function stylingEnabled(stream = process.stdout) {
  return Boolean(stream && stream.isTTY) && !process.env.NO_COLOR;
}

const enabled = stylingEnabled();

// Forced to level 1 (standard 16-color ANSI) rather than left to chalk's own
// ambient detection - readable on both light and dark backgrounds without
// depending on truecolor support, and avoids the FORCE_COLOR quirk noted
// above ever leaking a color decision we didn't intend.
const c = new Chalk({ level: enabled ? 1 : 0 });

if (enabled) {
  marked.use(
    markedTerminal({
      width: process.stdout.columns || 80,
      reflowText: false,
    })
  );
}

// De-emphasizes companion's own status/system lines (startup banner, relay
// server lifecycle, warnings, errors) relative to actual conversation
// content. A no-op string pass-through when styling is off.
export function dim(text) {
  return enabled ? c.dim(text) : text;
}

const ROLE_STYLES = {
  you: (text) => c.cyanBright.bold(text),
  tutor: (text) => c.magentaBright.bold(text),
};

// A short, styled role label ("you", "tutor"). Returns '' when styling is
// off - callers must skip adding the label line entirely in that case
// rather than printing an empty line, so non-TTY output stays byte-for-byte
// what it was before this label existed (see companion.js's sendAndPrint).
export function roleLabel(role) {
  if (!enabled) return '';
  const style = ROLE_STYLES[role];
  return style ? style(role) : role;
}

// The readline prompt string. Plain '> ' when styling is off, matching the
// prompt this program has always used.
export function promptString() {
  return enabled ? `${c.cyanBright.bold('you')} ${c.dim('›')} ` : '> ';
}

// Renders markdown (headers, bold/emphasis, lists, fenced code blocks with
// syntax highlighting) to ANSI-styled text for a real TTY. Returns the text
// unchanged when styling is off, so piped output keeps showing the raw
// markdown exactly as before this feature existed.
export function renderMarkdown(text) {
  if (!enabled) return text;
  // marked-terminal pads block elements with blank lines; collapse runs of
  // 3+ into a single blank line and trim trailing whitespace so replies
  // don't accumulate extra vertical space compared to before.
  return marked.parse(text).replace(/\n{3,}/g, '\n\n').trimEnd();
}

// --- streaming reply support -------------------------------------------
//
// Phase 2 of the CLI look (phase 1, above: colored role/prompt styling and
// one-shot markdown rendering). Two pieces: framing a reply turn's start
// and end with a role-labeled rule so consecutive turns don't visually run
// together, and rendering markdown safely as it streams in rather than only
// once a reply is fully done. companion.js owns *when* a turn starts/ends
// and how each piece reaches the terminal (it has the readline instance);
// this module only owns what each piece looks like.

// Terminal width to frame against, capped well below a very wide terminal -
// a rule that stretches the full width of an ultrawide window reads as a
// wall, not a frame.
function frameWidth() {
  const cols = process.stdout.columns || 80;
  return Math.max(20, Math.min(cols, 100));
}

// A horizontal rule with a role label cut into it, e.g. "── tutor ─────...",
// opening one reply turn. '' when styling is off, same convention as
// roleLabel - callers must skip the frame entirely rather than print an
// empty line.
export function frameTop(role) {
  if (!enabled) return '';
  const width = frameWidth();
  const label = roleLabel(role) || role;
  const tail = '─'.repeat(Math.max(1, width - role.length - 4));
  return `${c.dim('── ')}${label}${c.dim(` ${tail}`)}`;
}

// The matching closing rule, printed once a reply turn finishes. '' when
// styling is off.
export function frameBottom() {
  if (!enabled) return '';
  return c.dim('─'.repeat(frameWidth()));
}

// One frame of the "waiting for the backend" spinner, cycling through
// SPINNER_FRAME_COUNT frames on request - callers own the timing
// (setInterval) and where each frame is drawn, since that needs readline
// coordination this module doesn't have. Plain, unstyled text when styling
// is off (companion.js's spinner is itself a no-op in that case, but the
// frame text stays meaningful if ever printed directly, e.g. in a test).
const SPINNER_GLYPHS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_FRAME_COUNT = SPINNER_GLYPHS.length;
export function spinnerFrame(i) {
  const glyph = SPINNER_GLYPHS[((i % SPINNER_GLYPHS.length) + SPINNER_GLYPHS.length) % SPINNER_GLYPHS.length];
  const text = `${glyph} thinking`;
  return enabled ? c.dim(text) : text;
}

// Feeds a reply in incrementally, rendering complete markdown as soon as a
// safe boundary is reached: a blank line outside a fenced code block, or the
// close of a fenced code block itself. Never mid-fence, never mid-block -
// marked-terminal renders those as broken/uncoloured text. push() returns
// text ready to print now ('' if nothing new is complete yet); finish()
// flushes whatever's left once the stream ends, complete or not (the common
// case: a reply's last block has no trailing blank line).
//
// When styling is off, this is a pure pass-through - each push() returns
// its chunk unchanged, finish() has nothing left to flush - since raw
// markdown is never rendered either way (see renderMarkdown above), the
// same as a non-streaming reply already looks over a pipe.
export function createMarkdownStreamer() {
  if (!enabled) {
    return { push: (chunk) => chunk, finish: () => '' };
  }

  let buffer = '';

  return {
    push(chunk) {
      buffer += chunk;
      const splitAt = findSafeSplit(buffer);
      if (splitAt <= 0) return '';
      const complete = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt);
      return renderMarkdown(complete);
    },
    finish() {
      if (!buffer) return '';
      const rendered = renderMarkdown(buffer);
      buffer = '';
      return rendered;
    },
  };
}

// Single left-to-right scan tracking fenced-code-block open/close state,
// returning the end index of the latest position it's safe to cut at:
// right after a closing fence's own line, or a blank line encountered while
// not inside an open fence. -1 if no such point exists yet. A plain scan
// rather than a regex split specifically so an odd/open fence count is
// tracked incrementally and blank lines inside it are correctly ignored.
function findSafeSplit(text) {
  let fenceCount = 0;
  let lastSafe = -1;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      fenceCount += 1;
      i += 3;
      if (fenceCount % 2 === 0) {
        const lineEnd = text.indexOf('\n', i);
        if (lineEnd !== -1) lastSafe = lineEnd + 1;
      }
      continue;
    }
    if (fenceCount % 2 === 0 && text.startsWith('\n\n', i)) {
      lastSafe = i + 2;
    }
    i += 1;
  }
  return lastSafe;
}
