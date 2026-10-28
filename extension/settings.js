// LeetCode Capture - options page logic.
//
// This is an extension page, so it is the one place an API key can be typed
// without any script on leetcode.com being able to see it. It never holds a
// key it didn't just receive from the user's keyboard: the companion only ever
// reports whether a key exists. Everything goes through the relay's
// POST /settings/rpc, which only answers requests from an extension origin
// and forwards them to the companion (see relay-server/panel-broker.js).
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

  const $ = (id) => document.getElementById(id);

  let view = null; // latest public view from the companion
  let selected = null; // provider currently chosen in the form
  const keyAction = {}; // provider -> "replace" | "remove" | undefined
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

  // ---- talking to the companion ---------------------------------------------

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

  // ---- rendering -----------------------------------------------------------------

  function activeLabel(active) {
    if (!active) return "";
    return active.model ? `${active.label}, ${active.model}` : active.label;
  }

  function setConnection(ok, text) {
    const el = $("connection");
    if (ok) el.setAttribute("data-ok", "");
    else el.removeAttribute("data-ok");
    $("connection-text").textContent = text;
  }

  // Each cause gets its own instruction; `code` parts render as inline code.
  const OFFLINE_COPY = {
    "relay-down": [
      "Can't reach the relay server on localhost:8135. Start the tutor with ",
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

  function setOffline(kind) {
    $("form").setAttribute("data-disabled", "");
    $("test").disabled = true;
    $("save").disabled = true;
    setConnection(false, "Tutor offline");
    const box = $("offline");
    box.textContent = "";
    for (const part of OFFLINE_COPY[kind] || OFFLINE_COPY["relay-down"]) {
      box.appendChild(typeof part === "string" ? document.createTextNode(part) : h("code", { text: part.code }));
    }
    box.hidden = false;
    if (!pollTimer) pollTimer = setInterval(load, 4000);
  }

  function lockNote(field) {
    const name = view.locks[field];
    return name ? h("p", { class: "hint locked", text: `Set by ${name} in your environment. Remove it there to change it here.` }) : null;
  }

  function isLocked(provider, field) {
    return Boolean(view.locks[field]) && provider === view.provider;
  }

  function keyField(id) {
    const info = view.providers[id];
    const optional = !view.catalog[id].requires.includes("apiKey");
    const input = h("input", { type: "password", id: `${id}-apiKey`, autocomplete: "off", spellcheck: "false", placeholder: id === "anthropic" ? "sk-ant-..." : id === "openai" ? "sk-..." : "Optional" });
    const label = h("label", { for: `${id}-apiKey` }, "API key", optional ? h("span", { class: "opt", text: " (optional)" }) : null);
    const wrap = h("div", { class: "field" }, label);
    if (info.hasKey && keyAction[id] !== "replace" && keyAction[id] !== "remove") {
      const source = info.keySource === "saved" ? "A key is saved" : `Using ${info.keySource} from your environment`;
      const line = h("div", { class: "keyline" }, h("span", { text: source }));
      if (info.keySource === "saved") {
        line.appendChild(h("button", { type: "button", class: "linkbtn", text: "Replace", onclick: () => { keyAction[id] = "replace"; render(); $(`${id}-apiKey`).focus(); } }));
        line.appendChild(h("button", { type: "button", class: "linkbtn", text: "Remove", onclick: () => { keyAction[id] = "remove"; render(); } }));
      }
      wrap.appendChild(line);
    } else if (keyAction[id] === "remove") {
      wrap.appendChild(
        h("div", { class: "keyline" }, h("span", { text: "The key will be removed when you save." }), h("button", { type: "button", class: "linkbtn", text: "Undo", onclick: () => { keyAction[id] = undefined; render(); } }))
      );
    } else {
      wrap.appendChild(input);
      if (id === "local") wrap.appendChild(h("p", { class: "hint", text: "Only needed if your server requires one." }));
    }
    return wrap;
  }

  function fieldFor(id, field) {
    if (field === "apiKey") return keyField(id);
    const info = view.providers[id];
    const locked = isLocked(id, field);
    const required = view.catalog[id].requires.includes(field);
    const defaults = view.defaults[id] || {};
    const value = info[field] === null || info[field] === undefined ? "" : String(info[field]);
    const attrs = { id: `${id}-${field}`, autocomplete: "off", spellcheck: "false", disabled: locked };
    let input;
    if (field === "contextTokens") {
      input = h("input", { ...attrs, type: "number", min: "1024", max: "2000000", step: "1024", value });
    } else {
      input = h("input", {
        ...attrs,
        type: "text",
        value,
        placeholder: field === "model" ? (required ? "Model name" : "Default") : defaults[field] || "",
        list: field === "model" ? `${id}-models` : false,
      });
    }
    const label = h("label", { for: `${id}-${field}` }, FIELD_LABELS[field], required ? null : h("span", { class: "opt", text: " (optional)" }));
    const wrap = h("div", { class: "field" }, label);
    if (field === "model" && (id === "local" || id === "openai")) {
      wrap.appendChild(
        h("div", { class: "row" }, input, h("button", { type: "button", class: "btn", id: `${id}-find`, text: "Find models", disabled: locked, onclick: () => findModels(id) }))
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
    const note = locked ? lockNote(field) : null;
    if (note) wrap.appendChild(note);
    return wrap;
  }

  function providerCard(id) {
    const spec = view.catalog[id];
    const locked = Boolean(view.locks.provider);
    const radio = h("input", {
      type: "radio",
      name: "provider",
      value: id,
      checked: selected === id,
      disabled: locked && view.provider !== id,
      onchange: () => {
        selected = id;
        render();
        clearResults();
      },
    });
    const title = h("div", { class: "provider-title" }, spec.label, id === "chatgpt" ? h("span", { class: "tag", text: "Experimental" }) : null);
    const head = h("label", { class: "provider-head" }, radio, h("div", {}, title, h("div", { class: "provider-hint", text: spec.hint })));
    const fields = h("div", { class: "fields" }, ...spec.fields.map((f) => fieldFor(id, f)));
    return h("div", { class: "provider", "data-selected": selected === id }, head, fields);
  }

  function toggle(id, label, hint, checked) {
    const locked = Boolean(view.locks[id]);
    const wrap = h(
      "div",
      { class: "toggle" },
      h("input", { type: "checkbox", id, checked, disabled: locked }),
      h("label", { for: id, text: label }),
      h("p", { class: "hint", text: hint })
    );
    const note = lockNote(id);
    if (note) wrap.appendChild(note);
    return wrap;
  }

  function renderBehavior() {
    const o = view.options;
    const box = $("behavior");
    box.textContent = "";
    box.appendChild(toggle("autoClearContext", "Start fresh when you switch problems", "The tutor forgets the previous problem, so old code never muddies a new one.", o.autoClearContext));
    box.appendChild(toggle("vaultAutoSummary", "Save Submit reviews to my Obsidian vault", "Turns the tutor's review of each Submit into a note. Needs a vault folder (see the README).", o.vaultAutoSummary));
    const locked = Boolean(view.locks.localMaxHistoryTurns);
    const num = h(
      "div",
      { class: "toggle number" },
      h("label", { for: "localMaxHistoryTurns", text: "Exchanges a local model remembers" }),
      h("input", { type: "number", id: "localMaxHistoryTurns", min: "0", max: "100", value: String(o.localMaxHistoryTurns), disabled: locked }),
      h("p", { class: "hint", text: "Older exchanges are dropped to fit a small context window. 0 keeps everything." })
    );
    const note = lockNote("localMaxHistoryTurns");
    if (note) num.appendChild(note);
    box.appendChild(num);
  }

  function render() {
    const fieldset = $("providers");
    for (const node of [...fieldset.children]) if (node.tagName !== "LEGEND") node.remove();
    for (const id of ORDER) if (view.catalog[id]) fieldset.appendChild(providerCard(id));
    renderBehavior();
    $("path").textContent = view.settingsPath;
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

  function collectPatch() {
    const id = selected;
    const fields = {};
    for (const field of view.catalog[id].fields) {
      if (isLocked(id, field)) continue;
      if (field === "apiKey") {
        if (keyAction[id] === "remove") fields.apiKey = null;
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
    const options = {};
    if (!view.locks.autoClearContext) options.autoClearContext = $("autoClearContext").checked;
    if (!view.locks.vaultAutoSummary) options.vaultAutoSummary = $("vaultAutoSummary").checked;
    if (!view.locks.localMaxHistoryTurns) {
      const turns = $("localMaxHistoryTurns").value.trim();
      options.localMaxHistoryTurns = turns === "" ? null : Number(turns);
    }
    return { provider: view.locks.provider ? undefined : id, providers: { [id]: fields }, options };
  }

  // ---- actions ----------------------------------------------------------------------------

  async function findModels(id) {
    const note = $(`${id}-models-note`);
    const button = $(`${id}-find`);
    button.disabled = true;
    note.textContent = "Looking";
    const baseInput = $(`${id}-baseUrl`);
    const keyInput = $(`${id}-apiKey`);
    const res = await rpc("models", {
      provider: id,
      baseUrl: baseInput ? baseInput.value.trim() || undefined : undefined,
      apiKey: keyInput && keyInput.value.trim() ? keyInput.value.trim() : undefined,
    });
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
    const button = $("test");
    button.disabled = true;
    showResult("test-result", "", "Testing...");
    const res = await rpc("test", { patch: collectPatch() }, 100000);
    button.disabled = false;
    if (!res.ok) {
      showResult("test-result", "error", res.error.message);
      return;
    }
    showResult("test-result", res.result.ok ? "ok" : "error", res.result.message);
  }

  async function save(event) {
    event.preventDefault();
    const button = $("save");
    button.disabled = true;
    showResult("save-result", "", "Saving...");
    const res = await rpc("save", { patch: collectPatch() });
    button.disabled = false;
    if (!res.ok) {
      showResult("save-result", "error", res.error.message);
      if (res.error.field) {
        const target = $(`${selected}-${res.error.field}`);
        if (target) target.focus();
      }
      return;
    }
    for (const key of Object.keys(keyAction)) delete keyAction[key];
    applyView(res.result);
    showResult("save-result", "ok", `Saved. The tutor now uses ${activeLabel(res.result.active)}.`);
  }

  function applyView(result) {
    view = result.settings;
    selected = view.provider;
    $("offline").hidden = true;
    $("form").removeAttribute("data-disabled");
    $("test").disabled = false;
    $("save").disabled = false;
    setConnection(true, `Tutor running: ${activeLabel(result.active)}`);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    render();
  }

  async function load() {
    const res = await rpc("get", {});
    if (!res.ok) {
      if (res.error.offline) setOffline(res.error.offline);
      else if (!view) setOffline("relay-down");
      return;
    }
    // Polling only runs while the form is disabled (the tutor was offline), so
    // re-rendering here cannot clobber anything the user was typing.
    applyView(res.result);
  }

  $("form").addEventListener("submit", save);
  $("test").addEventListener("click", runTest);
  load();
})();
