// LeetCode Capture - in-page tutor panel broker
//
// The companion (a separate local process) publishes tutor events here, and
// the in-page panel (the extension's panel.js, running on leetcode.com)
// streams them out over Server-Sent Events and posts typed messages back.
// This module only brokers: it never calls an LLM, and it keeps everything in
// memory (a bounded event buffer), so a relay restart simply starts the panel
// transcript fresh.
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
// The two companion-only routes (publish, inbox) additionally require NO
// Origin header at all, so even a script running on leetcode.com can neither
// forge tutor replies nor eavesdrop on the inbox; it can only read events and
// post messages.

"use strict";

const PANEL_ORIGIN = "https://leetcode.com";

const MAX_BUFFERED_EVENTS = 2000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PUBLISH_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_MESSAGE_CHARS = 8000;
const HEARTBEAT_MS = 15_000;

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

  let nextSeq = 1;
  let events = []; // bounded, oldest first
  const panelClients = new Set(); // SSE responses for panels
  const consumers = new Set(); // SSE responses for companions (inbox)
  let nextMessageId = 1;

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
    return { type: "status", companionOnline: consumers.size > 0 };
  }

  function broadcastStatus() {
    for (const res of panelClients) sseWrite(res, { data: statusEvent() });
  }

  function addEvent(event) {
    const stored = { ...event, seq: nextSeq++ };
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

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return true;
    }

    const route = `${req.method} ${url.pathname}`;
    const companionOnly = route === "POST /panel/publish" || route === "GET /panel/inbox";
    if (companionOnly && origin !== undefined) {
      sendJson(req, res, 403, { error: "this route is for the companion only" });
      return true;
    }

    if (route === "GET /panel/events") {
      const lastEventId = Number(req.headers["last-event-id"]);
      const afterParam = Number(url.searchParams.get("after"));
      const after = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : Number.isFinite(afterParam) ? afterParam : 0;
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
        broadcastStatus();
      });
      consumers.add(res);
      broadcastStatus();
      return true;
    }

    if (route === "POST /panel/message") {
      readBody(req, res, MAX_MESSAGE_BYTES, (body) => {
        const text = body && typeof body.text === "string" ? body.text.trim() : "";
        const slug = body && body.problemSlug;
        if (!text || text.length > MAX_MESSAGE_CHARS || !isShortString(slug, 200) || !slug) {
          sendJson(req, res, 400, { error: "text (1-8000 chars) and problemSlug are required" });
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
        const stored = clean.map(addEvent);
        sendJson(req, res, 200, { ok: true, lastSeq: stored[stored.length - 1].seq });
      });
      return true;
    }

    sendJson(req, res, 404, { error: "not found" });
    return true;
  }

  return { handle };
}

module.exports = { createPanelBroker, sanitizeEvent, PANEL_ORIGIN };
