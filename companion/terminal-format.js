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
import TerminalRenderer, { markedTerminal } from 'marked-terminal';

// marked-terminal's own listitem() only reflow-wraps a *loose* list item
// (one with a blank line between bullets - marked hands it 'paragraph'-type
// tokens): it forwards to marked's own Parser.parse(item.tokens,
// !!item.loose), and marked's Parser only routes a 'text'-type token
// through paragraph rendering - and therefore through reflowText - when
// that `top` flag is true (see marked's Parser.prototype.parse's "text"
// case). A *tight* item (the common case - no blank line between bullets,
// which is what an LLM's own list output almost always looks like) carries
// plain 'text' tokens instead, so with top=false its text comes out
// completely unwrapped; whatever line break then appears on screen is only
// the raw terminal's own hardware auto-wrap-at-column-N, which can land
// mid-word with zero hanging indent - confirmed live once PR #36 removed
// the old fixed-width cap and made a long single-sentence bullet an
// everyday occurrence rather than a rare edge case (see companion/AGENTS.md
// and the PR that added this fix for the live repro).
//
// Patched once here, directly on marked-terminal's shared
// TerminalRenderer.prototype (rather than inside configureMarkedTerminal
// below, which re-registers on every terminal resize - wrapping listitem()
// again on every one of those would stack redundant wrappers), by forcing
// every item to look "loose" to marked's Parser. Confirmed this doesn't
// change what's rendered for an already-loose item (identical either way)
// or for a tight *task*/checkbox item (whose tokens[0] is 'text' rather
// than the 'paragraph' the loose branch expects, so it falls through to the
// same unshift-a-checkbox-token behavior either way) - every other item
// just takes the same parser.parse(item.tokens, true) call a genuinely
// loose item's text already took, which is what actually turns reflowText
// on for it.
const originalListitem = TerminalRenderer.prototype.listitem;
TerminalRenderer.prototype.listitem = function (item) {
  if (item && typeof item === 'object' && !item.loose) {
    item = { ...item, loose: true };
  }
  return originalListitem.call(this, item);
};

export function stylingEnabled(stream = process.stdout) {
  return Boolean(stream && stream.isTTY) && !process.env.NO_COLOR;
}

const enabled = stylingEnabled();

// Forced to level 1 (standard 16-color ANSI) rather than left to chalk's own
// ambient detection - readable on both light and dark backgrounds without
// depending on truecolor support, and avoids the FORCE_COLOR quirk noted
// above ever leaking a color decision we didn't intend.
const c = new Chalk({ level: enabled ? 1 : 0 });

// Visual width of turnMarker()'s own text ('•' plus its one trailing space -
// see turnMarker below), ignoring ANSI codes: the bullet is a single-column
// glyph in a monospace terminal. This is the hanging-indent column every
// wrapped/continuation line of a turnMarker-led reply aligns under (see
// indentContinuation below), and also how much narrower marked-terminal's
// own reflow width needs to be so an indented line still fits the terminal
// instead of running TURN_MARKER_WIDTH columns past it.
const TURN_MARKER_WIDTH = 2;

// marked-terminal's own list rendering adds a further indent on top of
// whatever reflowText already wrapped a list item's text to: a tab-stop
// (marked-terminal's own default `tab` option, left unset here so it's 4)
// plus the bullet marker's own width (its internal BULLET_POINT constant,
// '* ' - 2 columns), applied to every line of a list via
// indentLines/bulletPointLines *after* reflow already ran - see
// marked-terminal's Renderer.prototype.list. Unlike TURN_MARKER_WIDTH
// above, neither of those is subtracted from the width reflowText wraps
// to, so a list item's own continuation line could still run past
// contentWidth() once that indent lands on top of an already
// maximally-reflowed line - confirmed live in a real 260-column tmux pane:
// a hyphenated word ("off-by-one", which reflowText correctly never
// splits internally - it isn't whitespace) landed exactly on that
// unaccounted overhang and got hard-split by the terminal's own hardware
// wrap instead, the exact same mid-word-break symptom this file's list-
// item reflow fix (below) exists to prevent. Covers exactly one level of
// list nesting - the common case an LLM reply actually produces; a list
// nested inside a list item could still overflow by a further
// LIST_INDENT_OVERHEAD per extra nesting level, not accounted for here as
// disproportionate to the reported bug. Subtracted from the *global*
// reflow width (which also governs paragraphs, which don't need it)
// rather than only for list rendering specifically - marked-terminal
// doesn't expose a per-element-type width, and paragraphs losing a few
// columns of a terminal that's often 200+ wide is a non-issue next to a
// list item actually overflowing and hard-breaking mid-word.
const LIST_INDENT_OVERHEAD = 6; // marked-terminal's default tab (4) + BULLET_POINT width (2)

// The box rule and prose wrap track the real terminal width exactly, with
// no upper bound - this used to cap at a fixed ~80 columns (later raised to
// a 120-column ceiling) regardless of how wide the terminal actually was,
// which read as "the width isn't tracking the window" on anything wider
// than that (confirmed live: a 100+ col terminal still rendered an 80-col
// rule with visible unused space to its right). Thomson confirmed he wants
// this literally uncapped - a fullscreen monitor is often 200-300+ columns,
// and even 120 still read as capped - so there is deliberately no ceiling
// here any more. `|| 80` only covers the case where the terminal hasn't
// reported a column count at all (columns is undefined/0), not a readability
// cap.
function contentWidth() {
  return process.stdout.columns || 80;
}

