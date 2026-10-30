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

// Every companion-only route needs this header (see panel-broker.js).
const COMPANION = { "x-lc-companion": "1" };

// Every helper below gives up after a few seconds. Several routes answer with
// a never-ending stream when a check is broken (a refused /panel/inbox becomes
// a live one), and a helper that waited for the end of that response would
// hang the run instead of failing the test.
const HELPER_TIMEOUT_MS = 3000;

function request({ method = "GET", route, headers = {}, body, port = PORT, timeout = HELPER_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
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
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`${method} ${route} did not finish within ${timeout} ms (an open stream where a refusal was expected?)`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Opens an SSE stream and collects parsed `data:` payloads. Resolves
// `waitFor(predicate)` as soon as the collected events satisfy it.
function openSse({ route, headers = {}, port = PORT }) {
  const events = [];
  const waiters = [];
  let statusCode = null;
  let responseHeaders = null;
  let buffer = "";
  const req = http.get({ host: "127.0.0.1", port, path: route, headers }, (res) => {
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
    ready: (ms = HELPER_TIMEOUT_MS) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ms;
        const check = () => {
          if (statusCode !== null) resolve({ statusCode, headers: responseHeaders });
          else if (Date.now() > deadline) reject(new Error(`${route} sent no response within ${ms} ms`));
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

async function startServer(t, port = PORT) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-capture-panel-test-"));
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, CAPTURE_PORT: String(port), CAPTURE_LOG_PATH: path.join(logDir, "captures.jsonl") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const stop = async () => {
    child.kill();
    await exited;
  };
  t.after(async () => {
    await stop();
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
  return { stop };
}

// A whole-test ceiling too, so a hang nobody anticipated still ends the run.
test("panel broker", { timeout: 60000 }, async (t) => {
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
    // Even with the companion header: a browser can only add it after a
    // preflight, and the real request then carries an Origin.
    const withHeader = await request({ route: "/panel/inbox", headers: { origin: LEETCODE, ...COMPANION } });
    assert.equal(withHeader.status, 403);
  });

  await t.test("a no-Origin request is not enough: no-cors page requests lack the companion header", async () => {
    // What `fetch(url, { mode: "no-cors" })` from any web page looks like.
    const noCors = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" };
    const inbox = await request({ route: "/panel/inbox", headers: noCors });
    assert.equal(inbox.status, 403);
    const bare = await request({ route: "/panel/inbox" });
    assert.equal(bare.status, 403);
    assert.match(JSON.parse(bare.body).error, /x-lc-companion/);
    const publish = await request({ method: "POST", route: "/panel/publish", body: { type: "notice", text: "forged" } });
    assert.equal(publish.status, 403);
    // A cross-site fetch metadata header is refused even alongside the header.
    const crossSite = await request({ route: "/panel/inbox", headers: { ...COMPANION, "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    // The preflight never advertises the companion header as allowed.
    const preflight = await request({
      method: "OPTIONS",
      route: "/panel/inbox",
      headers: { origin: LEETCODE, "access-control-request-headers": "x-lc-companion" },
    });
    assert.doesNotMatch(String(preflight.headers["access-control-allow-headers"]), /x-lc-companion/i);
  });

  await t.test("typed messages lose terminal control characters and need a real slug", async () => {
    const inbox = openSse({ route: "/panel/inbox", headers: COMPANION });
    await inbox.ready();
    const res = await request({
      method: "POST",
      route: "/panel/message",
      headers: { origin: LEETCODE },
      body: { text: "esc-probe \x1b[31mRED\x1b[0m \x1b]0;pwned-title\x07 end\r\n\tok\x9b2J \u202eevil\u202c\u200b!", problemSlug: "two-sum" },
    });
    assert.equal(res.status, 202);
    const [message] = await inbox.waitFor((e) => e.length > 0);
    assert.equal(message.text, "esc-probe [31mRED[0m ]0;pwned-title end\n\tok2J evil!");
    for (const problemSlug of ["two sum", "../x", "a\x1b[31m", ""]) {
      // eslint-disable-next-line no-await-in-loop
      const bad = await request({ method: "POST", route: "/panel/message", headers: { origin: LEETCODE }, body: { text: "hi", problemSlug } });
      assert.equal(bad.status, 400, JSON.stringify(problemSlug));
    }
    // Only control characters: nothing is left to send.
    const empty = await request({ method: "POST", route: "/panel/message", headers: { origin: LEETCODE }, body: { text: "\x1b\x07", problemSlug: "two-sum" } });
    assert.equal(empty.status, 400);
    inbox.close();
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
      headers: COMPANION,
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
    const pub = await request({ method: "POST", route: "/panel/publish", headers: COMPANION, body: { events } });
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
    const bad = await request({ method: "POST", route: "/panel/publish", headers: COMPANION, body: { type: "rm-rf", text: "x" } });
    assert.equal(bad.status, 400);
    const badBatch = await request({
      method: "POST",
      route: "/panel/publish",
      headers: COMPANION,
      body: { events: [{ type: "notice", text: "ok" }, { type: "chunk", text: 42 }] },
    });
    assert.equal(badBatch.status, 400);

    await request({
      method: "POST",
      route: "/panel/publish",
      headers: COMPANION,
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

    const inbox = openSse({ route: "/panel/inbox", headers: COMPANION });
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
    const inbox = openSse({ route: "/panel/inbox", headers: COMPANION });
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

test("unit: stripControlChars and companionOnlyRejection", () => {
  const { stripControlChars, companionOnlyRejection } = require("./panel-broker");
  assert.equal(stripControlChars("a\x00b\x1bc\x7fd\x85e\x9ff\tg\nh\ri"), "abcdef\tg\nhi");
  assert.equal(stripControlChars("plain é ✓"), "plain é ✓");
  // Bidi overrides, isolates and marks, and zero-width characters, are
  // dropped; line separators become newlines; emoji joiners stay.
  assert.equal(stripControlChars("a\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200b\u200e\u200f\u061c\u2060\ufeffb"), "ab");
  assert.equal(stripControlChars("one\u2028two\u2029three"), "one\ntwo\nthree");
  for (const kept of ["👨‍👩‍👧‍👦", "🧑🏽‍💻", "می\u200cخواهم"]) assert.equal(stripControlChars(kept), kept);
  const req = (headers) => ({ headers });
  assert.equal(companionOnlyRejection(req({ "x-lc-companion": "1" })), null);
  assert.equal(companionOnlyRejection(req({ "x-lc-companion": "1", "sec-fetch-site": "none" })), null);
  assert.notEqual(companionOnlyRejection(req({})), null);
  assert.notEqual(companionOnlyRejection(req({ "x-lc-companion": "1", origin: LEETCODE })), null);
  assert.notEqual(companionOnlyRejection(req({ "x-lc-companion": "1", "sec-fetch-site": "same-site" })), null);
});

test("a relay restart: a new epoch, and a client counting from the old run still gets every new event", async (t) => {
  const port = PORT + 3;
  const first = await startServer(t, port);
  const publish = (text) =>
    request({ port, method: "POST", route: "/panel/publish", headers: COMPANION, body: { type: "user", problemSlug: "two-sum", text } });
  for (const text of ["one", "two", "three"]) {
    // eslint-disable-next-line no-await-in-loop
    await publish(text);
  }
  const before = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
  const seen = await before.waitFor((e) => e.some((x) => x.type === "status"));
  const oldEpoch = seen.find((x) => x.type === "status").epoch;
  assert.match(oldEpoch, /^[0-9a-f]{16}$/);
  assert.ok(seen.filter((x) => x.type === "user").every((x) => x.epoch === oldEpoch));
  const lastSeq = Math.max(...seen.filter((x) => x.seq).map((x) => x.seq));
  before.close();

  // Same epoch: `after` is honored.
  const same = openSse({ port, route: `/panel/events?after=${lastSeq}&epoch=${oldEpoch}`, headers: { origin: LEETCODE } });
  assert.equal((await same.waitFor((e) => e.some((x) => x.type === "status"))).filter((x) => x.type === "user").length, 0);
  same.close();

  await first.stop();
  await startServer(t, port);
  await publish("after restart");
  const again = openSse({ port, route: `/panel/events?after=${lastSeq}&epoch=${oldEpoch}`, headers: { origin: LEETCODE } });
  const replay = await again.waitFor((e) => e.some((x) => x.type === "status"));
  const status = replay.find((x) => x.type === "status");
  assert.notEqual(status.epoch, oldEpoch);
  const user = replay.find((x) => x.type === "user");
  assert.equal(user.text, "after restart");
  assert.equal(user.seq, 1); // numbering restarted, which is why the epoch exists
  assert.equal(user.epoch, status.epoch);
  again.close();
});

test("the number of open panel streams is capped", async (t) => {
  const port = PORT + 4;
  await startServer(t, port);
  const streams = [];
  for (let i = 0; i < 20; i += 1) {
    const s = openSse({ port, route: "/panel/events", headers: { origin: LEETCODE } });
    streams.push(s);
    // eslint-disable-next-line no-await-in-loop
    await s.waitFor((e) => e.some((x) => x.type === "status"));
  }
  const over = await request({ port, route: "/panel/events", headers: { origin: LEETCODE } });
  assert.equal(over.status, 503);
  // A closed stream frees its slot.
  streams.pop().close();
  let reopened = null;
  for (let i = 0; i < 50 && !reopened; i += 1) {
    const s = openSse({ port, route: "/panel/events", headers: { origin: LEETCODE } });
    // eslint-disable-next-line no-await-in-loop
    const info = await s.ready();
    if (info.statusCode === 200) reopened = s;
    else {
      s.close();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  assert.ok(reopened, "a slot never freed up");
  reopened.close();
  for (const s of streams) s.close();
});

test("a web page cannot fill the panel-stream cap with requests it cannot read", async (t) => {
  const port = PORT + 5;
  await startServer(t, port);
  // What `fetch(url, { mode: "no-cors" })`, an <img>/<script> tag and an
  // <iframe> on any website send: no Origin, so the origin check alone let
  // them through, and each held one of the 20 slots open.
  const pageRequests = [
    { "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" },
    { "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" },
    { "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" },
  ];
  const held = [];
  for (let i = 0; i < 25; i += 1) {
    const s = openSse({ port, route: "/panel/events", headers: pageRequests[i % pageRequests.length] });
    held.push(s);
    // eslint-disable-next-line no-await-in-loop
    const info = await s.ready();
    assert.equal(info.statusCode, 403, JSON.stringify(pageRequests[i % pageRequests.length]));
  }
  // The real panel (a CORS request from leetcode.com) still gets its stream.
  const panel = openSse({
    port,
    route: "/panel/events",
    headers: { origin: LEETCODE, "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" },
  });
  assert.equal((await panel.ready()).statusCode, 200);
  await panel.waitFor((e) => e.some((x) => x.type === "status"));
  // The companion's own requests (Node's fetch sends Sec-Fetch-Mode: cors
  // and no Origin) still work.
  const inbox = openSse({ port, route: "/panel/inbox", headers: { ...COMPANION, "sec-fetch-mode": "cors" } });
  assert.equal((await inbox.ready()).statusCode, 200);
  const pub = await request({
    port,
    method: "POST",
    route: "/panel/publish",
    headers: { ...COMPANION, "sec-fetch-mode": "cors" },
    body: { type: "notice", text: "still works", problemSlug: "two-sum" },
  });
  assert.equal(pub.status, 200);
  // A no-cors POST is refused too (it carries an Origin, but no route needs
  // anything but CORS).
  const noCorsPost = await request({
    port,
    method: "POST",
    route: "/panel/message",
    headers: { origin: LEETCODE, "sec-fetch-mode": "no-cors" },
    body: { text: "hi", problemSlug: "two-sum" },
  });
  assert.equal(noCorsPost.status, 403);
  for (const s of [...held, panel, inbox]) s.close();
});

test("when the last companion leaves, its unfinished replies are closed as interrupted", async (t) => {
  const port = PORT + 6;
  await startServer(t, port);
  const publish = (events) => request({ port, method: "POST", route: "/panel/publish", headers: COMPANION, body: { events } });
  const inbox = openSse({ port, route: "/panel/inbox", headers: COMPANION });
  assert.equal((await inbox.ready()).statusCode, 200);
  await publish([
    { type: "turn-start", turnId: "t-done", problemSlug: "two-sum" },
    { type: "chunk", turnId: "t-done", text: "All " },
    { type: "turn-end", turnId: "t-done", problemSlug: "two-sum", text: "All done." },
    // Cut off mid-reply, and cut off before its first chunk.
    { type: "turn-start", turnId: "t-half", problemSlug: "two-sum" },
    { type: "chunk", turnId: "t-half", text: "Half " },
    { type: "chunk", turnId: "t-half", text: "a reply" },
    { type: "turn-start", turnId: "t-none", problemSlug: "valid-parentheses" },
  ]);
  const panel = openSse({ port, route: "/panel/events", headers: { origin: LEETCODE } });
  await panel.waitFor((e) => e.some((x) => x.type === "status" && x.companionOnline === true));

  // The companion exits without sending a turn-end (its process is gone).
  inbox.close();
  const live = await panel.waitFor((e) => e.filter((x) => x.type === "status").pop().companionOnline === false);
  const ends = live.filter((x) => x.type === "turn-end" && x.interrupted === true);
  assert.deepEqual(
    ends.map((x) => [x.turnId, x.problemSlug, x.text]),
    [
      ["t-half", "two-sum", "Half a reply"],
      ["t-none", "valid-parentheses", ""],
    ]
  );
  // They arrive before the offline status, and a finished turn is left alone.
  assert.ok(live.indexOf(ends[1]) < live.lastIndexOf(live.filter((x) => x.type === "status").pop()));
  assert.equal(live.filter((x) => x.turnId === "t-done" && x.type === "turn-end").length, 1);
  panel.close();

  // A tab opened later is not shown a reply that is still "typing".
  const late = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
  const replay = await late.waitFor((e) => e.some((x) => x.type === "status"));
  for (const turnId of ["t-half", "t-none"]) {
    const mine = replay.filter((x) => x.turnId === turnId);
    assert.deepEqual(mine.map((x) => x.type), ["turn-start", "turn-end"], turnId);
    assert.equal(mine[1].interrupted, true);
  }
  late.close();

  // The companion's last batch can land after its stream closed; nothing
  // will end that turn either, so it is closed at once.
  await publish([
    { type: "turn-start", turnId: "t-race", problemSlug: "two-sum" },
    { type: "chunk", turnId: "t-race", text: "Last words" },
  ]);
  const raced = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
  const racedReplay = await raced.waitFor((e) => e.some((x) => x.type === "status"));
  const raceEnd = racedReplay.filter((x) => x.turnId === "t-race").pop();
  assert.deepEqual([raceEnd.type, raceEnd.text, raceEnd.interrupted], ["turn-end", "Last words", true]);
  raced.close();

  // A companion that comes back and finishes the same turn (it only lost its
  // inbox stream) still ends it normally, and is not closed a second time.
  const back = openSse({ port, route: "/panel/inbox", headers: COMPANION });
  await back.ready();
  await publish([
    { type: "chunk", turnId: "t-half", text: " finished" },
    { type: "turn-end", turnId: "t-half", problemSlug: "two-sum", text: "Half a reply finished" },
  ]);
  back.close();
  const after = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
  const final = await after.waitFor((e) => e.filter((x) => x.type === "status").length > 0);
  const half = final.filter((x) => x.turnId === "t-half" && x.type === "turn-end");
  assert.equal(half.at(-1).text, "Half a reply finished");
  assert.equal(half.at(-1).interrupted, undefined);
  after.close();
});

test("the status event lists the replies still open, so a panel that lost its stream can tell which are alive", async (t) => {
  const port = PORT + 7;
  await startServer(t, port);
  const publish = (events) => request({ port, method: "POST", route: "/panel/publish", headers: COMPANION, body: { events } });
  const inbox = openSse({ port, route: "/panel/inbox", headers: COMPANION });
  await inbox.ready();
  await publish([
    { type: "turn-start", turnId: "t-done", problemSlug: "two-sum" },
    { type: "turn-end", turnId: "t-done", problemSlug: "two-sum", text: "Done." },
    { type: "turn-start", turnId: "t-open", problemSlug: "two-sum" },
    { type: "turn-start", turnId: "t-streaming", problemSlug: "valid-parentheses" },
    { type: "chunk", turnId: "t-streaming", text: "So far" },
  ]);
  const statusOf = async () => {
    const panel = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
    const events = await panel.waitFor((e) => e.some((x) => x.type === "status"));
    panel.close();
    return events.find((x) => x.type === "status");
  };
  const online = await statusOf();
  assert.equal(online.companionOnline, true);
  assert.deepEqual(online.openTurns, ["t-open", "t-streaming"]);

  // Once the relay has ended them as interrupted they are no longer open.
  inbox.close();
  const panel = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
  const events = await panel.waitFor((e) => e.some((x) => x.type === "status" && x.companionOnline === false));
  panel.close();
  assert.deepEqual(events.find((x) => x.type === "status" && x.companionOnline === false).openTurns, []);

  // A companion that comes back and keeps streaming one reopens it.
  const back = openSse({ port, route: "/panel/inbox", headers: COMPANION });
  await back.ready();
  await publish([{ type: "chunk", turnId: "t-open", text: "Resumed" }]);
  assert.deepEqual((await statusOf()).openTurns, ["t-open"]);
  back.close();
});

test("drop-problem forgets one problem's buffered events, and only the companion may ask", async (t) => {
  const port = PORT + 8;
  await startServer(t, port);
  const publish = (events) => request({ port, method: "POST", route: "/panel/publish", headers: COMPANION, body: { events } });
  const drop = (headers, body = { problemSlug: "two-sum" }) =>
    request({ port, method: "POST", route: "/panel/drop-problem", headers, body });
  const inbox = openSse({ port, route: "/panel/inbox", headers: COMPANION });
  await inbox.ready();
  await publish([
    { type: "user", text: "old question", problemSlug: "two-sum" },
    { type: "turn-start", turnId: "t-old", problemSlug: "two-sum" },
    { type: "chunk", turnId: "t-old", text: "half a reply" },
    { type: "capture", trigger: "run", problemSlug: "house-robber", attemptSeq: 1, note: "Kept for your next message" },
  ]);
  const buffered = async () => {
    const panel = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
    const events = await panel.waitFor((e) => e.some((x) => x.type === "status"));
    panel.close();
    return events;
  };

  // A page (even leetcode.com) cannot wipe the transcript.
  assert.equal((await drop({ origin: LEETCODE })).status, 403);
  assert.equal((await drop({})).status, 403, "the companion header is required");
  assert.equal((await drop(COMPANION, { problemSlug: "../x" })).status, 400);
  assert.equal((await buffered()).filter((e) => e.problemSlug === "two-sum").length, 2);

  assert.equal((await drop(COMPANION)).status, 200);
  const after = await buffered();
  assert.ok(!after.some((e) => e.problemSlug === "two-sum" || e.turnId === "t-old"), JSON.stringify(after));
  // The other problem's events stay (a chip note from an older companion is
  // not passed on), and the dropped reply is no longer listed as open.
  assert.equal(after.find((e) => e.type === "capture").attemptSeq, 1);
  assert.equal(after.find((e) => e.type === "capture").note, undefined);
  assert.deepEqual(after.find((e) => e.type === "status").openTurns, []);
  inbox.close();
});

test("a panel message may carry the live editor code; a malformed one is dropped, not the message", async (t) => {
  const port = PORT + 9;
  await startServer(t, port);
  const inbox = openSse({ port, route: "/panel/inbox", headers: COMPANION });
  await inbox.ready();
  const send = (body) => request({ port, method: "POST", route: "/panel/message", headers: { origin: LEETCODE }, body });
  const code = "def f():\n    return 1\n".repeat(4000); // well past the old 64 KB body cap
  assert.equal(
    (await send({ text: "why?", problemSlug: "two-sum", snapshot: { code, language: "Python3", problemTitle: "Two Sum", problemDescription: "D", extra: "x" } })).status,
    202
  );
  assert.equal((await send({ text: "bad", problemSlug: "two-sum", snapshot: { code: 42 } })).status, 202);
  const events = await inbox.waitFor((e) => e.length >= 2);
  assert.deepEqual(events[0].snapshot, { code, language: "Python3", problemTitle: "Two Sum", problemDescription: "D" });
  assert.equal(events[1].text, "bad");
  assert.equal(events[1].snapshot, undefined);
  inbox.close();
});

test("a panel message body is capped at 256 KB, a snapshot's code at 100,000 characters and its description at 50,000", async (t) => {
  const port = PORT + 10;
  await startServer(t, port);
  const inbox = openSse({ port, route: "/panel/inbox", headers: COMPANION });
  await inbox.ready();
  const send = (body) => request({ port, method: "POST", route: "/panel/message", headers: { origin: LEETCODE }, body });
  // Over the whole-message cap: refused outright.
  assert.equal((await send({ text: "big", problemSlug: "two-sum", snapshot: { code: "x".repeat(300 * 1024) } })).status, 413);
  // Under the body cap, but the code is past its own cap: the message goes, without the snapshot.
  assert.equal((await send({ text: "long code", problemSlug: "two-sum", snapshot: { code: "y".repeat(100_001) } })).status, 202);
  // Code at its cap is kept; a description past its cap is dropped, the code is not.
  const code = "z".repeat(100_000);
  assert.equal(
    (await send({ text: "at cap", problemSlug: "two-sum", snapshot: { code, problemDescription: "d".repeat(50_001) } })).status,
    202
  );
  assert.equal(
    (await send({ text: "both at cap", problemSlug: "two-sum", snapshot: { code, problemDescription: "d".repeat(50_000) } })).status,
    202
  );
  const events = await inbox.waitFor((e) => e.length >= 3);
  assert.equal(events[0].text, "long code");
  assert.equal(events[0].snapshot, undefined);
  assert.deepEqual(events[1].snapshot, { code });
  assert.equal(events[2].snapshot.problemDescription.length, 50_000);
  inbox.close();
});

test("the companion's busy flag reaches every panel in the status event, and clears when it leaves", async (t) => {
  const port = PORT + 11;
  await startServer(t, port);
  const activity = (body, headers = COMPANION) => request({ port, method: "POST", route: "/panel/activity", headers, body });
  const panel = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
  const lastStatus = (events) => events.filter((x) => x.type === "status").pop();
  await panel.waitFor((e) => e.some((x) => x.type === "status"));
  const inbox = openSse({ port, route: "/panel/inbox", headers: COMPANION });
  await inbox.ready();
  await panel.waitFor((e) => lastStatus(e).companionOnline === true);
  assert.equal(lastStatus(await panel.waitFor((e) => e.length > 0)).busy, false);

  assert.equal((await activity({ busy: true }, { origin: LEETCODE })).status, 403);
  assert.equal((await activity({ busy: true }, {})).status, 403);
  assert.equal((await activity({ busy: "yes" })).status, 400);
  assert.equal((await activity({ busy: true })).status, 200);
  await panel.waitFor((e) => lastStatus(e).busy === true);
  // A panel opened now gets it too.
  const later = openSse({ port, route: "/panel/events?after=0", headers: { origin: LEETCODE } });
  assert.equal(lastStatus(await later.waitFor((e) => e.some((x) => x.type === "status"))).busy, true);
  later.close();
  assert.equal((await activity({ busy: false })).status, 200);
  await panel.waitFor((e) => lastStatus(e).busy === false);
  assert.equal((await activity({ busy: true })).status, 200);
  await panel.waitFor((e) => lastStatus(e).busy === true);
  // The companion goes away mid-turn: nothing would ever clear it, so the relay does.
  inbox.close();
  const gone = await panel.waitFor((e) => lastStatus(e).companionOnline === false);
  assert.equal(lastStatus(gone).busy, false);
  panel.close();
});

// ---- the options page's settings calls and the config event ------------------
//
// These run the broker in-process (createPanelBroker behind a plain http
// server on an ephemeral port), so the call timeout can be made short.

const { createPanelBroker, sanitizeConfig, sanitizeEvent, EXTENSION_ORIGIN_RE } = require("./panel-broker");

const CHROME_EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const FIREFOX_EXT = "moz-extension://0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";

async function startInProcess(t, options = {}) {
  let broker;
  const server = http.createServer((req, res) => {
    if (!broker.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  broker = createPanelBroker({ port, ...options });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return port;
}

// Plays the companion: an open inbox stream and a way to answer settings calls.
async function companionInbox(port) {
  const inbox = openSse({ route: "/panel/inbox", headers: { ...COMPANION, "sec-fetch-mode": "cors" }, port });
  await inbox.ready();
  return {
    inbox,
    nextRpc: async (n = 1) => (await inbox.waitFor((evs) => evs.filter((e) => e.type === "rpc").length >= n)).filter((e) => e.type === "rpc")[n - 1],
    answer: (id, response, headers = COMPANION) =>
      request({ method: "POST", route: "/panel/rpc-result", headers, body: { id, response }, port }),
  };
}

const rpcCall = (port, { origin = CHROME_EXT, body = { method: "get", params: {} }, headers = {}, timeout } = {}) =>
  request({
    method: "POST",
    route: "/settings/rpc",
    headers: { ...(origin ? { origin } : {}), "sec-fetch-mode": "cors", ...headers },
    body,
    port,
    timeout,
  });

test("unit: the extension origin pattern and sanitizeConfig", () => {
  assert.ok(EXTENSION_ORIGIN_RE.test(CHROME_EXT));
  assert.ok(EXTENSION_ORIGIN_RE.test(FIREFOX_EXT));
  for (const bad of [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnoq", // q is not a Chrome id letter
    "chrome-extension://abcdefghijklmnop",
    `${CHROME_EXT}.evil.com`,
    "https://leetcode.com",
    "null",
    "moz-extension://not-a-uuid",
  ]) {
    assert.ok(!EXTENSION_ORIGIN_RE.test(bad), bad);
  }
  assert.deepEqual(sanitizeConfig({ type: "config", provider: "local", label: "Local model", model: "m", apiKey: "sk-x" }), {
    type: "config",
    provider: "local",
    label: "Local model",
    model: "m",
  });
  assert.equal(sanitizeConfig({ provider: "Local!", label: "x" }), null);
  assert.equal(sanitizeConfig({ provider: "local" }), null);
});

test("settings calls: only an extension origin with the right Host may call, and 503 without a companion", async (t) => {
  const port = await startInProcess(t);
  for (const origin of [null, "https://leetcode.com", "https://evil.example", "null", "chrome-extension://short"]) {
    const res = await rpcCall(port, { origin });
    assert.equal(res.status, 403, `origin ${origin}`);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  }
  const rebound = await rpcCall(port, { headers: { host: `evil.example:${port}` } });
  assert.equal(rebound.status, 403, "a rebound Host is refused");
  const noCors = await rpcCall(port, { headers: { "sec-fetch-mode": "no-cors" } });
  assert.equal(noCors.status, 403);

  const preflight = await request({
    method: "OPTIONS",
    route: "/settings/rpc",
    headers: { origin: FIREFOX_EXT, "access-control-request-method": "POST", "sec-fetch-mode": "cors" },
    port,
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], FIREFOX_EXT);
  const foreignPreflight = await request({ method: "OPTIONS", route: "/settings/rpc", headers: { origin: "https://evil.example" }, port });
  assert.equal(foreignPreflight.status, 403);

  const offline = await rpcCall(port);
  assert.equal(offline.status, 503);
  assert.equal(JSON.parse(offline.body).ok, false);
  assert.equal(offline.headers["access-control-allow-origin"], CHROME_EXT);

  const bad = await rpcCall(port, { body: { method: "drop tables" } });
  assert.equal(bad.status, 400);
});

test("settings calls reach the companion over its inbox and its answer comes back to the caller", async (t) => {
  const port = await startInProcess(t);
  const companion = await companionInbox(port);
  t.after(() => companion.inbox.close());

  const pending = rpcCall(port, { origin: FIREFOX_EXT, body: { method: "save", params: { patch: { provider: "local" } } } });
  const call = await companion.nextRpc();
  assert.equal(call.method, "save");
  assert.deepEqual(call.params, { patch: { provider: "local" } });
  assert.match(call.id, /^[0-9a-f]{24}$/);

  // Only the companion may answer: a page (any Origin) or a request without
  // the companion header is refused, and the caller keeps waiting.
  assert.equal((await companion.answer(call.id, { ok: true, result: {} }, { origin: CHROME_EXT, ...COMPANION })).status, 403);
  assert.equal((await companion.answer(call.id, { ok: true, result: {} }, {})).status, 403);
  assert.equal((await companion.answer(call.id, "not an object")).status, 400);

  const answered = await companion.answer(call.id, { ok: true, result: { saved: true } });
  assert.equal(answered.status, 200);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, result: { saved: true } });
  assert.equal(res.headers["access-control-allow-origin"], FIREFOX_EXT);

  assert.equal((await companion.answer(call.id, { ok: true })).status, 404, "a second answer has no one waiting");
  assert.equal((await companion.answer("nope", { ok: true })).status, 404);
});

test("a settings call the companion never answers times out with a clear message", async (t) => {
  const port = await startInProcess(t, { rpcTimeoutMs: 300 });
  const companion = await companionInbox(port);
  t.after(() => companion.inbox.close());
  const res = await rpcCall(port, { body: { method: "test", params: { patch: {} } } });
  assert.equal(res.status, 504);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error.message, /did not answer/);
  const call = await companion.nextRpc();
  assert.equal((await companion.answer(call.id, { ok: true })).status, 404, "a late answer is dropped");
});

test("the newest config event goes to every panel, also to panels that connect later, and stays out of the buffer", async (t) => {
  const port = await startInProcess(t);
  const companion = await companionInbox(port);
  t.after(() => companion.inbox.close());
  const panelHeaders = { origin: LEETCODE, "sec-fetch-mode": "cors" };
  const early = openSse({ route: "/panel/events?after=0", headers: panelHeaders, port });
  t.after(() => early.close());
  await early.ready();

  const publish = (events) => request({ method: "POST", route: "/panel/publish", headers: COMPANION, body: { events }, port });
  assert.equal((await publish([{ type: "config", provider: "local", label: "Local model", model: "m1" }])).status, 200);
  assert.equal(
    (await publish([{ type: "config", provider: "openai", label: "OpenAI API key", model: "gpt-x" }, { type: "notice", problemSlug: "two-sum", text: "hi" }])).status,
    200
  );
  await early.waitFor((evs) => evs.filter((e) => e.type === "config").length === 2 && evs.some((e) => e.type === "notice"));
  assert.equal(early.events.filter((e) => e.type === "config")[1].provider, "openai");
  assert.ok(early.events.filter((e) => e.type === "config").every((e) => e.seq === undefined));
  assert.equal((await publish([{ type: "config", provider: "local", label: "x", apiKey: 5, model: 7 }])).status, 400);

  const late = openSse({ route: "/panel/events?after=0", headers: panelHeaders, port });
  t.after(() => late.close());
  const replay = await late.waitFor((evs) => evs.some((e) => e.type === "status"));
  const types = replay.map((e) => e.type);
  assert.deepEqual(types, ["notice", "config", "status"], "the replay, then the one newest config, then status");
  assert.equal(replay[1].model, "gpt-x");
});

test("unit: sanitizeEvent keeps the switch flag only on a notice, and only as true", () => {
  assert.equal(sanitizeEvent({ type: "notice", text: "fresh", problemSlug: "a", switch: true }).switch, true);
  assert.equal(sanitizeEvent({ type: "notice", text: "fresh", problemSlug: "a", switch: "yes" }).switch, undefined);
  assert.equal(sanitizeEvent({ type: "user", text: "hi", problemSlug: "a", switch: true }).switch, undefined);
});
