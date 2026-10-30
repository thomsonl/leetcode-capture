// extension/shared/conversation.js - the tutor conversation as data every
// backend can hand to another, and the flattening the prompt-only backends
// (CodexBackend, ClaudeBackend's rebuild) share.
//
// Every backend keeps the same three things about the chat: the exchanges
// still shown in full, the "earlier in this session" summary of condensed
// ones (context-summary.js) and the pinned problem statement. The student's
// code is not part of it: the runtime's code ledger (code-ledger.js) owns it
// and hands every request the current full code. So a backend swap (another
// model on the options page, or the model switcher) moves this state to the
// new backend and the tutor forgets nothing: `transferConversation`.
//
// The exported shape, the same from every backend:
//   { turns: [{ role: 'user' | 'assistant', content, compactContent? }],
//     summary: string | null,
//     problem: { problemId, title, slug, description } | null }
// `turns` always holds whole exchanges, oldest first.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

// A copy of `state` in the exported shape, with anything malformed left out:
// a turn that is not a string, a trailing unanswered user turn, a role out of
// order. Never throws.
export function normalizeConversation(state) {
  const turns = [];
  const raw = Array.isArray(state?.turns) ? state.turns : [];
  for (const turn of raw) {
    if (!turn || typeof turn.content !== 'string') continue;
    const role = turn.role === 'assistant' ? 'assistant' : turn.role === 'user' ? 'user' : null;
    const expected = turns.length % 2 === 0 ? 'user' : 'assistant';
    if (role !== expected) continue;
    turns.push({
      role,
      content: turn.content,
      ...(typeof turn.compactContent === 'string' && turn.compactContent !== turn.content
        ? { compactContent: turn.compactContent }
        : {}),
    });
  }
  if (turns.length % 2 === 1) turns.pop();
  const summary = typeof state?.summary === 'string' && state.summary ? state.summary : null;
  const problem = state?.problem && typeof state.problem === 'object' ? { ...state.problem } : null;
  return { turns, summary, problem };
}

// Moves the conversation from one backend to another. Returns true when it
// did (both sides support it and they differ), so the caller knows the new
// backend has seen everything the old one had.
export function transferConversation(from, to) {
  if (!from || !to || from === to) return false;
  if (typeof from.exportConversation !== 'function' || typeof to.importConversation !== 'function') return false;
  to.importConversation(normalizeConversation(from.exportConversation()));
  return true;
}

// Splits buildMessages' list (context-budget.js) for a backend that takes one
// system text and one prompt string: the first `systemCount` leading system
// messages become the system text (keep it to what never changes within a
// problem, so the provider can cache it), and everything else becomes the
// prompt, in order: any further system messages (the pinned code, the
// summary), the earlier exchanges as a transcript, then the current message
// and `closing`.
export function flattenMessages(messages, { systemCount = Infinity, closing = '' } = {}) {
  const leading = [];
  let i = 0;
  while (i < messages.length && messages[i].role === 'system') {
    leading.push(messages[i].content);
    i += 1;
  }
  const turns = messages.slice(i);
  const current = turns.pop();
  const system = leading.slice(0, systemCount);
  const parts = leading.slice(systemCount);
  if (turns.length) {
    parts.push(
      `Conversation so far:\n\n${turns.map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content}`).join('\n\n')}`
    );
  }
  parts.push(`Student: ${current ? current.content : ''}${closing ? `\n\n${closing}` : ''}`);
  return { system: system.join('\n\n---\n\n'), prompt: parts.join('\n\n---\n\n') };
}
