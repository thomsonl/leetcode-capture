# AMO (addons.mozilla.org) submission checklist

Nothing has been submitted to Mozilla yet, as far as this repository records.
Each field below has text ready to paste.
The long description, single purpose and permission justifications are the same as Chrome's, in `CHROME_SUBMISSION_CHECKLIST.md`; this file only adds what differs on AMO.

## Version and what changed

Same as `CHROME_SUBMISSION_CHECKLIST.md`: upload `1.2.0` as it is in `manifest.json`, unless an earlier build was already uploaded at that version or higher.
For the "what changed" summary, use that file's "What changed since the store-prep version" list.

## Before you start

- Run `npm test` and `npm run lint:amo` in `extension/`.
  The only expected lint warning is that `background.service_worker` is ignored on Firefox; the manifest declares both `service_worker` (Chrome) and `scripts` (Firefox) on purpose.
- Run `npm run build:amo` and upload `extension/web-ext-artifacts/leetcode_capture-<version>.zip`.
  The `--ignore-files` list in both npm scripts keeps tests, `e2e/`, `package.json` files, these Markdown files and screenshots out of the package.

## Listing fields

**Name (24 characters, max 50; it is the manifest `name`):** Thomson's LeetCode Tutor

The wording and the trademark reasoning are under "Decisions" in `CHROME_SUBMISSION_CHECKLIST.md`.
The description pasted from there states that the project is independent and not affiliated with or endorsed by LeetCode.

**Summary (max 250 characters):**

```
A LeetCode tutor that coaches you on your Run and Submit attempts, using a local model, your own OpenAI or Anthropic API key, or your Claude or ChatGPT subscription. Your code goes only to the provider you choose.
```

**Description:** paste the Description block from `CHROME_SUBMISSION_CHECKLIST.md`.

**Categories:** Education (AMO allows two; leave the second empty).

**Homepage:** https://github.com/thomsonl/leetcode-capture

**Support site:** https://github.com/thomsonl/leetcode-capture/issues

**Support email:** your own, if you want one shown.

**License:** the repository has no LICENSE file yet, so pick one (or "All Rights Reserved") before submitting; AMO requires a choice.

**Privacy policy:** paste the text of `extension/PRIVACY_POLICY.md` (AMO takes the policy text itself, not a URL).

**Screenshots:** the same set as in `CHROME_SUBMISSION_CHECKLIST.md`, taken in Firefox if you can.

**Firefox for Android:** opt out.
The extension runtime would work there, but the Tutor tab is built for LeetCode's desktop layout and the helper is desktop only.
`gecko_android.strict_min_version` stays in the manifest so it is valid either way.

## Notes to reviewer

```
No build step: every file in the package is hand-written source, with no bundler, minifier or transpiler, so the uploaded zip is the source. The one generated file is shared/problem-index.js, plain data (LeetCode's public problem titles, difficulties, topic tags and like and submission counts) written by extension/scripts/problem-index.mjs from LeetCode's public GraphQL and read locally for practice suggestions; the extension never fetches it. To reproduce the package from https://github.com/thomsonl/leetcode-capture, run "npm run build:amo" in extension/ (it runs web-ext build with an ignore list for tests and docs; there are no dependencies).

What it does: adds a Tutor tab to leetcode.com/problems/* pages. When the user clicks Run or Submit or types to the tutor, it reads the problem text and the editor code and sends them only to the AI provider the user picked in Settings.

Permissions:
- storage: the user's settings and, optionally, their own OpenAI or Anthropic API key, kept in local extension storage.
- host http://localhost:8135/*: a relay on the user's own computer, used only by the optional helper runtime.
- optional host permissions http://*/* and https://*/*: never granted at install. On Save in Settings the extension requests exactly one origin: the user's local model server, the OpenAI API (or a custom OpenAI-compatible address) or api.anthropic.com. The pattern is broad only because the model server's address is whatever the user types.
- optional nativeMessaging: requested only when the user picks a Claude or ChatGPT subscription and presses "Allow starting the helper". It talks to the native host dev.thomsonklee.leetcode_capture.

The helper is not part of this add-on. It is a separate program the user installs themselves with "npx leetcode-capture-helper install" (source in helper/ of the same repository). It registers a native messaging manifest for this add-on's id and runs the local tutor, which uses the user's own Claude or ChatGPT sign-in. Without it, the add-on still works fully with a local model or an API key.

inject.js is a web accessible resource added to the page as a script tag, so it can read the full text of LeetCode's Monaco editor model; it only answers the content script over a CustomEvent and makes no network requests.

To test without any account: install Ollama, run "ollama pull qwen2.5:0.5b" (any small model works), set OLLAMA_ORIGINS to the moz-extension:// origin shown in Settings, choose "Local model" in Settings, press Save and allow the localhost permission, then open https://leetcode.com/problems/two-sum/ and click the Tutor tab and Submit.
```

## Data collection permissions

The manifest declares `data_collection_permissions.required: ["websiteContent"]`.
This release also sends the student's typed messages to the provider, and the user's own API key to its provider.
Decide before submitting whether to add `personalCommunications` (the messages) and `authenticationInfo` (the API key) to the manifest's `required` list, to match the Chrome disclosure in `CHROME_SUBMISSION_CHECKLIST.md`.
I left the manifest unchanged so that this stays your call.

## Manual steps only you can do

1. Create or sign in to a Mozilla Add-on Developer account.
2. Decide on the data collection categories above.
3. Take the screenshots on real leetcode.com.
4. Upload the zip, fill the fields above, paste the reviewer notes, and submit.
5. Publish the helper to npm (see the Chrome checklist), so the reviewer's `npx` command resolves.
   Until it is published, change the reviewer note to `node helper/cli.js install` from a clone of the repository.

No `web-ext sign` was run; it needs your AMO API credentials and would submit the add-on.
