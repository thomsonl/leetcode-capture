// extension/shared/extension-settings.js - the extension runtime's own
// settings: which provider the tutor uses and where it runs, the fields of
// the providers that can run inside the extension, and how a backend is built
// from them. The background worker keeps them in chrome.storage.local (see
// background.js); the companion's settings (companion/settings.js) are only
// used for the helper runtime.
//
// Two stored records, so a key can never ride along with anything else:
//   settings: { version, provider, runtimes, providers, options, profiles,
//               activeProfile }, no secrets
//   secrets:  { local, anthropic, openai }, the API keys
// publicView() is all the options page is ever given: `hasKey`, never a key.
//
// `profiles` are the saved models the Tutor panel's switcher lists (see
// profiles.js); `activeProfile` is the one in use. `provider` and the active
// provider's `model` always match the active profile, so everything that
// reads them (runtimeFor, buildBackend, statusSummary) needs no change. A
// record from before profiles becomes one profile (migrateProfiles).
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

import { PROVIDERS, OLLAMA_BASE_URL, OPENAI_BASE_URL, defaultRuntime } from './providers.js';
import { LocalBackend } from './local-backend.js';
import { AnthropicBackend, ANTHROPIC_BASE_URL, DEFAULT_ANTHROPIC_MODEL } from './anthropic-backend.js';
import { ProfileError, cleanActiveProfile, cleanProfiles, findProfile, migrateProfiles, profileName } from './profiles.js';

export const EXTENSION_SETTINGS_VERSION = 2;
// The providers the extension can run itself.
export const EXTENSION_PROVIDERS = Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].runtimes.includes('extension'));
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 8192;
// Same assumption as the companion (companion/settings.js): 128k is the
// floor for current hosted OpenAI models.
export const OPENAI_CONTEXT_TOKENS = 128000;
export const DEFAULT_OPTIONS = { autoClearContext: true, localMaxHistoryTurns: 6 };
// What the context-window field is called in errors the tutor shows.
export const WINDOW_SETTING = 'the "Context window (tokens)" setting';

const DEFAULT_FIELDS = {
  local: { baseUrl: OLLAMA_BASE_URL, model: null, contextTokens: DEFAULT_LOCAL_CONTEXT_TOKENS },
  anthropic: { model: null },
  openai: { model: null, baseUrl: OPENAI_BASE_URL },
};

export class SettingsError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'SettingsError';
    this.field = field || null;
  }
}

export function emptySettings() {
  const providers = {};
  const runtimes = {};
  for (const id of EXTENSION_PROVIDERS) {
    providers[id] = { ...DEFAULT_FIELDS[id] };
    runtimes[id] = defaultRuntime(id);
  }
  return {
    version: EXTENSION_SETTINGS_VERSION,
    provider: null,
    runtimes,
    providers,
    options: { ...DEFAULT_OPTIONS },
    profiles: [],
    activeProfile: null,
  };
}

export function emptySecrets() {
  const secrets = {};
  for (const id of EXTENSION_PROVIDERS) secrets[id] = null;
  return secrets;
}

// ---- validation ------------------------------------------------------------

function cleanString(value, max, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new SettingsError(`${field} must be text`, field);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new SettingsError(`${field} is too long`, field);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new SettingsError(`${field} contains control characters`, field);
  return trimmed;
}

export function cleanUrl(value, field = 'baseUrl') {
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
  if (url.username || url.password) throw new SettingsError(`${field} must not contain a user name or password`, field);
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

// Stored values from an older or hand-edited record are taken field by field;
// anything invalid falls back to the default rather than breaking the page.
export function normalizeSettings(raw) {
  const out = emptySettings();
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.provider === 'string' && PROVIDERS[raw.provider]) out.provider = raw.provider;
  for (const id of EXTENSION_PROVIDERS) {
    const runtime = raw.runtimes && raw.runtimes[id];
    if (PROVIDERS[id].runtimes.includes(runtime)) out.runtimes[id] = runtime;
    const fields = (raw.providers && raw.providers[id]) || {};
    for (const field of Object.keys(DEFAULT_FIELDS[id])) {
      try {
        const value = applyField(field, fields[field]);
        if (value !== undefined && value !== null) out.providers[id][field] = value;
      } catch {
        // keep the default
      }
    }
  }
  const options = raw.options || {};
  if (typeof options.autoClearContext === 'boolean') out.options.autoClearContext = options.autoClearContext;
  try {
    const turns = cleanInt(options.localMaxHistoryTurns, 0, 100, 'localMaxHistoryTurns');
    if (turns !== null) out.options.localMaxHistoryTurns = turns;
  } catch {
    // keep the default
  }
  const providerModel = out.provider && out.providers[out.provider] ? out.providers[out.provider].model : null;
  const migrated = migrateProfiles({
    profiles: cleanProfiles(raw.profiles, PROVIDERS),
    activeProfile: raw.activeProfile,
    provider: out.provider,
    model: providerModel,
  });
  out.profiles = migrated.profiles;
  out.activeProfile = migrated.activeProfile;
  syncActive(out);
  return out;
}

