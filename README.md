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

### 3. (optional) Install the `leetcode` launcher

```sh
mkdir -p ~/.local/bin
ln -s "$(pwd)/bin/leetcode" ~/.local/bin/leetcode
```

```sh
leetcode         # Claude backend (default)
leetcode -local  # local Ollama backend
```

### Configure the local model

Before using the local backend, set `COMPANION_MODEL` to a model you've already pulled (`ollama pull <model>`, `ollama list` to check).

macOS/Linux (bash/zsh): `export COMPANION_MODEL=llama3.2`

Windows PowerShell: `$env:COMPANION_MODEL="llama3.2"`

Windows cmd: `set COMPANION_MODEL=llama3.2`
