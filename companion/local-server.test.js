// Unit tests for local-server.js: what the probes learn from each kind of
// local model server, and that an unknown, broken or hanging server just
// yields nothing (the configured window and the 'openai' style), quickly.
// Each server here is a real local HTTP stub answering only its own routes.
//
// Run with: node --test local-server.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  serverRoot,
  looksLikeOllamaVersion,
  parseOllamaShow,
  parseOllamaPs,
  parseLmStudioModels,
  parseLlamaCppProps,
  parseOpenAIModels,
  probeServer,
} from './local-server.js';

// `routes` maps "METHOD /path" to a JSON body, a function of the request
// body returning one, or 'hang' (never answers). Anything else is a 404.
async function stub(t, routes) {
  const seen = [];
  const hanging = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      const route = routes[`${req.method} ${req.url}`];
      if (route === 'hang') {
        hanging.push(res);
        return;
      }
      if (route === undefined) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 page not found');
        return;
      }
      const body = typeof route === 'function' ? route(raw ? JSON.parse(raw) : null) : route;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const res of hanging) res.destroy();
    server.closeAllConnections?.();
    server.close();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, seen };
}

test('serverRoot drops a trailing /v1 and slashes', () => {
  assert.equal(serverRoot('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(serverRoot('http://host:1234/v1/'), 'http://host:1234');
  assert.equal(serverRoot('http://host:8080'), 'http://host:8080');
});

test('the parsers read each server shape and ignore anything unexpected', () => {
  assert.equal(looksLikeOllamaVersion({ version: '0.12.3' }), true);
  for (const bad of [null, {}, { version: 3 }, { version: '' }, 'x', []]) assert.equal(looksLikeOllamaVersion(bad), false);

  assert.equal(parseOllamaShow({ model_info: { 'general.architecture': 'gemma3', 'gemma3.context_length': 131072 } }), 131072);
  for (const bad of [null, {}, { model_info: null }, { model_info: { 'x.context_length': 'big' } }]) assert.equal(parseOllamaShow(bad), null);

  const ps = { models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest', context_length: 4096 }] };
  assert.equal(parseOllamaPs(ps, 'llama3.2'), 4096);
  assert.equal(parseOllamaPs(ps, 'llama3.2:latest'), 4096);
  assert.equal(parseOllamaPs(ps, 'qwen3'), null);
  assert.equal(parseOllamaPs({ models: 'no' }, 'llama3.2'), null);

  const lm = { data: [{ id: 'qwen3-8b', loaded_context_length: 16384, max_context_length: 40960 }, { id: 'other', max_context_length: 8192 }] };
  assert.equal(parseLmStudioModels(lm, 'qwen3-8b'), 16384);
  assert.equal(parseLmStudioModels(lm, 'other'), 8192);
  assert.equal(parseLmStudioModels(lm, 'missing'), null);

  assert.equal(parseLlamaCppProps({ default_generation_settings: { n_ctx: 8192 } }), 8192);
  assert.equal(parseLlamaCppProps({ n_ctx: 4096 }), 4096);
  assert.equal(parseLlamaCppProps({ default_generation_settings: { n_ctx: -1 } }), null);

  assert.equal(parseOpenAIModels({ data: [{ id: 'm', max_model_len: 32768 }] }, 'm'), 32768);
  assert.equal(parseOpenAIModels({ data: [{ id: 'm' }] }, 'm'), null);
  assert.equal(parseOpenAIModels({ object: 'list' }, 'm'), null);
});

test('Ollama on any address is recognized, and its window comes from /api/show (and /api/ps for openai style)', async (t) => {
  const server = await stub(t, {
    'GET /api/version': { version: '0.12.3' },
    'POST /api/show': (body) =>
      body && body.model === 'gemma3' ? { model_info: { 'gemma3.context_length': 131072 } } : { error: 'no' },
    'GET /api/ps': { models: [{ name: 'gemma3:latest', context_length: 4096 }] },
  });
  const auto = await probeServer({ baseUrl: server.baseUrl, model: 'gemma3' });
  assert.deepEqual(auto, { ollama: true, apiStyle: 'native', window: { tokens: 131072, source: 'Ollama /api/show' } });

  // Forced to the compat endpoint, the loaded model's running window is what counts.
  const compat = await probeServer({ baseUrl: server.baseUrl, model: 'gemma3', apiStyle: 'openai' });
  assert.deepEqual(compat, { ollama: true, apiStyle: 'openai', window: { tokens: 4096, source: 'Ollama /api/ps' } });
});

test('LM Studio, llama.cpp and vLLM report their windows and stay on the openai style', async (t) => {
  const lm = await stub(t, {
    'GET /api/v0/models': { data: [{ id: 'qwen3-8b', loaded_context_length: 16384, max_context_length: 40960 }] },
    'GET /v1/models': { data: [{ id: 'qwen3-8b' }] },
  });
  assert.deepEqual(await probeServer({ baseUrl: lm.baseUrl, model: 'qwen3-8b' }), {
    ollama: false,
    apiStyle: 'openai',
    window: { tokens: 16384, source: 'LM Studio /api/v0/models' },
  });

  const llama = await stub(t, { 'GET /props': { default_generation_settings: { n_ctx: 4096 } } });
  assert.deepEqual(await probeServer({ baseUrl: llama.baseUrl, model: 'anything' }), {
    ollama: false,
    apiStyle: 'openai',
    window: { tokens: 4096, source: 'llama.cpp /props' },
  });

  const vllm = await stub(t, { 'GET /v1/models': { object: 'list', data: [{ id: 'mistral', max_model_len: 32768 }] } });
  assert.deepEqual(await probeServer({ baseUrl: vllm.baseUrl, model: 'mistral' }), {
    ollama: false,
    apiStyle: 'openai',
    window: { tokens: 32768, source: '/v1/models max_model_len' },
  });
});

test('an unknown, garbage-answering, unreachable or hanging server yields nothing, within the timeout', async (t) => {
  const unknown = await stub(t, {});
  assert.deepEqual(await probeServer({ baseUrl: unknown.baseUrl, model: 'm' }), { ollama: false, apiStyle: 'openai', window: null });

  const garbage = await stub(t, {
    'GET /api/version': '<html>hi</html>',
    'GET /props': 'not json',
    'GET /v1/models': { data: 'nope' },
    'GET /api/v0/models': { data: [{ id: 'm', loaded_context_length: '4k' }] },
  });
  assert.deepEqual(await probeServer({ baseUrl: garbage.baseUrl, model: 'm' }), { ollama: false, apiStyle: 'openai', window: null });

  // A port nothing listens on.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  assert.deepEqual(await probeServer({ baseUrl: `http://127.0.0.1:${closedPort}/v1`, model: 'm' }), {
    ollama: false,
    apiStyle: 'openai',
    window: null,
  });

  const hang = await stub(t, { 'GET /api/version': 'hang', 'GET /props': 'hang', 'GET /v1/models': 'hang' });
  const started = Date.now();
  const result = await probeServer({ baseUrl: hang.baseUrl, model: 'm', timeoutMs: 300 });
  assert.deepEqual(result, { ollama: false, apiStyle: 'openai', window: null });
  assert.ok(Date.now() - started < 2000, `probing a hanging server took ${Date.now() - started} ms`);
});

test('the API key is sent on probes, for a remote server that needs one', async (t) => {
  let auth = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') auth = req.headers.authorization;
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await probeServer({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'm', apiKey: 'sk-test' });
  assert.equal(auth, 'Bearer sk-test');
});
