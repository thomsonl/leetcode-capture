// The relay's helper-mode lifecycle: the idle exit (RELAY_IDLE_EXIT_MS), the
// helper's keepalive route, and exiting when the helper closes stdin
// (RELAY_EXIT_WITH_STDIN). Each case runs its own relay on a free port.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startRelay(t, env, stdin = "ignore") {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-capture-lifecycle-"));
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, CAPTURE_PORT: String(port), CAPTURE_LOG_PATH: path.join(dir, "captures.jsonl"), ...env },
    stdio: [stdin, "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("listening")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`relay exited early (${code})`)));
  });
  return { child, port, exited };
}

function post(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

const within = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms))]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("with RELAY_IDLE_EXIT_MS the relay exits when nothing is heard", async (t) => {
  const { exited } = await startRelay(t, { RELAY_IDLE_EXIT_MS: "400" });
  assert.equal(await within(exited, 3000), 0);
});

test("the helper's keepalive keeps an idle relay running, and is companion-only", async (t) => {
  const { child, port } = await startRelay(t, { RELAY_IDLE_EXIT_MS: "500" });
  for (let i = 0; i < 8; i += 1) {
    assert.equal(await post(port, "/helper/keepalive", { "x-lc-companion": "1" }), 204);
    await sleep(150);
  }
  assert.equal(child.exitCode, null);
  assert.equal(await post(port, "/helper/keepalive", { "x-lc-companion": "1", origin: "https://leetcode.com" }), 403);
  assert.equal(await post(port, "/helper/keepalive"), 403);
});

test("companion-only traffic alone does not keep the relay up", async (t) => {
  const { exited, port } = await startRelay(t, { RELAY_IDLE_EXIT_MS: "500" });
  const poll = setInterval(() => post(port, "/panel/activity", { "x-lc-companion": "1" }).catch(() => {}), 100);
  t.after(() => clearInterval(poll));
  assert.equal(await within(exited, 3000), 0);
});

test("without RELAY_IDLE_EXIT_MS the relay keeps running", async (t) => {
  const { child } = await startRelay(t, {});
  await sleep(700);
  assert.equal(child.exitCode, null);
});

test("with RELAY_EXIT_WITH_STDIN the relay exits when stdin closes", async (t) => {
  const { child, exited } = await startRelay(t, { RELAY_EXIT_WITH_STDIN: "1" }, "pipe");
  await sleep(100);
  assert.equal(child.exitCode, null);
  child.stdin.end();
  assert.equal(await within(exited, 3000), 0);
});
