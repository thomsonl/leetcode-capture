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
  currently 80 cols, capped by a narrower real terminal) rather than the terminal's full width. That
  width tracks a live terminal resize: `boxRule()` re-reads `process.stdout.columns` on every call, so
  the box's own rule updates the instant it's next redrawn, but `marked-terminal`'s renderer is
  registered once against a snapshot width via `marked.use(...)` - `refreshWidth()` re-registers it
  with the current width, and `companion.js` calls it from a `process.stdout.on('resize', ...)`
  listener so markdown rendered after a resize wraps to the new size rather than whatever was current
  at import time. A separate module specifically so the styling decision (TTY or not, `NO_COLOR` or
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

- Automatic context reset on a problem switch (`COMPANION_AUTO_CLEAR_CONTEXT`, on by
  default - see `companion.js`'s "automatic context reset on problem switch" section):
  tracks `capture.problemSlug` (falling back to `problemTitle`) across captures and calls
  each backend's own `resetContext()` - dropping `ClaudeBackend.sessionId` so the SDK
  starts a fresh session, or truncating `LocalBackend.history` back to just its leading
  system message - the instant a capture for a different problem arrives, rather than
  relying on `TUTOR_SYSTEM_PROMPT`'s own soft "first capture for this problem" wording.
  Deliberately in-memory only, not added to `.companion-state.json`: neither backend's own
  continuity (`sessionId`/`history`) is persisted across a restart either, so persisting
  just the tracked problem id would add bookkeeping without changing any actual behavior -
  a restart already starts both backends from a clean slate regardless.
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
  normal-sized capture's clean reply is unaffected.

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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
