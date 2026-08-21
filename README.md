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
`/exit` or `/quit` (or Ctrl+C) ends the session and, in a real terminal, restores the screen to exactly what was on it before the companion started - nothing from the session stays in your scrollback.

In a real terminal, the companion runs in the terminal's alternate screen buffer (the same mechanism vim/less/htop use) - your shell's prior scrollback is hidden while it runs and comes back untouched when you quit, and pressing Enter on an empty line is ignored rather than adding a blank line.
The input box (a thin rule above a `>` prompt) stays pinned at the bottom of the screen, and the tutor's markdown (headers, bold, lists, fenced code blocks) renders - wrapped to a comfortable reading width rather than the terminal's full width - instead of showing raw syntax.
Resizing the terminal window is picked up live - the box's rule and any markdown rendered afterward immediately track the new size (still capped at the comfortable width on a wide terminal).
A short spinner shows while waiting on the backend; once a reply starts, it opens with a `•` marker, and exactly one blank line separates each turn from the next.
Replies also stream in as the backend generates them rather than appearing all at once - except a Submit turn with vault auto-summary on (see below), which always waits for the complete reply before showing anything, since the machine-readable block it strips off the end can only be identified once the reply is whole.
Colors are skipped automatically when output isn't a terminal (piped to a file or another program) or when `NO_COLOR` is set - output stays plain, undecorated text in both cases, and replies print as one block instead of streaming (a pipe has no use for incremental display).

### 3. (optional) Install the `leetcode` launcher

```sh
mkdir -p ~/.local/bin
ln -s "$(pwd)/bin/leetcode" ~/.local/bin/leetcode
```

```sh
leetcode         # Claude backend (default)
leetcode -local  # local Ollama backend
```

### Configure the vault

`vault-tool/log-session.js` and the companion's vault auto-summary feature (`VAULT_AUTO_SUMMARY=1`, see below) both write into an Obsidian vault.
By default they use Thomson's own vault, at `~/Documents/My Brain`, with algorithm notes under its `Study/Algorithms` subfolder - no configuration is needed to reproduce that setup.

To point either tool at a different vault, copy `vault.config.example.json` to `vault.config.json` at the repo root (gitignored, since it holds a personal absolute path) and fill in your own values:

```json
{
  "vaultPath": "/absolute/path/to/your/vault",
  "algorithmsSubfolder": "Study/Algorithms"
}
```

Both keys are optional; a missing key falls back to the next source below.
Precedence, highest first:

1. Environment variables: `VAULT_PATH` and `VAULT_ALGORITHMS_SUBFOLDER`.
2. `vault.config.json`'s `vaultPath` and `algorithmsSubfolder`.
3. Built-in defaults (Thomson's own vault and subfolder, above).

`log-session.js`'s `--vault <path>` CLI flag outranks all of the above for that one invocation.

If the resolved vault path doesn't exist, both tools fail with a clear error naming the exact path instead of silently creating a new folder tree there.

### Configure the local model

Before using the local backend, set `COMPANION_MODEL` to a model you've already pulled (`ollama pull <model>`, `ollama list` to check).

macOS/Linux (bash/zsh): `export COMPANION_MODEL=llama3.2`

Windows PowerShell: `$env:COMPANION_MODEL="llama3.2"`

Windows cmd: `set COMPANION_MODEL=llama3.2`
