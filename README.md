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

Each problem has its own transcript.
A message you type in the terminal before your first Run or Submit stays in the terminal, since it belongs to no problem's transcript yet.

### What the tutor is sent

- A Run (the button or Ctrl+') is never sent to the tutor on its own. It is recorded as the newest code for that problem, and its chip says "Kept for your next message".
- A Submit is sent automatically, but only if the code changed since the tutor last saw it. Otherwise the tab notes that it was unchanged and nothing is sent.
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

## Optional features

- **Local model backend.**
  Run entirely against a local Ollama model instead of Claude: install Ollama, `ollama pull <model>`, then run `COMPANION_MODEL=<model> COMPANION_BACKEND=local node companion.js` (or `leetcode -local` with the launcher).
  A handful of env vars (`COMPANION_LOCAL_MAX_HISTORY_TURNS`, `COMPANION_LOCAL_NUM_CTX`, `COMPANION_LOCAL_RESERVE_TOKENS`, `COMPANION_LOCAL_API`) tune context-window limits for smaller local models; the defaults work for most.

- **Auto-clear context on problem switch.**
  On by default: starting a new problem resets the tutor's memory so an old problem doesn't linger as context forever.
  Disable with `COMPANION_AUTO_CLEAR_CONTEXT=0`.

- **Obsidian vault integration (experimental).**
  Logs your attempts as notes into an Obsidian vault.
  Run `vault-tool/log-session.js` to manually log the current problem's session (the capture log is cleared once you move on), or set `VAULT_AUTO_SUMMARY=1` to have the companion turn every Submit into a vault note automatically as you go.
  Point either at your own vault via `vault.config.json` (copy `vault.config.example.json`) or the `VAULT_PATH`/`VAULT_ALGORITHMS_SUBFOLDER` env vars.
  These features are experimental: the star ratings and proficiency scores they write are LLM assumptions.
