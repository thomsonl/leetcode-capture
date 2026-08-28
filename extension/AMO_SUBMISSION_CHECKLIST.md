# AMO (addons.mozilla.org) submission checklist

This is preparation only. Nothing has been submitted to Mozilla. Actually creating the listing and submitting for review needs a Mozilla Add-on Developer account and is a separate, deliberate step — see "Not done here" at the bottom.

## Done in this pass

- **`web-ext lint` passes clean** (0 errors, 0 warnings) as of this checklist, against exactly the files that ship (see "How to rebuild the package" below for why `--ignore-files` is needed — without it, `content.test.js`/`package.json`/this checklist/the privacy policy all get bundled into the package too). Re-run before every submission:
  ```
  cd extension && npm run lint:amo
  ```
- **`strict_min_version` fixed.** It was `109.0`, but `browser_specific_settings.gecko.data_collection_permissions` (added for Mozilla's November 2025 policy — see `AGENTS.md`) isn't supported until Firefox 140 (142 for Firefox for Android). The lint step above caught this as two warnings; both are fixed by bumping `gecko.strict_min_version` to `140.0` and adding `gecko_android.strict_min_version: "142.0"`. Firefox ignores an unsupported manifest key rather than failing, so this was silent before — worth being aware this raises the effective minimum Firefox version users need, from 109 to 140.
- **Privacy policy drafted**: `extension/PRIVACY_POLICY.md`. Factual description of the extension's actual data flow, grounded in `content.js`'s real behavior (data goes only to `localhost:8135`, nothing to the developer or a third party via the extension itself; the separately-run, optional `companion/` tool is the only path data could reach an LLM, and only if you configure and run it that way). **Read it, edit anything that doesn't match your intent, and remove its DRAFT notice before using it.** AMO requires a privacy policy (or an explicit statement of none) for any listing that declares data collection permissions, which this one does.
- **Packaged build**: `web-ext build` produces a `.zip` of exactly what AMO would receive (source files only, no build step to worry about — see "Source code" below). See "How to rebuild the package" below for the command; the output isn't committed to git (it's a build artifact).

## Still needed before actually submitting — none of these were decided or drafted here

- **Icon.** `manifest.json` has no `icons` field, and there are no icon assets anywhere in `extension/`. Firefox will show a generic default icon without one; AMO's listing form also wants one. Needs actual artwork — not something to fabricate as part of a packaging pass.
- **Screenshot(s).** AMO requires at least one for the listing. Needs a real screenshot of the extension in use against the real `leetcode.com` — not producible from an automated/sandboxed environment (see `AGENTS.md`'s note on Cloudflare blocking headless browser access to the real site). Take one from your own browser session.
- **Listing copy**: AMO's submission form asks for a name (already have: "LeetCode Capture"), a summary (short, shows in search results), and a longer description. `manifest.json`'s own `description` field ("Captures live LeetCode editor attempts on Run/Submit and relays them to a local logging server.") is a reasonable starting point for the summary, but the longer description and any framing of "this only works if you're also running the relay server + optionally the companion tool" is real product copy worth writing deliberately rather than defaulting to.
- **Permission justifications.** AMO's submission form asks you to justify each requested permission to the reviewer. Concrete answers, grounded in what's actually declared in `manifest.json`:
  - `host_permissions: ["http://localhost:8135/*"]` — needed so the extension's own `fetch()` to the local relay server isn't blocked by CORS in Chrome-family browsers (see `AGENTS.md`'s CORS bullet); the relay only ever runs on the user's own machine.
  - `content_scripts` matching `https://leetcode.com/problems/*` — the extension's entire purpose is reading the code editor and problem content on exactly these pages; it runs nowhere else.
  - `web_accessible_resources` (`inject.js`) matching `https://leetcode.com/*` — needed to read Monaco's full editor model rather than a truncated DOM scrape (see `AGENTS.md`'s inject.js bullet); broadened beyond `content_scripts`'s own pattern only because an identical pattern pair was confirmed live to make Chrome reject the extension outright (see the WAR/matches bullet in `AGENTS.md`).
- **Support contact / homepage URL.** AMO's listing form asks for these. Needs your own info (email, and/or a link to this repo if you want it public).
- **Category selection.** AMO asks you to pick a listing category (e.g. "Developer Tools"). A product framing choice, not made here.
- **Firefox for Android support decision.** The manifest fix above (`gecko_android.strict_min_version`) makes the manifest itself internally consistent, but doesn't answer whether this extension makes sense on Android at all — it depends on a local relay server running on the same machine, which isn't really an Android use case. AMO's submission flow lets you opt an extension in or out of Android distribution separately from the manifest; decide that when you actually submit.

## Source code

No build step, no bundler, no minification anywhere in `extension/` (confirmed: `content.js`/`inject.js`/`manifest.json` are the only files `web-ext build` packages, all authored source). AMO's "provide source code separately" requirement only applies to extensions containing built/minified/generated code, so this doesn't apply here — the submitted `.zip` *is* the source.

## How to rebuild the package

From `extension/`. The `--ignore-files` flag inside both npm scripts matters: without it, `web-ext build` bundles `content.test.js`, `package.json`, and these two Markdown files into the shipped package too — verified live (the first build produced a 7-file zip; this produces the intended 3: `manifest.json`, `content.js`, `inject.js`).
```
npm run lint:amo    # must be 0 errors before packaging
npm run build:amo
```
This produces `web-ext-artifacts/leetcode_capture-<version>.zip` (gitignored) — this is the file to upload to AMO once the "still needed" items above are actually done.

## Not done here

- No AMO account was used and nothing was submitted to Mozilla — that needs your own Mozilla Add-on Developer account.
- No `web-ext sign` (Mozilla's automated signing API) was run — it needs API credentials (JWT issuer/secret) from your AMO developer account, which weren't available here, and running it would actually submit the extension for signing/review.
