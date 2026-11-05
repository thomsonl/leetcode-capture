#!/bin/sh
# Installs Thomson's LeetCode Tutor for Chrome on macOS and Linux:
# the extension (from the Chrome Web Store) and the helper for Claude and ChatGPT subscriptions.
# Usage: sh install.sh
set -eu

EXT_ID="klolbndoiokcflamiielknjgoojjkbdc"
UPDATE_URL="https://clients2.google.com/service/update2/crx"

if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "Node.js is needed first: https://nodejs.org" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) DIRS="$HOME/Library/Application Support/Google/Chrome/External Extensions|$HOME/Library/Application Support/Chromium/External Extensions" ;;
  *) DIRS="$HOME/.config/google-chrome/External Extensions|$HOME/.config/chromium/External Extensions" ;;
esac

# The extension: Chrome installs it from the Web Store and asks you to turn it on.
found=0
OLD_IFS=$IFS
IFS='|'
for dir in $DIRS; do
  parent=$(dirname "$dir")
  if [ -d "$parent" ]; then
    mkdir -p "$dir"
    printf '{ "external_update_url": "%s" }\n' "$UPDATE_URL" > "$dir/$EXT_ID.json"
    echo "Extension added for: $parent"
    found=1
  fi
done
IFS=$OLD_IFS
if [ "$found" = 0 ]; then
  echo "Chrome was not found. Open it once, then run this again." >&2
  exit 1
fi

# The helper: lets the extension start the tutor for a Claude or ChatGPT subscription.
npx --yes leetcode-capture-helper install --chrome-id "$EXT_ID"

echo
echo "Done. Restart Chrome and click Enable when it says a new extension was added."
