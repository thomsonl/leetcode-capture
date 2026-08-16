# leetcode-capture

A browser extension and local relay server that capture LeetCode editor content on Run/Submit clicks, so live attempts (not just final solutions) are visible.
A vault tool and companion program turn captured sessions into struggle/proficiency notes logged back into an Obsidian vault.
The companion also gives running commentary on attempts as they happen and doubles as a normal chat session.

## Requirements

- **Node.js**
  - macOS: `brew install node`
  - Linux: use your distro's package manager (e.g. `sudo apt install nodejs npm` on Debian/Ubuntu) or https://nodejs.org
  - Windows: `winget install OpenJS.NodeJS.LTS` or the installer from https://nodejs.org
- **Claude Code** (the `claude` CLI) - the companion's default backend uses the Claude Agent SDK, which relies on an installed, logged-in `claude` CLI.
  - macOS/Linux: `curl -fsSL https://claude.ai/install.sh | bash`
  - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
  - Or via npm on any OS: `npm install -g @anthropic-ai/claude-code`
- **Ollama** (optional, only for the local backend, `COMPANION_BACKEND=local`)
  - macOS: `brew install ollama` or https://ollama.com/download
  - Linux: `curl -fsSL https://ollama.com/install.sh | sh`
  - Windows: installer from https://ollama.com/download

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

### Use a local model instead

By default the companion talks to Claude Code.
To use a local model via Ollama instead, set `COMPANION_BACKEND=local` and `COMPANION_MODEL` to a model you've already pulled (`ollama pull <model>`, `ollama list` to check).

macOS/Linux (bash/zsh):

```sh
COMPANION_BACKEND=local COMPANION_MODEL=llama3.2 node companion.js
```

Windows PowerShell:

```powershell
$env:COMPANION_BACKEND="local"; $env:COMPANION_MODEL="llama3.2"; node companion.js
```

Windows cmd:

```cmd
set COMPANION_BACKEND=local && set COMPANION_MODEL=llama3.2 && node companion.js
```

To switch back to Claude, just omit `COMPANION_BACKEND` (or set it to `claude`) and run `node companion.js` as usual.

### Relay server (manual/standalone use)

The companion starts and stops the relay server for you.
To run it standalone instead:

```sh
cd relay-server
node server.js
```

It listens on `http://127.0.0.1:8135` and logs captures to `relay-server/data/captures.jsonl`.
