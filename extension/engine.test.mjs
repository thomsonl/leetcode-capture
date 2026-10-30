// The extension runtime's tutor (tutor-service.js, which wires
// tutor-engine.js and event-hub.js) driven the way the background worker
// drives it: runtime messages for captures and settings, and a panel port
// for events and messages. The backend is a recording stub, storage and
// permissions are in-memory fakes, so nothing real is read or reached.
//
// Run with: node --test engine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTutorService, SECRETS_KEY, SETTINGS_KEY } from './shared/tutor-service.js';
import { NEW_PROBLEM_NOTICE } from './shared/tutor-engine.js';
import { buildBackend } from './shared/extension-settings.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OPTIONS_PAGE = { url: `${ORIGIN}/settings.html` };
const CONTENT_SCRIPT = { url: 'https://leetcode.com/problems/two-sum/', tab: { id: 1 } };

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
  };
}

// A backend that records every call and answers "reply N", streamed in two
// chunks.
function recordingBackends() {
  const built = [];
  function make(settings) {
    const backend = {
      model: settings.providers[settings.provider].model,
      calls: [],
      resets: 0,
      async sendMessage(text, options) {
        backend.calls.push({ text, options });
        const reply = `reply ${backend.calls.length}`;
        if (options.onChunk) {
          options.onChunk('reply ');
          options.onChunk(String(backend.calls.length));
        }
        return reply;
      },
      resetContext() {
        backend.resets += 1;
      },
      takeWarnings: () => [],
    };
    built.push(backend);
    return backend;
  }
  return {
    built,
    impl(settings, secrets, opts) {
      // Validates like the real one, then hands back the stub.
      buildBackend(settings, secrets, { probe: async () => null, ...(opts || {}) });
      return make(settings);
    },
  };
}

function fakePort() {
  const listeners = { message: [], disconnect: [] };
  const received = [];
  return {
    received,
    postMessage: (m) => received.push(structuredClone(m)),
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    send: (m) => listeners.message.forEach((fn) => fn(m)),
    disconnect: () => listeners.disconnect.forEach((fn) => fn()),
    events: () => received.filter((m) => m.type === 'event').map((m) => m.event),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(service) {
  for (let i = 0; i < 5; i++) {
    await service.engine.idle();
    await tick();
  }
}

const LOCAL = { provider: 'local', runtime: 'extension', providers: { local: { model: 'model-a', baseUrl: 'http://localhost:11434/v1' } } };

async function setup({ stored = {}, granted = true } = {}) {
  const backends = recordingBackends();
  const storage = memoryStorage(stored);
  const service = createTutorService({
    storage,
    permissions: { contains: async () => granted },
    extensionOrigin: ORIGIN,
    buildBackendImpl: backends.impl,
  });
  await service.ready;
  return { service, storage, backends };
}

const code1 = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
const code2 = code1.replace('line 5', 'line five');
const capture = (trigger, code, slug = 'two-sum') => ({
  type: 'lc-tutor:capture',
  capture: { trigger, code, problemSlug: slug, problemTitle: slug, problemDescription: `About ${slug}.`, language: 'python3' },
});

test('only the options page can read or change settings, and a key never comes back', async () => {
  const { service, storage } = await setup();
  const refused = await service.handleMessage({ type: 'lc-tutor:settings-get' }, CONTENT_SCRIPT);
  assert.deepEqual(refused, { ok: false, error: { message: 'not allowed' } });
  const saveRefused = await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: LOCAL } }, CONTENT_SCRIPT);
  assert.equal(saveRefused.ok, false);
  assert.deepEqual(storage.data, {}, 'nothing was written');

  const patch = { provider: 'anthropic', providers: { anthropic: { apiKey: 'sk-ant-very-secret-key' } } };
  const saved = await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch } }, OPTIONS_PAGE);
  assert.equal(saved.ok, true);
  assert.equal(saved.result.settings.providers.anthropic.hasKey, true);
  assert.equal(JSON.stringify(saved).includes('very-secret'), false, 'the answer carries no key');
  assert.equal(storage.data[SECRETS_KEY].anthropic, 'sk-ant-very-secret-key');
  assert.equal(JSON.stringify(storage.data[SETTINGS_KEY]).includes('very-secret'), false, 'the settings record carries no key');
  const got = await service.handleMessage({ type: 'lc-tutor:settings-get' }, OPTIONS_PAGE);
  assert.equal(JSON.stringify(got).includes('very-secret'), false);
});

