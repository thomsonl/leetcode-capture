// extension/shared/sanitize.js - makes untrusted text safe to print in the terminal.
//
// Several things the companion prints come from outside this process:
// messages typed into the in-page panel, and every field of a capture. The
// relay's /capture route is CORS `*` by design (see relay-server/server.js),
// so ANY website the student visits can post a capture whose problemTitle or
// trigger carries an escape sequence. Written to a terminal unchanged, that
// sequence can recolor or clear the screen, retitle the window, or (on some
// terminals) do worse. The relay strips control characters from panel
// messages too, but the companion must not depend on that: it is the one
// writing to the terminal.
//
// The rule matches relay-server/panel-broker.js's stripControlChars: every C0
// control except newline and tab, DEL, and every C1 control (U+0080 to U+009F,
// which some terminals treat as 8-bit escape introducers, e.g. U+009B as CSI).
//
// Invisible formatting characters are dropped too, because they make text
// read differently from what it is (the "Trojan Source" trick): the bidi
// embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069) and
// the bidi marks (U+200E, U+200F, U+061C) reorder what follows them, and the
// zero-width space, word joiner, invisible operators and BOM (U+200B, U+2060
// to U+2064, U+FEFF) hide inside a word. The line and paragraph separators
// (U+2028, U+2029) become a plain newline, which is what they mean.
// Deliberately kept: the zero-width joiner and non-joiner (U+200D, U+200C).
// Emoji sequences (a family, a skin tone on a profession, a flag) are glued
// together by U+200D, and Persian and several Indic scripts need U+200C to
// spell words correctly; neither reorders text, so neither can disguise it.

const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const LINE_SEPARATORS_RE = /[\u2028\u2029]/g;

// Multi-line text (a typed message, a problem description): keeps newlines
// and tabs, drops every other control character.
export function stripControlChars(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(LINE_SEPARATORS_RE, '\n').replace(CONTROL_CHARS_RE, '');
}

// A value shown inside a one-line label (a problem title, a slug, a trigger):
// control characters dropped and any run of whitespace, newlines included,
// collapsed to one space, so it can neither inject escapes nor break the
// label across lines.
export function oneLine(text) {
  return stripControlChars(text).replace(/\s+/g, ' ').trim();
}

// Normalizes a parsed capture in place of the raw one: every string field
// that reaches the terminal, the panel or the model's prompt label is made
// safe once, here, so no call site has to remember to. The student's code is
// left exactly as captured (it only goes to the model and is never printed).
export function sanitizeCapture(capture) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return {};
  const out = { ...capture };
  for (const field of ['problemTitle', 'problemSlug', 'trigger', 'language']) {
    if (out[field] === undefined || out[field] === null) continue;
    out[field] = oneLine(out[field]) || null;
  }
  if (out.problemDescription !== undefined && out.problemDescription !== null) {
    out.problemDescription = stripControlChars(out.problemDescription);
  }
  if (Array.isArray(out.problemTags)) {
    out.problemTags = out.problemTags.filter((tag) => typeof tag === 'string').map(oneLine).filter(Boolean);
  }
  // The relay assigns attemptSeq, but the log file is just JSON lines: never
  // print a non-integer.
  if (out.attemptSeq !== undefined && !Number.isInteger(out.attemptSeq)) out.attemptSeq = null;
  return out;
}
