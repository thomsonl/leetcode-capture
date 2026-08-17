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
