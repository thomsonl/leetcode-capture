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

  // Applies one relay event. Returns the problem slug it affected (or null),
  // so the caller can re-render only when that problem is on screen.
  function applyEvent(state, event) {
    if (event.type === "status") {
      state.companionOnline = Boolean(event.companionOnline);
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
        itemsFor(state, slug).push({ kind: "user", text: event.text || "" });
        break;
      case "capture":
        itemsFor(state, slug).push({
          kind: "capture",
          trigger: event.trigger,
          attemptSeq: event.attemptSeq,
          title: event.problemTitle || null,
        });
        break;
      case "notice":
        itemsFor(state, slug).push({ kind: "notice", text: event.text || "" });
        break;
      case "turn-start":
        if (state.turnProblem.has(event.turnId)) return null;
        state.turnProblem.set(event.turnId, slug);
        itemsFor(state, slug).push({ kind: "tutor", turnId: event.turnId, text: "", pending: true, error: null });
        break;
      case "chunk": {
        const turn = findTurn(state, event.turnId);
        if (!turn) return null;
        turn.text += event.text || "";
        return state.turnProblem.get(event.turnId);
      }
      case "turn-end": {
        let turn = findTurn(state, event.turnId);
        if (!turn) {
          // Joined after the turn started and its start was already trimmed.
          state.turnProblem.set(event.turnId, slug);
          turn = { kind: "tutor", turnId: event.turnId, text: "", pending: true, error: null };
          itemsFor(state, slug).push(turn);
        }
        if (typeof event.text === "string") turn.text = event.text;
        turn.error = event.error || null;
        turn.pending = false;
        return state.turnProblem.get(event.turnId);
      }
      default:
        return null;
    }
    const items = itemsFor(state, slug);
    if (items.length > MAX_ITEMS_PER_PROBLEM) items.splice(0, items.length - MAX_ITEMS_PER_PROBLEM);
    return slug;
  }

  // ---------------------------------------------------------------------
  // Markdown (just what a tutor reply uses)
  // ---------------------------------------------------------------------

  function parseInline(text) {
    const nodes = [];
    let buf = "";
    let i = 0;
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
      if (text.startsWith("**", i) || text.startsWith("__", i)) {
        const marker = text.slice(i, i + 2);
        const end = text.indexOf(marker, i + 2);
        const inner = end > i + 2 ? text.slice(i + 2, end) : "";
        // `__init__` / `__main__` are identifiers, not emphasis (CommonMark
        // would bold them, but a coding tutor mentions them constantly).
        const isDunder = marker === "__" && /^\w+$/.test(inner);
        if (end > i + 2 && !isDunder && !/^\s/.test(inner) && !/\s$/.test(inner)) {
          flush();
          nodes.push({ t: "strong", c: parseInline(text.slice(i + 2, end)) });
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
            nodes.push({ t: "em", c: parseInline(text.slice(i + 1, end)) });
            i = end + 1;
            continue;
          }
        }
      }
      if (ch === "[") {
        const match = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(text.slice(i));
        if (match) {
          flush();
          nodes.push({ t: "link", href: match[2], c: parseInline(match[1]) });
          i += match[0].length;
          continue;
        }
      }
      buf += ch;
      i += 1;
    }
    flush();
    return nodes;
  }

  const FENCE_RE = /^\s*```\s*([\w+#.-]*)\s*$/;
  const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE_RE = /^\s*>\s?(.*)$/;
  const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

  const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function splitTableRow(line) {
    let row = line.trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|")) row = row.slice(0, -1);
    return row.split("|").map((cell) => cell.trim());
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
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        blocks.push({
          t: "table",
          header: header.map(parseInline),
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
      } else if (node.t === "strong" || node.t === "em") {
        const el = doc.createElement(node.t === "strong" ? "strong" : "em");
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
        for (const cell of block.header) {
          const th = doc.createElement("th");
          th.appendChild(renderInline(cell, doc));
          headRow.appendChild(th);
        }
        head.appendChild(headRow);
        const body = doc.createElement("tbody");
        for (const row of block.rows) {
          const tr = doc.createElement("tr");
          for (const cell of row) {
            const td = doc.createElement("td");
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

  function problemSlugFromPath(pathname) {
    const match = /\/problems\/([^/]+)/.exec(pathname);
    return match ? match[1] : null;
  }

  // Test-only hook (same pattern as content.js): `module` is undefined in a
  // real content script, so this is a no-op in the browser.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseSseBlock,
      createSseParser,
      createState,
      applyEvent,
      itemsFor,
      parseInline,
      parseBlocks,
      renderBlocks,
      problemSlugFromPath,
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

  const state = createState();
  let relayReachable = null; // null until the first connect attempt settles
  let active = false;
  let unread = false;
  let mounted = null; // { tabset, container, tab, divider, host, layout, ... }
  let renderQueued = false;

  const PAGE_CSS = `
    [${TAB_ATTR}] .lc-tutor-dot { display: none; width: 6px; height: 6px; margin-left: 2px; border-radius: 50%; background: #ef4743; }
    [${TAB_ATTR}][data-unread] .lc-tutor-dot { display: block; }
    body[${ACTIVE_ATTR}] .flexlayout__tabset:has([${TAB_ATTR}]) .flexlayout__tab_button--selected:not([${TAB_ATTR}]) {
      color: var(--lc-tutor-muted, rgba(255, 255, 255, 0.6));
    }
  `;

  // Metrics below were measured on LeetCode's own Description pane (dark
  // theme): scroll area padding 20px 16px, title 24px/32px weight 600, body
  // 14px/21px, 16px between blocks, inline code chips 12px/16px with 2px
  // padding, a 5px radius and a 1px border, and the browser's default
  // (non-thin) scrollbar.
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
    .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 16px; }
    .title { margin: 0; font-size: 24px; font-weight: 600; line-height: 32px; color: var(--fg); }
    .status { display: flex; align-items: center; gap: 4px; font-size: 14px; line-height: 20px; color: var(--muted); white-space: nowrap; }
    .status svg { width: 14px; height: 14px; flex: none; }
    .status[data-ok] svg { color: var(--green); }
    .feed { flex: 1 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .banner { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; background: var(--fill); color: var(--muted); }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 12px; margin: auto; padding: 0 24px; color: var(--muted); text-align: center; }
    .empty svg { width: 32px; height: 32px; opacity: 0.6; }
    .empty p { margin: 0; max-width: 300px; }
    .chip { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px; background: var(--fill); font-size: 12px; line-height: 16px; color: var(--muted); }
    .chip b { font-weight: 500; color: var(--fg); }
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
    .tutor ul, .tutor ol { margin: 0 0 16px; padding-left: 20px; }
    .tutor li { margin: 2px 0; }
    .tutor li > ul, .tutor li > ol { margin: 4px 0 4px; }
    .table-wrap { margin: 0 0 16px; overflow-x: auto; scrollbar-width: thin; }
    .tutor table { border-collapse: collapse; }
    .tutor th, .tutor td { padding: 6px 12px; border: 1px solid var(--chip-line); text-align: left; vertical-align: top; }
    .tutor th { font-weight: 600; color: var(--fg); background: var(--fill); }
    .tutor strong { font-weight: 600; }
    .tutor a { color: var(--link); text-decoration: none; }
    .tutor a:hover { text-decoration: underline; }
    code { font: 12px/16px Menlo, Menlo-fallback, sans-serif; padding: 2px; border-radius: 5px; background: var(--fill); border: 1px solid var(--chip-line); color: color-mix(in srgb, var(--fg) 75%, transparent); }
    .tutor pre { margin: 0 0 16px; padding: 12px 16px; border-radius: 8px; background: var(--fill); border: 1px solid var(--chip-line); overflow-x: auto; scrollbar-width: thin; }
    .tutor pre code { padding: 0; border: 0; background: none; white-space: pre; font-size: 12px; line-height: 20px; color: var(--body); }
    .tutor blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 2px solid var(--line-strong); color: var(--muted); }
    .tutor hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
    .err { color: var(--red); }
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

  // Relative luminance below 0.5 is a dark surface.
  function isLight(cssColor) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cssColor);
    if (!m) return false;
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 > 0.5;
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
    const muted = pick(unselected, "color", "rgba(255, 255, 255, 0.6)");
    const style = m.host.style;
    style.setProperty("--bg", pick(m.tabset, "backgroundColor", "rgb(38, 38, 38)"));
    style.setProperty("--fg", fg);
    style.setProperty("--muted", muted);
    // Body copy in the Description pane is pure white while its title and the
    // tab labels are 245; keep that distinction.
    const nativePane = [...m.layout.querySelectorAll(".flexlayout__tab")].find((t) => t !== m.host);
    style.setProperty("--body", pick(nativePane, "color", fg));
    style.setProperty("--scheme", getComputedStyle(document.documentElement).colorScheme || "dark");
    style.setProperty("--font", getComputedStyle(document.body).fontFamily);
    style.setProperty("--fill", "color-mix(in srgb, var(--fg) 7%, transparent)");
    style.setProperty("--line", "color-mix(in srgb, var(--fg) 10%, transparent)");
    style.setProperty("--line-strong", "color-mix(in srgb, var(--fg) 24%, transparent)");
    style.setProperty("--chip-line", "color-mix(in srgb, var(--fg) 12%, transparent)");
    // The status green comes from the page's own Submit button, so a light
    // theme gets its own, darker shade; the fallback is for a page that has
    // no such button on screen yet.
    const light = isLight(pick(m.tabset, "backgroundColor", "rgb(38, 38, 38)"));
    const submit = document.querySelector('[data-e2e-locator="console-submit-button"]');
    style.setProperty("--green", pick(submit, "color", light ? "#0e8a3a" : "#2cbb5d"));
    // Not sampled: the first anchor in the native pane is a plain-text link
    // (it came out near-black in light mode), so links get a fixed blue per
    // surface instead.
    style.setProperty("--link", light ? "#0b63e5" : "#4b9bff");
    style.setProperty("--red", "#ef4743");
    document.documentElement.style.setProperty("--lc-tutor-muted", muted);
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

  function chatBubbleIcon(size) {
    return svgIcon("M5 3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7.2L6 21.5V17H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z", size);
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
    // The title row scrolls away with the content, like the Description pane's.
    const head = el("div", "head");
    head.appendChild(el("h2", "title", "Tutor"));
    const status = el("div", "status");
    const statusText = el("span", "", "Connecting");
    status.appendChild(statusText);
    status.appendChild(statusIcon());
    head.appendChild(status);

    const banner = el("div", "banner");
    banner.hidden = true;

    const scroll = el("div", "scroll");
    const feed = el("div", "feed");
    scroll.append(head, banner, feed);

    const composer = el("div", "composer");
    const box = el("div", "box");
    const input = document.createElement("textarea");
    input.rows = 1;
    input.placeholder = "Ask the tutor about this problem";
    input.setAttribute("aria-label", "Message the tutor");
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

    wrap.append(scroll, composer);
    root.append(style, wrap);

    // LeetCode binds many single-key shortcuts on the page, and this script's
    // sibling (content.js) binds Ctrl/Cmd+Enter to a Submit capture. Typing
    // here must trigger neither, so keys stop at the host.
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());

    return { host, status, statusText, banner, scroll, feed, input, send, hint };
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

  function renderItem(item) {
    if (item.kind === "capture") {
      const chip = el("div", "chip");
      chip.appendChild(el("b", "", item.trigger === "submit" ? "Submit" : "Run"));
      if (item.attemptSeq) chip.appendChild(document.createTextNode(`Attempt ${item.attemptSeq}`));
      return chip;
    }
    if (item.kind === "notice") return el("div", "notice", item.text);
    if (item.kind === "user") return el("div", "user", item.text);
    const wrap = el("div", "tutor");
    if (item.text) wrap.appendChild(renderBlocks(parseBlocks(item.text), document));
    if (item.error) wrap.appendChild(el("p", "err", item.error));
    if (item.pending && !item.text) {
      const dots = el("div", "dots");
      for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement("i"));
      wrap.appendChild(dots);
    }
    return wrap;
  }

  function render() {
    renderQueued = false;
    if (!mounted) return;
    const p = mounted.panel;
    const slug = currentSlug();
    const conn = describeConnection();
    p.statusText.textContent = conn.label;
    p.status.querySelector("path").setAttribute("d", conn.ok ? STATUS_OK : STATUS_BAD);
    if (conn.ok) p.status.setAttribute("data-ok", "");
    else p.status.removeAttribute("data-ok");
    renderBanner(p.banner, conn.banner);

    const canSend = conn.ok && Boolean(slug);
    p.input.disabled = !canSend;
    p.send.disabled = !canSend || !p.input.value.trim();
    p.input.placeholder = canSend ? "Ask the tutor about this problem" : "Start the companion to chat";

    if (!active) return;
    const stick =
      Date.now() < mounted.stickUntil || p.scroll.scrollHeight - p.scroll.scrollTop - p.scroll.clientHeight < 80;
    const items = (slug && state.byProblem.get(slug)) || [];
    p.feed.textContent = "";
    if (items.length === 0) {
      const empty = el("div", "empty");
      empty.appendChild(chatBubbleIcon(32));
      empty.appendChild(el("p", "", "Run or submit your code and the tutor will review it here. You can also ask a question about this problem below."));
      p.feed.appendChild(empty);
    }
    for (const item of items) p.feed.appendChild(renderItem(item));
    if (stick) p.scroll.scrollTop = p.scroll.scrollHeight;
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
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
    // of it.
    mounted.inertPane = [...mounted.layout.querySelectorAll(".flexlayout__tab")].find(
      (t) => t !== mounted.host && t.getBoundingClientRect().width > 0
    );
    if (mounted.inertPane) mounted.inertPane.inert = true;
    setUnread(false);
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
      panel.send.disabled = panel.input.disabled || !panel.input.value.trim();
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
    if (!text || !slug || p.input.disabled) return;
    p.send.disabled = true;
    p.hint.hidden = true;
    try {
      const res = await fetch(`${RELAY_BASE}/panel/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, problemSlug: slug }),
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
      } else if (res.status === 503) {
        state.companionOnline = false;
        p.hint.textContent = "The tutor went offline. Your message wasn't sent.";
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
        const res = await fetch(`${RELAY_BASE}/panel/events?after=${state.lastSeq}`, {
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
          scheduleRender();
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
      state.companionOnline = null;
      scheduleRender();
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
