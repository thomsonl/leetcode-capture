// extension/shared/local-backend.js - the tutor backend for any
// OpenAI-compatible chat server (Ollama, LM Studio, llama.cpp server, vLLM,
// text-generation-webui, LocalAI, hosted OpenAI) and Ollama's own native chat
// API. The companion (Node) and the extension's background engine import this
// one copy.
//
// Pure JavaScript with no Node API: only fetch, TextDecoder and
// AbortController, which a browser's service worker has too
// (extension/shared.test.js checks that).

import { buildMessages as buildLocalMessages, resolveContextWindow } from './context-budget.js';
import { fitWithSummary } from './context-summary.js';
import { probeServer, serverRoot } from './local-server.js';
import { formatPinnedCode } from './code-ledger.js';
import { normalizeConversation } from './conversation.js';
import { TUTOR_SYSTEM_MESSAGE } from './tutor-prompt.js';

// How many tokens of the window are held back for the model's own thinking
// and answer (see LocalBackend's class comment and companion.js's
// LOCAL_RESERVE_TOKENS, which can override it).
export const DEFAULT_RESERVE_TOKENS = 2600;

// What the companion calls the context-window setting in its messages.
export const DEFAULT_WINDOW_SETTING = 'COMPANION_LOCAL_NUM_CTX';

// Picks the actual reply text out of an OpenAI-compatible chat-completion
// response (or accumulated stream), used by both LocalBackend.sendMessage
// (non-streaming) and streamReply (streaming) so the two paths can't drift.
//
// The `reasoning`-when-`content`-is-empty fallback (see sendMessage's own
// comment) was built for a model that puts its whole, *finished* answer in
// `reasoning` and leaves `content` empty on an otherwise normal turn
// (finish_reason "stop"). It does NOT hold when the response was cut off
// before the model ever got past its own internal thinking
// (finish_reason "length"): in that case `reasoning` isn't a finished
// answer at all, just a raw, mid-thought scratchpad - handing it to
// sendAndPrint would print the model's own thinking process as if it were
// the tutor's actual reply, indistinguishable from a real one since it's
// still just text in the terminal.
//
// Confirmed live against the real Ollama gemma4:26b model this companion is
// actually configured for: a normal-length capture completes fine (content
// non-empty, or a complete reasoning-only answer on finish_reason "stop"),
// but a big Submit capture - a long solution, a long problem description,
// and/or several turns of resent history piling up in one session - eats
// most of Ollama's default 4096-token context window for this model (no
// num_ctx override; confirmed neither a top-level nor a nested `options`
// num_ctx field is honored by this Ollama version's /v1/chat/completions
// endpoint - only its native /api/chat does), leaving too little of the
// window for a real answer. The model then gets cut off mid-`reasoning`
// (finish_reason "length", content still empty), and the existing fallback
// printed that raw, truncated internal monologue as the "reply" - matching
// what grows more frequent as a session's conversation (and therefore its
// resent history) grows, not a rare fluke. Rather than ever surface that
// text, this throws a distinct, clearly-worded error instead - surfaced via
// the same "companion: error talking to backend" path as any other backend
// failure - so the failure is visible instead of silently masquerading as a
// real tutoring reply.
//
// This also fires on the very first turn of a brand-new conversation, with
// no accumulated history at all: one capture's own content (system prompt +
// problem description + submitted code) can by itself already exceed a
// small model's context window - a genuinely different failure from the
// multi-turn growth the pre-flight fit guards against, and confirmed live to
// happen with a perfectly normal-sized real submission (a description plus a
// ~150-line solution), not just a synthetic worst case. See LocalBackend's
// class comment for the actual fix (a bigger real context window via
// Ollama's native chat API) - `advice` lets the caller phrase this error
// according to which API path is actually in play, since the fix differs.
export function resolveReplyText({ content, reasoning, finishReason, advice }) {
  const trimmedContent = content && content.trim();
  const trimmedReasoning = reasoning && reasoning.trim();
  // A cut-off answer is a failed turn, even when visible content exists.
  // Keep that content on the error so callers can mark it as partial.
  if (finishReason === 'length' && (trimmedContent || trimmedReasoning)) {
    const err = new Error(
      'local backend reply was cut off before finishing; ' +
        (advice ||
          'try a shorter capture, clearing context, or a model/server configuration with more context')
    );
    err.cutOff = true; // LocalBackend frees room for the next message on this one
    err.partialReply = trimmedContent || '';
    throw err;
  }
  if (trimmedContent) return trimmedContent;
  return trimmedReasoning || '';
}