// Registers marked-terminal's renderer with the current width. Callable
// more than once - re-registering with a fresh width is exactly how a
// terminal resize is picked up (see refreshWidth below), since marked's own
// `use()` replaces the previously-registered renderer rather than stacking
// on top of it.
function configureMarkedTerminal() {
  marked.use(
    markedTerminal({
      // Reserves TURN_MARKER_WIDTH columns for the hanging indent every
      // rendered reply gets on top of this (renderMarkdown/
      // createMarkdownStreamer are only ever used for backend replies,
      // which always carry turnMarker()'s indent - see companion.js's
      // sendAndPrintTurn) - without this, a paragraph reflowed right up to
      // contentWidth() would then get indented past it once
      // indentContinuation runs, overflowing the terminal's actual column
      // count instead of staying within the terminal's own width. Also
      // reserves LIST_INDENT_OVERHEAD (see above) for the further indent
      // list rendering adds on top of that.
      width: contentWidth() - TURN_MARKER_WIDTH - LIST_INDENT_OVERHEAD,
      // Reflow (word-wrap) prose text to the width above rather than
      // leaving lines exactly as the model generated them - the width
      // above already matches the terminal's own edge (minus the hanging
      // indent), so without this, text generated with its own line breaks
      // (e.g. a numbered list item) could still run past it.
      reflowText: true,
    })
  );
}

if (enabled) configureMarkedTerminal();

// Re-registers marked-terminal's renderer against the terminal's *current*
// width - call this after a resize (companion.js listens for
// process.stdout's 'resize' event) so markdown rendered from here on wraps
// to the new size instead of whatever was captured at import time. A no-op
// when styling is off, matching every other helper in this module - nothing
// uses marked-terminal's renderer over a pipe anyway.
export function refreshWidth() {
  if (enabled) configureMarkedTerminal();
}

// De-emphasizes companion's own status/system lines (startup banner, relay
// server lifecycle, warnings, errors) relative to actual conversation
// content. A no-op string pass-through when styling is off.
export function dim(text) {
  return enabled ? c.dim(text) : text;
}

// The readline prompt marker. Plain '> ' when styling is off, matching the
// prompt this program has always used; a one-space left margin plus the
// colored ">" when styling is on, so the prompt lines up under boxRule's own
// matching one-space margin below rather than starting flush at column 0 -
// no "you"/role text (see turnMarker below for the tutor-reply side of the
// same convention).
export function promptString() {
  return enabled ? ` ${c.cyanBright.bold('>')} ` : '> ';
}

// The marker opening a tutor reply turn - a single bullet, replacing the
// old "tutor" role label and framing rule. '' when styling is off, same
// convention as the rest of this module's labels: callers must skip adding
// it entirely in that case, not print an empty prefix, so non-TTY output
// stays exactly the raw reply text.
export function turnMarker() {
  if (!enabled) return '';
  return `${c.magentaBright('•')} `;
}

// Indents every line of `text` except its very first by TURN_MARKER_WIDTH
// spaces, so a multi-line turnMarker-led reply's wrapped/continuation lines
// align under where the text starts after the bullet - a hanging indent -
// rather than wrapping back to column 0. Matches a Claude Code CLI
// transcript's own look (see companion/AGENTS.md's "message padding" note).
// Blank lines are left untouched rather than padded with trailing
// whitespace, so a blank separator row between blocks still reads as
// genuinely empty. `indentFirstLine: true` indents the first line too - for
// a streamed reply's second-or-later piece (see companion.js's
// writeReplyPiece), which starts on its own fresh line that still needs the
// same indent as every other continuation line, unlike the very first piece
// where turnMarker() itself already occupies that column. A no-op when
// styling is off, same convention as the rest of this module: there is no
// marker or indent to align under over a pipe.
export function indentContinuation(text, { indentFirstLine = false } = {}) {
  if (!enabled) return text;
  const pad = ' '.repeat(TURN_MARKER_WIDTH);
  return text
    .split('\n')
    .map((line, i) => ((i === 0 && !indentFirstLine) || line === '' ? line : pad + line))
    .join('\n');
}

// A thin rule marking off the pinned input box from the conversation above
// it, at the same width prose wraps to (minus the one-space left margin
// below, so the rule's right edge still lands at the terminal's own edge
// rather than running one column past it). A one-space left margin -
// matching promptString's own - gives the box a consistent inset rather than
// starting flush at column 0; companion.js's drawBoxRaw also prints a blank
// line above this rule for breathing room from whatever chat content
// precedes it. '' when styling is off - there is no persistent input box
// over a pipe.
export function boxRule() {
  if (!enabled) return '';
  return ` ${c.dim('─'.repeat(contentWidth() - 1))}`;
}

// Renders markdown (headers, bold/emphasis, lists, fenced code blocks with
// syntax highlighting) to ANSI-styled text for a real TTY, wrapped to the
// width above. Returns the text unchanged when styling is off, so piped
// output keeps showing the raw markdown exactly as before this feature
// existed.
export function renderMarkdown(text) {
  if (!enabled) return text;
  // marked-terminal pads block elements with blank lines; collapse runs of
  // 3+ into a single blank line and trim trailing whitespace so replies
  // don't accumulate extra vertical space compared to before.
  return marked.parse(text).replace(/\n{3,}/g, '\n\n').trimEnd();
}

// --- streaming reply support -------------------------------------------
//
// Two pieces on top of the styling/rendering above: rendering markdown
// safely as it streams in rather than only once a reply is fully done, and
// a spinner while waiting on the backend. companion.js owns *when* a reply
// starts/ends and how each piece reaches the terminal (it has the readline
// instance and the pinned input box); this module only owns what each piece
// looks like.

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
  // A one-space left margin, matching boxRule/promptString's own - the
  // spinner temporarily occupies the same column position the box's prompt
  // normally does, so it should line up with it rather than sitting one
  // column further left.
  return enabled ? ` ${c.dim(text)}` : text;
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
