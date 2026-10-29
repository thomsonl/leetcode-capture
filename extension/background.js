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
// Only this extension's own content scripts and pages are listened to.
//
// API keys live in storage.local and are only ever sent to the provider's
// API. No message to a content script carries one (tutor-service.js).

import { createTutorService } from "./shared/tutor-service.js";

const api = typeof browser !== "undefined" ? browser : chrome;
const PANEL_PORT = "lc-tutor-panel";

const service = createTutorService({
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
});

// Granting or revoking the server's host permission in the options page (or
// the browser's own extension settings) changes whether the tutor can run.
if (api.permissions.onAdded) api.permissions.onAdded.addListener(() => service.refresh());
if (api.permissions.onRemoved) api.permissions.onRemoved.addListener(() => service.refresh());
