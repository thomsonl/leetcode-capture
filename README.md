# leetcode-capture

A browser extension that captures your LeetCode Run and Submit attempts as you work, not just your final solution.
It adds a Tutor tab to the problem page, backed by an LLM of your choice, acting as a personal tutor that reviews your code live.
With a local model or an API key the tutor runs inside the extension itself, with nothing else to install (see "Runtimes" below).
With a Claude or ChatGPT subscription it runs in a companion terminal chat on your computer.
Optional add-ons can also log your progress as notes into an Obsidian vault.

## Install

With a local model or an API key you only need the browser extension: skip to "Then load the browser extension" below.
For a Claude or ChatGPT subscription, pick your OS and run its commands first.

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

Chrome prints a warning about `background.scripts` when it loads the repo folder, because the manifest lists that key for Firefox.
For a warning-free Chrome folder, run `node extension/scripts/build.mjs --browser chrome --out <dir>` and load `<dir>` instead.
It copies only the files the browser needs and drops `background.scripts` from the copy; `--browser firefox` copies the manifest unchanged.

## Runtimes

The tutor runs in one of two places, chosen per provider on the settings page ("Where the tutor runs").

- **In the browser** (the extension runtime) is the default for a local model, an Anthropic API key and an OpenAI API key.
  The extension's own background worker runs the tutor: it talks to the model directly, reads your Runs and Submits from the page, and streams replies into the Tutor tab.
  Nothing else needs to be installed or running: no Node, no relay, no companion.
  Settings and API keys are kept in the extension's storage (`chrome.storage.local`), and a key is only ever sent to its provider's API.
  The conversation lives in the worker's memory only, and nothing is written to disk (no `captures.jsonl`).
- **Through the helper** (the companion, see "Start the companion" below) is required for the Claude and ChatGPT subscriptions, because they use the sign-in of the `claude` or `codex` command on your computer.
  Any other provider can use it too, which also gives you the terminal chat and the vault auto-summary.

Who needs what:

| You use | Runtime | Install |
| --- | --- | --- |
| A local model (Ollama, LM Studio, any OpenAI-compatible server) | In the browser | The extension only |
| An Anthropic or OpenAI API key | In the browser | The extension only |
| A Claude or ChatGPT subscription | Through the helper | The extension, Node, the companion and the helper (see "Helper") |

The browser asks you once per server before the extension may reach it: Save, Test connection and Find models request that site's permission (`optional_host_permissions`), so the extension holds no broad host access by default.
If you deny it, the settings page says so and nothing is saved.

**Ollama in the browser runtime.**
Ollama only answers browser extensions it is told to trust, so set `OLLAMA_ORIGINS` to the extension's origin where Ollama runs and restart Ollama (the settings page shows the exact value, for example `OLLAMA_ORIGINS=chrome-extension://<id>`).
On Linux with the systemd service that is `systemctl edit ollama.service` with `Environment="OLLAMA_ORIGINS=chrome-extension://<id>"`; on macOS, `launchctl setenv OLLAMA_ORIGINS chrome-extension://<id>`.
Without it Ollama answers 403 (or the browser reports a network error), and both the settings page's test and the Tutor tab say exactly this.

The browser runtime follows the same rules as the companion: the same tutor instructions, the same "What the tutor is sent" rules and reset on a problem switch, the same context fitting and summary for a small local window.
The code for both lives once, in `extension/shared/`, which the companion imports.

## Helper (subscription providers)

The Claude and ChatGPT subscriptions need the companion and relay on your computer.
The helper lets the extension start and stop them for you, so you never open a terminal for them.
It is a small program plus a registration file that tells your browser where it is (Native Messaging), not a second extension.
It needs Node 18 or newer.
The npm package carries its own copy of the companion and relay, so `npx leetcode-capture-helper install` needs no checkout of this repository.
It does not include either subscription's own program:

- The Claude subscription needs Claude Code installed and signed in (`claude`, then `/login`) as the same user.
- The ChatGPT subscription needs the `codex` CLI installed separately and signed in (`codex login`).

1. In the extension's settings, choose Claude subscription or ChatGPT subscription.
2. In the Helper section, press "Allow starting the helper" and accept the browser's prompt (the `nativeMessaging` permission, only asked for here).
3. Copy the install command the Helper section shows and run it in a terminal, then press "Check again".
   On Chrome, Chromium, Edge and Brave the command carries the extension's id, for example `npx leetcode-capture-helper install --chrome-id <id>`; on Firefox it is `npx leetcode-capture-helper install`.

From then on:

- The tutor starts when you open a LeetCode problem, and keeps running while at least one problem tab is open, even in the background.
- It stops 30 seconds after you close the last problem tab; opening one again within those 30 seconds keeps it running with the conversation intact.
- If you close the tab of the problem you were working on while other problem tabs stay open, the tutor forgets that conversation after 30 seconds but keeps running.
- If the browser crashes, the helper, the companion and the relay stop on their own within a few minutes, so nothing is left holding port 8135.
- A companion you start by hand (`leetcode`) still works; the helper sees the relay already running and leaves it alone.

