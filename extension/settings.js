// LeetCode Capture - options page logic.
//
// This is an extension page, so it is the one place an API key can be typed
// without any script on leetcode.com being able to see it. It never holds a
// key it didn't just receive from the user's keyboard: whoever stores the key
// only ever reports whether one exists (`hasKey`).
//
// The tutor runs in one of two places (browser or helper):
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

  // The helper's relay and tutor are only up while a LeetCode problem tab is
  // open (or this page asks for them), so a save, a test or a model search
  // made without one finds nothing there. These ask the worker to start the
  // helper, wait for it (up to about 15 s), and try once more.
  async function rpcStarting(method, params, timeoutMs, note) {
    let res = await rpc(method, params, timeoutMs);
    if (res.ok || !res.error.offline || res.error.offline === "relay-old") return res;
    if (note) note("Starting the helper...");
    await workerHelper("lc-tutor:helper-retry");
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 700));
      // eslint-disable-next-line no-await-in-loop
      const up = await rpc("get", {}, 2500);
      if (up.ok) break;
      await workerHelper("lc-tutor:helper-status");
    }
    res = await rpc(method, params, timeoutMs);
    if (!res.ok && res.error.offline) {
      res = { ok: false, error: { ...res.error, message: `${res.error.message} The helper did not start: check the Helper section below and press Check again.` } };
    }
    return res;
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

  // ---- the helper app (Native Messaging) ----------------------------------------
  //
  // For a provider that runs through the helper, the extension can start the
  // companion and relay itself once the helper app is installed and the
  // optional nativeMessaging permission is granted. The worker owns the
  // connection (shared/helper-launcher.js); this page shows its state, asks
  // for the permission and shows the install command.

  const HELPER_HOST = "dev.thomsonklee.leetcode_capture";
  const HELPER_PACKAGE = "leetcode-capture-helper";
  const NATIVE = { permissions: ["nativeMessaging"] };
  let helperInfo = null; // the worker's view, see background.js helperView
  let helperProbe = null; // "installed" | "not-installed" | { error } from a direct ping, or null
  let helperTimer = null;
  let helperError = null;

  function installCommand() {
    const id = api.runtime.id;
    return /^[a-p]{32}$/.test(id) ? `npx ${HELPER_PACKAGE} install --chrome-id ${id}` : `npx ${HELPER_PACKAGE} install`;
  }

  // Only called while the Helper section is shown, that is while a provider
  // that runs through the helper is chosen in the form, so each call also
  // asks the worker to start the helper (`want`): the provider can only be
  // saved once the helper runs. The wish lapses about 20 s after the section
  // hides or this page closes.
  async function workerHelper(type) {
    try {
      return await api.runtime.sendMessage({ type, want: true });
    } catch {
      return null;
    }
  }

  // Pings the helper directly, which only tells whether it is installed: it
  // starts nothing until the worker asks.
  function probeHelper() {
    return new Promise((resolve) => {
      if (typeof api.runtime.connectNative !== "function") {
        resolve("not-installed");
        return;
      }
      let port;
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          port.disconnect();
        } catch {
          // already gone
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ error: "The helper did not answer." }), 4000);
      try {
        port = api.runtime.connectNative(HELPER_HOST);
      } catch (err) {
        finish({ error: err && err.message ? err.message : "Could not start the helper." });
        return;
      }
      port.onMessage.addListener((message) => {
        if (message && message.type === "pong") finish("installed");
      });
      port.onDisconnect.addListener(() => {
        const reason = (port.error && port.error.message) || (api.runtime.lastError && api.runtime.lastError.message) || "";
        finish(/not found|no such native application|not registered|forbidden/i.test(reason) ? "not-installed" : { error: reason || "The helper stopped." });
      });
      port.postMessage({ type: "ping", id: 1 });
    });
  }

  async function refreshHelper({ retry = false, probe = false } = {}) {
    helperInfo = await workerHelper(retry ? "lc-tutor:helper-retry" : "lc-tutor:helper-status");
    if (helperInfo && helperInfo.permission && (probe || helperProbe === null) && helperInfo.state !== "running" && helperInfo.state !== "connecting") {
      helperProbe = await probeHelper();
    }
    if (helperInfo && !helperInfo.permission) helperProbe = null;
    // Running proves it is installed, for when it stops again.
    if (helperInfo && helperInfo.state === "running") helperProbe = "installed";
    drawHelper();
  }

  // What to show: [light ("ok" | "bad" | null), label].
  function helperSummary() {
    if (!helperInfo) return [null, "Checking"];
    if (!helperInfo.permission) return [null, "Not allowed yet"];
    if (helperInfo.state === "running") {
      const host = helperInfo.host || {};
      if (host.error) return ["bad", "Error"];
      if (host.relay && host.relay.state === "external") return ["ok", "Running (started by hand)"];
      return ["ok", "Running"];
    }
    if (helperInfo.state === "connecting") return [null, "Starting"];
    if (helperInfo.state === "not-installed" || helperProbe === "not-installed") return ["bad", "Not installed"];
    if (helperProbe === "installed") return ["ok", "Installed"];
    if (helperProbe && helperProbe.error) return ["bad", "Error"];
    return [null, "Checking"];
  }

  function helperErrorText() {
    if (helperError) return helperError;
    if (!helperInfo || !helperInfo.permission) return null;
    if (helperInfo.state === "running" && helperInfo.host && helperInfo.host.error) return `The helper says: ${helperInfo.host.error}`;
    if (helperInfo.state === "error" && helperInfo.error) return `The helper stopped: ${helperInfo.error}`;
    if (helperProbe && helperProbe.error && helperInfo.state !== "running") return `The helper could not be reached: ${helperProbe.error}`;
    return null;
  }

  function commandRow(command, label) {
    const status = h("span", { class: "result", role: "status", "aria-live": "polite" });
    const copy = h("button", {
      type: "button",
      class: "btn",
      text: "Copy",
      "aria-label": `Copy the ${label} command`,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(command);
          status.textContent = "Copied";
        } catch {
          status.textContent = "Select the command and copy it";
        }
      },
    });
    return h("div", { class: "helper-step" }, h("div", { class: "helper-command" }, h("code", { text: command }), copy), status);
  }

  function drawHelper() {
    const card = $("helper-card");
    if (card.hidden) return;
    const [light, label] = helperSummary();
    const state = $("helper-state");
    if (light === "ok") state.setAttribute("data-ok", "");
    else state.removeAttribute("data-ok");
    if (light === "bad") state.setAttribute("data-state", "bad");
    else state.removeAttribute("data-state");
    $("helper-state-text").textContent = label;

    const body = $("helper-body");
    body.textContent = "";
    if (helperInfo && !helperInfo.permission) {
      body.appendChild(
        h(
          "div",
          { class: "helper-step" },
          h("p", { class: "hint", text: "First, let the extension start the helper app. The browser asks once." }),
          h(
            "div",
            { class: "actions" },
            h("button", {
              type: "button",
              id: "helper-permission",
              class: "btn primary",
              text: "Allow starting the helper",
              onclick: () => {
                helperError = null;
                // Straight from the click, before any await.
                let asked;
                try {
                  asked = Promise.resolve(api.permissions.request(NATIVE));
                } catch {
                  asked = Promise.resolve(false);
                }
                asked
                  .then(Boolean, () => false)
                  .then((granted) => {
                    if (!granted) helperError = "The browser did not allow it, so the extension can't start the helper. Press the button again and choose Allow.";
                    return refreshHelper({ probe: true });
                  });
              },
            })
          )
        )
      );
    } else if (helperInfo) {
      const installed = helperInfo.state === "running" || helperProbe === "installed";
      if (!installed) {
        body.appendChild(h("p", { class: "hint", text: "Install the helper once by running this in a terminal, then press Check again:" }));
        body.appendChild(commandRow(installCommand(), "install"));
      } else {
        body.appendChild(
          h("p", {
            class: "hint",
            text:
              helperInfo.state === "running"
                ? "The tutor is running. It stops 30 seconds after you close the last LeetCode problem tab."
                : "It starts by itself when you open a LeetCode problem.",
          })
        );
      }
      body.appendChild(
        h(
          "div",
          { class: "actions" },
          h("button", {
            type: "button",
            id: "helper-check",
            class: "btn",
            text: "Check again",
            onclick: () => {
              helperError = null;
              refreshHelper({ retry: true, probe: true });
            },
          })
        )
      );
      if (installed) {
        body.appendChild(h("p", { class: "hint", text: "To remove it, run:" }));
        body.appendChild(commandRow(`npx ${HELPER_PACKAGE} uninstall`, "uninstall"));
      }
    }
    const error = helperErrorText();
    $("helper-error").hidden = !error;
    $("helper-error").textContent = error || "";
  }

  function renderHelper() {
    const show = Boolean(selected && catalog[selected] && runtimeOf(selected) === "helper");
    const card = $("helper-card");
    const wasHidden = card.hidden;
    card.hidden = !show;
    if (!show) {
      if (helperTimer) clearInterval(helperTimer);
      helperTimer = null;
      return;
    }
    drawHelper();
    if (wasHidden) refreshHelper();
    if (!helperTimer) helperTimer = setInterval(() => refreshHelper(), 5000);
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
      "This provider runs through the helper app, and it isn't running (nothing answers on localhost:8135). Set it up in the Helper section below. If you run the tutor from a terminal instead, start it with ",
      { code: "leetcode" },
      " (or ",
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

  // The local provider's model is picked from a dropdown of what the server
  // actually has (Ollama's /api/tags or /v1/models), not typed. Embedding and
  // reranker models are left out: they cannot chat.
  const foundModels = {};
  const typeModelByHand = {};
  const modelsNote = {};
  const NOT_CHAT = /embed|rerank/i;
  const OTHER = "__other__";

  // `flag` is the typeModelByHand key that remembers "Other" was picked
  // (the provider's card, or the Models card's add row).
  function modelSelect(id, value, attrs, flag = id) {
    const names = (foundModels[id] || []).filter((n) => !NOT_CHAT.test(n) || n === value);
    const select = h("select", { ...attrs, onchange: () => {
      if (select.value === OTHER) {
        // In place, so nothing typed in the other fields is lost.
        typeModelByHand[flag] = true;
        const box = h("input", { ...attrs, type: "text", value: "", placeholder: "Model name" });
        select.replaceWith(box);
        box.focus();
      }
    } });
    if (!names.length && !value) select.appendChild(h("option", { value: "", text: "No models found yet" }));
    if (value && !names.includes(value)) names.unshift(value);
    for (const name of names) select.appendChild(h("option", { value: name, text: name, selected: name === value }));
    select.appendChild(h("option", { value: OTHER, text: "Other (type a name)..." }));
    return select;
  }

  // The Claude subscription's models: Claude Code's own aliases, which always
  // mean the newest of that kind, so the list never goes out of date.
  const CLAUDE_PRESETS = [
    ["", "Default"],
    ["sonnet", "Sonnet (latest)"],
    ["opus", "Opus (latest)"],
    ["haiku", "Haiku (latest)"],
  ];

  // A dropdown of those, keeping a name typed earlier, with "Other" to type one.
  function presetSelect(value, attrs, flag) {
    const select = h("select", { ...attrs, onchange: () => {
      if (select.value === OTHER) {
        typeModelByHand[flag] = true;
        const box = h("input", { ...attrs, type: "text", value: "", placeholder: "Model name" });
        select.replaceWith(box);
        box.focus();
      }
    } });
    const known = CLAUDE_PRESETS.some(([v]) => v === value);
    for (const [v, text] of CLAUDE_PRESETS) select.appendChild(h("option", { value: v, text, selected: v === value }));
    if (!known) select.appendChild(h("option", { value, text: value, selected: true }));
    select.appendChild(h("option", { value: OTHER, text: "Other (type a name)..." }));
    return select;
  }

  // On opening the page, fill the dropdown without asking for anything: only
  // when the browser already lets the extension reach the server.
  const autoFound = new Set();
  async function autoFindModels(id) {
    const key = `${id}:${runtimeOf(id)}`;
    if (id !== "local" || autoFound.has(key)) return;
    autoFound.add(key);
    const inBrowser = runtimeOf(id) === "extension";
    if (inBrowser) {
      const pattern = originPatternFor(id);
      let granted = false;
      try {
        granted = Boolean(await api.permissions.contains({ origins: [pattern] }));
      } catch {
        granted = false;
      }
      if (!granted) return;
    }
    await findModels(id, { quiet: true });
  }

  function fieldFor(id, field) {
    const info = infoFor(id);
    if (field === "apiKey") return keyField(id, info);
    const runtime = runtimeOf(id);
    const locked = isLocked(id, field);
    const required = catalog[id].requires.includes(field);
    const defaults = (runtime === "extension" ? ext.settings.defaults[id] : helper && helper.settings.defaults[id]) || {};
    const raw = field === "model" && info && Object.prototype.hasOwnProperty.call(formModel, id) && !locked ? formModel[id] : info ? info[field] : null;
    const value = raw === null || raw === undefined ? "" : String(raw);
    const attrs = { id: `${id}-${field}`, autocomplete: "off", spellcheck: "false", disabled: locked || !info };
    let input;
    if (field === "contextTokens") {
      input = h("input", { ...attrs, type: "number", min: "1024", max: "2000000", step: "1024", value });
    } else if (field === "model" && id === "local" && !typeModelByHand[id]) {
      input = modelSelect(id, value, attrs);
    } else if (field === "model" && id === "claude" && !typeModelByHand[id]) {
      input = presetSelect(value, attrs, id);
    } else {
      input = h("input", {
        ...attrs,
        type: "text",
        value,
        placeholder: field === "model" ? (required ? "Model name" : defaults.model || "Default") : defaults[field] || "",
        list: field === "model" && id !== "local" ? `${id}-models` : false,
      });
    }
    const label = h("label", { for: `${id}-${field}` }, FIELD_LABELS[field], required ? null : h("span", { class: "opt", text: " (optional)" }));
    const wrap = h("div", { class: "field" }, label);
    const findable = field === "model" && (id === "local" || id === "openai" || (id === "anthropic" && runtime === "extension"));
    if (findable) {
      wrap.appendChild(
        h("div", { class: "row" }, input, h("button", { type: "button", class: "btn", id: `${id}-find`, text: id === "local" ? "Refresh" : "Find models", disabled: locked || !info, onclick: () => findModels(id) }))
      );
      if (id !== "local") wrap.appendChild(h("datalist", { id: `${id}-models` }));
      wrap.appendChild(h("p", { class: "hint", id: `${id}-models-note`, text: modelsNote[id] || "" }));
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
      id: `provider-${id}-radio`,
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
          : "Turns the tutor's review of each Submit into a note. Needs a vault folder.",
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

  // Runs `draw`, which rebuilds part of the page, and puts the focus back on
  // the element with the same id (and a text field's selection), so a
  // keyboard user is not dropped to the top of the page: arrows in a radio
  // group check the next radio, whose change handler redraws the group.
  function keepingFocus(draw) {
    const was = document.activeElement;
    const id = was && was !== document.body ? was.id : "";
    let selection = null;
    try {
      if (id && typeof was.selectionStart === "number") selection = [was.selectionStart, was.selectionEnd, was.selectionDirection];
    } catch {
      selection = null;
    }
    draw();
    if (!id || (was.isConnected && document.activeElement === was)) return;
    const again = document.getElementById(id);
    if (!again || again.disabled) return;
    again.focus({ preventScroll: true });
    if (selection) {
      try {
        again.setSelectionRange(...selection);
      } catch {
        // not a text field
      }
    }
  }

  function render() {
    keepingFocus(drawAll);
  }

  function drawAll() {
    const fieldset = $("providers");
    for (const node of [...fieldset.children]) if (node.tagName !== "LEGEND") node.remove();
    for (const id of ORDER) if (catalog[id]) fieldset.appendChild(providerCard(id));
    renderBehavior();
    renderHelper();
    renderOffline();
    renderConnection();
    renderFoot();
    renderProfiles();
    autoFindModels("local");
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
    // Backends word their errors as clauses ("the Anthropic API key was
    // refused ..."), so a message shown on its own starts with a capital.
    el.textContent = kind === "error" && text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    if (kind) el.setAttribute("data-kind", kind);
    else el.removeAttribute("data-kind");
  }

  // ---- models in the Tutor tab (profiles) ---------------------------------------------
  //
  // The saved models the Tutor panel's switcher lists (shared/profiles.js).
  // This page keeps a draft of the list (add, rename, reorder, remove,
  // choose the default) and sends it with Save. The provider cards above
  // edit the default model: its provider, its model and the provider's
  // connection. The extension keeps the whole list; the helper's companion
  // keeps the ones that run through it, so the panel can switch it only to
  // one of those.

  const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const MAX_PROFILES = 30;
  let draftProfiles = []; // [{ id, provider, model, label }]
  let draftActive = null;
  const formModel = {}; // provider -> the model its card shows for the default
  let renaming = null; // the id being renamed
  let addProvider = "local";

  function newProfileId(provider) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = `${provider}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    return PROFILE_ID_RE.test(id) ? id : `m-${Date.now().toString(36)}`;
  }

  function defaultModelOf(provider) {
    const defaults = ext && ext.settings.defaults[provider];
    return defaults && defaults.model ? defaults.model : null;
  }

  function profileName(profile) {
    return profile.label || profile.model || defaultModelOf(profile.provider) || (catalog[profile.provider] ? catalog[profile.provider].label : profile.provider);
  }

  function profileMeta(profile) {
    const parts = [catalog[profile.provider] ? catalog[profile.provider].label : profile.provider];
    const model = profile.model || defaultModelOf(profile.provider);
    if (model && model !== profileName(profile)) parts.push(model);
    parts.push(runtimeOf(profile.provider) === "helper" ? "through the helper app" : "in the browser");
    return parts.join(" · ");
  }

  function loadDraft(view) {
    renaming = null;
    draftProfiles = (view.profiles || []).map((p) => ({ ...p }));
    draftActive = view.activeProfile || null;
    const active = draftProfiles.find((p) => p.id === draftActive);
    if (active) formModel[active.provider] = active.model;
  }

  function profilesNote(kind, text) {
    const note = $("profiles-note");
    note.textContent = text || "";
    if (kind) note.setAttribute("data-kind", kind);
    else note.removeAttribute("data-kind");
  }

  function chooseDefault(id) {
    const profile = draftProfiles.find((p) => p.id === id);
    if (!profile) return;
    draftActive = id;
    formModel[profile.provider] = profile.model;
    typeModelByHand[profile.provider] = false;
    if (selected !== profile.provider) {
      selected = profile.provider;
      clearResults();
      if (runtimeOf(profile.provider) === "helper" && !helper) loadHelper();
    }
    render();
  }

  function moveProfile(id, by) {
    const i = draftProfiles.findIndex((p) => p.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= draftProfiles.length) return;
    [draftProfiles[i], draftProfiles[j]] = [draftProfiles[j], draftProfiles[i]];
    renderProfiles();
    const again = $(`profile-${id}-${by < 0 ? "up" : "down"}`);
    if (again && !again.disabled) again.focus();
    else if ($(`profile-${id}-radio`)) $(`profile-${id}-radio`).focus();
  }

  // Focus goes to the row that took the removed one's place (or the one
  // before it when it was the last), or to the add row when none is left.
  function removeProfile(id) {
    const i = draftProfiles.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [gone] = draftProfiles.splice(i, 1);
    profilesNote(null, `Removed ${profileName(gone)}. Save to apply.`);
    const next = draftProfiles[Math.min(i, draftProfiles.length - 1)];
    if (draftActive === id) {
      draftActive = null;
      if (next) chooseDefault(next.id);
      else renderProfiles();
    } else {
      renderProfiles();
    }
    const target = next ? $(`profile-${next.id}-radio`) : $("add-provider");
    if (target) target.focus();
  }

  // `paths` are the icon's path data (Feather icons, MIT), drawn as strokes.
  function iconButton(id, label, paths, onclick, disabled = false) {
    const button = h("button", { type: "button", class: "iconbtn", id, "aria-label": label, title: label, disabled, onclick });
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      svg.setAttribute(name, value);
    }
    for (const d of paths) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    button.appendChild(svg);
    return button;
  }

  function profileRow(profile, index) {
    const isDefault = profile.id === draftActive;
    const name = profileName(profile);
    const radio = h("input", {
      type: "radio",
      name: "profile",
      id: `profile-${profile.id}-radio`,
      value: profile.id,
      checked: isDefault,
      "aria-label": `Use ${name} by default`,
      onchange: () => chooseDefault(profile.id),
    });
    let text;
    if (renaming === profile.id) {
      const input = h("input", {
        type: "text",
        id: `profile-${profile.id}-label`,
        value: profile.label || "",
        placeholder: profile.model || defaultModelOf(profile.provider) || "Name",
        maxlength: "60",
        "aria-label": `Name for ${name}`,
        // Leaving the field keeps what was typed, as Enter does. Only this row
        // is redrawn, so a button pressed in another row still gets its click.
        // A window losing focus leaves the field focused and changes nothing.
        onblur: (e) => {
          if (renaming !== profile.id || document.activeElement === input) return;
          const to = e.relatedTarget;
          commitRename(input);
          const row = input.closest(".profile");
          if (!row || !row.isConnected) return;
          const fresh = profileRow(profile, draftProfiles.indexOf(profile));
          row.replaceWith(fresh);
          if (!to || fresh.contains(to) || row.contains(to)) $(`profile-${profile.id}-rename`).focus();
        },
        onkeydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finishRename(profile.id, input.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            renaming = null;
            renderProfiles();
            $(`profile-${profile.id}-rename`).focus();
          }
        },
      });
      text = h("div", { class: "profile-text" }, input);
    } else {
      text = h("label", { class: "profile-text", for: radio.id }, h("span", { class: "profile-name", text: name }), h("span", { class: "profile-meta", text: profileMeta(profile) }));
    }
    const actions = h("div", { class: "profile-actions" });
    if (renaming === profile.id) {
      actions.appendChild(h("button", { type: "button", class: "btn", id: `profile-${profile.id}-done`, text: "Done", onclick: () => finishRename(profile.id, $(`profile-${profile.id}-label`).value) }));
    } else {
      actions.append(
        iconButton(`profile-${profile.id}-rename`, `Rename ${name}`, ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"], () => {
          commitRename();
          renaming = profile.id;
          renderProfiles();
          const input = $(`profile-${profile.id}-label`);
          input.focus();
          input.select();
        }),
        iconButton(`profile-${profile.id}-up`, `Move ${name} up`, ["M18 15l-6-6-6 6"], () => moveProfile(profile.id, -1), index === 0),
        iconButton(`profile-${profile.id}-down`, `Move ${name} down`, ["M6 9l6 6 6-6"], () => moveProfile(profile.id, 1), index === draftProfiles.length - 1),
        iconButton(`profile-${profile.id}-remove`, `Remove ${name}`, ["M18 6L6 18", "M6 6l12 12"], () => removeProfile(profile.id))
      );
    }
    return h("div", { class: "profile", "data-default": isDefault, "data-id": profile.id }, radio, text, actions);
  }

  function finishRename(id, value) {
    const profile = draftProfiles.find((p) => p.id === id);
    renaming = null;
    if (profile) profile.label = value.trim().slice(0, 60) || null;
    renderProfiles();
    const again = $(`profile-${id}-rename`);
    if (again) again.focus();
  }

  // Keeps the name typed in an open rename field, if any, and closes it (the
  // caller redraws). Returns whether one was open. `field` is the field
  // itself when it may be out of the page already.
  function commitRename(field = null) {
    if (!renaming) return false;
    const id = renaming;
    renaming = null;
    const input = field || $(`profile-${id}-label`);
    const profile = draftProfiles.find((p) => p.id === id);
    if (input && profile) profile.label = input.value.trim().slice(0, 60) || null;
    return true;
  }

  // The add row: a provider, a model (the local provider's is the same
  // dropdown of the server's models as its card), an optional name.
  function renderAddRow() {
    const row = $("add-profile");
    const keepModel = $("add-model") ? $("add-model").value : "";
    const keepLabel = $("add-label") ? $("add-label").value : "";
    row.textContent = "";
    const select = h("select", {
      id: "add-provider",
      onchange: () => {
        addProvider = select.value;
        typeModelByHand.add = false;
        renderAddRow();
      },
    });
    for (const id of ORDER) if (catalog[id]) select.appendChild(h("option", { value: id, text: catalog[id].label, selected: id === addProvider }));
    let model;
    if (addProvider === "local" && !typeModelByHand.add) {
      // "Other" in this dropdown types a name here, not in the card.
      model = modelSelect("local", keepModel && (foundModels.local || []).includes(keepModel) ? keepModel : "", { id: "add-model", autocomplete: "off", spellcheck: "false" }, "add");
    } else if (addProvider === "claude" && !typeModelByHand.add) {
      model = presetSelect(keepModel && CLAUDE_PRESETS.some(([v]) => v === keepModel) ? keepModel : "", { id: "add-model", autocomplete: "off", spellcheck: "false" }, "add");
    } else {
      const required = catalog[addProvider].requires.includes("model");
      model = h("input", {
        type: "text",
        id: "add-model",
        autocomplete: "off",
        spellcheck: "false",
        value: addProvider === "local" ? keepModel : "",
        placeholder: required ? "Model name" : defaultModelOf(addProvider) || "Default",
        list: addProvider !== "local" && $(`${addProvider}-models`) ? `${addProvider}-models` : false,
      });
    }
    const label = h("input", { type: "text", id: "add-label", autocomplete: "off", maxlength: "60", placeholder: "Optional", value: keepLabel });
    row.append(
      h("div", { class: "field" }, h("label", { for: "add-provider", text: "Provider" }), select),
      h("div", { class: "field" }, h("label", { for: "add-model", text: "Model" }), model),
      h("div", { class: "field" }, h("label", { for: "add-label" }, "Name", h("span", { class: "opt", text: " (optional)" })), label),
      h("button", { type: "button", class: "btn", id: "add-profile-button", text: "Add model", onclick: addProfile })
    );
  }

  function addProfile() {
    const provider = $("add-provider").value;
    const raw = $("add-model").value.trim();
    const model = raw && raw !== OTHER ? raw : null;
    const label = $("add-label").value.trim().slice(0, 60) || null;
    if (!model && catalog[provider].requires.includes("model")) {
      profilesNote("error", `Choose a model for ${catalog[provider].label} first.`);
      $("add-model").focus();
      return;
    }
    if (draftProfiles.some((p) => p.provider === provider && (p.model || null) === model)) {
      profilesNote("error", "That model is already in the list.");
      return;
    }
    if (draftProfiles.length >= MAX_PROFILES) {
      profilesNote("error", `At most ${MAX_PROFILES} models can be saved.`);
      return;
    }
    const profile = { id: newProfileId(provider), provider, model, label };
    draftProfiles.push(profile);
    $("add-label").value = "";
    if ($("add-model").tagName === "INPUT") $("add-model").value = "";
    typeModelByHand.add = false;
    if (!draftActive) {
      chooseDefault(profile.id);
    } else {
      renderProfiles();
    }
    profilesNote("ok", `Added ${profileName(profile)}. Save to apply.`);
  }

  function renderProfiles() {
    keepingFocus(() => {
      const list = $("profiles");
      list.textContent = "";
      draftProfiles.forEach((profile, i) => list.appendChild(profileRow(profile, i)));
      renderAddRow();
    });
  }

  // The list and default to save: the default follows the provider card
  // (its provider and its model). Same provider: the default's model is
  // edited in place, unless another saved entry already is that model, which
  // then becomes the default. Another provider: an entry with that provider
  // and model becomes the default, or a new one is added for it.
  function profilesForSave() {
    const provider = selected;
    const input = $(`${provider}-model`);
    const locked = isLocked(provider, "model");
    const typed = input && !locked ? input.value.trim() : "";
    const model = typed && typed !== OTHER ? typed : null;
    const list = draftProfiles.map((p) => ({ ...p }));
    let active = list.find((p) => p.id === draftActive) || null;
    const same = list.find((p) => p !== active && p.provider === provider && (p.model || null) === model);
    if (active && active.provider === provider) {
      if (same) active = same;
      else if (!locked) active.model = model;
    } else {
      active = same || null;
      if (!active) {
        active = { id: newProfileId(provider), provider, model, label: null };
        list.push(active);
      }
    }
    return { profiles: list.slice(0, MAX_PROFILES), activeProfile: active.id };
  }

  // The entries that run through the helper, for the companion's own list.
  function helperProfiles(list) {
    return list.filter((p) => runtimeOf(p.provider) === "helper");
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
  function helperPatch(plan) {
    const id = selected;
    const patch = { provider: helperLocked("provider") ? undefined : id, providers: { [id]: collectFields(id) }, options: collectOptions(false) };
    if (plan) {
      patch.profiles = helperProfiles(plan.profiles);
      if (patch.profiles.some((p) => p.id === plan.activeProfile) && !helperLocked("provider") && !helperLocked("model")) patch.activeProfile = plan.activeProfile;
    }
    return patch;
  }

  // The patch for the extension (browser runtime).
  function extensionPatch(plan) {
    const id = selected;
    const patch = { provider: id, runtime: "extension", providers: { [id]: collectFields(id) }, options: collectOptions(true) };
    if (plan) Object.assign(patch, plan);
    return patch;
  }

  // Keeps the companion's list in step after a save in the browser runtime,
  // when a helper is there to tell (best effort: a helper that is not running
  // gets the list with the next save made through it).
  async function syncHelperProfiles(plan) {
    if (!helper) return;
    const res = await rpc("setProfiles", { profiles: helperProfiles(plan.profiles) });
    if (res.ok) helper = res.result;
  }

  // ---- actions ----------------------------------------------------------------------------

  async function findModels(id, { quiet = false } = {}) {
    const inBrowser = runtimeOf(id) === "extension";
    // Asked first, while this still counts as the click.
    const pattern = inBrowser ? originPatternFor(id) : null;
    const allowed = inBrowser && !quiet ? requestPermission(pattern) : Promise.resolve(true);
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
    const res = inBrowser ? await worker("lc-tutor:settings-models", params) : await rpcStarting("models", params, undefined, (t) => (note.textContent = t));
    button.disabled = false;
    if (!res.ok) {
      note.textContent = res.error.message;
      return;
    }
    const names = res.result.models;
    const message = names.length ? `Found ${names.length}.` : res.result.message || "No models found.";
    if (id === "local") {
      foundModels[id] = names;
      modelsNote[id] = names.length ? `Found ${names.filter((n) => !NOT_CHAT.test(n)).length} models you can chat with.` : message;
      // Keep what is typed in the other fields across the redraw.
      const keep = {};
      for (const el of document.querySelectorAll("#providers input[id], #providers select[id]")) keep[el.id] = el.value;
      const keptModel = $(`${id}-model`) ? $(`${id}-model`).value : "";
      render();
      for (const [elId, v] of Object.entries(keep)) {
        const el = $(elId);
        if (el && el.tagName === "INPUT" && el.type !== "radio" && el.type !== "checkbox" && elId !== `${id}-model`) el.value = v;
      }
      const sel = $(`${id}-model`);
      if (sel && keptModel && sel.tagName === "SELECT" && [...sel.options].some((o) => o.value === keptModel)) sel.value = keptModel;
      return;
    }
    const list = $(`${id}-models`);
    list.textContent = "";
    for (const name of names) list.appendChild(h("option", { value: name }));
    note.textContent = names.length ? `${message} Start typing the model field to pick one.` : message;
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
    const res = inBrowser ? await worker("lc-tutor:settings-test", { patch }) : await rpcStarting("test", { patch }, 100000, (t) => showResult("test-result", "", t));
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
    // A name still being typed is part of what is saved.
    if (commitRename()) renderProfiles();
    const inBrowser = runtimeOf(selected) === "extension";
    const pattern = inBrowser ? originPatternFor(selected) : null;
    const allowed = inBrowser ? requestPermission(pattern) : Promise.resolve(true);
    const button = $("save");
    button.disabled = true;
    showResult("save-result", "", "Saving...");
    const plan = profilesForSave();
    if (inBrowser) {
      const patch = extensionPatch(plan);
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
      loadDraft(ext.settings);
      profilesNote(null, "");
      render();
      showResult("save-result", "ok", `Saved. The tutor now runs in the browser with ${activeLabel(ext.active)}.`);
      syncHelperProfiles(plan);
      return;
    }
    const res = await rpcStarting("save", { patch: helperPatch(plan) }, undefined, (t) => showResult("save-result", "", t));
    if (!res.ok) {
      button.disabled = false;
      failSave(res.error);
      return;
    }
    helper = res.result;
    // The extension remembers that this provider runs through the helper, so
    // captures and the Tutor panel go to the relay.
    const provider = helper.settings.provider;
    const routed = await worker("lc-tutor:settings-save", { patch: { provider, runtime: "helper", ...plan } });
    button.disabled = false;
    if (routed.ok) {
      ext = routed.result;
      loadDraft(ext.settings);
      profilesNote(null, "");
    }
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
    loadDraft(ext.settings);
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
        // Its saved models too, for the extension to keep from the next save.
        if (!draftProfiles.length) loadDraft(helper.settings);
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

  // What the default model's card shows is what Save makes the default.
  $("providers").addEventListener("change", (e) => {
    const m = /^([a-z]+)-model$/.exec(e.target.id || "");
    if (m && e.target.value !== OTHER) formModel[m[1]] = e.target.value.trim() || null;
  });
  $("providers").addEventListener("input", (e) => {
    const m = /^([a-z]+)-model$/.exec(e.target.id || "");
    if (m && e.target.tagName === "INPUT") formModel[m[1]] = e.target.value.trim() || null;
  });
  $("form").addEventListener("submit", save);
  $("test").addEventListener("click", runTest);
  load();
})();
