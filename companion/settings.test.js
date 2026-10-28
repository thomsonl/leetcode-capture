// Tests for settings.js: the file store, validation, env precedence, and the
// guarantee that no API key ever appears in what the options page receives.
//
// Run with: node --test settings.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROVIDERS,
  SettingsError,
  applyPatch,
  emptySettings,
  loadSettings,
  missingRequirement,
  publicView,
  resolveEffective,
  sanitizeStored,
  saveSettings,
  settingsPath,
  statusSummary,
} from './settings.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-settings-test-'));
  return path.join(dir, 'nested', 'settings.json');
}

test('settingsPath honors the override, then XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(settingsPath({ LEETCODE_CAPTURE_SETTINGS: '/x/s.json' }), '/x/s.json');
  assert.equal(settingsPath({ XDG_CONFIG_HOME: '/xdg' }), path.join('/xdg', 'leetcode-capture', 'settings.json'));
  assert.equal(settingsPath({}), path.join(os.homedir(), '.config', 'leetcode-capture', 'settings.json'));
});

test('a missing file is a normal first run; a corrupt file is reported and ignored', () => {
  const file = tmpFile();
  assert.deepEqual(loadSettings(file), { settings: emptySettings(), warning: null });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const { settings, warning } = loadSettings(file);
  assert.deepEqual(settings, emptySettings());
  assert.match(warning, /not valid JSON/);
});

test('saving writes the file 0600 in a 0700 directory and round-trips', { skip: process.platform === 'win32' }, () => {
  const file = tmpFile();
  const stored = applyPatch(emptySettings(), { provider: 'openai', providers: { openai: { apiKey: 'sk-test-123', model: 'gpt-4.1' } } });
  saveSettings(stored, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(loadSettings(file).settings, stored);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1, 'no temp file is left behind');
});

test('bad stored values fall back to defaults instead of poisoning the config', () => {
  const clean = sanitizeStored({
    provider: 'nonsense',
    providers: { local: { baseUrl: 'ftp://x', contextTokens: 'big', model: 'llama3.2' }, evil: { model: 'x' } },
    options: { autoClearContext: 'yes', localMaxHistoryTurns: -4 },
    extra: true,
  });
  assert.equal(clean.provider, null);
  assert.equal(clean.providers.local.baseUrl, 'http://localhost:11434/v1');
  assert.equal(clean.providers.local.contextTokens, 8192);
  assert.equal(clean.providers.local.model, 'llama3.2');
  assert.equal(clean.options.autoClearContext, true);
  assert.equal(clean.options.localMaxHistoryTurns, 6);
  assert.equal(clean.evil, undefined);
});

