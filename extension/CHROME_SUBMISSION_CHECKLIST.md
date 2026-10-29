# Chrome Web Store submission checklist

Nothing has been submitted yet, as far as this repository records.
The Chrome Web Store Developer Dashboard can't be driven by browser automation, so every dashboard step below is done by hand.
Each field below has text ready to paste.
The listing text, single purpose and permission justifications are shared with Firefox, so `AMO_SUBMISSION_CHECKLIST.md` points back here for them.

## Version

`manifest.json` is at `1.2.0`, and that is the suggested version for this upload.
The store only requires each upload to carry a higher version than the last one, so no bump is needed for a first submission.
If an earlier capture-only build was ever uploaded under `1.2.0` or higher, bump to `1.3.0` before uploading.

## What changed since the store-prep version

The earlier store drafts described a capture-only extension that sent Run and Submit attempts to a relay on `localhost:8135`.
This release is a tutor:

- A Tutor tab on every LeetCode problem page, next to Description and Submissions, where replies stream in and the student can type to the tutor.
- An options page (Settings) to pick the provider and where the tutor runs.
- An in-browser runtime: the extension's background worker talks directly to a local model server, or to the OpenAI or Anthropic API with the student's own key.
- An optional helper runtime for the Claude and ChatGPT subscriptions, through a separately installed Native Messaging helper that starts the local companion and relay.
- New optional permissions, requested at runtime only: host access to the one model server the student configures, and `nativeMessaging` for the helper.
- The `storage` permission, for the settings and API keys.
- A new manifest description.

## Before you start

- Register at https://chrome.google.com/webstore/devconsole with your Google account.
  There is a one-time $5 registration fee, paid with your own payment details.
- The package needs `manifest.json` at the zip root.
  `npm run build:amo` produces exactly the shipped files (`manifest.json`, `background.js`, `content.js`, `inject.js`, `panel.js`, `settings.html`, `settings.css`, `settings.js`, `shared/*.js`, `icons/icon-*.png`) and leaves tests, docs and screenshots out.
- Run `npm test` and `npm run lint:amo` in `extension/` first.

## Files to upload

| What | Where | Notes |
|---|---|---|
| Extension zip | Package tab | `extension/web-ext-artifacts/leetcode_capture-<version>.zip` after `npm run build:amo` |
| Store icon, 128x128 PNG | Store listing tab | `extension/icons/icon-128.png` |
| Screenshots, 1280x800 or 640x400 | Store listing tab | At least one, up to five. See "Screenshots" below. |
| Small promo tile, 440x280 | Store listing tab | Optional |

The icon source is `design/icon.svg`.
It is a placeholder, so swap it for real artwork whenever you have it.

## Screenshots

Take these on real leetcode.com in your own browser (Cloudflare blocks automated browsers there), at 1280x800:

1. The Tutor tab open beside a problem, with a Submit chip and a streamed reply.
2. The student typing a question in the Tutor tab, with the "Connected" status light.
3. The Settings page with the provider list and "Where the tutor runs".
4. Optional: the Settings page's Helper section, for the subscription providers.

Keep any API key field empty or masked in the shots.

## Store listing tab

**Name:** LeetCode Capture

**Summary (max 132 characters, same as the manifest description):**

```
A LeetCode tutor that coaches you on your Run and Submit attempts, using a local model, your own API key or your subscription.
```

**Description:**

```
LeetCode Capture adds a Tutor tab to every LeetCode problem page. It sees each Run and Submit you make, not just your final solution, and coaches you toward the answer with hints and questions instead of handing you code.

How it works
- Open a problem and click the Tutor tab, next to Description and Submissions.
- Run or Submit as usual. Your attempts show up as chips, and the tutor reacts to Submits.
- Type to the tutor at any time. Your message carries the code currently in the editor, so you never paste it.
- Each problem keeps its own conversation.

Pick your model in Settings
- A local model (Ollama, LM Studio, llama.cpp or any OpenAI-compatible server). Nothing leaves your computer.
- Your own OpenAI or Anthropic API key. Requests go straight from your browser to that provider.
- Your Claude or ChatGPT subscription, through an optional helper program you install on your computer. The helper starts and stops the tutor for you while a LeetCode tab is open.

Privacy
- Your code and the problem text go only to the provider you choose.
- API keys stay in the browser's extension storage and are only sent to their own provider.
- No analytics, no ads, no tracking, no remote code, and nothing is sent to the developer.
- The browser asks before the extension may reach your model server or start the helper.

Run and Submit are captured from button clicks and from the keyboard shortcuts Ctrl/Cmd+' (Run) and Ctrl/Cmd+Enter (Submit).

LeetCode Capture is an independent project and is not affiliated with LeetCode.

Source code, setup instructions and the privacy policy: https://github.com/thomsonl/leetcode-capture
```

