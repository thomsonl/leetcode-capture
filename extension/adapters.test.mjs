// The extension runtime's provider adapters against stub servers on
// ephemeral ports: an OpenAI-compatible server (streamed SSE), Ollama's
// native /api/chat (NDJSON, with num_ctx), and the Anthropic Messages API
// (SSE). Also how the extension's settings build each backend, and the plain
// error text for an Ollama that refuses the extension's origin.
//
// Run with: node --test adapters.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalBackend } from './shared/local-backend.js';
import { AnthropicBackend, ANTHROPIC_VERSION, listAnthropicModels, toAnthropicRequest } from './shared/anthropic-backend.js';
import { TUTOR_SYSTEM_MESSAGE } from './shared/tutor-prompt.js';
import { applyPatch, buildBackend, emptySecrets, emptySettings, explainError } from './shared/extension-settings.js';

// A stub server: handler(req, body, res). Every request is recorded.
async function stub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      handler(req, parsed, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  res.end();
}

const noProbe = async () => null;

test('OpenAI-compatible: streams the reply, asks for usage, and sends the shared tutor prompt', async () => {
  const server = await stub((req, body, res) => {
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    sse(res, [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 900 } },
      '[DONE]',
    ]);
  });
  try {
    const backend = new LocalBackend({ baseUrl: `${server.url}/v1`, model: 'm', apiStyle: 'openai', numCtx: 8192, probe: noProbe });
    const chunks = [];
    const reply = await backend.sendMessage('hi', { onChunk: (c) => chunks.push(c) });
    assert.equal(reply, 'Hello there');
    assert.deepEqual(chunks, ['Hello', ' there']);
    const sent = server.requests[0].body;
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[0].content, TUTOR_SYSTEM_MESSAGE);
    assert.deepEqual(sent.messages.at(-1), { role: 'user', content: 'hi' });
  } finally {
    await server.close();
  }
});

test('Ollama: auto detection picks the native API, which is asked for the configured num_ctx', async () => {
  const server = await stub((req, body, res) => {
    if (req.url === '/api/version') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"version":"0.32.9"}');
    if (req.url === '/api/show') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"model_info":{"llama.context_length":32768}}');
    if (req.url !== '/api/chat') return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { content: 'Native', thinking: 'hmm' } })}\n`);
    res.write(`${JSON.stringify({ message: { content: ' reply' } })}\n`);
    res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 1200 })}\n`);
  });
  try {
    const settings = applyPatch(emptySettings(), emptySecrets(), {
      provider: 'local',
      providers: { local: { baseUrl: `${server.url}/v1`, model: 'gemma', contextTokens: 16384 } },
    });
    const backend = buildBackend(settings.settings, settings.secrets);
    const chunks = [];
    const reply = await backend.sendMessage('hi', { onChunk: (c) => chunks.push(c) });
    assert.equal(reply, 'Native reply');
    assert.deepEqual(chunks, ['Native', ' reply'], 'thinking is never streamed');
    const chat = server.requests.find((r) => r.url === '/api/chat');
    assert.equal(chat.body.options.num_ctx, 16384);
    assert.equal(chat.body.stream, true);
    assert.equal(backend.contextWindow().tokens, 16384, 'the smaller of the setting and the model window');
  } finally {
    await server.close();
  }
});

test('Anthropic: streams text deltas with the browser-access headers and the system prompt on its own', async () => {
  const server = await stub((req, body, res) => {
    if (req.url !== '/v1/messages') return void res.writeHead(404).end();
    sse(res, [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Nice ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'work.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
  });
  try {
    const backend = new AnthropicBackend({ apiKey: 'sk-ant-test-key', model: 'claude-opus-5-5', baseUrl: server.url, maxHistoryTurns: 6 });
    const chunks = [];
    const reply = await backend.sendMessage('my question', {
      onChunk: (c) => chunks.push(c),
      problemContext: { problemId: 'two-sum', title: 'Two Sum', slug: 'two-sum', description: 'Find two numbers.' },
      heldCode: { code: 'x = 1', language: 'python3' },
    });
    assert.equal(reply, 'Nice work.');
    assert.deepEqual(chunks, ['Nice ', 'work.']);
    const sent = server.requests[0];
    assert.equal(sent.headers['x-api-key'], 'sk-ant-test-key');
    assert.equal(sent.headers['anthropic-version'], ANTHROPIC_VERSION);
    assert.equal(sent.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(sent.headers.authorization, undefined, 'the key goes only in x-api-key');
    assert.equal(sent.body.model, 'claude-opus-5-5');
    assert.equal(sent.body.stream, true);
    assert.ok(sent.body.max_tokens > 0);
    assert.ok(sent.body.system.startsWith(TUTOR_SYSTEM_MESSAGE));
    assert.match(sent.body.system, /Find two numbers\./, 'the pinned problem goes into system');
    assert.match(sent.body.system, /x = 1/, 'the pinned code goes into system');
    assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'my question' }]);

    // The second turn carries the first exchange as alternating turns.
    await backend.sendMessage('again', { onChunk: () => {} });
    assert.deepEqual(
      server.requests[1].body.messages.map((m) => m.role),
      ['user', 'assistant', 'user']
    );
  } finally {
    await server.close();
  }
});

