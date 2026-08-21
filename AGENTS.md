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
  only drives Chromium. This reasoning-only Firefox gap turned out to miss a real bug: Firefox enforces Xray
  wrapper security boundaries between a content script's isolated realm and the page's MAIN-world realm, so
  reading a property (e.g. `.requestId`) off a `CustomEvent`'s `detail` object created *in the other realm*
  throws `Permission denied to access property "..."` even though the value is present - Chrome doesn't
  enforce this for a page-context-injected `<script>`, so it looked fine there. Confirmed live in Thomson's
  own Firefox console against the merged PR #16/#17 fix. Both `content.js`'s `requestModelCode()` and
  `inject.js`'s request listener now `JSON.stringify` the whole `{ requestId, ... }` payload into `detail`
  as a plain string and `JSON.parse` it back out on the receiving side, in both directions of the protocol -
  a string primitive crosses the realm boundary cleanly on both browsers, avoiding the need for Firefox's
  `cloneInto()` (which doesn't exist in Chrome and would need feature-detection). `extension/content.test.js`
  covers the parse side (a malformed non-JSON `detail` is ignored, not thrown). Chrome-side regression-checked
  after this fix via Playwright's cached headless Chromium loading the real `inject.js`/`content.js`
  request-response logic against a page with a faked `monaco` global (same sandboxing approach as the WAR
  match-pattern note below) - real Firefox/Zen verification of this specific fix was not done in the PR that
  introduced it (no Firefox available in that sandbox); confirm live in Firefox/Zen before trusting this is
  fully closed. `.view-line`'s rendered text uses U+00A0 (non-breaking space) where the real source
  has a plain space (confirmed live via charCode) - `getEditorCodeFromDom()`'s `.replace(/ /g, " ")` (NBSP to
  space) is a real normalization, not a no-op; the model path never has this problem since `getValue()`
  returns the real source text directly.