**Category:** Education (this release is a tutor; the earlier draft used Developer Tools)

**Language:** English

**Homepage URL:** https://github.com/thomsonl/leetcode-capture

**Support URL:** https://github.com/thomsonl/leetcode-capture/issues

## Privacy tab

**Single purpose description:**

```
Tutor the user on the LeetCode problem they are solving: read their code and the problem when they Run, Submit or message the tutor, and send it only to the AI model provider they chose.
```

**Permission justifications:**

- `storage`:
  `Saves the user's tutor settings (chosen provider, model, server address) and, if they enter one, their own OpenAI or Anthropic API key, in the browser's local extension storage. Nothing is synced or sent anywhere from storage.`
- Optional `nativeMessaging`:
  `Only requested when the user chooses a Claude or ChatGPT subscription and presses "Allow starting the helper" in Settings. It lets the extension start and stop a helper program the user installed themselves, which runs the tutor on their own computer.`
- Host permission `http://localhost:8135/*`:
  `The local relay server that the optional helper starts runs on the user's own computer at localhost:8135. The extension sends Run and Submit attempts and Tutor messages to it, and reads the tutor's replies and settings from it, only when the helper runtime is in use.`
- Optional host permissions `http://*/*` and `https://*/*`:
  `Never granted at install. When the user saves a provider in Settings, the extension asks for exactly one origin: their local model server's address (for example localhost:11434 or a machine on their network), https://api.openai.com or a custom OpenAI-compatible address, or https://api.anthropic.com. The broad pattern exists only because the model server's address is whatever the user types.`
- Content scripts on `https://leetcode.com/problems/*`:
  `The extension's purpose is tutoring on LeetCode problem pages: it adds the Tutor tab there and reads the problem and the user's editor code when they Run, Submit or message the tutor. It runs on no other pages.`
- Web accessible resource `inject.js` (matches `https://leetcode.com/*`):
  `inject.js runs in the page's own context so it can read the full text of LeetCode's Monaco editor model, because the rendered editor only contains the lines on screen. The pattern is broader than the content script's because Chrome rejects the extension when the two are identical.`

**Remote code:** No, I am not using remote code.
All JavaScript ships in the package; model replies are rendered as text, never executed.

**Data usage, what the extension handles:**

- Check **Website content** (the problem text and the user's code in the editor).
- Check **Personal communications** (the messages the user types to the tutor).
- Check **Authentication information** (the user's own OpenAI or Anthropic API key, kept in local extension storage and sent only to that provider).
- Leave every other category unchecked.
  The extension does not collect personally identifiable information, health, financial, location, web history, or user activity data.

**Data usage certifications (check all three):**

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:**
https://github.com/thomsonl/leetcode-capture/blob/main/extension/PRIVACY_POLICY.md

This URL only shows the new policy once `settings-integration` is merged to `main`.

## Distribution tab

- **Visibility:** Public now works for the browser runtime, which needs nothing else installed.
  Unlisted is still a safe first pass while the helper is unpublished on npm.
- **Regions:** All regions.

## Manual steps only you can do

1. Merge `settings-integration` to `main`, so the privacy policy URL serves the new policy.
2. Take the screenshots above on real leetcode.com.
3. Run `npm run build:amo` in `extension/` and upload the zip.
4. Fill the Store listing, Privacy and Distribution tabs with the text above, then Submit for review.
5. After approval, copy the store extension id from the dashboard into `helper/config.js` (`CHROME_EXTENSION_IDS`), so `npx leetcode-capture-helper install` works without `--chrome-id`.
6. Check that the npm name `leetcode-capture-helper` is free, then publish the helper with `npm publish` from `helper/` (the README still says it is a placeholder; update that line once it is live).
7. Point the README's Chrome install steps at the store listing.

Expect a few days for review, longer for a first submission or for the broad optional host pattern.
If a reviewer asks about it, the justification above is the answer: nothing is granted at install, and the user approves one origin at a time.

## After approval

- Bump `version` before the next upload.
