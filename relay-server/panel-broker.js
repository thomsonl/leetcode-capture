// LeetCode Capture - in-page tutor panel broker
//
// The companion (a separate local process) publishes tutor events here, and
// the in-page panel (the extension's panel.js, running on leetcode.com)
// streams them out over Server-Sent Events and posts typed messages back.
// This module only brokers: it never calls an LLM, and it keeps everything in
// memory (a bounded event buffer), so a relay restart simply starts the panel
// transcript fresh. Sequence numbers restart at 1 with it, so every event
// (and the status event) carries this run's random `epoch`: a panel that
// reconnects with `?after=<seq>&epoch=<old>` gets the whole new buffer
// instead of having it filtered against a counter from a previous run, and
// it resets its own `lastSeq` when it sees a new epoch.
//
// Routes (all under /panel/):
//   GET  /panel/events?after=<seq>  panel     SSE stream of tutor events (replays the buffer after <seq>)
//   POST /panel/message             panel     a typed message for the tutor
//   POST /panel/publish             companion one event, or { events: [...] }
//   GET  /panel/inbox               companion SSE stream of the panel's typed messages
//
// Unlike /capture (which only ingests data, so a permissive CORS `*` is
// harmless), these routes can READ tutor replies, which contain the student's
// code, so any web page that could reach localhost must not be able to. Two
// checks run on every request:
//   - Host must be exactly the relay's own loopback address, which defeats DNS
//     rebinding (an attacker's hostname resolving to 127.0.0.1 arrives with
//     the attacker's Host header).
//   - Origin must be absent or exactly https://leetcode.com. Browsers always
//     send Origin on a CORS request and on any POST, and a page cannot forge
//     it, so every other website is rejected.
// The companion-only routes (publish, inbox) additionally go through
// companionOnlyRejection below. A missing Origin alone is NOT proof of the
// companion: a page's `fetch(url, { mode: "no-cors" })` GET carries no Origin
// either. What a browser page cannot do is add a custom header without a CORS
// preflight, and that preflight carries an Origin and is refused (and even
// leetcode.com's preflight is never told this header is allowed). So these
// routes require COMPANION_HEADER, no Origin, and no cross-site Sec-Fetch-Site.
// A script on leetcode.com can therefore only read events and post messages.
//
// Text in a typed message ends up printed in the student's terminal by the
// companion, so C0/C1 control characters (escape sequences that could recolor
// the terminal, retitle the window, or worse) and invisible bidi/zero-width
// characters (which could disguise what the text says) are stripped at this
// boundary.
// The companion strips them again before printing anything untrusted.
//
// The number of open panel streams is capped, and only CORS-mode requests
// count: a page's no-cors GET (or an <img> or <iframe>) to /panel/events has
// no Origin, so without the Sec-Fetch-Mode check in handle() it could hold the
// slots open, unread, and lock the real panel out.

"use strict";

const crypto = require("crypto");

const PANEL_ORIGIN = "https://leetcode.com";
// Sent by companion/panel-bridge.js on every companion-only request.
const COMPANION_HEADER = "x-lc-companion";

const MAX_BUFFERED_EVENTS = 2000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PUBLISH_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_MESSAGE_CHARS = 8000;
const MAX_PANEL_STREAMS = 20;
const MAX_OPEN_TURNS = 100;
const HEARTBEAT_MS = 15_000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/i;

// Everything in C0 except tab and newline, plus DEL and all of C1 (which some
// terminals honor as 8-bit CSI/OSC introducers), plus the invisible bidi and
// zero-width formatting characters that make text read differently from what
// it is. The line and paragraph separators become a newline. The zero-width
// joiner and non-joiner stay (emoji sequences and several scripts need them).
// Same rule as companion/sanitize.js, which explains each range.
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const LINE_SEPARATORS_RE = /[\u2028\u2029]/g;

function stripControlChars(text) {
  return text.replace(LINE_SEPARATORS_RE, "\n").replace(CONTROL_CHARS_RE, "");
}

