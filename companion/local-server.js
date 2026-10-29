// companion/local-server.js - best-effort facts about the local model server
// LocalBackend talks to: whether it is Ollama (so its native chat API, the
// only one that honors a requested context window, can be used), and how big
// the model's context window really is. Works with any OpenAI-compatible
// server: every probe is optional, has a short timeout, and is ignored on any
// error or unexpected shape, so an unknown server simply keeps the
// configured window (plus LocalBackend's silent-truncation guard). Uses only
// fetch and AbortController, no Node API, so it can also run inside the
// browser extension.
//
// Probes, all read-only:
// - Ollama: GET /api/version (identifies it), POST /api/show (the model's
//   trained context_length) and GET /api/ps (the window a loaded model is
//   running with, which the OpenAI-compatible endpoint is stuck with).
// - LM Studio: GET /api/v0/models (loaded_context_length, else
//   max_context_length).
// - llama.cpp server: GET /props (default_generation_settings.n_ctx).
// - vLLM: GET <base>/models (max_model_len).

export const PROBE_TIMEOUT_MS = 1500;

// The server root, for the routes that do not live under the
// OpenAI-compatible /v1 prefix: a trailing /v1 (and slashes) is dropped.
export function serverRoot(baseUrl) {
  return String(baseUrl || '')
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Ollama names a model "name:tag" and fills in ":latest" when none is given.
function sameOllamaModel(name, model) {
  if (typeof name !== 'string' || !model) return false;
  const withTag = (s) => (s.includes(':') ? s : `${s}:latest`);
  return withTag(name) === withTag(model);
}

// GET /api/version answers {"version": "0.x.y"} on Ollama and nothing like
// it anywhere else.
export function looksLikeOllamaVersion(json) {
  return Boolean(json && typeof json === 'object' && typeof json.version === 'string' && json.version);
}

// POST /api/show: model_info carries "<architecture>.context_length".
export function parseOllamaShow(json) {
  const info = json && typeof json === 'object' ? json.model_info : null;
  if (!info || typeof info !== 'object') return null;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length')) {
      const n = positiveInt(value);
      if (n) return n;
    }
  }
  return null;
}

// GET /api/ps: the loaded models, each with the context_length it runs with.
export function parseOllamaPs(json, model) {
  const models = json && Array.isArray(json.models) ? json.models : [];
  const entry = models.find((m) => m && (sameOllamaModel(m.name, model) || sameOllamaModel(m.model, model)));
  return entry ? positiveInt(entry.context_length) : null;
}

// GET /api/v0/models (LM Studio): the loaded window wins over the maximum.
export function parseLmStudioModels(json, model) {
  const models = json && Array.isArray(json.data) ? json.data : [];
  const entry = models.find((m) => m && m.id === model);
  if (!entry) return null;
  return positiveInt(entry.loaded_context_length) || positiveInt(entry.max_context_length);
}

// GET /props (llama.cpp server): the per-slot window.
export function parseLlamaCppProps(json) {
  if (!json || typeof json !== 'object') return null;
  return positiveInt(json.default_generation_settings?.n_ctx) || positiveInt(json.n_ctx);
}

// GET /v1/models (vLLM): max_model_len on the served model.
export function parseOpenAIModels(json, model) {
  const models = json && Array.isArray(json.data) ? json.data : [];
  const entry = models.find((m) => m && m.id === model);
  return entry ? positiveInt(entry.max_model_len) : null;
}

// One probe: the parsed JSON body of a 2xx answer, or null on anything else
// (refused, timed out, not JSON, an error status).
export async function probeJson(url, { method = 'GET', body, headers = {}, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      response.body?.cancel?.().catch(() => {});
      return null;
    }
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Runs every probe at once and reports what it learned:
// `{ ollama, window }`, where `window` is `{ tokens, source }` (the smallest
// window any probe reported) or null. `apiStyle` is the style that will be
// used ('native' or 'openai'); a loaded Ollama model's running window only
// matters for 'openai', since native requests ask for their own.
export async function probeServer({ baseUrl, model, apiKey = null, apiStyle = null, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch }) {
  const root = serverRoot(baseUrl);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const get = (url) => probeJson(url, { headers, timeoutMs, fetchImpl });
  const [version, show, ps, lmStudio, props, models] = await Promise.all([
    get(`${root}/api/version`),
    probeJson(`${root}/api/show`, { method: 'POST', body: { model }, headers, timeoutMs, fetchImpl }),
    get(`${root}/api/ps`),
    get(`${root}/api/v0/models`),
    get(`${root}/props`),
    get(`${base}/models`),
  ]);
  const ollama = looksLikeOllamaVersion(version);
  const style = apiStyle || (ollama ? 'native' : 'openai');
  const found = [];
  if (ollama) {
    const trained = parseOllamaShow(show);
    if (trained) found.push({ tokens: trained, source: 'Ollama /api/show' });
    const running = style === 'openai' ? parseOllamaPs(ps, model) : null;
    if (running) found.push({ tokens: running, source: 'Ollama /api/ps' });
  }
  const lm = parseLmStudioModels(lmStudio, model);
  if (lm) found.push({ tokens: lm, source: 'LM Studio /api/v0/models' });
  const llama = parseLlamaCppProps(props);
  if (llama) found.push({ tokens: llama, source: 'llama.cpp /props' });
  const vllm = parseOpenAIModels(models, model);
  if (vllm) found.push({ tokens: vllm, source: '/v1/models max_model_len' });
  const window = found.reduce((min, w) => (!min || w.tokens < min.tokens ? w : min), null);
  return { ollama, apiStyle: style, window };
}
