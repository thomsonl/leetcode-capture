# leetcode-capture

A browser extension and local relay server that capture LeetCode editor content on Run/Submit clicks, so live attempts (not just final solutions) are visible.
A vault tool and companion program turn captured sessions into struggle/proficiency notes logged back into an Obsidian vault.
The companion also gives running commentary on attempts as they happen and doubles as a normal chat session.

## Requirements

- Node.js.
- An LLM CLI: the companion's default backend uses the Claude Agent SDK, which relies on an installed, logged-in `claude` CLI (Claude Code).
- The companion also supports a local backend via Ollama (`COMPANION_BACKEND=local`) if you don't want to use the Claude CLI.

## Setup

### 1. Load the extension

Chrome:

1. Open `chrome://extensions`.
2. Enable "Developer mode".
3. Click "Load unpacked" and select the `extension/` directory.

Firefox or Zen Browser:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select `extension/manifest.json`.

Open any `leetcode.com/problems/<slug>/` page to confirm it loaded.

### 2. Install and run the companion

```sh
cd companion
npm install
node companion.js
```

This starts the relay server automatically and drops you into a chat prompt.
Run/Submit clicks on a LeetCode problem page are injected into the chat as they happen.
`/exit` or `/quit` (or Ctrl+C) ends the session.

### 3. Log a captured session into the vault (optional)

```sh
node vault-tool/log-session.js --slug two-sum --note "Brute force first, then hashmap trick." --accepted
```

Options: `--slug`, `--log`, `--vault`, `--note`, `--accepted`, `--dry-run`.
See `vault-tool/log-session.js` for details.

### Relay server (manual/standalone use)

The companion starts and stops the relay server for you.
To run it standalone instead:

```sh
cd relay-server
node server.js
```

It listens on `http://127.0.0.1:8135` and logs captures to `relay-server/data/captures.jsonl`.
