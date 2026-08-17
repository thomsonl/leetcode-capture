// LeetCode Capture - page-world injection script.
//
// content.js runs in an isolated JS world and can't reach the page's own
// `monaco` global directly. This script is injected as a real <script> tag
// (see injectPageScript in content.js) so it runs in the page's MAIN world
// alongside LeetCode's own code, where `monaco` is reachable.
//
// It talks back to content.js over CustomEvents on `document` - both worlds
// share the same DOM, so this works without postMessage and without relying
// on MV3's declarative `"world": "MAIN"` content-script support, which
// Firefox (this extension's minimum: Firefox 109, see manifest.json's
// `browser_specific_settings.gecko.strict_min_version`) didn't reliably have
// at that version - Firefox only gained it in 128. Using the same
// script-tag-injection path on both browsers avoids a Chrome/Firefox fork
// here entirely.
(() => {
  // LeetCode can have more than one Monaco editor instance on a problem
  // page at once (verified live: the code editor plus a second, empty
  // "plaintext" model - most likely the console/testcase input area).
  // `monaco.editor.getModels()[0]` is not reliably the code editor, so this
  // walks the actual editor *instances* (`monaco.editor.getEditors()`) and
  // picks the one whose DOM node is actually visible (non-zero
  // `getBoundingClientRect()`), matching the code panel that's rendered on
  // screen rather than a hidden/offscreen instance. Confirmed live: the
  // code editor's node has a real rect, the other editor's node is
  // 0x0.
  function readEditorCode() {
    if (typeof monaco === "undefined" || !monaco.editor) return null;
    const editors = monaco.editor.getEditors();
    const visible = editors.find((editor) => {
      const node = editor.getDomNode();
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!visible) return null;
    const model = visible.getModel();
    if (!model) return null;
    // getValue() returns the model's real source text - plain spaces, not
    // the U+00A0 non-breaking spaces Monaco's rendered `.view-line` DOM
    // uses for whitespace (verified live: view-line text contains
    // where the source has a normal space). No normalization needed here.
    return { code: model.getValue(), language: model.getLanguageId() };
  }

  document.addEventListener("leetcode-capture:request-code", (event) => {
    const requestId = event.detail && event.detail.requestId;
    let result = null;
    try {
      result = readEditorCode();
    } catch (err) {
      // Swallow - content.js falls back to the DOM-scraping method if it
      // never gets a response (or gets a null one).
      result = null;
    }
    document.dispatchEvent(
      new CustomEvent("leetcode-capture:code-response", {
        detail: { requestId, result },
      })
    );
  });
})();
