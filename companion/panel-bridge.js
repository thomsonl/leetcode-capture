// companion/panel-bridge.js - mirrors the tutor conversation to the in-page
// panel (the extension's panel.js on leetcode.com) through the relay server.
//
// Two directions, both over the relay (see relay-server/panel-broker.js):
//   - publish(event): tutor/user/capture events go out in batches to
//     POST /panel/publish. Best effort: the terminal chat is the source of
//     truth, so a relay hiccup drops panel events rather than disturbing it.
//   - inbox: a long-lived GET /panel/inbox stream delivers messages the
//     student typed into the panel, handed to onMessage. It reconnects with
//     backoff for as long as the bridge runs, which is also how the panel
//     learns whether a companion is online at all.
//   - setBusy(busy): tells the relay whether the tutor is working on a turn
//     (POST /panel/activity), for the panel's "Processing" light.
//   - dropProblem(slug): asks the relay to forget one problem's buffered
//     events (POST /panel/drop-problem) once the tutor has moved on from it.
//     It goes out after everything published before it, so the old
//     problem's last events cannot land after the drop.
//
// Kept free of any terminal/readline code so it can be tested against a stub
// relay without booting companion.js.

const FLUSH_MS = 40;
// A relay that accepts a publish but never answers must not stall the flush
// chain (and with it every later publish) forever.
const PUBLISH_TIMEOUT_MS = 5000;
// While a publish is slow the queue keeps growing; past this many events the
// oldest are dropped. Losing them is fine (the panel tolerates a missing
// turn-start, and a turn-end carries the full text), running out of memory is
// not.
const MAX_QUEUED_EVENTS = 1000;
// The relay's companion-only routes require this header; a browser page cannot
// send it without a CORS preflight, which the relay refuses (see
// relay-server/panel-broker.js, companionOnlyRejection).
const COMPANION_HEADERS = { 'X-LC-Companion': '1' };
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 8000;

// Parses one SSE block ("id: 3\ndata: {...}") into its JSON payload, or null
// for a comment/keep-alive/malformed block.
export function parseSseBlock(block) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function createPanelBridge({
  baseUrl,
  onMessage,
  onState,
  fetchImpl = fetch,
  flushMs = FLUSH_MS,
  publishTimeoutMs = PUBLISH_TIMEOUT_MS,
}) {
  let stopped = false;
  let queue = [];
  let flushTimer = null;
  let flushing = Promise.resolve();
  let inboxAbort = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let state = 'connecting';

  function setState(next) {
    if (state === next) return;
    state = next;
    if (onState) onState(next);
  }

  function publish(event) {
    if (stopped) return;
    const last = queue[queue.length - 1];
    // Consecutive chunks of one turn travel as one: the panel only ever
    // concatenates them, and a long reply would otherwise cost one HTTP
    // request per streamed token.
    if (last && event.type === 'chunk' && last.type === 'chunk' && last.turnId === event.turnId) {
      last.text += event.text;
    } else {
      queue.push({ ...event });
      if (queue.length > MAX_QUEUED_EVENTS) queue.splice(0, queue.length - MAX_QUEUED_EVENTS);
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushing = flushing.then(flushQueue);
      }, flushMs);
      flushTimer.unref();
    }
  }

  async function flushQueue() {
    if (queue.length === 0) return;
    const events = queue;
    queue = [];
    try {
      await fetchImpl(`${baseUrl}/panel/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...COMPANION_HEADERS },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(publishTimeoutMs),
      });
    } catch {
      // Best effort - see the file header.
    }
  }

  async function runInbox() {
    while (!stopped) {
      inboxAbort = new AbortController();
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl(`${baseUrl}/panel/inbox`, {
          headers: COMPANION_HEADERS,
          signal: inboxAbort.signal,
        });
        if (res.status === 404) {
          // A relay server started before this feature existed.
          setState('unsupported');
        } else if (res.ok && res.body) {
          reconnectDelay = RECONNECT_MIN_MS;
          setState('connected');
          if (busy) flushing = flushing.then(postActivity);
          const decoder = new TextDecoder();
          let buffer = '';
          // eslint-disable-next-line no-restricted-syntax
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let idx;
            // eslint-disable-next-line no-cond-assign
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              const message = parseSseBlock(buffer.slice(0, idx));
              buffer = buffer.slice(idx + 2);
              if (message && typeof message.text === 'string') onMessage(message);
            }
          }
        }
      } catch {
        // Relay not up (yet) or the stream dropped - fall through to retry.
      }
      if (stopped) return;
      if (state === 'connected') setState('disconnected');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        const t = setTimeout(resolve, reconnectDelay);
        t.unref();
      });
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }
  }

  async function postDrop(problemSlug) {
    try {
      await fetchImpl(`${baseUrl}/panel/drop-problem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...COMPANION_HEADERS },
        body: JSON.stringify({ problemSlug }),
        signal: AbortSignal.timeout(publishTimeoutMs),
      });
    } catch {
      // Best effort - see the file header.
    }
  }

  // Tells the relay whether the tutor is working on (or has queued) a turn,
  // for the panel's status light. Sent in order after everything published
  // before it, and again whenever the inbox (re)connects, since a restarted
  // relay starts out idle.
  let busy = false;
  async function postActivity() {
    try {
      await fetchImpl(`${baseUrl}/panel/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...COMPANION_HEADERS },
        body: JSON.stringify({ busy }),
        signal: AbortSignal.timeout(publishTimeoutMs),
      });
    } catch {
      // Best effort - see the file header.
    }
  }

  function setBusy(next) {
    if (stopped || busy === Boolean(next)) return;
    busy = Boolean(next);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushing = flushing.then(flushQueue).then(postActivity);
  }

  function dropProblem(problemSlug) {
    if (stopped || typeof problemSlug !== 'string' || !problemSlug) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushing = flushing.then(flushQueue).then(() => postDrop(problemSlug));
  }

  return {
    publish,
    dropProblem,
    setBusy,
    start() {
      runInbox();
    },
    stop() {
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (inboxAbort) inboxAbort.abort();
    },
    // Resolves once everything queued so far has been sent (for tests).
    async drain() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
        flushing = flushing.then(flushQueue);
      }
      await flushing;
    },
    get state() {
      return state;
    },
  };
}
