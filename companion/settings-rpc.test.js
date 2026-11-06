// Tests for settings-rpc.js: what the options page can ask the companion to do.
//
// Run with: node --test settings-rpc.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSettingsRpc } from './settings-rpc.js';
import { emptySettings, loadSettings } from './settings.js';

function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-rpc-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const state = { stored: emptySettings(), applied: [], built: [] };
  const deps = {
    file,
    env: {},
    getStored: () => state.stored,
    setStored: (next) => {
      state.stored = next;
    },
    buildBackend: async (effective) => {
      state.built.push(effective);
      return { sendMessage: async () => 'OK' };
    },
    apply: async (effective, backend) => {
      state.applied.push({ effective, backend });
    },
    ...overrides,
  };
  return { rpc: createSettingsRpc(deps), state, file, deps };
}

test('get returns the public view and the active provider, never a key', async (t) => {
  const { rpc, state } = harness(t);
  await rpc.handle('save', { patch: { provider: 'openai', providers: { openai: { apiKey: 'sk-SECRET-123456', model: 'gpt-4.1' } } } });
  const res = await rpc.handle('get', {});
  assert.equal(res.ok, true);
  assert.equal(res.result.active.provider, 'openai');
  assert.equal(res.result.settings.providers.openai.hasKey, true);
  assert.ok(!JSON.stringify(res).includes('sk-SECRET-123456'));
  assert.equal(state.stored.providers.openai.apiKey, 'sk-SECRET-123456', 'the key is kept in memory for the backend');
});

test('save validates, builds a backend, persists the file, then applies it', async (t) => {
  const { rpc, state, file } = harness(t);
  const res = await rpc.handle('save', { patch: { provider: 'local', providers: { local: { model: 'gpt-oss:20b' } }, options: { vaultAutoSummary: false } } });
  assert.equal(res.ok, true);
  assert.equal(res.result.saved, true);
  assert.equal(state.built.length, 1);
  assert.equal(state.applied.length, 1);
  assert.equal(state.applied[0].effective.provider, 'local');
  assert.equal(state.applied[0].effective.model, 'gpt-oss:20b');
  assert.equal(loadSettings(file).settings.providers.local.model, 'gpt-oss:20b');
});

