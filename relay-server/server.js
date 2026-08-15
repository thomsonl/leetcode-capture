// LeetCode Capture - local relay server
//
// Listens on localhost only. Accepts POSTs from the browser extension and
// durably appends each capture as one JSON line to a local log file, adding
// a per-problem monotonic attempt sequence number.
//
// Log file location: ./data/captures.jsonl (relative to this file), unless
// overridden with the CAPTURE_LOG_PATH environment variable. See README.md.

const http = require("http");
const fs = require("fs");
const path = require("path");

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

const server = http.createServer((req, res) => {
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

server.listen(PORT, HOST, () => {
  console.log(`leetcode-capture relay server listening on http://${HOST}:${PORT}`);
  console.log(`logging captures to ${LOG_PATH}`);
});
