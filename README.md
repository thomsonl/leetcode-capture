# leetcode-capture

A browser extension that captures your LeetCode Run and Submit attempts as you work, not just your final solution.
It streams each attempt to a companion terminal chat backed by an LLM of your choice, acting as a personal tutor that reviews your code live.
Optional add-ons can also log your progress as notes into an Obsidian vault.

## Install

Pick your OS, then run its commands.

**macOS**
```sh
brew install node
curl -fsSL https://claude.ai/install.sh | bash
```

**Linux**
```sh
sudo apt install nodejs npm   # or your distro's package manager
curl -fsSL https://claude.ai/install.sh | bash
```

**Windows (PowerShell)**
```powershell
winget install OpenJS.NodeJS.LTS
irm https://claude.ai/install.ps1 | iex
```

Then load the browser extension.

**Chrome:** open `chrome://extensions`, enable "Developer mode", click "Load unpacked", and select the `extension/` folder.
**Firefox:** open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", and select `extension/manifest.json`.

Open any `leetcode.com/problems/<slug>/` page to confirm it loaded.

## Start the companion

```sh
cd companion
npm install
node companion.js
```

That's it.
It starts a local relay server automatically and drops you into a chat.
Your Run/Submit clicks on LeetCode show up in that chat as they happen (see "What the tutor is sent" below for which ones reach the tutor).
Type `/exit` (or press Ctrl+C) to quit.

Optional shortcut: symlink the launcher once (`ln -s "$(pwd)/bin/leetcode" ~/.local/bin/leetcode`), then just run `leetcode` from anywhere instead of the three commands above.

## Tutor tab on LeetCode

With the companion running, the extension adds a **Tutor** tab to the left tab strip on every problem page, next to Description, Submissions, Editorial, and Solutions.
It mirrors the same conversation you see in the terminal: your Run and Submit attempts show up as small chips as they happen, the tutor's replies stream in, and you can type to it from the page.
The terminal chat keeps working exactly as before, and the two stay in sync (a message typed in the page appears in the terminal under a `[panel]` label).

The header shows a small status light: green with "Connected" while the tutor is idle, yellow with "Processing" while it works on a message or Submit (including one waiting behind another), red with "Offline" when the relay can't be reached, and grey while connecting or with the tutor offline.

Each problem has its own transcript.
A message you type in the terminal before your first Run or Submit stays in the terminal, since it belongs to no problem's transcript yet.

### What the tutor is sent

