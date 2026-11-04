// LeetCode Capture - background worker (an ES module).
//
// Three jobs:
//   - Open the options page when the Tutor panel's gear is clicked (content
//     scripts can't call runtime.openOptionsPage themselves).
//   - Run the tutor itself for the "extension" runtime (local models and API
//     keys, nothing to install): captures from content.js and messages from
//     the Tutor panel come here instead of going to the relay, and the panel
//     follows the conversation over a port. The logic is in
//     shared/tutor-service.js; this file only binds the browser APIs to it.
//   - Answer the options page's settings calls for that runtime.
//   - For the helper runtime, once the optional nativeMessaging permission
//     is granted, start the Native Messaging helper while a LeetCode problem
//     tab is open and stop it 30 s after the last one closes
//     (shared/helper-launcher.js has the rules).
// Only this extension's own content scripts and pages are listened to.
//
// API keys live in storage.local and are only ever sent to the provider's
// API. No message to a content script carries one (tutor-service.js).

import { createTutorService, SETTINGS_KEY } from "./shared/tutor-service.js";
import { normalizeSettings } from "./shared/extension-settings.js";
import { createHelperLauncher } from "./shared/helper-launcher.js";

const api = typeof browser !== "undefined" ? browser : chrome;
const PANEL_PORT = "lc-tutor-panel";

const NATIVE = { permissions: ["nativeMessaging"] };

const launcher = createHelperLauncher({
  connectNative: (name) => api.runtime.connectNative(name),
  // Firefox puts the reason on the port, Chrome in runtime.lastError.
  lastError: (port) =>
    (port && port.error && port.error.message) || (api.runtime.lastError && api.runtime.lastError.message) || null,
  // Called through this object, so each is wrapped: a browser's own timer
  // functions throw "Illegal invocation" when `this` is not the global.
  timers: {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  },
  log: (text) => console.warn(`[leetcode-capture] ${text}`),
});

let runtime = null;
async function refreshHelper() {
  let granted = false;
  try {
    granted = await api.permissions.contains(NATIVE);
  } catch {
    granted = false;
  }
  launcher.setWanted(runtime === "helper" && granted && typeof api.runtime.connectNative === "function");
}

// The options page asks for the helper's state; panels hear it so an offline
// panel can point to Settings.
async function helperView() {
  let granted = false;
  try {
    granted = await api.permissions.contains(NATIVE);
  } catch {
    granted = false;
  }
  return { ...launcher.view(), runtime, permission: granted, extensionId: api.runtime.id };
}

const panelPorts = new Set();
launcher.onChange((view) => {
  service.refreshProfiles();
  for (const port of panelPorts) {
    try {
      port.postMessage({ type: "helper", state: view.wanted ? view.state : null });
    } catch {
      // gone
    }
  }
});

// Dev builds only (build.mjs --dev-ollama <model>): a dev-seed.json next to
// the manifest picks the local provider and model when nothing is saved yet,
// so removing and re-adding the unpacked extension does not need the options
// page. It never overwrites a saved choice and is absent from real builds.
async function applyDevSeed() {
  try {
    const response = await fetch(api.runtime.getURL("dev-seed.json"));
    if (!response.ok) return;
    const seed = await response.json();
    const stored = await api.storage.local.get([SETTINGS_KEY]);
    const saved = normalizeSettings(stored && stored[SETTINGS_KEY]);
    if (saved.provider) return;
    const next = normalizeSettings({ provider: seed.provider, runtimes: { [seed.provider]: "extension" }, providers: { [seed.provider]: seed.fields } });
    await api.storage.local.set({ [SETTINGS_KEY]: next });
  } catch {
    // no seed file: a normal build
  }
}
applyDevSeed();

// Why the model switcher cannot move to a profile that runs through the
// helper right now, or null. While the helper runtime is in use the panel
// itself sees whether the tutor answers; from the browser runtime the
// extension must be able to start the helper.
async function helperProblem(current) {
  if (current === "helper") return null;
  let granted = false;
  try {
    granted = await api.permissions.contains(NATIVE);
  } catch {
    granted = false;
  }
  if (!granted || typeof api.runtime.connectNative !== "function") return "Helper app not set up yet";
  if (launcher.view().state === "not-installed") return "Helper app not installed";
  return null;
}

const service = createTutorService({
  helperProblem,
  onRuntime: (next) => {
    runtime = next;
    refreshHelper();
  },
  storage: {
    get: (keys) => api.storage.local.get(keys),
    set: (items) => api.storage.local.set(items),
  },
  permissions: { contains: (request) => api.permissions.contains(request) },
  extensionOrigin: new URL(api.runtime.getURL("")).origin,
  log: (text) => console.warn(`[leetcode-capture] ${text}`),
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id) return undefined;
  if (message && message.type === "lc-tutor:open-settings") {
    api.runtime.openOptionsPage();
    return undefined;
  }
  // A Run or Submit makes its tab the active problem.
  if (message && message.type === "lc-tutor:capture" && sender.tab) launcher.markActive(sender.tab.id);
  if (message && (message.type === "lc-tutor:helper-status" || message.type === "lc-tutor:helper-retry")) {
    // Only the extension's own pages (the options page, even open in a tab),
    // never a content script on leetcode.com.
    if (!sender.url || !sender.url.startsWith(api.runtime.getURL(""))) return undefined;
    (async () => {
      if (message.type === "lc-tutor:helper-retry") {
        await refreshHelper();
        launcher.retry();
      }
      return helperView();
    })().then(sendResponse, () => sendResponse(null));
    return true;
  }
  service
    .handleMessage(message, sender)
    .then((answer) => sendResponse(answer))
    .catch((err) => sendResponse({ ok: false, error: { message: err && err.message ? err.message : "failed" } }));
  // The answer is sent asynchronously.
  return true;
});

api.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT || !port.sender || port.sender.id !== api.runtime.id) return;
  service.connectPort(port);
  const tab = port.sender.tab;
  if (!tab || typeof tab.id !== "number") return;
  // Listeners first, so nothing below can leave the tab counted forever.
  port.onMessage.addListener((message) => {
    if (message && message.type === "active") launcher.markActive(tab.id);
  });
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    launcher.tabClosed(tab.id);
  });
  panelPorts.add(port);
  launcher.tabOpened(tab.id, tab.url || port.sender.url);
  const view = launcher.view();
  if (view.wanted) {
    try {
      port.postMessage({ type: "helper", state: view.state });
    } catch {
      // already gone
    }
  }
});

// Granting or revoking the server's host permission in the options page (or
// the browser's own extension settings) changes whether the tutor can run.
// The same goes for nativeMessaging and the helper.
if (api.permissions.onAdded) {
  api.permissions.onAdded.addListener(() => {
    service.refresh();
    refreshHelper();
  });
}
if (api.permissions.onRemoved) {
  api.permissions.onRemoved.addListener(() => {
    service.refresh();
    refreshHelper();
  });
}