// Makes `provider` and that provider's model match the active profile.
function syncActive(settings) {
  const profile = findProfile(settings.profiles, settings.activeProfile);
  if (!profile) return;
  settings.provider = profile.provider;
  if (settings.providers[profile.provider]) settings.providers[profile.provider].model = profile.model;
}

// An id for a profile the store makes itself, unused in `profiles`.
function freeProfileId(profiles, base) {
  const stem = base.replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'model';
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? stem : `${stem}-${n}`;
    if (!findProfile(profiles, id)) return id;
  }
}

// A patch from before profiles (a provider and its fields, no profile list):
// the active profile follows it, as it would have been migrated.
function followLegacyPatch(next) {
  if (!next.provider) {
    next.activeProfile = null;
    return;
  }
  const model = next.providers[next.provider] ? next.providers[next.provider].model : null;
  const active = findProfile(next.profiles, next.activeProfile);
  if (active && active.provider === next.provider) {
    if (next.providers[next.provider]) active.model = model;
    return;
  }
  const same = next.profiles.find((p) => p.provider === next.provider && (!next.providers[next.provider] || p.model === model));
  if (same) {
    next.activeProfile = same.id;
    return;
  }
  const profile = { id: freeProfileId(next.profiles, next.profiles.length ? next.provider : 'default'), provider: next.provider, model, label: null };
  next.profiles.push(profile);
  next.activeProfile = profile.id;
}

export function normalizeSecrets(raw) {
  const out = emptySecrets();
  if (!raw || typeof raw !== 'object') return out;
  for (const id of EXTENSION_PROVIDERS) {
    try {
      out[id] = cleanApiKey(raw[id]);
    } catch {
      out[id] = null;
    }
  }
  return out;
}

function applyField(field, value) {
  if (field === 'baseUrl') return cleanUrl(value);
  if (field === 'model') return cleanString(value, 200, 'model');
  if (field === 'contextTokens') return cleanInt(value, 1024, 2_000_000, 'contextTokens');
  return undefined;
}

