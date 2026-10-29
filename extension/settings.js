// LeetCode Capture - options page logic.
//
// This is an extension page, so it is the one place an API key can be typed
// without any script on leetcode.com being able to see it. It never holds a
// key it didn't just receive from the user's keyboard: whoever stores the key
// only ever reports whether one exists (`hasKey`).
//
// The tutor runs in one of two places (see README.md, "Runtimes"):
//   - In the browser (the "extension" runtime): the extension's background
//     worker runs it, for a local model or an API key, nothing to install.
//     Settings and keys live in the extension's own storage, and this page
//     talks only to the worker (runtime messages 'lc-tutor:settings-*', see
//     shared/tutor-service.js). The relay is never needed.
//   - Through the helper (the companion on this computer), which the Claude
//     and ChatGPT subscriptions need. Its settings live in the companion's
//     file and go through the relay's POST /settings/rpc, which only answers
//     an extension origin (see relay-server/panel-broker.js).
// The provider and the runtime chosen are always saved in the extension, so
// the Tutor panel and content.js know where to send things.
//
// The browser asks the user before the extension may reach a server: Save,
// Test connection and Find models request that host permission first, while
// the click still counts as the user's own action.
//
// All text is inserted with textContent / createElement, never innerHTML.

(() => {
  const RELAY = "http://localhost:8135";
  const ORDER = ["local", "claude", "chatgpt", "anthropic", "openai"];
  const FIELD_LABELS = {
    baseUrl: "Server URL",
    model: "Model",
    contextTokens: "Context window (tokens)",
    apiKey: "API key",
  };
  const RUNTIME_LABELS = {
    extension: "In the browser",
    helper: "Through the helper app",
  };
  const ANTHROPIC_ORIGIN = "https://api.anthropic.com/*";

  // The provider catalog, the same one the companion uses
  // (shared/providers.js). A classic script cannot import it, so the worker
  // hands it over with the extension settings.
  let catalog = null;

  const api = typeof browser !== "undefined" ? browser : chrome;
  const $ = (id) => document.getElementById(id);

  let ext = null; // { settings, active, permission } from the worker
  let helper = null; // the companion's view ({ settings, active }), or null
  let helperOffline = null; // why the helper can't be asked, or null
  let selected = null; // provider currently chosen in the form
  const runtimeChoice = {}; // provider -> "extension" | "helper", as chosen in the form
  const keyAction = {}; // `${runtime}:${provider}` -> "replace" | "remove" | undefined
  let pollTimer = null;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (name === "class") node.className = value;
      else if (name === "text") node.textContent = value;
      else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? "" : value);
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  // ---- talking to the worker (extension runtime) -----------------------------

  // Resolves to { ok, result } or { ok: false, error: { message, field? } }.
  async function worker(type, params = {}) {
    try {
      const answer = await api.runtime.sendMessage({ type, params });
      if (answer && typeof answer.ok === "boolean") return answer;
      return { ok: false, error: { message: "The extension did not answer." } };
    } catch (err) {
      return { ok: false, error: { message: `The extension did not answer (${err && err.message ? err.message : "error"}).` } };
    }
  }

  // ---- talking to the companion (helper runtime) -----------------------------

  // Resolves to { ok, result } or { ok: false, error: { message, offline? } }.
  async function rpc(method, params, timeoutMs = 20000) {
    let res;
    try {
      res = await fetch(`${RELAY}/settings/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err && err.name === "TimeoutError";
      return {
        ok: false,
        error: {
          message: timedOut ? "That took too long. Try again." : "Can't reach the relay server on localhost:8135.",
          offline: !timedOut ? "relay-down" : undefined,
        },
      };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // handled below
    }
    if (res.status === 503) return { ok: false, error: { message: "The tutor isn't running.", offline: "companion-down" } };
    if (res.status === 404) {
      return { ok: false, error: { message: "The relay server is from an older version.", offline: "relay-old" } };
    }
    if (res.status === 403) return { ok: false, error: { message: "The relay refused this request." } };
    if (!body || typeof body.ok !== "boolean") return { ok: false, error: { message: "Unexpected answer from the relay." } };
    return body;
  }

  // ---- host permissions ------------------------------------------------------------

  // The match pattern for the server a provider's form points at, or null
  // when it reaches no server from the browser.
  function originPatternFor(id) {
    if (id === "anthropic") return ANTHROPIC_ORIGIN;
    if (id !== "local" && id !== "openai") return null;
    const input = $(`${id}-baseUrl`);
    const raw = (input && input.value.trim()) || (ext.settings.defaults[id] || {}).baseUrl;
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return `${url.protocol}//${url.hostname}/*`;
    } catch {
      return null;
    }
  }

  // Must be called straight from a click, before anything is awaited, or the
  // browser refuses to ask. Resolves true when the extension may reach the
  // server (already allowed, or the user just allowed it).
  function requestPermission(pattern) {
    if (!pattern) return Promise.resolve(true);
    try {
      return Promise.resolve(api.permissions.request({ origins: [pattern] })).then(Boolean, () => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  function deniedMessage(pattern) {
    const host = pattern.replace(/\/\*$/, "");
    return `The browser did not allow the extension to reach ${host}, so the tutor can't use it. Press the button again and choose Allow.`;
  }

  // ---- state helpers -----------------------------------------------------------

  function runtimesOf(id) {
    return catalog[id].runtimes;
  }

  function runtimeOf(id) {
    const options = runtimesOf(id);
    const chosen = runtimeChoice[id];
    return options.includes(chosen) ? chosen : options[0];
  }

  // The values a provider's fields show: the extension's for the browser
  // runtime, the companion's for the helper (null while it is offline).
  function infoFor(id) {
    if (runtimeOf(id) === "extension") return ext.settings.providers[id];
    return helper ? helper.settings.providers[id] : null;
  }

  function helperLocked(field) {
    return Boolean(helper && helper.settings.locks[field]);
  }

  function isLocked(id, field) {
    if (runtimeOf(id) !== "helper") return false;
    return helperLocked(field) && helper.settings.provider === id;
  }

  function usable(id) {
    return runtimeOf(id) === "extension" || Boolean(helper);
  }

  function activeLabel(active) {
    if (!active) return "";
    return active.model ? `${active.label}, ${active.model}` : active.label;
  }

  // ---- rendering -----------------------------------------------------------------

  function setConnection(ok, text) {
    const el = $("connection");
    if (ok) el.setAttribute("data-ok", "");
    else el.removeAttribute("data-ok");
    $("connection-text").textContent = text;
  }

  // What the tutor runs on right now, from what is saved.
  function renderConnection() {
    const saved = ext.settings.provider;
    if (saved && ext.settings.runtime === "extension") {
      setConnection(true, `Tutor running in the browser: ${activeLabel(ext.active)}`);
    } else if (helper) {
      setConnection(true, `Tutor running: ${activeLabel(helper.active)}`);
    } else if (saved) {
      setConnection(false, "Helper offline");
    } else {
      setConnection(false, "Not set up");
    }
  }

  // Each cause gets its own instruction; `code` parts render as inline code.
  const OFFLINE_COPY = {
    "relay-down": [
      "This provider runs through the helper app, and it isn't running: can't reach the relay server on localhost:8135. Start the tutor with ",
      { code: "leetcode" },
      " (or run ",
      { code: "node companion.js" },
      " in the companion folder). This page reconnects on its own.",
    ],
    "companion-down": [
      "The relay is running but the tutor isn't. Start it with ",
      { code: "leetcode" },
      ". This page reconnects on its own.",
    ],
    "relay-old": [
      "The relay server is from an older version without settings support. Quit the tutor and start it again with ",
      { code: "leetcode" },
      ".",
    ],
  };

  function renderOffline() {
    const box = $("offline");
    const show = selected && runtimeOf(selected) === "helper" && !helper;
    box.hidden = !show;
    if (!show) return;
    box.textContent = "";
    for (const part of OFFLINE_COPY[helperOffline] || OFFLINE_COPY["relay-down"]) {
      box.appendChild(typeof part === "string" ? document.createTextNode(part) : h("code", { text: part.code }));
    }
  }

  function lockNote(field) {
    const name = helper && helper.settings.locks[field];
    return name ? h("p", { class: "hint locked", text: `Set by ${name} in your environment. Remove it there to change it here.` }) : null;
  }

  function keyField(id, info) {
    const runtime = runtimeOf(id);
    const action = keyAction[`${runtime}:${id}`];
    const optional = !catalog[id].requires.includes("apiKey");
    const input = h("input", {
      type: "password",
      id: `${id}-apiKey`,
      autocomplete: "off",
      spellcheck: "false",
      disabled: !info,
      placeholder: id === "anthropic" ? "sk-ant-..." : id === "openai" ? "sk-..." : "Optional",
    });
    const label = h("label", { for: `${id}-apiKey` }, "API key", optional ? h("span", { class: "opt", text: " (optional)" }) : null);
    const wrap = h("div", { class: "field" }, label);
    const setAction = (next) => {
      keyAction[`${runtime}:${id}`] = next;
      render();
    };
    if (info && info.hasKey && action !== "replace" && action !== "remove") {
      // The extension stores keys itself; the companion may also take one
      // from the environment.
      const source = runtime === "extension" || info.keySource === "saved" ? "A key is saved" : `Using ${info.keySource} from your environment`;
      const line = h("div", { class: "keyline" }, h("span", { text: source }));
      if (runtime === "extension" || info.keySource === "saved") {
        line.appendChild(h("button", { type: "button", class: "linkbtn", text: "Replace", onclick: () => { setAction("replace"); $(`${id}-apiKey`).focus(); } }));
        line.appendChild(h("button", { type: "button", class: "linkbtn", text: "Remove", onclick: () => setAction("remove") }));
      }
      wrap.appendChild(line);
    } else if (action === "remove") {
      wrap.appendChild(
        h("div", { class: "keyline" }, h("span", { text: "The key will be removed when you save." }), h("button", { type: "button", class: "linkbtn", text: "Undo", onclick: () => setAction(undefined) }))
      );
    } else {
      wrap.appendChild(input);
      if (id === "local") wrap.appendChild(h("p", { class: "hint", text: "Only needed if your server requires one." }));
    }
    return wrap;
  }

  function fieldFor(id, field) {
    const info = infoFor(id);
    if (field === "apiKey") return keyField(id, info);
    const runtime = runtimeOf(id);
    const locked = isLocked(id, field);
    const required = catalog[id].requires.includes(field);
    const defaults = (runtime === "extension" ? ext.settings.defaults[id] : helper && helper.settings.defaults[id]) || {};
    const raw = info ? info[field] : null;
    const value = raw === null || raw === undefined ? "" : String(raw);
    const attrs = { id: `${id}-${field}`, autocomplete: "off", spellcheck: "false", disabled: locked || !info };
    let input;
    if (field === "contextTokens") {
      input = h("input", { ...attrs, type: "number", min: "1024", max: "2000000", step: "1024", value });
    } else {
      input = h("input", {
        ...attrs,
        type: "text",
        value,
        placeholder: field === "model" ? (required ? "Model name" : defaults.model || "Default") : defaults[field] || "",
        list: field === "model" ? `${id}-models` : false,
      });
    }
    const label = h("label", { for: `${id}-${field}` }, FIELD_LABELS[field], required ? null : h("span", { class: "opt", text: " (optional)" }));
    const wrap = h("div", { class: "field" }, label);
    const findable = field === "model" && (id === "local" || id === "openai" || (id === "anthropic" && runtime === "extension"));
    if (findable) {
      wrap.appendChild(
        h("div", { class: "row" }, input, h("button", { type: "button", class: "btn", id: `${id}-find`, text: "Find models", disabled: locked || !info, onclick: () => findModels(id) }))
      );
      wrap.appendChild(h("datalist", { id: `${id}-models` }));
      wrap.appendChild(h("p", { class: "hint", id: `${id}-models-note` }));
    } else {
      wrap.appendChild(input);
    }
    if (field === "contextTokens") {
      wrap.appendChild(h("p", { class: "hint", text: "How much text the model reads at once. Larger needs more memory; Ollama is asked for this window." }));
    }
    if (field === "baseUrl" && id === "openai") {
      wrap.appendChild(h("p", { class: "hint", text: "Leave as is unless you use an OpenAI-compatible proxy." }));
    }
    if (field === "baseUrl" && id === "local" && runtime === "extension") {
      wrap.appendChild(
        h(
          "p",
          { class: "hint" },
          "Ollama answers the extension only if it is allowed to. Set this where Ollama runs, then restart it:",
          h("br"),
          h("code", { class: "nowrap", text: `OLLAMA_ORIGINS=${location.origin}` })
        )
      );
    }
    const note = locked ? lockNote(field) : null;
    if (note) wrap.appendChild(note);
    return wrap;
  }

  // Where the tutor runs for a provider: a choice for those that can run in
  // the browser, a note for those that need the helper.
  function runtimeRow(id) {
    const options = runtimesOf(id);
    if (options.length === 1) {
      return h("p", { class: "hint runtime-note", text: "Runs through the helper app on your computer (it uses your local sign-in)." });
    }
    const group = h("div", { class: "runtime", role: "radiogroup", "aria-label": "Where the tutor runs" });
    for (const runtime of options) {
      const inputId = `${id}-runtime-${runtime}`;
      group.appendChild(
        h(
          "label",
          { class: "runtime-option", for: inputId },
          h("input", {
            type: "radio",
            id: inputId,
            name: `${id}-runtime`,
            value: runtime,
            checked: runtimeOf(id) === runtime,
            onchange: () => {
              runtimeChoice[id] = runtime;
              render();
              clearResults();
              if (runtime === "helper" && !helper) loadHelper();
            },
          }),
          h("span", { text: RUNTIME_LABELS[runtime] }),
          h("span", { class: "opt", text: runtime === "extension" ? " (nothing to install)" : " (the companion)" })
        )
      );
    }
    return h("div", { class: "field" }, h("span", { class: "label", text: "Where the tutor runs" }), group);
  }

  function providerCard(id) {
    const spec = catalog[id];
    const providerLocked = helperLocked("provider") && runtimeOf(id) === "helper";
    const radio = h("input", {
      type: "radio",
      name: "provider",
      value: id,
      checked: selected === id,
      disabled: providerLocked && helper.settings.provider !== id,
      onchange: () => {
        selected = id;
        render();
        clearResults();
        if (runtimeOf(id) === "helper" && !helper) loadHelper();
      },
    });
    const title = h("div", { class: "provider-title" }, spec.label, id === "chatgpt" ? h("span", { class: "tag", text: "Experimental" }) : null);
    const head = h("label", { class: "provider-head" }, radio, h("div", {}, title, h("div", { class: "provider-hint", text: spec.hint })));
    const fields = h("div", { class: "fields" }, runtimeRow(id), ...spec.fields.map((f) => fieldFor(id, f)));
    return h("div", { class: "provider", "data-selected": selected === id }, head, fields);
  }

  function toggle(id, label, hint, checked, { locked = false, disabled = false } = {}) {
    const wrap = h(
      "div",
      { class: "toggle" },
      h("input", { type: "checkbox", id, checked, disabled: locked || disabled }),
      h("label", { for: id, text: label }),
      h("p", { class: "hint", text: hint })
    );
    const note = locked ? lockNote(id) : null;
    if (note) wrap.appendChild(note);
    return wrap;
  }

  function renderBehavior() {
    const inBrowser = runtimeOf(selected) === "extension";
    const o = inBrowser ? ext.settings.options : helper ? helper.settings.options : { autoClearContext: true, vaultAutoSummary: false, localMaxHistoryTurns: 6 };
    const off = !inBrowser && !helper;
    const box = $("behavior");
    box.textContent = "";
    box.appendChild(
      toggle("autoClearContext", "Start fresh when you switch problems", "The tutor forgets the previous problem, so old code never muddies a new one.", o.autoClearContext, {
        locked: !inBrowser && helperLocked("autoClearContext"),
        disabled: off,
      })
    );
    box.appendChild(
      toggle(
        "vaultAutoSummary",
        "Save Submit reviews to my Obsidian vault",
        inBrowser
          ? "Needs the helper app, which can write to your vault folder. Choose \"Through the helper app\" above to use it."
          : "Turns the tutor's review of each Submit into a note. Needs a vault folder (see the README).",
        inBrowser ? false : o.vaultAutoSummary,
        { locked: !inBrowser && helperLocked("vaultAutoSummary"), disabled: inBrowser || off }
      )
    );
    const locked = !inBrowser && helperLocked("localMaxHistoryTurns");
    const num = h(
      "div",
      { class: "toggle number" },
      h("label", { for: "localMaxHistoryTurns", text: "Exchanges a local model remembers" }),
      h("input", { type: "number", id: "localMaxHistoryTurns", min: "0", max: "100", value: String(o.localMaxHistoryTurns), disabled: locked || off }),
      h("p", { class: "hint", text: "Older exchanges are condensed into a short summary to fit a small context window. 0 keeps everything." })
    );
    const note = locked ? lockNote("localMaxHistoryTurns") : null;
    if (note) num.appendChild(note);
    box.appendChild(num);
  }

  function renderFoot() {
    const foot = $("foot");
    foot.textContent = "";
    if (runtimeOf(selected) === "extension") {
      foot.appendChild(
        document.createTextNode(
          "Settings and API keys are stored in this browser's extension storage, where web pages can't read them. A key is only ever sent to the provider you choose."
        )
      );
      return;
    }
    foot.appendChild(document.createTextNode("Settings are stored in "));
    foot.appendChild(h("code", { id: "path", text: helper ? helper.settings.settingsPath : "your config folder" }));
    foot.appendChild(document.createTextNode(", readable only by you. API keys never leave your computer except to the provider you choose."));
  }

  function render() {
    const fieldset = $("providers");
    for (const node of [...fieldset.children]) if (node.tagName !== "LEGEND") node.remove();
    for (const id of ORDER) if (catalog[id]) fieldset.appendChild(providerCard(id));
    renderBehavior();
    renderOffline();
    renderConnection();
    renderFoot();
    const can = usable(selected);
    $("test").disabled = !can;
    $("save").disabled = !can;
    if (can) $("form").removeAttribute("data-disabled");
    else $("form").setAttribute("data-disabled", "");
    // Poll for the helper only while it is the one needed and not there.
    if (!can && !pollTimer) pollTimer = setInterval(loadHelper, 4000);
    if (can && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function clearResults() {
    for (const id of ["test-result", "save-result"]) {
      $(id).textContent = "";
      $(id).removeAttribute("data-kind");
    }
  }

  function showResult(id, kind, text) {
    const el = $(id);
    el.textContent = text;
    if (kind) el.setAttribute("data-kind", kind);
    else el.removeAttribute("data-kind");
  }

  // ---- reading the form back --------------------------------------------------------

  function collectFields(id) {
    const fields = {};
    const runtime = runtimeOf(id);
    for (const field of catalog[id].fields) {
      if (isLocked(id, field)) continue;
      if (field === "apiKey") {
        if (keyAction[`${runtime}:${id}`] === "remove") fields.apiKey = null;
        else {
          const input = $(`${id}-apiKey`);
          const typed = input ? input.value.trim() : "";
          if (typed) fields.apiKey = typed;
        }
        continue;
      }
      const raw = $(`${id}-${field}`).value.trim();
      if (field === "contextTokens") fields[field] = raw === "" ? null : Number(raw);
      else fields[field] = raw === "" ? null : raw;
    }
    return fields;
  }

  function collectOptions(inBrowser) {
    const options = {};
    if (inBrowser || !helperLocked("autoClearContext")) options.autoClearContext = $("autoClearContext").checked;
    if (!inBrowser && !helperLocked("vaultAutoSummary")) options.vaultAutoSummary = $("vaultAutoSummary").checked;
    if (inBrowser || !helperLocked("localMaxHistoryTurns")) {
      const turns = $("localMaxHistoryTurns").value.trim();
      options.localMaxHistoryTurns = turns === "" ? null : Number(turns);
    }
    return options;
  }

  // The patch for the companion (helper runtime), in its own shape.
  function helperPatch() {
    const id = selected;
    return { provider: helperLocked("provider") ? undefined : id, providers: { [id]: collectFields(id) }, options: collectOptions(false) };
  }

  // The patch for the extension (browser runtime).
  function extensionPatch() {
    const id = selected;
    return { provider: id, runtime: "extension", providers: { [id]: collectFields(id) }, options: collectOptions(true) };
  }

  // ---- actions ----------------------------------------------------------------------------

  async function findModels(id) {
    const inBrowser = runtimeOf(id) === "extension";
    // Asked first, while this still counts as the click.
    const pattern = inBrowser ? originPatternFor(id) : null;
    const allowed = inBrowser ? requestPermission(pattern) : Promise.resolve(true);
    const note = $(`${id}-models-note`);
    const button = $(`${id}-find`);
    button.disabled = true;
    note.textContent = "Looking";
    const baseInput = $(`${id}-baseUrl`);
    const keyInput = $(`${id}-apiKey`);
    const params = {
      provider: id,
      baseUrl: baseInput ? baseInput.value.trim() || undefined : undefined,
      apiKey: keyInput && keyInput.value.trim() ? keyInput.value.trim() : undefined,
    };
    if (!(await allowed)) {
      button.disabled = false;
      note.textContent = deniedMessage(pattern);
      return;
    }
    const res = inBrowser ? await worker("lc-tutor:settings-models", params) : await rpc("models", params);
    button.disabled = false;
    if (!res.ok) {
      note.textContent = res.error.message;
      return;
    }
    const list = $(`${id}-models`);
    list.textContent = "";
    for (const name of res.result.models) list.appendChild(h("option", { value: name }));
    note.textContent = res.result.models.length
      ? `Found ${res.result.models.length}. Start typing the model field to pick one.`
      : res.result.message || "No models found.";
  }

  async function runTest() {
    const inBrowser = runtimeOf(selected) === "extension";
    const pattern = inBrowser ? originPatternFor(selected) : null;
    const allowed = inBrowser ? requestPermission(pattern) : Promise.resolve(true);
    const button = $("test");
    button.disabled = true;
    showResult("test-result", "", "Testing...");
    const patch = inBrowser ? extensionPatch() : helperPatch();
    if (!(await allowed)) {
      button.disabled = false;
      showResult("test-result", "error", deniedMessage(pattern));
      return;
    }
    const res = inBrowser ? await worker("lc-tutor:settings-test", { patch }) : await rpc("test", { patch }, 100000);
    button.disabled = false;
    if (!res.ok) {
      showResult("test-result", "error", res.error.message);
      return;
    }
    showResult("test-result", res.result.ok ? "ok" : "error", res.result.message);
  }

  function failSave(error) {
    showResult("save-result", "error", error.message);
    if (error.field) {
      const target = $(`${selected}-${error.field}`);
      if (target) target.focus();
    }
  }

  async function save(event) {
    event.preventDefault();
    const inBrowser = runtimeOf(selected) === "extension";
    const pattern = inBrowser ? originPatternFor(selected) : null;
    const allowed = inBrowser ? requestPermission(pattern) : Promise.resolve(true);
    const button = $("save");
    button.disabled = true;
    showResult("save-result", "", "Saving...");
    if (inBrowser) {
      const patch = extensionPatch();
      if (!(await allowed)) {
        button.disabled = false;
        showResult("save-result", "error", deniedMessage(pattern));
        return;
      }
      const res = await worker("lc-tutor:settings-save", { patch });
      button.disabled = false;
      if (!res.ok) {
        failSave(res.error);
        return;
      }
      forgetKeyActions("extension");
      ext = res.result;
      render();
      showResult("save-result", "ok", `Saved. The tutor now runs in the browser with ${activeLabel(ext.active)}.`);
      return;
    }
    const res = await rpc("save", { patch: helperPatch() });
    if (!res.ok) {
      button.disabled = false;
      failSave(res.error);
      return;
    }
    helper = res.result;
    // The extension remembers that this provider runs through the helper, so
    // captures and the Tutor panel go to the relay.
    const provider = helper.settings.provider;
    const routed = await worker("lc-tutor:settings-save", { patch: { provider, runtime: "helper" } });
    button.disabled = false;
    if (routed.ok) ext = routed.result;
    forgetKeyActions("helper");
    selected = provider;
    render();
    if (!routed.ok) {
      showResult("save-result", "error", `Saved in the helper, but the extension could not switch to it: ${routed.error.message}`);
      return;
    }
    showResult("save-result", "ok", `Saved. The tutor now uses ${activeLabel(helper.active)}.`);
  }

  function forgetKeyActions(runtime) {
    for (const key of Object.keys(keyAction)) if (key.startsWith(`${runtime}:`)) delete keyAction[key];
  }

  // ---- loading ------------------------------------------------------------------------

  async function loadHelper() {
    const res = await rpc("get", {});
    if (!res.ok) {
      if (helper === null) helperOffline = res.error.offline || "relay-down";
      if (catalog) render();
      return;
    }
    helper = res.result;
    helperOffline = null;
    render();
  }

  async function load() {
    const res = await worker("lc-tutor:settings-get");
    if (!res.ok) {
      setConnection(false, "Extension error");
      showResult("save-result", "error", res.error.message);
      return;
    }
    ext = res.result;
    catalog = ext.catalog;
    for (const [id, runtime] of Object.entries(ext.settings.runtimes)) runtimeChoice[id] = runtime;
    selected = ext.settings.provider;
    const helperFirst = rpc("get", {});
    if (!selected) {
      // Nothing chosen yet: show what the helper runs, if one is running;
      // otherwise a local model, which needs nothing installed.
      const res2 = await helperFirst;
      if (res2.ok) {
        // An existing helper setup, from before the extension could run the
        // tutor itself: start from exactly what it runs.
        helper = res2.result;
        selected = helper.settings.provider;
        if (runtimesOf(selected).includes("helper")) runtimeChoice[selected] = "helper";
      } else {
        helperOffline = res2.error.offline || "relay-down";
        selected = "local";
      }
      render();
      return;
    }
    render();
    const res2 = await helperFirst;
    if (res2.ok) {
      helper = res2.result;
      helperOffline = null;
    } else {
      helperOffline = res2.error.offline || "relay-down";
    }
    render();
  }

  $("form").addEventListener("submit", save);
  $("test").addEventListener("click", runTest);
  load();
})();
