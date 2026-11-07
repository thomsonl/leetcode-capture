// The companion-only route that drops the already-delivered prefix of the
// capture log (POST /panel/trim-captures, see server.js's trimCaptureLog).
// Run against a real spawned relay, like the other relay tests.
//
// Run with: node --test capture-trim.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const COMPANION = { "x-lc-companion": "1" };

function request(port, { method, route, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: route, method, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// `seed`: log entries already there when the relay starts.
async function startRelay(t, port, { seed = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-capture-trim-"));
  const logPath = path.join(dir, "captures.jsonl");
  if (seed.length) fs.writeFileSync(logPath, seed.map((e) => JSON.stringify(e) + "\n").join(""));
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, CAPTURE_PORT: String(port), CAPTURE_LOG_PATH: logPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => c.toString().includes("listening") && resolve());
    child.once("exit", () => reject(new Error("relay exited")));
  });
  const capture = (slug, marker, trigger = "run") =>
    request(port, {
      method: "POST",
      route: "/capture",
      body: { problemSlug: slug, language: "Python3", code: marker, trigger, timestamp: new Date().toISOString() },
    });
  const trim = (body, headers = COMPANION) => request(port, { method: "POST", route: "/panel/trim-captures", body, headers });
  const lines = () => fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { logPath, capture, trim, lines };
}

test("the relay drops only the consumed prefix of the capture log, on a line boundary, for the companion only", async (t) => {
  const r = await startRelay(t, 18230);
  for (const m of ["a1", "a2", "b1"]) assert.equal((await r.capture(m[0] === "a" ? "old-problem" : "new-problem", m)).status, 200);
  const raw = fs.readFileSync(r.logPath, "utf8");
  const before = raw.indexOf("\n", raw.indexOf("\n") + 1) + 1; // after a1 and a2

  // Only the companion may ask, and only for the file the relay writes.
  assert.equal((await r.trim({ before, path: r.logPath }, {})).status, 403);
  assert.equal((await r.trim({ before, path: r.logPath }, { ...COMPANION, origin: "https://leetcode.com" })).status, 403);
  assert.equal((await r.trim({ before, path: path.join(path.dirname(r.logPath), "other.jsonl") })).status, 409);
  // Never in the middle of a line, past the end, or with a bad number.
  assert.equal((await r.trim({ before: before - 3, path: r.logPath })).status, 409);
  assert.equal((await r.trim({ before: raw.length + 10, path: r.logPath })).status, 409);
  assert.equal((await r.trim({ before: -1, path: r.logPath })).status, 400);
  assert.equal((await r.trim({ before: "12", path: r.logPath })).status, 400);
  assert.equal(fs.readFileSync(r.logPath, "utf8"), raw, "a refused trim changes nothing");

  const ok = await r.trim({ before, path: r.logPath });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, removed: before, size: Buffer.byteLength(raw) - before });
  assert.deepEqual(r.lines().map((e) => e.code), ["b1"]);
  // Appends carry on after it, and attempt numbers keep counting.
  await r.capture("new-problem", "b2");
  assert.deepEqual(r.lines().map((e) => [e.code, e.attemptSeq]), [["b1", 1], ["b2", 2]]);
  // Nothing to drop is fine.
  assert.deepEqual((await r.trim({ before: 0, path: r.logPath })).json, { ok: true, removed: 0, size: fs.statSync(r.logPath).size });
});

test("captures arriving while the log is trimmed are each kept exactly once", async (t) => {
  const r = await startRelay(t, 18232);
  for (let i = 0; i < 20; i += 1) await r.capture("old-problem", `old-${i}`);
  const before = fs.statSync(r.logPath).size;
  // Fire a burst of captures and several trims of the same prefix at once.
  const sends = Array.from({ length: 60 }, (_, i) => r.capture("new-problem", `new-${i}`));
  const trims = [r.trim({ before, path: r.logPath }), ...Array.from({ length: 3 }, () => r.trim({ before: 0, path: r.logPath }))];
  const results = await Promise.all([...sends, ...trims]);
  assert.ok(results.slice(0, 60).every((res) => res.status === 200));
  assert.equal(results[60].status, 200);
  const codes = r.lines().map((e) => e.code);
  assert.ok(!codes.some((c) => c.startsWith("old-")), "the old prefix is gone");
  assert.deepEqual([...codes].sort(), Array.from({ length: 60 }, (_, i) => `new-${i}`).sort(), "every new capture once");
});

test("Runs and Submits are also numbered on their own per problem, and the numbers survive a restart", async (t) => {
  // The panel shows only Submits, so its chip and the terminal use
  // triggerSeq: the first Submit after a Run is attempt 1, not 2.
  const seed = [
    { problemSlug: "two-sum", trigger: "run", code: "a", attemptSeq: 1, triggerSeq: 1 },
    { problemSlug: "two-sum", trigger: "submit", code: "b", attemptSeq: 2, triggerSeq: 1 },
    // A line from a relay before triggerSeq: it still counts in attemptSeq.
    { problemSlug: "two-sum", trigger: "run", code: "c", attemptSeq: 3 },
  ];
  const r = await startRelay(t, 18234, { seed });
  const answer = await r.capture("two-sum", "d", "submit");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { ok: true, attemptSeq: 4, triggerSeq: 2 });
  await r.capture("two-sum", "e", "run");
  await r.capture("other", "f", "submit");
  assert.deepEqual(
    r.lines().slice(3).map((e) => [e.problemSlug, e.trigger, e.attemptSeq, e.triggerSeq]),
    [
      ["two-sum", "submit", 4, 2],
      ["two-sum", "run", 5, 2],
      ["other", "submit", 1, 1],
    ]
  );
});