// Applies an options-page patch:
//   { provider?, runtime?, providers?: { id: { field: value, apiKey?: string|null } }, options? }
// `runtime` applies to the chosen provider. A provider field set to null goes
// back to its default; an apiKey of null removes the key, a missing one keeps
// it. Returns new { settings, secrets }; throws SettingsError naming the field.
export function applyPatch(settings, secrets, patch) {
  const next = normalizeSettings(settings);
  const nextSecrets = { ...normalizeSecrets(secrets) };
  if (!patch || typeof patch !== 'object') return { settings: next, secrets: nextSecrets };
  if (patch.provider !== undefined) {
    if (patch.provider !== null && !PROVIDERS[patch.provider]) throw new SettingsError('unknown provider', 'provider');
    next.provider = patch.provider;
  }
  if (patch.runtime !== undefined) {
    const id = next.provider;
    if (!id || !PROVIDERS[id].runtimes.includes(patch.runtime)) {
      throw new SettingsError(`${id ? PROVIDERS[id].label : 'This provider'} cannot run there`, 'runtime');
    }
    if (next.runtimes[id] !== undefined) next.runtimes[id] = patch.runtime;
  }
  for (const [id, fields] of Object.entries(patch.providers || {})) {
    if (!EXTENSION_PROVIDERS.includes(id) || !fields || typeof fields !== 'object') continue;
    for (const [field, value] of Object.entries(fields)) {
      if (field === 'apiKey') {
        if (value === undefined) continue;
        nextSecrets[id] = value === null ? null : cleanApiKey(value);
        continue;
      }
      if (!(field in DEFAULT_FIELDS[id])) continue;
      const cleaned = applyField(field, value);
      next.providers[id][field] = cleaned === null ? DEFAULT_FIELDS[id][field] : cleaned;
    }
  }
  if (patch.profiles !== undefined) {
    try {
      next.profiles = cleanProfiles(patch.profiles, PROVIDERS, { strict: true });
    } catch (err) {
      throw new SettingsError(err instanceof ProfileError ? err.message : 'profiles are not valid', 'profiles');
    }
    next.activeProfile = cleanActiveProfile(next.profiles, next.activeProfile);
  }
  if (patch.activeProfile !== undefined) {
    if (patch.activeProfile === null) next.activeProfile = null;
    else if (!findProfile(next.profiles, patch.activeProfile)) throw new SettingsError('That model is not in the saved list.', 'activeProfile');
    else next.activeProfile = patch.activeProfile;
  }
  if (patch.profiles === undefined && patch.activeProfile === undefined && (patch.provider !== undefined || patch.providers !== undefined)) {
    followLegacyPatch(next);
  }
  syncActive(next);
  const options = patch.options || {};
  if (options.autoClearContext !== undefined) {
    if (typeof options.autoClearContext !== 'boolean') throw new SettingsError('autoClearContext must be on or off', 'autoClearContext');
    next.options.autoClearContext = options.autoClearContext;
  }
  if (options.localMaxHistoryTurns !== undefined) {
    const turns = cleanInt(options.localMaxHistoryTurns, 0, 100, 'localMaxHistoryTurns');
    next.options.localMaxHistoryTurns = turns === null ? DEFAULT_OPTIONS.localMaxHistoryTurns : turns;
  }
  return { settings: next, secrets: nextSecrets };
}

// ---- what runs where -------------------------------------------------------

// 'extension' or 'helper'. Nothing chosen yet means the helper, which is how
// the extension behaved before it could run the tutor itself, so an existing
// companion setup keeps working untouched.
export function runtimeFor(settings) {
  const id = settings && settings.provider;
  if (!id || !PROVIDERS[id]) return 'helper';
  const runtime = settings.runtimes && settings.runtimes[id];
  return PROVIDERS[id].runtimes.includes(runtime) ? runtime : defaultRuntime(id);
}

// What is missing before the extension can run the chosen provider, as a
// sentence for the options page and the panel, or null.
export function missingRequirement(settings, secrets) {
  const id = settings.provider;
  if (!id) return 'Choose a provider in the extension options.';
  const fields = settings.providers[id] || {};
  for (const need of PROVIDERS[id].requires) {
    if (need === 'apiKey' ? !secrets[id] : !fields[need]) {
      return `${PROVIDERS[id].label} needs ${need === 'apiKey' ? 'an API key' : `a ${need === 'model' ? 'model name' : need}`}.`;
    }
  }
  return null;
}

// The server the chosen provider talks to.
export function serverUrlFor(settings) {
  const id = settings.provider;
  if (id === 'anthropic') return ANTHROPIC_BASE_URL;
  if (id === 'local' || id === 'openai') return settings.providers[id].baseUrl || DEFAULT_FIELDS[id].baseUrl;
  return null;
}