test('applyPatch validates every field and leaves the original untouched on error', () => {
  const base = emptySettings();
  const snapshot = JSON.stringify(base);
  const bad = [
    [{ provider: 'gemini' }, /unknown provider/],
    [{ providers: { local: { baseUrl: 'javascript:alert(1)' } } }, /http:\/\/ or https:\/\//],
    [{ providers: { local: { baseUrl: 'not a url' } } }, /full URL/],
    [{ providers: { local: { contextTokens: 12 } } }, /between 1024/],
    [{ providers: { anthropic: { apiKey: 'sk ant' } } }, /spaces/],
    [{ providers: { anthropic: { apiKey: 'sk-\u001b[31m' } } }, /control characters/],
    [{ providers: { local: { model: 'x'.repeat(201) } } }, /too long/],
    [{ options: { autoClearContext: 'no' } }, /on or off/],
    [{ options: { localMaxHistoryTurns: 1000 } }, /between 0 and 100/],
    [{ providers: { bogus: {} } }, /unknown provider/],
  ];
  for (const [patch, pattern] of bad) {
    assert.throws(() => applyPatch(base, patch), (err) => err instanceof SettingsError && pattern.test(err.message), JSON.stringify(patch));
  }
  assert.equal(JSON.stringify(base), snapshot);
});

test('an absent apiKey keeps the saved one, null removes it, a string replaces it', () => {
  let s = applyPatch(emptySettings(), { providers: { anthropic: { apiKey: 'sk-one' } } });
  s = applyPatch(s, { providers: { anthropic: { model: 'claude-sonnet-5-5' } } });
  assert.equal(s.providers.anthropic.apiKey, 'sk-one');
  s = applyPatch(s, { providers: { anthropic: { apiKey: 'sk-two' } } });
  assert.equal(s.providers.anthropic.apiKey, 'sk-two');
  s = applyPatch(s, { providers: { anthropic: { apiKey: null } } });
  assert.equal(s.providers.anthropic.apiKey, null);
});

test('switching provider keeps every other provider\'s saved fields', () => {
  let s = applyPatch(emptySettings(), { provider: 'local', providers: { local: { model: 'gpt-oss:20b' }, openai: { apiKey: 'sk-o', model: 'gpt-4.1' } } });
  s = applyPatch(s, { provider: 'openai' });
  assert.equal(s.providers.local.model, 'gpt-oss:20b');
  assert.equal(s.providers.openai.apiKey, 'sk-o');
});

test('defaults: with nothing saved and no env, the provider is claude (the app\'s historic default)', () => {
  const eff = resolveEffective(emptySettings(), {});
  assert.equal(eff.provider, 'claude');
  assert.deepEqual(eff.locks, {});
  assert.equal(eff.options.autoClearContext, true);
  assert.equal(eff.options.vaultAutoSummary, false);
});

test('environment variables beat the saved file and are reported as locks', () => {
  const stored = applyPatch(emptySettings(), { provider: 'claude', providers: { local: { model: 'saved-model' } }, options: { autoClearContext: true } });
  const eff = resolveEffective(stored, {
    COMPANION_BACKEND: 'local',
    COMPANION_MODEL: 'env-model',
    COMPANION_BASE_URL: 'http://127.0.0.1:1234/v1',
    COMPANION_LOCAL_NUM_CTX: '16000',
    COMPANION_AUTO_CLEAR_CONTEXT: '0',
    VAULT_AUTO_SUMMARY: '1',
    COMPANION_LOCAL_MAX_HISTORY_TURNS: '3',
  });
  assert.equal(eff.provider, 'local');
  assert.equal(eff.model, 'env-model');
  assert.equal(eff.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(eff.contextTokens, 16000);
  assert.equal(eff.options.autoClearContext, false);
  assert.equal(eff.options.vaultAutoSummary, true);
  assert.equal(eff.options.localMaxHistoryTurns, 3);
  assert.deepEqual(Object.keys(eff.locks).sort(), ['autoClearContext', 'baseUrl', 'contextTokens', 'localMaxHistoryTurns', 'model', 'provider', 'vaultAutoSummary']);
  assert.equal(eff.locks.model, 'COMPANION_MODEL');
});

test('an unknown COMPANION_BACKEND is an error, as before', () => {
  assert.throws(() => resolveEffective(emptySettings(), { COMPANION_BACKEND: 'gemini' }), /unknown COMPANION_BACKEND "gemini"/);
});

test('API keys fall back to the standard provider variables, saved keys win, and the source is reported', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-env', OPENAI_API_KEY: 'sk-oai-env' };
  const a = resolveEffective(applyPatch(emptySettings(), { provider: 'anthropic' }), env);
  assert.deepEqual([a.apiKey, a.keySource], ['sk-ant-env', 'ANTHROPIC_API_KEY']);
  const o = resolveEffective(applyPatch(emptySettings(), { provider: 'openai' }), env);
  assert.deepEqual([o.apiKey, o.keySource], ['sk-oai-env', 'OPENAI_API_KEY']);
  const saved = resolveEffective(applyPatch(emptySettings(), { provider: 'anthropic', providers: { anthropic: { apiKey: 'sk-saved' } } }), env);
  assert.deepEqual([saved.apiKey, saved.keySource], ['sk-saved', 'saved']);
  const generic = resolveEffective(applyPatch(emptySettings(), { provider: 'anthropic' }), { COMPANION_API_KEY: 'sk-generic', ANTHROPIC_API_KEY: 'sk-ant-env' });
  assert.deepEqual([generic.apiKey, generic.keySource], ['sk-generic', 'COMPANION_API_KEY']);
});

test('the subscription providers never pick up an API key, so they cannot silently bill one', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-env', OPENAI_API_KEY: 'sk-oai-env', COMPANION_API_KEY: 'k' };
  for (const provider of ['claude', 'chatgpt']) {
    const eff = resolveEffective(applyPatch(emptySettings(), { provider }), env);
    assert.equal(eff.apiKey, null, provider);
  }
});

test('the OpenAI provider assumes a large hosted context window; local uses the configured one', () => {
  assert.equal(resolveEffective(applyPatch(emptySettings(), { provider: 'openai' }), {}).contextTokens, 128000);
  assert.equal(resolveEffective(applyPatch(emptySettings(), { provider: 'local' }), {}).contextTokens, 8192);
});

test('missingRequirement names what is needed before a backend can be built', () => {
  const need = (provider, env = {}) => missingRequirement(resolveEffective(applyPatch(emptySettings(), { provider }), env));
  assert.match(need('local'), /model name/);
  assert.match(need('anthropic'), /API key/);
  assert.match(need('openai'), /API key/);
  assert.equal(need('claude'), null);
  assert.equal(need('chatgpt'), null);
  assert.equal(need('anthropic', { ANTHROPIC_API_KEY: 'k' }), null);
});

test('publicView never contains a key, but says whether one exists and where it came from', () => {
  const secret = 'sk-SECRET-VALUE-do-not-leak';
  const envSecret = 'sk-ENV-SECRET-do-not-leak';
  const stored = applyPatch(emptySettings(), {
    provider: 'openai',
    providers: { openai: { apiKey: secret, model: 'gpt-4.1' }, local: { apiKey: secret, model: 'm' }, anthropic: {} },
  });
  const view = publicView(stored, { ANTHROPIC_API_KEY: envSecret, COMPANION_API_KEY: envSecret }, '/tmp/s.json');
  const text = JSON.stringify(view);
  assert.ok(!text.includes(secret), 'saved key leaked');
  assert.ok(!text.includes(envSecret), 'env key leaked');
  assert.equal(view.providers.openai.hasKey, true);
  assert.equal(view.providers.openai.keySource, 'saved');
  assert.equal(view.providers.anthropic.hasKey, false);
  assert.equal(view.providers.claude.hasKey, undefined);
  assert.equal(view.settingsPath, '/tmp/s.json');
  assert.deepEqual(Object.keys(view.catalog), Object.keys(PROVIDERS));
});

test('statusSummary is non-secret and names the provider', () => {
  const eff = resolveEffective(applyPatch(emptySettings(), { provider: 'local', providers: { local: { model: 'gpt-oss:20b', apiKey: 'k' } } }), {});
  assert.deepEqual(statusSummary(eff), { provider: 'local', label: 'Local model', model: 'gpt-oss:20b' });
});
