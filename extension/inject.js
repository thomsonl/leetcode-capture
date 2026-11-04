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

  // event.detail crosses from content.js's isolated world into this page
  // world (and the response event's detail crosses back the other way).
  // Firefox enforces Xray wrapper security boundaries between those two
  // realms: reading a property off a plain object that was created in the
  // *other* realm throws "Permission denied to access property ..." even
  // though the value is there - it's the property access itself that's
  // blocked, not a missing value. Chrome doesn't enforce this the same way
  // for a page-context-injected <script>, so this was invisible there.
  // Confirmed live in Firefox/Zen (Thomson's console): "Uncaught Error:
  // Permission denied to access property "requestId"" at this line, when
  // it read `event.detail.requestId` directly.
  //
  // Fix: never touch a property on a cross-realm object. JSON.stringify the
  // whole payload into `detail` as a plain string instead - a string
  // primitive crosses the realm boundary cleanly on both browsers - and
  // JSON.parse it back out on the receiving side. This avoids needing
  // Firefox's `cloneInto()` (which doesn't exist in Chrome and would need
  // feature-detection) and fixes both directions of this protocol
  // identically, since both content.js and inject.js now only ever read
  // `event.detail` itself (a string), never a property of it.
  document.addEventListener("leetcode-capture:request-code", (event) => {
    let requestId = null;
    try {
      requestId = JSON.parse(event.detail).requestId;
    } catch (err) {
      requestId = null;
    }
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
        detail: JSON.stringify({ requestId, result }),
      })
    );
  });

  // ---- accepted submissions ---------------------------------------------
  //
  // After a Submit, LeetCode's page polls
  // /submissions/detail/<id>/v2/check/ (older pages: /<id>/check/) until the judge answers with
  // state "SUCCESS"; status_msg "Accepted" means every test passed. A Run
  // polls the same path, but with an id like "runcode_..." (and its result
  // carries task_name "judger.runcodetask.RunCode"), so only an all-digit id
  // counts. The page's own requests are only watched, never changed: the
  // wrappers hand back the very response the page asked for and read a
  // clone (fetch) or the finished text (XMLHttpRequest).
  //
  // Each accepted submission id is reported to content.js once, as
  // leetcode-capture:submission-accepted with a JSON-string detail (the same
  // Firefox Xray reason as above). Nothing about the code or the problem goes
  // with it: content.js takes the problem from the page address.
  const CHECK_PATH = /\/submissions\/detail\/([^/?#]+)\/(?:v2\/)?check\/?(?:[?#]|$)/;
  const reported = new Set();

  function submissionIdOf(url) {
    let path;
    try {
      path = new URL(String(url), window.location.href).pathname;
    } catch (err) {
      return null;
    }
    const match = CHECK_PATH.exec(path);
    return match && /^\d{1,20}$/.test(match[1]) ? match[1] : null;
  }

  function isAccepted(result) {
    if (!result || typeof result !== "object") return false;
    if (result.state !== "SUCCESS" || result.status_msg !== "Accepted") return false;
    if (typeof result.task_name === "string" && /runcode/i.test(result.task_name)) return false;
    if ("status_code" in result && result.status_code !== 10) return false;
    return true;
  }

  function noteResult(id, result) {
    if (!id || reported.has(id) || !isAccepted(result)) return;
    reported.add(id);
    document.dispatchEvent(
      new CustomEvent("leetcode-capture:submission-accepted", { detail: JSON.stringify({ submissionId: id }) })
    );
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      return null;
    }
  }

  const pageFetch = window.fetch;
  if (typeof pageFetch === "function" && !pageFetch.__lcCaptureWrapped) {
    const wrapped = function fetch(input, init) {
      const promise = pageFetch.apply(this, arguments);
      let id = null;
      try {
        id = submissionIdOf(input && typeof input === "object" && "url" in input ? input.url : input);
      } catch (err) {
        id = null;
      }
      if (id) {
        promise.then(
          (response) => {
            try {
              response
                .clone()
                .text()
                .then((text) => noteResult(id, parseJson(text)), () => {});
            } catch (err) {
              // an opaque or already-used body: nothing to read
            }
          },
          () => {}
        );
      }
      return promise;
    };
    Object.defineProperty(wrapped, "__lcCaptureWrapped", { value: true });
    window.fetch = wrapped;
  }

  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto && !xhrProto.open.__lcCaptureWrapped) {
    const pageOpen = xhrProto.open;
    const ids = new WeakMap();
    const wrappedOpen = function open(method, url) {
      try {
        const id = submissionIdOf(url);
        if (id && !ids.has(this)) {
          this.addEventListener("load", function () {
            const current = ids.get(this);
            if (!current) return;
            let result = null;
            try {
              if (this.responseType === "json") result = this.response;
              else if (this.responseType === "" || this.responseType === "text") result = parseJson(this.responseText);
            } catch (err) {
              result = null;
            }
            noteResult(current, result);
          });
        }
        if (id) ids.set(this, id);
        else ids.delete(this);
      } catch (err) {
        // never in the page's way
      }
      return pageOpen.apply(this, arguments);
    };
    Object.defineProperty(wrappedOpen, "__lcCaptureWrapped", { value: true });
    xhrProto.open = wrappedOpen;
  }
})();