// Phrases resolveReplyText's cut-off advice and the budget refusal according
// to which API path LocalBackend actually used, so the message always points
// at something that can genuinely help: only Ollama's native API can be asked
// for a bigger window (COMPANION_LOCAL_NUM_CTX, or the runtime's own
// `windowSetting`); on any OpenAI-compatible
// server the window is set in the server itself.
export function contextAdviceFor(apiStyle, numCtx, setting = DEFAULT_WINDOW_SETTING) {
  if (apiStyle === 'native') {
    return (
      `try a shorter capture, clearing context, or raising ${setting} ` +
      `(currently ${numCtx}) if your model/machine has room for a bigger context window`
    );
  }
  return (
    "try a shorter capture, clearing context, or giving the model a bigger context window in the local " +
    `server's own settings and setting ${setting} to match (an OpenAI-compatible API ` +
    'cannot ask the server for one)'
  );
}

// A reply whose reported prompt size (usage.prompt_tokens, or Ollama's
// prompt_eval_count) is under this share of what LocalBackend estimates it
// sent means the server dropped part of the prompt to fit its own, smaller
// window. The estimate is deliberately on the high side for code (see
// CHARS_PER_TOKEN_ESTIMATE), so a normal tokenizer lands well above this;
// TRUNCATION_MIN_GAP keeps a tiny prompt's rounding from ever counting.
export const TRUNCATION_RATIO = 0.7;
export const TRUNCATION_MIN_GAP = 256;

