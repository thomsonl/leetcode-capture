// companion/settings.js - the companion's persisted settings.
//
// One place decides which LLM the tutor talks to and how, so the browser
// extension's options page, the terminal, and the existing environment
// variables all agree. Pure and dependency-free so it can be unit-tested
// without booting companion.js.
//
// Precedence, per field: environment variable > saved settings file > default.
// An environment variable that is set locks its field in the options page
// (the page is told which variable), so a launcher script that exports
// COMPANION_MODEL keeps working exactly as it always has.
//
// Secrets: API keys live only in the settings file (mode 0600 inside a 0700
// directory) and in this process's memory. publicView() is the only thing the
// options page ever receives and it carries `hasKey`, never the key itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SETTINGS_VERSION = 1;
export const DEFAULT_PROVIDER = 'claude';

// The provider catalog (labels, fields, requirements, which runtimes can run
// each one) is shared with the extension: extension/shared/providers.js.
export { PROVIDERS, OLLAMA_BASE_URL, OPENAI_BASE_URL } from '../extension/shared/providers.js';
import { PROVIDERS, OLLAMA_BASE_URL, OPENAI_BASE_URL } from '../extension/shared/providers.js';

const DEFAULT_FIELDS = {
  local: { baseUrl: OLLAMA_BASE_URL, model: null, contextTokens: 8192, apiKey: null },
  claude: { model: null },
  anthropic: { apiKey: null, model: null },
  openai: { apiKey: null, model: null, baseUrl: OPENAI_BASE_URL },
  chatgpt: { model: null },
};

export const DEFAULT_OPTIONS = { autoClearContext: true, vaultAutoSummary: false, localMaxHistoryTurns: 6 };

// Context window assumed for hosted OpenAI-compatible APIs (the pre-flight
// size check in LocalBackend needs a number; 128k is the floor for current
// hosted models).
export const OPENAI_CONTEXT_TOKENS = 128000;

export class SettingsError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'SettingsError';
    this.field = field || null;
  }
}

export function settingsPath(env = process.env) {
  if (env.LEETCODE_CAPTURE_SETTINGS) return env.LEETCODE_CAPTURE_SETTINGS;
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === 'win32' && env.APPDATA ? env.APPDATA : path.join(os.homedir(), '.config'));
  return path.join(base, 'leetcode-capture', 'settings.json');
}

export function emptySettings() {
  const providers = {};
  for (const id of Object.keys(PROVIDERS)) providers[id] = { ...DEFAULT_FIELDS[id] };
  return { version: SETTINGS_VERSION, provider: null, providers, options: { ...DEFAULT_OPTIONS } };
}

// ---- validation ------------------------------------------------------------

function cleanString(value, max, field, { allowEmpty = true } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new SettingsError(`${field} must be text`, field);
  const trimmed = value.trim();
  if (!trimmed) {
    if (allowEmpty) return null;
    throw new SettingsError(`${field} can't be empty`, field);
  }
  if (trimmed.length > max) throw new SettingsError(`${field} is too long`, field);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new SettingsError(`${field} contains control characters`, field);
  return trimmed;
}

function cleanUrl(value, field) {
  const text = cleanString(value, 500, field);
  if (text === null) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new SettingsError(`${field} must be a full URL like http://localhost:11434/v1`, field);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SettingsError(`${field} must start with http:// or https://`, field);
  }
  return text.replace(/\/+$/, '');
}

function cleanApiKey(value) {
  const text = cleanString(value, 400, 'apiKey');
  if (text !== null && /\s/.test(text)) throw new SettingsError('apiKey must not contain spaces', 'apiKey');
  return text;
}

function cleanInt(value, min, max, field) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new SettingsError(`${field} must be a whole number between ${min} and ${max}`, field);
  }
  return n;
}

const FIELD_CLEANERS = {
  model: (v) => cleanString(v, 200, 'model'),
  baseUrl: (v) => cleanUrl(v, 'baseUrl'),
  contextTokens: (v) => cleanInt(v, 1024, 2_000_000, 'contextTokens'),
  apiKey: cleanApiKey,
};

function cleanBool(value, field) {
  if (typeof value !== 'boolean') throw new SettingsError(`${field} must be on or off`, field);
  return value;
}

// ---- file store --------------------------------------------------------------

