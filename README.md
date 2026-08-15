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
- `companion/` - a standing tmux + Claude Code session that gives running
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

Each log line includes the problem slug/title, language, code content at
click time, trigger (`"run"` or `"submit"`), the extension's timestamp, a
server-assigned `receivedAt` timestamp, and a per-problem monotonic
`attemptSeq` that survives server restarts (rebuilt from the existing log
file on startup).

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
`### Capture session: <date>` block. It looks for an existing
`Study/Algorithms/<Topic>.md` note in the vault whose `## LeetCode Problems`
section links to that problem, and appends there. If no matching topic note
exists, it creates `Study/Algorithms/Problems/<Problem Title>.md` following
the vault's note conventions (see `~/Documents/My Brain/AGENTS.md`).

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

`companion/` is a live, standing Claude Code session that gives running
commentary on your LeetCode attempts as you make them, and doubles as a
normal chat session you can type into directly whenever you want.

It works by tailing the same append-only log the relay server writes
(`relay-server/data/captures.jsonl`) and injecting each new capture into a
dedicated tmux pane as a chat message, as if you had typed and submitted it
yourself.

**Start it:**

```
companion/start.sh
```

This creates a tmux session named `leetcode-companion` running an
interactive `claude` session from a plain scratch directory (not this repo).
It is idempotent - running it again while the session is already up is a
no-op.

**Attach and use it:**

```
tmux attach -t leetcode-companion
```

You can type into this session directly at any time, before, after, or
between injected captures - it's a real interactive `claude` session, not a
one-way feed. Detach with the usual tmux prefix + `d` without stopping it.

**Run the watcher:**

```
node companion/watch.js
```

This tails `relay-server/data/captures.jsonl` for new Run/Submit captures
and injects each one into the `leetcode-companion` pane, formatted with the
problem title/slug, language, trigger (Run vs Submit), and the captured
code. It tracks its own offset into the log so restarting it does not replay
captures it already injected.

**Notes:**

- Captures are only auto-injected while both the relay server and
  `companion/watch.js` are running. If either is down, captures still get
  durably logged to `captures.jsonl` (by the relay server) but won't show up
  in the companion pane until `watch.js` is running again to catch up on
  the newly appended lines.
- This is a real Claude Code session, not a free or local model - every
  injected capture and every message you type into it consumes normal
  Claude usage for a response, the same as any other Claude Code session.
