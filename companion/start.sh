#!/usr/bin/env bash
# companion/start.sh - ensure the leetcode-capture companion's tmux session
# is running, starting it if needed.
#
# Idempotent: if the session is already up, this is a no-op (exit 0, prints
# a message, never spawns a second session). Safe to run repeatedly, e.g.
# from a cron job or every time you sit down to leetcode.
#
# The companion is a plain interactive `claude` session with no special
# wiring - it is not a coding agent and has no write access to this repo.
# It runs from a dedicated scratch directory (not the leetcode-capture repo)
# so it never picks up this project's CLAUDE.md/AGENTS.md or file tree as
# context. companion/watch.js separately injects captured Run/Submit
# attempts into this same tmux pane as if typed by hand.
set -euo pipefail

SESSION_NAME="${LEETCODE_COMPANION_SESSION:-leetcode-companion}"
SCRATCH_DIR="${LEETCODE_COMPANION_SCRATCH:-$HOME/.local/state/leetcode-companion/scratch}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux is required but not found on PATH" >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "error: claude (Claude Code CLI) is required but not found on PATH" >&2
  exit 1
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "companion: tmux session '$SESSION_NAME' is already running, nothing to do"
  exit 0
fi

mkdir -p "$SCRATCH_DIR"

tmux new-session -d -s "$SESSION_NAME" -c "$SCRATCH_DIR" claude
echo "companion: started tmux session '$SESSION_NAME' (claude, cwd=$SCRATCH_DIR)"
echo "companion: attach with: tmux attach -t $SESSION_NAME"
