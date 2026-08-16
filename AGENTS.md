# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Four components, each self-contained with no shared build tooling: `extension/` (MV3 content script, no build step - loads unpacked in Chrome, and as a temporary add-on in Firefox/Zen via `about:debugging#/runtime/this-firefox`; carries `browser_specific_settings.gecko.id` for Firefox), `relay-server/` (plain Node `http`, no deps), `vault-tool/` (Node CLI, no deps), `companion/` (single-process Node program, ESM, one real dependency - `@anthropic-ai/claude-agent-sdk` - for its Claude backend). See `README.md` for setup/usage of all four.
- The extension reads Monaco's code via DOM (`.monaco-editor .view-lines`), not the `monaco` JS global - avoids needing a page-context injection. If LeetCode's DOM structure changes, this is the first place to check.
- The problem description is read from `[data-track-load="description_content"]` (an analytics hook attribute, more stable than LeetCode's generated class names - verified against live `leetcode.com/problems/*` pages). `#qd-content` also matches but additionally picks up tab labels and other page chrome, so it's avoided.
- LeetCode's own topic tags are read from `a[href^="/tag/"]` (verified live against `leetcode.com/problems/two-sum/` and `/house-robber/` with `chrome-devtools-axi`: matches exactly the "Topics" panel's links and nothing else, present in the DOM even while that panel is visually collapsed). Sent as `problemTags` on the capture; see `vault-tool/vault-notes.js`'s `findTopicNoteByTagName` for how a tag gets matched to an existing vault topic note.
- The relay server rebuilds its per-problem `attemptSeq` counter from the existing log file on startup, so restarts don't reset sequence numbers. Log format is one JSON object per line at `relay-server/data/captures.jsonl` (gitignored).
- The relay server sends permissive CORS headers (`Access-Control-Allow-Origin: *`) and answers the `OPTIONS` preflight on `/capture`. This is load-bearing, not decorative: Chrome's content-script `fetch()` bypasses CORS via the extension's `host_permissions`, but Firefox/Zen run content-script `fetch()` under the page's own origin, so without these headers every capture from Firefox/Zen is silently dropped (see git history for the original bug/fix). `relay-server/server.test.js` (`npm test` in `relay-server/`) is the regression test - run it before touching CORS or route handling in `server.js`.
- `vault-tool/vault-notes.js` holds the shared per-problem/per-topic note-linking logic (topic lookup, per-problem note creation, generic markdown-section read/upsert) used by both `vault-tool/log-session.js` (the manual CLI) and `companion/vault-summary.js` (the automatic feature below) - extend it there rather than duplicating logic in either caller. `log-session.js` matches a problem slug to a topic note by searching `Study/Algorithms/*.md` for a link containing `/problems/<slug>/`; falls back to creating a per-problem note under `Study/Algorithms/Problems/`. `npm test` in `vault-tool/` covers `vault-notes.js` directly, including that `upsertSection` is idempotent. See `~/Documents/My Brain/AGENTS.md` for vault conventions.
- `fixtures/captures.jsonl` is a sample capture log for exercising the vault tool without a live capture session (`--dry-run` to preview without writing).
- `companion/companion.js` is a single Node process (no tmux, no CLI pane-scraping): it tails
  captures the same way the old `watch.js` did and drives a normal `readline` chat loop, sending
  both typed input and injected captures through a swappable backend (`COMPANION_BACKEND=claude`
  via `@anthropic-ai/claude-agent-sdk`, or `local` via plain `fetch` against an OpenAI-compatible
  endpoint). A capture arriving mid-keystroke never corrupts the in-progress input line - it's
  printed above the prompt and the prompt is redrawn with the saved line/cursor reinserted
  (`printAboveInput` in `companion.js`). See `README.md` → Companion for credentials, setup, and
  the verified behavior difference between the two backends' auth.
- Both companion backends share one tutor persona, `TUTOR_SYSTEM_PROMPT` in `companion.js`. For
  the Claude backend, passing it as a plain `systemPrompt` string *replaces* Claude Code's own
  default system prompt rather than appending to it - only the SDK's `{ type: 'preset', preset:
  'claude_code' }` form preserves the default. That's intentional here (no tools, not acting as a
  coding agent over this repo), but is the first thing to check if Claude-backend responses ever
  seem to be missing Claude Code's usual framing.
- `companion.js` owns the relay server's lifecycle: it health-checks (`OPTIONS /capture`) on
  startup, spawns `node server.js` detached only if nothing answers, and stops only the instance it
  spawned (tracked in `relayServerChild`) via a `process.on('exit', ...)` handler, so a server it
  found already running is never touched. This is a deliberate durability tradeoff from the
  server's old always-on behavior - see README.md → Companion for what changed. Verified end-to-end
  (not just read) in the PR that introduced this: auto-start + real capture flow, exit kills the
  spawned server, and a manually-started server survives companion exit untouched.
- Every commit message and PR description in this repo is written in first person (I/my/mine) -
  the repo's own account is the author, so never refer to the user in the third person.
- Vault auto-summary (`VAULT_AUTO_SUMMARY`, off by default): on a Submit, turns the companion's own
  tutoring reply into a durable vault note - see README.md → "Vault auto-summary" for the full
  design. The logic lives in `companion/vault-summary.js`, not `companion.js` itself, specifically
  so it's unit-testable without booting the readline loop or relay-server lifecycle (`npm test` in
  `companion/` - the first automated tests this program has had). The load-bearing constraint: no
  second LLM call - a Submit's addendum (`buildVaultAddendum`) asks the model to tack a
  machine-readable `<<<VAULT_JSON>>>...<<<END_VAULT_JSON>>>` block onto the end of the *same* reply
  already being generated; `extractVaultBlock` peels it back off before the reply is printed, so the
  terminal chat is unchanged. Both the per-problem star rating and per-topic proficiency score are
  LLM judgment calls, not verified facts (LeetCode exposes neither "optimal complexity" nor "this
  code's complexity" directly) - this limitation is stated in the note itself, not just here.
  Verified end-to-end in the PR that introduced this: a real subprocess run of `companion.js`
  against a stub OpenAI-compatible backend, asserting the JSON block never reaches stdout and both
  the per-problem and topic-index vault files come out with the expected content.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
