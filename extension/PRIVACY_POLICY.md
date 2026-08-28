# Privacy Policy — LeetCode Capture

**Status: DRAFT.** This describes the browser extension's actual, current behavior as implemented in this repository.
It hasn't been reviewed or approved by Thomson yet.
Review it, edit it as needed, and remove this notice before submitting it as part of an AMO listing.

## What this extension does

LeetCode Capture is a personal development tool.
It watches for you clicking Run or Submit (or using the Run/Submit keyboard shortcuts) on a `leetcode.com/problems/*` page, reads the code currently in the editor, and sends it to a local server running on your own computer.

## What data is read

When you Run or Submit, the extension reads:

- The problem's slug, title, description, and topic tags, all from the LeetCode page you're already viewing.
- The language currently selected in the editor.
- The code currently in the editor.
- The URL of the page and a timestamp.

## Where that data goes

This data is sent to exactly one place: `http://localhost:8135`, a server that runs on your own machine as part of this same project (`relay-server/`).
The extension makes no other network requests.
It does not send data to the developer, to Mozilla, to any analytics or tracking service, or to any third party.
`localhost` still counts as network transmission for the purposes of this policy and Mozilla's data collection disclosure requirements, which is why this extension declares a data collection permission for website content even though the data never leaves your own computer through the extension itself.

## What happens to the data after that

The relay server writes each capture to a local log file on your computer (`relay-server/data/captures.jsonl`).
From there, two other components in this same project, both optional and both run separately by you:

- `vault-tool/`, a command-line tool that can turn captures into notes in a local Obsidian vault you specify. This never leaves your computer.
- `companion/`, an optional AI tutor you can run alongside your LeetCode session. If you configure and run it, it sends capture content to whichever LLM backend you've configured it to use, either a cloud provider such as Anthropic (using your own API credentials) or a locally-running model. This is the only path by which captured code or problem content could leave your computer, and it only happens if you separately install, configure, and run this component.

The browser extension itself never talks to any of these components directly. It only writes to the local relay server.

## Data retention and control

All data stays in files on your own computer (the relay server's log file, and, if you use it, your Obsidian vault). You control deletion by deleting those files directly. Nothing is stored by the developer.

## Changes

Since this is a personal tool with source available in this repository, any change to what data is read or where it is sent will be visible in `extension/content.js`'s change history.
