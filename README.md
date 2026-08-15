# leetcode-capture

Browser extension + local relay server that captures LeetCode editor content
on Run/Submit clicks, so live attempts (not just final solutions) are visible,
and struggle/proficiency notes can be logged back into the Obsidian vault.

## Scope (initial)

- Browser extension: hooks the LeetCode editor and Run/Submit buttons,
  captures the current code content at each click.
- Local relay server: receives captures from the extension over localhost,
  logs them.
- Vault logging: writes struggle/proficiency notes derived from captured
  attempts into the Obsidian vault.

Delivery posture: local-only (no remote, no PR pipeline).
