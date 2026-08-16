# leetcode-capture

Browser extension + local relay server that captures LeetCode editor content
on Run/Submit clicks, so live attempts (not just final solutions) are visible,
and struggle/proficiency notes can be logged back into the Obsidian vault.

## Components

- `extension/` - Manifest V3 content script, loadable in Chrome and in
  Firefox/Zen Browser (Firefox 109+). Loads on
  `leetcode.com/problems/*`, reads the Monaco editor's current code on every
  Run/Submit click, and POSTs it to the local relay server. Makes no other
  network calls.
- `relay-server/` - minimal Node.js HTTP server, localhost-only, that
  receives captures and durably appends them to a JSON-lines log file.
- `vault-tool/` - CLI that reads a captured session's log entries and
  appends a struggle/proficiency note into the Obsidian vault.
- `companion/` - a standalone terminal chat program that gives running
  commentary on captured Run/Submit attempts as they happen, and doubles as
  a normal chat session. See [Companion](#companion) below.

Delivery posture: local-only (no remote, no PR pipeline).

## Setup

### 1. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select the `extension/` directory.
4. Open any `leetcode.com/problems/<slug>/` page. Open the DevTools console
   and confirm you see `[leetcode-capture] content script active`.

### 1b. Load the extension in Firefox or Zen Browser

The extension is Manifest V3 and works unchanged on Firefox 109+ and on
Zen Browser (a Firefox/Gecko-based browser with the same WebExtensions
engine and developer-load path).
This was verified directly in this environment: both Firefox 153.0.4 and
Zen Browser 1.21.9b installed `extension/` as a temporary add-on with no
errors or manifest warnings, using the same underlying remote-debugging
install path that `about:debugging` uses.

1. Open `about:debugging#/runtime/this-firefox` (works the same in Zen).
2. Click "Load Temporary Add-on".
3. Select `extension/manifest.json`.
4. Open any `leetcode.com/problems/<slug>/` page. Open the DevTools console
   and confirm you see `[leetcode-capture] content script active`.

Note: a temporary add-on unloads when the browser restarts, so this step
needs to be repeated each session. Persisting it without reloading would
require Mozilla's (free) unlisted-distribution signing - that's out of
scope for this task, but is a future option if session-to-session
persistence becomes worth the extra setup.

### 2. Start the relay server

```sh
cd relay-server
node server.js
```

The server listens on `http://127.0.0.1:8135` (localhost only). Every click
of Run or Submit on a LeetCode problem page (with the extension loaded and
the server running) POSTs a capture, which is durably appended - one JSON
line per capture - to:

```
relay-server/data/captures.jsonl
```

Override the log location with `CAPTURE_LOG_PATH`, and the port with
`CAPTURE_PORT`, if needed.

Each log line includes the problem slug/title/description, language, code
content at click time, trigger (`"run"` or `"submit"`), the extension's
timestamp, a server-assigned `receivedAt` timestamp, and a per-problem
monotonic `attemptSeq` that survives server restarts (rebuilt from the
existing log file on startup). `problemDescription` is the full problem
statement (prompt, examples, constraints) read from the page at capture
time; it's `null` if the description panel couldn't be found (e.g. the page
hadn't finished rendering yet).

The server answers CORS preflight (`OPTIONS`) requests and sends
`Access-Control-Allow-Origin: *` on every response to `/capture`. This
matters specifically for Firefox and Zen Browser: unlike Chrome, they run a
content script's `fetch()` under the page's own origin
(`https://leetcode.com`), so the cross-origin POST to `http://localhost:8135`
is subject to normal CORS rules. Run `npm test` (or `node --test
server.test.js`) in `relay-server/` to exercise this against a live instance
of the server.

### 3. Log a captured session into the vault

Once you've captured a session (a series of Run/Submit clicks on one
problem), turn it into a struggle/proficiency note:

```sh
node vault-tool/log-session.js --slug two-sum --note "Brute force first, then hashmap trick." --accepted
```

Options:

- `--slug <problem-slug>` (required) - the LeetCode problem slug, e.g. `two-sum`.
- `--log <path>` - path to `captures.jsonl` (default: `relay-server/data/captures.jsonl`).
- `--vault <path>` - path to the Obsidian vault root (default: `~/Documents/My Brain`).
- `--note <text>` - freeform note text to include.
- `--accepted` - mark the session's last Submit as accepted.
- `--dry-run` - print the note instead of writing it.

The tool computes attempt count, elapsed time from the first Run to the
accepted Submit (or the last Submit if never accepted), and appends a
`### Capture session: <date>` block. If any of the session's captures carry
a `problemDescription`, the block also includes the problem statement, so
the note has the question alongside the code and summary. It looks for an
existing `Study/Algorithms/<Topic>.md` note in the vault whose
`## LeetCode Problems` section links to that problem, and appends there. If
no matching topic note exists, it creates
`Study/Algorithms/Problems/<Problem Title>.md` following the vault's note
conventions (see `~/Documents/My Brain/AGENTS.md`).

This is manual and explicit by design for v1: run it on request for one
already-captured session at a time. There is no automatic struggle
classifier and no background sync loop.

## Fixtures

`fixtures/captures.jsonl` is a sample capture log (problem: Two Sum) usable
for testing the vault tool without needing a live capture session:

```sh
node vault-tool/log-session.js --slug two-sum --log fixtures/captures.jsonl --dry-run
```

## Privacy / network scope

- The extension only talks to `leetcode.com` (the page it runs on) and
  `http://localhost:8135` (the relay server). No analytics, no third-party
  endpoints.
- The relay server binds to `127.0.0.1` only - never reachable from other
  machines on the network.
- The vault tool makes no network calls; it only reads the local capture
  log and writes to the local vault directory.

## Companion

`companion/` is a standalone terminal chat program that gives running
commentary on your LeetCode attempts as you make them, and doubles as a
normal chat session you can type into directly whenever you want.

It owns the whole conversation itself - it tails the same append-only log
the relay server writes (`relay-server/data/captures.jsonl`), and injects
each new capture into the same ongoing conversation as if you had typed and
submitted it yourself.
There is no tmux pane and no pane-scraping: it prints the real response
directly, whether it came from an injected capture or something you typed.

It supports two swappable backends, chosen with `COMPANION_BACKEND`.
Both backends are given the same tutor system prompt (defined once in
`companion.js` as `TUTOR_SYSTEM_PROMPT`) so behavior is consistent across
them: acknowledge the code, name the problem and its pattern on the first
attempt at it, describe the approach without hinting at a fix, point out
bugs via a concrete failing test case rather than a bare assertion, praise
correct solutions, and always call out time complexity against an O(n)
target - without ever handing over the optimal algorithm unless asked.
For the Claude backend, this is passed as a plain `systemPrompt` string,
which *replaces* Claude Code's own default system prompt rather than
appending to it (the SDK only preserves the default when `systemPrompt` is
the `{ type: 'preset', preset: 'claude_code' }` form) - intentional here,
since this companion runs no tools and isn't acting as a coding agent over
this repo.

### Setup

```sh
cd companion
npm install
```

This installs the one dependency the Claude backend needs
(`@anthropic-ai/claude-agent-sdk`).
The local backend needs no dependency - it talks to an OpenAI-compatible
endpoint over plain HTTP - but `npm install` still needs to run once so
`companion.js` has somewhere to resolve `node_modules` from.

### Run it

```sh
node companion/companion.js
```

One process, one command.
It prints a startup banner (backend, model, and the capture log it's
watching), then drops you into a normal chat prompt.
Type into it directly at any time - before, after, or in the middle of an
injected capture - and it sends what you typed the moment you press Enter.
A capture that arrives while you're mid-line never touches what you've
already typed; it prints above your prompt and redraws your in-progress
input afterward.
`/exit` or `/quit` (or Ctrl+C) ends the session.

Captures are only auto-injected while both the relay server and
`companion/companion.js` are running.
If either is down, captures still get durably logged to `captures.jsonl`
(by the relay server) but won't show up in the companion chat until
`companion.js` is running again to catch up on the newly appended lines -
it tracks its own byte offset into the log (in
`companion/.companion-state.json`, gitignored) so restarting it does not
replay captures it already injected.

### Backend: Claude (default)

`COMPANION_BACKEND=claude` (or unset - it's the default) drives a real
programmatic session through the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk` on npm - this is Claude Code packaged as a
library, not the `claude` CLI driven by fake keystrokes, and not the plain
Messages/Client API).
Each capture and each typed message is sent into one resumed SDK session,
the same way a real conversation would continue turn by turn.

**Credentials - read this before assuming it's free.**
This is the one genuine setup/cost difference from the old tmux design, and
it's worth stating plainly rather than glossing over:

- If `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is **not** set, the SDK
  falls back to the same OAuth login the interactive `claude` CLI uses -
  verified directly in this environment: with no key set, the SDK
  authenticated via the existing `claude` CLI login and returned a real
  response, and the result stream carried a `rate_limit_event` message
  explicitly scoped to "claude.ai subscription users."
  In other words: with no extra configuration, this behaves like the old
  tmux companion did - it piggybacks on your existing Claude Code login and
  subscription, at no additional cost beyond what that login already covers.
- If you set `ANTHROPIC_API_KEY` to a real API key, the SDK uses that key
  instead, and every capture and every message you type is billed as normal,
  metered Claude API usage on that key - separate from, and in addition to,
  your Claude Code subscription.
- Anthropic's own SDK documentation is explicit that reusing a claude.ai
  login is only sanctioned for personal use, not for a product you'd
  distribute to other people: "Unless previously approved, Anthropic does
  not allow third party developers to offer claude.ai login or rate limits
  for their products... Use the API key authentication methods described in
  the Quickstart instead."
  Since this companion is a personal script that never leaves your machine,
  the no-key default is the right choice here - just don't carry that
  assumption into anything you'd hand to someone else.

Working example (personal use, no separate billing - the default):

```sh
cd companion
npm install
node companion.js
```

Working example (separately-billed API key):

```sh
cd companion
npm install
COMPANION_BACKEND=claude \
ANTHROPIC_API_KEY=sk-ant-... \
COMPANION_MODEL=claude-opus-5 \
node companion.js
```

`COMPANION_MODEL` is optional for this backend; unset, the SDK uses its own
default model resolution (whatever the Claude Code CLI itself defaults to).

### Backend: local (Ollama or any OpenAI-compatible endpoint)

`COMPANION_BACKEND=local` talks plain HTTP to an OpenAI-compatible
chat-completions endpoint - no SDK, no extra dependency, just `fetch`.
It defaults to a local Ollama install and keeps its own in-process message
history, resending the full conversation on every turn (standard OpenAI
chat-completions shape).

Verified directly in this environment against a locally running Ollama
(`ollama list` showed `gemma3:12b` and `gemma4:26b` already pulled) - both a
raw HTTP round trip and a full round trip through `companion.js` itself
returned real model output.

```sh
# ollama pull llama3.2   # or any model you've already pulled - `ollama list` shows what's available
cd companion
npm install
COMPANION_BACKEND=local \
COMPANION_MODEL=llama3.2 \
node companion.js
```

- `COMPANION_MODEL` is **required** for this backend (there's no sane
  default across arbitrary local models) - `companion.js` exits with a clear
  error if it's missing.
- `COMPANION_BASE_URL` overrides the endpoint (default
  `http://localhost:11434/v1`, Ollama's OpenAI-compatible route).
- `COMPANION_API_KEY` is optional - most local servers ignore it, but it's
  there for endpoints that expect a bearer token even for a dummy value.

### Environment variables (reference)

| Variable                       | Applies to | Default                       |
| ------------------------------ | ---------- | ------------------------------ |
| `COMPANION_BACKEND`            | both       | `claude`                       |
| `COMPANION_MODEL`              | both       | unset (Claude); required for `local` |
| `COMPANION_BASE_URL`           | local      | `http://localhost:11434/v1`    |
| `COMPANION_API_KEY`            | local      | unset                          |
| `ANTHROPIC_API_KEY`            | claude     | unset (falls back to CLI login) |
| `LEETCODE_CAPTURES_FILE`       | both       | `relay-server/data/captures.jsonl` |
| `LEETCODE_COMPANION_STATE_FILE`| both       | `companion/.companion-state.json` |
| `LEETCODE_COMPANION_SCRATCH`   | claude     | `~/.local/state/leetcode-companion/scratch` |
| `LEETCODE_COMPANION_POLL_MS`   | both       | `1000`                         |

`LEETCODE_COMPANION_SCRATCH` mirrors the old tmux design's intent: the
Claude backend's SDK session runs with that directory as its working
directory, not this repo, so it never picks up this project's
`CLAUDE.md`/`AGENTS.md` or file tree as context.