test('a panel port gets the runtime, a replay, config and status, and a message streams a reply', async () => {
  const { service } = await setup();
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: LOCAL } }, OPTIONS_PAGE);
  const port = fakePort();
  service.connectPort(port);
  port.send({ type: 'subscribe', after: 0 });
  await settle(service);
  assert.deepEqual(port.received[0], { type: 'runtime', runtime: 'extension', chosen: true });
  const config = port.events().find((e) => e.type === 'config');
  assert.deepEqual([config.provider, config.label, config.model], ['local', 'Local model', 'model-a']);
  const status = port.events().find((e) => e.type === 'status');
  assert.equal(status.companionOnline, true);

  port.send({ type: 'message', id: 7, text: 'hello tutor', problemSlug: 'two-sum', snapshot: { code: code1, language: 'python3', problemTitle: 'Two Sum' } });
  await settle(service);
  assert.deepEqual(port.received.find((m) => m.type === 'reply'), { type: 'reply', id: 7, ok: true });
  const kinds = port.events().filter((e) => typeof e.seq === 'number').map((e) => e.type);
  assert.deepEqual(kinds, ['user', 'turn-start', 'chunk', 'chunk', 'turn-end']);
  const end = port.events().find((e) => e.type === 'turn-end');
  assert.equal(end.text, 'reply 1');
  assert.equal(end.problemSlug, 'two-sum');
  // "Processing" while the turn ran, then idle.
  await new Promise((r) => setTimeout(r, 150));
  const busy = port.events().filter((e) => e.type === 'status').map((e) => e.busy);
  assert.deepEqual(busy, [false, true, false]);

  port.send({ type: 'message', id: 8, text: 'x'.repeat(8001), problemSlug: 'two-sum' });
  await settle(service);
  assert.deepEqual(port.received.filter((m) => m.type === 'reply').at(-1), { type: 'reply', id: 8, ok: false, error: 'too-long' });
});

test('the code rules: Runs are never sent, a Submit only when changed, messages carry diffs against held code', async () => {
  const { service, backends } = await setup();
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: LOCAL } }, OPTIONS_PAGE);
  const backend = backends.built.at(-1);

  assert.deepEqual(await service.handleMessage(capture('run', code1), CONTENT_SCRIPT), { handled: true });
  await settle(service);
  assert.equal(backend.calls.length, 0, 'a Run is only recorded');
  const chips = () => service.hub.events().filter((e) => e.type === 'capture');
  assert.equal(chips().length, 0, 'a Run shows no chip');

  await service.handleMessage(capture('submit', code1), CONTENT_SCRIPT);
  await settle(service);
  assert.equal(backend.calls.length, 1);
  assert.match(backend.calls[0].text, /\[LeetCode capture\] Submit - two-sum \(two-sum\)/);
  assert.match(backend.calls[0].text, /line 29/, 'the first Submit carries the full code');
  assert.match(backend.calls[0].text, /This was a Submit/);
  assert.equal(backend.calls[0].options.problemContext.description, 'About two-sum.');
  assert.deepEqual(
    chips().map((e) => [e.trigger, e.attemptSeq]),
    [['submit', 2]],
    'a Submit sent to the tutor keeps its chip, numbered after the Run'
  );
  const events = service.hub.events();
  assert.ok(
    events.indexOf(chips()[0]) < events.findIndex((e) => e.type === 'turn-start'),
    'the chip comes before the reply'
  );

  await service.handleMessage(capture('submit', code1), CONTENT_SCRIPT);
  await settle(service);
  assert.equal(backend.calls.length, 1, 'an unchanged Submit is not sent');
  assert.equal(chips().length, 1, 'an unchanged Submit shows no chip');

  const port = fakePort();
  service.connectPort(port);
  port.send({ type: 'message', id: 1, text: 'is this right?', problemSlug: 'two-sum', snapshot: { code: code2 } });
  await settle(service);
  assert.equal(backend.calls.length, 2);
  const sent = backend.calls[1];
  assert.match(sent.text, /line five/);
  assert.doesNotMatch(sent.text, /line 29/, 'a message carries a diff, not the whole code');
  assert.equal(sent.options.currentCode.code, code2, 'the request pins the current full code, with the diff applied');

  port.send({ type: 'message', id: 2, text: 'and now?', problemSlug: 'two-sum', snapshot: { code: code2 } });
  await settle(service);
  assert.doesNotMatch(backend.calls[2].text, /line five/, 'no change means no code at all');

  port.send({ type: 'message', id: 3, text: 'no editor', problemSlug: 'two-sum' });
  await settle(service);
  assert.match(backend.calls[3].text, /editor could not be read/);
});

