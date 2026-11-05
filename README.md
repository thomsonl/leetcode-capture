# Thomson's LeetCode Tutor

A browser extension that adds a Tutor tab to LeetCode problems. It gives hints and reviews your Submits, and tracks your progress.
Independent project, not affiliated with LeetCode.

## Install

```sh
git clone https://github.com/thomsonl/leetcode-capture.git
```

1. Open `chrome://extensions`, turn on Developer mode, click Load unpacked, and pick the `extension/` folder.
2. Open a problem on leetcode.com. Click the gear in the Tutor tab and choose a model.

A local model (Ollama, LM Studio) or an API key needs nothing else.

For a Claude or ChatGPT subscription, install Node, sign in to `claude` or `codex`, then run:

```sh
npx leetcode-capture-helper install --chrome-id <your extension id>
```

More in [docs/DETAILS.md](docs/DETAILS.md).
