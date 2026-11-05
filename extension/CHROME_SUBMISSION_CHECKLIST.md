# Chrome Web Store submission checklist

Nothing has been submitted yet, as far as this repository records.
Every dashboard field below has final text ready to paste.
The listing text, single purpose and permission justifications are shared with Firefox, so `AMO_SUBMISSION_CHECKLIST.md` points back here for them.

## Version

`manifest.json` is at `1.2.0`, and that is the version for this upload.
The repository records no earlier store upload (the store-prep commits only drafted text), so no bump is needed.
The store only requires each upload to carry a higher version than the last one; bump before any later upload.

## Must be done before you press Submit

1. Merge `settings-integration` to `main` and push, so the privacy policy URL below serves the current policy.
   Today that URL still serves the older capture-only policy.
2. Publish the helper to npm (`npm publish` from `helper/`, after checking the name `leetcode-capture-helper` is still free).
   Until it is published, the options page's install command (`npx leetcode-capture-helper install`) fails, so the Claude and ChatGPT subscription paths do not work for a store user.
   If you submit before publishing it, paste the "Description without the subscription line" variant below instead.
3. Run `npm test` and `npm run lint:amo` in `extension/`.
4. Run `npm run build:chrome` in `extension/` and upload `extension/web-ext-artifacts/leetcode_capture-chrome-1.2.0.zip`.
   That is the chrome build of `scripts/build.mjs` (no `background.scripts`, which Chrome warns about), zipped with `manifest.json` at the root.
   `npm run build:amo` makes the Firefox package and is not the one to upload here.

## What changed since the store-prep version

The earlier store drafts described a capture-only extension that sent Run and Submit attempts to a relay on `localhost:8135`.
This release is a tutor:

- A Tutor tab on every LeetCode problem page, next to Description and Submissions, where replies stream in and the student can type to the tutor.
- An options page (Settings) to pick the provider and where the tutor runs.
- An in-browser runtime: the extension's background worker talks directly to a local model server, or to the OpenAI or Anthropic API with the student's own key.
- An optional helper runtime for the Claude and ChatGPT subscriptions, through a separately installed Native Messaging helper that starts the local companion and relay.
- New optional permissions, requested at runtime only: host access to the one model server the student configures, and `nativeMessaging` for the helper.
- The `storage` permission, for the settings, API keys and solved problems.
- Progress tracking and "Practice a skill" suggestions, built from lists and LeetCode's public problem metadata bundled in the package (`shared/catalog.js`, `shared/roadmap.js`, `shared/problem-index.js`); no new permission and no network use for them.
- A new manifest description.

## Files to upload

