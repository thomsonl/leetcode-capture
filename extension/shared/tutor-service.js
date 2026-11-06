// extension/shared/tutor-service.js - everything the background worker does
// for the extension runtime, with the browser APIs passed in so it runs (and
// is tested) under Node too. background.js only binds chrome.* to it.
//
//   - Keeps the extension's settings and API keys in storage (two records,
//     see extension-settings.js) and builds the backend from them.
//   - Runs the tutor (tutor-engine.js) and its event hub (event-hub.js).
//   - Speaks the panel's port protocol (extension/panel.js, "extension"
//     transport). Panel to worker:
//       { type: 'subscribe', after, epoch }   replay, then follow live
//       { type: 'message', id, text, problemSlug, snapshot }
//       { type: 'switch-profile', reqId, id } the model switcher picked a profile
//       { type: 'profile-switched', id }      the helper's companion switched to it
//       { type: 'ping' }                      keeps the worker awake
//     Worker to panel:
//       { type: 'runtime', runtime, chosen }  on connect and on every change
//       { type: 'profiles', profiles, active } the switcher's entries (no secrets)
//       { type: 'event', event }              one hub event
//       { type: 'reply', id, ok, error? }     answer to a message
//       { type: 'switch-result', reqId, ok, runtime?, message? }
//   - Answers runtime messages: a capture from content.js
//     ('lc-tutor:capture'), and the options page's settings calls
//     ('lc-tutor:settings-get|save|test|models'), which only the extension's
//     own pages may make. No answer to a content script ever carries a key.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

import { PROVIDERS } from './providers.js';
import { createEventHub } from './event-hub.js';
import { createTutorEngine } from './tutor-engine.js';
import { CONNECTION_TEST_PROMPT } from './tutor-prompt.js';
import { listAnthropicModels } from './anthropic-backend.js';
import { findProfile } from './profiles.js';
import {
  SettingsError,
  applyPatch,
  backendKey,
  buildBackend,
  explainError,
  missingRequirement,
  normalizeSecrets,
  normalizeSettings,
  originPatternFor,
  profileEntry,
  profileProblem,
  publicView,
  runtimeFor,
  serverUrlFor,
  statusSummary,
  withProfile,
} from './extension-settings.js';

export const SETTINGS_KEY = 'tutorSettings';
export const SECRETS_KEY = 'tutorSecrets';
export const TEST_TIMEOUT_MS = 90_000;
export const MODELS_TIMEOUT_MS = 6000;
const MAX_MODELS = 200;