- `manifest.json`'s `web_accessible_resources[0].matches` must be a *strictly broader* match pattern than
  `content_scripts[0].matches`, not merely equal to it - PR #16's model-read fix (above) initially shipped
  with both set to the identical string `https://leetcode.com/problems/*`, and that exact pairing made real
  Chrome reject the whole extension at load time ("Invalid value for 'web_accessible_resources[0]'. Invalid
  match pattern.") - confirmed live by loading the real unpacked extension into a real Chrome instance.
  Silent failure mode: `getEditorCode()`'s DOM-scrape fallback had zero logging, so the truncation bug PR #16
  was meant to fix kept happening with no visible cause. Fixed by broadening WAR's pattern to
  `https://leetcode.com/*`; `getEditorCode()` now logs which path (model vs. DOM-scrape) produced each
  capture and warns loudly on fallback. `extension/content.test.js` asserts WAR's matches strictly cover
  content_scripts's matches, specifically rejecting an identical pair. To sandbox-test extension loading
  without a system Chrome install: launch Playwright's cached Chromium
  (`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome --headless=new --load-extension=<dir>
  --disable-extensions-except=<dir> --enable-logging=stderr --v=1`) and grep its log for "Failed to load
  extension" - real leetcode.com is unreachable from a headless browser here (Cloudflare's bot challenge), so
  end-to-end capture behavior needs a local page serving the unmodified content.js/inject.js against a faked
  `monaco` global instead (see the PR that added this note for the pattern). `sleep` is blocked in this
  harness's Bash tool and silently kills the whole command chain - use a spin-loop (`for i in $(seq 1 N); do
  :; done`) or split across separate tool calls instead.
- The problem description is read from `[data-track-load="description_content"]` (an analytics hook attribute, more stable than LeetCode's generated class names - verified against live `leetcode.com/problems/*` pages). `#qd-content` also matches but additionally picks up tab labels and other page chrome, so it's avoided.
- LeetCode's own topic tags are read from `a[href^="/tag/"]` (verified live against `leetcode.com/problems/two-sum/` and `/house-robber/` with `chrome-devtools-axi`: matches exactly the "Topics" panel's links and nothing else, present in the DOM even while that panel is visually collapsed). Sent as `problemTags` on the capture; see `vault-tool/vault-notes.js`'s `findTopicNoteByTagName` for how a tag gets matched to an existing vault topic note.
- The relay server rebuilds its per-problem `attemptSeq` counter from the existing log file on startup, so restarts don't reset sequence numbers. Log format is one JSON object per line at `relay-server/data/captures.jsonl` (gitignored).
- The relay server sends permissive CORS headers (`Access-Control-Allow-Origin: *`) and answers the `OPTIONS` preflight on `/capture`. This is load-bearing, not decorative: Chrome's content-script `fetch()` bypasses CORS via the extension's `host_permissions`, but Firefox/Zen run content-script `fetch()` under the page's own origin, so without these headers every capture from Firefox/Zen is silently dropped (see git history for the original bug/fix). `relay-server/server.test.js` (`npm test` in `relay-server/`) is the regression test - run it before touching CORS or route handling in `server.js`.
- The vault path and its algorithm-notes subfolder (Thomson's own: `~/Documents/My Brain`,
  `Study/Algorithms`) resolve through `vault-notes.js`'s `resolveVaultConfig()` - the one place both
  `log-session.js` and `vault-summary.js`/`companion.js` go, precedence env var
  (`VAULT_PATH`/`VAULT_ALGORITHMS_SUBFOLDER`) > gitignored `vault.config.json` at the repo root (see
  `vault.config.example.json`, and README.md → "Configure the vault") > built-in defaults. Zero
  config file and zero env vars reproduces Thomson's own setup exactly. `validateVaultPath()` fails
  loudly (naming the exact path) if the resolved vault path doesn't exist, rather than
  `ensurePerProblemNoteFile`/`createPerProblemNote` silently `mkdirSync`-ing a brand-new folder tree
  there - called from `ensurePerProblemNoteFile` itself and from both callers before any write.
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

- `companion/terminal-format.js` owns companion.js's CLI-look styling: a `>` prompt marker, a `•`
  marker opening a tutor reply turn (`turnMarker`, replacing an earlier "tutor" role-label/framing-rule
  design - no per-speaker labels any more), dimmed `companion: ...` status/error lines, and markdown
  rendering via `marked`/`marked-terminal` wrapped to a comfortable reading width (`COMFORTABLE_WIDTH`,
  currently 80 cols, capped by a narrower real terminal) rather than the terminal's full width - a
  separate module specifically so the styling decision (TTY or not, `NO_COLOR` or not) is computed
  once at import time and every exported helper already no-ops correctly, rather than each call site
  in companion.js carrying its own branch. Gates on `process.stdout.isTTY` explicitly rather than
  trusting chalk's/marked-terminal's own ambient color-support detection - confirmed live that this
  sandbox sometimes has `FORCE_COLOR` set even on a piped, non-TTY stdout, which would otherwise leak
  ANSI codes into piped output. Because `enabled` is frozen at import time, a test that wants the
  TTY-on behavior must set `process.stdout.isTTY = true` *and* import the module via dynamic
  `import()` (not a static `import` statement, which ES modules hoist and evaluate before any
  preceding line of code, TTY flag included) - see `companion/terminal-format.test.js`'s header
  comment and `runInChild` for the working pattern. `companion/companion.test.js` spawns companion.js
  with piped stdio, so it doubles as the non-TTY/no-ANSI regression path end-to-end.

  `terminal-format.js` also owns streaming support: `spinnerFrame` (one frame of a "waiting on the
  backend" spinner - the timing/redraw is `companion.js`'s job, since only it has the readline
  instance) and `createMarkdownStreamer` (feeds a reply in incrementally, only rendering a block once
  it reaches a safe boundary - a blank line outside a fenced code block, or a fence's own close - so
  a still-open fence or mid-block chunk is never handed to `marked`/`marked-terminal`, which renders
  those as broken/uncoloured text; disabled/non-TTY mode is a pure per-chunk pass-through, matching
  how a non-streaming reply already looked over a pipe). Both backends' `sendMessage(text, {
  onChunk })` take an optional `onChunk` and call it with each visible text delta: `ClaudeBackend`
  sets `includePartialMessages: true` and reads `stream_event` messages'
  `content_block_delta`/`text_delta` events; `LocalBackend` requests `stream: Boolean(onChunk)` and
  parses the OpenAI-compatible SSE response itself (`response.body.getReader()`), still falling back
  to `reasoning` if `content` stays empty end to end, same as the non-streaming path.
  In `companion.js`, `sendAndPrint` only streams when there's no `onReply` transform - a vault
  auto-summary Submit turn (`onReply` set) always waits for the whole reply, since `extractVaultBlock`
  can only identify and strip the trailing `<<<VAULT_JSON>>>` block once the reply is complete, and
  streaming it live would risk that block (or a fragment of it) reaching the terminal before it's
  known to be strippable - `companion.test.js` has a test asserting a real gap between the delayed
  JSON chunk and the visible reply's arrival, and that `VAULT_JSON` never appears in the output,
  distinct from a separate test proving genuine incremental delivery on the streaming path (both
  matter: a stub that always answers instantly can't tell a real stream from a fast one-shot flush).

- The input area is a small pinned box (a thin rule, then the `>` prompt) that stays the last thing
  on screen, styled/TTY mode only. `bottomRowsShown` tracks how many terminal rows, ending at the
  cursor's current row, the box (or, mid-spinner, its temporary one-line replacement) currently
  occupies; `clearBottomRows()` clears exactly that many before new content is written, and
  `drawBox()` redraws the box fresh afterward, setting it back to 2. `printAboveInput` and every
  streamed reply piece (`sendAndPrint`'s `writeReplyPiece`) go through this same clear/print/redraw
  cycle - throttled to real markdown block boundaries by `createMarkdownStreamer`, not raw network
  chunks, so the box stays visibly pinned through a whole streaming reply without flickering on every
  tiny piece. Consecutive rendered blocks are separated by exactly one blank line in `writeReplyPiece`
  - each piece already ends with its own trailing newline (so the box's rule has a fresh line to
  start on), which accounts for the first half of that blank line, so only one more newline (not two)
  is written before a second-or-later piece; writing two produced a real double-blank-line bug,
  caught live (see below). A turn-boundary flag (`turnBoundaryPending`/`consumeTurnBoundary`) makes
  exactly one blank line separate whole turns from each other too - set at the end of every turn,
  consumed by whichever prints first for the next one (a capture's local ack, or a typed reply's own
  first output), so it's correct regardless of which runs first.

  `drawBox()` redraws via `rl.prompt(true)` alone - readline's own rendering already reflects the
  current line and cursor position correctly on its own, including mid-line edits, confirmed live via
  a minimal probe script. An earlier version additionally did `rl.write(savedLine)` (inherited from
  this feature's very first cut, when it was structurally impossible to trigger): `rl.write()` does
  not just *display* text, it *inserts* it into the buffer at the cursor position - calling it with
  the very text `rl.prompt(true)` had just re-rendered from that same `rl.line` duplicated every
  character on screen (and in the buffer) the moment a keystroke landed in the gap between two box
  redraws, e.g. typing while a reply is streaming in. Also confirmed live: reset `bottomRowsShown = 0`
  at the very top of `rl.on('line', ...)`, before anything else runs - pressing Enter is readline's
  own native handling, and it already finalizes the prompt row as permanent scrollback and moves the
  cursor to a fresh row *before* this listener ever fires, so `bottomRowsShown` from whenever the box
  was last drawn is stale at that point; clearing "that many rows" without resetting first walks
  straight up onto the line just typed and erases it.

  All of the above - the pinned box across a streaming reply, the turn separator, the `rl.write`
  duplication bug and its fix, the `rl.on('line')` stale-row-count bug and its fix, wrapped markdown
  and code-fence rendering, the error path, and readline's own arrow-key/backspace editing continuing
  to work against the box - were verified live, not just by reading the code: a real pty (Python's
  `pty` module, no `node-pty` dependency needed) for a quick first pass, then a real `tmux` pane
  (`tmux capture-pane -p`, which renders ANSI cursor movement/clear sequences the way a real terminal
  would rather than showing their raw escape codes in log order) once the `pty`-only approach turned
  out to be actively misleading for reasoning about multi-step clear/redraw sequences - piped
  `node --test` output never exercises any of this, since none of it runs off a real TTY.
  `ClaudeBackend`'s streaming path itself still has no automated test (matches this file's existing
  backend-coverage gap: only `local` is exercised via subprocess tests) - reasoned about from the
  Agent SDK's own type definitions (`sdk.d.ts`'s `SDKPartialAssistantMessage`), not independently
  live-verified against a real Claude account.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
