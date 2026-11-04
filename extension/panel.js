// LeetCode Capture - in-page tutor panel
//
// Adds a "Tutor" tab to the problem page's left tab strip (next to
// Description, Submissions, Editorial, Solutions) that shows the companion's
// live conversation and lets the student type to it. The tab and its content
// are built to look and behave like LeetCode's own: the tab button is a clone
// of a real one (so its classes, metrics and theme-following all come for
// free), and the panel samples its colors from the page's own elements at
// runtime instead of hardcoding a theme.
//
// The tutor runs elsewhere, and this script only shows its events and sends
// typed messages, over one of two transports (see "Transports" below), picked
// from the runtime chosen in the options page:
//   - extension: the extension's own background worker runs the tutor (a
//     local model or an API key, nothing to install). Events and messages go
//     over a runtime port (shared/tutor-service.js).
//   - relay: the helper (the local companion process) runs it. Events stream
//     from the relay server on localhost:8135 (GET /panel/events) and typed
//     messages go to POST /panel/message. See relay-server/panel-broker.js for
//     the protocol and its origin checks.
// Both carry the same event protocol, so everything below the transports is
// the same either way.
//
// Everything model-generated is untrusted text. It is only ever rendered with
// createElement/textContent (never innerHTML), and links are limited to
// http(s) URLs.