// Returns null when the request plausibly comes from the local companion
// process, or a reason string for the 403. Shared by every companion-only
// route; add new ones to COMPANION_ONLY_ROUTES rather than re-deriving this.
function companionOnlyRejection(req) {
  if (req.headers.origin !== undefined) return "this route is for the companion only";
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "none") return "this route is for the companion only";
  if (req.headers[COMPANION_HEADER] !== "1") return `this route is for the companion only (missing ${COMPANION_HEADER})`;
  return null;
}

const COMPANION_ONLY_ROUTES = new Set(["POST /panel/publish", "GET /panel/inbox"]);

const EVENT_TYPES = new Set(["user", "capture", "turn-start", "chunk", "turn-end", "notice"]);

function isShortString(value, max) {
  return typeof value === "string" && value.length <= max;
}

// Copies only the fields the panel knows how to render, so a malformed or
// oversized publish can never smuggle arbitrary data into the buffer.
function sanitizeEvent(raw) {
  if (!raw || typeof raw !== "object" || !EVENT_TYPES.has(raw.type)) return null;
  const event = { type: raw.type };
  if (raw.problemSlug !== undefined && raw.problemSlug !== null) {
    if (!isShortString(raw.problemSlug, 200)) return null;
    event.problemSlug = raw.problemSlug;
  } else {
    event.problemSlug = null;
  }
  if (raw.turnId !== undefined) {
    if (!isShortString(raw.turnId, 64)) return null;
    event.turnId = raw.turnId;
  }
  if (raw.text !== undefined) {
    if (!isShortString(raw.text, MAX_TEXT_CHARS)) return null;
    event.text = raw.text;
  }
  if (raw.error !== undefined) {
    if (!isShortString(raw.error, 2000)) return null;
    event.error = raw.error;
  }
  if (raw.trigger !== undefined) {
    if (raw.trigger !== "run" && raw.trigger !== "submit") return null;
    event.trigger = raw.trigger;
  }
  if (raw.problemTitle !== undefined && raw.problemTitle !== null) {
    if (!isShortString(raw.problemTitle, 300)) return null;
    event.problemTitle = raw.problemTitle;
  }
  if (raw.attemptSeq !== undefined && raw.attemptSeq !== null) {
    if (!Number.isInteger(raw.attemptSeq) || raw.attemptSeq < 0) return null;
    event.attemptSeq = raw.attemptSeq;
  }
  return event;
}