`npx leetcode-capture-helper status` shows what is registered where, and `npx leetcode-capture-helper uninstall` removes exactly what install wrote.

What install writes, for your user only and without admin rights:

- A copy of the helper in `~/.local/share/leetcode-capture-helper` (Linux), `~/Library/Application Support/leetcode-capture-helper` (macOS) or `%LOCALAPPDATA%\leetcode-capture-helper` (Windows), with a small script that runs it with the `node` you installed it with.
- A registration file in each browser's `NativeMessagingHosts` folder (on Windows, in that folder plus a value under `HKCU\Software\...\NativeMessagingHosts`), for the browsers it finds; `--browser chrome,firefox` picks them yourself.
- The helper runs the companion and relay from the copy inside the npm package, wherever npm put it.
  With `npx` that is npm's npx cache: if you clear the cache, run the install command again (status and the Helper section say when the files are gone).
  For a copy that stays put, run `npm install -g leetcode-capture-helper` and then `leetcode-capture-helper install`.
- The capture log and the companion's state go in `app/data/` inside that data folder, not in the package.

From a checkout of this repository, `node helper/cli.js install --chrome-id <id>` runs the companion and relay from that checkout instead (with `npm install` done in `companion/`), and `--root <folder>` names another LeetCode Capture folder.
The name `leetcode-capture-helper` was free on npm on 2026-10-29 and has not been published yet; until it is, use the checkout command above.