- A Run (the button or Ctrl+') is never sent to the tutor on its own. It is recorded silently as the newest code for that problem.
- A Submit is sent automatically, but only if the code changed since the tutor last saw it. Otherwise nothing is sent and nothing changes in the tab.
- When you send a message from the Tutor tab, the tab reads the live editor and sends it along. If the code changed since the tutor last saw it, your message goes with a diff (line numbered, with a little context), not the whole code again. If nothing changed, your message goes as typed.
- The live code goes along only if it fits the relay's limits (100,000 characters of code, 50,000 of problem statement, 256 KB for the whole message). Code past that is never cut short: the message goes without any code and the tab says so.
- A message typed in the terminal cannot read the editor, so it uses the newest recorded Run or Submit instead.
- Code is only ever read from the editor itself, never guessed. If the tab cannot read your editor, a Run or Submit is not recorded at all and a message goes without code, and the Tutor tab says "Couldn't read your editor, so the tutor has not seen this code."
- The tutor gets the full code once, the first time (and again after a reset), and whenever a diff would be almost as long as the code itself.
- What the tutor holds is tracked in memory only, and only counts once a reply came back, so a failed call never makes the companion think the tutor saw code it did not.

The active problem is whichever one you last sent a message, Run or Submit from.
Activity on a different problem resets the tutor (with `COMPANION_AUTO_CLEAR_CONTEXT` on, the default): its context, the code it held, and the old problem's chat kept by the relay are all dropped, and the new problem starts with its statement and your latest code.
`relay-server/data/captures.jsonl` is only a short-lived queue from the relay to the companion, not an archive.
The part the companion has already handled is cleared when the companion starts, when you move to another problem, and once it passes 4 MB (`LEETCODE_CAPTURES_TRIM_BYTES`).
A Run or Submit that has not been handled yet is never cleared, including the one that switched problems.
The relay does the clearing itself, so a capture that arrives at the same moment is still delivered exactly once.
If the relay writes a different file than the companion reads (only one of `CAPTURE_LOG_PATH` and `LEETCODE_CAPTURES_FILE` set), it refuses and the companion prints a warning.
If the companion isn't running, the tab says so instead of failing silently.
If the relay restarts, the tab marks the break with "Session restarted" and carries on with the new session.
If the companion quits in the middle of a reply (Ctrl+C, a crash, its terminal closed), that reply stops typing and says the tutor stopped before it finished, in every open tab and in any tab opened later.
Set `COMPANION_PANEL=0` to turn the bridge off.

The first time the page talks to the relay, Chrome may ask whether leetcode.com can connect to devices on your local network.
Allow it, since the relay is on your own machine (`localhost:8135`).
Nothing is sent anywhere else.

The relay's panel routes only answer requests whose `Host` is its own loopback address and whose `Origin`, if any, is `https://leetcode.com`, because unlike capture ingestion they can read your code back.
Publishing tutor replies and reading the messages you type are reserved for the companion: those routes refuse every request a web page can make, including leetcode.com itself (see `companionOnlyRejection` in `relay-server/panel-broker.js`).

## Settings

The extension has a settings page where you choose which LLM the tutor uses.
Open it with the gear in the Tutor tab's header (the tab also names the model it is using there), or from the extension's "Options" in `chrome://extensions` or `about:addons`.
The companion must be running for the page to load or save anything.

The providers:

- **Claude subscription** (the default): your Claude Code sign-in (Pro or Max). Run `claude` once to sign in.
- **Anthropic API key**: pay as you go with a key from console.anthropic.com.
- **Local model**: Ollama, LM Studio or any OpenAI-compatible server on your machine, with its address, model name and context window (see "Local model backend" below).
- **OpenAI API key**: pay as you go with a key from platform.openai.com, or any OpenAI-compatible service at another address.
- **ChatGPT subscription** (experimental): your Codex CLI sign-in (`codex login`). It has only been tested against a stand-in for `codex`, not a real ChatGPT account.

"Test connection" sends one short prompt with what is on the page, without saving anything.
"Save" checks that the choice can work, writes it, and switches the tutor over between turns, never in the middle of a reply.
The new model starts a fresh conversation and gets your full code with your next message.
The page also has the auto-clear and vault options described below.

Settings are saved in `~/.config/leetcode-capture/settings.json` (`%APPDATA%` on Windows, or the path in `LEETCODE_CAPTURE_SETTINGS`), readable only by you (mode 0600).
API keys are kept only in that file and in the companion's memory, and are sent only to the provider you picked.
The settings page never gets a key back, only whether one is saved and where it came from.
The subscription providers remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY` from the environment they run with, so a stray key can never bill you instead of your subscription.

Environment variables still work and win over the saved settings, one field at a time: `COMPANION_BACKEND` (the provider id: `claude`, `anthropic`, `local`, `openai` or `chatgpt`), `COMPANION_MODEL`, `COMPANION_BASE_URL`, `COMPANION_API_KEY`, `COMPANION_LOCAL_NUM_CTX`, `COMPANION_LOCAL_MAX_HISTORY_TURNS`, `COMPANION_AUTO_CLEAR_CONTEXT` and `VAULT_AUTO_SUMMARY`.
A field set that way is locked on the page, which names the variable.
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are used for their providers when no key is saved.

The page talks to the relay at `POST /settings/rpc`, which only answers the extension's own pages (an `Origin` of `chrome-extension://<id>` or `moz-extension://<id>`, plus the same `Host` check as the panel routes), so neither leetcode.com nor any other website can read or change your settings.
The relay passes each call to the companion over its existing connection and waits up to two minutes for the answer.
Settings are never typed into the Tutor tab itself, because scripts on leetcode.com can see what is typed into the page.

## Optional features

- **Local model backend.**
  Run entirely against a local model instead of Claude, with any OpenAI-compatible server (Ollama, LM Studio, llama.cpp server, vLLM, text-generation-webui, LocalAI and others) and any model: pick "Local model" on the settings page, or run `COMPANION_MODEL=<model> COMPANION_BACKEND=local node companion.js` (or `leetcode -local` with the launcher).
  The server address (`COMPANION_BASE_URL`) is the server's OpenAI-compatible root (default `http://localhost:11434/v1`, Ollama's), and an API key (`COMPANION_API_KEY`) is sent as a bearer token if the server needs one.
  The context window settings (the defaults work for most):
  - The context window (the settings page's "Context window (tokens)", or `COMPANION_LOCAL_NUM_CTX`; default 8192) is the most the companion budgets for, and what Ollama is asked for through its native API.
  - `COMPANION_LOCAL_API` is `auto` (default), `openai` or `native`.
    With `auto` the companion asks the server once at startup whether it is Ollama (`GET /api/version`) and uses Ollama's native chat API only if it is, at any address or port, since that is the only API that honors a requested window; anything else uses the standard OpenAI-compatible API.
    Set it explicitly to skip the guess.
  - At startup the companion also asks the server for the model's real window where it can: Ollama (`/api/show`, and `/api/ps` for a loaded model on the OpenAI-compatible API), LM Studio (`/api/v0/models`), llama.cpp server (`/props`) and vLLM (`/v1/models`).
    It budgets for the smaller of that and the configured window.
    Every probe has a short timeout and is ignored if it fails, so an unknown server just uses the configured window.
  - On any server, if a reply reports far fewer prompt tokens than were sent (under 70 percent), the server silently cut the prompt to fit a smaller window: the companion prints one warning and budgets for the window the server really kept from then on.
  - `COMPANION_LOCAL_RESERVE_TOKENS` (default 2600) is held back for the model's thinking and answer; the prompt gets the rest.
  - Each request is fitted to that budget by condensing the oldest whole exchanges into one short "earlier in this session" summary (about 300 tokens at most), like Claude Code's `/compact`; the problem statement, your code and the current message are never condensed.
    `COMPANION_LOCAL_MAX_HISTORY_TURNS` (default 6, 0 for no cap) also caps how many exchanges are kept whole, and the ChatGPT (Codex) backend condenses past that cap the same way.
    The summary comes from one quiet call to the same model, with a one-line-per-exchange digest when that call fails, and nothing is shown for it; it lives in memory only and a reset or a change of model clears it.
    A message is refused, with what is too big named, only if the statement, code and that message alone are over the budget.

- **Auto-clear context on problem switch.**
  On by default: starting a new problem resets the tutor's memory so an old problem doesn't linger as context forever.
  Turn it off on the settings page or with `COMPANION_AUTO_CLEAR_CONTEXT=0`.

- **Obsidian vault integration (experimental).**
  Logs your attempts as notes into an Obsidian vault.
  Run `vault-tool/log-session.js` to manually log the current problem's session (the capture log is cleared once you move on), or turn on the vault auto-summary on the settings page (or set `VAULT_AUTO_SUMMARY=1`) to have the companion turn every Submit into a vault note automatically as you go.
  Point either at your own vault via `vault.config.json` (copy `vault.config.example.json`) or the `VAULT_PATH`/`VAULT_ALGORITHMS_SUBFOLDER` env vars.
  These features are experimental: the star ratings and proficiency scores they write are LLM assumptions.
