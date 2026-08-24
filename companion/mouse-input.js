// companion/mouse-input.js - parses xterm SGR mouse-report escape sequences
// (`\x1b[<Cb;Cx;Cy;M` for press/wheel, `...m` for release) out of a raw
// input stream, so wheel-up/down events can drive companion.js's own
// scrollback viewport instead of ever reaching readline.
//
// Why this has to happen before readline sees the bytes at all: readline's
// own keypress decoder has no notion of the SGR mouse protocol (confirmed
// live - see the PR that introduced this file). Fed a raw wheel-report
// sequence, it doesn't ignore it or emit one clean "mouse" event; it shreds
// the sequence into a run of ordinary-looking keypresses, one per
// character (`6`, `4`, `;`, `1`, `0`, ...), each of which readline's own
// line editor then inserts into whatever's currently typed - a wheel
// notch would corrupt the input line with literal digits and semicolons.
// Legacy X10 mouse reports (`\x1b[M` + three raw bytes, mode 1000 without
// 1006) happen to be silently swallowed by Node's decoder already, but
// that mode can't report coordinates past 223 and isn't what this program
// requests - SGR (1006) is, and SGR gets no such special handling.
//
// Kept separate from companion.js's stream wiring (which stream gets raw
// mode, which one readline reads from) so the byte-level parsing itself is
// unit-testable without a real TTY - mirrors this project's existing split
// between terminal-format.js's pure rendering helpers and companion.js's
// orchestration of when/where they're used.

// Only button-event tracking (1000) + SGR extended coordinates (1006) are
// requested, not full motion tracking (1002/1003): wheel notches are
// already reported as "buttons" 64-67 under plain 1000, so drag/motion
// tracking would only add noise this program has no use for. Disable in
// the reverse order, matching how the alternate-screen buffer's own
// enable/disable pair is ordered elsewhere in companion.js.
export const ENABLE_MOUSE_TRACKING = '\x1b[?1000h\x1b[?1006h';
export const DISABLE_MOUSE_TRACKING = '\x1b[?1006l\x1b[?1000l';

// A real terminal delivers one escape sequence in a single write in the
// overwhelming common case, but nothing guarantees it - this bounds how
// long a possible-in-progress `\x1b[<...` prefix is held waiting for the
// rest before it's abandoned and let through byte by byte, so a malformed
// or truncated sequence can't buffer forever.
const MAX_PENDING = 32;

// A short idle window covers the rare case where a sequence really is
// split across two reads (e.g. a slow/laggy pty) without leaving a lone,
// unrelated Escape keypress (which also starts with `\x1b[<`'s first byte)
// stuck waiting indefinitely just because no more bytes ever follow it.
const IDLE_FLUSH_MS = 50;

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

// The wheel bit (bit 6, value 64) distinguishes a wheel report from an
// ordinary button (0-3) regardless of any modifier bits (4=shift, 8=meta,
// 16=ctrl) added on top; the low bit (1) then distinguishes up (even) from
// down (odd). Standard xterm SGR encoding - matches xterm.js/blessed/
// neovim's own mouse-report handling. Returns null for anything that isn't
// a wheel report (plain clicks, releases - these are passed through
// unchanged by createMouseFilter below, not decoded here).
export function decodeWheelDirection(cb) {
  if ((cb & 64) !== 64) return null;
  return (cb & 1) === 1 ? 'down' : 'up';
}

// Creates a filter: feed it raw bytes as they arrive from the real
// terminal via push(chunk), and it calls onWheel('up' | 'down') for each
// complete SGR wheel report found, while writing every other byte -
// unchanged and in order, including non-wheel mouse reports (clicks,
// releases) this program doesn't act on - to `output` (expected to be a
// plain Writable, e.g. a PassThrough handed to readline as its own
// `input`).
//
// `chunk` may be a Buffer or a string; bytes are held internally as a
// binary/latin1 string (a straight 1:1 byte-to-char-code mapping) rather
// than decoded as UTF-8, specifically so a multi-byte UTF-8 character that
// happens to be split across two chunks is never corrupted by a decode
// happening mid-character - every byte, mouse-protocol or not, round-trips
// through unchanged.
export function createMouseFilter({ output, onWheel }) {
  let pending = '';
  let idleTimer = null;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function flushPending() {
    idleTimer = null;
    if (pending) output.write(Buffer.from(pending, 'binary'));
    pending = '';
  }

  function armIdleTimer() {
    idleTimer = setTimeout(flushPending, IDLE_FLUSH_MS);
    // Never let a lingering timer keep the process alive on its own - it's
    // purely a cleanup safety net, not something companion.js should have
    // to wait on to exit.
    if (idleTimer.unref) idleTimer.unref();
  }

  function push(chunk) {
    clearIdleTimer();
    pending += Buffer.isBuffer(chunk) ? chunk.toString('binary') : String(chunk);
    for (;;) {
      const escIndex = pending.indexOf('\x1b');
      if (escIndex === -1) {
        if (pending) output.write(Buffer.from(pending, 'binary'));
        pending = '';
        return;
      }
      if (escIndex > 0) {
        output.write(Buffer.from(pending.slice(0, escIndex), 'binary'));
        pending = pending.slice(escIndex);
      }
      // pending now starts at an ESC byte - not yet enough of it buffered
      // to tell whether it's the start of a mouse report at all.
      if (pending.length < 3) {
        armIdleTimer();
        return;
      }
      if (!pending.startsWith('\x1b[<')) {
        // Not a mouse report - forward just the ESC byte and keep
        // scanning from the next one; whatever follows (arrow keys, other
        // CSI sequences, a lone Escape) is ordinary input for readline to
        // decode exactly as it always has.
        output.write(Buffer.from(pending[0], 'binary'));
        pending = pending.slice(1);
        continue;
      }
      const match = SGR_MOUSE_RE.exec(pending);
      if (!match) {
        if (pending.length > MAX_PENDING) {
          // Long past any real mouse report's length with no terminator -
          // stop waiting and let it through byte by byte rather than
          // buffering forever.
          output.write(Buffer.from(pending[0], 'binary'));
          pending = pending.slice(1);
          continue;
        }
        armIdleTimer();
        return;
      }
      const direction = decodeWheelDirection(Number(match[1]));
      if (direction) onWheel(direction);
      // Any other SGR mouse report (a click, a release, a modifier-only
      // variant) is deliberately swallowed too, not forwarded - this
      // program never enabled motion tracking, so the only reports it can
      // receive at all are clicks/releases/wheel, none of which readline
      // has any use for either.
      pending = pending.slice(match[0].length);
    }
  }

  return { push };
}