(() => {
  const RELAY_BASE = "http://localhost:8135";
  const MAX_ITEMS_PER_PROBLEM = 300;

  // ---------------------------------------------------------------------
  // Streaming transport
  // ---------------------------------------------------------------------

  // Parses one SSE block ("id: 3\ndata: {...}") into its JSON payload, or
  // null for a comment, keep-alive or malformed block.
  function parseSseBlock(block) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // Feeds raw text chunks in, calls onEvent for every complete SSE event.
  function createSseParser(onEvent) {
    let buffer = "";
    return function push(text) {
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const event = parseSseBlock(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (event) onEvent(event);
      }
    };
  }

  // ---------------------------------------------------------------------
  // Transcript state
  // ---------------------------------------------------------------------
  //
  // One transcript per problem slug, rebuilt purely from the relay's event
  // stream, so a reload or a late-opened tab replays into the same state.

  function createState() {
    return {
      companionOnline: null, // null until the first status event
      // The tutor is working on a turn, or has one queued (the relay's status
      // event carries it, see panel-broker.js).
      companionBusy: false,
      lastSeq: 0,
      // The relay run that lastSeq counts in. Sequence numbers restart at 1
      // when the relay restarts, so a seq means nothing without its epoch.
      epoch: null,
      // What the tutor runs on, from the companion's `config` event
      // ({ provider, label, model }, never a key), or null before one came.
      config: null,
      displayConfig: null,
      byProblem: new Map(), // slug -> items[]
      // The problem the tutor is on, once a switch notice said so (or null).
      // A panel on any other problem shows only that another one is active.
      activeProblem: null,
      turnProblem: new Map(), // turnId -> slug, so a chunk (which has no slug) finds its turn
    };
  }

  // What the feed shows of a transcript: a switch notice with nothing after
  // it yet (a Run on another problem resets the tutor but shows nothing) is
  // held back until the next message or reply, so it never dangles at the
  // end.
  function visibleItems(items) {
    return items.length && items[items.length - 1].switchNotice ? items.slice(0, -1) : items;
  }

  function itemsFor(state, slug) {
    const key = slug || "";
    let items = state.byProblem.get(key);
    if (!items) {
      items = [];
      state.byProblem.set(key, items);
    }
    return items;
  }

  function findTurn(state, turnId) {
    const slug = state.turnProblem.get(turnId);
    if (slug === undefined) return null;
    return itemsFor(state, slug).find((item) => item.kind === "tutor" && item.turnId === turnId) || null;
  }

  function hasOpenTurn(state) {
    for (const items of state.byProblem.values()) {
      if (items.some((item) => item.kind === "tutor" && item.pending)) return true;
    }
    return false;
  }

  // Every item carries a revision that goes up whenever applyEvent changes it
  // after creation, which is how the renderer knows which cached DOM nodes are
  // still current (see renderFeed).
  function touch(item) {
    item.rev = (item.rev || 0) + 1;
  }

  function newTurn(turnId) {
    // ended: the relay sent this turn's end (as opposed to the panel giving
    // up on it locally, see streamLost).
    return { kind: "tutor", turnId, text: "", pending: true, interrupted: false, ended: false, error: null, rev: 0 };
  }

  // Appends an item and enforces the per-problem cap. The turn ids of tutor
  // items that fall off the front are forgotten too, or turnProblem would grow
  // for as long as the tab stays open.
  function pushItem(state, slug, item) {
    const items = itemsFor(state, slug);
    if (item.rev === undefined) item.rev = 0;
    items.push(item);
    if (items.length > MAX_ITEMS_PER_PROBLEM) {
      for (const dropped of items.splice(0, items.length - MAX_ITEMS_PER_PROBLEM)) {
        if (dropped.kind === "tutor" && state.turnProblem.get(dropped.turnId) === (slug || "")) {
          state.turnProblem.delete(dropped.turnId);
        }
      }
    }
  }

  // The relay restarted (its epoch changed). Everything already on screen
  // stays, but numbering starts over, and a reply that was still streaming
  // will never get its end from this relay unless the companion survived, so
  // it stops showing the typing indicator. Returns true if any transcript
  // changed.
  function restartSession(state) {
    state.lastSeq = 0;
    interruptPending(state);
    let changed = false;
    for (const [slug, items] of state.byProblem) {
      if (!items.length) continue;
      if (items[items.length - 1].kind !== "notice" || items[items.length - 1].restart !== true) {
        pushItem(state, slug, { kind: "notice", text: "Session restarted", restart: true });
      }
      changed = true;
    }
    return changed;
  }

  // Every reply still streaming will never get its end: it stops showing
  // the typing indicator and says it did not finish. Returns true if any
  // reply changed.
  function interruptPending(state) {
    let changed = false;
    for (const items of state.byProblem.values()) {
      for (const item of items) {
        if (item.kind === "tutor" && item.pending) {
          item.pending = false;
          item.interrupted = true;
          touch(item);
          changed = true;
        }
      }
    }
    return changed;
  }

  // The event stream dropped and the relay may be gone. In the default setup
  // the companion runs the relay as its child and kills it when it exits, so
  // nothing will ever send the end of a reply still streaming (the relay's
  // own interrupted turn-end, see panel-broker.js's closeOpenTurns, needs the
  // relay to outlive the companion). Every such reply is given up on now. If
  // it was only a blip, the status the relay sends after the reconnect lists
  // the replies still open (reviveOpen), and a chunk revives one too.
  // Returns RESTARTED if any reply changed, else null.
  function streamLost(state) {
    state.companionOnline = null;
    return interruptPending(state) ? RESTARTED : null;
  }

  // The relay's status lists the turns it still has open. Those the panel
  // gave up on itself when its stream dropped are alive after all. Returns
  // true if any reply changed.
  function reviveOpen(state, turnIds) {
    let changed = false;
    for (const turnId of turnIds) {
      const turn = typeof turnId === "string" ? findTurn(state, turnId) : null;
      if (!turn || !turn.interrupted || turn.ended) continue;
      turn.interrupted = false;
      turn.pending = true;
      touch(turn);
      changed = true;
    }
    return changed;
  }

  // The tutor reset on a problem switch (a switch notice): it forgot every
  // other problem, and the relay or the worker dropped their buffered chat,
  // so the panel drops every transcript too. What a reload would replay is
  // then exactly what is on screen.
  function startFreshSession(state) {
    state.byProblem.clear();
    state.turnProblem.clear();
    state.displayConfig = state.config;
  }

  // Applies one relay event. Returns the problem slug whose transcript it
  // changed (or null), so the caller only touches the feed when that problem
  // is on screen. Returns RESTARTED when the change can touch every
  // transcript: the relay's epoch changed, or the companion went offline.
  const RESTARTED = "\u0000restarted";
  function applyEvent(state, event) {
    // Checked per event, not only on status: a reconnect replays the buffer
    // first and sends status last, and the replayed events already belong to
    // the new run.
    let restarted = false;
    if (typeof event.epoch === "string" && event.epoch) {
      if (state.epoch !== null && event.epoch !== state.epoch) restarted = restartSession(state);
      state.epoch = event.epoch;
    }
    const affected = applyEventInEpoch(state, event);
    return restarted ? RESTARTED : affected;
  }

  function applyEventInEpoch(state, event) {
    if (event.type === "status") {
      state.companionOnline = Boolean(event.companionOnline);
      state.companionBusy = state.companionOnline && event.busy === true;
      // The companion left (it exited, crashed, or its terminal closed), so
      // nothing will end a reply it was still streaming. The relay ends
      // those itself (a turn-end marked interrupted, see panel-broker.js's
      // closeOpenTurns); this covers a relay started before it did.
      if (!state.companionOnline && interruptPending(state)) return RESTARTED;
      if (state.companionOnline && Array.isArray(event.openTurns) && reviveOpen(state, event.openTurns)) return RESTARTED;
      return null;
    }
    // Kept apart from the transcripts; only the header shows it.
    if (event.type === "config") {
      if (typeof event.label !== "string" || !event.label) return null;
      state.config = {
        provider: typeof event.provider === "string" ? event.provider : "",
        label: event.label,
        model: typeof event.model === "string" && event.model ? event.model : null,
      };
      if (!hasOpenTurn(state)) state.displayConfig = state.config;
      return null;
    }
    // Replays after a reconnect can overlap what we already have.
    if (typeof event.seq === "number") {
      if (event.seq <= state.lastSeq) return null;
      state.lastSeq = event.seq;
    }
    const slug = event.problemSlug || "";
    // Chat on another problem with no switch (auto-clear turned off) means
    // the tutor is there now.
    if (state.activeProblem && slug && slug !== state.activeProblem && (event.type === "user" || event.type === "capture" || event.type === "turn-start")) {
      state.activeProblem = slug;
    }
    switch (event.type) {
      case "user":
        pushItem(state, slug, { kind: "user", text: event.text || "" });
        return slug;
      case "capture":
        // Only a Submit sent to the tutor shows a chip; an older companion
        // still publishes its Runs too.
        if (event.trigger !== "submit") return null;
        pushItem(state, slug, {
          kind: "capture",
          trigger: event.trigger,
          attemptSeq: event.attemptSeq,
          title: event.problemTitle || null,
        });
        return slug;
      case "notice":
        if (event.switch === true) {
          startFreshSession(state);
          state.activeProblem = slug || null;
          // Only shown once something follows it, see visibleItems.
          pushItem(state, slug, { kind: "notice", text: event.text || "", switchNotice: true });
          // Every open panel redraws: the one on the old problem empties.
          return RESTARTED;
        }
        pushItem(state, slug, { kind: "notice", text: event.text || "" });
        return slug;
      case "turn-start":
        if (state.turnProblem.has(event.turnId)) return null;
        state.turnProblem.set(event.turnId, slug);
        pushItem(state, slug, newTurn(event.turnId));
        return slug;
      case "chunk": {
        const turn = findTurn(state, event.turnId);
        if (!turn) return null;
        turn.text += event.text || "";
        // A reply marked interrupted that keeps streaming (the companion
        // outlived the relay, or only lost its inbox stream) is alive after
        // all.
        if (turn.interrupted) {
          turn.interrupted = false;
          turn.pending = true;
          turn.ended = false;
        }
        touch(turn);
        return state.turnProblem.get(event.turnId);
      }
      case "turn-end": {
        let turn = findTurn(state, event.turnId);
        if (!turn) {
          // Joined after the turn started and its start was already trimmed.
          state.turnProblem.set(event.turnId, slug);
          turn = newTurn(event.turnId);
          pushItem(state, slug, turn);
        }
        if (typeof event.text === "string") turn.text = event.text;
        turn.error = event.error || null;
        turn.pending = false;
        turn.ended = true;
        // The relay ends a reply this way when its companion went away
        // before finishing it.
        turn.interrupted = event.interrupted === true;
        if (!hasOpenTurn(state)) state.displayConfig = state.config;
        touch(turn);
        return state.turnProblem.get(event.turnId);
      }
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------
  // Markdown (just what a tutor reply uses)
  // ---------------------------------------------------------------------

  // Emphasis, strike and link text are parsed recursively. Past this depth
  // the markers stay literal text, so a pathological run of nested markers
  // can neither overflow the stack nor re-parse the same text over and over.
  const MAX_INLINE_DEPTH = 8;
  const URL_RUN_RE = /[^\s)]*/y;

  // ---- plain math --------------------------------------------------------
  // Small local models write LaTeX even when told not to ("\[ \frac{n(n-1)}{2}
  // = O(n^2) \]"), and the escape rule below would turn its \[ and \( into a
  // bare bracket, leaving the commands raw. The simple forms become plain
  // text before inline parsing: a/b, the symbols, superscripts and \sqrt,
  // with \( \), \[ \], $$ $$ and $ $ dropped around content that is clearly
  // math. Code spans are copied as they are, and fenced blocks never reach
  // this (they are not parsed inline). Everything stays text: the renderer
  // only ever makes text nodes from it.
  const SUPERSCRIPTS = {
    0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", k: "ᵏ", m: "ᵐ", x: "ˣ", y: "ʸ", j: "ʲ",
  };
  const MATH_SYMBOLS = {
    cdot: "·", times: "×", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
    ldots: "...", cdots: "...", dots: "...", infty: "∞", sum: "Σ", log: "log", ln: "ln", min: "min", max: "max",
    left: "", right: "", quad: " ", qquad: " ",
    Theta: "Θ", Omega: "Ω", Sigma: "Σ", Delta: "Δ", theta: "θ", omega: "ω", sigma: "σ", delta: "δ",
    alpha: "α", beta: "β", gamma: "γ", lambda: "λ", mu: "μ", pi: "π", epsilon: "ε",
    rightarrow: "→", to: "→", leftarrow: "←", approx: "≈", pm: "±", div: "÷", in: "∈", lceil: "⌈", rceil: "⌉",
    lfloor: "⌊", rfloor: "⌋", bmod: "mod", mod: "mod", gcd: "gcd", prod: "Π",
  };
  const MATH_WRAPPERS = new Set(["text", "textrm", "texttt", "mathrm", "mathit", "mathbf", "operatorname"]);
  const MAX_MATH_DEPTH = 6;

  // Where each "{" in `s` closes (-1: never), in one pass, so a long run of
  // unclosed braces is not rescanned for every command.
  function braceMatches(s) {
    const close = new Map();
    const open = [];
    for (let j = 0; j < s.length; j++) {
      if (s[j] === "{") open.push(j);
      else if (s[j] === "}" && open.length) close.set(open.pop(), j);
    }
    return close;
  }

  // A {group} (braces nested) or, failing that, one character, after spaces.
  function mathGroup(s, from, close) {
    let i = from;
    while (s[i] === " ") i += 1;
    if (i >= s.length || s[i] === "}") return null;
    if (s[i] !== "{") return { v: s[i], end: i + 1, braced: false };
    const j = close.get(i);
    return j === undefined ? null : { v: s.slice(i + 1, j), end: j + 1, braced: true };
  }

  // Parenthesized unless it is one term (an operator or space outside
  // parentheses would change what a/b means).
  function mathAtom(s) {
    let depth = 0;
    for (const c of s) {
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      else if (depth === 0 && /[\s+\-*/·×=<>]/.test(c)) return `(${s})`;
    }
    return s;
  }

  // The commands and superscripts in `s` as plain text. Inside math (inMath)
  // leftover braces go, thin spaces become spaces and ^n takes a letter;
  // outside, only ^ with digits or a {group} counts, so prose like a^b (XOR)
  // and {a: 1} stay as they were. Unknown commands and markdown escapes are
  // copied untouched.
  function mathText(s, inMath, depth = 0) {
    if (depth > MAX_MATH_DEPTH) return s;
    const close = braceMatches(s);
    let out = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") {
        const name = (/^[A-Za-z]+/.exec(s.slice(i + 1, i + 16)) || [""])[0];
        const after = i + 1 + name.length;
        if (name === "frac" || name === "dfrac" || name === "tfrac") {
          const a = mathGroup(s, after, close);
          const b = a && mathGroup(s, a.end, close);
          if (b) {
            out += `${mathAtom(mathText(a.v, true, depth + 1))}/${mathAtom(mathText(b.v, true, depth + 1))}`;
            i = b.end;
            continue;
          }
        } else if (name === "sqrt") {
          const a = mathGroup(s, after, close);
          if (a) {
            out += `√${mathAtom(mathText(a.v, true, depth + 1))}`;
            i = a.end;
            continue;
          }
        } else if (MATH_WRAPPERS.has(name)) {
          const a = mathGroup(s, after, close);
          if (a && a.braced) {
            out += mathText(a.v, true, depth + 1);
            i = a.end;
            continue;
          }
        } else if (name && Object.prototype.hasOwnProperty.call(MATH_SYMBOLS, name) && !/[A-Za-z]/.test(s[after] || "")) {
          const sym = MATH_SYMBOLS[name];
          // "n\log n" reads "n log n".
          out += /^[a-z]/.test(sym) && /[A-Za-z0-9]$/.test(out) ? ` ${sym}` : sym;
          i = after;
          continue;
        } else if (!name && inMath && /[,;:! ]/.test(s[i + 1] || "")) {
          out += s[i + 1] === "!" ? "" : " ";
          i += 2;
          continue;
        }
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "^" && i > 0 && !/\s/.test(s[i - 1])) {
        const next = s[i + 1] || "";
        let g = null;
        if (next === "{") g = mathGroup(s, i + 1, close);
        else if (/\d/.test(next)) g = { v: /^\d+/.exec(s.slice(i + 1, i + 12))[0], end: 0 };
        else if (inMath && /[A-Za-z]/.test(next)) g = { v: next, end: 0 };
        if (g) {
          if (!g.end) g.end = i + 1 + g.v.length;
          const inner = mathText(g.v, true, depth + 1).trim();
          const sup = [...inner].map((c) => SUPERSCRIPTS[c]);
          out += inner && sup.every(Boolean) ? sup.join("") : `^${mathAtom(inner)}`;
          i = g.end;
          continue;
        }
      }
      if (inMath && ch === "_" && s[i + 1] === "{") {
        const g = mathGroup(s, i + 1, close);
        if (g) {
          out += `_${mathAtom(mathText(g.v, true, depth + 1).trim())}`;
          i = g.end;
          continue;
        }
      }
      if (inMath && (ch === "{" || ch === "}")) {
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  const MATH_DELIMITERS = [
    { open: "\\[", close: "\\]" },
    { open: "\\(", close: "\\)" },
    { open: "$$", close: "$$" },
    { open: "$", close: "$" },
  ];
  // \( \) and \[ \] around anything with a command, an operator or a digit
  // ("\[not a link\]" is an escaped bracket); $ $ needs more, since a dollar
  // is also money: no space inside either end, no digit right after it, and
  // a command, ^, _, a comparison or a single letter inside.
  function isMathContent(content, open) {
    if (!content.trim() || content.length > 400 || content.includes("`")) return false;
    if (open !== "$") return /\\[A-Za-z]|[\^_=<>+\-*/]|\d/.test(content);
    return /\\[A-Za-z]|[\^_=<>]|^[A-Za-z]$/.test(content) && !/^\s|\s$/.test(content);
  }

  function plainMath(text) {
    if (!/[\\$^]/.test(text)) return text;
    let out = "";
    let plainStart = 0;
    let i = 0;
    // The next position of each closing delimiter at or after a point, so
    // a long run of unmatched openers is not rescanned (linear, like
    // parseInline).
    const nextClose = new Map();
    const closeAfter = (close, from) => {
      const cached = nextClose.get(close);
      if (cached !== undefined && (cached === -1 || cached >= from)) return cached;
      const found = text.indexOf(close, from);
      nextClose.set(close, found);
      return found;
    };
    const flush = (end) => {
      if (end > plainStart) out += mathText(text.slice(plainStart, end), false);
    };
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\" && text[i + 1] === "`") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        // Same rule as parseInline: a code span runs to the next backtick.
        const end = text.indexOf("`", i + 1);
        if (end > i + 1) {
          flush(i);
          out += text.slice(i, end + 1);
          i = end + 1;
          plainStart = i;
          continue;
        }
      }
      let matched = false;
      for (const d of MATH_DELIMITERS) {
        if (!text.startsWith(d.open, i)) continue;
        if (d.open === "$" && text[i + 1] === "$") break;
        const from = i + d.open.length;
        const end = closeAfter(d.close, from);
        if (end < 0) break;
        const content = text.slice(from, end);
        if (d.open === "$" && /\d/.test(text[end + 1] || "")) break;
        if (!isMathContent(content, d.open)) break;
        flush(i);
        out += mathText(content, true).trim();
        i = end + d.close.length;
        plainStart = i;
        matched = true;
        break;
      }
      if (!matched) i += ch === "\\" ? 2 : 1;
    }
    flush(text.length);
    return out;
  }

  // Linear in the length of `text` (times the nesting cap above): every scan
  // forward is either consumed by a match or cached for the positions after
  // it. The link rule in particular used to re-run a regex on text.slice(i)
  // at every "[", which was quadratic on a long run of unmatched brackets
  // and ran again on every streamed chunk.
  function parseInline(text, depth = 0) {
    if (depth > MAX_INLINE_DEPTH) return text ? [{ t: "text", v: text }] : [];
    if (depth === 0) text = plainMath(text);
    const nodes = [];
    let buf = "";
    let i = 0;
    // For links: the next "]" after the current position (-1: none left),
    // shared by every "[" before it, and the end of the last run of URL
    // characters (no whitespace, no ")") scanned, shared by every URL that
    // starts inside that run. Both only ever move forward.
    let nextClose = -2;
    let runStart = -1;
    let runEnd = -1;
    const urlRunEnd = (from) => {
      if (from < runStart || from > runEnd) {
        URL_RUN_RE.lastIndex = from;
        URL_RUN_RE.exec(text);
        runStart = from;
        runEnd = URL_RUN_RE.lastIndex;
      }
      return runEnd;
    };
    const flush = () => {
      // The model still emits em dashes despite the prompt; show a comma.
      if (buf) nodes.push({ t: "text", v: buf.replace(/\s*\u2014\s*/g, ", ") });
      buf = "";
    };
    const isWordChar = (c) => c !== undefined && /[A-Za-z0-9]/.test(c);
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(text[i + 1])) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === "`") {
        const end = text.indexOf("`", i + 1);
        if (end > i + 1) {
          flush();
          nodes.push({ t: "code", v: text.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
      if (text.startsWith("~~", i)) {
        const end = text.indexOf("~~", i + 2);
        const inner = end > i + 2 ? text.slice(i + 2, end) : "";
        if (end > i + 2 && !/^\s/.test(inner) && !/\s$/.test(inner)) {
          flush();
          nodes.push({ t: "del", c: parseInline(inner, depth + 1) });
          i = end + 2;
          continue;
        }
      }
      if (text.startsWith("***", i)) {
        const end = text.indexOf("***", i + 3);
        const inner = end > i + 3 ? text.slice(i + 3, end) : "";
        if (end > i + 3 && !/^\s/.test(inner) && !/\s$/.test(inner)) {
          flush();
          nodes.push({ t: "strong", c: [{ t: "em", c: parseInline(inner, depth + 1) }] });
          i = end + 3;
          continue;
        }
      }
      if (text.startsWith("**", i) || text.startsWith("__", i)) {
        const marker = text.slice(i, i + 2);
        const end = text.indexOf(marker, i + 2);
        const inner = end > i + 2 ? text.slice(i + 2, end) : "";
        // `__init__` / `__main__` are identifiers, not emphasis (CommonMark
        // would bold them, but a coding tutor mentions them constantly).
        const isDunder = marker === "__" && /^\w+$/.test(inner);
        if (end > i + 2 && !isDunder && !/^\s/.test(inner) && !/\s$/.test(inner)) {
          flush();
          nodes.push({ t: "strong", c: parseInline(text.slice(i + 2, end), depth + 1) });
          i = end + 2;
          continue;
        }
      }
      if ((ch === "*" || ch === "_") && text[i + 1] !== ch && text[i + 1] !== undefined && !/\s/.test(text[i + 1])) {
        // Underscore emphasis only at word boundaries, so snake_case survives.
        const boundaryOk = ch === "*" || !isWordChar(text[i - 1]);
        if (boundaryOk) {
          let end = i + 1;
          while (end < text.length) {
            end = text.indexOf(ch, end);
            if (end === -1) break;
            if (text[end + 1] === ch || text[end - 1] === ch) {
              end += 1;
              continue;
            }
            break;
          }
          if (end > i + 1 && !/\s/.test(text[end - 1]) && (ch === "*" || !isWordChar(text[end + 1]))) {
            flush();
            nodes.push({ t: "em", c: parseInline(text.slice(i + 1, end), depth + 1) });
            i = end + 1;
            continue;
          }
        }
      }
      if (ch === "[") {
        // [label](http(s)://url): the label runs to the first "]" and must
        // not be empty, the URL has no whitespace and ends at the first ")".
        if (nextClose !== -1 && nextClose <= i) nextClose = text.indexOf("]", i + 1);
        const close = nextClose;
        const urlStart = close + 2;
        const scheme = text.startsWith("https://", urlStart) ? 8 : text.startsWith("http://", urlStart) ? 7 : 0;
        if (close > i + 1 && text[close + 1] === "(" && scheme) {
          const urlEnd = urlRunEnd(urlStart);
          if (urlEnd > urlStart + scheme && text[urlEnd] === ")") {
            flush();
            nodes.push({ t: "link", href: text.slice(urlStart, urlEnd), c: parseInline(text.slice(i + 1, close), depth + 1) });
            i = urlEnd + 1;
            continue;
          }
        }
      }
      buf += ch;
      i += 1;
    }
    flush();
    return nodes;
  }

  // A fence opens with three or more backticks or tildes after up to three
  // spaces (more inside a list item), then an optional info string whose
  // first word is the language ("```python title=x" is python). It closes on
  // a line of the same character, at least as long, and nothing after it but
  // spaces.
  const FENCE_RE = /^(\s*)(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
  const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "plaintext", "ascii"]);
  function closesFence(line, fence) {
    const m = /^\s*(`{3,}|~{3,})[ \t]*$/.exec(line);
    return Boolean(m) && m[1][0] === fence[0] && m[1].length >= fence.length;
  }
  // Up to three spaces of indentation, and a closing run of #s only counts
  // after whitespace, so "## Using C#" keeps its #.
  const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE_RE = /^\s*>\s?(.*)$/;
  const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

  const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  // GFM alignment markers in the separator row: ":--" left, ":-:" center,
  // "--:" right, plain "---" leaves the default.
  function tableAlignments(separator) {
    return splitTableRow(separator).map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":") && cell.length > 1;
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return null;
    });
  }

  function splitTableRow(line) {
    let row = line.trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|")) row = row.slice(0, -1);
    const cells = [];
    let cell = "";
    let inCode = false;
    for (let k = 0; k < row.length; k += 1) {
      const ch = row[k];
      if (ch === "\\" && row[k + 1] === "|") {
        cell += "|";
        k += 1;
      } else if (ch === "`") {
        inCode = !inCode;
        cell += ch;
      } else if (ch === "|" && !inCode) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  // Turns a run of list lines into real nested lists. Indentation decides
  // nesting; a change of marker kind (bullet vs number) at the same level
  // starts a new list instead of continuing the old one, and a numbered list
  // keeps the number it started at.
  function buildLists(entries) {
    const out = [];
    const newList = (e) => ({ t: "list", ordered: e.ordered, start: e.ordered && Number.isFinite(e.start) ? e.start : 1, items: [] });
    let stack = [];
    for (const e of entries) {
      while (stack.length > 1 && e.indent < stack[stack.length - 1].indent) stack.pop();
      let top = stack[stack.length - 1];
      if (top && e.indent > top.indent && top.list.items.length) {
        const list = newList(e);
        top.list.items[top.list.items.length - 1].sub.push(list);
        top = { indent: e.indent, list };
        stack.push(top);
      } else if (top && e.ordered !== top.list.ordered) {
        const list = newList(e);
        if (stack.length === 1) {
          out.push(list);
          stack = [{ indent: e.indent, list }];
        } else {
          const parent = stack[stack.length - 2];
          parent.list.items[parent.list.items.length - 1].sub.push(list);
          stack[stack.length - 1] = { indent: e.indent, list };
        }
        top = stack[stack.length - 1];
      } else if (!top) {
        const list = newList(e);
        out.push(list);
        top = { indent: e.indent, list };
        stack.push(top);
      }
      top.list.items.push({ c: parseInline(e.text), sub: [] });
    }
    return out;
  }

  function startsBlock(line) {
    return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line);
  }

  function parseBlocks(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const fence = FENCE_RE.exec(line);
      if (fence) {
        // Content lines lose as much leading space as the fence itself had
        // (at most), so a block indented under a list item is not shifted.
        const indent = fence[1].replace(/\t/g, "    ").length;
        const strip = new RegExp(`^ {0,${indent}}`);
        const code = [];
        i += 1;
        let closed = false;
        while (i < lines.length) {
          if (closesFence(lines[i], fence[2])) {
            closed = true;
            i += 1;
            break;
          }
          code.push(lines[i].replace(strip, ""));
          i += 1;
        }
        // A reply still streaming may end inside a fence: the block renders
        // open (marked so) and settles once the closing fence arrives.
        blocks.push({ t: "code", lang: fence[3].toLowerCase(), v: code.join("\n"), open: !closed });
        continue;
      }
      const heading = HEADING_RE.exec(line);
      if (heading) {
        blocks.push({ t: "heading", level: heading[1].length, c: parseInline(heading[2]) });
        i += 1;
        continue;
      }
      if (HR_RE.test(line)) {
        blocks.push({ t: "hr" });
        i += 1;
        continue;
      }
      if (QUOTE_RE.test(line)) {
        const quoted = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          quoted.push(QUOTE_RE.exec(lines[i])[1]);
          i += 1;
        }
        blocks.push({ t: "quote", c: parseBlocks(quoted.join("\n")) });
        continue;
      }
      if (LIST_RE.test(line)) {
        const entries = [];
        while (i < lines.length) {
          const m = LIST_RE.exec(lines[i]);
          if (m) {
            entries.push({ indent: m[1].length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
            i += 1;
          } else if (lines[i].trim() && /^\s+\S/.test(lines[i]) && entries.length && !FENCE_RE.test(lines[i])) {
            // An indented continuation joins the item, but an indented fence
            // starts a code block of its own (a diagram under a step).
            entries[entries.length - 1].text += ` ${lines[i].trim()}`;
            i += 1;
          } else {
            break;
          }
        }
        blocks.push(...buildLists(entries));
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
        const header = splitTableRow(line);
        const aligns = tableAlignments(lines[i + 1]);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        blocks.push({
          t: "table",
          header: header.map(parseInline),
          align: header.map((_, col) => aligns[col] || null),
          rows: rows.map((r) => header.map((_, col) => parseInline(r[col] || ""))),
        });
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) {
        para.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ t: "paragraph", c: parseInline(para.join(" ")) });
    }
    return blocks;
  }

  function renderInline(nodes, doc, tableCell = false) {
    const frag = doc.createDocumentFragment();
    for (const node of nodes) {
      if (node.t === "text") {
        if (tableCell) {
          const parts = node.v.split(/(<br\s*\/?>)/gi);
          for (const part of parts) {
            if (/^<br\s*\/?>$/i.test(part)) frag.appendChild(doc.createElement("br"));
            else if (part) frag.appendChild(doc.createTextNode(part));
          }
        } else {
          frag.appendChild(doc.createTextNode(node.v));
        }
      } else if (node.t === "code") {
        const el = doc.createElement("code");
        el.textContent = node.v;
        frag.appendChild(el);
      } else if (node.t === "strong" || node.t === "em" || node.t === "del") {
        const el = doc.createElement(node.t);
        el.appendChild(renderInline(node.c, doc, tableCell));
        frag.appendChild(el);
      } else if (node.t === "link") {
        const el = doc.createElement("a");
        el.href = node.href;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
        el.appendChild(renderInline(node.c, doc, tableCell));
        frag.appendChild(el);
      }
    }
    return frag;
  }

  function renderList(block, doc) {
    const list = doc.createElement(block.ordered ? "ol" : "ul");
    if (block.ordered && block.start !== 1) list.start = block.start;
    for (const item of block.items) {
      const li = doc.createElement("li");
      li.appendChild(renderInline(item.c, doc));
      for (const sub of item.sub) li.appendChild(renderList(sub, doc));
      list.appendChild(li);
    }
    return list;
  }

  function renderBlocks(blocks, doc) {
    const frag = doc.createDocumentFragment();
    for (const block of blocks) {
      if (block.t === "paragraph") {
        const el = doc.createElement("p");
        el.appendChild(renderInline(block.c, doc));
        frag.appendChild(el);
      } else if (block.t === "heading") {
        const el = doc.createElement("p");
        el.className = `h h${Math.min(block.level, 3)}`;
        el.appendChild(renderInline(block.c, doc));
        frag.appendChild(el);
      } else if (block.t === "code") {
        const pre = doc.createElement("pre");
        // A block with no language (or a plain-text one) is how the tutor
        // draws diagrams and traces: it gets the tight line height that makes
        // box-drawing lines meet.
        if (PLAIN_LANGS.has(block.lang)) pre.className = "plain";
        if (block.open) pre.setAttribute("data-open", "");
        const code = doc.createElement("code");
        code.textContent = block.v;
        pre.appendChild(code);
        frag.appendChild(pre);
      } else if (block.t === "hr") {
        frag.appendChild(doc.createElement("hr"));
      } else if (block.t === "quote") {
        const el = doc.createElement("blockquote");
        el.appendChild(renderBlocks(block.c, doc));
        frag.appendChild(el);
      } else if (block.t === "list") {
        frag.appendChild(renderList(block, doc));
      } else if (block.t === "table") {
        const wrap = doc.createElement("div");
        wrap.className = "table-wrap";
        const table = doc.createElement("table");
        const head = doc.createElement("thead");
        const headRow = doc.createElement("tr");
        // An attribute plus a stylesheet rule rather than an inline style, so
        // nothing here depends on the page's CSP allowing style attributes.
        const align = (cell, col) => {
          if (block.align && block.align[col]) cell.setAttribute("data-align", block.align[col]);
        };
        for (const [col, cell] of block.header.entries()) {
          const th = doc.createElement("th");
          align(th, col);
          th.appendChild(renderInline(cell, doc, true));
          headRow.appendChild(th);
        }
        head.appendChild(headRow);
        const body = doc.createElement("tbody");
        for (const row of block.rows) {
          const tr = doc.createElement("tr");
          for (const [col, cell] of row.entries()) {
            const td = doc.createElement("td");
            align(td, col);
            td.appendChild(renderInline(cell, doc, true));
            tr.appendChild(td);
          }
          body.appendChild(tr);
        }
        table.append(head, body);
        wrap.appendChild(table);
        frag.appendChild(wrap);
      }
    }
    return frag;
  }

  // How many leading blocks of a re-parsed reply are unchanged, compared by a
  // key per block (its JSON form). The renderer keeps those blocks' nodes.
  function firstChangedBlock(oldKeys, newKeys) {
    let same = 0;
    while (same < oldKeys.length && same < newKeys.length && oldKeys[same] === newKeys[same]) same += 1;
    return same;
  }

  function problemSlugFromPath(pathname) {
    const match = /\/problems\/([^/]+)/.exec(pathname);
    return match ? match[1] : null;
  }

  // Asks content.js (a sibling content script in the same isolated world)
  // for the live editor code over a request/response CustomEvent pair on
  // `document`, the same JSON-string protocol content.js and inject.js use.
  // Resolves to { code, language, problemTitle, problemDescription } or
  // null when nothing answers in time or the editor could not be read; the
  // message then goes without code and the panel says so. `target` is injectable for panel.test.js.
  const SNAPSHOT_REQUEST = "leetcode-capture:snapshot-request";
  const SNAPSHOT_RESPONSE = "leetcode-capture:snapshot-response";
  function requestEditorSnapshot(target, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => {
        target.removeEventListener(SNAPSHOT_RESPONSE, onResponse);
        resolve(null);
      }, timeoutMs);
      function onResponse(event) {
        let payload;
        try {
          payload = JSON.parse(event.detail);
        } catch {
          return;
        }
        if (!payload || payload.requestId !== requestId) return;
        clearTimeout(timer);
        target.removeEventListener(SNAPSHOT_RESPONSE, onResponse);
        const snapshot = payload.snapshot;
        resolve(snapshot && typeof snapshot.code === "string" ? snapshot : null);
      }
      target.addEventListener(SNAPSHOT_RESPONSE, onResponse);
      target.dispatchEvent(new CustomEvent(SNAPSHOT_REQUEST, { detail: JSON.stringify({ requestId }) }));
    });
  }

  // The relay's caps on a panel message (relay-server/panel-broker.js keeps
  // the same numbers). Real code is a few KB, so these only matter for a
  // pathological editor; the point is that the panel never sends a body the
  // relay would refuse.
  const MAX_MESSAGE_BYTES = 256 * 1024;
  const MAX_SNAPSHOT_CODE_CHARS = 100_000;
  const MAX_SNAPSHOT_DESCRIPTION_CHARS = 50_000;

  function utf8Length(text) {
    return new TextEncoder().encode(text).length;
  }

  // The JSON body of a typed message, with the live editor snapshot when it
  // fits. The code is never cut: a truncated copy would look to the tutor
  // like deleted code. So when it does not fit, the description goes first
  // (the tutor already has it from earlier turns or a capture), then the
  // whole snapshot, and `codeLeftOut` tells the caller to say so; the
  // message then goes without any code.
  function buildMessageBody(text, problemSlug, snapshot) {
    const bare = JSON.stringify({ text, problemSlug });
    if (!snapshot || typeof snapshot.code !== "string") return { body: bare, codeLeftOut: false };
    if (snapshot.code.length > MAX_SNAPSHOT_CODE_CHARS) return { body: bare, codeLeftOut: true };
    const withSnapshot = { ...snapshot };
    if (typeof withSnapshot.problemDescription === "string" && withSnapshot.problemDescription.length > MAX_SNAPSHOT_DESCRIPTION_CHARS) {
      delete withSnapshot.problemDescription;
    }
    let body = JSON.stringify({ text, problemSlug, snapshot: withSnapshot });
    if (utf8Length(body) <= MAX_MESSAGE_BYTES) return { body, codeLeftOut: false };
    delete withSnapshot.problemDescription;
    body = JSON.stringify({ text, problemSlug, snapshot: withSnapshot });
    if (utf8Length(body) <= MAX_MESSAGE_BYTES) return { body, codeLeftOut: false };
    return { body: bare, codeLeftOut: true };
  }

  // Test-only hook (same pattern as content.js): `module` is undefined in a
  // real content script, so this is a no-op in the browser.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseSseBlock,
      createSseParser,
      createState,
      applyEvent,
      streamLost,
      RESTARTED,
      itemsFor,
      visibleItems,
      firstChangedBlock,
      parseInline,
      plainMath,
      parseBlocks,
      renderBlocks,
      problemSlugFromPath,
      requestEditorSnapshot,
      buildMessageBody,
      MAX_MESSAGE_BYTES,
      MAX_SNAPSHOT_CODE_CHARS,
      MAX_SNAPSHOT_DESCRIPTION_CHARS,
    };
    return;
  }

  // ---------------------------------------------------------------------
  // Page integration (browser only below this line)
  // ---------------------------------------------------------------------

  // Running twice in one document would build two tabs and two panels.
  if (window.__lcTutorPanelLoaded) return;
  window.__lcTutorPanelLoaded = true;

  const HOST_ID = "lc-tutor-panel-host";
  const TAB_ATTR = "data-lc-tutor-tab";
  const ACTIVE_ATTR = "data-lc-tutor-active";
  // Set by layout-bridge.js on the native Tutor tab's pane and button.
  const PANE_ATTR = "data-lc-tutor-pane";
  const BUTTON_ATTR = "data-lc-tutor-button";
  const CHAT_PATH = "M5 3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7.2L6 21.5V17H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z";
  const CHAT_PATH_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='${CHAT_PATH}'/></svg>`;
  // How long a page that has a layout may wait for the bridge's answer
  // before the injected tab is used instead.
  const BRIDGE_WAIT_MS = 3000;
  const TUTOR_COLOR = "rgb(150, 115, 255)";
  const MAX_MESSAGE_CHARS = 8000;
  // A message, Run or Submit whose code could not be read from the editor
  // model goes without code (a Run or Submit is not captured at all); see
  // content.js. Nothing stands in for it.
  const EDITOR_READ_FAILED = "Couldn't read your editor, so the tutor has not seen this code.";
  const ANOTHER_PROBLEM_ACTIVE = "Another problem is active now. Send a message or Run here to switch to this one.";
  const CODE_TOO_LONG = "Your code is too long to send with a message, so the tutor has not seen this code.";

  const state = createState();
  // Whether the current transport's event source answers; null until the
  // first connect attempt settles.
  let sourceReachable = null;
  let active = false;
  let unread = false;
  let mounted = null; // { tabset, container, tab, divider, host, layout, ... }
  // How the Tutor tab exists: "native" (a real tab of the page's own layout,
  // added by layout-bridge.js), "clone" (an injected copy of a tab button
  // over the Description tabset, the fallback) or "pending" until the bridge
  // has answered.
  let layoutMode = "pending";
  let pendingSince = 0;
  let nativePanel = null; // the native mode's panel, kept across panes
  let renderQueued = false;
  let sending = false; // a typed message's POST is in flight

  const PAGE_CSS = `
    /* The native Tutor tab's button is flexlayout's own, rendered by the
       page; it is only decorated, through attributes and pseudo-elements,
       which React never touches. */
    .flexlayout__tab_button[${BUTTON_ATTR}] { display: flex; align-items: center; }
    .flexlayout__tab_button[${BUTTON_ATTR}]:not(:has(svg))::before {
      content: ""; flex: none; width: 1em; height: 1em; margin-right: 4px; background: ${TUTOR_COLOR};
      -webkit-mask: url("data:image/svg+xml,${encodeURIComponent(CHAT_PATH_SVG)}") center / contain no-repeat;
      mask: url("data:image/svg+xml,${encodeURIComponent(CHAT_PATH_SVG)}") center / contain no-repeat;
    }
    .flexlayout__tab_button[${BUTTON_ATTR}][data-unread]::after {
      content: ""; flex: none; width: 6px; height: 6px; margin-left: 4px; border-radius: 50%; background: #ef4743;
    }
    [${TAB_ATTR}] .lc-tutor-dot { display: none; width: 6px; height: 6px; margin-left: 2px; border-radius: 50%; background: #ef4743; }
    [${TAB_ATTR}][data-unread] .lc-tutor-dot { display: block; }
    body[${ACTIVE_ATTR}] .flexlayout__tabset:has([${TAB_ATTR}]) .flexlayout__tab_button--selected:not([${TAB_ATTR}]) {
      color: var(--lc-tutor-muted, rgba(255, 255, 255, 0.6));
    }
    /* And the weight of an unselected label, on every copy of it. */
    body[${ACTIVE_ATTR}] .flexlayout__tabset:has([${TAB_ATTR}]) .flexlayout__tab_button--selected:not([${TAB_ATTR}]),
    body[${ACTIVE_ATTR}] .flexlayout__tabset:has([${TAB_ATTR}]) .flexlayout__tab_button--selected:not([${TAB_ATTR}]) * {
      font-weight: 400;
    }
  `;

  // Metrics below were measured on LeetCode's own panes (dark theme): the
  // Description pane's scroll area padding 20px 16px, body 14px/21px, 16px
  // between blocks, list items 16px in with a 33px pitch (21px line plus
  // 12px), inline code chips 12px/16px with 2px padding, a 5px radius and a
  // 1px border, and the browser's default (non-thin) scrollbar. There is no
  // big title: none of the native tabs except Description has one, and
  // Submissions opens with a slim muted row, which the header row copies:
  // flush at the top of the pane and 1px in from each side of it (the pane
  // itself lines up with the Description pane exactly), 32px tall with 12px
  // side padding, the row's own secondary text color and a 10% hairline under
  // it (white at 10% in the dark theme).
  const PANEL_CSS = `
    :host { display: none; position: absolute; z-index: 20; box-sizing: border-box; }
    /* LeetCode's own code font first, then monospace faces that carry the
       box-drawing and arrow glyphs on each platform, then whatever monospace
       face the system has (never a proportional one: diagrams need columns). */
    :host { --mono: Menlo, Menlo-fallback, "SF Mono", ui-monospace, Consolas, "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Segoe UI Symbol", monospace; }
    :host([data-active]) { display: block; }
    * { box-sizing: border-box; }
    .wrap {
      position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden;
      border-radius: 0 0 8px 8px; background: var(--bg); color: var(--body);
      font: 400 14px/21px var(--font);
      /* Text wraps anywhere rather than run past the pane: a long URL, a long
         identifier or inline code breaks onto the next line. Code blocks and
         table cells opt out below. The container lets the composer size
         itself by the pane's height. */
      overflow-wrap: anywhere; container-type: size;
    }
    /* Only ever scrolls vertically: wide code blocks and tables scroll inside
       their own boxes. The panel keeps its own scroll anchor across resizes
       (see keepScrollAnchor), so the browser's is switched off. */
    .scroll { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; overflow-anchor: none; scrollbar-gutter: stable; display: flex; flex-direction: column; padding: 20px 16px; color-scheme: var(--scheme); }
    .head {
      flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
      height: 32px; margin: 0 1px; padding: 0 12px; border-bottom: 1px solid var(--head-line); color: var(--muted);
    }
    /* In a narrow pane the model label gives way first (the right side only
       takes the room the status leaves), then the status text; both end in
       an ellipsis. The light and the gear always stay. */
    .head-left, .head-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .head-left { flex: 0 1 auto; min-width: 8px; }
    .head-right { flex: 1 1 0; justify-content: flex-end; gap: 4px; min-width: 24px; }
    /* The model switcher: a button like LeetCode's own language selector in
       the editor's top bar (its text style, padding and radius are sampled
       from that button when the page has one, see sampleTheme), the model's
       name cut with an ellipsis when the pane is narrow, then a chevron.
       It opens a listbox of the saved models. */
    button.model {
      flex: 0 1 auto; min-width: 0; width: auto; height: auto; gap: 4px; justify-content: flex-start;
      padding: var(--sel-pad, 2px 6px); border-radius: var(--sel-radius, 4px); color: var(--sel-color, var(--muted));
      font: var(--sel-weight, 400) var(--sel-size, 14px) / var(--sel-line, 20px) var(--font);
    }
    button.model[hidden] { display: none; }
    button.model:hover:not(:disabled), button.model[aria-expanded="true"] { color: var(--fg); background: var(--fill); }
    button.model:focus-visible { outline: 1px solid color-mix(in srgb, var(--fg) 45%, transparent); outline-offset: 0; }
    .provider { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.model svg { flex: none; }
    .menu {
      position: absolute; z-index: 5; top: 30px; right: 8px; box-sizing: border-box;
      width: max-content; min-width: min(220px, calc(100% - 16px)); max-width: min(320px, calc(100% - 16px));
      max-height: calc(100% - 46px); overflow-y: auto; padding: 4px; border: 1px solid var(--line); border-radius: 8px;
      background: var(--pop-bg); box-shadow: var(--pop-shadow); color: var(--body); font-size: 14px; line-height: 20px; overflow-wrap: normal;
    }
    .menu[hidden] { display: none; }
    .opt { display: flex; align-items: flex-start; gap: 8px; min-height: 32px; padding: 6px 8px; border-radius: 6px; cursor: pointer; outline: 0; }
    /* One highlighted row, keyboard or pointer: moving the pointer over an
       entry focuses it (see wireSwitcher), so only focus paints. */
    .opt:focus { background: color-mix(in srgb, var(--body) 9%, transparent); }
    .opt[aria-disabled="true"] { cursor: not-allowed; }
    .opt[aria-disabled="true"] .opt-name { color: var(--muted); }
    .opt .check { flex: none; width: 16px; height: 20px; display: flex; align-items: center; justify-content: center; color: var(--body); visibility: hidden; }
    .opt[aria-selected="true"] .check { visibility: visible; }
    .opt-text { display: flex; flex-direction: column; min-width: 0; }
    .opt-name, .opt-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .opt-meta { font-size: 12px; line-height: 16px; color: var(--muted); }
    .menu .sep { height: 1px; margin: 4px 0; background: var(--line); }
    /* An icon button like LeetCode's own pane-header icons: muted, brighter on
       hover over a faint fill. Pulled 4px right so the 16px icon itself, not
       its hover box, lines up with the row's 12px padding, as the status
       text does on the left. */
    button.gear { flex: none; width: 24px; height: 24px; margin-right: -4px; border-radius: 4px; color: var(--muted); }
    button.gear:hover { color: var(--fg); background: var(--fill); }
    button.gear:focus-visible { outline: 1px solid color-mix(in srgb, var(--fg) 45%, transparent); outline-offset: 0; }
    .status { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 14px; line-height: 20px; color: var(--muted); white-space: nowrap; }
    .status span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    /* The status light: neutral (the text color) while connecting or with
       the tutor offline, red with no relay, green idle, yellow working. The
       text next to it always says the same, for anyone who cannot tell the
       colors apart. */
    .status .light { width: 8px; height: 8px; border-radius: 50%; flex: none; background: currentColor; }
    .status[data-state="ok"] .light { background: var(--green); }
    .status[data-state="busy"] .light { background: var(--yellow); }
    .status[data-state="bad"] .light { background: var(--red); }
    .feed { flex: 1 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .banner { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; background: var(--fill); color: var(--muted); }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 12px; margin: auto; padding: 0 24px; color: color-mix(in srgb, var(--fg) 30%, transparent); text-align: center; }
    .empty p { margin: 0; max-width: 300px; }
    .chip { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px; background: var(--fill); font-size: 12px; line-height: 16px; color: var(--muted); }
    .chip b { font-weight: 500; color: var(--fg); }
    .notice { display: flex; align-items: center; gap: 10px; font-size: 12px; line-height: 16px; color: var(--muted); }
    .notice::before, .notice::after { content: ""; flex: 1; height: 1px; background: var(--line); }
    .user { align-self: flex-end; max-width: 85%; padding: 8px 12px; border-radius: 8px; background: var(--fill); white-space: pre-wrap; }
    .user-text.collapsed { max-height: 220px; overflow: hidden; }
    .user button.more { display: block; width: auto; height: auto; margin-top: 4px; padding: 2px 0; color: var(--muted); font: inherit; font-size: 12px; }
    .tutor { min-width: 0; }
    .tutor > :first-child { margin-top: 0; }
    .tutor > :last-child { margin-bottom: 0; }
    .tutor p { margin: 0 0 16px; }
    .tutor .h { font-weight: 600; margin: 20px 0 8px; color: var(--fg); }
    .tutor > .h:first-child { margin-top: 0; }
    .tutor .h1 { font-size: 18px; line-height: 26px; } .tutor .h2 { font-size: 16px; line-height: 24px; }
    .tutor ul, .tutor ol { margin: 0 0 16px; padding-left: 16px; }
    .tutor li { margin: 0 0 12px; }
    .tutor li:last-child { margin-bottom: 0; }
    .tutor li > ul, .tutor li > ol { margin: 4px 0 0; }
    .tutor li li { margin-bottom: 4px; }
    .tutor li li:last-child { margin-bottom: 0; }
    .table-wrap { margin: 0 0 16px; overflow-x: auto; }
    /* Cells wrap between words but never inside one, so a table too wide for
       the pane keeps readable columns and scrolls in its wrapper. */
    .tutor table { border-collapse: collapse; }
    .tutor th, .tutor td { overflow-wrap: break-word; padding: 6px 12px; border: 1px solid var(--chip-line); text-align: left; vertical-align: top; }
    .tutor [data-align="center"] { text-align: center; } .tutor [data-align="right"] { text-align: right; }
    .tutor th { font-weight: 600; color: var(--fg); background: var(--fill); }
    .tutor strong { font-weight: 600; }
    .tutor a { color: var(--link); text-decoration: none; }
    .tutor a:hover { text-decoration: underline; }
    code { font: 12px/16px var(--mono); padding: 2px; border-radius: 5px; background: var(--fill); border: 1px solid var(--chip-line); color: color-mix(in srgb, var(--fg) 75%, transparent); }
    .tutor pre { margin: 0 0 16px; padding: 12px 16px; border-radius: 8px; background: var(--fill); border: 1px solid var(--chip-line); overflow-x: auto; }
    /* A wide code block or table scrolls sideways. Chromium's own thin
       scrollbar draws arrow buttons that sit over the rounded corners, so it
       gets a slim styled one without buttons. Setting scrollbar-width would
       switch these rules off in Chromium, so only browsers without them
       (Firefox) get it. */
    .tutor pre::-webkit-scrollbar, .table-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
    .tutor pre::-webkit-scrollbar-button, .table-wrap::-webkit-scrollbar-button { display: none; }
    .tutor pre::-webkit-scrollbar-track, .table-wrap::-webkit-scrollbar-track, .tutor pre::-webkit-scrollbar-corner, .table-wrap::-webkit-scrollbar-corner { background: transparent; }
    .tutor pre::-webkit-scrollbar-thumb, .table-wrap::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 4px; background: color-mix(in srgb, var(--fg) 22%, transparent) padding-box; }
    @supports not selector(::-webkit-scrollbar) { .tutor pre, .table-wrap { scrollbar-width: thin; } }
    /* A code block is shown exactly as sent: never wrapped (it scrolls
       sideways), tabs at four columns, no ligatures turning "->" or "!=" into
       one glyph. A plain block (a diagram) gets a line height equal to the
       glyph box, so the vertical box-drawing lines of one row meet the next. */
    .tutor pre code {
      display: block; padding: 0; border: 0; background: none; color: var(--body);
      font-size: 12px; line-height: 20px; white-space: pre; overflow-wrap: normal; word-break: normal;
      tab-size: 4; font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; font-kerning: none;
    }
    .tutor pre.plain code { line-height: 14px; }
    .tutor blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 2px solid var(--line-strong); color: var(--muted); }
    .tutor hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
    .err { color: var(--red); }
    .tutor .note { margin: 0; font-size: 12px; line-height: 16px; color: var(--muted); }
    .dots { display: inline-flex; gap: 4px; padding: 6px 0; }
    .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite ease-in-out; }
    .dots i:nth-child(2) { animation-delay: 0.15s; } .dots i:nth-child(3) { animation-delay: 0.3s; }
    @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
    .composer { padding: 12px 16px 16px; border-top: 1px solid var(--line); }
    .composer { flex: none; }
    .box { display: flex; align-items: flex-end; gap: 8px; padding: 6px 6px 6px 12px; border-radius: 8px; background: var(--fill); }
    .box:focus-within { box-shadow: 0 0 0 1px color-mix(in srgb, var(--fg) 45%, transparent); }
    textarea { flex: 1; min-width: 0; min-height: 28px; max-height: min(140px, max(28px, 30cqh)); margin: 0; padding: 4px 0; border: 0; outline: 0; resize: none; background: transparent; color: var(--body); font: inherit; }
    textarea::placeholder { color: var(--muted); }
    /* A placeholder longer than a narrow pane is cut, never wrapped into a
       scrolling second line. */
    textarea:placeholder-shown { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    textarea:disabled { cursor: not-allowed; }
    button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--green); cursor: pointer; }
    button:hover:not(:disabled) { background: var(--fill); }
    button:disabled { color: var(--muted); opacity: 0.5; cursor: not-allowed; }
    .hint { margin: 6px 2px 0; font-size: 12px; line-height: 16px; color: var(--muted); }
    .counter { margin: 6px 2px 0; font-size: 12px; line-height: 16px; color: var(--muted); text-align: right; }
    .counter[hidden] { display: none; }
    .counter.over { color: var(--red); font-weight: 600; }
  `;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- finding LeetCode's own elements --------------------------------

  // LeetCode renders every label twice inside a tab button (a bold visible
  // copy and an absolutely-positioned regular-weight copy that reserves the
  // width), so a button's textContent reads "descriptiondescription". The
  // label is the text of its first leaf element.
  function labelLeaves(button) {
    return [...button.querySelectorAll("*")].filter((n) => n.children.length === 0 && (n.textContent || "").trim());
  }

  function labelOf(button) {
    const leaf = labelLeaves(button)[0];
    return leaf ? leaf.textContent.trim().toLowerCase() : "";
  }

  function findTabset() {
    for (const button of document.querySelectorAll(".flexlayout__tab_button")) {
      if (button.hasAttribute(TAB_ATTR)) continue;
      if (labelOf(button) === "description") return button.closest(".flexlayout__tabset");
    }
    return null;
  }

  // The native pane currently shown in our tabset. Panes are absolutely
  // positioned siblings of the tabsets, so the visible one is the pane laid out
  // exactly over this tabset's content area. DOM order means nothing here: the
  // layout can list another tabset's pane (the Code editor, say) first, and
  // picking that one would make the editor inert while the Tutor tab is open.
  function paneUnderTabset(m) {
    const content = m.tabset.querySelector(".flexlayout__tabset_content");
    if (!content) return null;
    const want = content.getBoundingClientRect();
    if (!want.width || !want.height) return null;
    const near = (a, b) => Math.abs(a - b) <= 1;
    return (
      [...m.layout.querySelectorAll(".flexlayout__tab")].find((pane) => {
        if (pane === m.host) return false;
        const r = pane.getBoundingClientRect();
        return near(r.left, want.left) && near(r.top, want.top) && near(r.width, want.width) && near(r.height, want.height);
      }) || null
    );
  }

  // Relative luminance below 0.5 is a dark surface.
  function isLight(cssColor) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cssColor);
    if (!m) return false;
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 > 0.5;
  }

  // The text color of the slim row at the top of the native Submissions pane
  // (its "Status" column label), which the Tutor header copies. flexlayout
  // gives a tab button the path "<tabset>/tb<i>" and its pane "<tabset>/t<i>".
  // The pane only exists once Submissions has been opened, and is usually
  // hidden; a hidden element still has a computed color. Null when not found.
  function submissionsRowColor(m) {
    const button = [...m.container.querySelectorAll(".flexlayout__tab_button")].find(
      (b) => !b.hasAttribute(TAB_ATTR) && labelOf(b) === "submissions"
    );
    const match = button ? /^(.*)\/tb(\d+)$/.exec(button.getAttribute("data-layout-path") || "") : null;
    if (!match) return null;
    const panePath = `${match[1]}/t${match[2]}`;
    const pane = [...m.layout.querySelectorAll(".flexlayout__tab")].find((p) => p.getAttribute("data-layout-path") === panePath);
    const row = pane ? pane.querySelector(".border-b") : null;
    const leaf = row ? labelLeaves(row).find((n) => !n.closest("svg")) : null;
    if (!leaf) return null;
    const color = getComputedStyle(leaf).color;
    return color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent" ? color : null;
  }

  // The colors are read from LeetCode's own rendered elements rather than
  // hardcoded, so the panel follows whatever theme the page is in.
  function sampleTheme(m) {
    const pick = (node, prop, fallback) => {
      if (!node) return fallback;
      const value = getComputedStyle(node)[prop];
      return value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent" ? value : fallback;
    };
    const buttons = [...m.container.querySelectorAll(".flexlayout__tab_button")].filter((b) => !b.hasAttribute(TAB_ATTR));
    const selected = buttons.find((b) => b.classList.contains("flexlayout__tab_button--selected"));
    const unselected = buttons.find((b) => b.classList.contains("flexlayout__tab_button--unselected"));
    const fg = pick(selected || unselected, "color", "rgb(245, 245, 245)");
    // The tab strip's secondary color: what a native tab label turns to
    // while the Tutor tab is the selected one.
    const tabMuted = pick(unselected, "color", "rgba(255, 255, 255, 0.6)");
    const light = isLight(pick(m.tabset, "backgroundColor", "rgb(38, 38, 38)"));
    // Secondary text inside the panel is the content's own, which in the
    // dark theme is a slightly blue grey, not the tab strip's white at 60%.
    // Measured on the real Submissions row; used until that row can be read.
    const muted = submissionsRowColor(m) || (light ? tabMuted : "rgba(239, 242, 246, 0.6)");
    const style = m.host.style;
    style.setProperty("--bg", pick(m.tabset, "backgroundColor", "rgb(38, 38, 38)"));
    style.setProperty("--fg", fg);
    style.setProperty("--muted", muted);
    // Body copy in the Description pane is pure white while its title and the
    // tab labels are 245; keep that distinction.
    style.setProperty("--body", pick(m.native ? m.pane : paneUnderTabset(m), "color", fg));
    style.setProperty("--scheme", getComputedStyle(document.documentElement).colorScheme || "dark");
    style.setProperty("--font", getComputedStyle(document.body).fontFamily);
    style.setProperty("--fill", "color-mix(in srgb, var(--fg) 7%, transparent)");
    style.setProperty("--line", "color-mix(in srgb, var(--fg) 10%, transparent)");
    // The Submissions row's hairline is the body text color (pure white in
    // the dark theme) at 10%, slightly brighter than --line.
    style.setProperty("--head-line", "color-mix(in srgb, var(--body) 10%, transparent)");
    style.setProperty("--line-strong", "color-mix(in srgb, var(--fg) 24%, transparent)");
    style.setProperty("--chip-line", "color-mix(in srgb, var(--fg) 12%, transparent)");
    // The status green comes from the page's own Submit button, so a light
    // theme gets its own, darker shade; the fallback is for a page that has
    // no such button on screen yet.
    const submit = document.querySelector('[data-e2e-locator="console-submit-button"]');
    style.setProperty("--green", pick(submit, "color", light ? "#0e8a3a" : "#2cbb5d"));
    // Not sampled: the first anchor in the native pane is a plain-text link
    // (it came out near-black in light mode), so links get a fixed blue per
    // surface instead.
    style.setProperty("--link", light ? "#0b63e5" : "#4b9bff");
    style.setProperty("--red", "#ef4743");
    // LeetCode's own "Medium" yellow in the dark theme; on white a darker
    // shade, so the light keeps at least 3:1 against the panel.
    style.setProperty("--yellow", light ? "#b97c00" : "#ffc01e");
    // The switcher's popover: a raised surface like LeetCode's own menus.
    style.setProperty("--pop-bg", light ? "#ffffff" : "rgb(48, 48, 48)");
    style.setProperty("--pop-shadow", light ? "0 4px 16px rgba(0, 0, 0, 0.12)" : "0 4px 16px rgba(0, 0, 0, 0.4)");
    sampleLanguageSelector(style);
    document.documentElement.style.setProperty("--lc-tutor-muted", tabMuted);
  }

  // LeetCode's language selector in the editor's top bar ("C++", "Python3"
  // and a chevron): the model switcher copies its text style, padding and
  // radius. Found by its label among the page's buttons; each value falls
  // back to the switcher's own default when the page has no such button.
  const LANGUAGES = new Set(["C++", "Java", "Python", "Python3", "C", "C#", "JavaScript", "TypeScript", "PHP", "Swift", "Kotlin", "Dart", "Go", "Ruby", "Scala", "Rust", "Racket", "Erlang", "Elixir", "Pandas", "MySQL", "MS SQL Server", "Oracle", "PostgreSQL", "Bash"]);
  function languageSelector() {
    for (const button of document.querySelectorAll(".flexlayout__tab button")) {
      if (button.closest(`#${HOST_ID}`)) continue;
      if (LANGUAGES.has((button.textContent || "").trim())) return button;
    }
    return null;
  }

  function sampleLanguageSelector(style) {
    const button = languageSelector();
    const cs = button ? getComputedStyle(button) : null;
    const set = (name, value, ok) => {
      if (cs && value && ok) style.setProperty(name, value);
      else style.removeProperty(name);
    };
    const px = (v) => /^\d+(\.\d+)?px$/.test(v);
    set("--sel-color", cs && cs.color, cs && cs.color !== "rgba(0, 0, 0, 0)");
    set("--sel-size", cs && cs.fontSize, cs && px(cs.fontSize) && parseFloat(cs.fontSize) >= 11 && parseFloat(cs.fontSize) <= 16);
    set("--sel-line", cs && cs.lineHeight, cs && px(cs.lineHeight) && parseFloat(cs.lineHeight) <= 24);
    set("--sel-weight", cs && cs.fontWeight, cs && /^\d+$/.test(cs.fontWeight));
    const pad = cs ? `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}` : "";
    set("--sel-pad", pad, cs && [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].every((v) => px(v) && parseFloat(v) <= 8));
    set("--sel-radius", cs && cs.borderTopLeftRadius, cs && px(cs.borderTopLeftRadius) && parseFloat(cs.borderTopLeftRadius) <= 8);
  }

  // ---- the tab button --------------------------------------------------

  function chatIcon(template) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    // Same classes and size model as LeetCode's own icons (absolutely centered
    // in a fixed box), so spacing matches exactly.
    svg.setAttribute("class", template && template.getAttribute("class") ? template.getAttribute("class") : "");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "1em");
    svg.setAttribute("height", "1em");
    svg.setAttribute("aria-hidden", "true");
    svg.style.color = TUTOR_COLOR;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", CHAT_PATH);
    svg.appendChild(path);
    return svg;
  }

  function buildTab(container) {
    const buttons = [...container.querySelectorAll(".flexlayout__tab_button")].filter((b) => !b.hasAttribute(TAB_ATTR));
    const template = buttons[buttons.length - 1];
    if (!template) return null;
    const tab = template.cloneNode(true);
    tab.setAttribute(TAB_ATTR, "");
    tab.removeAttribute("data-layout-path");
    tab.removeAttribute("id");
    // LeetCode's tab buttons are draggable (to rearrange panels); ours has no
    // layout node behind it, so it must not start a drag.
    tab.removeAttribute("draggable");
    tab.setAttribute("role", "tab");
    tab.classList.remove("flexlayout__tab_button--selected");
    tab.classList.add("flexlayout__tab_button--unselected");
    for (const trailing of tab.querySelectorAll(".flexlayout__tab_button_trailing")) trailing.remove();

    const leaves = labelLeaves(tab).filter((n) => !n.closest("svg"));
    for (const leaf of leaves) leaf.textContent = "Tutor";
    const row = leaves.length ? leaves[0].closest(".flexlayout__tab_button_content") : null;
    if (row && row.firstElementChild) row.firstElementChild.appendChild(el("span", "lc-tutor-dot"));
    const oldIcon = tab.querySelector("svg");
    if (oldIcon) oldIcon.replaceWith(chatIcon(oldIcon));

    const dividerTemplate = container.querySelector(".flexlayout__tabset_tab_divider");
    const divider = dividerTemplate ? dividerTemplate.cloneNode(true) : null;
    return { tab, divider };
  }

  // Puts the injected tab right after Description, as the bridge does for the
  // real tab: Description, its divider, Tutor, our divider, then the rest.
  // flexlayout draws a divider after every tab but the last, so when
  // Description is last ours goes before the Tutor tab instead. Without a
  // Description button in the strip the tab stays where it is (appended on
  // the first call). Does nothing when the tab is already in place.
  function placeTab(container, tab, divider) {
    const desc = [...container.querySelectorAll(".flexlayout__tab_button")].find(
      (b) => !b.hasAttribute(TAB_ATTR) && labelOf(b) === "description"
    );
    if (!desc) {
      if (!tab.isConnected) container.append(...(divider ? [divider, tab] : [tab]));
      return;
    }
    const next = desc.nextElementSibling;
    const nativeDivider = next && next !== divider && next.classList.contains("flexlayout__tabset_tab_divider") ? next : null;
    if (nativeDivider) {
      if (nativeDivider.nextElementSibling === tab && (!divider || tab.nextElementSibling === divider)) return;
      nativeDivider.after(...(divider ? [tab, divider] : [tab]));
    } else {
      if (divider ? next === divider && divider.nextElementSibling === tab : next === tab) return;
      desc.after(...(divider ? [divider, tab] : [tab]));
    }
  }

  // ---- the panel -------------------------------------------------------

  function buildPanel() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.setProperty("min-width", "0", "important");
    host.style.setProperty("max-width", "100%", "important");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;

    const wrap = el("div", "wrap");
    wrap.style.setProperty("min-width", "0", "important");
    wrap.style.setProperty("max-width", "100%", "important");
    wrap.setAttribute("role", "tabpanel");
    wrap.setAttribute("aria-label", "Tutor");
    // A slim header row like the one Submissions opens with, fixed at the
    // top while the transcript scrolls under it: the connection status on
    // the left; on the right the model the tutor uses and a gear that opens
    // the extension's options page (through background.js, since a content
    // script cannot open it itself).
    const head = el("div", "head");
    const headLeft = el("div", "head-left");
    const status = el("div", "status");
    // A polite live region: screen readers announce "Offline",
    // "Processing" and the like when it changes, without interrupting.
    status.setAttribute("role", "status");
    status.dataset.state = "neutral";
    const light = el("div", "light");
    light.setAttribute("aria-hidden", "true");
    status.appendChild(light);
    const statusText = el("span", "", "Connecting");
    status.appendChild(statusText);
    headLeft.appendChild(status);
    const headRight = el("div", "head-right");
    // The model switcher (see "The model switcher" below).
    const model = document.createElement("button");
    model.type = "button";
    model.className = "model";
    model.hidden = true;
    model.setAttribute("aria-haspopup", "listbox");
    model.setAttribute("aria-expanded", "false");
    const provider = el("span", "provider", "");
    model.appendChild(provider);
    // Feather's "chevron-down" (MIT), drawn in the text color.
    model.insertAdjacentHTML(
      "beforeend",
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'
    );
    const menu = el("div", "menu");
    menu.hidden = true;
    menu.id = "lc-tutor-models";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Tutor model");
    model.setAttribute("aria-controls", menu.id);
    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "gear";
    gear.setAttribute("aria-label", "Tutor settings");
    gear.title = "Tutor settings";
    // Feather's "settings" gear (MIT), drawn in the text color.
    gear.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
      "</svg>";
    gear.addEventListener("click", openSettings);
    headRight.append(model, gear);
    head.append(headLeft, headRight);

    const banner = el("div", "banner");
    banner.hidden = true;

    const scroll = el("div", "scroll");
    const feed = el("div", "feed");
    scroll.append(banner, feed);
    // Whether the feed follows new content to the bottom. Any scroll up by
    // the student (wheel, touch, keys, a scrollbar drag) stops it at once;
    // coming back near the bottom starts it again. The panel itself only
    // ever scrolls down, and content that shrinks leaves it at the bottom.
    // `lastTop` and `metrics` are where the feed was and how big it was at
    // the last scroll the panel saw: a scroll that comes with a size change
    // (a resize clamping scrollTop, a rewrap) is layout, not the student.
    const view = { follow: true, lastTop: 0, metrics: "", expectTop: null, anchor: null };
    scroll.addEventListener(
      "scroll",
      () => {
        const top = scroll.scrollTop;
        const ownScroll = view.expectTop !== null && Math.abs(top - view.expectTop) < 1;
        view.expectTop = null;
        // The panel's own scroll (following, or restoring the anchor after a
        // resize) says nothing about what the student wants, and neither
        // does one the layout caused.
        if (ownScroll || scrollMetrics(scroll) !== view.metrics) {
          noteScroll(view, scroll);
          if (view.follow && scroll.scrollHeight - top - scroll.clientHeight > 1) scrollPanelTo({ scroll, view }, scroll.scrollHeight);
          return;
        }
        const fromBottom = scroll.scrollHeight - top - scroll.clientHeight;
        if (top < view.lastTop - 1 && fromBottom > 1) view.follow = false;
        else if (fromBottom < 80) view.follow = true;
        noteScroll(view, scroll);
        if (!view.follow) view.anchor = scrollAnchor(scroll, feed);
      },
      { passive: true }
    );
    // The wheel says so before the scroll it causes lands, so a render in
    // between cannot pull the feed back down.
    scroll.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0 && scroll.scrollTop > 0) view.follow = false;
      },
      { passive: true }
    );

    const composer = el("div", "composer");
    const box = el("div", "box");
    const input = document.createElement("textarea");
    input.rows = 1;
    input.placeholder = "Ask the tutor about this problem";
    input.setAttribute("aria-label", "Message the tutor");
    // Preserve a long paste so the student can edit it down to the relay limit.
    const send = document.createElement("button");
    send.type = "button";
    send.setAttribute("aria-label", "Send");
    send.title = "Send (Enter)";
    send.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z"/></svg>';
    box.appendChild(input);
    box.appendChild(send);
    composer.appendChild(box);
    const hint = el("div", "hint", "");
    hint.hidden = true;
    composer.appendChild(hint);
    const counter = el("div", "counter", "");
    counter.hidden = true;
    counter.setAttribute("aria-live", "polite");
    composer.appendChild(counter);

    wrap.append(head, scroll, composer, menu);
    root.append(style, wrap);

    // LeetCode binds many single-key shortcuts on the page, and this script's
    // sibling (content.js) binds Ctrl/Cmd+Enter to a Submit capture. Typing
    // here must trigger neither, so keys stop at the host.
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());

    const p = { host, wrap, status, statusText, headRight, model, provider, menu, gear, banner, scroll, view, feed, box, input, send, hint, counter };
    wireSwitcher(p);
    return p;
  }

  // ---- live resizing ----------------------------------------------------
  //
  // The student drags the splitters, so the pane changes width and height at
  // any time, mid-reply included. Nothing here is measured once: a
  // ResizeObserver on the scroll area and the feed re-runs these on every
  // change.

  // The composer grows with what is typed, up to its max-height (which
  // depends on the pane's height), and must be re-measured when a width
  // change rewraps the text.
  function fitInput(p) {
    const input = p.input;
    input.style.height = "auto";
    if (!input.value) return;
    const max = parseFloat(getComputedStyle(input).maxHeight) || 140;
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
  }

  function updateCounter(p) {
    const length = p.input.value.length;
    p.counter.hidden = length < MAX_MESSAGE_CHARS * 0.8;
    p.counter.textContent = `${length} / ${MAX_MESSAGE_CHARS}`;
    p.counter.classList.toggle("over", length > MAX_MESSAGE_CHARS);
  }

  // Scrolls the panel itself, telling the scroll listener so.
  function scrollMetrics(scroll) {
    return `${scroll.scrollHeight}x${scroll.clientHeight}x${scroll.clientWidth}`;
  }

  function noteScroll(view, scroll) {
    view.lastTop = scroll.scrollTop;
    view.metrics = scrollMetrics(scroll);
  }

  function scrollPanelTo(p, top) {
    const before = p.scroll.scrollTop;
    p.scroll.scrollTop = top;
    // Only a real move fires a scroll event to recognize.
    if (p.scroll.scrollTop !== before) p.view.expectTop = p.scroll.scrollTop;
    noteScroll(p.view, p.scroll);
  }

  // What the student is reading when scrolled up: the first block (a feed
  // item, or a paragraph, code block, table or list item inside a reply)
  // that reaches below the top edge, and how far below the edge it starts.
  function scrollAnchor(scroll, feed) {
    const top = scroll.getBoundingClientRect().top;
    let candidates = feed.children;
    let found = null;
    for (let depth = 0; depth < 3 && candidates; depth += 1) {
      let next = null;
      for (const node of candidates) {
        const r = node.getBoundingClientRect();
        if (r.bottom > top + 0.5 && r.height > 0) {
          next = node;
          break;
        }
      }
      if (!next) break;
      found = next;
      const r = next.getBoundingClientRect();
      // Inside a reply (or a list in it), a block nearer the edge holds
      // still better through a rewrap than the whole reply does.
      if (r.top >= top - 0.5 || !next.children.length) break;
      candidates = next.children;
    }
    return found ? { node: found, offset: found.getBoundingClientRect().top - top } : null;
  }

  // After a size change: a following feed stays at the bottom, and one the
  // student scrolled up keeps the same text at the same height on screen.
  function keepScrollAnchor(p) {
    const { scroll, view } = p;
    if (view.follow) {
      scrollPanelTo(p, scroll.scrollHeight);
      return;
    }
    const anchor = view.anchor;
    if (anchor && anchor.node.isConnected) {
      const now = anchor.node.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      const delta = now - anchor.offset;
      if (Math.abs(delta) >= 0.5) scrollPanelTo(p, scroll.scrollTop + delta);
    }
    noteScroll(view, scroll);
    view.anchor = scrollAnchor(scroll, p.feed);
  }

  function observePanelSize(p) {
    let size = "";
    const observer = new ResizeObserver(() => {
      // Hidden (its tab not selected) or between two panes: nothing is laid
      // out, and measuring now would lose the place the student was reading.
      if (!p.wrap.clientHeight || !p.host.isConnected) return;
      // The pane's own size (not the feed's) changes what the composer may
      // take: its width rewraps the typed text, its height sets the cap.
      const now = `${p.wrap.clientWidth}x${p.wrap.clientHeight}`;
      if (now !== size) {
        size = now;
        fitInput(p);
      }
      keepScrollAnchor(p);
    });
    observer.observe(p.scroll);
    observer.observe(p.feed);
    observer.observe(p.wrap);
    return observer;
  }

  // The options page is the only place settings (and API keys) are edited:
  // a script on leetcode.com can read anything typed into this panel, but not
  // an extension page. Without an extension runtime (the panel injected by
  // hand for a test) there is nothing to open.
  function openSettings() {
    const runtime =
      (typeof browser !== "undefined" && browser.runtime) || (typeof chrome !== "undefined" && chrome.runtime) || null;
    if (!runtime || typeof runtime.sendMessage !== "function" || !runtime.id) return;
    try {
      const pending = runtime.sendMessage({ type: "lc-tutor:open-settings" });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {
      // The extension was reloaded under this page; nothing to do.
    }
  }

  function currentSlug() {
    return problemSlugFromPath(location.pathname);
  }

  function describeConnection() {
    if (sourceReachable === false && transport === extensionTransport) {
      return {
        label: "Offline",
        ok: false,
        light: "bad",
        banner: "Lost the connection to the extension's tutor. Reload this page if it doesn't come back in a moment.",
      };
    }
    if (sourceReachable === false && providerChosen === false) {
      // Nothing chosen in the options page, and no helper running: the first
      // thing to do is pick a model, which for most people needs no install.
      return {
        label: "Not set up",
        ok: false,
        light: "neutral",
        banner: "Choose the tutor's model in the extension options (the gear above). A local model or an API key needs nothing else installed.",
      };
    }
    if (sourceReachable === false) {
      return {
        label: "Offline",
        ok: false,
        light: "bad",
        banner:
          "Can't reach the relay server on localhost:8135. Start the companion with `leetcode`, or run `node companion.js` in the project's companion folder." +
          (HELPER_HINTS[helperState] ? ` ${HELPER_HINTS[helperState]}` : ""),
      };
    }
    if (state.companionOnline === false) {
      return {
        label: "Tutor offline",
        ok: false,
        light: "neutral",
        banner: "The relay is running but the tutor isn't. Start the companion with `leetcode` to chat and get your attempts reviewed here.",
      };
    }
    if (switching) return { label: "Switching", ok: true, light: "busy", banner: null };
    if (state.companionOnline === null) return { label: "Connecting", ok: false, light: "neutral", banner: null };
    if (state.companionBusy) return { label: "Processing", ok: true, light: "busy", banner: null };
    return { label: "Connected", ok: true, light: "ok", banner: null };
  }

  function renderBanner(node, text) {
    // Rebuilt only when the text changes, like everything in the header.
    if (node.dataset.text === (text || "")) return;
    node.dataset.text = text || "";
    node.textContent = "";
    if (!text) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    // Backticked words become <code>, nothing else is interpreted.
    text.split(/(`[^`]+`)/).forEach((part) => {
      if (part.startsWith("`") && part.endsWith("`")) node.appendChild(el("code", "", part.slice(1, -1)));
      else node.appendChild(document.createTextNode(part));
    });
  }

  function emptyStateText(conn, slug) {
    if (sourceReachable === false && providerChosen === false) {
      return "Once you choose a model in the extension options, your Run and Submit attempts and the tutor's replies show up here.";
    }
    if (sourceReachable === false || state.companionOnline === false) {
      // The composer is disabled and the banner above says how to start the
      // companion; don't invite a question that can't be asked.
      return "Once the companion is running, your Run and Submit attempts and the tutor's replies show up here.";
    }
    // The tutor moved to another problem and forgot this one. Which problem
    // is never shown here, nor anything of its chat.
    if (state.activeProblem && slug && slug !== state.activeProblem) {
      return ANOTHER_PROBLEM_ACTIVE;
    }
    // A Run is only recorded (the tutor sees it with the next message), so
    // only a Submit is promised a review.
    return conn.ok
      ? "Submit your code and the tutor will review it here. You can also ask a question about this problem below."
      : "Submit your code and the tutor will review it here.";
  }

  // ---- the feed ----------------------------------------------------------
  //
  // The feed is patched in place, never rebuilt per event. Rebuilding it
  // (as an earlier version did on every streamed chunk) threw away the
  // student's text selection and reset every code block's horizontal scroll
  // several times a second. Instead each item keeps one DOM node for its whole
  // life (nodeCache, keyed by the item object, so a dropped item's node is
  // garbage collected with it), and a node is only touched when its item's
  // rev changed. A tutor reply is patched block by block: blocks whose parsed
  // form is unchanged keep their nodes, and only the first changed block
  // onward is rebuilt, which while streaming is normally just the last one.

  const INTERRUPTED_NOTE = "The tutor stopped before this reply finished.";
  const nodeCache = new WeakMap(); // item -> { node, rev, blocks: [{ key, node }], tail: [] }
  let emptyNode = null;
  let feedDirty = true; // the on-screen transcript changed since the last feed render
  let renderedSlug; // the slug the feed currently shows (undefined: none yet)

  function renderStaticItem(item) {
    if (item.kind === "capture") {
      const chip = el("div", "chip");
      chip.appendChild(el("b", "", item.trigger === "submit" ? "Submit" : "Run"));
      if (item.attemptSeq) chip.appendChild(document.createTextNode(`Attempt ${item.attemptSeq}`));
      return chip;
    }
    if (item.kind === "notice") return el("div", "notice", item.text);
    if (item.text.length <= 1200) return el("div", "user", item.text);
    const bubble = el("div", "user");
    const body = el("div", "user-text collapsed", item.text);
    const more = el("button", "more", "Show more");
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const expanded = body.classList.toggle("collapsed") === false;
      more.textContent = expanded ? "Show less" : "Show more";
      more.setAttribute("aria-expanded", String(expanded));
    });
    bubble.append(body, more);
    return bubble;
  }

  function patchTutor(entry, item) {
    const blocks = item.text ? parseBlocks(item.text) : [];
    const keys = blocks.map((block) => JSON.stringify(block));
    const same = firstChangedBlock(
      entry.blocks.map((b) => b.key),
      keys
    );
    for (const old of entry.blocks.splice(same)) old.node.remove();
    // The tail (error, interruption note, typing dots) is small and always
    // comes last, so it is simply redone.
    for (const node of entry.tail.splice(0)) node.remove();
    for (let k = same; k < blocks.length; k += 1) {
      const node = renderBlocks([blocks[k]], document).firstChild;
      entry.node.appendChild(node);
      entry.blocks.push({ key: keys[k], node });
    }
    if (item.error) {
      const cutOff = /cut off before finishing/i.test(item.error);
      const message = cutOff
        ? "The reply was cut off because the model ran out of room. Open Settings and check Context window (tokens)."
        : item.error.replaceAll("COMPANION_LOCAL_NUM_CTX", "Context window (tokens) in Settings");
      entry.tail.push(el("p", "err", message));
    }
    // One note for every way a reply can be cut off: the relay restarted, or
    // the companion went away mid-reply.
    if (item.interrupted) entry.tail.push(el("p", "note", INTERRUPTED_NOTE));
    if (item.pending && !item.text) {
      const dots = el("div", "dots");
      for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement("i"));
      entry.tail.push(dots);
    }
    for (const node of entry.tail) entry.node.appendChild(node);
  }

  function nodeFor(item) {
    let entry = nodeCache.get(item);
    if (!entry) {
      const node = item.kind === "tutor" ? el("div", "tutor") : renderStaticItem(item);
      entry = { node, rev: item.kind === "tutor" ? -1 : item.rev, blocks: [], tail: [] };
      nodeCache.set(item, entry);
    }
    if (entry.rev !== item.rev) {
      patchTutor(entry, item);
      entry.rev = item.rev;
    }
    return entry.node;
  }

  // Makes the feed's children exactly `nodes`, in order, while moving as
  // little as possible: nodes that stay are never detached (detaching would
  // drop a selection inside them), stale ones are removed, new ones inserted.
  function reconcile(feed, nodes) {
    const keep = new Set(nodes);
    for (const child of [...feed.children]) if (!keep.has(child)) child.remove();
    nodes.forEach((node, i) => {
      if (feed.children[i] !== node) feed.insertBefore(node, feed.children[i] || null);
    });
  }

  function renderHeader(p, conn, slug) {
    if (p.statusText.textContent !== conn.label) p.statusText.textContent = conn.label;
    if (p.status.dataset.state !== conn.light) p.status.dataset.state = conn.light;
    renderBanner(p.banner, conn.banner);

    // The switcher names the active saved model; without a list of them (no
    // extension worker) it names what the tutor reported it runs on, and
    // only while that tutor is online.
    const config = state.companionOnline ? state.displayConfig : null;
    const entry = activeEntry();
    const providerText = entry ? entry.name : config ? (config.model ? `${config.label} \u00b7 ${config.model}` : config.label) : "";
    const tip = entry
      ? `The tutor uses ${entry.model && entry.model !== entry.name ? `${entry.name} (${entry.providerLabel}, ${entry.model})` : `${entry.name} (${entry.providerLabel})`}. Click to switch.`
      : config
        ? `The tutor uses ${config.model ? `${config.label}, ${config.model}` : config.label}`
        : "";
    if (p.provider.textContent !== providerText) p.provider.textContent = providerText;
    if (p.model.title !== tip) p.model.title = tip;
    const aria = `Tutor model: ${providerText}`;
    if (p.model.getAttribute("aria-label") !== aria) p.model.setAttribute("aria-label", aria);
    p.model.hidden = !providerText;
    if (p.model.hidden && !p.menu.hidden) closeMenu(p, false);
    if (!p.menu.hidden) renderMenu(p);

    const canSend = conn.ok && Boolean(slug);
    p.input.disabled = !canSend;
    p.send.disabled = !canSend || sending || !p.input.value.trim() || p.input.value.length > MAX_MESSAGE_CHARS;
    p.input.placeholder = canSend
      ? "Ask the tutor about this problem"
      : sourceReachable === false && providerChosen === false
        ? "Choose a model to chat"
        : "Start the companion to chat";
  }

  function render() {
    renderQueued = false;
    if (!mounted) return;
    const p = mounted.panel;
    const slug = currentSlug();
    const conn = describeConnection();
    renderHeader(p, conn, slug);

    if (!active) return;
    const emptyText = emptyStateText(conn, slug);
    if (emptyNode && emptyNode.firstChild.textContent !== emptyText) emptyNode.firstChild.textContent = emptyText;
    if (slug !== renderedSlug) feedDirty = true;
    // Status changes and events for other problems end here: nothing in the
    // feed is touched.
    if (!feedDirty) return;
    feedDirty = false;
    renderedSlug = slug;

    const stick = p.view.follow;
    const items = visibleItems((slug && state.byProblem.get(slug)) || []);
    let nodes;
    if (items.length === 0) {
      if (!emptyNode) {
        emptyNode = el("div", "empty");
        emptyNode.appendChild(el("p", "", emptyText));
      }
      nodes = [emptyNode];
    } else {
      nodes = items.map(nodeFor);
    }
    reconcile(p.feed, nodes);
    if (stick) scrollPanelTo(p, p.scroll.scrollHeight);
    else keepScrollAnchor(p);
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  // What an applied event means for the screen: the feed only needs work when
  // the transcript on screen changed (or a relay restart touched them all).
  function noteApplied(affected) {
    if (affected === RESTARTED || (affected !== null && affected === currentSlug())) feedDirty = true;
    scheduleRender();
  }

  // ---- placement, activation ------------------------------------------

  function syncRect() {
    if (!mounted || mounted.native) return;
    const content = mounted.tabset.querySelector(".flexlayout__tabset_content");
    if (!content) return;
    const layoutRect = mounted.layout.getBoundingClientRect();
    const rect = content.getBoundingClientRect();
    const s = mounted.host.style;
    s.left = `${rect.left - layoutRect.left}px`;
    s.top = `${rect.top - layoutRect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    // A splitter drag or a layout change can put another pane under the
    // tabset: the one made inert follows. A frame where the pane has not
    // caught up with the tabset yet (no match) keeps the current one.
    if (active) {
      const pane = paneUnderTabset(mounted);
      if (pane && pane !== mounted.inertPane) {
        if (mounted.inertPane) mounted.inertPane.inert = false;
        mounted.inertPane = pane;
        pane.inert = true;
      }
    }
  }

  function selectedRealButton(m) {
    return [...m.container.querySelectorAll(".flexlayout__tab_button--selected")].find((b) => !b.hasAttribute(TAB_ATTR)) || null;
  }

  function setUnread(on) {
    unread = on;
    if (!mounted) return;
    if (on) mounted.tab.setAttribute("data-unread", "");
    else mounted.tab.removeAttribute("data-unread");
  }

  function activate() {
    if (!mounted || mounted.native || active) return;
    active = true;
    // Remember the page's own selection by label, not node: React can swap
    // the node out for the same tab (seen right after load) and that must not
    // read as the page having moved to another tab.
    const selected = selectedRealButton(mounted);
    mounted.selectedAtActivation = selected ? labelOf(selected) : null;
    sampleTheme(mounted);
    syncRect();
    mounted.host.setAttribute("data-active", "");
    mounted.tab.classList.remove("flexlayout__tab_button--unselected");
    mounted.tab.classList.add("flexlayout__tab_button--selected");
    mounted.tab.setAttribute("aria-selected", "true");
    document.body.setAttribute(ACTIVE_ATTR, "");
    // The native pane stays mounted behind the panel; keep keyboard focus out
    // of it (and only it: see paneUnderTabset).
    mounted.inertPane = paneUnderTabset(mounted);
    if (mounted.inertPane) mounted.inertPane.inert = true;
    setUnread(false);
    // A hint about an earlier failed send is stale by the time they come back.
    mounted.panel.hint.hidden = true;
    render();
    mounted.panel.view.follow = true;
    scrollPanelTo(mounted.panel, mounted.panel.scroll.scrollHeight);
    // After the browser's own mousedown focus handling, which would otherwise
    // move focus to the tab button we are being activated from.
    setTimeout(() => {
      if (active && mounted && !mounted.panel.input.disabled) mounted.panel.input.focus({ preventScroll: true });
    }, 0);
  }

  function deactivate() {
    if (!mounted || mounted.native || !active) return;
    active = false;
    mounted.host.removeAttribute("data-active");
    mounted.tab.classList.remove("flexlayout__tab_button--selected");
    mounted.tab.classList.add("flexlayout__tab_button--unselected");
    mounted.tab.setAttribute("aria-selected", "false");
    document.body.removeAttribute(ACTIVE_ATTR);
    if (mounted.inertPane) mounted.inertPane.inert = false;
    mounted.inertPane = null;
  }

  function teardown() {
    if (!mounted) return;
    deactivate();
    mounted.cleanup();
    mounted = null;
    active = false;
  }

  function mount() {
    const tabset = findTabset();
    if (!tabset) return;
    const container = tabset.querySelector(".flexlayout__tabset_tabbar_inner_tab_container");
    // The panes are absolutely positioned under the layout element. On
    // LeetCode that is the tabset's parent; newer flexlayout versions wrap
    // each tabset in a container first.
    const layout = tabset.closest(".flexlayout__layout") || tabset.parentElement;
    if (!container || !layout) return;
    const built = buildTab(container);
    if (!built) return;
    const { tab, divider } = built;
    placeTab(container, tab, divider);

    const panel = buildPanel();
    layout.appendChild(panel.host);

    const m = {
      tabset, container, layout, tab, divider, host: panel.host, panel,
      selectedAtActivation: null, inertPane: null, cleanup: null,
    };
    tab.setAttribute("aria-selected", "false");
    mounted = m;
    // A fresh panel has an empty feed; the cached item nodes move into it on
    // the next render.
    feedDirty = true;
    renderedSlug = undefined;
    sampleTheme(m);
    syncRect();

    // LeetCode selects a tab on mousedown, not click: by the time the mouse
    // is released its own handlers have already re-rendered under the pointer,
    // and the browser never delivers a click to our button (observed live).
    // So ours follows the same rule, on pointerdown. A real click is still
    // handled too, for keyboard activation and synthetic clicks; activating
    // twice is harmless. Pressing any other tab in this strip closes ours.
    const onStripPress = (event) => {
      if (event.type === "pointerdown" && event.button !== 0) return;
      const button = event.target.closest && event.target.closest(".flexlayout__tab_button");
      if (!button) return;
      if (button === tab) activate();
      else deactivate();
    };
    container.addEventListener("pointerdown", onStripPress, true);
    container.addEventListener("click", onStripPress, true);

    // LeetCode itself switches tabs (e.g. to Test Result after a Run). The
    // panel only covers a tab it didn't select, so when the page's own
    // selection moves, ours steps aside.
    const strip = new MutationObserver(() => {
      // LeetCode adds and removes tabs (Accepted after a Submit, for one);
      // ours stays right after Description. A move only happens when the
      // spot is wrong, so the mutations it causes settle on the next call.
      placeTab(container, tab, divider);
      if (!active) return;
      const now = selectedRealButton(m);
      if ((now ? labelOf(now) : null) !== m.selectedAtActivation) deactivate();
    });
    strip.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

    const rects = new MutationObserver(syncRect);
    rects.observe(tabset, { attributes: true, attributeFilter: ["style"] });
    const resize = new ResizeObserver(syncRect);
    resize.observe(layout);
    const content = tabset.querySelector(".flexlayout__tabset_content");
    if (content) resize.observe(content);
    window.addEventListener("resize", syncRect);
    const panelSize = observePanelSize(panel);

    const theme = new MutationObserver(() => mounted && sampleTheme(mounted));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    theme.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });

    wireComposer(panel);

    m.cleanup = () => {
      container.removeEventListener("pointerdown", onStripPress, true);
      container.removeEventListener("click", onStripPress, true);
      strip.disconnect();
      rects.disconnect();
      resize.disconnect();
      panelSize.disconnect();
      theme.disconnect();
      window.removeEventListener("resize", syncRect);
      tab.remove();
      if (divider) divider.remove();
      panel.host.remove();
    };
    setUnread(unread);
    setNativeReason(nativeReason);
    render();
  }

  function wireComposer(panel) {
    panel.input.addEventListener("input", () => {
      fitInput(panel);
      updateCounter(panel);
      panel.send.disabled = panel.input.disabled || sending || !panel.input.value.trim() || panel.input.value.length > MAX_MESSAGE_CHARS;
      // They are editing; a complaint about the previous attempt no longer
      // applies.
      panel.hint.hidden = true;
    });
    panel.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendTyped();
      }
    });
    panel.send.addEventListener("click", sendTyped);
    // The rounded box is what reads as the input, but the textarea leaves
    // its padding and rims uncovered; a press there would otherwise land on
    // nothing focusable and typing would go nowhere. Pressing the textarea
    // itself or a button keeps the browser's own handling (caret placement,
    // selection, Send).
    panel.box.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target === panel.input || (target.closest && target.closest("button"))) return;
      // Keeps the browser from blurring the textarea or starting a selection
      // in the box.
      event.preventDefault();
      if (panel.input.disabled) return;
      const focused = panel.input.getRootNode().activeElement === panel.input;
      panel.input.focus({ preventScroll: true });
      if (!focused) {
        const end = panel.input.value.length;
        panel.input.setSelectionRange(end, end);
      }
    });
  }

  // Keeps the tab present across LeetCode's own re-renders and SPA
  // navigation, and drops it if the layout it lived in is gone.
  let lastSlug = null;
  function ensureMounted() {
    if (layoutMode === "pending") {
      // The bridge has not answered yet. Once the page has a layout, it gets
      // a few seconds before the injected tab takes over.
      if (findTabset()) {
        if (!pendingSince) pendingSince = Date.now();
        else if (Date.now() - pendingSince > BRIDGE_WAIT_MS) useClone("bridge-no-answer");
      }
      if (layoutMode === "pending") return;
    }
    if (layoutMode === "native") {
      syncNative();
    } else {
      if (mounted && (!document.contains(mounted.tab) || !document.contains(mounted.host))) teardown();
      if (!mounted) {
        mount();
      } else {
        // React re-rendered the strip; keep Tutor right after Description.
        placeTab(mounted.container, mounted.tab, mounted.divider);
      }
    }
    const slug = currentSlug();
    if (slug !== lastSlug) {
      lastSlug = slug;
      if (mounted) {
        deactivate();
        scheduleRender();
      }
    }
  }

  // ---- the native tab (layout-bridge.js) --------------------------------
  //
  // The Tutor tab is a real tab of the page's flexlayout layout: flexlayout
  // draws its button, drags, drops, splits, maximizes, selects and hides it.
  // The panel only lives in the tab's pane (the element the bridge marks)
  // and follows it when React moves or re-creates it, keeping one panel, so
  // the feed and its scroll survive every move.

  function sendBridge(cmd, extra = {}) {
    document.dispatchEvent(new CustomEvent("lc-tutor:layout-command", { detail: JSON.stringify({ ...extra, cmd }) }));
  }

  // Where the student last moved the Tutor tab, kept in the extension's own
  // storage on this device (LeetCode saves its layout to the account, and
  // the tab must never be in that). The bridge describes it by tab names
  // only; anything that goes wrong here means the default spot.
  const POSITION_KEY = "tutorTabPosition";
  function positionStore() {
    try {
      const api = (typeof browser !== "undefined" && browser.storage) || (typeof chrome !== "undefined" && chrome.storage) || null;
      return api && api.local && typeof api.local.get === "function" ? api.local : null;
    } catch {
      return null;
    }
  }

  async function loadPosition() {
    const store = positionStore();
    if (!store) return null;
    try {
      const got = await Promise.race([store.get(POSITION_KEY), new Promise((resolve) => setTimeout(() => resolve(null), 1000))]);
      const value = got && got[POSITION_KEY];
      return value && typeof value === "object" && JSON.stringify(value).length < 4000 ? value : null;
    } catch {
      return null;
    }
  }

  function savePosition(value) {
    const store = positionStore();
    if (!store || !value || typeof value !== "object" || JSON.stringify(value).length >= 4000) return;
    try {
      const pending = store.set({ [POSITION_KEY]: value });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {
      // not saved: the next page load uses the default spot
    }
  }

  function startBridge() {
    const runtime = typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function" ? chrome.runtime : null;
    if (!runtime) {
      layoutMode = "clone";
      setNativeReason("no-extension-runtime");
      return;
    }
    document.addEventListener("lc-tutor:layout-state", (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.detail === "string" ? event.detail : "");
      } catch {
        return;
      }
      if (!msg || msg.ready) return;
      if (msg.native === false) {
        useClone(typeof msg.reason === "string" && msg.reason ? msg.reason : "unknown");
      } else if (msg.native === true) {
        // Also after a give-up: the bridge tries again once the page's
        // layout changes (React drew it again, a new Model, a navigation),
        // and the injected tab steps aside for the real one.
        if (layoutMode === "clone" && mounted) teardown();
        layoutMode = "native";
        nativeState = msg;
        setNativeReason(null);
        syncNative();
      }
    });
    const script = document.createElement("script");
    script.id = "lc-tutor-layout-bridge";
    try {
      script.src = runtime.getURL("layout-bridge.js");
    } catch {
      layoutMode = "clone";
      setNativeReason("bridge-url-failed");
      return;
    }
    document.addEventListener("lc-tutor:layout-position", (event) => {
      try {
        const msg = JSON.parse(typeof event.detail === "string" ? event.detail : "");
        if (msg && msg.position) savePosition(msg.position);
      } catch {
        // ignore a malformed report
      }
    });
    script.onload = () => {
      script.remove();
      loadPosition().then((position) => sendBridge("start", { position }));
    };
    script.onerror = () => {
      script.remove();
      useClone("bridge-load-failed");
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // The injected tab: the bridge could not start, did not answer in time,
  // or gave up (its tab is already out of the layout then, and it keeps
  // watching, so the real tab can come back; see the layout-state handler).
  function useClone(reason) {
    setNativeReason(reason);
    if (layoutMode === "clone") return;
    const wasNative = layoutMode === "native";
    layoutMode = "clone";
    if (wasNative && mounted) teardown();
    ensureMounted();
    setNativeReason(reason);
  }

  // Why the injected tab stands in for the real one, kept where a tester on
  // the live page can read it (the console, and data-native-reason on
  // #lc-tutor-panel-host); null once the real tab is back.
  let nativeReason = null;
  function setNativeReason(reason) {
    if (reason && reason !== nativeReason) {
      console.warn(`LeetCode Capture: the Tutor tab is the injected copy, not a real tab of the page's layout (${reason}).`);
    }
    nativeReason = reason || null;
    const host = mounted && mounted.host;
    if (!host) return;
    if (nativeReason && !mounted.native) host.setAttribute("data-native-reason", nativeReason);
    else host.removeAttribute("data-native-reason");
  }

  let nativeState = { present: false, visible: false };
  let focusWanted = 0;

  function buildNative() {
    const panel = buildPanel();
    panel.host.setAttribute("data-native", "");
    panel.host.setAttribute("data-active", "");
    panel.host.style.inset = "0";
    const panelSize = observePanelSize(panel);
    const theme = new MutationObserver(() => mounted && mounted.native && mounted.pane && sampleTheme(mounted));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    theme.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
    wireComposer(panel);
    // Pressing the Tutor tab is asking to type to the tutor, as it was for
    // the injected tab; flexlayout selects it on its own.
    const onPress = (event) => {
      if (event.type === "pointerdown" && event.button !== 0) return;
      const button = event.target.closest && event.target.closest(`[${BUTTON_ATTR}]`);
      if (!button) return;
      focusWanted = Date.now();
      setTimeout(syncNative, 0);
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("click", onPress, true);
    return {
      native: true, panel, host: panel.host, pane: null, tab: null, tabset: null, container: null, layout: null,
      cleanup: () => {
        document.removeEventListener("pointerdown", onPress, true);
        document.removeEventListener("click", onPress, true);
        panelSize.disconnect();
        theme.disconnect();
        panel.host.remove();
      },
    };
  }

  function syncNative() {
    if (layoutMode !== "native") return;
    if (!mounted) {
      if (!nativePanel) nativePanel = buildNative();
      mounted = nativePanel;
      feedDirty = true;
      renderedSlug = undefined;
    }
    const m = mounted;
    const pane = document.querySelector(`[${PANE_ATTR}]`);
    const button = document.querySelector(`[${BUTTON_ATTR}]`);
    if (!button || !nativeState.present) {
      // Between two renders, or the layout is gone (the panel and its feed
      // are kept for when it comes back).
      if (m.host.isConnected && (!pane || !pane.contains(m.host))) m.host.remove();
      active = false;
      return;
    }
    // A tab's pane exists only once it has been shown.
    if (!pane) {
      if (m.host.isConnected) m.host.remove();
    } else if (m.host.parentNode !== pane) {
      pane.appendChild(m.host);
    }
    const tabsChanged = m.tab !== button;
    m.pane = pane;
    m.tab = button;
    m.container = button.parentElement;
    m.tabset = button.closest(".flexlayout__tabset");
    m.layout = button.closest(".flexlayout__layout");
    button.setAttribute(TAB_ATTR, "");
    button.setAttribute("aria-selected", nativeState.visible ? "true" : "false");
    if (tabsChanged) setUnread(unread);
    const shown = !!nativeState.visible && !!pane && pane.getBoundingClientRect().width > 0;
    if (shown && !active) {
      active = true;
      if (m.tabset) sampleTheme(m);
      setUnread(false);
      m.panel.hint.hidden = true;
      render();
      keepScrollAnchor(m.panel);
    } else if (!shown && active) {
      active = false;
    }
    if (shown && focusWanted && Date.now() - focusWanted < 1500) {
      focusWanted = 0;
      setTimeout(() => {
        if (active && mounted && !mounted.panel.input.disabled) mounted.panel.input.focus({ preventScroll: true });
      }, 0);
    }
  }

  async function sendTyped() {
    if (!mounted) return;
    const p = mounted.panel;
    const text = p.input.value.trim();
    const slug = currentSlug();
    // A second Enter while the first POST is in flight would send the same
    // message again and cost a second tutor turn. The text stays visible but
    // read-only until the relay answers.
    if (sending || !text || p.input.value.length > MAX_MESSAGE_CHARS || !slug || p.input.disabled) return;
    sending = true;
    p.input.readOnly = true;
    p.send.disabled = true;
    p.hint.hidden = true;
    try {
      // The live editor code goes with the message, so the companion can
      // tell the tutor what changed since it last saw the code.
      const snapshot = await requestEditorSnapshot(document);
      const { body, codeLeftOut } = buildMessageBody(text, slug, snapshot);
      // This tab holds the active problem now (the helper launcher's rule
      // for which tab closing resets the tutor).
      postToWorker({ type: "active" });
      const res = await transport.send(body);
      if (res.status === 202) {
        p.input.value = "";
        fitInput(p);
        updateCounter(p);
        // Their own message and the reply should come into view even if they
        // had scrolled up to reread something, until they scroll up again.
        p.view.follow = true;
        scrollPanelTo(p, p.scroll.scrollHeight);
        if (codeLeftOut || !snapshot) {
          p.hint.textContent = codeLeftOut ? CODE_TOO_LONG : EDITOR_READ_FAILED;
          p.hint.hidden = false;
        }
      } else if (res.status === 503) {
        state.companionOnline = false;
        p.hint.textContent = "The tutor went offline. Your message wasn't sent.";
        p.hint.hidden = false;
      } else if (res.status === 413 || (res.status === 400 && text.length > MAX_MESSAGE_CHARS)) {
        p.hint.textContent = `That message is too long (${MAX_MESSAGE_CHARS} characters at most).`;
        p.hint.hidden = false;
      } else if (res.status === 400) {
        // What else the relay refuses: a message that is nothing but control
        // characters, or a page whose problem slug it doesn't accept.
        p.hint.textContent = "The relay refused that message. Edit it and try again.";
        p.hint.hidden = false;
      } else {
        p.hint.textContent = "Couldn't send that message.";
        p.hint.hidden = false;
      }
    } catch {
      // Deliberately does not touch sourceReachable: that is the event
      // stream's to report. One slow or aborted send says nothing about
      // whether the stream is healthy.
      p.hint.textContent = transport.unreachableHint;
      p.hint.hidden = false;
    } finally {
      sending = false;
      p.input.readOnly = false;
    }
    scheduleRender();
    p.input.focus({ preventScroll: true });
  }

  // ---- the model switcher ----------------------------------------------------
  //
  // The header's model button opens a listbox of the saved models (profiles,
  // see shared/profiles.js) the worker lists on its port: only non-secret
  // fields (id, name, provider, model, where it runs, whether it can be used
  // and why not). Choosing one switches with one click: through the worker
  // for the browser runtime, through the relay's POST /panel/switch-profile
  // for one that runs through the helper while the helper is in use. Either
  // way the switch waits for a reply already running, the light says
  // "Switching" meanwhile, and the chat and the code move to the new model.
  // Moving between the browser and the helper starts the other runtime's own
  // session, since the two keep separate conversations.
  // Keyboard: Enter, Space or the arrows open it; arrows, Home and End move;
  // Enter or Space choose; Escape closes and puts focus back on the button.

  let profiles = []; // the worker's entries
  let activeProfileId = null;
  let switching = null; // the id being switched to
  let relaySwitchPending = null; // an id the helper's companion should take once it is here
  const pendingSwitches = new Map(); // reqId -> { resolve, reject, timer }
  let nextSwitchId = 1;
  // A switch waits behind a reply that may run for minutes.
  const SWITCH_TIMEOUT_MS = 180000;
  const MANAGE = "\u0000manage";

  function validEntry(e) {
    return e && typeof e.id === "string" && typeof e.name === "string" && (e.runtime === "extension" || e.runtime === "helper");
  }

  function activeEntry() {
    return profiles.find((e) => e.id === activeProfileId) || null;
  }

  // Why an entry cannot be chosen right now, or null. The worker says so for
  // what it can see; the panel knows whether the helper's tutor answers.
  function entryReason(entry) {
    if (!entry.available) return entry.reason || "Not available";
    if (entry.runtime === "helper" && transport === relayTransport && (sourceReachable === false || state.companionOnline === false)) {
      return "Helper app isn't running";
    }
    return null;
  }

  function entryMeta(entry) {
    const reason = entryReason(entry);
    if (reason) return reason;
    const parts = [entry.providerLabel];
    if (entry.model && entry.model !== entry.name) parts.push(entry.model);
    return parts.join(" \u00b7 ");
  }

  function optionNodes(p) {
    return [...p.menu.querySelectorAll('.opt:not([aria-disabled="true"])')];
  }

  function renderMenu(p) {
    const focusedId = p.menu.contains(p.menu.getRootNode().activeElement) ? p.menu.getRootNode().activeElement.dataset.id : null;
    const items = [];
    for (const entry of profiles) {
      const reason = entryReason(entry);
      const opt = el("div", "opt");
      opt.setAttribute("role", "option");
      opt.tabIndex = -1;
      opt.dataset.id = entry.id;
      opt.id = `lc-tutor-model-${entry.id}`;
      opt.setAttribute("aria-selected", String(entry.id === activeProfileId));
      if (reason) opt.setAttribute("aria-disabled", "true");
      const check = el("span", "check");
      check.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
      const text = el("span", "opt-text");
      text.append(el("span", "opt-name", entry.name), el("span", "opt-meta", entryMeta(entry)));
      opt.title = reason ? `${entry.name}: ${reason}` : entry.name;
      opt.append(check, text);
      items.push(opt);
    }
    if (items.length) {
      const sep = el("div", "sep");
      sep.setAttribute("role", "separator");
      items.push(sep);
    }
    const manage = el("div", "opt manage");
    manage.setAttribute("role", "option");
    manage.setAttribute("aria-selected", "false");
    manage.tabIndex = -1;
    manage.dataset.id = MANAGE;
    const pad = el("span", "check");
    manage.append(pad, el("span", "opt-text", "Manage models..."));
    items.push(manage);
    // Rebuilt only when what it shows changed, so focus and hover stay put.
    const key = JSON.stringify(items.map((n) => n.outerHTML));
    if (p.menu.dataset.key === key) return;
    p.menu.dataset.key = key;
    p.menu.replaceChildren(...items);
    const again = focusedId && optionNodes(p).find((n) => n.dataset.id === focusedId);
    if (again) again.focus({ preventScroll: true });
  }

  function openMenu(p, focus = "active") {
    renderMenu(p);
    p.menu.hidden = false;
    p.model.setAttribute("aria-expanded", "true");
    const opts = optionNodes(p);
    const target =
      focus === "last" ? opts[opts.length - 1] : opts.find((n) => n.getAttribute("aria-selected") === "true") || opts[0];
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    }
  }

  function closeMenu(p, returnFocus) {
    if (p.menu.hidden) return;
    p.menu.hidden = true;
    p.model.setAttribute("aria-expanded", "false");
    if (returnFocus) p.model.focus({ preventScroll: true });
  }

  function activateOption(p, node) {
    if (!node || node.getAttribute("aria-disabled") === "true") return;
    closeMenu(p, true);
    if (node.dataset.id === MANAGE) openSettings();
    else chooseProfile(node.dataset.id);
  }

  function wireSwitcher(p) {
    p.model.addEventListener("click", () => {
      if (p.menu.hidden) openMenu(p);
      else closeMenu(p, true);
    });
    p.model.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu(p, e.key === "ArrowUp" ? "last" : "active");
      }
    });
    p.menu.addEventListener("keydown", (e) => {
      const opts = optionNodes(p);
      const root = p.menu.getRootNode();
      const i = opts.indexOf(root.activeElement);
      const move = (to) => {
        e.preventDefault();
        const node = opts[(to + opts.length) % opts.length];
        if (node) {
          node.focus({ preventScroll: true });
          node.scrollIntoView({ block: "nearest" });
        }
      };
      if (e.key === "ArrowDown") move(i + 1);
      else if (e.key === "ArrowUp") move(i < 0 ? opts.length - 1 : i - 1);
      else if (e.key === "Home") move(0);
      else if (e.key === "End") move(opts.length - 1);
      else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activateOption(p, opts[i]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeMenu(p, true);
      } else if (e.key === "Tab") {
        closeMenu(p, false);
      }
    });
    p.menu.addEventListener("click", (e) => {
      const node = e.target.closest(".opt");
      if (node) activateOption(p, node);
    });
    // Moving the pointer over an entry moves the focus there too, as in a
    // native select, so the keyboard carries on from where the pointer is.
    p.menu.addEventListener("pointermove", (e) => {
      const node = e.target.closest('.opt:not([aria-disabled="true"])');
      if (node && p.menu.getRootNode().activeElement !== node) node.focus({ preventScroll: true });
    });
    // A press anywhere else closes it.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (p.menu.hidden) return;
        const path = e.composedPath();
        if (!path.includes(p.menu) && !path.includes(p.model)) closeMenu(p, false);
      },
      true
    );
  }

  function workerSwitch(id) {
    return new Promise((resolve, reject) => {
      const reqId = nextSwitchId++;
      const timer = setTimeout(() => {
        pendingSwitches.delete(reqId);
        reject(new Error("timed out"));
      }, SWITCH_TIMEOUT_MS);
      pendingSwitches.set(reqId, { resolve, reject, timer });
      if (!postToWorker({ type: "switch-profile", reqId, id })) {
        pendingSwitches.delete(reqId);
        clearTimeout(timer);
        reject(new Error("no worker"));
      }
    });
  }

  async function relaySwitch(id) {
    const res = await fetch(`${RELAY_BASE}/panel/switch-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      cache: "no-store",
      signal: AbortSignal.timeout(SWITCH_TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 200 && body && body.ok) return { ok: true, runtime: "helper" };
    if (res.status === 503) return { ok: false, message: "The helper app isn't running, so the model wasn't switched." };
    const message = body && body.error && typeof body.error.message === "string" ? body.error.message : "Couldn't switch models.";
    return { ok: false, message };
  }

  function showSwitchHint(text) {
    if (!mounted) return;
    const p = mounted.panel;
    p.hint.textContent = text;
    p.hint.hidden = !text;
  }

  // One click switches. A second choice while one is switching waits its turn
  // (the first one finishes, then this one runs).
  let switchChain = Promise.resolve();
  function chooseProfile(id, { followUp = false } = {}) {
    if (!followUp && (id === activeProfileId || switching === id)) return Promise.resolve();
    const run = switchChain.then(() => runSwitch(id, followUp));
    switchChain = run.catch(() => {});
    return run;
  }

  async function runSwitch(id, followUp) {
    const entry = profiles.find((e) => e.id === id);
    if (!entry && !followUp) return;
    switching = id;
    if (!followUp) showSwitchHint("");
    scheduleRender();
    const fromTransport = transport;
    try {
      let result;
      if (followUp || (entry.runtime === "helper" && transport === relayTransport)) {
        result = await relaySwitch(id);
        if (result.ok) postToWorker({ type: "profile-switched", id });
      } else {
        result = await workerSwitch(id);
        if (result.ok && result.runtime === "helper" && fromTransport !== relayTransport) relaySwitchPending = id;
      }
      if (result.ok) {
        if (!followUp) activeProfileId = id;
      } else {
        showSwitchHint(result.message || "Couldn't switch models.");
      }
    } catch {
      showSwitchHint("Couldn't switch models. Try again.");
    } finally {
      switching = null;
      scheduleRender();
    }
  }

  // ---- transports ----------------------------------------------------------
  //
  // A transport follows the tutor's events (start/stop) and sends a typed
  // message (send(body) -> { status }, in the relay's HTTP terms: 202 queued,
  // 503 tutor offline, 413 or 400 refused). Both feed events through
  // deliver(), so everything else in this file is the same for either.

  // A first connection replays history, which is not news; only what arrives
  // after a reconnect (state.lastSeq > 0) can be unread. The source sends a
  // status event once its replay is done.
  let suppressUnread = true;
  function beginReplay() {
    suppressUnread = state.lastSeq === 0;
  }
  function deliver(event) {
    if (event.type === "status") suppressUnread = false;
    if (event.type === "status" && event.companionOnline && transport === relayTransport && relaySwitchPending) {
      // The switch moved the tutor to the helper; now that its companion is
      // here, it is asked to use the chosen model too.
      const id = relaySwitchPending;
      relaySwitchPending = null;
      setTimeout(() => chooseProfile(id, { followUp: true }), 0);
    }
    const affected = applyEvent(state, event);
    if (event.type === "turn-end" && !suppressUnread && !active && affected === currentSlug()) setUnread(true);
    noteApplied(affected);
  }

  // ---- the relay (helper runtime) ------------------------------------------

  // One open stream per *visible* tab. The browser allows only six
  // connections per host, and every leetcode tab with this script would
  // otherwise hold one for its whole life, starving captures and sends from
  // the tabs you are actually using. A hidden tab drops its stream and
  // reconnects on return, replaying what it missed from state.lastSeq.
  let streamAbort = null;
  let relayRunning = false;
  let relayStopped = true;
  const visibleWaiters = [];

  function whenVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise((resolve) => visibleWaiters.push(resolve));
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (streamAbort && transport === relayTransport) streamAbort.abort();
    } else {
      for (const resolve of visibleWaiters.splice(0)) resolve();
    }
  });

  async function streamLoop() {
    relayRunning = true;
    let delay = 1000;
    while (!relayStopped) {
      // eslint-disable-next-line no-await-in-loop
      await whenVisible();
      if (relayStopped) break;
      const abort = new AbortController();
      streamAbort = abort;
      beginReplay();
      try {
        // no-store: see panel-broker.js; two tabs must never queue behind
        // each other's open stream through the HTTP cache.
        // The epoch says which relay run lastSeq counts in; a restarted relay
        // ignores `after` from another run and replays everything it has.
        const epoch = state.epoch ? `&epoch=${encodeURIComponent(state.epoch)}` : "";
        const res = await fetch(`${RELAY_BASE}/panel/events?after=${state.lastSeq}${epoch}`, {
          headers: { Accept: "text/event-stream" },
          cache: "no-store",
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`relay answered ${res.status}`);
        sourceReachable = true;
        delay = 1000;
        scheduleRender();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const push = createSseParser(deliver);
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Fall through: either we hid the tab (or left this transport) on
        // purpose, or the relay is gone.
      }
      if (relayStopped) break;
      // Hiding the tab on purpose is not an outage.
      if (abort.signal.aborted) continue;
      sourceReachable = false;
      noteApplied(streamLost(state));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000);
    }
    relayRunning = false;
  }

  const relayTransport = {
    unreachableHint: "Couldn't reach the relay server. Try again.",
    async send(body) {
      const res = await fetch(`${RELAY_BASE}/panel/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
        // A send must never hang the composer: the browser queues a request
        // behind its per-host connection limit, so give up and say so.
        signal: AbortSignal.timeout(8000),
      });
      return { status: res.status };
    },
    start() {
      relayStopped = false;
      if (!relayRunning) streamLoop();
    },
    stop() {
      relayStopped = true;
      if (streamAbort) streamAbort.abort();
    },
  };

  // ---- the background worker (extension runtime) ----------------------------
  //
  // One port per tab to the background worker (shared/tutor-service.js). It
  // is opened in either runtime: the worker says on it which runtime the
  // options page chose ({ type: 'runtime' }), and in the extension runtime the
  // events and messages travel on it too. A ping every 20 seconds keeps the
  // worker running while a problem page is open. A worker that restarted
  // drops the port; the panel reconnects, and the new run's epoch tells
  // applyEvent the session restarted.
  const PANEL_PORT = "lc-tutor-panel";
  const PING_MS = 20000;
  const SEND_TIMEOUT_MS = 8000;
  let bgPort = null;
  let bgDelay = 500;
  let providerChosen = null; // from the worker: whether a provider is chosen at all
  // From the worker: the Native Messaging helper's state when the extension
  // is set to launch it ("not-installed", "error", ...), or null.
  let helperState = null;
  const HELPER_HINTS = {
    "not-installed": "Or set up the helper app in Settings (the gear above) so the tutor starts on its own.",
    error: "The helper app could not start the tutor; Settings (the gear above) shows why.",
  };
  const pendingReplies = new Map(); // id -> { resolve, reject, timer }
  let nextReplyId = 1;

  function extensionRuntime() {
    const runtime =
      (typeof browser !== "undefined" && browser.runtime) || (typeof chrome !== "undefined" && chrome.runtime) || null;
    return runtime && runtime.id && typeof runtime.connect === "function" ? runtime : null;
  }

  function postToWorker(message) {
    if (!bgPort) return false;
    try {
      bgPort.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  function connectWorker() {
    const runtime = extensionRuntime();
    if (!runtime) return false;
    let port;
    try {
      port = runtime.connect({ name: PANEL_PORT });
    } catch {
      return false;
    }
    bgPort = port;
    port.onMessage.addListener((message) => {
      if (port !== bgPort || !message || typeof message !== "object") return;
      bgDelay = 500;
      if (message.type === "runtime") {
        providerChosen = message.chosen !== false;
        useTransport(message.runtime === "extension" ? extensionTransport : relayTransport);
      } else if (message.type === "helper") {
        helperState = typeof message.state === "string" ? message.state : null;
        scheduleRender();
      } else if (message.type === "profiles") {
        profiles = Array.isArray(message.profiles) ? message.profiles.filter(validEntry) : [];
        activeProfileId = typeof message.active === "string" ? message.active : null;
        scheduleRender();
      } else if (message.type === "switch-result") {
        const pending = pendingSwitches.get(message.reqId);
        if (!pending) return;
        pendingSwitches.delete(message.reqId);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } else if (message.type === "event" && transport === extensionTransport && message.event) {
        if (sourceReachable !== true) {
          sourceReachable = true;
          scheduleRender();
        }
        deliver(message.event);
      } else if (message.type === "reply") {
        const pending = pendingReplies.get(message.id);
        if (!pending) return;
        pendingReplies.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    });
    port.onDisconnect.addListener(() => {
      if (port !== bgPort) return;
      bgPort = null;
      for (const map of [pendingReplies, pendingSwitches]) {
        for (const [id, pending] of map) {
          map.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new Error("disconnected"));
        }
      }
      if (transport === extensionTransport) {
        sourceReachable = false;
        noteApplied(streamLost(state));
      }
      // The extension was reloaded or removed under this page: there is no
      // worker to come back to.
      if (!extensionRuntime()) return;
      setTimeout(() => {
        if (!bgPort) connectWorker();
      }, bgDelay);
      bgDelay = Math.min(bgDelay * 2, 10000);
    });
    // The worker says which runtime first; in the extension runtime that is
    // when this port subscribes (useTransport).
    return true;
  }

  setInterval(() => postToWorker({ type: "ping" }), PING_MS);

  // What the worker answers, in the relay's HTTP terms.
  const REPLY_STATUS = { "too-long": 413, invalid: 400, helper: 503 };

  const extensionTransport = {
    unreachableHint: "Couldn't reach the extension's tutor. Try again.",
    send(body) {
      return new Promise((resolve, reject) => {
        const id = nextReplyId++;
        const timer = setTimeout(() => {
          pendingReplies.delete(id);
          reject(new Error("timed out"));
        }, SEND_TIMEOUT_MS);
        pendingReplies.set(id, {
          resolve: (reply) => resolve({ status: reply.ok ? 202 : REPLY_STATUS[reply.error] || 500 }),
          reject,
          timer,
        });
        if (!postToWorker({ type: "message", id, ...JSON.parse(body) })) {
          pendingReplies.delete(id);
          clearTimeout(timer);
          reject(new Error("no worker"));
        }
      });
    },
    start() {
      beginReplay();
      postToWorker({ type: "subscribe", after: state.lastSeq, epoch: state.epoch });
    },
    stop() {
      postToWorker({ type: "unsubscribe" });
    },
  };

  // The transport in use, or null before the worker said which runtime.
  let transport = null;
  function useTransport(next) {
    if (transport === next) {
      // A reconnected port in the extension runtime subscribes again.
      if (next === extensionTransport) next.start();
      return;
    }
    if (transport) {
      transport.stop();
      // The other source starts from nothing known about it.
      sourceReachable = null;
      state.companionOnline = null;
      state.companionBusy = false;
      noteApplied(streamLost(state));
    }
    transport = next;
    transport.start();
    scheduleRender();
  }

  function start() {
    const pageStyle = document.createElement("style");
    pageStyle.textContent = PAGE_CSS;
    document.head.appendChild(pageStyle);

    startBridge();
    ensureMounted();
    // LeetCode builds its layout after document_idle and swaps it on
    // navigation, so keep checking; each check is a couple of DOM lookups.
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        ensureMounted();
      }, 250);
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(ensureMounted, 2000);

    // LeetCode shows the result of a Run or Submit in its own tab. When the
    // student triggers one while the panel is open, step aside the same way,
    // even in the case the page's own selection doesn't visibly change (the
    // result tab was already the one underneath).
    document.addEventListener("leetcode-capture:capture-start", () => deactivate());
    // A Run or Submit content.js could not read: it was not captured, so the
    // only trace is this note in the current problem's transcript.
    document.addEventListener("leetcode-capture:editor-read-failed", () => {
      const slug = currentSlug();
      if (!slug) return;
      const affected = applyEvent(state, { type: "notice", problemSlug: slug, text: EDITOR_READ_FAILED });
      if (!active) setUnread(true);
      noteApplied(affected);
    });

    // Not running as an extension (the e2e fixture injects this script into
    // a plain page): the relay is the only way to the tutor.
    if (!connectWorker()) useTransport(relayTransport);
  }

  start();
})();
