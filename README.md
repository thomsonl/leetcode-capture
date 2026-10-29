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
Your Run/Submit clicks on LeetCode show up in that chat as they happen.
Type `/exit` (or press Ctrl+C) to quit.

Optional shortcut: symlink the launcher once (`ln -s "$(pwd)/bin/leetcode" ~/.local/bin/leetcode`), then just run `leetcode` from anywhere instead of the three commands above.

## Tutor tab on LeetCode

With the companion running, the extension adds a **Tutor** tab to the left tab strip on every problem page, next to Description, Submissions, Editorial, and Solutions.
It mirrors the same conversation you see in the terminal: your Run and Submit attempts show up as they happen, the tutor's replies stream in, and you can type to it from the page.
The terminal chat keeps working exactly as before, and the two stay in sync (a message typed in the page appears in the terminal under a `[panel]` label).

Each problem has its own transcript.
If you ask a question about a different problem than the one the tutor was last discussing, it is told which problem you are looking at, and the tutor session resets first if `COMPANION_AUTO_CLEAR_CONTEXT` is on.
When you come back to a problem you already ran code for in this session, the tutor is told so and gets that problem's description again.
A message you type in the terminal before your first Run or Submit stays in the terminal, since it belongs to no problem's transcript yet.
If the companion isn't running, the tab says so instead of failing silently.
If the relay restarts, the tab marks the break with "Session restarted" and carries on with the new session.
Set `COMPANION_PANEL=0` to turn the bridge off.

The first time the page talks to the relay, Chrome may ask whether leetcode.com can connect to devices on your local network.
Allow it, since the relay is on your own machine (`localhost:8135`).
Nothing is sent anywhere else.

The relay's panel routes only answer requests whose `Host` is its own loopback address and whose `Origin`, if any, is `https://leetcode.com`, because unlike capture ingestion they can read your code back.
Publishing tutor replies and reading the messages you type are reserved for the companion: those routes refuse every request a web page can make, including leetcode.com itself (see `companionOnlyRejection` in `relay-server/panel-broker.js`).

## Optional features

- **Local model backend.**
  Run entirely against a local Ollama model instead of Claude: install Ollama, `ollama pull <model>`, then run `COMPANION_MODEL=<model> COMPANION_BACKEND=local node companion.js` (or `leetcode -local` with the launcher).
  A handful of env vars (`COMPANION_LOCAL_MAX_HISTORY_TURNS`, `COMPANION_LOCAL_NUM_CTX`, `COMPANION_LOCAL_RESERVE_TOKENS`, `COMPANION_LOCAL_API`) tune context-window limits for smaller local models; the defaults work for most.

- **Auto-clear context on problem switch.**
  On by default: starting a new problem resets the tutor's memory so an old problem doesn't linger as context forever.
  Disable with `COMPANION_AUTO_CLEAR_CONTEXT=0`.

- **Obsidian vault integration (experimental).**
  Logs your attempts as notes into an Obsidian vault.
  Run `vault-tool/log-session.js` to manually log a past session, or set `VAULT_AUTO_SUMMARY=1` to have the companion turn every Submit into a vault note automatically as you go.
  Point either at your own vault via `vault.config.json` (copy `vault.config.example.json`) or the `VAULT_PATH`/`VAULT_ALGORITHMS_SUBFOLDER` env vars.
  These features are experimental: the star ratings and proficiency scores they write are LLM assumptions.
