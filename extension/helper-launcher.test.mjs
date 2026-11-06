// The background worker's helper launcher: tab counting, the 30 second grace
// before stopping, the reset after the active tab closes, pings, retries and
// the not-installed state. Fake timers and a fake native port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelperLauncher, GRACE_MS, HELPER_HOST_NAME, PING_MS, problemSlugFromUrl } from './shared/helper-launcher.js';
import {
  NATIVE_RELOAD_KEY,
  RELOAD_DELAY_MS,
  RESUME_MAX_AGE_MS,
  SETTINGS_RESUME_KEY,
  createNativeSetup,
  freshResume,
  nativeApiDecision,
} from './shared/native-setup.js';

function fakeEvent() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), fire: (...args) => listeners.forEach((fn) => fn(...args)) };
}

function setup(t, { error = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ports = [];
  const launcher = createHelperLauncher({
    connectNative: (name) => {
      assert.equal(name, HELPER_HOST_NAME);
      const port = {
        sent: [],
        disconnected: false,
        onMessage: fakeEvent(),
        onDisconnect: fakeEvent(),
        postMessage(m) {
          if (this.disconnected) throw new Error('disconnected');
          this.sent.push(m);
        },
        disconnect() {
          this.disconnected = true;
        },
        // The helper side going away.
        drop(reason = null) {
          this.disconnected = true;
          this.reason = reason;
          this.onDisconnect.fire(this);
        },
      };
      ports.push(port);
      return port;
    },
    lastError: (port) => port.reason ?? error,
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
  });
  const types = (port) => port.sent.map((m) => m.type);
  const tick = (ms) => t.mock.timers.tick(ms);
  return { launcher, ports, types, tick, last: () => ports[ports.length - 1] };
}

const URL_A = 'https://leetcode.com/problems/two-sum/description/';
const URL_B = 'https://leetcode.com/problems/add-two-numbers/';

test('problemSlugFromUrl', () => {
  assert.equal(problemSlugFromUrl(URL_A), 'two-sum');
  assert.equal(problemSlugFromUrl('https://leetcode.com/problemset/'), null);
  assert.equal(problemSlugFromUrl('https://evil.example/problems/two-sum/'), null);
});

test('nothing connects until the helper is wanted and a tab is open', (t) => {
  const { launcher, ports } = setup(t);
  launcher.tabOpened(1, URL_A);
  assert.equal(ports.length, 0);
  launcher.setWanted(true);
  assert.equal(ports.length, 1);
  assert.equal(launcher.view().state, 'connecting');
});

test('the first tab starts the helper; status messages mark it running', (t) => {
  const { launcher, ports, types } = setup(t);
  launcher.setWanted(true);
  assert.equal(ports.length, 0);
  launcher.tabOpened(1, URL_A);
  launcher.tabOpened(2, URL_B);
  assert.equal(ports.length, 1);
  assert.deepEqual(types(ports[0]), ['start']);
  ports[0].onMessage.fire({ type: 'status', relay: { state: 'running' }, companion: { state: 'running' }, error: null });
  assert.equal(launcher.view().state, 'running');
  assert.equal(launcher.view().tabs, 2);
});

test('the last tab closing stops everything after the grace, not before', (t) => {
  const { launcher, ports, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  launcher.tabClosed(1);
  tick(GRACE_MS - 1);
  assert.equal(ports[0].disconnected, false);
  tick(1);
  assert.equal(ports[0].disconnected, true);
  assert.equal(launcher.view().state, 'idle');
});

test('a tab opening within the grace cancels the stop', (t) => {
  const { launcher, ports, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  launcher.tabClosed(1);
  tick(GRACE_MS / 2);
  launcher.tabOpened(1, URL_A); // a reload
  tick(GRACE_MS * 2);
  assert.equal(ports[0].disconnected, false);
  assert.equal(ports.length, 1);
});

test('two ports from one tab count as one tab', (t) => {
  const { launcher, ports, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  launcher.tabOpened(1, URL_A);
  launcher.tabClosed(1);
  tick(GRACE_MS * 2);
  assert.equal(ports[0].disconnected, false);
  launcher.tabClosed(1);
  tick(GRACE_MS);
  assert.equal(ports[0].disconnected, true);
});

test('the active tab closing while others stay resets the context after the grace, keeping the helper', (t) => {
  const { launcher, ports, types, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  launcher.tabOpened(2, URL_B);
  launcher.markActive(1);
  launcher.tabClosed(1);
  tick(GRACE_MS - 1);
  assert.deepEqual(types(ports[0]), ['start']);
  tick(1);
  assert.deepEqual(types(ports[0]), ['start', 'reset']);
  assert.equal(ports[0].disconnected, false);
  // Only once.
  tick(GRACE_MS * 2);
  assert.equal(types(ports[0]).filter((x) => x === 'reset').length, 1);
});

test('reopening the active problem within the grace keeps the context', (t) => {
  const { launcher, ports, types, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  launcher.tabOpened(2, URL_B);
  launcher.markActive(1);
  launcher.tabClosed(1);
  tick(10_000);
  launcher.tabOpened(3, URL_A); // the same problem in a new tab
  tick(GRACE_MS * 2);
  assert.ok(!types(ports[0]).includes('reset'));
  // And it is the active one now: closing it starts a reset of its own.
  launcher.tabClosed(3);
  tick(GRACE_MS);
  assert.ok(types(ports[0]).includes('reset'));
});

test('closing a tab that is not the active one resets nothing', (t) => {
  const { launcher, ports, types, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  launcher.tabOpened(2, URL_B);
  launcher.markActive(2);
  launcher.tabClosed(1);
  tick(GRACE_MS * 2);
  assert.ok(!types(ports[0]).includes('reset'));
});

test('activity in another tab during the grace cancels the pending reset', (t) => {
  const { launcher, ports, types, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  launcher.tabOpened(2, URL_B);
  launcher.markActive(1);
  launcher.tabClosed(1);
  tick(5000);
  launcher.markActive(2);
  tick(GRACE_MS * 2);
  assert.ok(!types(ports[0]).includes('reset'));
});

test('pings keep the helper informed while connected', (t) => {
  const { launcher, ports, types, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  tick(PING_MS * 3);
  assert.deepEqual(types(ports[0]), ['start', 'ping', 'ping', 'ping']);
  // Message ids are distinct.
  assert.equal(new Set(ports[0].sent.map((m) => m.id)).size, 4);
});

test('a helper that is not installed is not retried until retry()', (t) => {
  const { launcher, ports, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  ports[0].drop('Specified native messaging host not found.');
  assert.equal(launcher.view().state, 'not-installed');
  tick(10 * 60_000);
  launcher.tabOpened(2, URL_B);
  assert.equal(ports.length, 1);
  launcher.retry();
  assert.equal(ports.length, 2);
  assert.equal(launcher.view().state, 'connecting');
});

test('a quiet re-probe of a missing helper never reads as starting', (t) => {
  // The options page asks for the helper every few seconds (setWanted), which
  // looks again for a helper that was just installed. Until the host answers,
  // the state must stay "not-installed": a status read in the instant between
  // the new connection and its failure used to say "connecting" instead.
  const { launcher, ports } = setup(t);
  const seen = [];
  launcher.onChange((view) => seen.push(view.state));
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  ports[0].drop('Specified native messaging host not found.');
  assert.equal(launcher.view().state, 'not-installed');
  seen.length = 0;

  launcher.setWanted(true);
  assert.equal(ports.length, 2, 'it looks again');
  assert.equal(launcher.view().state, 'not-installed');
  ports[1].drop('Specified native messaging host not found.');
  assert.equal(launcher.view().state, 'not-installed');
  assert.ok(!seen.includes('connecting'), `states seen: ${seen.join(', ')}`);

  // The helper gets installed: the next look finds it and it runs.
  launcher.setWanted(true);
  assert.equal(launcher.view().state, 'not-installed');
  ports[2].onMessage.fire({ type: 'status', relay: { state: 'started' } });
  assert.equal(launcher.view().state, 'running');
});

test('Firefox says it differently, and it still reads as not installed', (t) => {
  const { launcher, ports } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  ports[0].drop('No such native application dev.thomsonklee.leetcode_capture');
  assert.equal(launcher.view().state, 'not-installed');
});

test('a helper that drops for another reason is retried with a growing delay', (t) => {
  const { launcher, ports, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  ports[0].drop('Native host has exited.');
  assert.equal(launcher.view().state, 'error');
  assert.match(launcher.view().error, /exited/);
  tick(5000);
  assert.equal(ports.length, 2);
  ports[1].drop('Native host has exited.');
  tick(5000);
  assert.equal(ports.length, 2);
  tick(5000);
  assert.equal(ports.length, 3);
});

test('no retry once every tab is gone', (t) => {
  const { launcher, ports, tick } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  ports[0].drop('Native host has exited.');
  launcher.tabClosed(1);
  tick(10 * 60_000);
  assert.equal(ports.length, 1);
});

test('choosing a runtime in the browser disconnects at once', (t) => {
  const { launcher, ports } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  launcher.setWanted(false);
  assert.equal(ports[0].disconnected, true);
  assert.equal(launcher.view().state, 'idle');
});

test('a connectNative that throws (no permission) is an error, not a crash', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const launcher = createHelperLauncher({
    connectNative: () => {
      throw new Error('connectNative is not available');
    },
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
  });
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  assert.equal(launcher.view().state, 'error');
});

test('listeners hear every change', (t) => {
  const { launcher, ports } = setup(t);
  const seen = [];
  launcher.onChange((v) => seen.push(v.state));
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  ports[0].onMessage.fire({ type: 'status', error: null });
  assert.deepEqual(seen.slice(-2), ['connecting', 'running']);
});

test('the options page alone keeps the helper up, then lets go with the usual grace', (t) => {
  const { launcher, ports, types, tick } = setup(t);
  launcher.setWanted(true);
  assert.equal(ports.length, 0, 'wanted but nothing needs it yet');
  launcher.setHeld(true);
  assert.equal(ports.length, 1, 'the options page connects it with no problem tab');
  assert.deepEqual(types(ports[0]).slice(0, 1), ['start']);
  launcher.setHeld(false);
  tick(GRACE_MS - 1);
  assert.equal(ports[0].disconnected, false);
  tick(2);
  assert.equal(ports[0].disconnected, true, 'stops after the grace once the page lets go');
});

test('a problem tab opening while the options page holds it keeps it past the page', (t) => {
  const { launcher, ports, tick } = setup(t);
  launcher.setWanted(true);
  launcher.setHeld(true);
  launcher.tabOpened(1, URL_A);
  launcher.setHeld(false);
  tick(GRACE_MS * 2);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].disconnected, false);
});

test('a dropped helper is retried for the options page, not only for a tab', (t) => {
  const { launcher, ports, tick } = setup(t);
  launcher.setWanted(true);
  launcher.setHeld(true);
  ports[0].drop('the helper crashed');
  tick(5001);
  assert.equal(ports.length, 2);
});

test('retry asks a connected helper to start again, in case its relay or tutor went away', (t) => {
  const { launcher, ports, types } = setup(t);
  launcher.setWanted(true);
  launcher.tabOpened(1, URL_A);
  assert.deepEqual(types(ports[0]), ['start']);
  launcher.retry();
  assert.deepEqual(types(ports[0]), ['start', 'start']);
});

// ---- finishing the setup after the nativeMessaging grant -------------------
// (shared/native-setup.js: a context running when Allow was clicked has no
// connectNative until it starts again.)

test('the native API decision: reload once after a grant, then stuck, cleared by the API or a revoke', () => {
  assert.deepEqual(nativeApiDecision({ granted: false, hasApi: false, record: undefined }), { state: null, action: 'none' });
  assert.deepEqual(nativeApiDecision({ granted: false, hasApi: false, record: { at: 1 } }), { state: null, action: 'clear' });
  assert.deepEqual(nativeApiDecision({ granted: true, hasApi: true, record: undefined }), { state: 'ready', action: 'none' });
  assert.deepEqual(nativeApiDecision({ granted: true, hasApi: true, record: { at: 1 } }), { state: 'ready', action: 'clear' });
  assert.deepEqual(nativeApiDecision({ granted: true, hasApi: false, record: undefined }), { state: 'pending', action: 'reload' });
  assert.deepEqual(nativeApiDecision({ granted: true, hasApi: false, record: { at: 1 } }), { state: 'stuck', action: 'none' });
});

test('a resume record is used only while fresh and well formed', () => {
  const now = 1_000_000;
  assert.equal(freshResume(null, now), null);
  assert.equal(freshResume({ provider: 'claude' }, now), null);
  assert.equal(freshResume({ at: now - RESUME_MAX_AGE_MS - 1, provider: 'claude' }, now), null);
  assert.equal(freshResume({ at: now + 5, provider: 'claude' }, now), null);
  assert.deepEqual(freshResume({ at: now - 10, provider: 'claude', runtime: 'helper', model: 'opus', reopen: true }, now), {
    at: now - 10,
    provider: 'claude',
    runtime: 'helper',
    model: 'opus',
    reopen: true,
  });
  assert.deepEqual(freshResume({ at: now, provider: '<b>', runtime: 'cloud', model: 5 }, now), { at: now, provider: null, runtime: null, model: null, reopen: false });
});

const mockedTimers = new WeakSet();
function nativeWorld(t, { granted = true, api = false, store = {}, settingsOpen = false, reload = true } = {}) {
  if (!mockedTimers.has(t)) t.mock.timers.enable({ apis: ['setTimeout'] });
  mockedTimers.add(t);
  const world = { granted, api, store: { ...store }, reloads: 0, opened: 0, now: 5_000_000 };
  world.setup = createNativeSetup({
    storage: {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in world.store).map((k) => [k, structuredClone(world.store[k])])),
      set: async (items) => Object.assign(world.store, structuredClone(items)),
      remove: async (key) => delete world.store[key],
    },
    permitted: async () => world.granted,
    hasApi: () => world.api,
    reload: reload ? () => (world.reloads += 1) : null,
    settingsOpen: async () => settingsOpen,
    openSettings: async () => (world.opened += 1),
    timers: { setTimeout },
    now: () => world.now,
  });
  return world;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a stale worker with the permission granted reloads once, after a short delay, carrying the unsaved choice', async (t) => {
  const resume = { at: 5_000_000 - 1000, provider: 'claude', runtime: 'helper', model: 'sonnet' };
  const world = nativeWorld(t, { store: { [SETTINGS_RESUME_KEY]: resume } });
  assert.equal(await world.setup.check(true), 'pending');
  // Checked again by the next poll: still one reload scheduled.
  assert.equal(await world.setup.check(true), 'pending');
  t.mock.timers.tick(RELOAD_DELAY_MS - 1);
  await settle();
  assert.equal(world.reloads, 0);
  t.mock.timers.tick(1);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(world.reloads, 1);
  assert.deepEqual(world.store[NATIVE_RELOAD_KEY], { at: world.now });
  assert.deepEqual(world.store[SETTINGS_RESUME_KEY], { ...resume, reopen: true });
});

test('after the reload the options page opens again once, and the API still missing means stuck, never a second reload', async (t) => {
  const world = nativeWorld(t, { store: { [NATIVE_RELOAD_KEY]: { at: 4_999_000 }, [SETTINGS_RESUME_KEY]: { at: 4_999_000, provider: 'chatgpt', reopen: true } } });
  assert.equal(await world.setup.reopenAfterReload(), true);
  assert.equal(world.opened, 1);
  assert.equal(world.store[SETTINGS_RESUME_KEY].provider, 'chatgpt', 'the page still gets the choice');
  assert.equal(await world.setup.reopenAfterReload(), false, 'a second worker start does not open it again');
  assert.equal(world.opened, 1);
  assert.equal(await world.setup.check(true), 'stuck');
  t.mock.timers.tick(RELOAD_DELAY_MS * 10);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(world.reloads, 0);
  assert.equal(world.setup.state(), 'stuck');
});

test('the API present after the reload clears the guard, so a later grant gets its own reload', async (t) => {
  const world = nativeWorld(t, { api: true, store: { [NATIVE_RELOAD_KEY]: { at: 1 } } });
  assert.equal(await world.setup.check(true), 'ready');
  assert.equal(NATIVE_RELOAD_KEY in world.store, false);
  world.api = false;
  assert.equal(await world.setup.check(false), null, 'not granted is never pending');
  assert.equal(await world.setup.check(true), 'pending');
});

test('no reload when the permission goes or the API comes before the delay ends, nor without a reload API', async (t) => {
  const world = nativeWorld(t);
  assert.equal(await world.setup.check(true), 'pending');
  world.granted = false;
  t.mock.timers.tick(RELOAD_DELAY_MS);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(world.reloads, 0);
  assert.equal(NATIVE_RELOAD_KEY in world.store, false);
  assert.equal(world.setup.state(), null);

  const without = nativeWorld(t, { reload: false });
  assert.equal(await without.setup.check(true), 'stuck');
});

test('a reload with no resume record reopens the options page only when one is open', async (t) => {
  const open = nativeWorld(t, { settingsOpen: true });
  await open.setup.check(true);
  t.mock.timers.tick(RELOAD_DELAY_MS);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(open.reloads, 1);
  assert.equal(open.store[SETTINGS_RESUME_KEY].reopen, true);
  assert.equal(open.store[SETTINGS_RESUME_KEY].provider, undefined);

  const closed = nativeWorld(t, { settingsOpen: false });
  await closed.setup.check(true);
  t.mock.timers.tick(RELOAD_DELAY_MS);
  for (let i = 0; i < 10; i += 1) await settle();
  assert.equal(closed.reloads, 1);
  assert.equal(SETTINGS_RESUME_KEY in closed.store, false);
});
