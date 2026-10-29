// The one place that names this helper and the extensions allowed to talk to
// it. The installer writes these into the browsers' registration files.

// Native Messaging host name: lowercase letters, digits, dots and underscores.
// The extension's background worker connects to this exact name.
export const HOST_NAME = 'dev.thomsonklee.leetcode_capture';

export const HOST_DESCRIPTION = 'LeetCode Capture helper (starts the local tutor companion and relay)';

// Firefox: the gecko id from extension/manifest.json
// (browser_specific_settings.gecko.id). It never changes.
export const GECKO_ID = 'leetcode-capture@thomsonklee.dev';

// Chrome, Chromium, Edge and Brave identify an extension by a 32-letter id.
// An unpacked copy gets an id from its folder path (or from a `key` in its
// manifest), and a store copy gets the store's id, so there is no single
// built-in value yet.
// Set the published Chrome Web Store id (and the Edge Add-ons id, if it
// differs) here once they exist; until then `install --chrome-id <id>` adds
// the id the options page shows (chrome://extensions lists it too).
export const CHROME_EXTENSION_IDS = [];

export const CHROME_ID_RE = /^[a-p]{32}$/;

export const VERSION = '0.1.0';
