// Regression test for the CORS/preflight handling that Firefox and Zen
// Browser need (see README.md and the CORS_HEADERS comment in server.js).
//
// Chrome's content-script fetch() bypasses CORS entirely via the
// extension's host_permissions grant, so a same-origin curl-style POST
// against this server would pass even with the bug present. What actually
// distinguishes "works in Firefox/Zen" from "silently drops every
// capture" is whether the server (a) answers the OPTIONS preflight the
// browser sends before a cross-origin JSON POST, and (b) echoes
// Access-Control-Allow-Origin on both the preflight and the real
// response. This test asserts exactly that, against a real running
// instance of the server - not a mock.
//
// Run with: node --test relay-server/server.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = 18135; // distinct from the default 8135 to avoid clashing with a dev instance
const LEETCODE_ORIGIN = "https://leetcode.com"; // the origin a Firefox/Zen content-script fetch() actually runs as

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("relay server CORS/preflight handling", async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-capture-test-"));
  const logPath = path.join(logDir, "captures.jsonl");

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, CAPTURE_PORT: String(PORT), CAPTURE_LOG_PATH: logPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(() => {
    child.kill();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  // Wait for the server to announce it's listening rather than polling blind.
  await new Promise((resolve, reject) => {
    let out = "";
    const onData = (chunk) => {
      out += chunk.toString();
      if (out.includes("listening")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
    setTimeout(() => reject(new Error("timed out waiting for server to start")), 5000);
  });

  await t.test("OPTIONS preflight to /capture returns CORS headers", async () => {
    const res = await request({
      host: "127.0.0.1",
      port: PORT,
      path: "/capture",
      method: "OPTIONS",
      headers: {
        Origin: LEETCODE_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });

    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.match(res.headers["access-control-allow-methods"] || "", /POST/);
    assert.match(res.headers["access-control-allow-headers"] || "", /Content-Type/i);
  });

  await t.test("cross-origin POST to /capture succeeds and is logged", async () => {
    const payload = JSON.stringify({
      problemSlug: "two-sum",
      problemTitle: "Two Sum",
      problemDescription: "Given an array of integers...",
      language: "python3",
      code: "def two_sum(nums, target): pass",
      trigger: "submit",
      timestamp: new Date().toISOString(),
      url: "https://leetcode.com/problems/two-sum/",
    });

    const res = await request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/capture",
        method: "POST",
        headers: {
          Origin: LEETCODE_ORIGIN,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      payload,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);

    const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].problemSlug, "two-sum");
    assert.equal(logged[0].trigger, "submit");
  });
});
