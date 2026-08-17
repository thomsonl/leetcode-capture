// LeetCode Capture - content script
//
// Hooks the Run and Submit buttons on a LeetCode problem page, reads the
// current Monaco editor content at the moment of the click, and POSTs a
// capture payload to the local relay server. No other network calls are
// made from this extension.

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
    if (descEl && descEl.textContent.trim()) {
      return descEl.textContent.trim();
    }
    return null;
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
  // the lines currently rendered in the viewport (plus a small overscan
  // buffer), and removes lines from the DOM entirely once they scroll out
  // of view. That makes getEditorCodeFromDom() below correct only for
  // whatever happens to be on screen at capture time - fine for a
  // screenful of code, silently incomplete beyond that. getEditorCode()
  // therefore prefers reading Monaco's actual editor model (the full,
  // unwindowed source) via a page-world injection, and only falls back to
  // the DOM scrape if that fails for any reason (extension resource
  // blocked, page script CSP, Monaco not loaded yet, etc.) so a capture is
  // still better than none.
  function getEditorCodeFromDom() {
    // Monaco renders each line of code as DOM text inside `.view-lines`.
    const viewLines = document.querySelector(".monaco-editor .view-lines");
    if (!viewLines) return null;

    const lineEls = Array.from(viewLines.querySelectorAll(".view-line"));
    if (lineEls.length === 0) return null;

    // Monaco positions lines absolutely with inline `top` styles; sort by
    // that so the extracted text is in visual (source) order regardless of
    // DOM insertion order.
    lineEls.sort((a, b) => {
      const topA = parseInt(a.style.top || "0", 10);
      const topB = parseInt(b.style.top || "0", 10);
      return topA - topB;
    });

    // Monaco's rendered `.view-line` DOM uses U+00A0 (non-breaking space)
    // for whitespace, not a plain U+0020 space - confirmed live
    // (chrome-devtools-axi against a real leetcode.com problem page: a
    // `.view-line`'s textContent came back with charCode 160 where the
    // actual source has an ordinary space). So this replace is a real
    // normalization back to plain spaces, not a no-op.
    return lineEls
      .map((line) => line.textContent.replace(/ /g, " "))
      .join("\n");
  }

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
  // to `null` (rather than rejecting) on timeout so callers can fall back
  // to the DOM scrape uniformly. `requestEvents`/`responseEvents` are
  // injectable (default `document`) purely so content.test.js can exercise
  // this round-trip with a plain mock EventTarget, without a real DOM.
  function requestModelCode(requestEvents = document, responseEvents = document, timeoutMs = 500) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => {
        responseEvents.removeEventListener("leetcode-capture:code-response", onResponse);
        resolve(null);
      }, timeoutMs);

      function onResponse(event) {
        if (!event.detail || event.detail.requestId !== requestId) return;
        clearTimeout(timer);
        responseEvents.removeEventListener("leetcode-capture:code-response", onResponse);
        resolve(event.detail.result);
      }

      responseEvents.addEventListener("leetcode-capture:code-response", onResponse);
      requestEvents.dispatchEvent(
        new CustomEvent("leetcode-capture:request-code", { detail: { requestId } })
      );
    });
  }

  async function getEditorCode() {
    try {
      await injectPageScript();
      const modelResult = await requestModelCode();
      if (modelResult && typeof modelResult.code === "string") {
        console.log("[leetcode-capture] editor code read from Monaco model (full source, not just what's on screen)");
        return modelResult.code;
      }
      // injectPageScript() resolved but the round-trip came back empty/null -
      // e.g. requestModelCode() timed out, or inject.js couldn't find an
      // editor. This is the silent-fallback case that made PR #16 look like
      // a fix while actually still truncating for real users: log loudly so
      // it's never invisible again.
      console.warn("[leetcode-capture] model-based editor read returned no code, falling back to DOM scrape (may be truncated to what's on screen)");
    } catch (err) {
      console.warn("[leetcode-capture] model-based editor read failed, falling back to DOM scrape (may be truncated to what's on screen)", err);
    }
    return getEditorCodeFromDom();
  }

  async function sendCapture(trigger) {
    const code = await getEditorCode();
    if (code === null) {
      console.warn("[leetcode-capture] editor content not found, skipping capture");
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

  // Test-only hook: exposes the button matchers and the model-read
  // message-passing logic to content.test.js via plain CommonJS require(),
  // so they're unit-testable with simple mocks (no jsdom, no build step)
  // without changing anything about how this script runs as a real content
  // script - `module` is undefined in the browser, so this is a no-op
  // there.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { matchesRunButton, matchesSubmitButton, requestModelCode };
    return;
  }

  document.addEventListener("click", handleDelegatedClick, true);

  console.log("[leetcode-capture] content script active");
})();
