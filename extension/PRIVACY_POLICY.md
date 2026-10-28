# Privacy Policy for LeetCode Capture

Last updated: 2026-10-27

## What this extension does

LeetCode Capture is a personal development tool.
It watches for you clicking Run or Submit (or using the Run/Submit keyboard shortcuts) on a `leetcode.com/problems/*` page, reads the code currently in the editor, and sends it to a local server running on your own computer.

## What data is read

When you Run or Submit, the extension reads:

- The problem's slug, title, description, and topic tags, all from the LeetCode page you're already viewing.
- The language currently selected in the editor.
- The code currently in the editor.
- The URL of the page and a timestamp.

The extension reads nothing on any page outside `leetcode.com/problems/*`.
It does not read your LeetCode account details, cookies, or credentials.

## Where that data goes

This data is sent to exactly one place: `http://localhost:8135`, a server that runs on your own machine as part of this same project (`relay-server/`).
The extension makes no other network requests.
It does not send data to the developer, to the browser vendor, to any analytics or tracking service, or to any third party.
`localhost` still counts as network transmission for the purposes of store data disclosure requirements, which is why this extension declares that it handles website content even though the data never leaves your own computer through the extension itself.

## What happens to the data after that

The relay server writes each capture to a local log file on your computer (`relay-server/data/captures.jsonl`).
From there, two other components in this same project, both optional and both run separately by you:

- `vault-tool/`, a command-line tool that can turn captures into notes in a local Obsidian vault you specify. This never leaves your computer.
- `companion/`, an optional AI tutor you can run alongside your LeetCode session. If you configure and run it, it sends capture content to whichever LLM backend you've configured it to use, either a cloud provider such as Anthropic (using your own API credentials) or a locally-running model. This is the only path by which captured code or problem content could leave your computer, and it only happens if you separately install, configure, and run this component.

The browser extension itself never talks to any of these components directly.
It only writes to the local relay server.

## Data sale and use

The developer does not collect, sell, or transfer your data to anyone, and does not use it for advertising, creditworthiness, or any purpose unrelated to the extension's single purpose of capturing your LeetCode attempts for your own local use.

## Data retention and control

All data stays in files on your own computer (the relay server's log file, and, if you use it, your Obsidian vault).
You control deletion by deleting those files directly.
Nothing is stored by the developer.

## Changes

Since this is a personal tool with source available at https://github.com/thomsonl/leetcode-capture, any change to what data is read or where it is sent will be visible in `extension/content.js`'s change history.

## Contact

Questions about this policy can be raised as an issue at https://github.com/thomsonl/leetcode-capture/issues.
