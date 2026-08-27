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
The alternate screen buffer has no native scrollback of its own, so the companion keeps its own: scroll the mouse wheel to move a real, application-level viewport back through the full conversation (not just what currently fits on screen), and scroll back down to return to the live view - typing a message or a new capture arriving always snaps you back to live first. Press **Page Up** at any time to instead open the same full history in `less`, with normal `less` navigation (arrows, Page Up/Down, `/` to search, `q` to return) - useful for searching or for a terminal that doesn't support mouse reporting.
The input box (a thin rule above a `>` prompt) stays pinned at the bottom of the screen, and the tutor's markdown (headers, bold, lists, fenced code blocks) renders - wrapped to a comfortable reading width rather than the terminal's full width - instead of showing raw syntax.
Resizing the terminal window is picked up live - the box's rule and any markdown rendered afterward immediately track the new size (still capped at the comfortable width on a wide terminal).
A short spinner shows while waiting on the backend; once a reply starts, it opens with a `•` marker, and exactly one blank line separates each turn from the next.
Replies also stream in as the backend generates them rather than appearing all at once - except a Submit turn with vault auto-summary on (see below), which always waits for the complete reply before showing anything, since the machine-readable block it strips off the end can only be identified once the reply is whole.
Colors are skipped automatically when output isn't a terminal (piped to a file or another program) or when `NO_COLOR` is set - output stays plain, undecorated text in both cases, and replies print as one block instead of streaming (a pipe has no use for incremental display).
When a capture arrives for a different problem than the one you were just discussing, the companion automatically clears its own context (a fresh Claude session, or a truncated history for the local backend) before processing it, so an old problem's code and discussion don't keep getting resent as context forever - a dim `companion: new problem detected ... clearing tutor context` line prints when this happens. On by default; set `COMPANION_AUTO_CLEAR_CONTEXT=0` (or `false`/`no`) to turn it off if you'd rather the tutor keep full cross-problem context itself.

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

The local backend resends its whole conversation history on every turn (the standard way to hold a multi-turn chat against an OpenAI-compatible endpoint), which can exhaust a small local model's context window over a long single-problem conversation.
To keep that bounded, it also trims history to the most recent `COMPANION_LOCAL_MAX_HISTORY_TURNS` Run/Submit exchanges (default 6) once a problem's conversation grows past that, dropping the oldest exchanges first.
This is separate from `COMPANION_AUTO_CLEAR_CONTEXT` above, which clears everything on a problem switch - this bound applies within one still-current problem.
Set `COMPANION_LOCAL_MAX_HISTORY_TURNS=0` to disable trimming and go back to unbounded history, or raise it if your model/server has enough context to spare.

Separately, even a *single* capture with no prior history at all can be big enough to exceed a small model's context window by itself - a long problem description plus a real submission can already be more than the model has room for, especially once it starts "thinking" about it.
The standard OpenAI-compatible endpoint (`/v1/chat/completions`) has no way to ask for a bigger context window - Ollama's own native chat API (`/api/chat`) does, via a `num_ctx` option.
`COMPANION_LOCAL_API` controls which one the companion uses: `auto` (the default) uses Ollama's native API automatically when `COMPANION_BASE_URL` is still pointed at Ollama's own default address, and the standard endpoint otherwise, so pointing this at some other OpenAI-compatible server keeps working exactly as before.
Set it explicitly to `openai` or `native` to override that choice.
`COMPANION_LOCAL_NUM_CTX` (default 8192) sets the context window requested when the native API is in use - raise it if an unusually large capture still gets cut off.