function createPanelBroker({ port }) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  // Identifies this run of the relay; see the file header.
  const epoch = crypto.randomBytes(8).toString("hex");
  let nextSeq = 1;
  let events = []; // bounded, oldest first
  const panelClients = new Set(); // SSE responses for panels
  const consumers = new Set(); // SSE responses for companions (inbox)
  let nextMessageId = 1;
  // Replies that have started but not ended, with the text streamed so far:
  // turnId -> { problemSlug, text, closed }. The companion ends every turn it
  // finishes, but a companion that exits mid-reply (Ctrl+C, a crash, the
  // terminal closed) never sends that end, and the panel would show the
  // reply as still typing forever, in every tab opened later too. When the
  // last companion's inbox stream goes away (and after any publish that
  // arrives while none is connected), closeOpenTurns ends each of them as
  // interrupted. `closed` marks one ended that way, so a companion that only
  // lost its stream and keeps streaming the same turn reopens it.
  const openTurns = new Map();

  function corsHeaders(req) {
    // Only ever echoed for the one allowed origin; a request with no Origin
    // header (the companion) needs no CORS headers at all.
    if (req.headers.origin !== PANEL_ORIGIN) return {};
    return {
      "Access-Control-Allow-Origin": PANEL_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
      // Chrome's Private Network Access preflight asks for this when a public
      // https page talks to a loopback address.
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }

  function sendJson(req, res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(req) });
    res.end(JSON.stringify(body));
  }

  function sseWrite(res, { id, data }) {
    if (id !== undefined) res.write(`id: ${id}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function statusEvent() {
    return { type: "status", companionOnline: consumers.size > 0, epoch };
  }

  function broadcastStatus() {
    for (const res of panelClients) sseWrite(res, { data: statusEvent() });
  }

  function trackTurn(event) {
    if (!event.turnId) return;
    if (event.type === "turn-start") {
      openTurns.delete(event.turnId);
      openTurns.set(event.turnId, { problemSlug: event.problemSlug, text: "", closed: false });
      // A companion that never ends its turns must not grow this forever.
      if (openTurns.size > MAX_OPEN_TURNS) openTurns.delete(openTurns.keys().next().value);
    } else if (event.type === "chunk") {
      const turn = openTurns.get(event.turnId);
      if (!turn) return;
      turn.closed = false;
      if (event.text && turn.text.length < MAX_TEXT_CHARS) turn.text = (turn.text + event.text).slice(0, MAX_TEXT_CHARS);
    } else if (event.type === "turn-end") {
      openTurns.delete(event.turnId);
    }
  }

  // Ends every reply still streaming as interrupted, with the text it got
  // so far (a turn-end replaces its chunks in the buffer, see addEvent). The
  // panel shows the same "did not finish" note it uses for a relay restart.
  function closeOpenTurns() {
    for (const [turnId, turn] of openTurns) {
      if (turn.closed) continue;
      turn.closed = true;
      const stored = { type: "turn-end", turnId, problemSlug: turn.problemSlug, text: turn.text, interrupted: true };
      addEvent(stored, { track: false });
    }
  }

  function addEvent(event, { track = true } = {}) {
    if (track) trackTurn(event);
    const stored = { ...event, seq: nextSeq++, epoch };
    // A turn-end carries the turn's full authoritative text, so the chunks
    // that led up to it are dead weight for anyone replaying the buffer.
    if (stored.type === "turn-end" && stored.turnId) {
      events = events.filter((e) => !(e.type === "chunk" && e.turnId === stored.turnId));
    }
    events.push(stored);
    if (events.length > MAX_BUFFERED_EVENTS) events = events.slice(events.length - MAX_BUFFERED_EVENTS);
    for (const res of panelClients) sseWrite(res, { id: stored.seq, data: stored });
    return stored;
  }

  function openStream(req, res, onClose) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      // no-store, not just no-cache: a stream that never finishes would
      // otherwise hold Chrome's HTTP-cache lock for its URL, and a second
      // identical GET (a second leetcode tab asking for /panel/events?after=0)
      // queues behind it forever.
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(req),
    });
    res.write("retry: 2000\n\n");
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      onClose();
    });
  }

  function readBody(req, res, maxBytes, onBody) {
    let received = 0;
    const chunks = [];
    let aborted = false;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        aborted = true;
        sendJson(req, res, 413, { error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(req, res, 400, { error: "invalid JSON" });
        return;
      }
      onBody(body);
    });
    req.on("error", () => {});
  }

  // Returns true if the request was a /panel/ route (and has been handled),
  // false if the caller should keep routing it.
  function handle(req, res) {
    const url = new URL(req.url, "http://relay.invalid");
    if (!url.pathname.startsWith("/panel/")) return false;

    if (!allowedHosts.has(req.headers.host)) {
      sendJson(req, res, 403, { error: "forbidden host" });
      return true;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== PANEL_ORIGIN) {
      sendJson(req, res, 403, { error: "forbidden origin" });
      return true;
    }

    // Every legitimate caller makes a CORS-mode request: the panel's fetch
    // from leetcode.com, and the companion's Node fetch (which sends
    // Sec-Fetch-Mode: cors too). A no-cors fetch, an <img>/<script> tag or an
    // <iframe> on some other website sends no Origin, so the check above lets
    // it through, and although it cannot read the stream it holds one of the
    // MAX_PANEL_STREAMS slots: twenty of them locked leetcode.com out with a
    // 503. Refused here, before anything is counted. A browser too old to send
    // Sec-Fetch-Mode at all is not covered; every browser the extension
    // supports sends it.
    const fetchMode = req.headers["sec-fetch-mode"];
    if (fetchMode !== undefined && fetchMode !== "cors") {
      sendJson(req, res, 403, { error: "only CORS requests are accepted" });
      return true;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return true;
    }

    const route = `${req.method} ${url.pathname}`;
    if (COMPANION_ONLY_ROUTES.has(route)) {
      const rejection = companionOnlyRejection(req);
      if (rejection) {
        sendJson(req, res, 403, { error: rejection });
        return true;
      }
    }

    if (route === "GET /panel/events") {
      if (panelClients.size >= MAX_PANEL_STREAMS) {
        sendJson(req, res, 503, { error: "too many open panel streams" });
        return true;
      }
      const lastEventId = Number(req.headers["last-event-id"]);
      const afterParam = Number(url.searchParams.get("after"));
      let after = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : Number.isFinite(afterParam) ? afterParam : 0;
      // A client counting from a previous run of the relay must get the whole
      // buffer: its `after` is meaningless against this run's numbering.
      const clientEpoch = url.searchParams.get("epoch");
      if (clientEpoch && clientEpoch !== epoch) after = 0;
      openStream(req, res, () => panelClients.delete(res));
      for (const event of events) {
        if (event.seq > after) sseWrite(res, { id: event.seq, data: event });
      }
      sseWrite(res, { data: statusEvent() });
      panelClients.add(res);
      return true;
    }

    if (route === "GET /panel/inbox") {
      openStream(req, res, () => {
        consumers.delete(res);
        if (consumers.size === 0) closeOpenTurns();
        broadcastStatus();
      });
      consumers.add(res);
      broadcastStatus();
      return true;
    }

    if (route === "POST /panel/message") {
      readBody(req, res, MAX_MESSAGE_BYTES, (body) => {
        const text = body && typeof body.text === "string" ? stripControlChars(body.text).trim() : "";
        const slug = body && body.problemSlug;
        if (!text || text.length > MAX_MESSAGE_CHARS || typeof slug !== "string" || !SLUG_RE.test(slug)) {
          sendJson(req, res, 400, { error: "text (1-8000 chars) and a valid problemSlug are required" });
          return;
        }
        if (consumers.size === 0) {
          sendJson(req, res, 503, { error: "companion offline" });
          return;
        }
        const message = { id: nextMessageId++, text, problemSlug: slug };
        for (const consumer of consumers) sseWrite(consumer, { id: message.id, data: message });
        sendJson(req, res, 202, { ok: true, id: message.id });
      });
      return true;
    }

    if (route === "POST /panel/publish") {
      readBody(req, res, MAX_PUBLISH_BYTES, (body) => {
        const rawEvents = body && Array.isArray(body.events) ? body.events : [body];
        const clean = rawEvents.map(sanitizeEvent);
        if (clean.length === 0 || clean.some((e) => e === null)) {
          sendJson(req, res, 400, { error: "invalid event" });
          return;
        }
        const stored = clean.map((event) => addEvent(event));
        // A publish can land after the companion's inbox stream closed: a
        // companion that exits sends its last batch and drops its stream at
        // the same moment, in either order. With no companion connected
        // nothing will end what this batch started or continued, so it is
        // closed again right away.
        if (consumers.size === 0) closeOpenTurns();
        sendJson(req, res, 200, { ok: true, lastSeq: stored[stored.length - 1].seq });
      });
      return true;
    }

    sendJson(req, res, 404, { error: "not found" });
    return true;
  }

  return { handle };
}

module.exports = { createPanelBroker, sanitizeEvent, stripControlChars, companionOnlyRejection, PANEL_ORIGIN, COMPANION_HEADER };