test('a save that is invalid or incomplete is refused and changes nothing', async (t) => {
  const { rpc, state, file } = harness(t);
  const cases = [
    [{ provider: 'local' }, /model name/],
    [{ provider: 'anthropic' }, /API key/],
    [{ provider: 'openai', providers: { openai: { apiKey: 'sk-abcdef' } } }, /model name/],
    [{ provider: 'local', providers: { local: { model: 'm', baseUrl: 'ftp://nope' } } }, /http:\/\/ or https:\/\//],
    [{ provider: 'cohere' }, /unknown provider/],
  ];
  for (const [patch, pattern] of cases) {
    const res = await rpc.handle('save', { patch });
    assert.equal(res.ok, false, JSON.stringify(patch));
    assert.match(res.error.message, pattern);
  }
  assert.equal(fs.existsSync(file), false, 'nothing was written');
  assert.equal(state.applied.length, 0);
  assert.deepEqual(state.stored, emptySettings());
});

test('if the backend cannot be built the working configuration is kept', async (t) => {
  const { rpc, state, file } = harness(t, {
    buildBackend: async () => {
      throw new Error('could not reach sk-LEAKYKEY-999 at the server');
    },
  });
  const res = await rpc.handle('save', { patch: { provider: 'anthropic', providers: { anthropic: { apiKey: 'sk-LEAKYKEY-999' } } } });
  assert.equal(res.ok, false);
  assert.ok(!res.error.message.includes('sk-LEAKYKEY-999'), 'a key echoed in an error is scrubbed');
  assert.equal(fs.existsSync(file), false);
  assert.equal(state.applied.length, 0);
});

test('turning the vault summary on is refused when the vault path is unusable', async (t) => {
  const { rpc, file } = harness(t, {
    validateVault: () => {
      throw new Error('vault path /nope does not exist');
    },
  });
  const res = await rpc.handle('save', { patch: { provider: 'claude', options: { vaultAutoSummary: true } } });
  assert.equal(res.ok, false);
  assert.equal(res.error.field, 'vaultAutoSummary');
  assert.match(res.error.message, /does not exist/);
  assert.equal(fs.existsSync(file), false);
});

test('test tries an unsaved draft through a throwaway backend and persists nothing', async (t) => {
  const { rpc, state, file } = harness(t);
  const res = await rpc.handle('test', { patch: { provider: 'local', providers: { local: { model: 'draft-model' } } } });
  assert.equal(res.ok, true);
  assert.equal(res.result.ok, true);
  assert.equal(res.result.reply, 'OK');
  assert.equal(state.built[0].model, 'draft-model');
  assert.equal(state.applied.length, 0);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(state.stored, emptySettings());
});

test('test reports problems as a result, scrubs keys, and reports an incomplete draft without building anything', async (t) => {
  const { rpc, state } = harness(t, {
    buildBackend: async (effective) => {
      if (effective.provider === 'openai') throw new Error('401 for key sk-TESTKEY-ABCDEF');
      return { sendMessage: async () => '   ' };
    },
  });
  const incomplete = (await rpc.handle('test', { patch: { provider: 'anthropic' } })).result;
  assert.deepEqual([incomplete.ok, /API key/.test(incomplete.message)], [false, true]);
  const failing = (await rpc.handle('test', { patch: { provider: 'openai', providers: { openai: { apiKey: 'sk-TESTKEY-ABCDEF', model: 'm' } } } })).result;
  assert.equal(failing.ok, false);
  assert.ok(!failing.message.includes('sk-TESTKEY-ABCDEF'));
  const empty = (await rpc.handle('test', { patch: { provider: 'claude' } })).result;
  assert.deepEqual([empty.ok, empty.message], [false, 'The model answered with nothing.']);
  assert.equal(state.applied.length, 0);
});

test('test checks the ChatGPT sign-in first and explains how to fix it', async (t) => {
  const { rpc } = harness(t, { codexCommand: { command: '/nonexistent/codex-binary' } });
  const res = (await rpc.handle('test', { patch: { provider: 'chatgpt' } })).result;
  assert.equal(res.ok, false);
  assert.match(res.message, /ChatGPT sign-in.*not found.*codex login/s);
});

test('a missing sign-in is one plain instruction, marked signIn, and the companion hears each outcome', async (t) => {
  const outcomes = [];
  let signedIn = false;
  const { rpc } = harness(t, {
    buildBackend: async () => ({
      sendMessage: async () => {
        if (!signedIn) throw Object.assign(new Error('Claude Code is not signed in.'), { code: 'signin', provider: 'claude' });
        return 'OK';
      },
    }),
    onTestResult: (provider, outcome) => outcomes.push([provider, outcome]),
    getAttention: () => (outcomes.length && outcomes.at(-1)[1] === 'signin' ? 'signin' : null),
  });
  const res = (await rpc.handle('test', { patch: { provider: 'claude' } })).result;
  assert.deepEqual(res, { ok: false, signIn: true, message: 'Claude Code is not signed in. In a terminal, run claude and type /login, then press Test connection again.' });
  assert.equal((await rpc.handle('get', {})).result.attention, 'signin');
  signedIn = true;
  const ok = (await rpc.handle('test', { patch: { provider: 'claude' } })).result;
  assert.equal(ok.ok, true);
  assert.equal('provider' in ok, false, 'only the companion hears the provider');
  assert.equal((await rpc.handle('get', {})).result.attention, null);
  assert.deepEqual(outcomes, [['claude', 'signin'], ['claude', 'ok']]);
});

test('ChatGPT with codex signed out is the same plain instruction', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-rpc-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'codex.cjs');
  fs.writeFileSync(script, "console.log('Not logged in'); process.exit(1);\n");
  const { rpc } = harness(t, { codexCommand: { command: process.execPath, commandArgs: [script] } });
  const res = (await rpc.handle('test', { patch: { provider: 'chatgpt' } })).result;
  assert.deepEqual(res, {
    ok: false,
    signIn: true,
    message: 'The Codex CLI is not signed in to ChatGPT. In a terminal, run codex login and choose ChatGPT, then press Test connection again.',
  });
});

function startModelServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: 'gpt-oss:20b' }, { name: 'llama3.2:latest' }] }));
    else if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1' }, { id: 'o4-mini' }] }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('models lists Ollama tags for a local server and the OpenAI-style list otherwise, sending the key', async (t) => {
  const { server, seen, base } = await startModelServer();
  t.after(() => server.close());
  const { rpc } = harness(t);
  const local = (await rpc.handle('models', { provider: 'local', baseUrl: base })).result;
  assert.deepEqual(local.models, ['gpt-oss:20b', 'llama3.2:latest']);
  const openai = (await rpc.handle('models', { provider: 'openai', baseUrl: base, apiKey: 'sk-listing-key' })).result;
  assert.deepEqual(openai.models, ['gpt-4.1', 'o4-mini'], 'sorted and de-duplicated');
  assert.equal(seen.at(-1).auth, 'Bearer sk-listing-key');
});

test('models degrades to an empty list with a message when the server is unreachable', async (t) => {
  const { rpc } = harness(t);
  const res = (await rpc.handle('models', { provider: 'local', baseUrl: 'http://127.0.0.1:1/v1' })).result;
  assert.deepEqual(res.models, []);
  assert.ok(res.message);
});

test('an unknown method and bad params never throw', async (t) => {
  const { rpc } = harness(t);
  assert.equal((await rpc.handle('rm', {})).ok, false);
  assert.equal((await rpc.handle('constructor', {})).ok, false);
  assert.equal((await rpc.handle('save', null)).ok, false);
  assert.equal((await rpc.handle('get', 'junk')).ok, true);
});

test('switchProfile: only a saved id, only the active profile changes, and it waits for the swap', async (t) => {
  const { rpc, state, file } = harness(t);
  await rpc.handle('save', {
    patch: {
      provider: 'local',
      providers: { local: { model: 'gpt-oss:20b', baseUrl: 'http://127.0.0.1:1/v1' } },
      profiles: [
        { id: 'gpt', provider: 'local', model: 'gpt-oss:20b' },
        { id: 'gemma', provider: 'local', model: 'gemma4:26b', label: 'Gemma' },
        { id: 'haiku', provider: 'claude', model: 'claude-haiku-5-5' },
      ],
      activeProfile: 'gpt',
    },
  });
  const unknown = await rpc.handle('switchProfile', { id: 'nope' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'unknown');
  const sneaky = await rpc.handle('switchProfile', { id: 'gemma', baseUrl: 'http://evil', patch: { providers: { local: { baseUrl: 'http://evil' } } } });
  assert.equal(sneaky.ok, true);
  assert.deepEqual(sneaky.result, { active: { provider: 'local', label: 'Local model', model: 'gemma4:26b', profile: 'gemma' }, profile: 'gemma' });
  const saved = loadSettings(file).settings;
  assert.equal(saved.activeProfile, 'gemma');
  assert.equal(saved.providers.local.model, 'gemma4:26b');
  assert.equal(saved.providers.local.baseUrl, 'http://127.0.0.1:1/v1', 'the URL is untouched');
  assert.equal(state.applied.length, 2);
  // Switching to the active one again builds nothing.
  await rpc.handle('switchProfile', { id: 'gemma' });
  assert.equal(state.applied.length, 2);
  const toClaude = await rpc.handle('switchProfile', { id: 'haiku' });
  assert.equal(toClaude.result.active.provider, 'claude');
});

test('switchProfile waits for the queued swap; a locked provider or model is refused; setProfiles keeps the backend', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { rpc, state } = harness(t, {
    apply: async (effective) => {
      await gate;
      state.applied.push({ effective });
    },
  });
  await rpc.handle('setProfiles', { profiles: [{ id: 'a', provider: 'local', model: 'm1' }, { id: 'b', provider: 'local', model: 'm2' }] });
  assert.equal(state.applied.length, 0, 'setProfiles applies nothing');
  let done = false;
  const pending = rpc.handle('switchProfile', { id: 'b' }).then((r) => {
    done = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, 'the answer waits for the swap');
  release();
  assert.equal((await pending).ok, true);

  const locked = harness(t, { env: { COMPANION_MODEL: 'pinned' } });
  await locked.rpc.handle('setProfiles', { profiles: [{ id: 'a', provider: 'local', model: 'm1' }] });
  const refused = await locked.rpc.handle('switchProfile', { id: 'a' });
  assert.equal(refused.error.code, 'locked');
  assert.match(refused.error.message, /COMPANION_MODEL/);
  const bad = await locked.rpc.handle('setProfiles', { profiles: [{ id: 'x', provider: 'nope' }] });
  assert.equal(bad.ok, false);
});
