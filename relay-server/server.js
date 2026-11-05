// LeetCode Capture - local relay server
//
// Listens on localhost only. Accepts POSTs from the browser extension and
// durably appends each capture as one JSON line to a local log file, adding
// a per-problem monotonic attempt sequence number.
//
// Log file location: ./data/captures.jsonl (relative to this file), unless
// overridden with the CAPTURE_LOG_PATH environment variable.
// The log is cleared as the companion consumes it (see trimCaptureLog).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { createPanelBroker, companionOnlyRejection } = require("./panel-broker");

const HOST = "127.0.0.1";
const PORT = process.env.CAPTURE_PORT ? Number(process.env.CAPTURE_PORT) : 8135;
const LOG_PATH = process.env.CAPTURE_LOG_PATH ||
  path.join(__dirname, "data", "captures.jsonl");

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB, generous for a single file's code

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

// Per-problem attempt sequence numbers, rebuilt from the existing log on
// startup so restarts don't reset the counter.
const attemptSeq = new Map();

function loadExistingSequences() {
  if (!fs.existsSync(LOG_PATH)) return;
  const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const key = entry.problemSlug || "unknown";
      const current = attemptSeq.get(key) || 0;
      if (entry.attemptSeq > current) {
        attemptSeq.set(key, entry.attemptSeq);
      }
    } catch {
      // Skip malformed lines rather than fail startup.
    }
  }
}

function nextAttemptSeq(problemSlug) {
  const key = problemSlug || "unknown";
  const next = (attemptSeq.get(key) || 0) + 1;
  attemptSeq.set(key, next);
  return next;
}

function isValidCapture(body) {
  return (
    body &&
    typeof body === "object" &&
    typeof body.problemSlug === "string" &&
    typeof body.language === "string" &&
    typeof body.code === "string" &&
    (body.trigger === "run" || body.trigger === "submit") &&
    typeof body.timestamp === "string"
  );
}

function appendCapture(body) {
  const entry = {
    receivedAt: new Date().toISOString(),
    problemSlug: body.problemSlug,
    problemTitle: body.problemTitle || null,
    problemDescription: body.problemDescription || null,
    problemTags: Array.isArray(body.problemTags) ? body.problemTags : [],
    language: body.language,
    trigger: body.trigger,
    timestamp: body.timestamp,
    url: body.url || null,
    code: body.code,
    attemptSeq: nextAttemptSeq(body.problemSlug),
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  return entry;
}

// The log is only a short-lived delivery queue from this relay to the
// companion, which tails it by byte offset. Once the companion has read a
// prefix of it (and moved on from that problem, or just started), it asks for
// that prefix to be dropped (the companion-only POST /panel/trim-captures,
// see panel-broker.js). `before` is the companion's own read offset, so only
// lines it already handled are dropped. Everything here is synchronous, like
// appendCapture, so a capture that arrives meanwhile is appended wholly
// before or wholly after the trim and is never lost or doubled; the rest of
// the file is written to a temporary file and renamed over the log, so a
// crash leaves either the old log or the new one. A future setting that
// keeps old captures (for studying later) would copy the dropped prefix
// somewhere first, here.
// Returns { removed, size }, or { error } for a request that cannot be met.
function trimCaptureLog(before) {
  let size;
  try {
    size = fs.statSync(LOG_PATH).size;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    size = 0;
  }
  if (before > size) return { error: `the log is only ${size} bytes` };
  if (before === 0) return { removed: 0, size };
  const fd = fs.openSync(LOG_PATH, "r");
  let rest;
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, before - 1);
    if (last[0] !== 0x0a) return { error: "that offset is not at the end of a line" };
    rest = Buffer.alloc(size - before);
    fs.readSync(fd, rest, 0, rest.length, before);
  } finally {
    fs.closeSync(fd);
  }
  const tmp = `${LOG_PATH}.trim-tmp`;
  fs.writeFileSync(tmp, rest);
  fs.renameSync(tmp, LOG_PATH);
  return { removed: before, size: rest.length };
}

// CORS headers, sent on every response to /capture (including the OPTIONS
// preflight). Chrome's content-script fetch() inherits the extension's
// host_permissions grant and skips CORS entirely, but Firefox/Zen run
// content-script fetch() as the page's own origin (https://leetcode.com),
// so a cross-origin POST with a JSON body triggers a real preflight. This
// server only binds to 127.0.0.1 and only ingests capture data (no
// secrets, no destructive actions), so a permissive `*` origin is fine -
// no need for an origin allowlist on a localhost-only dev tool.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// The in-page tutor panel's broker (see panel-broker.js). Its routes do their
// own, much stricter origin checks, so they run before the permissive
// /capture handling below.
const panelBroker = createPanelBroker({ port: PORT, captureLog: { path: LOG_PATH, trim: trimCaptureLog } });

// Run by the Native Messaging helper (helper/host.js), the relay quits on its
// own when nothing has been heard for RELAY_IDLE_EXIT_MS, so a browser or
// helper that vanished cannot leave it holding the port. Heard means a
// request from anything but the companion (a panel, a capture, the options
// page), an open panel stream, or the helper's POST /helper/keepalive, which
// the helper sends while the extension keeps talking to it. Off (0) unless
// set, so a relay started by hand runs until stopped.
const IDLE_EXIT_MS = Number(process.env.RELAY_IDLE_EXIT_MS) || 0;
let lastHeard = Date.now();

const server = http.createServer((req, res) => {
  if (req.headers["x-lc-companion"] === undefined) lastHeard = Date.now();
  if (req.method === "POST" && req.url === "/helper/keepalive") {
    const rejection = companionOnlyRejection(req);
    res.writeHead(rejection ? 403 : 204, { "Content-Type": "application/json" });
    if (!rejection) lastHeard = Date.now();
    res.end(rejection ? JSON.stringify({ error: rejection }) : undefined);
    req.resume();
    return;
  }
  if (panelBroker.handle(req, res)) return;

  if (req.method === "OPTIONS" && req.url === "/capture") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/capture") {
    res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  let received = 0;
  const chunks = [];
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ error: "payload too large" }));
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
      res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ error: "invalid JSON" }));
      return;
    }

    if (!isValidCapture(body)) {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ error: "missing or invalid required fields" }));
      return;
    }

    const entry = appendCapture(body);
    res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true, attemptSeq: entry.attemptSeq }));
  });

  req.on("error", () => {
    // Client disconnected mid-request; nothing to do.
  });
});

loadExistingSequences();

if (IDLE_EXIT_MS > 0) {
  setInterval(() => {
    if (panelBroker.openPanelStreams() > 0) lastHeard = Date.now();
    if (Date.now() - lastHeard < IDLE_EXIT_MS) return;
    console.log(`nothing heard for ${Math.round(IDLE_EXIT_MS / 1000)} s, exiting`);
    process.exit(0);
  }, Math.min(IDLE_EXIT_MS, 10000)).unref();
}

// Started by the helper with a pipe for stdin: the helper closing it (or
// dying, which closes it too) means stop.
if (/^(1|true|yes)$/i.test(process.env.RELAY_EXIT_WITH_STDIN || "")) {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.resume();
}

server.listen(PORT, HOST, () => {
  console.log(`leetcode-capture relay server listening on http://${HOST}:${PORT}`);
  console.log(`logging captures to ${LOG_PATH}`);
});