| What | Where | Notes |
|---|---|---|
| Extension zip | Package tab | `extension/web-ext-artifacts/leetcode_capture-chrome-1.2.0.zip` after `npm run build:chrome` |
| Store icon, 128x128 PNG | Store listing tab | `extension/store-assets/store-icon-128.png` (96x96 artwork with 16 px of transparent padding, as the store's image guidelines ask) |
| Screenshots, 1280x800 | Store listing tab | The four `extension/store-assets/shot-*.png`, in order (captions below) |
| Small promo tile, 440x280 | Store listing tab | `extension/store-assets/promo-small-440x280.png` |

`extension/icons/icon-128.png` (in the zip) is a valid 128x128 RGBA PNG, full bleed, used by Chrome itself; the padded copy is only for the listing.
Both come from `design/icon.svg`.
The store's guidelines ask promo tiles to avoid text; the tile carries only the name and a short tagline.

## Screenshots and captions

The dashboard shows screenshots in upload order.
If it offers a caption or description field for a screenshot, paste these; otherwise they only fix the order.

1. `shot-1-tutor-hint.png`:
   `Ask for a hint in the Tutor tab and get a question that points the way, not the answer.`
2. `shot-2-practice-skill.png`:
   `Practice a skill: three problems near your level, with problems you solved left out.`
3. `shot-3-progress.png`:
   `Track your progress through NeetCode 150, Blind 75, Grind 75 and other lists, with the next problem to work on.`
4. `shot-4-settings.png`:
   `Choose the model: a local model, your own OpenAI or Anthropic key, or your Claude or ChatGPT subscription.`

## Store listing tab

**Name:** `LeetCode Capture`

See "Decisions" at the end about the trademark in the name.

**Summary (129 characters, max 132; it is the manifest `description`):**

```
A tutor for LeetCode problems: hints and Submit reviews from a local model, your API key or subscription, plus progress tracking.
```

**Description:**

```
LeetCode Capture adds a Tutor tab to each problem page on leetcode.com. It sees each Run and Submit you make and the code in your editor, and coaches you with hints and questions instead of handing you the answer. It gives a full solution only when you ask for one.

Tutor
- Open a problem and click the Tutor tab, next to Description and Submissions.
- Ask for a hint, ask why your code fails, or ask about its complexity. Your message carries the code currently in the editor, so you never paste it.
- When you Submit, the tutor reviews that attempt. Runs are noted but not sent.
- Each problem keeps its own conversation.

Progress
- When a submission is accepted, the problem is marked solved and a short card suggests what to try next.
- The Progress page shows how far you are through NeetCode 150, NeetCode 250, Blind 75, Grind 75, Top 100 Liked, Top Interview 150 or SQL 50, and which problem comes next. You can also mark problems solved or starred by hand.

Practice a skill
- Pick a skill such as hash maps, two pointers or dynamic programming and get three problems near your level, chosen from problem data that ships with the extension. Problems you solved are left out.

Choose your model in Settings
- A local model through Ollama, LM Studio, llama.cpp or any OpenAI-compatible server. Your code stays on your computer. Small local models give weaker hints and reviews than large hosted models.
- Your own OpenAI or Anthropic API key. Requests go straight from your browser to that provider and are billed to your key.
- Your Claude or ChatGPT subscription, through a free helper program you install on your computer (it needs Node.js). The helper starts the tutor while a problem tab is open and stops it after you close the last one.

Privacy
- Your code, the problem text and your messages go only to the provider you choose.
- API keys stay in the browser's extension storage and are only sent to their own provider.
- Solved problems and progress stay in your browser and are never sent anywhere.
- No analytics, no ads, no tracking, no remote code, and nothing is sent to the developer.
- The browser asks before the extension may reach your model server or start the helper.

Run and Submit are noticed from the buttons and from the keyboard shortcuts Ctrl/Cmd+' (Run) and Ctrl/Cmd+Enter (Submit).

This is an independent project. It is not affiliated with or endorsed by LeetCode.

Source code, setup help and the privacy policy: https://github.com/thomsonl/leetcode-capture
```

"LeetCode" appears twice above, plus leetcode.com and the repository address (the store counts more than five repeats of a keyword as spam).

**Description without the subscription line** (only if the helper is not yet on npm): paste the block above with the third bullet under "Choose your model in Settings" removed.

**Category:** Education

**Language:** English

## Additional fields (Store listing tab)

**Homepage URL:** https://github.com/thomsonl/leetcode-capture

**Support URL:** https://github.com/thomsonl/leetcode-capture/issues

**Mature content:** No

## Privacy practices tab

**Single purpose description:**

```
Tutor the user on the LeetCode problem they are solving: read the problem and their code when they Run, Submit or message the tutor and send it only to the AI model provider they chose, and track which problems they solved so it can show their progress and suggest what to practice next.
```

**Permission justifications:**

- `storage`:

  ```
  Saves the user's tutor settings (chosen provider, model, server address), their own OpenAI or Anthropic API key if they enter one, the problems they solved or starred, the problem list they work on, and where they placed the Tutor tab, in the browser's local extension storage. Nothing is synced or sent anywhere from storage.
  ```

- `nativeMessaging` (optional, never granted at install):

  ```
  Only requested when the user chooses a Claude or ChatGPT subscription and presses "Allow starting the helper" in Settings. It lets the extension start and stop a helper program the user installed themselves, which runs the tutor on their own computer with their own sign-in.
  ```

- Host permission `http://localhost:8135/*`:

  ```
  The optional helper runs a relay server on the user's own computer at localhost:8135. In the helper runtime the extension sends Run and Submit attempts and Tutor messages to it and reads the tutor's replies and settings from it. While no provider is chosen, the Tutor tab only checks whether a tutor the user started from a terminal answers there. It is a fixed loopback address, never a remote server.
  ```

- Optional host permissions `http://*/*` and `https://*/*`:

  ```
  Never granted at install. When the user saves or tests a provider in Settings, the extension asks for exactly one origin: their local model server's address (for example localhost:11434 or a machine on their network), https://api.openai.com or a custom OpenAI-compatible address, or https://api.anthropic.com. The broad pattern exists only because the model server's address is whatever the user types.
  ```

- Content scripts on `https://leetcode.com/problems/*` (if asked):

  ```
  The extension's purpose is tutoring on LeetCode problem pages: it adds the Tutor tab there, reads the problem and the user's editor code when they Run, Submit or message the tutor, and notices when LeetCode accepts their submission. It runs on no other pages.
  ```

- Web accessible resources `inject.js` and `layout-bridge.js` (matches `https://leetcode.com/*`, if asked):

  ```
  Both run in the LeetCode page's own context. inject.js reads the full text of the Monaco editor (the rendered editor only holds the lines on screen) and reads only the accepted or not verdict of the user's own submission. layout-bridge.js places the Tutor tab in LeetCode's tab layout. The pattern is broader than the content script's because Chrome rejects the extension when the two are identical.
  ```

**Are you using remote code?** No, I am not using remote code.

```
All JavaScript ships in the package. Model replies are shown as text and never executed, and the bundled problem data is plain data.
```

**Data usage, what the extension collects or handles** (the store counts data kept only in the browser too):

- [x] **Website content**: the problem text and the user's code in the editor, sent to the provider they chose.
- [x] **Personal communications**: the messages the user types to the tutor.
- [x] **Authentication information**: the user's own OpenAI or Anthropic API key, kept in local extension storage and sent only to that provider.
- [x] **User activity**: the extension notices Run and Submit clicks and their keyboard shortcuts on problem pages, and reads LeetCode's accepted verdict from the page's own result request to record solved problems locally.
- [ ] Personally identifiable information
- [ ] Health information
- [ ] Financial and payment information
- [ ] Location
- [ ] Web history (it keeps which problems were solved and when, never which pages were visited; see "Decisions")

**Certifications (check all three):**

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:**
https://raw.githubusercontent.com/thomsonl/leetcode-capture/main/extension/PRIVACY_POLICY.md

It must serve the current policy (dated 2026-11-05) before you submit, so merge first (step 1 above).
The rendered page https://github.com/thomsonl/leetcode-capture/blob/main/extension/PRIVACY_POLICY.md works too, if you prefer it.

## Distribution tab

- **Visibility:** Public works for the browser runtime, which needs nothing else installed.
  Unlisted is a safe first pass if the helper is not on npm yet.
- **Regions:** All regions.

## Policies this was checked against (2026-11-05)

- Program policies: https://developer.chrome.com/docs/webstore/program-policies/policies
- Limited use: https://developer.chrome.com/docs/webstore/program-policies/limited-use
- User data FAQ (local-only data still counts; data exchanged with a native program on the same computer or a user-specified server is exempt from the secure-transmission rule): https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Impersonation and intellectual property: https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property
- Keyword spam: https://developer.chrome.com/docs/webstore/program-policies/spam-faq
- Privacy practices tab: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Images: https://developer.chrome.com/docs/webstore/images

## Decisions for you

- **The name.** The impersonation policy forbids representing that the product is "authorized by, endorsed by, or produced by" another company, and forbids trademark infringement; it gives no rule on wording.
  A name that starts with "LeetCode" reads most like an official product.
  The common safer form puts the trademark last as a description of what it works with, for example `Capture Tutor for LeetCode` or `Practice Tutor for LeetCode`, together with the "not affiliated" line already in the description and privacy policy.
  Renaming also needs the e2e harness's name lookup (`cdp.mjs`) changed, so it is not done here.
  The icon's orange (`#ffa116`) is also LeetCode's brand orange.
- **Web history.** Left unchecked: the extension stores problem slugs with the time they were solved, not pages visited.
  Check it too if you prefer to disclose more than strictly needed.
- **Plain HTTP to a local server.** The secure-transmission rule exempts user-specified servers and native programs on the same computer, which covers the local model server and the helper's relay.

## After approval

1. Copy the store extension id from the dashboard into `helper/config.js` (`CHROME_EXTENSION_IDS`), so `npx leetcode-capture-helper install` works without `--chrome-id`, and publish a new helper version.
2. Point the README's Chrome install steps at the store listing.
3. Bump `version` before the next upload.

Expect a few days for review, longer for a first submission or for the broad optional host pattern.
If a reviewer asks about it, the justification above is the answer: nothing is granted at install, and the user approves one origin at a time.