// The host permission (an optional_host_permissions match pattern) the
// extension needs before it may reach that server.
export function originPatternFor(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

// The non-secret summary for the panel header ({ provider, label, model }).
export function statusSummary(settings) {
  const id = settings.provider;
  if (!id) return null;
  const fields = settings.providers[id] || {};
  const model = fields.model || (id === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : null);
  return { provider: id, label: PROVIDERS[id].label, model };
}

// What a backend is built from; unchanged means the running one is kept.
export function backendKey(settings, secrets) {
  const id = settings.provider;
  const fields = settings.providers[id] || {};
  return JSON.stringify([id, fields.model, fields.baseUrl, fields.contextTokens, secrets[id] || null, settings.options.localMaxHistoryTurns]);
}

// Builds the backend for the chosen provider. Throws SettingsError when it
// cannot be built from these settings.
export function buildBackend(settings, secrets, { probe } = {}) {
  const id = settings.provider;
  const problem = missingRequirement(settings, secrets);
  if (problem) throw new SettingsError(problem, 'provider');
  const fields = settings.providers[id];
  const maxHistoryTurns = settings.options.localMaxHistoryTurns;
  if (id === 'anthropic') {
    return new AnthropicBackend({ apiKey: secrets.anthropic, model: fields.model, maxHistoryTurns });
  }
  if (id === 'local' || id === 'openai') {
    return new LocalBackend({
      baseUrl: fields.baseUrl || DEFAULT_FIELDS[id].baseUrl,
      model: fields.model,
      apiKey: secrets[id],
      maxHistoryTurns,
      // A hosted OpenAI API always speaks the OpenAI shape; a local server
      // is probed (Ollama gets its native API, which honors num_ctx).
      apiStyle: id === 'openai' ? 'openai' : null,
      numCtx: id === 'openai' ? OPENAI_CONTEXT_TOKENS : fields.contextTokens || DEFAULT_LOCAL_CONTEXT_TOKENS,
      windowSetting: WINDOW_SETTING,
      ...(probe ? { probe } : {}),
    });
  }
  throw new SettingsError(`${PROVIDERS[id].label} needs the helper app`, 'runtime');
}

export function publicView(settings, secrets) {
  const s = normalizeSettings(settings);
  const keys = normalizeSecrets(secrets);
  const providers = {};
  for (const id of EXTENSION_PROVIDERS) providers[id] = { ...s.providers[id], hasKey: Boolean(keys[id]) };
  return {
    provider: s.provider,
    runtime: runtimeFor(s),
    runtimes: { ...s.runtimes },
    providers,
    options: { ...s.options },
    profiles: s.profiles.map((p) => ({ ...p })),
    activeProfile: s.activeProfile,
    defaults: { local: { ...DEFAULT_FIELDS.local }, openai: { ...DEFAULT_FIELDS.openai }, anthropic: { model: DEFAULT_ANTHROPIC_MODEL } },
  };
}

// ---- profiles for the panel's switcher -------------------------------------

// The settings with `profile` made the active one (nothing is saved).
export function withProfile(settings, profile) {
  const next = normalizeSettings(settings);
  next.activeProfile = profile.id;
  if (!findProfile(next.profiles, profile.id)) next.profiles.push({ ...profile });
  syncActive(next);
  return next;
}

// Why a profile that runs in the browser cannot be used yet, as a short
// line for the switcher, or null.
export function profileProblem(settings, secrets) {
  const id = settings.provider;
  const fields = settings.providers[id] || {};
  for (const need of PROVIDERS[id].requires) {
    if (need === 'apiKey' && !secrets[id]) return 'No API key saved';
    if (need === 'model' && !fields.model) return 'No model chosen';
  }
  return null;
}

// One switcher entry, without availability (the service adds it).
export function profileEntry(settings, profile) {
  const spec = PROVIDERS[profile.provider];
  const model = profile.model || (profile.provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : null);
  return {
    id: profile.id,
    name: profileName({ ...profile, model }, PROVIDERS),
    provider: profile.provider,
    providerLabel: spec.label,
    model,
    runtime: runtimeFor(withProfile(settings, profile)),
  };
}

// ---- plain error messages -------------------------------------------------

// Turns a failed request to the chosen provider into a message that says what
// to do. Ollama refuses requests from an extension's origin unless
// OLLAMA_ORIGINS allows it (it answers 403, or the browser reports a network
// error), which is the most likely first-run failure for a local model.
export function explainError(message, { provider, serverUrl, extensionOrigin }) {
  const text = String(message || '');
  if (provider !== 'local') return text;
  const forbidden = /\b403\b/.test(text);
  const unreachable = /could not reach|Failed to fetch|NetworkError|network error|fetch failed/i.test(text);
  if (!forbidden && !unreachable) return text;
  const origin = extensionOrigin || 'chrome-extension://<this extension id>';
  const fix =
    `If it is Ollama, it only answers browser extensions it is told to trust: set the environment variable ` +
    `OLLAMA_ORIGINS=${origin} for the Ollama server (for example with "systemctl edit ollama.service" on Linux, ` +
    `or "launchctl setenv OLLAMA_ORIGINS ${origin}" on macOS) and restart Ollama.`;
  if (forbidden) return `The local server at ${serverUrl} refused the request (403). ${fix}`;
  return `Couldn't reach the local server at ${serverUrl}. Check that it is running. ${fix}`;
}
