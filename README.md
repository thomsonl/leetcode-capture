# Thomson's LeetCode Tutor

A browser extension that adds a Tutor tab to LeetCode problems. It gives hints and reviews your Submits, and tracks your progress.
Independent project, not affiliated with LeetCode.

## Install

The easy way: clone the repo and run the install script. It adds the extension to Chrome from the Web Store and sets up the helper for Claude and ChatGPT subscriptions. It needs Node.

```sh
git clone https://github.com/thomsonl/leetcode-capture.git
cd leetcode-capture
sh install.sh
```

On Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`.
Then restart Chrome and click Enable.

## Install by hand

You need Node and Git.

```sh
git clone https://github.com/thomsonl/leetcode-capture.git
cd leetcode-capture
node extension/scripts/build.mjs --browser chrome
```

The last command prints where it put the Chrome build: the `dist/chrome` folder in the repo.
In PowerShell, git and npm print some normal progress in red (for example `NativeCommandError` or `npm warn exec`); that is not an error.

1. Open `chrome://extensions`, turn on Developer mode, click Load unpacked, and pick the `dist/chrome` folder.
   (The repo's own `extension/` folder also loads, but Chrome then shows a Warnings button about `background.scripts`, a key only Firefox uses; it is harmless.)
2. Open a problem on leetcode.com and click the Tutor tab.
   Chrome may ask whether leetcode.com may "access other apps and services on this device".
   Choose Allow: the page only talks to the tutor at `localhost:8135`, nothing else on your network.
3. Click the gear in the Tutor tab to open Settings, and choose a model.
   A local model (Ollama, LM Studio) or an API key needs nothing else: fill it in and press Save.
4. For a Claude or ChatGPT subscription, first sign in to `claude` or `codex` in a terminal.
   Choose the subscription in Settings, press "Allow starting the helper" in the Helper section, and choose Allow when Chrome asks.
   The extension restarts once to finish this; Settings and any open LeetCode tabs come back by themselves.
5. The Helper section now shows the install command, with your extension id filled in:

   ```sh
   npx leetcode-capture-helper install --chrome-id <your extension id>
   ```

   Run it in a terminal, press Check again, and once the Helper says Running, press Save.
