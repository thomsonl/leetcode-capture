# Installs Thomson's LeetCode Tutor for Chrome on Windows:
# the extension (from the Chrome Web Store) and the helper for Claude and ChatGPT subscriptions.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Stop"

$ExtId = "klolbndoiokcflamiielknjgoojjkbdc"
$UpdateUrl = "https://clients2.google.com/service/update2/crx"

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is needed first: https://nodejs.org"
  exit 1
}

# The extension: Chrome installs it from the Web Store and asks you to turn it on.
$key = "HKCU:\Software\Google\Chrome\Extensions\$ExtId"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "update_url" -Value $UpdateUrl
Write-Host "Extension added for Chrome."

# The helper: lets the extension start the tutor for a Claude or ChatGPT subscription.
npx --yes leetcode-capture-helper install --chrome-id $ExtId

Write-Host ""
Write-Host "Done. Restart Chrome and click Enable when it says a new extension was added."
