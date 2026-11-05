// The background worker's side of the Native Messaging helper (helper/ at the
// repository root): while the helper runtime is chosen, the nativeMessaging
// permission is granted and at least one LeetCode problem tab is open, keep a
// native port to the helper, which runs the companion and relay for as long
// as that port stays open.
//
// Tabs are counted through each tab's long-lived Tutor panel port (a hidden
// tab drops its event stream but keeps that port). The rules:
//   - The first tab connects the helper and asks it to start.
//   - After the last tab closes, wait GRACE_MS, then disconnect (the helper
//     then stops the companion and relay). A tab opening meanwhile cancels it.
//   - The active problem is the tab the student last sent a message, Run or
//     Submit from. If that tab closes while others stay open, wait GRACE_MS,
//     then ask the helper to reset the tutor's context (the processes keep
//     running). Reloading that tab, or opening the same problem again,
//     meanwhile cancels it.
//   - A ping every PING_MS tells the helper someone is still there; it exits
//     on its own after a few quiet minutes (a crashed browser, say).
//   - A port that drops for another reason is retried with a growing delay.
//     A helper that is not installed is not retried until retry().
//
// Pure JavaScript with no Node or browser API: connectNative, the timers and
// the error lookup are passed in (extension/shared.test.js checks that).

export const HELPER_HOST_NAME = 'dev.thomsonklee.leetcode_capture';
export const GRACE_MS = 30_000;
export const PING_MS = 60_000;
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 60_000;

// How Chrome and Firefox say the host is not registered.
const NOT_INSTALLED_RE = /not found|no such native application|not registered|access to the specified native messaging host is forbidden/i;

export function problemSlugFromUrl(url) {
  const m = /^https:\/\/leetcode\.com\/problems\/([^/?#]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

export function createHelperLauncher({
  connectNative,
  lastError = () => null,
  timers,
  graceMs = GRACE_MS,
  pingMs = PING_MS,
  log = () => {},
}) {
  const tabs = new Map(); // tabId -> { ports, slug }
  const listeners = new Set();
  let wanted = false;
  let held = false; // the options page needs the helper, with or without a problem tab
  let port = null;
  let state = 'idle'; // idle | connecting | running | not-installed | error
  let host = null; // the helper's newest status message
  let error = null;
  let active = null; // { tabId, slug }
  let stopTimer = null;
  let resetTimer = null;
  let resetFor = null; // { tabId, slug } the pending reset is about
  let pingTimer = null;
  let retryTimer = null;
  let retryDelay = RETRY_MIN_MS;
  let nextId = 1;

  function emit() {
    const snapshot = view();
    for (const listener of listeners) listener(snapshot);
  }

  function view() {
    return { wanted, state, tabs: tabs.size, host, error };
  }

  function post(message) {
    if (!port) return false;
    try {
      port.postMessage({ id: nextId++, ...message });
      return true;
    } catch {
      return false;
    }
  }

  function clear(timer) {
    if (timer !== null) timers.clearTimeout(timer);
    return null;
  }

  function disconnect(nextState = 'idle') {
    pingTimer = pingTimer !== null ? (timers.clearInterval(pingTimer), null) : null;
    retryTimer = clear(retryTimer);
    stopTimer = clear(stopTimer);
    resetTimer = clear(resetTimer);
    resetFor = null;
    const current = port;
    port = null;
    if (current) {
      try {
        current.disconnect();
      } catch {
        // already gone
      }
    }
    host = null;
    if (state !== 'not-installed' || nextState !== 'idle') state = nextState;
    emit();
  }

  function connect() {
    if (port || state === 'not-installed') return;
    retryTimer = clear(retryTimer);
    let next;
    try {
      next = connectNative(HELPER_HOST_NAME);
    } catch (err) {
      state = 'error';
      error = err && err.message ? err.message : String(err);
      emit();
      return;
    }
    port = next;
    state = 'connecting';
    error = null;
    next.onMessage.addListener((message) => {
      if (port !== next || !message || typeof message !== 'object') return;
      if (message.type === 'status') {
        host = message;
        error = message.error || null;
        state = 'running';
        retryDelay = RETRY_MIN_MS;
        emit();
      }
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      pingTimer = pingTimer !== null ? (timers.clearInterval(pingTimer), null) : null;
      host = null;
      const reason = lastError(next);
      if (reason && NOT_INSTALLED_RE.test(reason)) {
        state = 'not-installed';
        error = reason;
      } else {
        state = 'error';
        error = reason || 'The helper stopped.';
        log(`helper disconnected: ${error}`);
        if (wanted && (tabs.size > 0 || held)) {
          retryTimer = timers.setTimeout(() => {
            retryTimer = null;
            if (wanted && (tabs.size > 0 || held)) connect();
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
        }
      }
      emit();
    });
    post({ type: 'start' });
    pingTimer = timers.setInterval(() => post({ type: 'ping' }), pingMs);
    emit();
  }

  // Whether the processes should be running right now, applied.
  function update() {
    if (!wanted) {
      if (port || state === 'connecting' || retryTimer !== null) disconnect();
      return;
    }
    if (tabs.size > 0 || held) {
      stopTimer = clear(stopTimer);
      connect();
    } else if (port && stopTimer === null) {
      stopTimer = timers.setTimeout(() => {
        stopTimer = null;
        if (tabs.size === 0) disconnect();
      }, graceMs);
    }
  }

  return {
    // A Tutor panel port opened in this tab.
    tabOpened(tabId, url) {
      const entry = tabs.get(tabId) || { ports: 0, slug: null };
      entry.ports += 1;
      entry.slug = problemSlugFromUrl(url) || entry.slug;
      tabs.set(tabId, entry);
      if (resetFor && (resetFor.tabId === tabId || (entry.slug && entry.slug === resetFor.slug))) {
        resetTimer = clear(resetTimer);
        resetFor = null;
        active = { tabId, slug: entry.slug };
      }
      update();
      emit();
    },

    tabClosed(tabId) {
      const entry = tabs.get(tabId);
      if (!entry) return;
      entry.ports -= 1;
      if (entry.ports > 0) return;
      tabs.delete(tabId);
      if (tabs.size > 0 && active && active.tabId === tabId && port) {
        resetTimer = clear(resetTimer);
        resetFor = active;
        active = null;
        resetTimer = timers.setTimeout(() => {
          resetTimer = null;
          resetFor = null;
          post({ type: 'reset' });
        }, graceMs);
      }
      update();
      emit();
    },

    // The student sent a message, Run or Submit from this tab.
    markActive(tabId) {
      const entry = tabs.get(tabId);
      if (!entry) return;
      active = { tabId, slug: entry.slug };
      // The pending reset was about the old problem; whatever the companion
      // does on a switch of problem now applies instead.
      resetTimer = clear(resetTimer);
      resetFor = null;
    },

    // Whether the helper runtime is chosen and the permission granted.
    setWanted(next) {
      wanted = Boolean(next);
      if (wanted && state === 'not-installed' && !port) state = 'idle';
      update();
      emit();
    },

    // The options page is open on a provider that runs through the helper:
    // keep the helper up for it as for a problem tab, so Settings can save.
    // Letting go starts the usual grace period.
    setHeld(next) {
      held = Boolean(next);
      update();
      emit();
    },

    // Try again after the student installed the helper.
    retry() {
      if (state === 'not-installed' || state === 'error') state = 'idle';
      retryDelay = RETRY_MIN_MS;
      update();
      // A host that is still there may have lost its relay or tutor: asking it
      // to start again is harmless when they run, and brings them back if not.
      if (port) post({ type: 'start' });
      emit();
      return view();
    },

    view,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