test('Anthropic: a reply cut off at max_tokens is an error, not a reply, and a refusal or error event too', async () => {
  let mode = 'max_tokens';
  const server = await stub((req, body, res) => {
    if (mode === 'error') return sse(res, [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    if (mode === 'http') return void res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":{"message":"invalid x-api-key"}}');
    sse(res, [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'message_delta', delta: { stop_reason: mode } },
    ]);
  });
  try {
    const backend = new AnthropicBackend({ apiKey: 'sk-ant-k', baseUrl: server.url });
    await assert.rejects(backend.sendMessage('q', { onChunk: () => {} }), /cut off before finishing/);
    mode = 'refusal';
    await assert.rejects(backend.sendMessage('q', { onChunk: () => {} }), /declined/);
    mode = 'error';
    await assert.rejects(backend.sendMessage('q', { onChunk: () => {} }), /Overloaded/);
    mode = 'http';
    await assert.rejects(backend.sendMessage('q', { onChunk: () => {} }), /API key was refused/);
    assert.equal(backend.history.length, 1, 'no failed turn is left in the history');
  } finally {
    await server.close();
  }
});

test('Anthropic: the models list and the request shaping', async () => {
  const server = await stub((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }] }));
  });
  try {
    assert.deepEqual(await listAnthropicModels({ apiKey: 'k', baseUrl: server.url }), ['claude-opus-5-5', 'claude-sonnet-5-5']);
    assert.equal(server.requests[0].headers['x-api-key'], 'k');
  } finally {
    await server.close();
  }
  assert.deepEqual(
    toAnthropicRequest([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'r' },
    ]),
    { system: 'a\n\nb', messages: [{ role: 'user', content: 'u1\n\nu2' }, { role: 'assistant', content: 'r' }] }
  );
});

test('OpenAI provider: built from settings, it sends the key as a bearer token to the configured base URL', async () => {
  const server = await stub((req, body, res) => {
    sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']);
  });
  try {
    const { settings, secrets } = applyPatch(emptySettings(), emptySecrets(), {
      provider: 'openai',
      providers: { openai: { model: 'gpt-5', baseUrl: `${server.url}/v1`, apiKey: 'sk-openai-xyz' } },
    });
    const backend = buildBackend(settings, secrets);
    assert.equal(await backend.sendMessage('hi', { onChunk: () => {} }), 'ok');
    const chat = server.requests.find((r) => r.url === '/v1/chat/completions');
    assert.equal(chat.headers.authorization, 'Bearer sk-openai-xyz');
    assert.equal(server.requests.some((r) => r.url === '/api/chat'), false, 'a hosted API never gets the Ollama API');
  } finally {
    await server.close();
  }
});

test('a local server that refuses the extension (403) or cannot be reached gets the OLLAMA_ORIGINS fix', () => {
  const ctx = { provider: 'local', serverUrl: 'http://localhost:11434/v1', extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' };
  const forbidden = explainError('local backend request failed: 403 Forbidden ', ctx);
  assert.match(forbidden, /refused the request \(403\)/);
  assert.match(forbidden, /OLLAMA_ORIGINS=chrome-extension:\/\/abcdefghijklmnopabcdefghijklmnop/);
  const down = explainError('could not reach http://localhost:11434 (Failed to fetch)', ctx);
  assert.match(down, /Couldn't reach the local server at http:\/\/localhost:11434\/v1\. Check that it is running\./);
  assert.match(down, /OLLAMA_ORIGINS/);
  assert.equal(explainError('local backend request failed: 500 boom', ctx), 'local backend request failed: 500 boom');
  assert.equal(explainError('could not reach x', { ...ctx, provider: 'openai' }), 'could not reach x');
});

test('settings: keys are kept apart, validated, removable, and never in the public view', async () => {
  const { publicView } = await import('./shared/extension-settings.js');
  let { settings, secrets } = applyPatch(emptySettings(), emptySecrets(), {
    provider: 'anthropic',
    providers: { anthropic: { apiKey: 'sk-ant-secret-1234' } },
  });
  assert.equal(secrets.anthropic, 'sk-ant-secret-1234');
  assert.equal(JSON.stringify(settings).includes('sk-ant'), false, 'the settings record holds no key');
  const view = publicView(settings, secrets);
  assert.equal(view.providers.anthropic.hasKey, true);
  assert.equal(JSON.stringify(view).includes('sk-ant-secret'), false, 'the public view holds no key');
  assert.equal(view.runtime, 'extension');
  ({ settings, secrets } = applyPatch(settings, secrets, { providers: { anthropic: { apiKey: null } } }));
  assert.equal(secrets.anthropic, null);
  assert.throws(() => applyPatch(settings, secrets, { providers: { local: { baseUrl: 'ftp://x' } } }), /must start with http/);
  assert.throws(() => applyPatch(settings, secrets, { provider: 'claude', runtime: 'extension' }), /cannot run there/);
  const helper = applyPatch(settings, secrets, { provider: 'local', runtime: 'helper' });
  assert.equal(publicView(helper.settings, helper.secrets).runtime, 'helper');
  assert.equal(publicView(emptySettings(), emptySecrets()).runtime, 'helper', 'nothing chosen keeps the helper');
});
