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
  reliable support for that in Firefox 128; this extension's `strict_min_version` was 109 at the time this
  was written, since raised to 140 for the AMO submission prep below, which happens to clear that
  threshold too - the injection approach was deliberately *not* rearchitected to match, since it's the
  same proven, live-verified mechanism on both browsers and a version bump elsewhere is no reason to
  rewrite working code) so it runs in the page's MAIN world where `monaco` lives, and talks back to
  `content.js`'s isolated world over
  `CustomEvent`s on `document` (`leetcode-capture:request-code` / `leetcode-capture:code-response`, matched
  by a request id) - both worlds share the same DOM, so no `postMessage` is needed.
  `getEditorCode()` in `content.js` awaits that round-trip (500ms timeout). There is no fallback (the old
  DOM scrape was removed): when the model cannot be read, the Run or Submit is not captured or sent at all
  and the Tutor panel shows "Couldn't read your editor, so the tutor has not seen this code." (a
  `leetcode-capture:editor-read-failed` event from `sendCapture`); a Tutor message then goes without code
  and the companion adds no code update for it (the newest Run does not stand in). Verified live end-to-end with chrome-devtools-axi against a real
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
  fully closed.
- `manifest.json`'s `web_accessible_resources[0].matches` must be a *strictly broader* match pattern than
  `content_scripts[0].matches`, not merely equal to it - PR #16's model-read fix (above) initially shipped
  with both set to the identical string `https://leetcode.com/problems/*`, and that exact pairing made real
  Chrome reject the whole extension at load time ("Invalid value for 'web_accessible_resources[0]'. Invalid
  match pattern.") - confirmed live by loading the real unpacked extension into a real Chrome instance.
  Silent failure mode: the DOM-scrape fallback of that time had zero logging, so the truncation bug PR #16
  was meant to fix kept happening with no visible cause. Fixed by broadening WAR's pattern to
  `https://leetcode.com/*` (the fallback itself is gone now, see above). `extension/content.test.js` asserts WAR's matches strictly cover
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
- The relay server rebuilds its per-problem `attemptSeq` counter from the existing log file on startup. Log format is one JSON object per line at `relay-server/data/captures.jsonl` (gitignored).
  The log is only a delivery queue to the companion and is cleared as it is consumed (`companion/capture-log.js`, `trimCaptureLog` in `server.js`), so a relay restart after a clear counts attempts from 1 again.
  The companion asks (companion-only `POST /panel/trim-captures { before, path }`) to drop the bytes before its own read offset, only between polls, at start, after a problem-switch reset and past `LEETCODE_CAPTURES_TRIM_BYTES` (4 MB).
  The relay refuses a `path` that is not its own log or a `before` not on a line boundary, cuts synchronously (so an append lands wholly before or after) by writing the rest to a temp file and renaming it, and the companion subtracts `removed` from its offset only on a 200.
  A `pendingTrim` (the 256 bytes before the cut) in the companion's state file resolves a crash or lost answer between the cut and the saved offset.
  A later "keep old captures" setting would copy the dropped prefix away inside `trimCaptureLog`. `companion/capture-log.test.js` has the race (a proxy posts captures right before and after the relay cuts).
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
  both typed input and changed Submits (never Runs, see the code-ledger bullet) through a swappable backend (`COMPANION_BACKEND=claude`
  via `@anthropic-ai/claude-agent-sdk`, or `local` via plain `fetch` against an OpenAI-compatible
  endpoint). A capture arriving mid-keystroke never corrupts the in-progress input line - it's
  printed above the prompt and the prompt is redrawn with the saved line/cursor reinserted
  (`printAboveInput` in `companion.js`). See `README.md` → Companion for credentials, setup, and
  the verified behavior difference between the two backends' auth.
- Every backend (companion and extension) shares one tutor persona, `TUTOR_SYSTEM_PROMPT` in `extension/shared/tutor-prompt.js`. For
  the Claude backend, passing it as a plain `systemPrompt` string *replaces* Claude Code's own
  default system prompt rather than appending to it - only the SDK's `{ type: 'preset', preset:
  'claude_code' }` form preserves the default. That's intentional here (no tools, not acting as a
  coding agent over this repo), but is the first thing to check if Claude-backend responses ever
  seem to be missing Claude Code's usual framing.
- The tutor's disclosure policy is in `extension/shared/tutor-prompt.js` (keep the system message at or under 600 estimated tokens) and is checked by `extension/shared.test.js` and the manual `companion/prompt-eval.mjs` model evaluation.
  It answers only the requested question using the student's approach, gives graded hints when asked, gives a full answer on request, and reviews a Submit without unsolicited methods or a guessed LeetCode verdict.
  `problemTags` stay in local vault metadata and do not enter the model context, including when vault auto-summary is enabled.
- The post-check guard (`extension/shared/reply-guard.js`, design in the vault note "Post-Check Guard Design") enforces the prompt rules the code can check, in both runtimes: `tutor-engine.js` and `companion.js` send every turn through `guardedSend` with the student's own words, the Submit trigger and the current code, and publish only what it releases.
  `classifyMessage` picks the turn kind from the student's words; a hint or "I'm stuck" reply is held whole (the panel shows its typing dots), checked, and re-asked once through `reviseLastReply` when broken, then salvaged or replaced by a fallback; chat, alternatives and Submit replies stream sentence by sentence (a code block as one unit) and a unit that breaks a rule is dropped before it shows; answer, code and fix requests stream word by word with repairs only (em dash, spaced en dash, emoji, Unicode arrows, never inside code).
  Nothing shown is ever replaced, and the turn-end text is exactly the streamed text.
  `replaceLastReply` keeps only the shown text in history; `LocalBackend` (so every extension-runtime provider) and `CodexBackend` have both methods, `ClaudeBackend` has neither (its session cannot be edited, so it gets drops and the fallback but no re-ask).
  A held reply past 1.6 times its limit, or opening a code block where none is allowed, is stopped early through `sendMessage`'s `shouldStop`.
  "Named" techniques (allowed) are those in the student's words, their code's signals (a self-calling function names DFS, `= {}` a hash map) or a reply they already saw; the guard's state resets with the conversation.
  A test stub reply that streams one long run-on sentence shows nothing until it ends, and a stub hint that names a data structure is re-asked, so stubs stream whole sentences and valid hints.
  Tests: `extension/reply-guard.test.mjs`, the guard cases in `adapters.test.mjs`, `engine.test.mjs`, `codex-backend.test.js` and `panel-bridge.test.js`, and the guard scenario in `e2e/extension-runtime.e2e.mjs`; `PROMPT_EVAL_GUARD=1 PROMPT_EVAL_ONLY=hard node companion/prompt-eval.mjs` measures it against a real model.
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
  terminal chat is unchanged.
  The per-problem star rating is an LLM judgment, not a verified fact.
  The model receives no LeetCode topic tags, so new topic-index entries keep their existing proficiency line rather than asking the model to score a named topic.
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
- Keyboard-shortcut support for Run/Submit captures: Ctrl/Cmd+' for Run, Ctrl/Cmd+Enter for
  Submit - the reverse of an early draft of this feature. Real leetcode.com couldn't be reached to
  verify directly: Cloudflare's Turnstile bot challenge blocks the automated browser here even after
  upgrading `chrome-devtools-axi` 0.1.29 -> 0.1.32, which was itself required first - 0.1.29's
  `open`/`newpage`/`selectpage` never returned a usable `pageId`, so every `snapshot`/`eval` call
  failed outright, a tool bug unrelated to leetcode.com. Confirmed instead via external research: a
  2024/2025 leetcode.com/discuss thread ("[Ctrl]+[Enter] hotkey annoyed") describes real users
  hitting accidental submissions from Ctrl+Enter while typing (LeetCode's own native Submit
  binding), and the well-established third-party "LeetCode Shortcuts" Chrome extension (built to
  restore what LeetCode's own site removed in Sept 2019) uses Ctrl+' for Run. `matchesRunShortcut`/
  `matchesSubmitShortcut` in `content.js` mirror `matchesRunButton`/`matchesSubmitButton`'s
  testable-pure-function style. The keydown listener is bound on `document` in the capture phase
  (same as the click listener) so it observes the event before Monaco's own internal keybinding
  service can `stopPropagation()` it - live-verified against a local page with a nested element
  doing exactly that. Because Ctrl+Enter is believed to already be LeetCode's own native Submit
  action, the listener never calls `preventDefault()`/`stopPropagation()` on either shortcut - it's
  purely additive, like the click listener. The resulting double-capture risk (LeetCode's native
  Ctrl+Enter handler possibly performing a real synthetic click on the Submit button internally,
  which would then also match `matchesSubmitButton` and fire a second capture) is closed by
  `isDuplicateCapture`, a mechanism-agnostic 300ms per-trigger dedup guard inside `sendCapture`
  itself, rather than by trying to detect LeetCode's actual internal mechanism, which couldn't be
  confirmed live either. Live end-to-end verification used this project's established local-fake-page
  fallback (see the WAR/matches bullet above): a static page under a `/problems/<slug>/` path (so
  `getProblemSlug()` resolves) served over `python3 -m http.server`, the unmodified `content.js`
  loaded via `<script src>`, a `.monaco-editor`/`.view-lines` DOM fake, and a nested focusable
  element with its own capture-phase `stopPropagation()` keydown listener standing in for Monaco -
  confirmed via a real relay server receiving exactly one correctly-shaped capture per shortcut
  press with focus both inside and outside that element, and confirmed the dedup guard collapses a
  simulated native-handler synthetic click into exactly one capture rather than two.
  A second, initially-missed double-capture path: browsers fire repeated `keydown` events
  (`event.repeat === true`) for as long as a key combo is held - an initial ~500ms delay, then
  repeats every ~30-50ms - and that first repeat lands *outside* `isDuplicateCapture`'s 300ms
  window (which only catches the fast repeats once they start), so briefly holding Ctrl+Enter/Ctrl+'
  down produced a second real capture. Fixed by excluding `event.repeat` directly in
  `matchesRunShortcut`/`matchesSubmitShortcut`, so only the genuine initial press ever matches.
  Live-confirmed both ways with a simulated held-key sequence (real timing: initial press, then
  repeats starting at 500ms): reverting the `!event.repeat` check reliably reproduced 2 captures
  from one held-down press, restoring it brought it back to 1, for both shortcuts.

- `companion/terminal-format.js` owns companion.js's CLI-look styling: a `>` prompt marker, a `•`
  marker opening a tutor reply turn (`turnMarker`, replacing an earlier "tutor" role-label/framing-rule
  design - no per-speaker labels any more), dimmed `companion: ...` status/error lines, and markdown
  rendering via `marked`/`marked-terminal`. Both the box rule and markdown wrap share one width source,
  `contentWidth()` (`process.stdout.columns || 80`) - the real terminal width exactly, with no upper cap
  at all. This used to be a fixed ~80-column target regardless of how wide the terminal actually was
  (`COMFORTABLE_WIDTH`) - changed after Thomson reported the width "not tracking the window": confirmed
  live the resize *handling* below was never broken, the fixed target itself was the actual complaint (a
  100+ col terminal still rendered an 80-col rule with visible unused space to its right). First raised to
  a 120-col ceiling (`MAX_CONTENT_WIDTH`), then dropped entirely at Thomson's request - a fullscreen
  monitor is often 200-300+ columns, and 120 still read as capped - so there is deliberately no readability
  ceiling here any more; the `|| 80` only covers a terminal that hasn't reported a column count at all.
  That width tracks a live terminal
  resize: `boxRule()` re-reads `process.stdout.columns` on every call, so the box's own rule updates the
  instant it's next redrawn, but `marked-terminal`'s renderer is registered once against a snapshot width
  via `marked.use(...)` - `refreshWidth()` re-registers it with the current width, and `companion.js` calls
  it from a `process.stdout.on('resize', ...)` listener so markdown rendered after a resize wraps to the
  new size rather than whatever was current at import time. `companion/companion.test.js`'s two
  width-resize tests fire a real `process.stdout.emit('resize')` against a fake-TTY-wrapped real
  `companion.js` subprocess (idle, and mid-stream/`turnActive`) and replay the output through
  `virtual-terminal.js` to assert the rendered rule width, rather than calling `terminal-format.js`'s
  exports directly (that unit-level coverage lives in `terminal-format.test.js`) - verified live over a
  real `tmux` pane too, per this file's own bar for this class of bug (see below). A separate module
  specifically so the styling decision (TTY or not, `NO_COLOR` or
  not) is computed
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

- The input area is a small pinned box (a blank breathing-room line, a thin rule, then the `>` prompt -
  see the box-height/margin bullets further down for both) that stays the last thing on screen,
  styled/TTY mode only. `reservedBottomRows()` computes how many terminal rows, ending at the cursor's
  current row, are currently occupied by whatever's reserved at the bottom (the box - its own row count
  computed fresh via `promptRowCount()`, not cached, since a long typed line can wrap it to more than one
  row - or the 1-row spinner, tracked via `boxShown`/`bottomRowsShown`; see below for why); `clearBottomRows()`
  clears exactly that many before new content is written, and `drawBox()`/`drawBoxRaw()` redraw the box
  fresh afterward. `printAboveInput` and every streamed reply piece (`sendAndPrint`'s `writeReplyPiece`)
  go through this same clear/print/redraw
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

  `turnActive` is true for the duration of one `sendAndPrint` call, tracking whether it's safe to force
  an immediate box redraw outside the normal print flow - used by the `process.stdout.on('resize', ...)`
  listener (see `refreshWidth` above): idle, `boxShown` unambiguously means "the box" (its own current
  height computed fresh via `promptRowCount()` - see below, no longer a fixed row count), so a resize can
  just clear and redraw it on the spot; mid-turn it might mean "a 1-row spinner" instead at any given
  moment, and forcing a box redraw there would corrupt whatever the turn's own writes are tracking - so
  mid-turn a resize only updates the width for what gets drawn *next*, verified live by resizing a `tmux`
  pane twice in the middle of a streaming reply and confirming no corruption, just the final box landing
  at the terminal's width by the time the reply finished.

  `drawBox()` redraws via `rl.prompt(true)` alone - readline's own rendering already reflects the
  current line and cursor position correctly on its own, including mid-line edits, confirmed live via
  a minimal probe script. An earlier version additionally did `rl.write(savedLine)` (inherited from
  this feature's very first cut, when it was structurally impossible to trigger): `rl.write()` does
  not just *display* text, it *inserts* it into the buffer at the cursor position - calling it with
  the very text `rl.prompt(true)` had just re-rendered from that same `rl.line` duplicated every
  character on screen (and in the buffer) the moment a keystroke landed in the gap between two box
  redraws, e.g. typing while a reply is streaming in.

  `rl.on('line', ...)` handles Enter specially depending on whether the submitted text is empty.
  Pressing Enter is readline's own native handling, and it *always* finalizes the prompt row as
  permanent scrollback and moves the cursor to a fresh row before this listener ever fires - for a
  non-empty submission that's correct (Thomson's own message belongs in permanent history), so the
  listener just resets the now-stale `bottomRowsShown` to 0 before the reply's own
  printAboveInput/box calls run (clearing "that many rows" without resetting first would walk
  straight up onto the line just typed and erase it). For an *empty* submission, that same committed
  row is unwanted - naively calling `drawBox()` there draws a whole new rule+prompt under the
  leftover blank row instead of reusing it, so every empty Enter permanently grew the screen by two
  lines and duplicated the rule (meant to be the single, unique break between chat history and the
  live input) once per press. Fixed by reclaiming that row instead (`moveCursor`/`clearLine` up one,
  then `rl.prompt(true)`, no new rule) - the rule row above was never touched by readline's own
  handling and is already correct, so the box ends up looking exactly as it did before Enter was
  pressed, not just similar to it.

  The whole program also runs inside the terminal's alternate screen buffer (`\x1b[?1049h` on
  startup, `\x1b[?1049l` in a `process.on('exit', ...)` handler registered in the same breath, TTY
  only) - the same mechanism vim/less/htop use, entered as early as possible (right after imports) so
  even the relay-server-lifecycle console.log lines land inside it. Without this, the shell's prior
  scrollback stayed visible above the box while the companion ran, and exiting left the whole
  session's output sitting in the terminal's normal scrollback instead of returning to exactly what
  was on screen before. The `rl.on('close')` handler's old "companion: goodbye" line was removed for
  the same reason - it would never be seen (the alt-screen restore fires synchronously right after
  `process.exit()`), so printing it only worked against "exiting restores exactly what was there
  before."

  A real consequence of the alternate screen buffer: most terminals (confirmed for kitty, the one in
  use here - `TERM=xterm-kitty`) automatically enable "alternate scroll mode" (DECSET 1007) the moment
  it's active, translating a mouse wheel notch into an Up/Down arrow keypress instead of native
  scrollback, on the theory that a full-screen app will handle its own scrolling with the arrow keys
  it already reads. Readline has no idea this is happening - it just sees an arrow key, which is also
  its own binding for cycling through previously-typed input lines, so scrolling the wheel to read
  back through the conversation instead silently replaced whatever was in the prompt with an old
  typed message. Fixed by explicitly disabling 1007 (`\x1b[?1007l`, sent once alongside entering
  1049h) - though what the wheel does *instead* (native alt-screen scrollback, if the terminal has
  one, or nothing at all) is then up to the terminal, not something controllable from here, and most
  terminals' alt-screen buffers don't retain scrollback past the current screen's height regardless,
  which is *why* Page Up (below) exists rather than relying on 1007 alone to fully solve this.

  Every line of actual conversation content - captures, replies, warnings, errors, and (recorded
  directly in `rl.on('line', ...)`, since readline's own echo never goes through any of these) typed
  messages - is also appended, verbatim with ANSI codes intact, to a capped-by-character-count
  `historyBuffer`, in addition to being printed live. This is the durable record of anything that's
  scrolled off screen, since (as above) the alternate screen buffer has no native scrollback of its
  own past one screen in most terminals. Page Up opens it in a real pager (`spawnSync('less', ['-RX'],
  { input: historyBuffer.join(''), stdio: ['pipe', 'inherit', 'inherit'] })`) rather than a hand-rolled
  scroll view - `less` already gets wrapping, search, and its own Page Up/Down exactly right, which a
  from-scratch implementation would have to earn the hard way. `-X` specifically disables `less`'s own
  terminal init/deinit (its own alternate-screen enter/exit) - without it, `less` entering *its own*
  alternate screen while this program is already in one, then leaving it, would drop the terminal
  straight back to the *normal* buffer instead of back to this program's own alternate screen, since
  1049 isn't a stack. With `-X`, `less` paints directly into the screen this program already owns, and
  `stdio: ['pipe', 'inherit', 'inherit']` (piped stdin carrying the content, but real terminal-attached
  stdout/stderr) is what makes its scrolling/search interactive rather than just dumping the content.
  `spawnSync` does not throw for a missing `less` binary - it returns normally with `.error` set, which
  is what's actually checked, not a `try`/`catch`. Ignored (via the `turnActive` flag above) while a
  turn is active, since spawning a pager on top of an in-progress spinner or streamed piece would
  corrupt both.

  All of the above - the pinned box across a streaming reply, the turn separator, the `rl.write`
  duplication bug and its fix, the empty-Enter row-duplication bug and its fix, the alternate-screen
  behavior, Page Up opening `less` with the full conversation (including confirming real overflow
  scrolling within `less` itself with a conversation deliberately longer than the terminal, that it's
  correctly ignored mid-turn, and that returning from it leaves readline's own arrow-key input-history
  navigation - a *different* key from Page Up/Down, confirmed by directly probing Node's keypress
  parser - working exactly as before), wrapped markdown and code-fence rendering, the error path, and
  readline's own arrow-key/backspace editing continuing to work against the box - were verified live,
  not just by reading the code: a real pty (Python's `pty` module, no `node-pty` dependency needed) for
  a quick first pass, then a real `tmux` pane (`tmux capture-pane -p`, which renders ANSI cursor
  movement/clear sequences the way a real terminal would rather than showing their raw escape codes
  in log order) once the `pty`-only approach turned out to be actively misleading for reasoning about
  multi-step clear/redraw sequences - piped `node --test` output never exercises any of this, since
  none of it runs off a real TTY.
  `ClaudeBackend`'s streaming path itself still has no automated test (matches this file's existing
  backend-coverage gap: only `local` is exercised via subprocess tests) - reasoned about from the
  Agent SDK's own type definitions (`sdk.d.ts`'s `SDKPartialAssistantMessage`), not independently
  live-verified against a real Claude account.

- What the tutor is sent, and the reset on a problem switch, live in `extension/shared/code-ledger.js` (pure, no Node API, so the
  extension's background runs it too; `extension/shared.test.js` checks that). A Run is only recorded, never sent.
  A Submit is sent only when its code differs from what the tutor holds. A typed message leads with a numbered diff
  (`formatDiffBody` in `context-budget.js`) against the held code, or the full code when nothing is held or the diff
  passes 80% of the code. The held code advances only on `commit()` after a successful backend call, and is memory only.
  Panel messages carry a live editor `snapshot` (content.js reads the Monaco model only); one without it goes with no
  code update and a note to the tutor that the editor could not be read. Terminal messages, which have no editor to
  read, use the newest Run or Submit. Caps: 256 KB per message body, 100,000 characters
  of snapshot code, 50,000 of description (`panel-broker.js`, mirrored in `panel.js`'s `buildMessageBody`, which drops the
  description and then the whole snapshot rather than send a body past them, and never truncates code). Every capture, message and reset runs inside
  `queueTurn`, so a reset never lands mid-request. A message, Run or Submit on another problem (with
  `COMPANION_AUTO_CLEAR_CONTEXT` on, the default) calls the backend's `resetContext()`, drops the old problem from the
  ledger, asks the relay to drop its buffered chat (companion-only `POST /panel/drop-problem`) and clears the handled
  part of `captures.jsonl` (see the `attemptSeq` bullet).
  Its panel notice carries `switch: true` (the relay keeps only that flag), and on it every open panel drops all its transcripts, so the screen matches what a reload replays.
  The notice is held back until something follows it (`visibleItems`), since a Run shows nothing else, and a panel on any other problem shows only "Another problem is active now" (`state.activeProblem`), never which one or its chat.
  A Run or Submit on the problem already active publishes no notice. `extension-runtime.e2e.mjs` checks this with two tabs, `panel-render.e2e.mjs` over the relay transport.
  `LocalBackend` pins the held code as a system message (like the description) so condensing old exchanges cannot
  lose it, and an older full-code turn is sent as its `compactContent`. `ClaudeBackend` needs no pinning: its resumed
  session keeps the first full code and later diffs. `companion/code-updates.test.js` covers the rules end to end.
- Real mouse-wheel scrolling inside the alternate screen: `companion/mouse-input.js` enables xterm's
  SGR mouse-reporting mode (`\x1b[?1000h\x1b[?1006h`, disabled on exit alongside `1049l`) and parses the
  `\x1b[<Cb;Cx;Cy;M`/`m` reports it produces, calling back with `'up'`/`'down'` for a wheel notch (bit 6
  of `Cb`, value 64, distinguishes a wheel report from an ordinary click regardless of modifier bits; bit
  0 then picks the direction) and swallowing every other mouse report (clicks, releases - motion tracking
  is never enabled, so those are the only kinds that can arrive). This has to happen *before* readline
  ever sees the bytes: readline's own keypress decoder has no notion of the SGR protocol and, confirmed
  live, shreds a mouse report into a run of single-character keypresses that its own line editor then
  inserts into whatever's being typed. `companion.js` wires this up by giving readline a filtered
  `PassThrough` (`filteredStdin`) instead of `process.stdin` directly, in real-terminal mode only - every
  byte that isn't part of a wheel report passes through unchanged, so readline's line editing, arrow-key
  history, Ctrl+C, and Page Up detection are all unaffected; the Page Up keypress listener has to attach
  to `filteredStdin`, not `process.stdin`, since that's where readline's decoder (and therefore
  `'keypress'` events) actually live once this wiring is in place. Since `filteredStdin` isn't a TTY,
  readline never auto-manages raw mode for it the way it did for `process.stdin` directly - `companion.js`
  now calls `process.stdin.setRawMode(true)`/`(false)` itself, paired with entering/leaving the alternate
  screen. `historyBuffer` (already recorded for Page Up/`less`, see above) now also backs a real
  application-level scrollback: `scrollOffset` (lines up from the live bottom) plus `redrawViewport()`
  paint a windowed slice of it, replacing the old `redrawLiveTail`. Wheel events are ignored outright
  while a turn is active (mid-turn, `boxShown` is false and `bottomRowsShown` can mean a 1-row spinner
  rather than a settled box, and a full-screen redraw there would corrupt it) - not suppressed and reconciled later, simply
  ignored, same as Page Up already was. The complementary rule (`resetScrollIfNeeded`, called first thing
  by both `handleCaptureLine` and `sendAndPrint`) is what keeps that safe: any new activity - a capture or
  a typed message - always snaps the view back to the live bottom before it writes anything, which is what
  lets every existing rendering function (`printAboveInput`, the streaming writer, the spinner) stay
  completely unmodified and unaware scrolling exists at all. Page Up/`less` was kept, not removed, now
  reasoned about as "open the same history in a real pager" (search, unbounded scroll speed, and it works
  on a terminal without SGR mouse support) rather than the wheel's only fallback; mouse tracking is
  disabled for the duration of the `less` call and re-enabled after (`showHistory` in `companion.js`) since
  it's a terminal-wide mode, not scoped to a file descriptor, and `less` reads its own keyboard input
  directly from `/dev/tty`, bypassing this process's stdin entirely. Verified live over a real pty (mouse
  enable/disable framing on startup/`/exit`) and `tmux` (`send-keys -H` to inject raw SGR bytes exactly as
  a real terminal would, `capture-pane -p` to read back the rendered screen): wheel-up/down scrolling
  through several turns and clamping at both ends, a resize while scrolled reflowing the viewport, a
  capture/typed-message snapping the view back to live mid-scroll with no corruption, wheel events during
  an active turn being silently ignored (spinner keeps animating undisturbed) and scrolling resuming once
  the turn ends including via its error path, Page Up/`less` still opening and returning cleanly with mouse
  tracking correctly restored, empty-Enter and normal typing unaffected, and `/exit` leaving the shell
  exactly as before - its prior scrollback intact, no raw-mode/mouse-mode bleed - confirmed by a plain
  shell command executing normally immediately after exit. `companion/mouse-input.test.js` covers the
  byte-level parser in isolation (split-chunk sequences, UTF-8 byte-fidelity round-tripping, the
  never-buffer-forever fallback) without needing a TTY; the short idle-flush timer that unblocks a lone,
  unrelated Escape keypress (see the file's own header) is reasoned about rather than covered by a
  deterministic test, to avoid a timing-flaky one.

- The box is pinned to the terminal window's actual last row(s), not to the bottom of whatever's been
  printed so far - the distinction only shows up when content hasn't yet filled the screen (right at
  startup is the easiest repro): before the fix, `drawBox()` just wrote at the cursor's current
  position, which floated mid-screen with blank space left *underneath* the box instead of above it.
  Originally fixed with a one-shot `padToBottomIfNeeded()` padding call, latched via `screenFilledToBox`
  after its very first draw - which turned out to be a second, worse bug (see the next bullet), so that
  function no longer exists; `redrawViewport()` (below) is now the only thing that ever pads.
  Verified live via a sized `tmux` pane (`new-session -x -y`, `capture-pane -p`, `send-keys -H` for raw
  SGR wheel bytes) across: startup on a window much taller than the banner, a streaming reply, a resize
  both shorter and taller (including mid-turn), scroll-back-to-live, Page Up/`less` open and return, and
  `/exit` restoring the shell's own scrollback untouched.

- Chat content must grow from the *top* of the screen like ordinary scrollback, with the box's own
  padding shrinking to make room - not chat clustering next to the box at the bottom while real content
  (even the startup banner) silently disappears off the top. This was `padToBottomIfNeeded`'s one-shot
  latch (above) compounding into a second bug: after its first call, `screenFilledToBox` was set `true`
  *unconditionally*, so every later incremental redraw (`clearBottomRows` + print + `drawBox`) skipped
  padding entirely and wrote new content immediately adjacent to the box - which, since the box is
  pinned to the terminal's actual last row, always meant writing right at that row. That forces a real
  terminal scroll on *every single redraw* (there's nowhere left to print a trailing newline without
  overflowing the last row), silently dropping exactly one row off the *top* of the screen each time,
  even while genuine blank padding sat untouched elsewhere. Confirmed live: a short conversation in a
  tall window showed the startup banner (and even earlier captures' own replies) scrolled away within a
  couple of exchanges, despite acres of unused blank space still on screen - and a single wheel-scroll
  tick "snapped" the broken layout to correct, because `redrawViewport()` (used for resize/wheel-
  scroll/Page-Up-return) was already doing a full repaint from `historyBuffer` - the true, never-lost
  record of everything printed - independent of whatever the physical screen had been scrolled into.
  Fixed by making `drawBox()` a phase-aware dispatcher: while the screen hasn't genuinely filled with
  real content yet (`screenFilledToBox` false), *every* redraw goes through `redrawViewport()`'s full
  `\x1b[2J\x1b[H` repaint (bounded cost - at most `visibleRows` lines, not the whole conversation) rather
  than the fast incremental path; `screenFilledToBox` now only latches `true` once `historyLines().length
  >= currentVisibleRows()` genuinely, in both `redrawViewport()` and the (now-unreachable-until-filled)
  fast path, never unconditionally. `drawBoxRaw()` is the shared "just paint the box at the current
  cursor position" primitive both branches end on. Verified live over the same sized-`tmux`-pane
  technique as the previous bullet, specifically: several real captures in a tall window with the banner
  and every earlier turn staying visible and in top-to-bottom order, wheel-scroll and resize no longer
  needed to "fix" a short conversation's layout, and natural scrolling correctly taking back over once
  the screen genuinely fills. `companion/box-padding.test.js` covers both bugs with a real companion.js
  subprocess (a tiny wrapper fakes `process.stdout.isTTY`/`rows`/`columns` before dynamically importing
  companion.js, matching `terminal-format.test.js`'s existing trick) - it can't verify real-terminal
  *rendering* of cursor-positioning escapes (see the pty/tmux note above for that gap), but a
  `\x1b[2J\x1b[H`-delimited "only look at the most recent full repaint" helper (`finalScreenLines`) lets
  it prove line ordering/survival and padding math directly from the raw captured output, without a
  terminal.

- The box always has one guaranteed blank breathing-room line directly above its rule, and both the
  rule and the prompt share a consistent one-space left margin (`drawBoxRaw`'s own leading `\n`;
  `boxRule`/`promptString`/`spinnerFrame` in `terminal-format.js`) - a deliberate visual-spacing pass
  distinct from the padding bugs above: that blank line is now *structural*, part of the box itself
  (`currentVisibleRows()` reserves space for it unconditionally), not something that happened to be left
  over from padding and would vanish once the screen genuinely filled and natural scrolling took over.

- `bottomRowsShown` (how many rows `clearBottomRows` clears before a redraw) is not simply "the box is
  always 2 rows" any more - a typed/pasted line long enough to soft-wrap changes how many physical rows
  the prompt itself occupies, and that can change from one redraw to the next independent of anything
  this file's own drawing code does (readline updates its own on-screen prompt on every keystroke, with
  no call into any of `drawBox`/`clearBottomRows`). `promptRowCount()` derives the prompt's current row
  count fresh, on demand (`Math.ceil((plain prompt length + rl.line.length) / columns)`, min 1) rather
  than caching it; a `boxShown` boolean (as opposed to a bare row count) tracks whether the *box itself*
  - as opposed to the 1-row spinner, or nothing - is what's currently occupying the reserved bottom
  rows, since only the box's height is dynamic this way. `currentVisibleRows()` also reserves space for
  the current `promptRowCount()`, so a long typed line correctly shrinks how much of the screen is left
  for chat content rather than the box's extra wrapped row silently overlapping it.

- A capture (or a typed reply) arriving while a long typed line wraps the prompt to 2+ rows used to
  corrupt everything printed earlier in that turn - and even earlier turns - once `promptRowCount()`
  (above) existed and was correct: the row-*counting* math wasn't the bug. The actual root cause is
  node's `readline` Interface tracking its own internal `prevRows` (an undocumented but stable,
  directly-readable property - confirmed empirically by dumping `readline.Interface.prototype
  [kRefreshLine].toString()`, not just inferred): `rl.prompt(true)` internally moves the cursor *up* by
  `rl.prevRows` first (to reach what it believes was the start of its own last multi-row render), then
  `clearScreenDown()`s from there before redrawing. That's only correct if readline is the *only* thing
  that's touched the terminal since its own last render - but it isn't: `clearBottomRows` already
  repositions the cursor independently, using this file's own row math, before every redraw. Once the
  prompt wraps to more than one row, readline's stale `prevRows` (left over from the *previous* render
  of that same long line) makes `rl.prompt(true)` move the cursor further up than it should - straight
  into content `clearBottomRows` never touched (an earlier turn's own ack/label lines) - and erases it
  with `clearScreenDown()` before redrawing the box there instead. Invisible before `promptRowCount()`
  existed, because a single-row prompt never needs `_refreshLine`'s upward move at all (`prevRows` was
  always effectively 0). Fixed by resetting `rl.prevRows = 0` immediately before every `rl.prompt(true)`
  call in `drawBoxRaw()`, so that upward move is always a no-op and readline just clears from the
  cursor's actual current position (already correctly placed by `clearBottomRows`) downward. Confirmed
  live in a real `tmux` pane: filled the screen with several captures (forcing the fast incremental
  path, not `redrawViewport`'s full repaint), typed/settled a line long enough to wrap to 3-4 rows, then
  sent another capture - before the fix, that capture's own ack/label vanished and the box's blank+rule
  disappeared too; after the fix, everything survives in order. `companion/box-corruption.test.js`
  covers this with `companion/virtual-terminal.js`, a small ANSI escape interpreter scoped to exactly
  what companion.js/readline emit (`moveCursor`/`cursorTo`/`clearLine`/`clearScreenDown`/full-clear;
  private-mode toggles and SGR ignored) - this specific bug can't be caught by a plain text/line search
  over the raw output (`box-padding.test.js`'s technique, sufficient for the padding-math bugs above):
  the erased text's bytes are still sitting earlier in the raw stream, just followed by escape codes
  that would make a real terminal stop showing them, so only replaying those escapes against a real
  cursor/grid - the same ground truth `tmux capture-pane -p` already established live - can tell "still
  on screen" apart from "already erased." Verified the test itself actually detects the bug (not just
  passes coincidentally) by reverting the `rl.prevRows = 0` fix and confirming it fails.

- An unbroken long token (a URL, a long identifier) in a reply has no whitespace for marked-terminal's
  `reflowText` to break on - confirmed live and via `terminal-format.test.js` that marked-terminal
  already hard-wraps it to the comfortable width rather than letting it overflow, so no fix was needed
  there; `refreshWidth()`'s live-resize re-registration was independently confirmed live to pick up a
  narrower/wider terminal correctly for replies rendered *after* the resize (already-rendered older
  content keeps its old wrap width baked in as literal text, a known, unchanged characteristic - see
  `redrawViewport`'s own doc comment).

- `LocalBackend`'s empty-`content`-falls-back-to-`reasoning` logic (see the bullet above) had a second,
  worse failure mode until `resolveReplyText` (shared by `sendMessage` and `streamReply`) fixed it: that
  fallback was built for a model that puts its whole *finished* answer in `reasoning` on a normal turn
  (`finish_reason: "stop"`) - it did not distinguish that from a response cut off *before* the model
  ever finished thinking (`finish_reason: "length"`), where `reasoning` is a raw, incomplete scratchpad,
  not an answer. Printing that verbatim is exactly "the LLM's own thinking process shown as if it were
  the tutor's actual reply" - confirmed live against the real Ollama `gemma4:26b` model this companion
  is configured for: a big-enough Submit capture (long code, long problem description, and/or several
  turns of resent history piling up - `LocalBackend.history` is resent in full every turn with no
  trimming) eats most of Ollama's default 4096-token context window for this model, and the model gets
  cut off mid-`<think>` with `content` still empty. Also confirmed live: neither a top-level `num_ctx`
  field nor a nested `options.num_ctx` field is honored by this Ollama version's (`0.32.9`)
  `/v1/chat/completions` endpoint - only its native `/api/chat` endpoint honors `options.num_ctx` - so
  raising the context window isn't available through the OpenAI-compat endpoint `LocalBackend` uses.
  `resolveReplyText` now only takes the `reasoning`-fallback path when `finishReason !== 'length'`;
  on a truncated, content-empty response it throws a distinct, clearly-worded error instead (surfaced
  via the existing `companion: error talking to backend` line), and `sendMessage` pops the dangling user
  turn on that throw the same way it already did for its other error paths. `companion.test.js` covers
  this with a stub `finish_reason: "length"` response, verified live to actually fail (not just pass
  coincidentally) when the `finishReason` gate is disabled - a real end-to-end run against the actual
  Ollama backend with an oversized capture reproduces the original leak and confirms the fix, and a
  normal-sized capture's clean reply is unaffected. That first fix only checked `finishReason` in the
  *empty*-`content` branch: `resolveReplyText`'s `if (trimmedContent) return trimmedContent;` still ran
  unconditionally before it, so a response that got cut off *after* already writing some real, non-empty
  `content` was returned as a normal successful reply instead of raising the same cutoff error - a
  narrower but real gap, code-reviewed rather than live-forced (20+ live trials never produced a
  non-empty-but-truncated response). Fixed by moving the `finishReason === 'length'` check ahead of the
  `trimmedContent` early return, covering both fields. The regression test for this
  (`companion.test.js`, "non-empty content" case) cannot assert the partial text never reaches the
  terminal the way the empty-content case's test does: `streamReply` calls `onChunk` with each
  `delta.content` piece live, as it arrives over SSE, before `finishReason` is known at all - genuine
  streaming behavior, out of scope to change here. What the test asserts instead is the actual bug/fix
  boundary: the turn ends via the `companion: error talking to backend ... cut off before finishing`
  path rather than completing silently with no error line.

- Two padding/spacing changes matched against a Claude Code CLI transcript's own look: a hanging indent
  for wrapped reply lines, and a blank breathing-room row below the input box's prompt (symmetric with
  the existing one above the rule). Both needed more than a formula change to actually hold up under
  live terminal rendering - see the PR that introduced them for a `tmux capture-pane` comparison.
  - Hanging indent: `terminal-format.js`'s `indentContinuation(text, { indentFirstLine })` indents every
    line after the first by `TURN_MARKER_WIDTH` (2 - `turnMarker()`'s bullet-plus-space) spaces, so a
    reply's wrapped/continuation lines align under where the text starts after the bullet instead of
    wrapping back to column 0. `companion.js` applies it in both the streaming path (`writeReplyPiece` -
    `indentFirstLine: wroteMarker`, since only the very first piece's own first line sits flush against
    the marker) and the non-streaming path (whole reply, `indentFirstLine` default `false`).
    `configureMarkedTerminal()`'s registered width is narrowed by that same `TURN_MARKER_WIDTH` so an
    indented line still fits the terminal instead of overflowing past it by 2 columns - safe to apply
    unconditionally there since `renderMarkdown`/`createMarkdownStreamer` are only ever used for replies,
    which always carry this indent. Blank lines are left un-padded (no trailing whitespace on what reads
    as an empty separator row).
  - Blank row below the prompt: `currentVisibleRows()` reserves one more row (`rows - 3 -
    promptRowCount()`, not `- 2 -`) so the box's bottom pins one row higher than the terminal's actual
    last row. Reserving that extra row in the row-count math alone is *not* sufficient on its own -
    confirmed live (and caught first by `box-padding.test.js`'s own steady-state test before it ever
    reached a real terminal): once the screen has genuinely filled and natural terminal scrolling takes
    over (`screenFilledToBox`), any content overflow always re-pins the last-written row to the
    terminal's true last row regardless of earlier row-count bookkeeping, silently undoing the
    reservation on every subsequent incremental redraw. `drawBoxRaw()` now actively re-reserves the row
    on *every* call: right after writing the blank-line-plus-rule and before rendering the prompt
    (`rl.prompt(true)`) - while the cursor sits at an unambiguous position, column 0 of the prompt's own
    first row - it writes `promptRowCount()` plain `'\n'` characters (forcing a scroll if already at the
    terminal's bottom margin; a relative cursor-down move, e.g. `readline.moveCursor` with positive `dy`,
    does *not* scroll, it just clamps uselessly at the last row - confirmed via `virtual-terminal.js`'s
    own CSI-`B` handling, which explicitly clamps rather than scrolls), clears the resulting row
    (guarding against stale content from a taller previous draw at that spot, e.g. after a resize), then
    moves back up the same count and `cursorTo(0)`. Doing this *before* `rl.prompt(true)` rather than
    after (relative to wherever it leaves the cursor) sidesteps having to know precisely where within a
    multi-row wrapped prompt the cursor ends up (e.g. mid-line editing after arrowing left) - genuinely
    ambiguous from there, unlike the prompt's known first-row starting position.
    `reservedBottomRows()`/`clearBottomRows()` deliberately keep counting only "the rule plus the
    prompt" rows (at and above the cursor) - the reserved row sits below the cursor and was never part
    of that upward-clearing count, so those two didn't need to change. A long typed/pasted line that
    wraps the prompt past 1 row can still eat into (or past) this reserved gap - readline manages its
    own multi-row prompt rendering entirely independently of `drawBoxRaw` on every keystroke (see the
    `promptRowCount`/`prevRows` bullets above), so there's no hook to re-run the reservation dance
    mid-typing; this is graceful degradation, not a regression, and the gap reappears on the next real
    `drawBoxRaw` call (e.g. once Enter shrinks the prompt back down) - confirmed live.
  - `box-padding.test.js`'s two tests that used to do a raw-byte-line-split (`finalScreenLines`, since
    removed) now use `virtual-terminal.js`'s `replayToScreen` instead, like the file's other tests
    already did: `drawBoxRaw`'s new reservation maneuver writes real cursor-repositioning bytes during
    the fill-phase full repaint too (not just the steady-state incremental path), which a naive line
    split can't interpret correctly.

- `LocalBackend.history` used to grow without bound (see the older bullets above on
  `resolveReplyText`) - a long single-problem conversation (several Run/Submit captures on the same
  problem, so `COMPANION_AUTO_CLEAR_CONTEXT`'s full reset never fires) kept resending every prior
  turn until it exhausted a small local model's context window, confirmed live to actually happen -
  not just theorized - against the real Ollama gemma4:26b model on a real machine (also
  re-confirmed there, live, that this Ollama version's `/v1/chat/completions` endpoint still
  doesn't honor `num_ctx` - loaded context stayed pinned at 4096 regardless of what was passed -
  while its native `/api/chat` does, confirmed via `ollama ps`'s own CONTEXT column jumping to
  match a passed `options.num_ctx`). Switching `LocalBackend` to `/api/chat` wasn't taken even
  though it would fix this too: it's Ollama-specific (breaks the "any OpenAI-compatible server"
  portability `COMPANION_BASE_URL` is documented for), uses a different streaming wire format
  (newline-delimited JSON, not this file's SSE parsing), and only moves the ceiling rather than
  removing the unbounded-growth root cause. Fixed instead with `LocalBackend.trimHistory()` (since replaced by condensing, see the context-window bullet)
  (`COMPANION_LOCAL_MAX_HISTORY_TURNS`, default 6, 0 disables it): drops the oldest complete
  user+assistant pairs once history holds more than that many, called only right after
  `sendMessage` pushes a successful assistant reply - never mid-turn, and never on an error path
  (which already pop the dangling user message first) - so history is always in well-formed
  `[system, user, assistant, ...]` shape when it runs and a trim can never cut a turn in half.
  `companion/companion.test.js`'s `startExhaustionStubBackend`/`runManyTurnsScenario` reproduce the
  real failure deterministically (a stub that starts responding with a truncated
  `finish_reason: "length"` reply once a request's total message content crosses a size threshold,
  the same shape `resolveReplyText` already handles) and confirm trimming prevents it under the
  same repro - verified live that the "trimming enabled" test actually fails (not just passes
  coincidentally) with `trimHistory` reverted to a no-op.
- `ClaudeBackend` does not hit an analogous practical exhaustion failure, confirmed rather than
  assumed from the architecture difference (`options.resume` vs. a hand-resent array): a live SDK
  call's own `result` message reports `modelUsage['claude-sonnet-5'].contextWindow: 1000000` - about
  244x the local Ollama model's 4096-token default - and `COMPANION_AUTO_CLEAR_CONTEXT` already caps
  growth to one problem's own conversation regardless, so a realistic tutoring session (a handful of
  Run/Submit captures) comes nowhere close. What *is* real and measured: `ClaudeBackend.sendMessage`
  never restricted `tools`/`mcpServers`/`settingSources`, so the Agent SDK's defaults ("load
  everything") apply - a live call with this file's exact options shape (custom `cwd`, a plain-string
  `systemPrompt`, nothing else set) carried ~12,500 tokens of pure overhead unrelated to the tutor
  conversation: the SDK's ~25 built-in tool definitions (Task, Bash, Edit, Write, Read, ...) plus,
  in an environment with any MCP connectors configured, every one of *their* tool definitions too -
  none of which this companion, which has no tools configured, ever calls. `allowedTools: []` looked
  like the fix but isn't - confirmed live it only skips the permission prompt, the tool list is
  unchanged (~10,800 tokens); `tools: []` (disables built-ins) plus `mcpServers: {}` +
  `strictMcpConfig: true` (drops ambient/MCP-connector tools, `strictMcpConfig` required or the SDK
  still merges in project/user MCP config) is what actually removes them, confirmed live: same call,
  197 tokens total, zero cache overhead - a ~98% reduction. `settingSources: []` was added too
  (filesystem settings default to "load everything," independent of the `systemPrompt` override,
  confirmed live: pointing `cwd` at this repo - which has a 53KB CLAUDE.md/AGENTS.md - with
  otherwise-identical options raised the same call to ~32,000 tokens) - defense in depth on top of
  `cwd` already being `SCRATCH_DIR`, a dedicated non-project directory (confirmed no CLAUDE.md
  exists anywhere in its own directory-ancestor chain either, so this repo's CLAUDE.md was never
  actually reachable from there in practice) - but `settingSources: []` also stopped
  `ClaudeBackend` from inheriting Thomson's global `~/.claude/CLAUDE.md` writing-style preferences
  the way it used to (confirmed live: an identical prompt reliably avoided an em dash with the SDK's
  old default settings-loading, then used one once `settingSources: []` was added) - fixed by
  promoting the style rules from a `LocalBackend`-only addendum (`STYLE_ADDENDUM`, formerly
  `LOCAL_STYLE_ADDENDUM`) to both backends explicitly, rather than relying on either backend
  incidentally inheriting the rest of that file's unrelated engineering-workflow guidance, which was
  never meant for this tutor persona regardless.

- `LocalBackend` can hit context overflow on a *single* capture, with zero accumulated history -
  a genuinely different failure from the multi-turn growth `trimHistory` (above) bounds, and one
  that bound cannot help with. Confirmed live against the real Ollama gemma4:26b model this project
  is configured for: a single, realistic Submit capture (a real problem description plus a
  ~150-line solution, first message of a brand-new conversation) already exhausted its default
  4096-token context window over the OpenAI-compat endpoint (`/v1/chat/completions`) - the model's
  own "thinking" burns through whatever's left after the system prompt and capture content, and a
  longer capture also means more for it to reason about, so trimming the capture's own content
  can't reliably guarantee safety either short of cutting the student's code short (which would
  make the tutor review incomplete code - undermining the one thing this tool exists to do).
  Re-confirmed live that this Ollama version's compat endpoint still ignores `num_ctx` entirely,
  top-level or nested under `options` - only its native `/api/chat` honors it. Fixed by giving
  `LocalBackend` a second API style (`requestNative`/`streamReplyNative` alongside the original
  `requestOpenAI`/`streamReply`) that speaks Ollama's native chat API instead, requesting a larger
  `num_ctx` (`COMPANION_LOCAL_NUM_CTX`, default 8192) - confirmed live that the *exact* request that
  failed against the compat endpoint's default 4096 completed normally once resent to `/api/chat`
  with `num_ctx: 8192`, and confirmed live end-to-end via a real `companion.js` subprocess against
  the real model both ways (forced `COMPANION_LOCAL_API=openai` reproduces the failure, the default
  config does not). `COMPANION_LOCAL_API` (`auto`/`openai`/`native`) picks between the two; `auto` now probes the
  server (see the context-window bullet below), and the old exact-default-address rule is gone. `companion/companion.test.js`'s dual-route stub (`startDualApiStubBackend`) serves both
  `/v1/chat/completions` and `/api/chat` behind independently-sized simulated context thresholds, so
  a test can prove the fix comes from genuinely using the native route with more room, not from the
  capture having gotten smaller - verified the repro test actually fails without the fix (reverted
  the `apiStyle` branch to always use `requestOpenAI` and confirmed the native-mode test fails).

- A *tight* bulleted/numbered list item (no blank line between bullets - what an LLM's own list
  output almost always looks like) used to skip `reflowText` entirely: marked-terminal's
  `listitem()` forwards to marked's own `Parser.parse(item.tokens, !!item.loose)`, and marked only
  routes a `'text'`-type token (what a tight item's tokens are) through paragraph rendering - and
  therefore through `reflowText` - when that `top` flag is true; a *loose* item's tokens are
  already `'paragraph'`-type, which renders (and reflows) through that path regardless of `top`. So
  a tight bullet's text came out completely unwrapped, and the only line break on screen was the
  raw terminal's own hardware auto-wrap, which could land mid-word with zero hanging indent - a
  pre-existing gap that PR #36 (uncapped terminal width) turned from a rare edge case into an
  everyday occurrence, since an ordinary one-sentence bullet exceeds 80-120 characters far more
  often than 250-320. Fixed in `terminal-format.js` by patching `TerminalRenderer.prototype.listitem`
  (marked-terminal's default export) once at import time to force every item to look "loose" to
  marked's Parser - confirmed this doesn't change what's rendered for an already-loose item or for a
  tight task/checkbox item, and makes a tight list render byte-for-byte identically to the same
  content as a loose list (which already reflowed correctly). A second, related bug found live in
  the same pass: marked-terminal's own list rendering adds a further indent on top of
  `reflowText`'s wrapped output (a tab-stop plus the bullet marker's own width -
  `Renderer.prototype.list`'s `indentLines`/`bulletPointLines`) that isn't subtracted from the
  configured reflow `width` the way `TURN_MARKER_WIDTH` already is, so a list item's continuation
  line could still run past the terminal's actual width and hard-break mid-word once that extra
  indent landed on top of an already maximally-reflowed line - confirmed live in a real 260-column
  `tmux` pane (a hyphenated word, "off-by-one", split into "off-by" / "-one"). Fixed by also
  subtracting `LIST_INDENT_OVERHEAD` (6: marked-terminal's default tab of 4 plus its 2-column
  bullet marker) from the global reflow width; covers one level of list nesting only (the common
  case), not arbitrarily nested lists. `terminal-format.test.js` has the regression test (a long
  single-sentence bullet in a tight list, wrapped at a wide terminal width, compared byte-for-byte
  against the same content as a loose list) - confirmed it actually fails without the fix.
- `extension/shared/context-budget.js` holds `LocalBackend`'s context-budget logic (pre-flight size
  estimate, the pinned problem description, and older-turn diff compression) as pure, importable
  functions - split out from `companion.js` so it's directly unit-testable (`context-budget.test.js`)
  the same way `terminal-format.js`/`vault-summary.js` already are, rather than only reachable
  through a full `companion.js` subprocess. Built from two firstmate investigations
  (`data/companion-context-capacity-test` and `data/companion-reply-cutoff-recheck` in the firstmate
  repo): past ~800-900 lines in a single capture, Ollama's native `/api/chat` silently discards part
  of the prompt *before* generating, with `done_reason: "stop"` (identical to genuine success) -
  none of `resolveReplyText`'s `finishReason`-based guards (PR #31/#33/#34/#35) can see this, since
  they only ever check for `"length"`. Three fixes, all in `LocalBackend.sendMessage`/`buildMessages`:
  1. **Pre-flight size check** (`estimateMessagesTokens` vs `LOCAL_NUM_CTX - LOCAL_RESERVE_TOKENS`,
     default reserve 2600, both in `companion.js`): refuses to send an over-budget request at all,
     turning the invisible wrong-review failure into the same clean `companion: error talking to
     backend (local): ...` line the existing cutoff guard already produces. `CHARS_PER_TOKEN_ESTIMATE`
     (3.9) is calibrated, not guessed - four live `/api/chat` calls against gemma4:26b at
     30/100/250/500 lines of real Python measured 4.28/4.13/4.01/3.93 chars/token, converging toward
     3.9 as size grows (matching the capacity report almost exactly); 3.9 is deliberately the
     conservative end (smaller divisor -> larger, safer token estimate) and is most accurate exactly
     in the large-capture danger zone. Live-confirmed: a real 903-line capture against real
     production defaults (`num_ctx=8192`) was refused instantly (~8,711 estimated tokens vs a
     5,592-token budget) rather than silently reviewing truncated code.
  2. **Problem description sent once per problem, not every turn**: `formatCaptureMessage` no longer
     embeds the description in the per-turn text at all; `captureProblemContext` bundles it with the
     problem id and is passed to `backend.sendMessage` on every capture. `LocalBackend` pins the
     first description it sees per problem (`pinnedProblemContext`) and `buildMessages` reconstructs
     it fresh as a second system message on *every* request - never stored inside `this.history`
     itself, so it can't be lost when `trimHistory` drops the turn that originally carried it.
     `ClaudeBackend` instead prepends it to the prompt text only on a fresh SDK session's first
     message (`!this.sessionId`), since that backend's own continuity never trims. Live-confirmed
     with `COMPANION_LOCAL_MAX_HISTORY_TURNS=1` (aggressive enough that turn 1 is provably gone from
     `history` by turn 3): after 4 captures plus a typed follow-up, the real model still answered a
     detail-specific question ("what exact condition triggers the police alarm") correctly from the
     pinned description alone.
  3. **Older history turns compressed to a diff**: superseded by the capture-diff rules above (later turns now carry
     only a diff, and older full-code turns go compact next to the pinned code). The original measurement on a real
     7-turn session: `prompt_eval_count` at turn 7 dropped from 2,879 to 1,901 (34% less).
  All three closed-loop-verified against the real, locally-running `gemma4:26b` (never a stub) in a
  real `tmux` pty session, per this file's own established bar - not just the piped test suite.

- `LocalBackend`'s context window works with any OpenAI-compatible server (Ollama, LM Studio, llama.cpp server, vLLM, text-generation-webui, LocalAI) and any model; nothing may assume Ollama or a particular model.
  The window budgeted for is `contextWindow()`, the single place it is decided (`resolveContextWindow` in `context-budget.js`): the smallest of `COMPANION_LOCAL_NUM_CTX` (default 8192, also what Ollama's native API is asked for), what the startup probes found, and what a reply showed the server really kept.
  The options page's "Context window (tokens)" field (`contextTokens` in `companion/settings.js`, locked by `COMPANION_LOCAL_NUM_CTX`) is what feeds `numCtx`.
  The probes (`extension/shared/local-server.js`, no Node API) run once in the background at startup and the first message waits at most for their 1.5 s timeouts: `GET /api/version` identifies Ollama (then `COMPANION_LOCAL_API=auto` uses the native API, at any address), and `/api/show`, `/api/ps`, LM Studio's `/api/v0/models`, llama.cpp's `/props` and vLLM's `/v1/models` report windows; any failure or unknown shape is ignored.
  Test model stubs must answer non-chat routes with a 404 (each stub has a one-line guard), since every companion subprocess now probes its stub.
  Every request is fitted to the budget before it is sent (`fitWithSummary` in `extension/shared/context-summary.js`), never touching the pinned statement, the pinned code or the current message, and it is refused (naming each part's size) only when those alone are over.
  This replaced a refusal that, with history trimmed only by count and only after a success, stuck every later message once a few long replies filled the budget (`context-window.test.js` has that scenario).
  Exchanges that must go (over the budget, past `COMPANION_LOCAL_MAX_HISTORY_TURNS`, or after a reply cut off with `finish_reason: "length"`, which would be cut off again) are condensed, at least the older half at a time so the call is not paid every turn, into one "earlier in this session" summary (at most about 300 estimated tokens), sent as a system message after the pins; a later overflow merges into it.
  It comes from one unstreamed call on the same model inside the same turn (so the turn queue never interleaves it and the panel sees nothing of it), carrying only the dropped exchanges and skipped if it would not fit; on failure, timeout (60 s), an empty reply or no fit, a digest of each exchange's first student and tutor sentence stands in, and with no room for even that the oldest are dropped by `fitToBudget` as before.
  A fixable overflow prints nothing.
  The summary is memory only, cleared by `resetContext` and gone with a swapped backend.
  `CodexBackend` condenses past its count cap the same way; `ClaudeBackend` resumes its session and never condenses.
  Test stubs tell a summary call apart by its first message being `SUMMARIZER_SYSTEM`.
  The silent-truncation guard: streamed OpenAI-style requests ask for `stream_options: { include_usage: true }` (dropped for good after a 400/422 that names it), and a reply whose `usage.prompt_tokens` (or native `prompt_eval_count`) is under 70 percent of the estimate, and at least 256 tokens under, means the server dropped the start of the prompt with an ordinary "stop".
  The window then becomes the reported count, and one terminal warning per session is printed after the turn (`takeWarnings`); there is deliberately no panel message for it.
  A cut smaller than 30 percent cannot be told apart from tokenizer differences, so it goes unnoticed.
  The reserve (2600) and the existing refusal path were kept as they were at Thomson's request.

- The in-page Tutor tab (`extension/panel.js`, `relay-server/panel-broker.js`, `companion/panel-bridge.js`) mirrors
  the companion chat into the leetcode.com tab strip. The companion publishes events to the relay (`POST
  /panel/publish`), the panel streams them over SSE (`GET /panel/events`) and posts typed messages (`POST
  /panel/message`), which reach the companion over its own SSE (`GET /panel/inbox`); the terminal chat stays the
  source of truth and every publish is best effort. Sharp edges, all found live against the real page:
  - The `/panel/` routes can *read* the student's code back, so unlike `/capture` they are not CORS `*`: Host must be
    the relay's own loopback address (DNS rebinding) and Origin must be absent or exactly `https://leetcode.com`.
    Publish and inbox are companion-only (`companionOnlyRejection` in `panel-broker.js`): any Origin, a
    `Sec-Fetch-Site` other than `none`, or a missing `X-LC-Companion: 1` header is refused. A missing Origin alone
    proves nothing (a page's `fetch(url, { mode: "no-cors" })` sends none); the custom header needs a preflight, which
    the relay refuses. This keeps web pages out, not other local processes. `relay-server/panel-broker.test.js` covers
    each rule; `POST /panel/rpc-result` (the settings answers) goes through the same helper. Every `/panel/` route also refuses a
    `Sec-Fetch-Mode` other than `cors`: a page's no-cors fetch, `<img>` or `<iframe>` carries no Origin and, unreadable
    as it is, used to hold one of the 20 panel-stream slots. Both real callers send `cors` (Node's fetch included).
  - The header's status light reads the relay's `status` event: `busy` (set by the companion on companion-only
    `POST /panel/activity`, from when a message is queued or a Submit turns out to need the tutor until it is answered,
    going idle 100 ms late so back-to-back turns do not flash) shows yellow "Processing"; the relay clears it when the
    last companion leaves. Runs and unchanged Submits show nothing in the panel; only a Submit sent to the tutor gets a chip.
  - Sequence numbers restart with the relay, so each event carries the relay run's random `epoch`. The panel compares
    it per event (a reconnect's replay arrives before its `status` event) and reconnects with `?after=N&epoch=X`.
  - A companion that exits mid-reply sends no `turn-end`. When the last inbox stream closes (or a publish lands with
    none open), the relay ends every open turn itself with `interrupted: true` and the text streamed so far
    (`closeOpenTurns`), so no tab, including one opened later, shows a reply typing forever. The panel shows the same
    note as for a relay restart, and also interrupts pending replies on `companionOnline: false` for an older relay.
    That needs the relay to outlive the companion, and by default it does not: the companion spawns the relay and
    kills it on exit. So the panel also interrupts every pending reply as soon as its event stream drops
    (`streamLost`). After a reconnect to the same relay run, the `status` event's `openTurns` lists the replies still
    open and the panel revives those (a chunk revives one too), so a mere stream blip leaves no false note.
  - The feed is patched in place, never rebuilt per event: one cached node per item (keyed by the item, refreshed when
    its `rev` changes) and, in a streaming reply, reuse of every block whose parsed form is unchanged. A rebuild wiped
    the student's selection and code-block scroll on every chunk. `extension/e2e/panel-render.e2e.mjs` checks this and
    the rest of the panel's DOM behavior in headless Chromium against a local fixture (no relay, no real page); it is
    a manual script, not part of `npm test`.
  - The tutor is told (`FORMAT_ADDENDUM` in `tutor-prompt.js`) to draw diagrams as ASCII or box-drawing in a bare fenced block within 56 columns; the panel renders such a block (`pre.plain`) verbatim with a 14px line so box lines meet, and everything else wraps with `overflow-wrap: anywhere` (table cells `break-word`, so wide tables scroll in `.table-wrap`).
    The pane is resized live: a ResizeObserver (`observePanelSize`) keeps a following feed at the bottom, keeps the block being read in place when scrolled up (`keepScrollAnchor`, the browser's own anchoring is off), and re-fits the composer, whose cap is 30% of the pane height (`cqh`).
    A scroll event that comes with a size change is layout, never the student scrolling up (`view.metrics`); reading it as one stopped the feed following on every resize.
    `syncRect` also re-finds the pane under the tabset, which may catch up with a splitter drag a frame late.
  - Streams must send `Cache-Control: no-store` (and the client `cache: 'no-store'`): Chrome's HTTP cache takes a lock
    on a never-ending response, and a second identical GET (another tab asking for `/panel/events?after=0`) queued
    behind it forever while a different URL on the same host answered instantly.
  - LeetCode's tab strip is flexlayout-react. Tabs select on *mousedown*, then re-render under the pointer so no
    `click` ever reaches the cloned Tutor button - it activates on `pointerdown`. Each tab label is rendered twice
    (a bold visible copy and an absolutely positioned regular-weight copy), so `textContent` reads
    "descriptiondescription"; match on the first leaf element instead. The tab *content* elements are absolutely
    positioned siblings of the tabsets under `.flexlayout__layout`, not children of the tabset, so the panel is
    placed over the tabset's `.flexlayout__tabset_content` rect.
  - The Tutor tab is a real flexlayout tab when it can be (`extension/layout-bridge.js`, a page-world script `panel.js` injects like `inject.js`, listed in `web_accessible_resources`).
    The bridge finds the Model through the React fiber chain of `.flexlayout__layout` and adds `{ id: 'lc-tutor-tab', component: 'lc-tutor' }` with an action object shaped like the library's (0.11 calls `isAdjusting()` on every action, and renamed `FlexLayout_AddNode` to `FlexLayout_AddTab`, so both are tried).
    Support matrix: it drags to any tabset, reorders, splits into its own tabset on any side, maximizes, follows splitter drags, selects and hides exactly like a native tab, cannot be closed, renamed, floated or popped out (another document the panel cannot follow), and stays put if Description moves or is deleted.
    LeetCode's real layout gives tabs no names (`getName()` is "[Unnamed Tab]", tabs are known only by `component`), draws its i18n key ("Tabs.LcTutor") with no icon for an unknown component, runs an older fork with `_setChangeListener` but no `addChangeListener`, has no `getPath()` on its nodes, and carries `foldBeforeWeight` on each tabset, rewritten by splitter drags.
    So the bridge finds tabs by component first (name as fallback), builds a node's `data-layout-path` from parent and child indexes when `getPath()` is missing (`pathOf`, taking a button only once the strip has every tab, since the Model runs ahead of React), hides key-like or empty page content in the button and shows a copy of a native tab's content from the same strip with "Tutor" and the chat icon (re-applied by an observer), and wraps the instance's `doAction` to see every action; `layout.e2e.mjs` runs every scenario against a named fixture and a LeetCode-like one (`?leetcode`) that copies all of this.
    The panel lives inside the tab's pane (`[data-lc-tutor-pane]`, marked by the bridge with `[data-lc-tutor-button]`; the pane exists only once the tab is first shown) and follows it when React re-creates it, keeping one panel so the feed and its scroll survive every move; a hidden or detached panel never touches its scroll anchor.
    Persistence safety: the bridge wraps that Model instance's `toJson` with `cleanLayout`: the tab, a tabset or row it empties and its selection index never reach what the page saves (LeetCode stores the layout in the account), and a split Tutor tabset's weight goes back to the sibling it came from, so the saved JSON is byte-identical to the layout without the Tutor (every weight key, `foldBeforeWeight` included, comes from the last clean JSON while the native shares are untouched; a drag on the Tutor's own splitter changes nothing saved).
    When the tab leaves its own tabset (a drag home, `pagehide`) the bridge also writes those weights back into the Model; a shape it cannot prove saves the last clean JSON and makes native mode give up for the clone (`unsafe-layout`, logged).
    `layout.e2e.mjs` compares the saved JSON with the layout read before the tab was added after every scenario (only `active`/`selected` left out).
    It re-wraps and re-adds on a replaced Model (Default layout, a new problem), and deletes the tab on `pagehide` (back on a persisted `pageshow`).
    Its spot is remembered on this device only: `storage.local` key `tutorTabPosition`, written by `panel.js` from the bridge's `lc-tutor:layout-position` event after each move by the student (the bridge's own actions carry `lcTutorBridge` and are ignored), described by native tabs only (each by its component, else its name; spots saved by name still restore) (`{ mode: 'tabset', anchors, after, index }` or `{ mode: 'dock', anchors, side, ratio }`, see `validPosition`); missing anchors, a failed add, junk or failing storage all mean the default spot, right after Description.
    Fallback: when the bridge cannot load or reports `native: false` (no fiber, no Model, no button, or a shown tab with no pane within 2 s) the injected clone takes over; the bridge keeps watching and retries (at most every 0.5 s, 10 times per page) once the layout element, Model or URL differs, and the clone steps aside on `native: true` (only `unsafe-layout` is final). Every fallback logs its reason and sets `data-native-reason` on the clone's `#lc-tutor-panel-host`. The clone runs with `inert` on the native pane under it and its rect synced; it finds panes under `.flexlayout__layout` even when a newer flexlayout wraps each tabset in a container.
    `extension/e2e/layout.e2e.mjs` checks all of this against the real flexlayout-react 0.11.1 (a dev-only package in `extension/e2e/flexlayout/`, run `npm install` there once) with real input; tab drags there are HTML5 drag and drop, which headless Chromium performs only through `Input.setInterceptDrags`, and a tab button partly under the strip's toolbar must be scrolled into view before clicking.
    Only the real page can confirm LeetCode's own flexlayout and React versions, its save path (assumed to be `model.toJson()` from `onModelChange`), what its factory and `onRenderTab` do with an unknown component, and whether its older drag code (pointer events, not HTML5) moves the tab the same way.
  - Chrome may show a one-time "local network access" prompt for leetcode.com on the first request to `localhost`;
    until it is answered the request just hangs. Keyboard input in the panel is stopped at its shadow host, and
    `content.js`'s Ctrl/Cmd+Enter shortcut ignores events whose composed path includes `#lc-tutor-panel-host`.
  - To test against the real page without loading the unpacked extension, run the relay + companion (with a stub
    model) and inject `panel.js` by `new Function(code)()` through the browser tool; leetcode's CSP allows it.

- `extension/scripts/build.mjs --browser chrome|firefox --out <dir>` (zero-dependency, covered by `extension/build.test.mjs` in `npm test`) copies the extension without tests, e2e, `package.json` files, checklists, the privacy policy, and screenshots; the chrome target also drops `background.scripts` from the output manifest only, since Chrome warns about it. Never edit the repo manifest for this: Firefox and `npm run lint:amo` need both background keys.

- Settings (which LLM the tutor uses, plus the auto-clear and vault options) are edited on the extension's options page (`extension/settings.html`, `settings.js`), never in the Tutor panel, since leetcode.com's own scripts can read anything typed into the page.
  The panel's gear sends `{ type: 'lc-tutor:open-settings' }` to `extension/background.js`, which calls `openOptionsPage`; the manifest declares `background` with both `service_worker` (Chrome) and `scripts` (Firefox), so `npm run lint:amo` always shows one warning about `service_worker` being ignored on Firefox.
  The page calls `POST /settings/rpc`, which takes only an extension `Origin` (`chrome-extension://<32 letters a-p>` or `moz-extension://<uuid>`) plus the loopback Host check, and the relay forwards it down the companion's inbox as `{ type: 'rpc', id, method, params }` and waits up to 120 s (190 s for `switchProfile`, longer than the panel's own 180 s) for the companion-only `POST /panel/rpc-result` (503 with no companion, 504 on timeout).
  The companion owns everything else: `companion/settings.js` (file, validation, env var > saved file > default per field, a set env var locks its field, `publicView` never carries a key), `settings-rpc.js` (get, save, test, models; a save builds the backend before writing anything) and `makeBackend(effective)` in `companion.js` for the five providers (`local`, `claude`, `anthropic`, `openai`, `chatgpt`).
  A save swaps `backend` through `queueTurn`, so it never lands mid-turn, and moves the conversation to the new backend (`transferConversation`); a save that changes only options keeps the running backend.
  Model switcher: saved models are `profiles: [{ id, provider, model, label }]` plus `activeProfile` in both stores (`extension/shared/profiles.js`; a pre-profile record migrates to one profile with id `default`), and `provider` plus that provider's `model` always mirror the active profile, so nothing downstream reads profiles.
  The extension keeps the whole list; the options page sends the companion only the profiles whose provider runs through the helper (with each helper save, or `setProfiles` after a browser save), so a list saved while the helper was down reaches it only on the next save.
  The panel gets entries (no secrets, with a disabled reason) from the worker's `profiles` port message and switches with `switch-profile` on the port, or, for a helper profile in the helper runtime, the panel-origin `POST /panel/switch-profile { id }`, which the relay forwards as the rpc `switchProfile` with only the id (the companion refuses an id it has not saved, or one an env var locks).
  Both answer only after the queued swap, so the panel's "Switching" outlasts a running reply; a switch across runtimes starts the other runtime's own session (`relaySwitchPending` asks the companion for the id once it is online).
  The companion's config event names its active profile (`profile`, from `resolveEffective`, null when an env var runs something else); a helper switch the panel stopped waiting for (its timeout, a 504 or a broken request) is taken from the next config event naming that id (`unsettledSwitch`), and no other config event moves the panel's choice, since a companion that missed a save made while it was down may name an older profile.
  Tests: `engine.test.mjs`, `settings-rpc.test.js`, `panel-broker.test.js`, `panel-bridge.test.js` (real relay and companion), `e2e/model-switcher.e2e.mjs` (the dropdown in the fixture with a scripted worker and relay), `e2e/extension-runtime.e2e.mjs` and `e2e/settings-page.e2e.mjs`.
  The companion publishes a non-secret `config` event (`statusSummary`: provider, label, model) at start, after each save and on every inbox reconnect; the relay keeps only the newest one, outside the conversation buffer, and sends it to each panel after the replay.
  `ClaudeBackend` passes its environment through the Agent SDK's `env` option (`claudeBackendEnv`): `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed for the subscription and set to the saved key for the API-key provider; `CodexBackend` likewise drops `OPENAI_API_KEY` and `CODEX_API_KEY`.
  `CodexBackend` pins the held code and the statement like `LocalBackend` (through `context-budget.js`'s `buildMessages`), and is tested only against a fake `codex`.
  The launcher `bin/leetcode` must not export `COMPANION_BACKEND` (or any other settings variable) without a flag, since that would lock the field and make the options page useless; only an explicit `-<provider>` flag sets it, for that run.
  It has no automated test: verify a change with a stub `node` on `PATH` that prints its environment, never a real companion.
  Tests must never touch the real `~/.config/leetcode-capture/settings.json`: `companion/test-isolation.js` (loaded by `npm test` with `--import`) points `LEETCODE_CAPTURE_SETTINGS` at a path that does not exist for every spawned companion, and a test that needs a file sets its own temp path.
  `companion/panel-bridge.test.js` has the hot-swap test (two stub models, a save through `/settings/rpc`), and `extension/e2e/settings-page.e2e.mjs` ends with a live scenario against a real companion and relay on a free port (the browser redirects the page's `localhost:8135` requests there, so the relay sees the page's real Origin).

- Runtimes (see README.md, "Runtimes"): the tutor runs either inside the extension (the "extension" runtime, default for `local`, `anthropic` and `openai`, nothing to install) or through the helper (relay + companion, required for `claude` and `chatgpt`).
  One copy of the tutor logic lives in `extension/shared/` (the extension folder is what gets packaged): the ledger, budget, summary, probing, sanitizing, `tutor-prompt.js`, `providers.js` (the catalog, with each provider's `runtimes`) and `LocalBackend` (`local-backend.js`), all ES modules the companion imports by relative path.
  `extension/shared/package.json` (`"type": "module"`) is what lets Node load them; it is left out of the AMO lint and build.
  `extension/shared.test.js` fails if any shared module imports a Node built-in, a bare package or anything outside the extension folder, or uses a Node global.
  The extension runtime's own pieces are there too: `anthropic-backend.js` (LocalBackend with only `request()` replaced; raw fetch with `anthropic-version` and `anthropic-dangerous-direct-browser-access: true`, default model `claude-opus-5-5`, a refusal or `max_tokens` stop is an error, never a reply), `event-hub.js` (the relay's event protocol: seq, epoch, replay, config, status, dropProblem), `tutor-engine.js` (the companion's capture and message rules in one queue), `extension-settings.js` (settings and keys as two storage records, `publicView` has only `hasKey`, `explainError` adds the `OLLAMA_ORIGINS` fix to a local 403 or network error) and `tutor-service.js` (the port protocol and the options page's `lc-tutor:settings-*` calls, which answer only a sender whose URL is the extension's own origin).
  `background.js` is a module worker (`"type": "module"` next to both `service_worker` and `scripts`) that only binds `chrome.*` to the service.
  `content.js` hands a capture to the worker first (`lc-tutor:capture`, answered `{ handled }`) and POSTs it to the relay only when the worker leaves it (helper runtime) or cannot be asked.
  `panel.js` always opens a port (`lc-tutor-panel`) to the worker, which says which runtime is chosen; the extension transport carries events and messages on that port (pinging every 20 s keeps the worker up), the relay transport is the old fetch/SSE code unchanged, and both feed the same `applyEvent`.
  Host access is `optional_host_permissions` requested by the options page on Save, Test or Find models (must happen before any `await`, while the click still counts as a user gesture); the worker re-checks on `permissions.onAdded/onRemoved`.
  Tests: `adapters.test.mjs` (stub OpenAI SSE, Ollama native, Anthropic SSE), `engine.test.mjs` (the rules through the service and a fake port), `e2e/extension-runtime.e2e.mjs` (the real extension, leetcode.com served by CDP Fetch from the fixture, a stub model, no relay) and the browser-runtime scenarios of `e2e/settings-page.e2e.mjs`.
  The e2e scripts load a copy of the extension whose manifest pre-grants `127.0.0.1` (`extensionCopy` in `cdp.mjs`), since headless Chromium cannot answer the permission prompt, and `Page.eval` passes `userGesture: true` so a scripted click may request permissions.
- The Native Messaging helper (`helper/`, see README.md "Helper"): an npm package (name `leetcode-capture-helper`, free on npm on 2026-10-29, not published) with `host.js` (the host: stdio framing in `framing.js`, `ping`/`status`/`start`/`reset`/`stop`), `install.js` and `cli.js` (install, uninstall, status), and `config.js` (host name `dev.thomsonklee.leetcode_capture`, the gecko id, `CHROME_EXTENSION_IDS`).
  The host's stdout is the browser channel: never print to it; the children's output goes to `helper.log`.
  It runs the relay (unless one already answers, then it starts no companion either) and the companion with `COMPANION_HEADLESS=1`, both with stdin pipes, so a killed host takes them down (`RELAY_EXIT_WITH_STDIN`, and the companion exits when stdin ends); the relay's opt-in `RELAY_IDLE_EXIT_MS` is held off by the host's companion-only `POST /helper/keepalive`, and a headless companion ignores SIGHUP and exits after `COMPANION_IDLE_EXIT_MS` without a relay.
  `/reset` on the companion's stdin (or typed) clears the tutor context and keeps the process.
  The installer copies the host into a per-user data folder and writes a receipt of every file, folder and registry value, which uninstall removes exactly; every location comes from `layout({ platform, home, env })` and the registry from an injected `reg`, so tests never touch real browser folders, and neither may anything else.
  The extension side is `extension/shared/helper-launcher.js` (pure; tab count from the panel ports, 30 s grace, active-tab reset, ping, retry), driven by `background.js` only when the runtime is helper and the optional `nativeMessaging` permission is granted; the options page's Helper section asks `lc-tutor:helper-status` / `lc-tutor:helper-retry` and pings the host itself to tell installed from not installed.
  Timer functions handed to shared modules from the worker must be wrapped (`(fn, ms) => setTimeout(fn, ms)`): the browser's own throw "Illegal invocation" when called through another object, which Node's do not, so only the e2e catches it.
  `extension/e2e/helper-launch.e2e.mjs` runs everything for real: Chromium reads per-user registrations from `<user-data-dir>/NativeMessagingHosts`, so the registration goes in the temporary profile; content-script fetches bypass the page's CDP Fetch interception, so the copy's `localhost:8135` is rewritten to the test port; and the browser needs `--disable-features=LocalNetworkAccessChecks,...` for leetcode.com to reach localhost headless.
  The package bundles the companion and relay: `prepack` runs `helper/scripts/pack.mjs`, which copies `companion/`, `relay-server/`, `extension/shared/` and `vault-tool/` (non-test `.js`, each folder with a `package.json` carrying only its module type) into the gitignored `helper/runtime/` with the same relative layout, and fails if an import reachable from the entry points is missing or a package import is not in the helper's `dependencies` (which `pack.test.js` keeps equal to the companion's); `postpack` deletes the copy, so never edit or commit `runtime/`.
  `resolveRoot` order: `LEETCODE_CAPTURE_ROOT`, the installer's `helper-config.json`, the bundled `runtime/` (marked by `bundle.json`), the checkout above; a bundled root moves the capture log and companion state to `<app>/data/` (`dataEnv`).
  `cli.js` must compare the real path of `argv[1]` (npx and global installs run it through a `.bin` symlink, and a plain compare made every command a silent no-op).
  `npm run e2e:packed` in `helper/` packs, extracts, installs dependencies (`--link-deps` for offline), installs into a temp home through a bin symlink and runs the registered host with a fake client on stdio.
  Not verified: real Chrome, Firefox (optional `nativeMessaging` there), macOS, Windows, a real `npx` run from the registry.

- Progress tracking (README.md, "Progress"): `extension/shared/catalog.js` is the one problem catalog (slug to LeetCode's exact title and difficulty); `extension/shared/roadmap.js` holds the lists by slug (`LISTS`, in the picker's order: NeetCode 150 and NeetCode 250 with the same topics and prerequisite edges, kind `graph`; Blind 75, Grind 75, Top 100 Liked, Top Interview 150, SQL 50 as ordered groups, kind `groups`, whose next group is the first unfinished one; Grind 75 also has `subjects`, a second grouping in NeetCode's topic names that the Progress tab's "Group by" switch shows and `moreOfTopic` uses, its derivation in the data's comment), `listById` (unknown means NeetCode 150), `nextOnRoadmap`, `suggestAfterSolve`; and `extension/shared/solved.js` the solved store (`storage.local` `solvedProblems` slug to `{ at, count, manual? }`, `starredProblems`, the chosen list `activeProgressList`), the "nice job" card's content (`congratulation`, built for the chosen list) and the worker's messages, all writes in one queue.
  Every list is pinned to its publisher, all checked 2026-11-04: `node extension/scripts/list-sources.mjs` fetches each site (plain fetch, no login) into `e2e/*.txt` (`--check` only compares), and `roadmap.test.mjs` holds the lists to those files.
  `e2e/neetcode-lists.txt`: the problem objects in neetcode.io's main bundle (https://neetcode.io/practice): NeetCode 150 and 250 topics in order, its `blind75` flag, and the topic its full catalog gives each Grind 75 problem on none of its lists.
  `e2e/blind-75.txt`: the original 2018 Blind post (teamblind.com, its DiscussionForumPosting data); the list is that post exactly, Merge K Sorted Lists kept once; neetcode.io's Blind 75 swaps the post's Combination Sum IV for Combination Sum.
  `e2e/grind-75.txt`: techinterviewhandbook.org/grind75 (behind a browser challenge; it proxies `https://grind75.pages.dev`, which the script reads): the site's question data scheduled by its own code at its defaults (8 weeks, 8 hours a week, by priority while 1.96 minutes per duration minute fit, then by difficulty, weeks cut at 480 such minutes); the script fails if those defaults leave the bundle. Its difficulty is the site's; the catalog keeps LeetCode's (only Lowest Common Ancestor of a BST differs).
  `e2e/leetcode-study-plans.txt`: LeetCode's GraphQL `studyPlanV2Detail` for top-100-liked, top-interview-150 and top-sql-50 (groups, order and difficulty exactly).
  Grind 75's subjects are neetcode.io's topic for the problem; the four it lacks are judged from LeetCode tags (in the data's comment, named in the test).
  The neetcode-gh/leetcode repo's `.problemSiteData.json` is older (no NeetCode 250, Generate Parentheses under Stack); neetcode.io has no NeetCode 75.
  After a change to a list or the catalog run `node extension/scripts/list-slugs.mjs`: `e2e/list-slugs.json` (every slug with its expected title and difficulty) must match, `roadmap.test.mjs` checks it.
  `node extension/scripts/list-slugs.mjs --snippet` prints a script for the console of a signed-in leetcode.com tab that checks every slug, title and difficulty in that file against LeetCode's GraphQL.
  `lc-tutor:set-list` (from the options page or a problem tab's card menu) writes only `activeProgressList`; from a problem tab it answers that page's card again, which `panel.js` patches in place (`patchStatic`).
  Detection lives in `inject.js` (page world, injected by `content.js` at load, not at the first capture): it wraps `window.fetch` and `XMLHttpRequest.prototype.open` only to read a clone of `/submissions/detail/<id>/v2/check/` answers (and the older `/<id>/check/`; the live page moved to `v2` and detection silently stopped until a real Submit caught it on 2026-11-04), counts an all-digit id with `state` "SUCCESS" and `status_msg` "Accepted" (a Run polls the same path with a `runcode_` id), and reports each id once as `leetcode-capture:submission-accepted` (JSON string detail) with the slug of the problem page its first check started on.
  `content.js` drops a verdict whose slug is not the page's live one (LeetCode moves between problems with `history.pushState`, so a verdict can land on the next problem) and sends `{ type: 'lc-tutor:accepted', submissionId, slug }`; the worker requires a leetcode.com problem page in a tab but takes the slug from the message, since Chrome's `sender.url` stays the address the tab loaded after an in-app move (seen in `solved-detection.e2e.mjs`; the card's `lc-tutor:set-list` carries its slug for the same reason), dedupes per submission, stores, and answers the card, which `content.js` passes to `panel.js` as `leetcode-capture:solved`; the panel keeps it in the tab's transcript only, so it never reaches the tutor or the relay, in either runtime.
  The options page's Progress tab is `progress.js` (an ES module next to the classic `settings.js`, which owns nothing of it) and `progress.css`; marks and stars go through `lc-tutor:solved-set` / `lc-tutor:star-set`, answered only for the extension's own pages, and the page follows `storage.onChanged`.
  `progress.js` draws the NeetCode lists as the graph and every other list as a grid of group cards; the "Working on" choice is native radios in four, two or one columns (never three, so seven lists fill rows evenly); Grind 75's "Group by" (week or subject) is per-list `localStorage` (`lc-progress-view`), a convenience only. The graph's coordinates are `LAYOUT` in `progress.js`; `e2e/progress-page.e2e.mjs` fails if a line stops starting at the middle of its node's bottom, ending at the middle of the next one's top, or crosses another node, or if a node title is cut, so check it after moving a topic.
  Tests: `solved.test.mjs` (store, service, `inject.js` in a VM against stand-in fetch and XHR, `content.js` forwarding), `e2e/solved-detection.e2e.mjs` (the real extension, scripted judge answers through CDP Fetch, both runtimes, the card's list menu), `e2e/progress-page.e2e.mjs` (the graph), `e2e/progress-lists.e2e.mjs` (the list choice and the groups) and the card scenario in `panel-render.e2e.mjs`.
  Every catalog slug, title and difficulty matches LeetCode's own (checked through the problem index below, fetched 2026-11-04).
- "Practice a skill" (README.md, "Progress"): `extension/shared/problem-index.js` is generated data (never edit it by hand) from `node extension/scripts/problem-index.mjs`, which reads LeetCode's public GraphQL with no login (bulk `questionList`, then aliased `question(titleSlug)` likes and stats, 25 a request, paid-only problems not asked), one request at a time, resumable through a cache outside the repo; `--check` and `problem-index.test.mjs` validate it against `e2e/list-slugs.json`.
  `extension/shared/practice.js` (pure) maps the twenty friendly skills onto tags (LeetCode's tag slugs change: it uses `sweep-line`, and "Graph Theory" is slug `graph`) and ranks: same level, one up, one down, likes times 1.25 for a bundled list, then submissions, id, slug; `practice.test.mjs` fails on a skill tag LeetCode no longer has.
  The worker answers `lc-tutor:practice { slug, skill?, offset? }` read only, with the same problem-tab and slug-from-message rule as `lc-tutor:accepted`; `panel.js` asks it directly (no `content.js` part), from the card's row and from the header's target button, whose card (`.practice-card`, a `div` because the card's list menu shows only on the last `section`) stays in the tab's transcript only.
  Tests: `solved.test.mjs` (the message), `e2e/practice.e2e.mjs` (the real worker and index, keyboard, focus, solved exclusion, 110 to 1280 px, nothing reaches the model; a tab in the background draws no frames, so bring it to the front) and the failure scenario in `panel-render.e2e.mjs`.
  Not verified against the real site: that LeetCode still polls that path with that JSON (needs a real accepted submission, which tests must never make on leetcode.com).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
