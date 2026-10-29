// extension/shared/anthropic-backend.js - the tutor backend for the Anthropic
// Messages API with the user's own API key, used by the extension's
// background engine (the companion uses the Claude Agent SDK instead).
//
// It is LocalBackend with a different wire format: the same history, pinned
// problem and code, context fitting and "earlier in this session" summary,
// so a long session behaves the same on every provider. Only request() is
// replaced. Raw fetch rather than the SDK, because the extension has no build
// step and no dependencies.
//
// Called straight from the browser, so the request carries
// `anthropic-dangerous-direct-browser-access: true`. The key comes from the
// extension's own storage and only ever goes to the Anthropic API.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

import { LocalBackend } from './local-backend.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2026-10-21';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
// What one reply may use. Also the reserve held back from the window, so a
// request that fits always leaves the model this much room.
export const ANTHROPIC_MAX_TOKENS = 16000;
// The window budgeted for. Current models take far more, but a tutoring
// session never needs it, and a smaller budget keeps a runaway session from
// getting expensive: older exchanges are condensed long before this.
export const ANTHROPIC_CONTEXT_TOKENS = 200000;

// The Messages API takes the system prompt on its own and only user and
// assistant turns in `messages`. Every leading system message (the persona,
// the pinned problem and code, the summary; see context-budget.js's
// buildMessages) is joined into `system`, in order; a system message anywhere
// later, which buildMessages never makes, is sent as a user note rather than
// dropped.
export function toAnthropicRequest(messages) {
  const system = [];
  const turns = [];
  for (const message of messages) {
    if (message.role === 'system' && turns.length === 0) {
      system.push(message.content);
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.role === 'system' ? `(Note: ${message.content})` : message.content;
    const last = turns[turns.length - 1];
    // Two turns in a row from the same side are merged, which the API would
    // do anyway, so the request is always well formed.
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else turns.push({ role, content });
  }
  return { system: system.join('\n\n'), messages: turns };
}

function anthropicError(status, statusText, bodyText) {
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed?.error?.message) detail = parsed.error.message;
  } catch {
    // keep the raw text
  }
  if (status === 401) return new Error('the Anthropic API key was refused (401). Check the key in the options page.');
  if (status === 429) return new Error(`the Anthropic API is rate limiting this key (429): ${detail}`);
  return new Error(`Anthropic API request failed: ${status} ${statusText} ${detail}`.trim());
}

export class AnthropicBackend extends LocalBackend {
  constructor({
    apiKey,
    model,
    maxHistoryTurns,
    baseUrl = ANTHROPIC_BASE_URL,
    contextTokens = ANTHROPIC_CONTEXT_TOKENS,
    maxTokens = ANTHROPIC_MAX_TOKENS,
  }) {
    if (!apiKey) throw new Error('the Anthropic provider needs an API key');
    super({
      baseUrl,
      model: model || DEFAULT_ANTHROPIC_MODEL,
      apiKey,
      maxHistoryTurns,
      apiStyle: 'openai',
      numCtx: contextTokens,
      reserveTokens: maxTokens,
      // Nothing to probe: the window is known and the API never silently
      // truncates (an over-long request is refused instead).
      probe: async () => null,
      windowSetting: 'the Anthropic provider',
    });
    this.maxTokens = maxTokens;
  }

  async request(onChunk, messages, { signal } = {}) {
    const { system, messages: turns } = toAnthropicRequest(messages);
    const stream = Boolean(onChunk);
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, system, messages: turns, stream }),
      });
    } catch (err) {
      throw new Error(`could not reach ${this.baseUrl} (${err.message})`);
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw anthropicError(response.status, response.statusText, bodyText);
    }
    if (stream) return this.streamAnthropic(response, onChunk);
    const data = await response.json();
    const content = (data?.content || [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');
    return { content, reasoning: '', finishReason: finishReasonFor(data?.stop_reason), promptTokens: null };
  }

  // Reads the Messages API's SSE stream: text arrives in
  // `content_block_delta` events with a `text_delta`, the stop reason in
  // `message_delta`, and a failure mid-stream as an `error` event. Thinking
  // deltas are never shown.
  async streamAnthropic(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let stopReason = null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          content += event.delta.text;
          onChunk(event.delta.text);
        } else if (event?.type === 'message_delta' && event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason;
        } else if (event?.type === 'error') {
          throw new Error(`Anthropic API error: ${event.error?.message || event.error?.type || 'unknown error'}`);
        }
      }
    }
    return { content, reasoning: '', finishReason: finishReasonFor(stopReason), promptTokens: null };
  }
}

// The Messages API's stop reasons in the OpenAI terms resolveReplyText
// understands: a reply cut off at max_tokens is 'length'; a refusal is an
// error, never shown as a reply.
function finishReasonFor(stopReason) {
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'refusal') {
    throw new Error('the model declined to answer this message (stop reason "refusal")');
  }
  return stopReason || 'stop';
}

// The model ids this key can use (GET /v1/models), for the options page.
export async function listAnthropicModels({ apiKey, baseUrl = ANTHROPIC_BASE_URL, signal } = {}) {
  const response = await fetch(`${baseUrl}/v1/models?limit=100`, {
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw anthropicError(response.status, response.statusText, bodyText);
  }
  const data = await response.json();
  return (data?.data || []).map((m) => m?.id).filter((id) => typeof id === 'string' && id);
}
