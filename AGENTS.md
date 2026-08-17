# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Four components, each self-contained with no shared build tooling: `extension/` (MV3 content script, no build step - loads unpacked in Chrome, and as a temporary add-on in Firefox/Zen via `about:debugging#/runtime/this-firefox`; carries `browser_specific_settings.gecko.id` for Firefox and, since Mozilla's November 2025
  policy change, `gecko.data_collection_permissions` - required for all new AMO submissions,
  declared as `websiteContent`/`required` because the extension transmits captured problem
  content and code to the local relay server and Mozilla counts localhost as "transmission" too),
  `relay-server/` (plain Node `http`, no deps), `vault-tool/` (Node CLI, no deps), `companion/` (single-process Node program, ESM, one real dependency - `@anthropic-ai/claude-agent-sdk` - for its Claude backend). See `README.md` for setup/usage of all four.
- The extension reads code from Monaco's actual editor model (`monaco.editor.getEditors()`, filtered to the
  editor whose DOM node has a non-zero `getBoundingClientRect()` - LeetCode has a second, hidden/offscreen
  Monaco instance on the page - then `.getModel().getValue()`), not the rendered `.view-lines` DOM. Monaco
  virtualizes rendered lines (only keeps DOM nodes for what's on screen plus overscan), so DOM scraping
  silently truncates anything beyond a screenful - confirmed live: a 156-line solution showed only 10
  `.view-line` elements in the DOM but the model always has the full text. `extension/inject.js` is injected
  as a real `<script>` tag (not a declarative MV3 `"world": "MAIN"` content script - Firefox only gained
  reliable support for that in Firefox 128, after this extension's `strict_min_version: 109`) so it runs in
  the page's MAIN world where `monaco` lives, and talks back to `content.js`'s isolated world over
  `CustomEvent`s on `document` (`leetcode-capture:request-code` / `leetcode-capture:code-response`, matched
  by a request id) - both worlds share the same DOM, so no `postMessage` is needed.
  `getEditorCode()` in `content.js` awaits that round-trip (500ms timeout) and falls back to the old
  DOM-scrape (`getEditorCodeFromDom()`) if it fails for any reason, so a capture still happens even if
  injection is ever blocked. Verified live end-to-end with chrome-devtools-axi against a real
  leetcode.com/problems/two-sum/ page (full protocol round-trip using the real `inject.js` source, not a
  mock): full capture of a 150+ line C++ solution well beyond one screen, a short solution, and a capture
  after switching the language selector (LeetCode replaces the model in place on a language switch, still
  correctly detected) - Firefox/Zen was reasoned about only (matching the CustomEvent/script-tag-injection
  approach that already works identically on both), not independently live-verified, since chrome-devtools-axi
  only drives Chromium. `.view-line`'s rendered text uses U+00A0 (non-breaking space) where the real source
  has a plain space (confirmed live via charCode) - `getEditorCodeFromDom()`'s `.replace(/ /g, " ")` (NBSP to
  space) is a real normalization, not a no-op; the model path never has this problem since `getValue()`
  returns the real source text directly.
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
- `sendAndPrint` in `companion.js` prints a capture's reply only after the backend call fully
  resolves - if a backend call ever resolves with an empty/falsy reply (rather than throwing), the
  old code printed just the capture's label with nothing after it, indistinguishable from "the
  reply never arrived." Hit live with `COMPANION_BACKEND=local` against an Ollama "thinking" model
  (e.g. `gemma4:26b`): it sometimes puts its whole answer in a `reasoning` field on the chat message
  and leaves `content` empty, more likely on the longer response a Submit's full breakdown asks for
  than on a Run's short acknowledgement - `LocalBackend.sendMessage` now falls back to `reasoning`
  and throws (surfacing the existing `companion: error talking to backend` line) if both are empty;
  `sendAndPrint` also has a defense-in-depth guard for any backend returning an empty string.
  `companion/companion.test.js` (`npm test` in `companion/`) is the regression test - spawns a real
  companion.js subprocess against a stub OpenAI-compatible server returning `reasoning`-only
  replies. When reproducing companion.js issues locally with a custom capture log path, set both
  `CAPTURE_LOG_PATH` (what `relay-server/server.js` writes to) and `LEETCODE_CAPTURES_FILE` (what
  `companion.js` tails) - they default to the same physical path but are read independently, so
  setting only one while `companion.js` auto-spawns its own relay server (see the lifecycle note
  above) points the two at different files and captures silently vanish.
- `extension/content.js`'s Run button is icon-only on the live page (a FontAwesome play-icon SVG,
  no visible text) - a text-only click match (`btn.textContent.trim() === 'run'`) never fires for
  it, so Run captures were silently never sent at all. Confirmed via live DOM inspection against a
  real leetcode.com problem page: the Submit button carries `data-e2e-locator="console-submit-button"`
  and `aria-label="Submit"`; `matchesRunButton`/`matchesSubmitButton` now check, in order,
  `data-e2e-locator`, `aria-label`, a play-icon SVG (Run only), then text - so no single LeetCode
  frontend change can silently reintroduce this bug. `handleDelegatedClick` looks up the click
  target via `closest('[data-e2e-locator]')` first, falling back to `closest('button')`.
  `extension/content.test.js` (`npm test` in `extension/` - the first automated tests this
  component has had; content.js exports the matchers via a `module.exports` guarded to be a no-op
  in the real browser, so no build step or jsdom is needed) covers this with mock button objects.
  The exact Run-side `data-e2e-locator` value (assumed `"console-run-button"`, mirroring Submit's
  naming) was not independently confirmed live - if it turns out different, the aria-label/icon
  fallbacks still cover it, but confirm the real value with a live DOM inspection if this ever needs
  revisiting.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
