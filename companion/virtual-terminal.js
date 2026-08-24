// companion/virtual-terminal.js - a small ANSI escape-code interpreter that
// replays a raw byte stream companion.js wrote to stdout into the 2D grid a
// real terminal would actually be showing, given the current cursor
// position and the escape codes companion.js/readline emitted along the
// way.
//
// Exists specifically because some of companion.js's box-pinning bugs (see
// AGENTS.md - the readline `prevRows` desync behind "a capture arriving
// while a long typed line occupies the prompt corrupts everything above the
// box") are about *interpreted* rendering: a `moveCursor` + `clearScreenDown`
// sequence overwrites text that's still physically present, byte for byte,
// earlier in the raw captured stream. A plain text/line search over raw
// output (the technique box-padding.test.js already uses for the simpler
// padding-math case, where padding really is just literal '\n' characters)
// can't tell "this text is still on screen" apart from "this text was
// already erased by a later escape sequence" - both leave the same bytes
// sitting in the capture. Only replaying the escapes against a real cursor
// position/grid, the way a terminal does, can.
//
// Scoped deliberately narrow: only the escape sequences companion.js itself
// emits directly (see its readline.clearLine/cursorTo/moveCursor calls and
// its own literal '\x1b[2J\x1b[H'/'\x1b[?1049h' writes) and the ones node's
// own readline._refreshLine emits internally on rl.prompt(true) (moveCursor,
// cursorTo, clearScreenDown - confirmed empirically, see this file's own
// test for the exact bytes) - not a general-purpose terminal emulator.
// Private-mode sequences (`\x1b[?...h`/`l`, e.g. the alternate-screen and
// mouse-tracking toggles) and SGR color codes (`\x1b[...m`) are recognized
// and ignored (no visible effect on the grid) rather than mishandled.

const CSI_RE = /\x1b\[([0-9;?]*)([A-Za-z])/g;

export function replayToScreen(raw, { cols, rows }) {
  const screen = Array.from({ length: rows }, () => new Array(cols).fill(' '));
  let row = 0;
  let col = 0;

  function clearRow(r, fromCol, toCol) {
    for (let c = fromCol; c <= toCol; c += 1) screen[r][c] = ' ';
  }

  function scrollUp() {
    screen.shift();
    screen.push(new Array(cols).fill(' '));
  }

  function newline() {
    row += 1;
    col = 0;
    if (row >= rows) {
      scrollUp();
      row = rows - 1;
    }
  }

  function putChar(ch) {
    if (col >= cols) newline();
    screen[row][col] = ch;
    col += 1;
  }

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\x1b' && raw[i + 1] === '[') {
      CSI_RE.lastIndex = i;
      const match = CSI_RE.exec(raw);
      if (!match || match.index !== i) {
        // Not a well-formed CSI sequence after all - skip just the ESC so
        // we don't get stuck in an infinite loop on stray bytes.
        i += 1;
        continue;
      }
      const params = match[1];
      const final = match[2];
      const isPrivate = params.startsWith('?');
      const nums = isPrivate ? [] : params.split(';').filter(Boolean).map(Number);
      if (!isPrivate) {
        switch (final) {
          case 'A': // cursor up
            row = Math.max(0, row - (nums[0] || 1));
            break;
          case 'B': // cursor down
            row = Math.min(rows - 1, row + (nums[0] || 1));
            break;
          case 'G': // cursor to column (1-indexed)
            col = Math.max(0, (nums[0] || 1) - 1);
            break;
          case 'H': { // cursor position (row;col, 1-indexed)
            row = Math.max(0, Math.min(rows - 1, (nums[0] || 1) - 1));
            col = Math.max(0, (nums[1] || 1) - 1);
            break;
          }
          case 'K': { // erase in line
            const mode = nums[0] || 0;
            if (mode === 0) clearRow(row, col, cols - 1);
            else if (mode === 1) clearRow(row, 0, col);
            else clearRow(row, 0, cols - 1);
            break;
          }
          case 'J': { // erase in display
            const mode = nums[0] || 0;
            if (mode === 0) {
              clearRow(row, col, cols - 1);
              for (let r = row + 1; r < rows; r += 1) clearRow(r, 0, cols - 1);
            } else if (mode === 2) {
              for (let r = 0; r < rows; r += 1) clearRow(r, 0, cols - 1);
            }
            break;
          }
          default:
            break; // SGR ('m') and anything else - no visible grid effect
        }
      }
      // Private-mode toggles (alternate screen, mouse tracking) have no
      // visible grid effect either - nothing to do for them.
      i = match.index + match[0].length;
      continue;
    }
    if (ch === '\x1b') {
      i += 1; // a lone/malformed escape - skip it, don't loop forever
      continue;
    }
    if (ch === '\n') {
      newline();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      col = 0;
      i += 1;
      continue;
    }
    putChar(ch);
    i += 1;
  }

  return screen.map((r) => r.join('').replace(/\s+$/, ''));
}
