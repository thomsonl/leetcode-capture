// LeetCode Capture - background worker.
//
// Its one job: open the options page when the Tutor panel's gear is clicked.
// Content scripts can't call runtime.openOptionsPage themselves, and the
// options page can't be linked to from a web page, so the panel sends a message
// and this opens the page. Only messages from this extension's own content
// scripts are honored.

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== api.runtime.id) return undefined;
  if (message && message.type === "lc-tutor:open-settings") {
    api.runtime.openOptionsPage();
  }
  return undefined;
});