test('activity on another problem resets the tutor, drops the old chat, and the first message carries the full code', async () => {
  const { service, backends } = await setup();
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: LOCAL } }, OPTIONS_PAGE);
  const backend = backends.built.at(-1);
  await service.handleMessage(capture('submit', code1, 'two-sum'), CONTENT_SCRIPT);
  await settle(service);
  assert.equal(service.hub.events().filter((e) => e.problemSlug === 'two-sum').length > 0, true);

  // A Run on another problem is enough to switch.
  await service.handleMessage(capture('run', code2, 'add-two-numbers'), CONTENT_SCRIPT);
  await settle(service);
  assert.equal(backend.resets, 1);
  assert.equal(service.hub.events().filter((e) => e.problemSlug === 'two-sum').length, 0, "the old problem's chat is dropped");
  const notice = service.hub.events().find((e) => e.type === 'notice');
  assert.deepEqual([notice.problemSlug, notice.text], ['add-two-numbers', NEW_PROBLEM_NOTICE]);
  assert.equal(service.engine.activeProblemId, 'add-two-numbers');

  const port = fakePort();
  service.connectPort(port);
  port.send({ type: 'message', id: 1, text: 'help', problemSlug: 'add-two-numbers', snapshot: { code: code2 } });
  await settle(service);
  const sent = backend.calls.at(-1);
  assert.match(sent.text, /line 29/, 'the tutor holds nothing after a reset, so the full code goes');
  assert.equal(sent.options.currentCode.code, code2, 'and pins it');

  // A message from the old problem's tab switches back and says so.
  port.send({ type: 'message', id: 2, text: 'back', problemSlug: 'two-sum', snapshot: { code: code1 } });
  await settle(service);
  assert.equal(backend.resets, 2);
  assert.match(backend.calls.at(-1).text, /now working on the LeetCode problem "two-sum"/);
});

test('a problem-switch notice appears before the panel message that triggered it', async () => {
  const { service } = await setup();
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: LOCAL } }, OPTIONS_PAGE);
  await service.handleMessage(capture('run', code1, 'two-sum'), CONTENT_SCRIPT);
  await settle(service);
  const port = fakePort();
  service.connectPort(port);
  port.send({ type: 'message', id: 1, text: 'new question', problemSlug: 'add-two-numbers', snapshot: { code: code2 } });
  await settle(service);
  const events = service.hub.events().filter((event) => event.problemSlug === 'add-two-numbers');
  const notice = events.findIndex((event) => event.type === 'notice');
  const user = events.findIndex((event) => event.type === 'user');
  assert.ok(notice >= 0 && user >= 0 && notice < user, JSON.stringify(events.map((event) => event.type)));
});

