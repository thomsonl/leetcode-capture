# Context guarantee: measurement and recommendation

Status 2026-10-29: the stateless backends (LocalBackend, AnthropicBackend, CodexBackend) now pin the CURRENT full code (this turn's diff already applied) next to the pinned statement in every request, and a backend swap keeps the chat.
ClaudeBackend was deliberately left on its resumed SDK session; this note is the input for deciding it later.

## Method and assumptions

The numbers are hand estimates with `estimateTokens` (3.9 characters per token) for a realistic 7-turn single-problem session, not real API calls.
Sizes: tutor system prompt about 600 tokens (`TUTOR_SYSTEM_MESSAGE`, 2,335 characters), statement about 400, code about 450, a numbered diff about 70, a student message about 30, a tutor reply about 350.
Cache model: a cached read costs 0.1x and a cache write 1.25x of base input (0.05x reads on Claude Opus 5.5), and a read can only land where an earlier request wrote a breakpoint.
Assumed for Claude Code: it marks the system prompt and the end of the last message, and a resumed session resends the whole session transcript as an append-only message list.
A stateless Agent SDK query takes one string prompt, so the whole rebuilt transcript is one block and only the system prompt (persona plus statement) can be read from cache.

## Claude: session versus stateless rebuild

Raw input tokens per turn are about the same both ways (turn 7 is about 4,200 tokens either way), because Claude Code resends the session too.
Cache-weighted, the session pays full price only for the newest exchange: turn 7 is about 935 units, the 7-turn total about 6,800.
A stateless rebuild pays write price for the whole transcript every turn: turn 7 is about 4,160 units, the 7-turn total about 18,400, so about 2.7x the session, and about 4.5x at 12 turns.
A session that carries the full current code whenever it changed (equal correctness to stateless: the newest full copy is always exact) costs about 10,500 for 7 turns, still about 1.75x cheaper than stateless.

## Recommendation

Keep ClaudeBackend on the session, but make it carry the current full code (the "The student's current code" block) in front of any turn whose code changed, so no diff ever has to be applied mentally.
Keep our own record of the exchanges in ClaudeBackend too, and seed a new session from it (statement, summary, exchanges, current code) on the first turn, after a reset, after a backend swap, after a failed turn and after an SDK `compact_boundary` event, which also gives it `exportConversation`/`importConversation` so a model switch keeps the chat.
Resend the same system prompt on resumed turns, or the cache and the statement are lost.
Verify the cache assumptions with two tiny real calls by reading `usage.cache_read_input_tokens` before relying on these ratios.

## Diff versus full code for the stateless backends

Every request pins the full current code; the per-turn message keeps the numbered diff (about 70 tokens per changed turn, a few percent of a 4,000-token request), because the pinned code alone cannot show what the student just changed.
A message whose plan is `full` already holds the whole code, so that request does not pin it a second time; every later request pins it and the older full turn is sent compact.

## Known follow-ups

`TUTOR_SYSTEM_MESSAGE` still says "apply it to held code"; it should say the diff is already applied to "The student's current code" (tutor-prompt.js was being edited elsewhere, so it was not touched here).
AnthropicBackend sends no `cache_control`; top-level automatic caching would be a free cost win.
