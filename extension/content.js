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

  function getEditorCode() {
    // Monaco renders each line of code as DOM text inside `.view-lines`.
    // Reading via the DOM avoids needing to inject into the page's JS
    // context to reach the `monaco` global.
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

    return lineEls
      .map((line) => line.textContent.replace(/ /g, " "))
      .join("\n");
  }

  async function sendCapture(trigger) {
    const code = getEditorCode();
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

  function findButtonByText(patterns) {
    const candidates = document.querySelectorAll("button");
    for (const btn of candidates) {
      const text = btn.textContent.trim().toLowerCase();
      if (patterns.some((p) => text === p)) {
        return btn;
      }
    }
    return null;
  }

  // LeetCode's Run/Submit buttons are re-rendered by React fairly often, so
  // instead of binding listeners to specific button elements once, delegate
  // from a stable ancestor and match on click target text.
  function handleDelegatedClick(event) {
    const btn = event.target.closest("button");
    if (!btn) return;

    const text = btn.textContent.trim().toLowerCase();
    if (text === "run" || text === "run code") {
      sendCapture("run");
    } else if (text === "submit") {
      sendCapture("submit");
    }
  }

  document.addEventListener("click", handleDelegatedClick, true);

  console.log("[leetcode-capture] content script active");
})();
