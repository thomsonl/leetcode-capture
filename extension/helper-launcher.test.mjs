// The background worker's helper launcher: tab counting, the 30 second grace
// before stopping, the reset after the active tab closes, pings, retries and
// the not-installed state. Fake timers and a fake native port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelperLauncher, GRACE_MS, HELPER_HOST_NAME, PING_MS, problemSlugFromUrl } from './shared/helper-launcher.js';

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
