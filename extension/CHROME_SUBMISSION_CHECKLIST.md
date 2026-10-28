# Chrome Web Store submission checklist

Nothing has been submitted yet.
The Chrome Web Store Developer Dashboard can't be driven by browser automation, so every dashboard step below is done by hand.
Each field below has text ready to paste.

## Before you start

- Register at https://chrome.google.com/webstore/devconsole with your Google account.
  There is a one-time $5 registration fee, paid with your own payment details.
- The package needs `manifest.json` at the zip root.
  `npm run build:amo` already produces exactly that (`manifest.json`, `content.js`, `inject.js`, `icons/`).
- A repeated version number is rejected, so bump `version` in `manifest.json` for every later upload.
  The first upload can stay at 1.0.0.

## Files to upload

| What | Where | Notes |
|---|---|---|
| Extension zip | Package tab | `extension/web-ext-artifacts/leetcode_capture-<version>.zip` after `npm run build:amo` |
| Store icon, 128x128 PNG | Store listing tab | `extension/icons/icon-128.png` |
| Screenshot, 1280x800 or 640x400 | Store listing tab | At least one, up to five. Take it on real leetcode.com in your own browser. |
| Small promo tile, 440x280 | Store listing tab | Optional |

The icon source is `design/icon.svg`.
It is a placeholder, so swap it for real artwork whenever you have it.

## Store listing tab

**Name:** LeetCode Capture

**Summary (max 132 characters):**
Captures your LeetCode Run and Submit attempts and sends them to a local server on your own computer.

**Description:**

```
LeetCode Capture records each Run and Submit attempt you make on LeetCode, not just your final solution.

It reads the code in the editor, the problem title, description and topic tags, and the selected language, then sends them to a relay server running on your own computer (localhost:8135). Nothing is sent to the developer or any third party by the extension.

This extension is one part of a local toolchain. It needs the companion relay server from the project's GitHub repository running on your machine. Without it, captures have nowhere to go. The optional companion tutor and Obsidian note-logging tools build on those captures.

Run and Submit are captured from button clicks and from the keyboard shortcuts Ctrl/Cmd+' (Run) and Ctrl/Cmd+Enter (Submit).

Source code, setup instructions and the privacy policy: https://github.com/thomsonl/leetcode-capture
```

**Category:** Developer Tools

**Language:** English

**Homepage URL:** https://github.com/thomsonl/leetcode-capture

**Support URL:** https://github.com/thomsonl/leetcode-capture/issues

## Privacy tab

**Single purpose description:**

```
Capture the code and problem details from a user's LeetCode Run and Submit attempts and send them to a relay server on the user's own computer.
```

**Permission justifications:**

- Host permission `http://localhost:8135/*`:
  `The extension sends each captured attempt to a relay server the user runs on their own machine at localhost:8135. This permission lets the content script's fetch() reach that local server without being blocked by CORS. It is the only host the extension sends data to.`
- Content script on `https://leetcode.com/problems/*`:
  `The extension's entire purpose is reading the code editor and problem content on LeetCode problem pages when the user clicks Run or Submit. It runs on no other pages.`
- Web accessible resource `inject.js` (matches `https://leetcode.com/*`):
  `inject.js runs in the page's own context so it can read the full text of LeetCode's Monaco editor model. Reading the rendered DOM instead silently truncates long solutions, because Monaco only renders the lines on screen. The pattern is broader than the content script's pattern because Chrome rejects the extension outright when the two patterns are identical.`

**Remote code:** No, I am not using remote code.
All code ships in the package (`content.js`, `inject.js`).

**Data usage, what the extension handles:**

- Check **Website content** (problem text and the user's code in the editor).
- Leave every other category unchecked.
  The extension does not collect personally identifiable information, health, financial, authentication, location, web history, or user activity data.

**Data usage certifications (check all three):**

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:**
https://github.com/thomsonl/leetcode-capture/blob/main/extension/PRIVACY_POLICY.md

This URL only resolves once the Chrome store prep PR is merged to `main`.

## Distribution tab

- **Visibility:** Unlisted is a good first pass.
  The extension does nothing useful without the local relay server, so a public listing may confuse people who install it cold.
  Switch to Public later if the install story improves.
- **Regions:** All regions.

## Submit

1. Upload the zip on the Package tab and fix any manifest errors it reports.
2. Fill the Store listing, Privacy, and Distribution tabs with the text above.
3. Click Submit for review.
4. Expect a few days for review.
   A first submission can take longer.
   A reviewer may ask why a localhost host permission is needed, and the justification above is the answer.

## After approval

- Point the README's Chrome install steps at the store listing.
- Bump `version` before the next upload.
