// LeetCode Capture - content script
//
// Hooks the Run and Submit buttons on a LeetCode problem page, reads the
// current Monaco editor model at the moment of the click, and hands the
// capture to the tutor. Where it goes depends on the runtime chosen in the
// options page: the extension's own background worker runs the tutor for a
// local model or an API key (nothing leaves the browser except the request to
// that provider), and otherwise the capture is POSTed to the local relay
// server, as it always was. No other network calls are made from this script.

(() => {
  const RELAY_URL = "http://localhost:8135/capture";

  function getProblemSlug() {
    // https://leetcode.com/problems/<slug>/...
    const match = window.location.pathname.match(/\/problems\/([^/]+)/);
    return match ? match[1] : null;
  }

  function getProblemTitle() {
    // The problem title lives in a link/heading near the top of the page;
    // LeetCode's class names churn, so fall back to the document title.
    const titleEl = document.querySelector("[data-cy='question-title']") ||
      document.querySelector("a[href^='/problems/'] > div");
    if (titleEl && titleEl.textContent.trim()) {
      return titleEl.textContent.trim();
    }
    // document.title is usually "<Title> - LeetCode"
    return document.title.replace(/\s*-\s*LeetCode\s*$/, "").trim();
  }

  function getProblemDescription() {
    // The full problem statement (prompt, examples, constraints) lives in a
    // panel identified by `data-track-load="description_content"`. This was
    // confirmed against live leetcode.com/problems/ pages (two-sum,
    // valid-parentheses): it's an analytics/telemetry hook attribute, which
    // tends to be far more stable across LeetCode's frontend rebuilds than
    // its generated class names - same reasoning as the class-name churn
    // noted for getProblemTitle() and getLanguage() above. A broader
    // container (`#qd-content`) also matches but additionally picks up tab
    // labels ("Description", "Editorial", "Solutions", ...) and other page
    // chrome, so it's avoided here in favor of this narrower, stable panel.
    const descEl = document.querySelector('[data-track-load="description_content"]');
    const text = descEl ? descriptionText(descEl).trim() : "";
    return text || null;
  }

  // The element's text, like textContent, except that an exponent or index
  // keeps its meaning: LeetCode writes constraints as 10<sup>4</sup>, which
  // textContent flattens to "104" (and -10<sup>9</sup> to "-109"). A <sup>
  // becomes "^4" and a <sub> "_i".
  function descriptionText(node) {
    if (!node.childNodes) return node.textContent || "";
    if (node.nodeType === 3) return node.nodeValue || "";
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.nodeValue || "";
      else if (child.nodeType !== 1) continue;
      else if (child.tagName === "SUP") text += `^${descriptionText(child)}`;
      else if (child.tagName === "SUB") text += `_${descriptionText(child)}`;
      else text += descriptionText(child);
    }
    return text;
  }

  function getProblemTags() {
    // LeetCode's own topic tags (e.g. "Array", "Dynamic Programming") live as
    // plain anchor links to /tag/<slug>/ inside the collapsible "Topics"
    // panel below the description. Verified directly against live
    // leetcode.com/problems/ pages (two-sum, house-robber) with
    // chrome-devtools-axi: `a[href^="/tag/"]` matches exactly the topic tags
    // and nothing else on the page, and the links are present in the DOM
    // even while the panel is visually collapsed (height: 0 via CSS, not
    // absent) - no click/expand needed, no extra permissions.
    const links = document.querySelectorAll('a[href^="/tag/"]');
    const tags = Array.from(links)
      .map((a) => a.textContent.trim())
      .filter(Boolean);
    return tags;
  }

  function getLanguage() {
    // The language selector button shows the currently selected language.
    const langButtons = document.querySelectorAll("button");
    for (const btn of langButtons) {
      const text = btn.textContent.trim();
      // Heuristic: LeetCode's language picker button text is exactly one of
      // its supported language names, and it sits near the editor toolbar.
      if (KNOWN_LANGUAGES.has(text)) {
        return text;
      }
    }
    return "unknown";
  }

  const KNOWN_LANGUAGES = new Set([
    "C++", "Java", "Python", "Python3", "C", "C#", "JavaScript", "TypeScript",
    "PHP", "Swift", "Kotlin", "Dart", "Go", "Ruby", "Scala", "Rust", "Racket",
    "Erlang", "Elixir", "MySQL", "MS SQL Server", "Oracle", "PostgreSQL",
  ]);

  // Monaco is a virtualized/windowed editor: it only keeps DOM nodes for
  // the lines on screen (plus a small overscan), so the rendered
  // `.view-lines` DOM is silently incomplete for anything longer than a
  // screenful. Code is therefore read only from Monaco's editor model (the
  // full source) through a page-world injection (inject.js). There is no
  // fallback: when the model cannot be read, nothing is captured or sent,
  // and the Tutor panel says so (a partial copy would read to the tutor as
  // deleted code).
  // Injects inject.js as a real <script> tag so it runs in the page's own
  // MAIN world (where the `monaco` global lives) rather than this content
  // script's isolated world. See inject.js for why this approach (rather
  // than a declarative MV3 `"world": "MAIN"` content script) is used for
  // both Chrome and Firefox/Zen.
  let pageScriptInjection = null;
  function injectPageScript() {
    if (pageScriptInjection) return pageScriptInjection;
    pageScriptInjection = new Promise((resolve, reject) => {
      if (document.getElementById("leetcode-capture-inject")) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.id = "leetcode-capture-inject";
      script.src = chrome.runtime.getURL("inject.js");
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("leetcode-capture: failed to load inject.js"));
      (document.head || document.documentElement).appendChild(script);
    });
    return pageScriptInjection;
  }

  // Asks inject.js (running in the page's MAIN world) for the current
  // editor model's full text over a CustomEvent round-trip on `document` -
  // both worlds share the same DOM, so this needs no postMessage. Resolves
  // to `null` (rather than rejecting) on timeout, the same as no editor. `requestEvents`/`responseEvents` are
  // injectable (default `document`) purely so content.test.js can exercise
  // this round-trip with a plain mock EventTarget, without a real DOM.
  // See inject.js for why `detail` is JSON-stringified rather than a plain
  // object: on Firefox, reading a property off a CustomEvent's `detail`
  // when that object was created in the *other* JS realm (content
  // script <-> page script) throws "Permission denied to access property"
  // due to Xray wrapper boundaries - Chrome doesn't enforce this the same
  // way, so it only surfaced live on Firefox/Zen. A JSON string primitive
  // crosses the realm boundary cleanly on both browsers, so both directions
  // of this request/response protocol use it.
  function requestModelCode(requestEvents = document, responseEvents = document, timeoutMs = 500) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => {
        responseEvents.removeEventListener("leetcode-capture:code-response", onResponse);
        resolve(null);
      }, timeoutMs);

      function onResponse(event) {
        let payload;
        try {
          payload = JSON.parse(event.detail);
        } catch (err) {
          return;
        }
        if (!payload || payload.requestId !== requestId) return;
        clearTimeout(timer);
        responseEvents.removeEventListener("leetcode-capture:code-response", onResponse);
        resolve(payload.result);
      }

      responseEvents.addEventListener("leetcode-capture:code-response", onResponse);
      requestEvents.dispatchEvent(
        new CustomEvent("leetcode-capture:request-code", { detail: JSON.stringify({ requestId }) })
      );
    });
  }

  // The full editor code from the Monaco model, or null when it cannot be
  // read (inject.js blocked, Monaco not loaded yet, no visible editor, or no
  // answer in time).
  async function getEditorCode() {
    try {
      await injectPageScript();
      const modelResult = await requestModelCode();
      if (modelResult && typeof modelResult.code === "string") return modelResult.code;
      console.warn("[leetcode-capture] could not read the editor model; nothing was captured");
    } catch (err) {
      console.warn("[leetcode-capture] could not read the editor model; nothing was captured", err);
    }
    return null;
  }

  // Answers panel.js's request for the live editor code at the moment the
  // student sends a Tutor message (see requestEditorSnapshot there): the same
  // reads a capture makes, over a request/response CustomEvent pair with a
  // JSON-string detail. With no model read the answer is null: the message
  // then goes without code and the panel says the editor could not be read.
  // `requestEvents`/`responseEvents` and
  // `readModelCode` are injectable for content.test.js.
  async function answerSnapshotRequest(event, responseEvents = document, readModelCode = defaultReadModelCode) {
    let requestId = null;
    try {
      requestId = JSON.parse(event.detail).requestId;
    } catch (err) {
      return;
    }
    if (typeof requestId !== "string") return;
    let snapshot = null;
    try {
      const result = await readModelCode();
      if (result && typeof result.code === "string") {
        snapshot = {
          code: result.code,
          language: getLanguage(),
          problemTitle: getProblemTitle(),
          problemDescription: getProblemDescription(),
        };
      }
    } catch (err) {
      snapshot = null;
    }
    responseEvents.dispatchEvent(
      new CustomEvent("leetcode-capture:snapshot-response", { detail: JSON.stringify({ requestId, snapshot }) })
    );
  }

  async function defaultReadModelCode() {
    await injectPageScript();
    return requestModelCode();
  }

  // Guards against the same logical Run/Submit event producing two captures
  // via two different paths - e.g. the keyboard-shortcut listener below
  // calling sendCapture("submit") directly, *and* LeetCode's own native
  // Ctrl+Enter handler (see the shortcut section below for why Ctrl+Enter
  // is believed to already be LeetCode's own native Submit binding)
  // separately ending up triggering handleDelegatedClick's own
  // sendCapture("submit") - e.g. if that native handler performs a real DOM
  // click on the Submit button internally rather than calling some other
  // internal submit function directly. Which mechanism LeetCode's frontend
  // actually uses couldn't be confirmed live (real leetcode.com is
  // Cloudflare-blocked in this environment - see the shortcut section), so
  // this guard is deliberately mechanism-agnostic: it doesn't matter *how*
  // a second call for the same trigger might arrive, only that one arriving
  // within CAPTURE_DEDUP_WINDOW_MS of an already-sent capture for that same
  // trigger is the same logical event and should be dropped, not resent.
  const CAPTURE_DEDUP_WINDOW_MS = 300;
  const lastCaptureAt = {};
  function isDuplicateCapture(trigger, now, lastCaptureAtByTrigger) {
    const last = lastCaptureAtByTrigger[trigger];
    return last !== undefined && now - last < CAPTURE_DEDUP_WINDOW_MS;
  }

  // `events` (where the panel listens) and `readCode` are injectable for
  // content.test.js.
  async function sendCapture(trigger, { events = document, readCode = getEditorCode } = {}) {
    const now = Date.now();
    if (isDuplicateCapture(trigger, now, lastCaptureAt)) {
      console.log(`[leetcode-capture] skipping duplicate ${trigger} capture (already captured within the last ${CAPTURE_DEDUP_WINDOW_MS}ms)`);
      return;
    }
    lastCaptureAt[trigger] = now;

    // Lets panel.js (the in-page Tutor tab) step aside so LeetCode's own
    // result tab is visible, whichever tab was underneath it.
    events.dispatchEvent(new Event("leetcode-capture:capture-start"));

    const code = await readCode();
    if (code === null) {
      // Nothing is guessed: no capture at all, and the panel tells the student.
      events.dispatchEvent(new CustomEvent("leetcode-capture:editor-read-failed", { detail: JSON.stringify({ trigger }) }));
      return;
    }

    const payload = {
      problemSlug: getProblemSlug(),
      problemTitle: getProblemTitle(),
      problemDescription: getProblemDescription(),
      problemTags: getProblemTags(),
      language: getLanguage(),
      code,
      trigger, // "run" or "submit"
      timestamp: new Date().toISOString(),
      url: window.location.href,
    };

    if (await handToBackground(payload)) return;
    try {
      await fetch(RELAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Relay server may not be running; fail silently so it never
      // interferes with normal LeetCode use.
      console.warn("[leetcode-capture] failed to reach relay server", err);
    }
  }

  // The extension runtime: the background worker takes the capture itself
  // and answers { handled: true }. Resolves false when it runs the tutor
  // through the helper (the relay) instead, or cannot be asked (the extension
  // was reloaded under this page, or this is not running as an extension).
  async function handToBackground(capture) {
    const runtime =
      (typeof browser !== "undefined" && browser.runtime) || (typeof chrome !== "undefined" && chrome.runtime) || null;
    if (!runtime || !runtime.id || typeof runtime.sendMessage !== "function") return false;
    try {
      const answer = await runtime.sendMessage({ type: "lc-tutor:capture", capture });
      return Boolean(answer && answer.handled === true);
    } catch {
      return false;
    }
  }

  // The Run button is icon-only on the live page (a FontAwesome play-icon
  // SVG, no visible text) - btn.textContent is empty for it, so a
  // text-based match never fires and Run captures were silently never
  // sent at all. Confirmed via live DOM inspection (Thomson, chrome
  // devtools). The Submit button does still carry visible "Submit" text
  // today, but is matched the same layered way here so a future LeetCode
  // frontend change that strips its text too doesn't silently reintroduce
  // this exact bug.
  //
  // Each button is checked against several independent signals, in order
  // from most to least specific, and matches on the first one that's
  // present - not all buttons carry every signal:
  //   1. `data-e2e-locator` - LeetCode's own e2e test hook attribute
  //      ("console-run-button" / "console-submit-button"), the same kind
  //      of stable, non-styling attribute already relied on elsewhere in
  //      this extension (see getProblemDescription's data-track-load).
  //   2. `aria-label` - LeetCode adds this to icon-only buttons for
  //      accessibility, so it's expected to stay present even without
  //      visible text.
  //   3. A FontAwesome play-icon SVG inside the button (`.fa-play`, or
  //      `data-icon="play"` on the <svg> itself) - specific to Run, since
  //      Submit has no play icon.
  //   4. Visible button text ("run"/"run code"/"submit") - the original,
  //      pre-this-fix behavior, kept as a last-resort fallback for
  //      whichever variant of the page still has it.
  function matchesRunButton(btn) {
    const locator = btn.getAttribute("data-e2e-locator");
    if (locator) return locator === "console-run-button";
    const ariaLabel = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
    if (ariaLabel) return ariaLabel === "run" || ariaLabel === "run code";
    if (btn.querySelector('svg.fa-play, svg[data-icon="play"]')) return true;
    const text = btn.textContent.trim().toLowerCase();
    return text === "run" || text === "run code";
  }

  function matchesSubmitButton(btn) {
    const locator = btn.getAttribute("data-e2e-locator");
    if (locator) return locator === "console-submit-button";
    const ariaLabel = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
    if (ariaLabel) return ariaLabel === "submit";
    const text = btn.textContent.trim().toLowerCase();
    return text === "submit";
  }

  // LeetCode's Run/Submit buttons are re-rendered by React fairly often, so
  // instead of binding listeners to specific button elements once, delegate
  // from a stable ancestor and match on click target. Prefer the nearest
  // `[data-e2e-locator]` ancestor over the nearest `<button>` - confirmed
  // live (Thomson, chrome devtools) that LeetCode puts this attribute
  // directly on the Submit button (`data-e2e-locator="console-submit-button"`,
  // alongside `aria-label="Submit"`); matchesRunButton/matchesSubmitButton
  // check the *same* element either way (the locator lookup is a no-op if
  // absent), so this only matters if a future page ever puts the locator on
  // a wrapping element instead of the `<button>` itself.
  function handleDelegatedClick(event) {
    const btn = event.target.closest("[data-e2e-locator]") || event.target.closest("button");
    if (!btn) return;

    if (matchesRunButton(btn)) {
      sendCapture("run");
    } else if (matchesSubmitButton(btn)) {
      sendCapture("submit");
    }
  }

  // Keyboard-shortcut support for Run/Submit captures, so a capture can be
  // triggered without touching the mouse: Ctrl/Cmd+' for Run, Ctrl/Cmd+Enter
  // for Submit.
  //
  // This mapping was decided after the task's own required first step -
  // live-verifying against a real leetcode.com/problems/ page with
  // chrome-devtools-axi - turned out to be blocked in this environment: real
  // leetcode.com fails Cloudflare's Turnstile bot challenge for the
  // automated browser here (confirmed live: the challenge's own "Verify you
  // are human" checkbox was clicked and explicitly reverted to unverified,
  // not just slow to load; plain curl gets a 403 too). Verified instead via
  // external research, since guessing wasn't an option: a 2024/2025
  // leetcode.com/discuss thread ("[Ctrl]+[Enter] hotkey annoyed") describes
  // real users hitting accidental submissions from Ctrl+Enter while typing -
  // i.e. LeetCode's own site currently binds native Ctrl+Enter to Submit,
  // not Run - and the well-established third-party "LeetCode Shortcuts"
  // Chrome extension (built specifically to restore the shortcut LeetCode's
  // own site removed in September 2019) uses Ctrl+' for Run and Ctrl+Enter
  // for Submit. The original task brief had this mapping backwards; this is
  // the corrected one, confirmed by Thomson.
  //
  // Because Ctrl+Enter is believed to already be LeetCode's own native
  // Submit action, this listener deliberately never calls preventDefault()
  // or stopPropagation() on either shortcut - doing so on Ctrl+Enter would
  // risk suppressing that real submission, which needs to happen exactly as
  // it would from a real click. The listener is purely additive, exactly
  // like handleDelegatedClick above: it only calls sendCapture(), and relies
  // on sendCapture's own dedup guard (isDuplicateCapture, above) to collapse
  // this into exactly one capture if LeetCode's native handler also ends up
  // triggering handleDelegatedClick through some internal mechanism.
  function isShortcutModifierPressed(event) {
    // Ctrl on Windows/Linux, Cmd on Mac - matching the "Ctrl/Cmd" convention
    // used by both LeetCode's own former native binding and the "LeetCode
    // Shortcuts" extension this mapping was verified against above.
    // Shift/Alt are excluded so this doesn't also match an unrelated combo
    // that happens to hold Ctrl/Cmd down, e.g. Ctrl+Shift+Enter.
    return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
  }

  // Browsers fire repeated keydown events (event.repeat === true) for as
  // long as a key combo is held down - typically an initial ~500ms delay,
  // then repeats every ~30-50ms. sendCapture's own dedup guard
  // (isDuplicateCapture, above) catches the fast repeats fine once they
  // start, but the *first* repeat lands ~500ms after the initial press -
  // outside its 300ms window - so without this check, briefly holding
  // Ctrl+Enter/Ctrl+' down (even by accident) would produce a second real
  // capture at that first repeat. Excluding event.repeat here means only
  // the genuine initial press of a combo ever counts as a match, regardless
  // of how long it's then held.
  function matchesRunShortcut(event) {
    // event.code === "Quote" is a fallback for keyboard layouts where the
    // physical apostrophe key doesn't produce event.key === "'".
    return !event.repeat && isShortcutModifierPressed(event) && (event.key === "'" || event.code === "Quote");
  }

  function matchesSubmitShortcut(event) {
    return !event.repeat && isShortcutModifierPressed(event) && event.key === "Enter";
  }

  // Bound on `document` in the capture phase - same as handleDelegatedClick
  // above, and for the same reason: capture-phase listeners run top-down
  // (document first), so a document-level capture listener always observes
  // the keydown event ahead of anything bound deeper in the DOM (e.g.
  // Monaco's own internal keybinding service), regardless of whether that
  // inner code later calls stopPropagation(). This is what makes the
  // shortcut work the same whether focus is inside the Monaco editor or
  // elsewhere on the page. Reasoned from standard DOM event-flow semantics
  // and live-verified against a local page with a nested contenteditable
  // element that calls stopPropagation() on its own keydown handler,
  // standing in for Monaco's real instance, which real leetcode.com being
  // Cloudflare-blocked (above) ruled out testing directly - confirm live
  // against the real page if this project ever regains access to it.
  function handleShortcutKeydown(event) {
    // Typing in the in-page tutor panel (panel.js) must never fire a capture:
    // Ctrl/Cmd+Enter is a natural "send" gesture in a chat box. The panel
    // lives in a shadow root, so the host element shows up in the event's
    // composed path even though event.target is retargeted to it.
    if (event.composedPath && event.composedPath().some((node) => node && node.id === "lc-tutor-panel-host")) {
      return;
    }
    if (matchesRunShortcut(event)) {
      sendCapture("run");
    } else if (matchesSubmitShortcut(event)) {
      sendCapture("submit");
    }
  }

  // Test-only hook: exposes the button matchers and the model-read
  // message-passing logic to content.test.js via plain CommonJS require(),
  // so they're unit-testable with simple mocks (no jsdom, no build step)
  // without changing anything about how this script runs as a real content
  // script - `module` is undefined in the browser, so this is a no-op
  // there.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      matchesRunButton,
      matchesSubmitButton,
      requestModelCode,
      matchesRunShortcut,
      matchesSubmitShortcut,
      isDuplicateCapture,
      answerSnapshotRequest,
      sendCapture,
      handToBackground,
    };
    return;
  }

  document.addEventListener("click", handleDelegatedClick, true);
  document.addEventListener("keydown", handleShortcutKeydown, true);
  document.addEventListener("leetcode-capture:snapshot-request", (event) => answerSnapshotRequest(event));

  console.log("[leetcode-capture] content script active");
})();
