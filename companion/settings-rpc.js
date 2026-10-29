// companion/settings-rpc.js - what the extension's options page can ask the
// companion to do: read the settings, save a change, test a connection, list a
// server's models.
//
// The options page talks to the relay, which forwards each call here over the
// companion's existing inbox stream (see panel-bridge.js). All the decisions
// live in this module so they can be tested without a browser, a relay, or a
// running companion:
//   - a save is validated, a backend is built from it (so a config that cannot
//     work is refused up front), and only then is it written and applied;
//   - a test builds a throwaway backend from an unsaved draft and never touches
//     the saved file or the live conversation;
//   - nothing returned to the options page ever contains an API key, and error
//     text is scrubbed of any key it might echo.

import {
  PROVIDERS,
  SettingsError,
  applyPatch,
  missingRequirement,
  publicView,
  resolveEffective,
  saveSettings,
  statusSummary,
} from './settings.js';
import { checkCodexLogin } from './codex-backend.js';
import { CONNECTION_TEST_PROMPT as TEST_PROMPT } from '../extension/shared/tutor-prompt.js';

const TEST_TIMEOUT_MS = 90_000;
const MODELS_TIMEOUT_MS = 6000;
const MAX_MODELS = 200;

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

// deps:
//   file, env                       where settings live and the environment to resolve against
//   getStored()                     the saved settings object currently in memory
//   setStored(next)                 replace it after a successful save
//   buildBackend(effective)         throws if a backend can't be built (async allowed)
//   apply(effective, backend)       swap the live backend (companion.js queues it behind the current turn)
//   validateVault(effective)        throws if the vault auto-summary can't run (optional)
//   fetchImpl, codexCommand         injectable for tests
export function createSettingsRpc(deps) {
  const fetchImpl = deps.fetchImpl || fetch;

  function view(extra = {}) {
    const stored = deps.getStored();
    const effective = resolveEffective(stored, deps.env);
    return { settings: publicView(stored, deps.env, deps.file), active: statusSummary(effective), ...extra };
  }

  async function get() {
    return view();
  }

  async function save({ patch }) {
    const stored = deps.getStored();
    const next = applyPatch(stored, patch);
    const effective = resolveEffective(next, deps.env);
    const problem = missingRequirement(effective);
    if (problem) throw new SettingsError(problem, 'provider');
    if (effective.options.vaultAutoSummary && deps.validateVault) {
      try {
        deps.validateVault(effective);
      } catch (err) {
        throw new SettingsError(err.message, 'vaultAutoSummary');
      }
    }
    // Build before persisting: a configuration that cannot produce a backend
    // must not replace one that works.
    let backend;
    try {
      backend = await deps.buildBackend(effective);
    } catch (err) {
      throw new SettingsError(scrub(err.message, [effective.apiKey]), 'provider');
    }
    saveSettings(next, deps.file);
    deps.setStored(next);
    await deps.apply(effective, backend);
    return view({ saved: true });
  }

  // Tries a draft (the saved settings with the page's unsaved edits on top).
  async function test({ patch }) {
    const draft = applyPatch(deps.getStored(), patch || {});
    const effective = resolveEffective(draft, deps.env);
    const secrets = [effective.apiKey];
    const problem = missingRequirement(effective);
    if (problem) return { ok: false, message: problem };
    const started = Date.now();
    try {
      if (effective.provider === 'chatgpt') {
        const login = await checkCodexLogin({ ...(deps.codexCommand || {}), env: deps.env });
        if (!login.ok) return { ok: false, message: `ChatGPT sign-in: ${login.message}. Run "codex login" and choose ChatGPT.` };
      }
      const backend = await deps.buildBackend(effective);
      const reply = await withTimeout(backend.sendMessage(TEST_PROMPT, {}), TEST_TIMEOUT_MS, PROVIDERS[effective.provider].label);
      if (!reply || !String(reply).trim()) return { ok: false, message: 'The model answered with nothing.' };
      return { ok: true, message: `Connected in ${((Date.now() - started) / 1000).toFixed(1)}s`, reply: String(reply).trim().slice(0, 120) };
    } catch (err) {
      return { ok: false, message: scrub(err.message, secrets) };
    }
  }

  // Lists model names a server offers, for the model field's suggestions.
  async function models({ provider, baseUrl, apiKey }) {
    const stored = deps.getStored();
    const id = PROVIDERS[provider] ? provider : 'local';
    const draft = applyPatch(stored, {
      providers: { [id]: { ...(baseUrl ? { baseUrl } : {}), ...(typeof apiKey === 'string' && apiKey ? { apiKey } : {}) } },
    });
    const effective = resolveEffective({ ...draft, provider: id }, deps.env);
    if (!effective.baseUrl) return { models: [] };
    const base = effective.baseUrl.replace(/\/+$/, '');
    const headers = effective.apiKey ? { Authorization: `Bearer ${effective.apiKey}` } : {};
    const secrets = [effective.apiKey];
    const ask = async (url) => {
      const res = await withTimeout(fetchImpl(url, { headers }), MODELS_TIMEOUT_MS, url);
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return res.json();
    };
    try {
      let names = [];
      // Ollama's own listing names models exactly as `ollama list` does and is
      // the one most local users want; fall back to the OpenAI-style list.
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
      return { models: [...new Set(names.filter((n) => typeof n === 'string' && n))].sort().slice(0, MAX_MODELS) };
    } catch (err) {
      return { models: [], message: scrub(err.message, secrets) };
    }
  }

  const METHODS = { get, save, test, models };

  // Single entry point used by the bridge. Never throws: the result is always
  // { ok: true, result } or { ok: false, error: { message, field } }.
  async function handle(method, params) {
    const fn = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
    if (!fn) return { ok: false, error: { message: `unknown settings method "${method}"` } };
    try {
      return { ok: true, result: await fn(params && typeof params === 'object' ? params : {}) };
    } catch (err) {
      if (err instanceof SettingsError) return { ok: false, error: { message: err.message, field: err.field } };
      return { ok: false, error: { message: scrub(err.message, [deps.env.COMPANION_API_KEY]) } };
    }
  }

  return { handle };
}
