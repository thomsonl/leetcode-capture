// Tests for the in-page tutor panel broker (panel-broker.js), run against a
// real spawned relay server rather than a mock, same as server.test.js.
//
// Run with: node --test relay-server/panel-broker.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = 18190; // distinct from server.test.js's 18135 and the dev default 8135
const LEETCODE = "https://leetcode.com";

function request({ method = "GET", route, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: route,
        method,
        headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Opens an SSE stream and collects parsed `data:` payloads. Resolves
// `waitFor(predicate)` as soon as the collected events satisfy it.
function openSse({ route, headers = {} }) {
  const events = [];
  const waiters = [];
  let statusCode = null;
  let responseHeaders = null;
  let buffer = "";
  const req = http.get({ host: "127.0.0.1", port: PORT, path: route, headers }, (res) => {
    statusCode = res.statusCode;
    responseHeaders = res.headers;
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        events.push(JSON.parse(dataLine.slice(6)));
        for (const w of [...waiters]) w();
      }
    });
  });
  req.on("error", () => {});
  return {
    events,
    close: () => req.destroy(),
    ready: () =>
      new Promise((resolve) => {
        const check = () => {
          if (statusCode !== null) resolve({ statusCode, headers: responseHeaders });
          else setTimeout(check, 10);
        };
        check();
      }),
    waitFor: (predicate, ms = 3000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(events)}`)), ms);
        const check = () => {
          if (predicate(events)) {
            clearTimeout(timer);
            const i = waiters.indexOf(check);
            if (i !== -1) waiters.splice(i, 1);
            resolve(events);
          }
        };
        waiters.push(check);
        check();
      }),
  };
}

async function startServer(t) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-capture-panel-test-"));
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, CAPTURE_PORT: String(PORT), CAPTURE_LOG_PATH: path.join(logDir, "captures.jsonl") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill();
    fs.rmSync(logDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 5000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
}

test("panel broker", async (t) => {
  await startServer(t);

  await t.test("rejects a request whose Host is not the relay's own loopback address (DNS rebinding)", async () => {
    const res = await request({ route: "/panel/events", headers: { host: `evil.example:${PORT}` } });
    assert.equal(res.status, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });

  await t.test("rejects any origin other than https://leetcode.com, without leaking CORS headers", async () => {
    for (const origin of ["https://evil.example", "http://leetcode.com", "null", "chrome-extension://abc"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request({ route: "/panel/events", headers: { origin } });
      assert.equal(res.status, 403, origin);
      assert.equal(res.headers["access-control-allow-origin"], undefined, origin);
    }
    const msg = await request({
      method: "POST",
      route: "/panel/message",
      headers: { origin: "https://evil.example" },
      body: { text: "hi", problemSlug: "two-sum" },
    });
    assert.equal(msg.status, 403);
  });

  await t.test("answers the preflight for leetcode.com, including the private-network opt-in", async () => {
    const res = await request({
      method: "OPTIONS",
      route: "/panel/message",
      headers: {
        origin: LEETCODE,
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], LEETCODE);
    assert.equal(res.headers["access-control-allow-private-network"], "true");
    assert.match(res.headers.vary, /Origin/);
  });

  await t.test("publish and inbox are companion-only: refused for any browser origin, even leetcode.com", async () => {
    const publish = await request({
      method: "POST",
      route: "/panel/publish",
      headers: { origin: LEETCODE },
      body: { type: "notice", text: "forged" },
    });
    assert.equal(publish.status, 403);
    const inbox = await request({ route: "/panel/inbox", headers: { origin: LEETCODE } });
    assert.equal(inbox.status, 403);
  });

  await t.test("a published event reaches a panel stream and is replayed to a late joiner", async () => {
    const live = openSse({ route: "/panel/events", headers: { origin: LEETCODE } });
    const info = await live.ready();
    assert.equal(info.statusCode, 200);
    assert.match(info.headers["content-type"], /text\/event-stream/);
    assert.match(info.headers["cache-control"], /no-store/); // a never-ending stream must not take Chrome's HTTP-cache lock
    assert.equal(info.headers["access-control-allow-origin"], LEETCODE);

    const pub = await request({
      method: "POST",
      route: "/panel/publish",
      body: { type: "user", problemSlug: "two-sum", text: "hello tutor" },
    });
    assert.equal(pub.status, 200);
    await live.waitFor((e) => e.some((x) => x.type === "user" && x.text === "hello tutor"));
    live.close();

    const late = openSse({ route: "/panel/events?after=0", headers: { origin: LEETCODE } });
    await late.waitFor((e) => e.some((x) => x.type === "user" && x.text === "hello tutor"));
    const replayed = late.events.find((x) => x.type === "user");
    assert.equal(replayed.problemSlug, "two-sum");
    assert.ok(replayed.seq > 0);

    // `after` skips what the client already has.
    const caughtUp = openSse({ route: `/panel/events?after=${replayed.seq}`, headers: { origin: LEETCODE } });
    await caughtUp.waitFor((e) => e.some((x) => x.type === "status"));
    assert.equal(caughtUp.events.filter((x) => x.type === "user").length, 0);
    late.close();
    caughtUp.close();
  });

  await t.test("a turn-end replaces its chunks in the replay buffer", async () => {
    const events = [
      { type: "turn-start", turnId: "t-compact", problemSlug: "two-sum" },
      { type: "chunk", turnId: "t-compact", text: "Hel" },
      { type: "chunk", turnId: "t-compact", text: "lo" },
      { type: "turn-end", turnId: "t-compact", problemSlug: "two-sum", text: "Hello" },
    ];
    const pub = await request({ method: "POST", route: "/panel/publish", body: { events } });
    assert.equal(pub.status, 200);

    const late = openSse({ route: "/panel/events?after=0", headers: { origin: LEETCODE } });
    await late.waitFor((e) => e.some((x) => x.type === "status"));
    const mine = late.events.filter((x) => x.turnId === "t-compact");
    assert.deepEqual(
      mine.map((x) => x.type),
      ["turn-start", "turn-end"]
    );
    assert.equal(mine[1].text, "Hello");
    late.close();
  });

  await t.test("drops unknown fields and rejects malformed events", async () => {
    const bad = await request({ method: "POST", route: "/panel/publish", body: { type: "rm-rf", text: "x" } });
    assert.equal(bad.status, 400);
    const badBatch = await request({
      method: "POST",
      route: "/panel/publish",
      body: { events: [{ type: "notice", text: "ok" }, { type: "chunk", text: 42 }] },
    });
    assert.equal(badBatch.status, 400);

    await request({
      method: "POST",
      route: "/panel/publish",
      body: { type: "notice", text: "tidy", problemSlug: "two-sum", secret: "do not store" },
    });
    const late = openSse({ route: "/panel/events?after=0", headers: { origin: LEETCODE } });
    await late.waitFor((e) => e.some((x) => x.type === "status"));
    const notice = late.events.find((x) => x.type === "notice" && x.text === "tidy");
    assert.ok(notice);
    assert.equal(notice.secret, undefined);
    late.close();
  });

  await t.test("a typed message gets 503 with no companion, then is delivered once one connects", async () => {
    const panel = openSse({ route: "/panel/events", headers: { origin: LEETCODE } });
    await panel.waitFor((e) => e.some((x) => x.type === "status" && x.companionOnline === false));

    const offline = await request({
      method: "POST",
      route: "/panel/message",
      headers: { origin: LEETCODE },
      body: { text: "any hints?", problemSlug: "two-sum" },
    });
    assert.equal(offline.status, 503);

    const inbox = openSse({ route: "/panel/inbox" });
    await inbox.ready();
    await panel.waitFor((e) => e.some((x) => x.type === "status" && x.companionOnline === true));

    const sent = await request({
      method: "POST",
      route: "/panel/message",
      headers: { origin: LEETCODE },
      body: { text: "any hints?", problemSlug: "two-sum" },
    });
    assert.equal(sent.status, 202);
    assert.equal(sent.headers["access-control-allow-origin"], LEETCODE);
    await inbox.waitFor((e) => e.some((x) => x.text === "any hints?" && x.problemSlug === "two-sum"));

    // The panel is told the moment the companion goes away again.
    inbox.close();
    await panel.waitFor((e) => e.filter((x) => x.type === "status").pop().companionOnline === false);
    panel.close();
  });

  await t.test("validates typed messages", async () => {
    const inbox = openSse({ route: "/panel/inbox" });
    await inbox.ready();
    for (const body of [
      { text: "", problemSlug: "two-sum" },
      { text: "   ", problemSlug: "two-sum" },
      { text: "hi" },
      { text: "x".repeat(8001), problemSlug: "two-sum" },
      { text: 5, problemSlug: "two-sum" },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request({ method: "POST", route: "/panel/message", headers: { origin: LEETCODE }, body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    }
    inbox.close();
  });

  await t.test("leaves /capture and unknown routes alone", async () => {
    const res = await request({ route: "/nope" });
    assert.equal(res.status, 404);
    const capture = await request({
      method: "POST",
      route: "/capture",
      body: { problemSlug: "two-sum", language: "python3", code: "x", trigger: "run", timestamp: new Date().toISOString() },
    });
    assert.equal(capture.status, 200);
    assert.equal(capture.headers["access-control-allow-origin"], "*");
  });
});