To build the package: `npm pack` in `helper/` copies the companion, relay, `extension/shared/` and `vault-tool/vault-notes.js` (no tests, no data) into `helper/runtime/` first (`scripts/pack.mjs`, run by `prepack`), and fails if anything they import is missing or is not a dependency of the helper package; `postpack` removes the copy again, so those folders stay the only source.
`npm run e2e:packed` in `helper/` checks the result for real: it packs, extracts, installs the dependencies, installs into a temporary home and starts the registered host with a fake browser on stdio (`--link-deps` uses the checkout's `node_modules` instead of `npm install`, for working offline).
The Chrome id of an unpacked copy is shown in the Helper section and on `chrome://extensions`; set the published store ids in `helper/config.js` (`CHROME_EXTENSION_IDS`) once they exist, so the plain command works for everyone.
The helper's log, with the companion's and relay's output, is `app/helper.log` inside that data folder.

## Start the companion

This is the helper runtime; skip it if the tutor runs in the browser.

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
Plain `leetcode` uses whatever provider you picked on the settings page (see below), or the Claude subscription if you have not picked one.
`leetcode -local`, `-claude`, `-anthropic`, `-openai` or `-chatgpt` uses that provider for this run only, by setting `COMPANION_BACKEND`, so the settings page shows the provider as locked until you restart without the flag.

## Tutor tab on LeetCode

The extension adds a **Tutor** tab to the left tab strip on every problem page, next to Description, Submissions, Editorial, and Solutions.
Each Submit the tutor reviews shows up as a small chip (Runs and unchanged Submits show nothing), the tutor's replies stream in, and you can type to it from the page.
In the helper runtime it mirrors the companion's terminal chat, and the two stay in sync (a message typed in the page appears in the terminal under a `[panel]` label).
In the browser runtime it talks to the extension's background worker over a port instead of the relay, and a reload replays the conversation from the worker.

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
For a provider that runs in the browser the page works on its own; for one that runs through the helper, the companion must be running for the page to load or save its fields.

The providers:

- **Claude subscription** (the default): your Claude Code sign-in (Pro or Max). Run `claude` once to sign in.
- **Anthropic API key**: pay as you go with a key from console.anthropic.com.
- **Local model**: Ollama, LM Studio or any OpenAI-compatible server on your machine, with its address, model name and context window (see "Local model backend" below).
- **OpenAI API key**: pay as you go with a key from platform.openai.com, or any OpenAI-compatible service at another address.
- **ChatGPT subscription** (experimental): your Codex CLI sign-in (`codex login`). It has only been tested against a stand-in for `codex`, not a real ChatGPT account.

"Test connection" sends one short prompt with what is on the page, without saving anything.
"Save" checks that the choice can work, writes it, and switches the tutor over between turns, never in the middle of a reply.
The new model carries on the same conversation, with the problem statement and your current code.
The page also has the auto-clear and vault options described below.

### Switching models from the Tutor tab

The model name in the Tutor tab's header is a menu, like LeetCode's language selector.
It lists the models saved on the settings page under "Models in the Tutor tab", where you can add several per provider (for example two local models and a Claude model), name, reorder and remove them, and choose the default.
Each model uses its provider's saved server, key and runtime.
Choosing one in the menu switches with one click: the light shows "Switching" until a reply that is already running has finished, then the next message goes to the new model with the whole chat, the problem statement and your current code.
A model that cannot be used right now (no API key saved, the browser has not allowed the server yet, the helper app is not set up or not running) is shown greyed out with the reason.
"Manage models..." at the bottom opens the settings page.
Moving between a model that runs in the browser and one that runs through the helper starts that runtime's own session, since the two keep separate conversations.

The tab only ever sees each model's name, provider and model id, never a key or a server address.
In the helper runtime the tab asks the relay (`POST /panel/switch-profile` with just the model's id), and the companion accepts only an id it already has saved, which changes nothing but which saved model is in use.
So a script on leetcode.com can at most switch between models you saved yourself.
The extension keeps the whole list; the companion keeps the ones that run through it, sent with each save.
Settings saved before this existed become one saved model, the default.

In the browser runtime, settings and keys are saved in the extension's storage (two separate records, so a key never travels with anything else), and the page only ever gets back whether a key is saved.
In the helper runtime, settings are saved in `~/.config/leetcode-capture/settings.json` (`%APPDATA%` on Windows, or the path in `LEETCODE_CAPTURE_SETTINGS`), readable only by you (mode 0600).
API keys are kept only in that file and in the companion's memory, and are sent only to the provider you picked.
The settings page never gets a key back, only whether one is saved and where it came from.
The subscription providers remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY` from the environment they run with, so a stray key can never bill you instead of your subscription.

Environment variables still work and win over the saved settings, one field at a time: `COMPANION_BACKEND` (the provider id: `claude`, `anthropic`, `local`, `openai` or `chatgpt`), `COMPANION_MODEL`, `COMPANION_BASE_URL`, `COMPANION_API_KEY`, `COMPANION_LOCAL_NUM_CTX`, `COMPANION_LOCAL_MAX_HISTORY_TURNS`, `COMPANION_AUTO_CLEAR_CONTEXT` and `VAULT_AUTO_SUMMARY`.
A field set that way is locked on the page, which names the variable.
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are used for their providers when no key is saved.

The page talks to the relay at `POST /settings/rpc`, which only answers the extension's own pages (an `Origin` of `chrome-extension://<id>` or `moz-extension://<id>`, plus the same `Host` check as the panel routes), so neither leetcode.com nor any other website can read or change your settings.
The relay passes each call to the companion over its existing connection and waits up to two minutes for the answer.
Settings are never typed into the Tutor tab itself, because scripts on leetcode.com can see what is typed into the page.

## Progress

The settings page has a **Progress** tab (open it with `#progress`, or "See your progress" in the Tutor tab) that tracks a problem list of your choice.
It is a picture only and changes no setting.
"Working on" at the top picks the list: NeetCode 150 (the default; the expanded Blind 75, also called Blind 150), Blind 75, Grind 75 (its default eight week schedule), LeetCode's Top Interview 150 or LeetCode's SQL 50.
The choice is kept in the extension's local storage (`activeProgressList`) and drives the whole tab and the Tutor tab's card.
NeetCode 150 is drawn as its roadmap: the 18 topics as a graph with the prerequisite lines, each node with its solved count.
Every other list is drawn as its own groups (categories, weeks or sections, as the list's publisher groups it) in the publisher's order, each card with its solved count and a part per difficulty; the next group is simply the first one not finished.
The topic or group and the problem to do next are marked.
Clicking a topic or group opens a side panel with its prerequisites (or the group before it) and a table of its problems (status, star, a link to the problem on leetcode.com, difficulty).
Every list refers to one shared catalog of problems (`extension/shared/catalog.js`), so a problem solved once counts in every list that has it.

A problem counts as solved when LeetCode accepts one of your submissions on its page.
The extension watches the page's own request for the judge's verdict (`/submissions/detail/<id>/v2/check/`, or the older `/<id>/check/`, an all-digit id with `state` "SUCCESS" and `status_msg` "Accepted"; a Run's check is ignored) and reads nothing else from it.
This works whichever runtime runs the tutor, and needs nothing running besides the browser.
For problems you solved before installing, click the status mark in a topic's or group's table; click it again to unmark any problem.
Solved problems (`solvedProblems`: slug, time, count), stars (`starredProblems`) and the chosen list (`activeProgressList`) are kept in the extension's local storage and never sent anywhere.
Changing the list never changes the solved problems.

After an accepted submission the Tutor tab shows a short card: "Nice job completing <problem>", the next problem on the list you work on ("Next up on Blind 75") and one more of the same topic or group, as ordinary links.
The newest card also has a small "Working on" menu that switches lists right there, and the card follows.
The tab builds it from the bundled lists; it is never sent to the tutor and never enters its context.
For a problem that is not on the chosen list, the card offers only that list's next problem.

## Optional features

- **Local model backend.**
  Run entirely against a local model instead of Claude, with any OpenAI-compatible server (Ollama, LM Studio, llama.cpp server, vLLM, text-generation-webui, LocalAI and others) and any model: pick "Local model" on the settings page, or run `COMPANION_MODEL=<model> COMPANION_BACKEND=local node companion.js` (or `COMPANION_MODEL=<model> leetcode -local` with the launcher, which takes the model from the settings page when `COMPANION_MODEL` is unset).
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
  These features are experimental: star ratings are LLM estimates, and existing topic proficiency scores are kept without sending LeetCode topic tags to the model.