test('saving a different model swaps the backend and the next message carries the full code again', async () => {
  const { service, backends } = await setup();
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: LOCAL } }, OPTIONS_PAGE);
  const port = fakePort();
  service.connectPort(port);
  port.send({ type: 'subscribe', after: 0 });
  port.send({ type: 'message', id: 1, text: 'one', problemSlug: 'two-sum', snapshot: { code: code1 } });
  await settle(service);
  // Only an option changes: the same backend is kept.
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: { options: { autoClearContext: true } } } }, OPTIONS_PAGE);
  assert.equal(backends.built.length, 1);
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: { providers: { local: { model: 'model-b' } } } } }, OPTIONS_PAGE);
  assert.equal(backends.built.length, 2);
  port.send({ type: 'message', id: 2, text: 'two', problemSlug: 'two-sum', snapshot: { code: code1 } });
  await settle(service);
  const fresh = backends.built[1];
  assert.equal(fresh.calls.length, 1);
  assert.match(fresh.calls[0].text, /line 29/);
  const config = port.events().filter((e) => e.type === 'config').at(-1);
  assert.equal(config.model, 'model-b');
});

test('a reconnect replays only what it missed, and a worker restart (new epoch) replays everything', async () => {
  const { service } = await setup();
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: LOCAL } }, OPTIONS_PAGE);
  const port = fakePort();
  service.connectPort(port);
  port.send({ type: 'message', id: 1, text: 'one', problemSlug: 'two-sum', snapshot: { code: code1 } });
  await settle(service);
  const stored = service.hub.events();
  const lastSeq = stored.at(-1).seq;
  port.send({ type: 'message', id: 2, text: 'two', problemSlug: 'two-sum', snapshot: { code: code1 } });
  await settle(service);
  const again = fakePort();
  service.connectPort(again);
  again.send({ type: 'subscribe', after: lastSeq, epoch: service.hub.epoch });
  await settle(service);
  const replayed = again.events().filter((e) => typeof e.seq === 'number');
  assert.ok(replayed.every((e) => e.seq > lastSeq));
  assert.equal(replayed[0].type, 'user');
  const other = fakePort();
  service.connectPort(other);
  other.send({ type: 'subscribe', after: lastSeq, epoch: 'another-run' });
  await settle(service);
  assert.equal(other.events().filter((e) => typeof e.seq === 'number')[0].seq, 1);
});

test('the helper runtime leaves captures to the relay, and missing setup or permission is explained', async () => {
  const { service } = await setup();
  assert.deepEqual(await service.handleMessage(capture('submit', code1), CONTENT_SCRIPT), { handled: false });
  await service.handleMessage({ type: 'lc-tutor:settings-save', params: { patch: { provider: 'claude' } } }, OPTIONS_PAGE);
  assert.deepEqual(await service.handleMessage({ type: 'lc-tutor:runtime' }, CONTENT_SCRIPT), { runtime: 'helper' });
  assert.deepEqual(await service.handleMessage(capture('submit', code1), CONTENT_SCRIPT), { handled: false });

  const denied = await setup({ granted: false, stored: { [SETTINGS_KEY]: { provider: 'local', providers: { local: { model: 'm' } } } } });
  const port = fakePort();
  denied.service.connectPort(port);
  port.send({ type: 'subscribe', after: 0 });
  port.send({ type: 'message', id: 1, text: 'hi', problemSlug: 'two-sum' });
  await settle(denied.service);
  const end = port.events().find((e) => e.type === 'turn-end');
  assert.match(end.error, /isn't allowed to reach http:\/\/localhost:11434\/v1/);
  const tested = await denied.service.handleMessage({ type: 'lc-tutor:settings-test', params: { patch: {} } }, OPTIONS_PAGE);
  assert.equal(tested.result.ok, false);
  assert.match(tested.result.message, /isn't allowed/);
});
