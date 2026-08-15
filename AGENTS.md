# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Four components, each self-contained with no shared build tooling: `extension/` (MV3 content script, no build step - loads unpacked in Chrome, and as a temporary add-on in Firefox/Zen via `about:debugging#/runtime/this-firefox`; carries `browser_specific_settings.gecko.id` for Firefox), `relay-server/` (plain Node `http`, no deps), `vault-tool/` (Node CLI, no deps), `companion/` (tmux + Claude Code CLI, no deps). See `README.md` for setup/usage of all four.
- The extension reads Monaco's code via DOM (`.monaco-editor .view-lines`), not the `monaco` JS global - avoids needing a page-context injection. If LeetCode's DOM structure changes, this is the first place to check.
- The problem description is read from `[data-track-load="description_content"]` (an analytics hook attribute, more stable than LeetCode's generated class names - verified against live `leetcode.com/problems/*` pages). `#qd-content` also matches but additionally picks up tab labels and other page chrome, so it's avoided.
- The relay server rebuilds its per-problem `attemptSeq` counter from the existing log file on startup, so restarts don't reset sequence numbers. Log format is one JSON object per line at `relay-server/data/captures.jsonl` (gitignored).
- `vault-tool/log-session.js` matches a problem slug to a vault topic note by searching `Study/Algorithms/*.md` for a link containing `/problems/<slug>/`; falls back to creating a per-problem note under `Study/Algorithms/Problems/`. See `~/Documents/My Brain/AGENTS.md` for vault conventions.
- `fixtures/captures.jsonl` is a sample capture log for exercising the vault tool without a live capture session (`--dry-run` to preview without writing).
- `companion/watch.js` injects multi-line text into its tmux pane via `tmux load-buffer` +
  `paste-buffer` (bracketed paste), never raw `send-keys` of a string containing embedded
  newlines - the latter sends each `\n` as its own Enter and both truncates the message and
  mangles code indentation.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