// Reads the settings file. A missing file is the normal first-run state; a
// corrupt one is reported (and treated as empty) rather than crashing.
export function loadSettings(file = settingsPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: emptySettings(), warning: null };
    return { settings: emptySettings(), warning: `could not read ${file}: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { settings: emptySettings(), warning: `${file} is not valid JSON (${err.message}); ignoring it` };
  }
  return { settings: sanitizeStored(parsed), warning: null };
}

// Keeps only known, valid values; anything else falls back to the default.
export function sanitizeStored(input) {
  const out = emptySettings();
  if (!input || typeof input !== 'object') return out;
  if (typeof input.provider === 'string' && PROVIDERS[input.provider]) out.provider = input.provider;
  for (const id of Object.keys(PROVIDERS)) {
    const src = input.providers && input.providers[id];
    if (!src || typeof src !== 'object') continue;
    for (const field of Object.keys(DEFAULT_FIELDS[id])) {
      if (!(field in src)) continue;
      try {
        const value = FIELD_CLEANERS[field](src[field]);
        out.providers[id][field] = value === null ? DEFAULT_FIELDS[id][field] : value;
      } catch {
        // invalid stored value: keep the default
      }
    }
  }
  const opts = input.options;
  if (opts && typeof opts === 'object') {
    if (typeof opts.autoClearContext === 'boolean') out.options.autoClearContext = opts.autoClearContext;
    if (typeof opts.vaultAutoSummary === 'boolean') out.options.vaultAutoSummary = opts.vaultAutoSummary;
    try {
      const turns = cleanInt(opts.localMaxHistoryTurns, 0, 100, 'localMaxHistoryTurns');
      if (turns !== null) out.options.localMaxHistoryTurns = turns;
    } catch {
      // keep default
    }
  }
  return out;
}

// Atomic write: a crash mid-write must never leave a half-written file that
// then contains (or drops) a key. Directory 0700, file 0600.
export function saveSettings(settings, file = settingsPath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without modes
  }
}

// ---- applying a change from the options page ------------------------------------

// patch = { provider?, providers?: { [id]: { model?, baseUrl?, contextTokens?, apiKey? } }, options? }
// apiKey: a string sets it, null removes it, undefined (absent) keeps what is saved.
// Returns a new stored object; throws SettingsError and changes nothing on a bad value.
export function applyPatch(stored, patch) {
  const next = JSON.parse(JSON.stringify(stored));
  if (!patch || typeof patch !== 'object') throw new SettingsError('nothing to save');
  if (patch.provider !== undefined) {
    if (typeof patch.provider !== 'string' || !PROVIDERS[patch.provider]) {
      throw new SettingsError('unknown provider', 'provider');
    }
    next.provider = patch.provider;
  }
  if (patch.providers !== undefined) {
    if (!patch.providers || typeof patch.providers !== 'object') throw new SettingsError('providers must be an object');
    for (const [id, fields] of Object.entries(patch.providers)) {
      if (!PROVIDERS[id]) throw new SettingsError(`unknown provider ${id}`, 'provider');
      if (!fields || typeof fields !== 'object') throw new SettingsError(`${id} settings must be an object`);
      for (const [field, value] of Object.entries(fields)) {
        if (!(field in DEFAULT_FIELDS[id])) continue; // not a field of this provider
        if (value === undefined) continue;
        const cleaned = FIELD_CLEANERS[field](value);
        next.providers[id][field] = cleaned === null ? DEFAULT_FIELDS[id][field] : cleaned;
      }
    }
  }
  if (patch.options !== undefined) {
    if (!patch.options || typeof patch.options !== 'object') throw new SettingsError('options must be an object');
    const o = patch.options;
    if (o.autoClearContext !== undefined) next.options.autoClearContext = cleanBool(o.autoClearContext, 'autoClearContext');
    if (o.vaultAutoSummary !== undefined) next.options.vaultAutoSummary = cleanBool(o.vaultAutoSummary, 'vaultAutoSummary');
    if (o.localMaxHistoryTurns !== undefined) {
      const turns = cleanInt(o.localMaxHistoryTurns, 0, 100, 'localMaxHistoryTurns');
      next.options.localMaxHistoryTurns = turns === null ? DEFAULT_OPTIONS.localMaxHistoryTurns : turns;
    }
  }
  return next;
}

// ---- effective settings (env > file > default) ---------------------------------

const TRUE_RE = /^(1|true|yes)$/i;
const FALSE_RE = /^(0|false|no)$/i;

// What the companion actually runs with, plus which environment variable (if
// any) pinned each field. `apiKey` is in the result because the backend needs
// it, so this object must never be sent to the options page - use publicView.
export function resolveEffective(stored, env = process.env) {
  const locks = {};
  let provider = stored.provider || DEFAULT_PROVIDER;
  if (env.COMPANION_BACKEND) {
    if (!PROVIDERS[env.COMPANION_BACKEND]) {
      throw new SettingsError(
        `unknown COMPANION_BACKEND "${env.COMPANION_BACKEND}" (expected one of ${Object.keys(PROVIDERS).join(', ')})`,
        'provider'
      );
    }
    provider = env.COMPANION_BACKEND;
    locks.provider = 'COMPANION_BACKEND';
  }
  const fields = { ...stored.providers[provider] };
  const has = (field) => field in DEFAULT_FIELDS[provider];

  if (env.COMPANION_MODEL && has('model')) {
    fields.model = env.COMPANION_MODEL;
    locks.model = 'COMPANION_MODEL';
  }
  if (env.COMPANION_BASE_URL && has('baseUrl')) {
    fields.baseUrl = env.COMPANION_BASE_URL;
    locks.baseUrl = 'COMPANION_BASE_URL';
  }
  if (env.COMPANION_LOCAL_NUM_CTX && has('contextTokens')) {
    fields.contextTokens = Number(env.COMPANION_LOCAL_NUM_CTX);
    locks.contextTokens = 'COMPANION_LOCAL_NUM_CTX';
  }
  let keySource = fields.apiKey ? 'saved' : null;
  if (has('apiKey') && !fields.apiKey) {
    const fallback = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }[provider];
    if (env.COMPANION_API_KEY) {
      fields.apiKey = env.COMPANION_API_KEY;
      keySource = 'COMPANION_API_KEY';
    } else if (fallback && env[fallback]) {
      fields.apiKey = env[fallback];
      keySource = fallback;
    }
  } else if (has('apiKey') && env.COMPANION_API_KEY) {
    fields.apiKey = env.COMPANION_API_KEY;
    keySource = 'COMPANION_API_KEY';
  }

  const options = { ...stored.options };
  if (env.VAULT_AUTO_SUMMARY !== undefined && env.VAULT_AUTO_SUMMARY !== '') {
    options.vaultAutoSummary = TRUE_RE.test(env.VAULT_AUTO_SUMMARY);
    locks.vaultAutoSummary = 'VAULT_AUTO_SUMMARY';
  }
  if (env.COMPANION_AUTO_CLEAR_CONTEXT !== undefined && env.COMPANION_AUTO_CLEAR_CONTEXT !== '') {
    options.autoClearContext = !FALSE_RE.test(env.COMPANION_AUTO_CLEAR_CONTEXT);
    locks.autoClearContext = 'COMPANION_AUTO_CLEAR_CONTEXT';
  }
  if (env.COMPANION_LOCAL_MAX_HISTORY_TURNS) {
    options.localMaxHistoryTurns = Number(env.COMPANION_LOCAL_MAX_HISTORY_TURNS);
    locks.localMaxHistoryTurns = 'COMPANION_LOCAL_MAX_HISTORY_TURNS';
  }

  let contextTokens = fields.contextTokens || null;
  if (provider === 'openai') contextTokens = OPENAI_CONTEXT_TOKENS;
  return {
    provider,
    model: fields.model || null,
    baseUrl: fields.baseUrl || null,
    apiKey: fields.apiKey || null,
    keySource,
    contextTokens,
    options,
    locks,
  };
}

// Returns the human-readable problem with an effective config, or null if a
// backend can be built from it.
export function missingRequirement(effective) {
  const spec = PROVIDERS[effective.provider];
  for (const field of spec.requires) {
    if (!effective[field]) {
      const what = { model: 'a model name', apiKey: 'an API key' }[field] || field;
      return `${spec.label} needs ${what}`;
    }
  }
  return null;
}

// ---- backend environments ------------------------------------------------------

// Environment variables that make Claude Code bill an API key (or another
// token) instead of the sign-in the subscription provider was picked for.
const ANTHROPIC_KEY_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

// The environment the Claude backend's Claude Code process runs with (the
// Agent SDK's `env` option). Without an apiKey (the "Claude subscription"
// provider) every key variable is removed, so a stray ANTHROPIC_API_KEY can
// never silently bill instead of the subscription; with one (the "Anthropic
// API key" provider) exactly that key is set.
export function claudeBackendEnv(apiKey, env = process.env) {
  const out = { ...env };
  for (const name of ANTHROPIC_KEY_ENV) delete out[name];
  if (apiKey) out.ANTHROPIC_API_KEY = apiKey;
  return out;
}

// ---- what other parties may see -----------------------------------------------

// Non-secret summary of what is running; published to the in-page panel.
export function statusSummary(effective) {
  return {
    provider: effective.provider,
    label: PROVIDERS[effective.provider].label,
    model: effective.model || null,
  };
}

// The options page's view. Keys are replaced by { hasKey, keySource }.
export function publicView(stored, env = process.env, file = settingsPath(env)) {
  const effective = resolveEffective(stored, env);
  const providers = {};
  for (const id of Object.keys(PROVIDERS)) {
    const saved = stored.providers[id];
    const view = {};
    for (const field of Object.keys(DEFAULT_FIELDS[id])) {
      if (field !== 'apiKey') view[field] = saved[field];
    }
    if ('apiKey' in DEFAULT_FIELDS[id]) {
      const eff = id === effective.provider ? effective : resolveEffective({ ...stored, provider: id }, {});
      view.hasKey = Boolean(saved.apiKey) || (id === effective.provider && Boolean(effective.apiKey));
      view.keySource = saved.apiKey ? 'saved' : id === effective.provider ? effective.keySource : eff.keySource;
    }
    providers[id] = view;
  }
  return {
    provider: effective.provider,
    savedProvider: stored.provider,
    providers,
    options: effective.options,
    locks: effective.locks,
    catalog: Object.fromEntries(
      Object.entries(PROVIDERS).map(([id, p]) => [id, { label: p.label, hint: p.hint, fields: p.fields, requires: p.requires }])
    ),
    defaults: { ...DEFAULT_FIELDS, options: DEFAULT_OPTIONS },
    settingsPath: file,
  };
}