// Replaces every occurrence of a secret in a message with ***.
function scrub(message, secrets) {
  let out = String(message);
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('***');
  }
  return out;
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// storage: { get(keys) -> Promise<object>, set(object) -> Promise }
// permissions: { contains({ origins }) -> Promise<boolean> }
// extensionOrigin: 'chrome-extension://<id>' (or moz-extension://<uuid>)
// onRuntime(runtime, chosen): called once the settings are read and after
// every save, with 'extension' or 'helper' and whether a provider is saved at
// all (the background's helper launcher follows both).
// helperProblem(currentRuntime): why a profile that runs through the helper
// cannot be switched to right now, as a short line, or null (async allowed).
export function createTutorService({
  storage,
  permissions,
  extensionOrigin,
  log = () => {},
  buildBackendImpl = buildBackend,
  onRuntime = () => {},
  helperProblem = async () => null,
}) {
  const hub = createEventHub();
  const engine = createTutorEngine({ hub, log });
  const ports = new Set();
  let settings = normalizeSettings(null);
  let secrets = normalizeSecrets(null);
  let configuredKey = null;

  const ready = (async () => {
    try {
      const stored = await storage.get([SETTINGS_KEY, SECRETS_KEY]);
      settings = normalizeSettings(stored && stored[SETTINGS_KEY]);
      secrets = normalizeSecrets(stored && stored[SECRETS_KEY]);
    } catch (err) {
      log(`could not read settings: ${err.message}`);
    }
    await applyToEngine();
    onRuntime(runtimeFor(settings), Boolean(settings.provider));
  })();

  async function permissionFor(current) {
    const pattern = originPatternFor(serverUrlFor(current));
    if (!pattern) return { pattern: null, granted: true };
    try {
      return { pattern, granted: Boolean(await permissions.contains({ origins: [pattern] })) };
    } catch {
      return { pattern, granted: false };
    }
  }

  function permissionMessage(current) {
    return (
      `The extension isn't allowed to reach ${serverUrlFor(current)} yet. ` +
      'Open the extension options and press Save (or Test connection) to allow it.'
    );
  }

  // Hands the engine the backend for the current settings, or the reason
  // there is none. A configuration whose backend key is unchanged keeps the
  // running conversation.
  async function applyToEngine() {
    const config = statusSummary(settings);
    const label = config ? config.label : 'tutor';
    const options = { autoClearContext: settings.options.autoClearContext };
    if (runtimeFor(settings) !== 'extension') {
      configuredKey = null;
      await engine.configure({ backend: null, label, options, config, error: 'The tutor runs through the helper app for this provider.' });
      return;
    }
    const problem = missingRequirement(settings, secrets);
    if (problem) {
      configuredKey = null;
      await engine.configure({ backend: null, label, options, config, error: `${problem} Open the extension options to finish setting it up.` });
      return;
    }
    const permission = await permissionFor(settings);
    if (!permission.granted) {
      configuredKey = null;
      await engine.configure({ backend: null, label, options, config, error: permissionMessage(settings) });
      return;
    }
    const key = backendKey(settings, secrets);
    const explain = makeExplainer(settings, secrets);
    if (key === configuredKey) {
      await engine.configure({ keep: true, key, label, options, config, explainError: explain });
      return;
    }
    let backend;
    try {
      backend = buildBackendImpl(settings, secrets);
    } catch (err) {
      configuredKey = null;
      await engine.configure({ backend: null, label, options, config, error: scrub(err.message, [secrets[settings.provider]]) });
      return;
    }
    configuredKey = key;
    await engine.configure({ backend, key, label, options, config, explainError: explain });
  }

  function makeExplainer(current, keys) {
    const provider = current.provider;
    const serverUrl = serverUrlFor(current);
    const secret = keys[provider];
    return (message) => explainError(scrub(message, [secret]), { provider, serverUrl, extensionOrigin });
  }

  // `chosen`: whether a provider is chosen at all, so a panel with no helper
  // running can say to pick one rather than to start the helper.
  function runtimeMessage() {
    return { type: 'runtime', runtime: runtimeFor(settings), chosen: Boolean(settings.provider) };
  }

  function broadcast(message) {
    for (const port of ports) {
      try {
        port.postMessage(message);
      } catch {
        // gone; its disconnect handler removes it
      }
    }
  }

  function broadcastRuntime() {
    broadcast(runtimeMessage());
  }

  // ---- the panel's model switcher ------------------------------------------

  // Every saved profile with whether it can be switched to now and, if not,
  // a one-line reason. Only non-secret fields.
  async function profilesMessage() {
    const current = runtimeFor(settings);
    const entries = [];
    for (const profile of settings.profiles) {
      const entry = profileEntry(settings, profile);
      let reason = null;
      if (entry.runtime === 'extension') {
        const draft = withProfile(settings, profile);
        reason = profileProblem(draft, secrets);
        if (!reason) {
          const permission = await permissionFor(draft);
          if (!permission.granted) reason = `Not allowed to reach ${permission.pattern.replace(/\/\*$/, '')} yet`;
        }
      } else {
        try {
          reason = (await helperProblem(current)) || null;
        } catch {
          reason = null;
        }
      }
      entries.push({ ...entry, available: !reason, reason });
    }
    return { type: 'profiles', profiles: entries, active: settings.activeProfile };
  }

  async function broadcastProfiles() {
    if (ports.size === 0) return;
    broadcast(await profilesMessage());
  }

  // Every change to the settings (a switch, a helper's switch noted, an
  // options-page save) reads the current settings, checks, writes storage and
  // takes the result in one step on this queue, so none of them works from a
  // copy another one replaced while it awaited (a permission check, the
  // storage write) and overwrites it. Only that step is queued: the engine
  // swap after it, which may wait for a running reply, is not, so a save is
  // never held up behind a reply.
  let commitChain = Promise.resolve();
  function commit(step) {
    const run = commitChain.then(step);
    commitChain = run.catch(() => {});
    return run;
  }

  // Switches to a saved profile: only the active profile changes (never a
  // key, a URL or anything else), saved like any other setting, and the new
  // backend goes in through the engine's turn queue, so a reply already
  // running finishes first and the chat, statement and code move over.
  // Resolves once the swap has happened. One switch at a time.
  let switchChain = Promise.resolve();
  function switchProfile(id) {
    const run = switchChain.then(() => doSwitchProfile(id));
    switchChain = run.catch(() => {});
    return run;
  }

  async function doSwitchProfile(id) {
    const result = await commit(async () => {
      const profile = findProfile(settings.profiles, id);
      if (!profile) return { ok: false, code: 'unknown', message: 'That model is no longer saved. Open Manage models to add it again.' };
      if (settings.activeProfile === id) return { ok: true, runtime: runtimeFor(settings), unchanged: true };
      const next = applyPatch(settings, secrets, { activeProfile: id });
      const runtime = runtimeFor(next.settings);
      if (runtime === 'extension') {
        const problem = profileProblem(next.settings, next.secrets);
        if (problem) return { ok: false, code: 'unavailable', message: `${problem}. Open Manage models to finish setting it up.` };
        const permission = await permissionFor(next.settings);
        if (!permission.granted) return { ok: false, code: 'unavailable', message: permissionMessage(next.settings) };
        try {
          buildBackend(next.settings, next.secrets, { probe: async () => null });
        } catch (err) {
          return { ok: false, code: 'unavailable', message: scrub(err.message, [next.secrets[next.settings.provider]]) };
        }
      }
      await storage.set({ [SETTINGS_KEY]: next.settings });
      settings = next.settings;
      return { ok: true, runtime };
    });
    if (!result.ok) return result;
    if (result.unchanged) return { ok: true, runtime: result.runtime };
    await applyToEngine();
    broadcastRuntime();
    onRuntime(runtimeFor(settings), Boolean(settings.provider));
    await broadcastProfiles();
    return { ok: true, runtime: result.runtime };
  }

  // The helper's companion switched to a profile (the panel asked it through
  // the relay); the extension remembers which one is active. Nothing else
  // changes: the tutor keeps running through the helper.
  async function noteHelperSwitch(id) {
    const changed = await commit(async () => {
      const profile = findProfile(settings.profiles, id);
      if (!profile || settings.activeProfile === id || runtimeFor(settings) !== 'helper') return false;
      const next = applyPatch(settings, secrets, { activeProfile: id });
      if (runtimeFor(next.settings) !== 'helper') return false;
      await storage.set({ [SETTINGS_KEY]: next.settings });
      settings = next.settings;
      return true;
    });
    if (!changed) return;
    await applyToEngine();
    await broadcastProfiles();
  }

  // ---- the options page -------------------------------------------------

  async function view(extra = {}) {
    const permission = await permissionFor(settings);
    return { settings: publicView(settings, secrets), active: statusSummary(settings), permission, catalog: PROVIDERS, ...extra };
  }

  async function save({ patch }) {
    await commit(async () => {
      const next = applyPatch(settings, secrets, patch);
      if (runtimeFor(next.settings) === 'extension') {
        const problem = missingRequirement(next.settings, next.secrets);
        if (problem) throw new SettingsError(problem, 'provider');
        try {
          // Only checks that a backend can be built; the probe stays off.
          buildBackend(next.settings, next.secrets, { probe: async () => null });
        } catch (err) {
          throw new SettingsError(scrub(err.message, [next.secrets[next.settings.provider]]), err.field || 'provider');
        }
      }
      await storage.set({ [SETTINGS_KEY]: next.settings, [SECRETS_KEY]: next.secrets });
      settings = next.settings;
      secrets = next.secrets;
    });
    await applyToEngine();
    broadcastRuntime();
    onRuntime(runtimeFor(settings), Boolean(settings.provider));
    await broadcastProfiles();
    return view({ saved: true });
  }

  async function test({ patch }) {
    let draft;
    try {
      draft = applyPatch(settings, secrets, patch || {});
    } catch (err) {
      return { ok: false, message: err.message };
    }
    const secret = draft.secrets[draft.settings.provider];
    const problem = missingRequirement(draft.settings, draft.secrets);
    if (problem) return { ok: false, message: problem };
    if (runtimeFor(draft.settings) !== 'extension') return { ok: false, message: 'This provider is tested through the helper app.' };
    const permission = await permissionFor(draft.settings);
    if (!permission.granted) return { ok: false, message: permissionMessage(draft.settings), permission };
    const started = Date.now();
    try {
      const backend = buildBackendImpl(draft.settings, draft.secrets);
      const reply = await withTimeout(backend.sendMessage(CONNECTION_TEST_PROMPT, {}), TEST_TIMEOUT_MS, PROVIDERS[draft.settings.provider].label);
      if (!reply || !String(reply).trim()) return { ok: false, message: 'The model answered with nothing.' };
      return { ok: true, message: `Connected in ${((Date.now() - started) / 1000).toFixed(1)}s`, reply: scrub(String(reply).trim().slice(0, 120), [secret]) };
    } catch (err) {
      return { ok: false, message: makeExplainer(draft.settings, draft.secrets)(err.message) };
    }
  }

  async function models({ provider, baseUrl, apiKey }) {
    const id = provider === 'anthropic' || provider === 'openai' ? provider : 'local';
    const patch = { provider: id, providers: { [id]: {} } };
    if (baseUrl && id !== 'anthropic') patch.providers[id].baseUrl = baseUrl;
    if (typeof apiKey === 'string' && apiKey) patch.providers[id].apiKey = apiKey;
    let draft;
    try {
      draft = applyPatch(settings, secrets, patch);
    } catch (err) {
      return { models: [], message: err.message };
    }
    const key = draft.secrets[id];
    const permission = await permissionFor(draft.settings);
    if (!permission.granted) return { models: [], message: permissionMessage(draft.settings), permission };
    const signal = AbortSignal.timeout(MODELS_TIMEOUT_MS);
    try {
      let names = [];
      if (id === 'anthropic') {
        if (!key) return { models: [], message: 'Enter the API key first.' };
        names = await listAnthropicModels({ apiKey: key, signal });
      } else {
        const base = draft.settings.providers[id].baseUrl.replace(/\/+$/, '');
        const headers = key ? { Authorization: `Bearer ${key}` } : {};
        const ask = async (url) => {
          const res = await fetch(url, { headers, signal });
          if (!res.ok) throw new Error(`${url} answered ${res.status}`);
          return res.json();
        };
        if (id === 'local' && /\/v1$/.test(base)) {
          try {
            const tags = await ask(`${base.replace(/\/v1$/, '')}/api/tags`);
            names = (tags.models || []).map((m) => m.name);
          } catch {
            names = [];
          }
        }
        if (names.length === 0) {
          const list = await ask(`${base}/models`);
          names = (list.data || []).map((m) => m.id);
        }
      }
      return { models: [...new Set(names.filter((n) => typeof n === 'string' && n))].sort().slice(0, MAX_MODELS) };
    } catch (err) {
      const message = err && err.name === 'TimeoutError' ? 'The server did not answer in time.' : err.message;
      return { models: [], message: makeExplainer(draft.settings, draft.secrets)(scrub(message, [key])) };
    }
  }

  const SETTINGS_METHODS = {
    'lc-tutor:settings-get': () => view(),
    'lc-tutor:settings-save': save,
    'lc-tutor:settings-test': test,
    'lc-tutor:settings-models': models,
  };

  function isExtensionPage(sender) {
    return Boolean(sender && typeof sender.url === 'string' && sender.url.startsWith(`${extensionOrigin}/`));
  }

  return {
    ready,
    hub,
    engine,

    // A runtime message. Resolves to the answer, or undefined when the
    // message is not for this service.
    async handleMessage(message, sender) {
      if (!message || typeof message !== 'object') return undefined;
      await ready;
      if (message.type === 'lc-tutor:capture') {
        if (runtimeFor(settings) !== 'extension') return { handled: false };
        engine.handleCapture(message.capture);
        return { handled: true };
      }
      if (message.type === 'lc-tutor:runtime') return { runtime: runtimeFor(settings) };
      const method = Object.prototype.hasOwnProperty.call(SETTINGS_METHODS, message.type) ? SETTINGS_METHODS[message.type] : null;
      if (!method) return undefined;
      // Only the extension's own pages (the options page) may read or change
      // settings, never a content script on leetcode.com.
      if (!isExtensionPage(sender)) return { ok: false, error: { message: 'not allowed' } };
      try {
        return { ok: true, result: await method(message.params && typeof message.params === 'object' ? message.params : {}) };
      } catch (err) {
        if (err instanceof SettingsError) return { ok: false, error: { message: err.message, field: err.field } };
        return { ok: false, error: { message: scrub(err.message, Object.values(secrets)) } };
      }
    },

    // A Tutor panel's port.
    connectPort(port) {
      ports.add(port);
      let unsubscribe = null;
      const post = (message) => {
        try {
          port.postMessage(message);
        } catch {
          // disconnected
        }
      };
      ready.then(async () => {
        post(runtimeMessage());
        post(await profilesMessage());
      });
      port.onMessage.addListener((message) => {
        if (!message || typeof message !== 'object') return;
        ready.then(() => {
          if (message.type === 'subscribe') {
            if (unsubscribe) unsubscribe();
            unsubscribe = hub.subscribe((event) => post({ type: 'event', event }), {
              after: Number(message.after) || 0,
              epoch: typeof message.epoch === 'string' ? message.epoch : null,
            });
          } else if (message.type === 'unsubscribe') {
            if (unsubscribe) unsubscribe();
            unsubscribe = null;
          } else if (message.type === 'message') {
            const answer =
              runtimeFor(settings) === 'extension'
                ? engine.handleMessage(message)
                : { ok: false, error: 'helper' };
            post({ type: 'reply', id: message.id, ...answer });
          } else if (message.type === 'switch-profile') {
            const reqId = message.reqId;
            switchProfile(typeof message.id === 'string' ? message.id : '').then(
              (result) => post({ type: 'switch-result', reqId, ...result }),
              (err) => post({ type: 'switch-result', reqId, ok: false, code: 'failed', message: scrub(err.message, Object.values(secrets)) })
            );
          } else if (message.type === 'profile-switched' && typeof message.id === 'string') {
            noteHelperSwitch(message.id).catch((err) => log(`could not note a model switch: ${err.message}`));
          }
          // 'ping' needs no answer: receiving it is what keeps the worker up.
        });
      });
      port.onDisconnect.addListener(() => {
        ports.delete(port);
        if (unsubscribe) unsubscribe();
      });
    },

    // Re-checks what the current settings need (call when host permissions
    // change).
    refresh() {
      return ready.then(async () => {
        await applyToEngine();
        await broadcastProfiles();
      });
    },

    // Sends every panel the switcher's entries again (call when what the
    // helper can do changed).
    refreshProfiles() {
      return ready.then(() => broadcastProfiles());
    },

    // For tests: the same as a panel's 'switch-profile'.
    switchProfile(id) {
      return ready.then(() => switchProfile(id));
    },
  };
}
