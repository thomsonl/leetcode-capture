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
// All the intelligence stays in the local companion process. This script only
// talks to the relay server on localhost:8135 (the same host the capture
// script already uses): it streams events from GET /panel/events and posts
// typed messages to POST /panel/message. See relay-server/panel-broker.js for
// the protocol and its origin checks.
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
      lastSeq: 0,
      // The relay run that lastSeq counts in. Sequence numbers restart at 1
      // when the relay restarts, so a seq means nothing without its epoch.
      epoch: null,
      byProblem: new Map(), // slug -> items[]
      turnProblem: new Map(), // turnId -> slug, so a chunk (which has no slug) finds its turn
    };
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
      // The companion left (it exited, crashed, or its terminal closed), so
      // nothing will end a reply it was still streaming. The relay ends
      // those itself (a turn-end marked interrupted, see panel-broker.js's
      // closeOpenTurns); this covers a relay started before it did.
      if (!state.companionOnline && interruptPending(state)) return RESTARTED;
      if (state.companionOnline && Array.isArray(event.openTurns) && reviveOpen(state, event.openTurns)) return RESTARTED;
      return null;
    }
    // Replays after a reconnect can overlap what we already have.
    if (typeof event.seq === "number") {
      if (event.seq <= state.lastSeq) return null;
      state.lastSeq = event.seq;
    }
    const slug = event.problemSlug || "";
    switch (event.type) {
      case "user":
        pushItem(state, slug, { kind: "user", text: event.text || "" });
        return slug;
      case "capture":
        pushItem(state, slug, {
          kind: "capture",
          trigger: event.trigger,
          attemptSeq: event.attemptSeq,
          title: event.problemTitle || null,
          // A quiet note on the chip: a Run is kept for the next message,
          // not sent to the tutor.
          note: typeof event.note === "string" && event.note ? event.note : null,
        });
        return slug;
      case "notice":
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

  // Linear in the length of `text` (times the nesting cap above): every scan
  // forward is either consumed by a match or cached for the positions after
  // it. The link rule in particular used to re-run a regex on text.slice(i)
  // at every "[", which was quadratic on a long run of unmatched brackets
  // and ran again on every streamed chunk.
  function parseInline(text, depth = 0) {
    if (depth > MAX_INLINE_DEPTH) return text ? [{ t: "text", v: text }] : [];
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
      if (buf) nodes.push({ t: "text", v: buf });
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

  const FENCE_RE = /^\s*```\s*([\w+#.-]*)\s*$/;
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
        const code = [];
        i += 1;
        let closed = false;
        while (i < lines.length) {
          if (/^\s*```\s*$/.test(lines[i])) {
            closed = true;
            i += 1;
            break;
          }
          code.push(lines[i]);
          i += 1;
        }
        blocks.push({ t: "code", lang: fence[1] || "", v: code.join("\n"), open: !closed });
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
          } else if (lines[i].trim() && /^\s+\S/.test(lines[i]) && entries.length) {
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

  function renderInline(nodes, doc) {
    const frag = doc.createDocumentFragment();
    for (const node of nodes) {
      if (node.t === "text") {
        frag.appendChild(doc.createTextNode(node.v));
      } else if (node.t === "code") {
        const el = doc.createElement("code");
        el.textContent = node.v;
        frag.appendChild(el);
      } else if (node.t === "strong" || node.t === "em" || node.t === "del") {
        const el = doc.createElement(node.t);
        el.appendChild(renderInline(node.c, doc));
        frag.appendChild(el);
      } else if (node.t === "link") {
        const el = doc.createElement("a");
        el.href = node.href;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
        el.appendChild(renderInline(node.c, doc));
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
          th.appendChild(renderInline(cell, doc));
          headRow.appendChild(th);
        }
        head.appendChild(headRow);
        const body = doc.createElement("tbody");
        for (const row of block.rows) {
          const tr = doc.createElement("tr");
          for (const [col, cell] of row.entries()) {
            const td = doc.createElement("td");
            align(td, col);
            td.appendChild(renderInline(cell, doc));
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
  // message then goes without it and the companion uses the newest recorded
  // Run or Submit instead. `target` is injectable for panel.test.js.
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
  // companion then uses the newest Run or Submit instead.
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
      firstChangedBlock,
      parseInline,
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
  const TUTOR_COLOR = "rgb(150, 115, 255)";
  const MAX_MESSAGE_CHARS = 8000;

  const state = createState();
  let relayReachable = null; // null until the first connect attempt settles
  let active = false;
  let unread = false;
  let mounted = null; // { tabset, container, tab, divider, host, layout, ... }
  let renderQueued = false;
  let sending = false; // a typed message's POST is in flight

  const PAGE_CSS = `
    [${TAB_ATTR}] .lc-tutor-dot { display: none; width: 6px; height: 6px; margin-left: 2px; border-radius: 50%; background: #ef4743; }
    [${TAB_ATTR}][data-unread] .lc-tutor-dot { display: block; }
    body[${ACTIVE_ATTR}] .flexlayout__tabset:has([${TAB_ATTR}]) .flexlayout__tab_button--selected:not([${TAB_ATTR}]) {
      color: var(--lc-tutor-muted, rgba(255, 255, 255, 0.6));
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
    :host([data-active]) { display: block; }
    * { box-sizing: border-box; }
    .wrap {
      position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden;
      border-radius: 0 0 8px 8px; background: var(--bg); color: var(--body);
      font: 400 14px/21px var(--font);
    }
    .scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; display: flex; flex-direction: column; padding: 20px 16px; color-scheme: var(--scheme); }
    .head {
      flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
      height: 32px; margin: 0 1px; padding: 0 12px; border-bottom: 1px solid var(--head-line); color: var(--muted);
    }
    .head-left, .head-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .head-right { flex: none; }
    .status { display: flex; align-items: center; gap: 4px; font-size: 14px; line-height: 20px; color: var(--muted); white-space: nowrap; }
    .status svg { width: 14px; height: 14px; flex: none; }
    .status[data-ok] svg { color: var(--green); }
    .feed { flex: 1 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .banner { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; background: var(--fill); color: var(--muted); }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 12px; margin: auto; padding: 0 24px; color: color-mix(in srgb, var(--fg) 30%, transparent); text-align: center; }
    .empty p { margin: 0; max-width: 300px; }
    .chip { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px; background: var(--fill); font-size: 12px; line-height: 16px; color: var(--muted); }
    .chip b { font-weight: 500; color: var(--fg); }
    .chip-note::before { content: "\\00b7"; margin-right: 6px; }
    .notice { display: flex; align-items: center; gap: 10px; font-size: 12px; line-height: 16px; color: var(--muted); }
    .notice::before, .notice::after { content: ""; flex: 1; height: 1px; background: var(--line); }
    .user { align-self: flex-end; max-width: 85%; padding: 8px 12px; border-radius: 8px; background: var(--fill); white-space: pre-wrap; overflow-wrap: anywhere; }
    .tutor { overflow-wrap: anywhere; }
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
    .tutor table { border-collapse: collapse; }
    .tutor th, .tutor td { padding: 6px 12px; border: 1px solid var(--chip-line); text-align: left; vertical-align: top; }
    .tutor [data-align="center"] { text-align: center; } .tutor [data-align="right"] { text-align: right; }
    .tutor th { font-weight: 600; color: var(--fg); background: var(--fill); }
    .tutor strong { font-weight: 600; }
    .tutor a { color: var(--link); text-decoration: none; }
    .tutor a:hover { text-decoration: underline; }
    code { font: 12px/16px Menlo, Menlo-fallback, sans-serif; padding: 2px; border-radius: 5px; background: var(--fill); border: 1px solid var(--chip-line); color: color-mix(in srgb, var(--fg) 75%, transparent); }
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
    .tutor pre code { padding: 0; border: 0; background: none; white-space: pre; font-size: 12px; line-height: 20px; color: var(--body); }
    .tutor blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 2px solid var(--line-strong); color: var(--muted); }
    .tutor hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
    .err { color: var(--red); }
    .tutor .note { margin: 0; font-size: 12px; line-height: 16px; color: var(--muted); }
    .dots { display: inline-flex; gap: 4px; padding: 6px 0; }
    .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite ease-in-out; }
    .dots i:nth-child(2) { animation-delay: 0.15s; } .dots i:nth-child(3) { animation-delay: 0.3s; }
    @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
    .composer { padding: 12px 16px 16px; border-top: 1px solid var(--line); }
    .box { display: flex; align-items: flex-end; gap: 8px; padding: 6px 6px 6px 12px; border-radius: 8px; background: var(--fill); }
    .box:focus-within { box-shadow: 0 0 0 1px color-mix(in srgb, var(--fg) 45%, transparent); }
    textarea { flex: 1; min-height: 28px; max-height: 140px; margin: 0; padding: 4px 0; border: 0; outline: 0; resize: none; background: transparent; color: var(--body); font: inherit; }
    textarea::placeholder { color: var(--muted); }
    textarea:disabled { cursor: not-allowed; }
    button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--green); cursor: pointer; }
    button:hover:not(:disabled) { background: var(--fill); }
    button:disabled { color: var(--muted); opacity: 0.5; cursor: not-allowed; }
    .hint { margin: 6px 2px 0; font-size: 12px; line-height: 16px; color: var(--muted); }
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
    style.setProperty("--body", pick(paneUnderTabset(m), "color", fg));
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
    document.documentElement.style.setProperty("--lc-tutor-muted", tabMuted);
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
    path.setAttribute("d", "M5 3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7.2L6 21.5V17H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z");
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

  // ---- the panel -------------------------------------------------------

  function svgIcon(pathData, size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }

  // Outlined circle with a check, like the native "Solved" mark; with an
  // exclamation mark instead when the tutor isn't reachable.
  const RING = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 1.8a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4z";
  const STATUS_OK = `${RING}M10.6 15.8 7.2 12.4l1.2-1.2 2.2 2.2 5-5 1.2 1.2z`;
  const STATUS_BAD = `${RING}M11.1 7h1.8v6.2h-1.8zm0 7.8h1.8v1.9h-1.8z`;

  function statusIcon() {
    return svgIcon(STATUS_BAD, 14);
  }

  function buildPanel() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;

    const wrap = el("div", "wrap");
    wrap.setAttribute("role", "tabpanel");
    wrap.setAttribute("aria-label", "Tutor");
    // A slim header row like the one Submissions opens with, fixed at the
    // top while the transcript scrolls under it: the connection status on
    // the left, and room on the right for controls (a settings gear and the
    // model's name are planned there).
    const head = el("div", "head");
    const headLeft = el("div", "head-left");
    const status = el("div", "status");
    // A polite live region: screen readers announce "Offline" and the like
    // when it changes, without interrupting.
    status.setAttribute("role", "status");
    status.appendChild(statusIcon());
    const statusText = el("span", "", "Connecting");
    status.appendChild(statusText);
    headLeft.appendChild(status);
    const headRight = el("div", "head-right");
    head.append(headLeft, headRight);

    const banner = el("div", "banner");
    banner.hidden = true;

    const scroll = el("div", "scroll");
    const feed = el("div", "feed");
    scroll.append(banner, feed);

    const composer = el("div", "composer");
    const box = el("div", "box");
    const input = document.createElement("textarea");
    input.rows = 1;
    input.placeholder = "Ask the tutor about this problem";
    input.setAttribute("aria-label", "Message the tutor");
    // The relay refuses longer messages (relay-server/panel-broker.js).
    input.maxLength = MAX_MESSAGE_CHARS;
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

    wrap.append(head, scroll, composer);
    root.append(style, wrap);

    // LeetCode binds many single-key shortcuts on the page, and this script's
    // sibling (content.js) binds Ctrl/Cmd+Enter to a Submit capture. Typing
    // here must trigger neither, so keys stop at the host.
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());

    return { host, status, statusText, headRight, banner, scroll, feed, input, send, hint };
  }

  function currentSlug() {
    return problemSlugFromPath(location.pathname);
  }

  function describeConnection() {
    if (relayReachable === false) {
      return {
        label: "Offline",
        ok: false,
        banner: "Can't reach the relay server on localhost:8135. Start the companion with `leetcode`, or run `node companion.js` in the project's companion folder.",
      };
    }
    if (state.companionOnline === false) {
      return {
        label: "Tutor offline",
        ok: false,
        banner: "The relay is running but the tutor isn't. Start the companion with `leetcode` to chat and get your attempts reviewed here.",
      };
    }
    if (state.companionOnline === null) return { label: "Connecting", ok: false, banner: null };
    return { label: "Connected", ok: true, banner: null };
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

  function emptyStateText(conn) {
    if (relayReachable === false || state.companionOnline === false) {
      // The composer is disabled and the banner above says how to start the
      // companion; don't invite a question that can't be asked.
      return "Once the companion is running, your Run and Submit attempts and the tutor's replies show up here.";
    }
    return conn.ok
      ? "Run or submit your code and the tutor will review it here. You can also ask a question about this problem below."
      : "Run or submit your code and the tutor will review it here.";
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
      if (item.note) chip.appendChild(el("span", "chip-note", item.note));
      return chip;
    }
    if (item.kind === "notice") return el("div", "notice", item.text);
    return el("div", "user", item.text);
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
    if (item.error) entry.tail.push(el("p", "err", item.error));
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
    p.status.querySelector("path").setAttribute("d", conn.ok ? STATUS_OK : STATUS_BAD);
    if (conn.ok) p.status.setAttribute("data-ok", "");
    else p.status.removeAttribute("data-ok");
    renderBanner(p.banner, conn.banner);

    const canSend = conn.ok && Boolean(slug);
    p.input.disabled = !canSend;
    p.send.disabled = !canSend || sending || !p.input.value.trim();
    p.input.placeholder = canSend ? "Ask the tutor about this problem" : "Start the companion to chat";
  }

  function render() {
    renderQueued = false;
    if (!mounted) return;
    const p = mounted.panel;
    const slug = currentSlug();
    const conn = describeConnection();
    renderHeader(p, conn, slug);

    if (!active) return;
    const emptyText = emptyStateText(conn);
    if (emptyNode && emptyNode.firstChild.textContent !== emptyText) emptyNode.firstChild.textContent = emptyText;
    if (slug !== renderedSlug) feedDirty = true;
    // Status changes and events for other problems end here: nothing in the
    // feed is touched.
    if (!feedDirty) return;
    feedDirty = false;
    renderedSlug = slug;

    const stick =
      Date.now() < mounted.stickUntil || p.scroll.scrollHeight - p.scroll.scrollTop - p.scroll.clientHeight < 80;
    const items = (slug && state.byProblem.get(slug)) || [];
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
    if (stick) p.scroll.scrollTop = p.scroll.scrollHeight;
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
    if (!mounted) return;
    const content = mounted.tabset.querySelector(".flexlayout__tabset_content");
    if (!content) return;
    const layoutRect = mounted.layout.getBoundingClientRect();
    const rect = content.getBoundingClientRect();
    const s = mounted.host.style;
    s.left = `${rect.left - layoutRect.left}px`;
    s.top = `${rect.top - layoutRect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
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
    if (!mounted || active) return;
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
    mounted.panel.scroll.scrollTop = mounted.panel.scroll.scrollHeight;
    // After the browser's own mousedown focus handling, which would otherwise
    // move focus to the tab button we are being activated from.
    setTimeout(() => {
      if (active && mounted && !mounted.panel.input.disabled) mounted.panel.input.focus({ preventScroll: true });
    }, 0);
  }

  function deactivate() {
    if (!mounted || !active) return;
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
  }

  function mount() {
    const tabset = findTabset();
    if (!tabset) return;
    const container = tabset.querySelector(".flexlayout__tabset_tabbar_inner_tab_container");
    const layout = tabset.parentElement;
    if (!container || !layout) return;
    const built = buildTab(container);
    if (!built) return;
    const { tab, divider } = built;
    if (divider) container.appendChild(divider);
    container.appendChild(tab);

    const panel = buildPanel();
    layout.appendChild(panel.host);

    const m = {
      tabset, container, layout, tab, divider, host: panel.host, panel,
      selectedAtActivation: null, inertPane: null, stickUntil: 0, cleanup: null,
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
      if (!active) return;
      const now = selectedRealButton(m);
      if ((now ? labelOf(now) : null) !== m.selectedAtActivation) deactivate();
    });
    strip.observe(container, { subtree: true, attributes: true, attributeFilter: ["class"] });

    const rects = new MutationObserver(syncRect);
    rects.observe(tabset, { attributes: true, attributeFilter: ["style"] });
    const resize = new ResizeObserver(syncRect);
    resize.observe(layout);
    const content = tabset.querySelector(".flexlayout__tabset_content");
    if (content) resize.observe(content);
    window.addEventListener("resize", syncRect);

    const theme = new MutationObserver(() => mounted && sampleTheme(mounted));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    theme.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });

    panel.input.addEventListener("input", () => {
      panel.input.style.height = "auto";
      panel.input.style.height = `${Math.min(panel.input.scrollHeight, 140)}px`;
      panel.send.disabled = panel.input.disabled || sending || !panel.input.value.trim();
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

    m.cleanup = () => {
      container.removeEventListener("pointerdown", onStripPress, true);
      container.removeEventListener("click", onStripPress, true);
      strip.disconnect();
      rects.disconnect();
      resize.disconnect();
      theme.disconnect();
      window.removeEventListener("resize", syncRect);
      tab.remove();
      if (divider) divider.remove();
      panel.host.remove();
    };
    setUnread(unread);
    render();
  }

  // Keeps the tab present across LeetCode's own re-renders and SPA
  // navigation, and drops it if the layout it lived in is gone.
  let lastSlug = null;
  function ensureMounted() {
    if (mounted && (!document.contains(mounted.tab) || !document.contains(mounted.host))) teardown();
    if (!mounted) {
      mount();
    } else if (mounted.container.lastElementChild !== mounted.tab) {
      // React appended something after us; keep Tutor last.
      mounted.container.appendChild(mounted.tab);
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

  async function sendTyped() {
    if (!mounted) return;
    const p = mounted.panel;
    const text = p.input.value.trim();
    const slug = currentSlug();
    // A second Enter while the first POST is in flight would send the same
    // message again and cost a second tutor turn. The text stays visible but
    // read-only until the relay answers.
    if (sending || !text || !slug || p.input.disabled) return;
    sending = true;
    p.input.readOnly = true;
    p.send.disabled = true;
    p.hint.hidden = true;
    try {
      // The live editor code goes with the message, so the companion can
      // tell the tutor what changed since it last saw the code.
      const snapshot = await requestEditorSnapshot(document);
      const { body, codeLeftOut } = buildMessageBody(text, slug, snapshot);
      const res = await fetch(`${RELAY_BASE}/panel/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
        // A send must never hang the composer: the browser queues a request
        // behind its per-host connection limit, so give up and say so.
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 202) {
        p.input.value = "";
        p.input.style.height = "auto";
        // Their own message and the reply should come into view even if they
        // had scrolled up to reread something.
        mounted.stickUntil = Date.now() + 4000;
        p.scroll.scrollTop = p.scroll.scrollHeight;
        if (codeLeftOut) {
          p.hint.textContent = "Your code is too long to send with a message, so the tutor sees your last Run or Submit.";
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
      // Deliberately does not touch relayReachable: that is the event
      // stream's to report. One slow or aborted POST says nothing about
      // whether the stream is healthy.
      p.hint.textContent = "Couldn't reach the relay server. Try again.";
      p.hint.hidden = false;
    } finally {
      sending = false;
      p.input.readOnly = false;
    }
    scheduleRender();
    p.input.focus({ preventScroll: true });
  }

  // ---- event stream ------------------------------------------------------

  // One open stream per *visible* tab. The browser allows only six
  // connections per host, and every leetcode tab with this script would
  // otherwise hold one for its whole life, starving captures and sends from
  // the tabs you are actually using. A hidden tab drops its stream and
  // reconnects on return, replaying what it missed from state.lastSeq.
  let streamAbort = null;
  const visibleWaiters = [];

  function whenVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise((resolve) => visibleWaiters.push(resolve));
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (streamAbort) streamAbort.abort();
    } else {
      for (const resolve of visibleWaiters.splice(0)) resolve();
    }
  });

  async function streamLoop() {
    let delay = 1000;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await whenVisible();
      const abort = new AbortController();
      streamAbort = abort;
      // A first connection replays history, which is not news; only what
      // arrives after a reconnect (state.lastSeq > 0) can be unread. The relay
      // sends a status event once the replay is done.
      let suppressUnread = state.lastSeq === 0;
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
        relayReachable = true;
        delay = 1000;
        scheduleRender();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const push = createSseParser((event) => {
          if (event.type === "status") suppressUnread = false;
          const affected = applyEvent(state, event);
          if (event.type === "turn-end" && !suppressUnread && !active && affected === currentSlug()) setUnread(true);
          noteApplied(affected);
        });
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Fall through: either we hid the tab on purpose, or the relay is gone.
      }
      // Hiding the tab on purpose is not an outage.
      if (abort.signal.aborted) continue;
      relayReachable = false;
      noteApplied(streamLost(state));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000);
    }
  }

  function start() {
    const pageStyle = document.createElement("style");
    pageStyle.textContent = PAGE_CSS;
    document.head.appendChild(pageStyle);

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

    streamLoop();
  }

  start();
})();