export class LocalBackend {
  // Talks to either a standard OpenAI-compatible /v1/chat/completions
  // endpoint (`apiStyle: 'openai'`, any such server: LM Studio, llama.cpp
  // server, vLLM, text-generation-webui, LocalAI, Ollama's compat endpoint,
  // ...) or Ollama's own native /api/chat (`apiStyle: 'native'`), the only
  // one of the two that honors a requested context window (`num_ctx`). With
  // `apiStyle` null (COMPANION_LOCAL_API=auto) the server is probed once at
  // startup (local-server.js) and 'native' is used only if it answers like
  // Ollama. The same probes report the model's real window where the server
  // exposes it, and the budget uses the smaller of that and `numCtx`.
  //
  // Why the window matters: this project's own configured model (Ollama,
  // gemma4:26b) runs with a 4096-token window by default, and a perfectly
  // normal single Submit (a real description plus a ~150-line solution) was
  // confirmed live to exhaust it; the same request completed once resent to
  // /api/chat with `num_ctx: 8192`. Worse, past the window a server may
  // silently drop the start of the prompt (the system prompt and problem)
  // with an ordinary "stop", so the tutor answers about the wrong thing with
  // no error. Three things close that, all in sendMessage: the pre-flight
  // fit (every request is fitted to the budget by condensing the oldest
  // whole exchanges into one short summary, see context-summary.js, and
  // refused only if the parts that can never be dropped are over it), the
  // probed window, and the silent-truncation guard (a reply that
  // reports far fewer prompt tokens than were sent lowers the window to what
  // the server really kept, with one visible warning).
  //
  // `windowSetting` names, in error and warning text, what sets `numCtx` in
  // the runtime using this class (the companion's COMPANION_LOCAL_NUM_CTX by
  // default; the extension names its own options-page field).
  constructor({
    baseUrl,
    model,
    apiKey,
    maxHistoryTurns,
    apiStyle,
    numCtx,
    reserveTokens = DEFAULT_RESERVE_TOKENS,
    probe = probeServer,
    windowSetting = DEFAULT_WINDOW_SETTING,
  }) {
    if (!model) {
      throw new Error(
        'a model name is required for a local or OpenAI-compatible model (set it in the extension\'s Tutor settings, or COMPANION_MODEL, e.g. COMPANION_MODEL=llama3.2)'
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.maxHistoryTurns = maxHistoryTurns;
    // Explicit 'native'/'openai' wins; null means "decide from the probe",
    // and until it answers (or if it fails) the portable 'openai' is used.
    this.apiStyle = apiStyle === 'native' ? 'native' : 'openai';
    this.numCtx = numCtx;
    this.reserveTokens = reserveTokens;
    this.windowSetting = windowSetting;
    // Ollama's native API lives at the server root (e.g.
    // http://localhost:11434/api/chat), not under the OpenAI-compat prefix,
    // so a trailing /v1 is dropped for it.
    this.nativeBaseUrl = serverRoot(this.baseUrl);
    // What the probe found (`{ tokens, source }` or null) and the smallest
    // window a reply showed the server really keeping (or null). See
    // contextWindow().
    this.detectedWindow = null;
    this.observedWindow = null;
    this.truncationWarned = false;
    // Warnings for the caller to print once the turn is over (takeWarnings).
    this.pendingWarnings = [];
    // Ask for usage on a streamed reply (the OpenAI `stream_options`) until a
    // server rejects the field, then never again.
    this.streamUsage = true;
    // Probed once, in the background, so startup never waits on it; the
    // first message waits at most for the probe's own short timeouts. A
    // failed probe leaves the configured window and the 'openai' style.
    this.ready = Promise.resolve()
      .then(() => probe({ baseUrl: this.baseUrl, model, apiKey, apiStyle: apiStyle || null }))
      .then((found) => {
        if (!found) return;
        if (!apiStyle && found.apiStyle === 'native') this.apiStyle = 'native';
        if (found.window) this.detectedWindow = found.window;
      })
      .catch(() => {});
    // Standard OpenAI chat-completions shape: a leading `role: 'system'`
    // message, resent in full on every turn along with the rest of history.
    // Includes the shared style addendum (see STYLE_ADDENDUM) - this backend
    // never inherits it any other way. Kept on its own so resetContext
    // (below) can restore exactly this. Ollama's native /api/chat accepts
    // this exact same messages shape too, so history/resetContext and the fit
    // are all shared unchanged between both API styles.
    this.systemMessage = { role: 'system', content: TUTOR_SYSTEM_MESSAGE };
    this.history = [this.systemMessage];
    // The full problem description for whichever problem is currently being
    // discussed, if one has been seen yet - `{ problemId, title, slug,
    // description }`, or null. Deliberately NOT part of `this.history`: it is
    // reconstructed fresh into every outgoing request (buildMessages), so a
    // long session can never lose it to trimming.
    this.pinnedProblemContext = null;
    // The student's current full code (see code-ledger.js's
    // formatPinnedCode), pinned as a system message like the description on
    // every request, so the tutor always sees the exact code and condensing
    // can never lose it; a turn's message only says what changed. `{ text }`
    // or null.
    this.pinnedCode = null;
    // The "earlier in this session" summary standing in for condensed older
    // exchanges (context-summary.js), or null. Memory only, cleared by
    // resetContext; a backend swap builds a new backend without one.
    this.summary = null;
    // Exchanges that must be condensed on the next request even if it fits
    // (after a reply cut off for room, see sendMessage).
    this.forceCondense = 0;
  }

  // The context window this backend budgets for, `{ tokens, source }`: the
  // smallest of the configured COMPANION_LOCAL_NUM_CTX, the probed one and
  // the observed one (see resolveContextWindow). The single place the
  // window is decided, so a settings field only needs to feed `numCtx`.
  contextWindow() {
    return resolveContextWindow({
      configured: this.numCtx,
      detected: this.detectedWindow,
      observed: this.observedWindow,
    });
  }

  // The prompt budget: the window minus the reserve for the model's reply.
  promptBudget() {
    return this.contextWindow().tokens - this.reserveTokens;
  }

  // Where the window in a budget message came from, in words.
  describeWindow() {
    const window = this.contextWindow();
    if (window.source === 'detected') {
      return `the model's ${window.tokens}-token context window, as reported by the server (${window.from})`;
    }
    if (window.source === 'observed') {
      return `a ${window.tokens}-token context window, the most the server was seen to keep`;
    }
    return /^[A-Z][A-Z0-9_]*$/.test(this.windowSetting)
      ? `${this.windowSetting}=${window.tokens}`
      : `a ${window.tokens}-token context window (${this.windowSetting})`;
  }

  // Warnings raised during the last turn (the silent-truncation guard), for
  // the caller to print once the reply is on screen. Emptied by the call.
  takeWarnings() {
    const warnings = this.pendingWarnings;
    this.pendingWarnings = [];
    return warnings;
  }

  // `problemContext` (see companion.js's captureProblemContext) is supplied
  // whenever a problem is known. `currentCode` is the student's current full
  // code for this request (code-ledger.js's currentCodeFor: `{ code,
  // language, stale }` or null), and `compactText` what this turn becomes
  // once it is older (see context-budget.js's buildMessages).
  async sendMessage(text, { onChunk, problemContext, currentCode, compactText } = {}) {
    await this.ready;
    // Pin the description the first time we see one for whichever problem
    // is now current - ignored on every later turn for the same problem,
    // which is exactly what keeps it from being resent every turn (see
    // buildMessages, which is what actually re-includes it on each
    // request).
    if (problemContext?.description && problemContext.problemId !== this.pinnedProblemContext?.problemId) {
      this.pinnedProblemContext = problemContext;
    }
    const pinnedText = formatPinnedCode(currentCode);
    this.pinnedCode = pinnedText ? { text: pinnedText } : null;
    this.history.push({
      role: 'user',
      content: text,
      ...(typeof compactText === 'string' && compactText !== text ? { compactContent: compactText } : {}),
    });

    // Pre-flight fit: condense the oldest whole exchanges into the
    // "earlier in this session" summary until the request is within budget
    // (or past the exchange-count cap), rather than ever sending one
    // estimated to exceed the model's real window (a server may silently
    // discard part of an over-long prompt and review the wrong code with an
    // ordinary "stop", which no finishReason guard can see). Done on every
    // request, so a conversation that grew past the budget (long replies, or
    // a window that turned out smaller) frees itself on the very next
    // message, silently: the summary call (see summarize) streams nothing and
    // prints nothing, and it runs inside this turn, so the turn queue never
    // interleaves it with another. Refused only when the parts that can
    // never be dropped (system prompt, problem statement, code, this
    // message) are over the budget alone.
    const budget = this.promptBudget();
    const fit = await fitWithSummary({
      history: this.history,
      pinnedProblemContext: this.pinnedProblemContext,
      pinnedCode: this.pinnedCode,
      summary: this.summary,
      budget,
      maxPairs: this.maxHistoryTurns > 0 ? this.maxHistoryTurns : 0,
      forcePairs: this.forceCondense,
      summarize: (messages, signal) => this.summarize(messages, signal),
    });
    if (!fit.fits) {
      this.history.pop();
      const { systemPrompt, problem, code, message } = fit.parts;
      throw new Error(
        `this request is estimated at ~${fit.estimatedTokens} prompt tokens, over the ${budget}-token budget ` +
          `(${this.describeWindow()} minus a ${this.reserveTokens}-token reserve for the model's own ` +
          `thinking/answer) even with every earlier exchange left out: the system prompt is ~${systemPrompt} ` +
          `tokens, the problem statement ~${problem}, the code ~${code} and this message ~${message} - ` +
          `refusing to send it rather than risk the local model silently discarding part of the prompt and ` +
          `reviewing the wrong code with no visible sign anything went wrong; ` +
          `${contextAdviceFor(this.apiStyle, this.numCtx, this.windowSetting)}`
      );
    }
    this.history = fit.history.slice();
    this.summary = fit.summary;
    this.forceCondense = 0;

    // Every failure path below pops the dangling user turn before
    // propagating, rather than leaving history with a user message that was
    // never actually answered.
    let raw;
    try {
      raw = await this.request(onChunk, fit.messages);
    } catch (err) {
      this.history.pop();
      throw err;
    }
    this.checkPromptTokens(fit.estimatedTokens, raw.promptTokens);

    let replyText;
    try {
      replyText = resolveReplyText({
        content: raw.content,
        reasoning: raw.reasoning,
        finishReason: raw.finishReason,
        advice: contextAdviceFor(this.apiStyle, this.numCtx, this.windowSetting),
      });
    } catch (err) {
      this.history.pop();
      // Cut off for room: the same request would only be cut off again, so
      // the oldest exchange is condensed on the next message, giving it more
      // room.
      if (err.cutOff) this.forceCondense = 1;
      throw err;
    }

    if (!replyText) {
      this.history.pop();
      throw new Error('local backend returned an empty reply (no content or reasoning in the response)');
    }
    this.history.push({ role: 'assistant', content: replyText });
    return replyText;
  }

  // The summary call (context-summary.js's condense): the same model and
  // API, not streamed, no warnings, no truncation check. Resolves to the
  // text (empty when the model gave none) or throws; any failure means the
  // deterministic digest is used instead.
  async summarize(messages, signal) {
    const raw = await this.request(null, messages, { signal });
    return resolveReplyText({ content: raw.content, reasoning: raw.reasoning, finishReason: raw.finishReason, advice: '' });
  }

  // One request to the model, streamed when `onChunk` is given. Resolves to
  // the raw reply parts `{ content, reasoning, finishReason, promptTokens }`.
  // A subclass speaking another API (anthropic-backend.js) overrides only
  // this.
  request(onChunk, messages, options = {}) {
    return this.apiStyle === 'native'
      ? this.requestNative(onChunk, messages, options)
      : this.requestOpenAI(onChunk, messages, options);
  }

  // The silent-truncation guard. `reported` is the prompt size the server
  // says it processed (null if it did not say). Far below what was sent
  // means the server's real window is smaller than budgeted for and it
  // dropped the start of the prompt: warn once per session, and budget for
  // the window it really kept from now on, so the next request is trimmed to
  // fit (the window only ever goes down this way).
  checkPromptTokens(estimated, reported) {
    if (!Number.isFinite(reported) || reported <= 0) return;
    if (reported >= estimated * TRUNCATION_RATIO || estimated - reported < TRUNCATION_MIN_GAP) return;
    const before = this.contextWindow().tokens;
    if (!this.observedWindow || reported < this.observedWindow) this.observedWindow = reported;
    if (this.truncationWarned) return;
    this.truncationWarned = true;
    this.pendingWarnings.push(
      `the local server processed only ~${reported} of the ~${estimated} prompt tokens sent, so it silently ` +
        `dropped part of the conversation (its context window is smaller than the ${before} tokens budgeted ` +
        `for, and that reply may have missed the problem or code); budgeting for a ${this.contextWindow().tokens}-token ` +
        `window from now on so later messages fit. Set a bigger context window in the server, or ` +
        `${this.windowSetting} to what it really has.`
    );
  }

  // Builds the actual outgoing messages array for a request (context-
  // budget.js's buildMessages, pure and unit-tested directly; this is a thin
  // wrapper passing this instance's own fields through).
  buildMessages() {
    return buildLocalMessages({
      history: this.history,
      pinnedProblemContext: this.pinnedProblemContext,
      pinnedCode: this.pinnedCode,
      summary: this.summary,
    });
  }

  // Standard OpenAI-compatible /v1/chat/completions request/response shape -
  // portable to any server that speaks it. Resolves to the raw reply parts
  // `{ content, reasoning, finishReason, promptTokens }`; sendMessage turns
  // them into the reply (resolveReplyText) after the truncation guard.
  async requestOpenAI(onChunk, messages, { signal } = {}) {
    const stream = Boolean(onChunk);
    const send = (withUsage) =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream,
          // Without this a streamed reply carries no usage at all, and the
          // truncation guard has nothing to check.
          ...(stream && withUsage ? { stream_options: { include_usage: true } } : {}),
        }),
      });
    let response;
    try {
      response = await send(this.streamUsage);
      if (!response.ok && stream && this.streamUsage && (response.status === 400 || response.status === 422)) {
        // A strict server that does not know `stream_options`: retry once
        // without it, and leave it off from now on.
        const bodyText = await response.text().catch(() => '');
        if (/stream_options/i.test(bodyText)) {
          this.streamUsage = false;
          response = await send(false);
        } else {
          throw new Error(`local backend request failed: ${response.status} ${response.statusText} ${bodyText}`);
        }
      }
    } catch (err) {
      if (err.message.startsWith('local backend request failed')) throw err;
      throw new Error(`could not reach ${this.baseUrl} (${err.message})`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`local backend request failed: ${response.status} ${response.statusText} ${bodyText}`);
    }

    // Some locally-hosted "thinking" models (e.g. Ollama's gemma-family
    // thinking variants) put their whole answer in a separate `reasoning`
    // field and leave `content` empty, especially on the longer responses a
    // Submit's full breakdown asks for; resolveReplyText falls back to it.
    if (stream) return this.streamReply(response, onChunk);
    const data = await response.json();
    const choice = data?.choices?.[0];
    return {
      content: choice?.message?.content,
      reasoning: choice?.message?.reasoning,
      finishReason: choice?.finish_reason,
      promptTokens: Number(data?.usage?.prompt_tokens),
    };
  }

  // Ollama's native /api/chat - same messages shape in, but a different
  // response shape out: a single JSON object (non-streaming) or newline-
  // delimited JSON objects (streaming), `message: { content, thinking }`
  // instead of `choices[0].message`, and `done_reason`/`prompt_eval_count`
  // at the top level. The only reason to use this over requestOpenAI is
  // `options.num_ctx`, below - confirmed live this is honored here and
  // nowhere on the compat endpoint.
  async requestNative(onChunk, messages, { signal } = {}) {
    let response;
    try {
      response = await fetch(`${this.nativeBaseUrl}/api/chat`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: Boolean(onChunk),
          options: { num_ctx: this.numCtx },
        }),
      });
    } catch (err) {
      throw new Error(`could not reach ${this.nativeBaseUrl} (${err.message})`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`local backend request failed: ${response.status} ${response.statusText} ${bodyText}`);
    }

    if (onChunk) return this.streamReplyNative(response, onChunk);
    const data = await response.json();
    return {
      content: data?.message?.content,
      reasoning: data?.message?.thinking,
      finishReason: data?.done_reason,
      promptTokens: Number(data?.prompt_eval_count),
    };
  }

  // Reads an OpenAI-compatible chat-completions SSE stream (one `data:
  // {...}` event per chunk, terminated by `data: [DONE]`), calling onChunk
  // for each piece of visible `delta.content` as it arrives. `delta.reasoning`
  // is accumulated the same way but never handed to onChunk - a "thinking"
  // model's internal trace isn't what streaming is meant to surface live.
  // `usage` arrives on its own final event when `stream_options` asked for it.
  async streamReply(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let finishReason = null;
    let promptTokens = null;
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
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // a malformed/partial SSE line - ignore rather than crash the stream
        }
        if (event?.usage && Number.isFinite(Number(event.usage.prompt_tokens))) {
          promptTokens = Number(event.usage.prompt_tokens);
        }
        const choice = event?.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          onChunk(delta.content);
        }
        if (delta?.reasoning) reasoning += delta.reasoning;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
    return { content, reasoning, finishReason, promptTokens };
  }

  // Reads Ollama's native /api/chat streaming shape: newline-delimited JSON
  // objects (no `data:`/SSE framing, no `[DONE]` sentinel), each carrying an
  // incremental `message.content` and/or `message.thinking`, with the final
  // object marked `done: true` and carrying `done_reason` and
  // `prompt_eval_count` - confirmed live against a real Ollama server.
  // `thinking` deltas accumulate like `reasoning` above, never to onChunk.
  async streamReplyNative(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let doneReason = null;
    let promptTokens = null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // a malformed/partial line - ignore rather than crash the stream
        }
        const delta = event?.message;
        if (delta?.content) {
          content += delta.content;
          onChunk(delta.content);
        }
        if (delta?.thinking) reasoning += delta.thinking;
        if (event?.done) {
          doneReason = event.done_reason || 'stop';
          if (Number.isFinite(Number(event.prompt_eval_count))) promptTokens = Number(event.prompt_eval_count);
        }
      }
    }
    return { content, reasoning, finishReason: doneReason, promptTokens };
  }

  // Truncates history back to just the leading system message, so the next
  // sendMessage resends none of the prior conversation - and drops the
  // pinned problem description too, so a genuinely new problem's own
  // description gets pinned fresh on its first capture. What was learned
  // about the server (its window) is kept: it is the same server.
  resetContext() {
    this.history = [this.systemMessage];
    this.pinnedProblemContext = null;
    this.pinnedCode = null;
    this.summary = null;
    this.forceCondense = 0;
  }

  // The conversation in the shape every backend shares (conversation.js), so
  // a swapped-in backend carries on from it.
  exportConversation() {
    return normalizeConversation({
      turns: this.history.slice(1),
      summary: this.summary,
      problem: this.pinnedProblemContext,
    });
  }

  importConversation(state) {
    const { turns, summary, problem } = normalizeConversation(state);
    this.resetContext();
    this.history = [this.systemMessage, ...turns];
    this.summary = summary;
    this.pinnedProblemContext = problem;
  }
}
