# Privacy Policy for Thomson's LeetCode Tutor

Last updated: 2026-11-05

## What this extension does

Thomson's LeetCode Tutor is a tutor for LeetCode problems.
It is an independent project and is not affiliated with or endorsed by LeetCode.
It adds a Tutor tab to `leetcode.com/problems/*` pages, sees your Run and Submit attempts, and lets you message an AI tutor about the problem you are solving.
It also keeps track of the problems you solved, shows your progress through well-known problem lists, and suggests problems to practice a skill.
You choose which AI model provider the tutor uses on the extension's Settings page.

## What data is read

The extension reads data only on `leetcode.com/problems/*` pages, and only when you click Run or Submit (or use their keyboard shortcuts) or send a message in the Tutor tab:

- The problem's slug, title, description and topic tags, from the page you are viewing.
- The language selected in the editor, and the code currently in the editor.
- The message you type to the tutor.
- The page URL and a timestamp.

When you submit, it also reads LeetCode's verdict for that submission (whether it was accepted) from the page's own result request, to keep track of the problems you solved.
When a LeetCode problem page is open, or when you press "Sync from LeetCode" on the Progress page, it also asks LeetCode, from that page and with your own signed-in session, which problems your account has accepted, and adds them to the solved problems kept in the browser.
That list goes nowhere else.
It reads nothing else from that request, and the verdict is never sent anywhere.

The Tutor tab also reads the problem's slug from the page address, to show that problem's conversation and suggestions.

It does not read your LeetCode account details, cookies, passwords or any other page.
It does not read your browsing history.

The extension also ships, inside its package, a fixed copy of LeetCode's public problem metadata (each problem's title, difficulty, topic tags and public like and submission counts, taken from LeetCode's public problem data) and the problem lists the Progress tab shows (such as NeetCode 150 and Blind 75).
The Tutor tab's "Practice a skill" suggestions and the Progress tab are computed from that copy inside your browser.
It holds nothing about you and is never fetched or updated over the network.
Suggestions leave out the problems you solved by looking at the solved problems kept in the browser (below); neither the suggestions nor your progress are ever sent anywhere, including to the tutor.

## Where that data goes

That data goes to exactly one place: the provider you chose in Settings.

- **A local model** (Ollama, LM Studio, llama.cpp or another OpenAI-compatible server): the extension sends it to the server address you entered, usually on your own computer.
- **The OpenAI API or the Anthropic API with your own API key**: the extension sends it directly from your browser to `api.openai.com` (or the OpenAI-compatible address you entered) or `api.anthropic.com`.
  That provider's own privacy policy and terms then apply to it.
- **Your Claude or ChatGPT subscription**: the extension sends it to the optional helper you installed on your computer, through a relay server at `http://localhost:8135` on that same computer.
  The helper runs the tutor, which uses your existing Claude or ChatGPT sign-in on that computer to reach Anthropic or OpenAI.
  That provider's own privacy policy and terms then apply to it.

Requests to the OpenAI and Anthropic APIs use HTTPS.
A local model server is reached at the address you entered, which is usually plain HTTP on your own computer or network.

The browser asks your permission before the extension may reach your model server or a provider's API, one address at a time, and before it may start the helper.
While no provider is chosen yet, the Tutor tab checks whether a tutor you started yourself from a terminal answers at `http://localhost:8135` on your computer; that check sends none of your code or messages.
The extension sends nothing to the developer.
There are no analytics, no telemetry, no tracking, no ads and no third-party services beyond the provider you chose.
All of the extension's code ships in the package; it loads and runs no remote code.

## API keys

If you enter an OpenAI or Anthropic API key, it is stored only in your browser's local extension storage, on your computer.
If you save a key through the helper instead, it is stored only in `~/.config/leetcode-capture/settings.json` on your computer.
A key is never sent anywhere except to its own provider, as the credential for your requests.
The extension never shows a saved key back on the Settings page or the Tutor tab.

## What is kept, and for how long

- **Settings and keys**: kept in the browser's local extension storage (and, for the helper, in `~/.config/leetcode-capture/settings.json`) until you remove them.
- **Solved problems and progress**: which problems you solved (the problem's slug, when, how many accepted submissions, and whether you marked it by hand or it came from LeetCode), the problems you starred and which problem list you chose to work on, kept in the browser's local extension storage until you unmark them or uninstall the extension.
  They are never sent anywhere, including to the tutor.
- **Layout preferences**: where you moved the Tutor tab in LeetCode's layout (kept in the browser's local extension storage) and how the Progress tab groups a list (kept in the Settings page's local storage).
- **Tutor conversations**: kept in memory only, per problem, and forgotten when the tutor stops, the browser ends the extension's background worker, or the conversation is reset on a problem switch.
  In the helper runtime, the local relay keeps a short queue of your Run and Submit attempts in `relay-server/data/captures.jsonl`, cleared as the tutor reads it, and the helper writes a log (`helper.log`) in its data folder.
- **Optional notes**: if you turn on the separate vault feature, the tutor writes notes into the Obsidian vault folder you configured.
  This is off by default.

The developer stores nothing, because nothing reaches the developer.

## Data sale and use

The developer does not collect, sell or transfer your data to anyone.
Your data is not used for advertising, for creditworthiness or lending, or for any purpose other than tutoring you on the problem you are solving.

## Deleting your data

- To remove a saved API key, use the key's Remove button on the Settings page and save.
- To remove all settings, keys, solved problems and preferences the extension stored, uninstall the extension; the browser deletes its extension storage.
- To remove the helper and what it wrote, run `npx leetcode-capture-helper uninstall`, and delete `~/.config/leetcode-capture/settings.json` and `relay-server/data/captures.jsonl` if they exist.
- Any notes the optional vault feature wrote are ordinary files in your vault; delete them like any other file.
- Data already sent to a provider you chose is held under that provider's own retention policy; see your account settings with that provider.

## Changes

Source code is available at https://github.com/thomsonl/leetcode-capture, so any change to what is read or where it is sent is visible in its history.
This page is updated with each such change.

## Contact

Questions about this policy can be raised as an issue at https://github.com/thomsonl/leetcode-capture/issues.
