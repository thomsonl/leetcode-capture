// Finishing the helper's setup after the nativeMessaging permission is
// granted.
//
// nativeMessaging is an optional permission. A page or service worker that
// was already running when the user clicked Allow does not get
// runtime.connectNative until it starts again, and the worker is kept alive
// by the options page's polling and by every open Tutor panel, so it would
// never start the helper. The extension then reloads itself once (the
// worker decides, see background.js), and the options page, which that
// reload closes, opens again with what the user had chosen in its form.
//
// Two storage.local records:
//   NATIVE_RELOAD_KEY   { at }  set right before the automatic reload. While
//                       it is there no second reload happens: if the API is
//                       still missing afterwards, the browser itself has not
//                       turned it on, and the user is asked to restart it.
//                       Cleared once the API is there or the permission is
//                       gone, so a later grant gets its own reload.
//   SETTINGS_RESUME_KEY { at, provider, runtime, model, reopen } the options
//                       page's unsaved choice, written when it asks for the
//                       permission; `reopen` is set by the worker right
//                       before it reloads, and the next worker start opens
//                       the options page, which applies and removes it.
//
// Pure JavaScript with no Node or browser API (extension/shared.test.js
// checks that).

export const NATIVE_RELOAD_KEY = 'nativeReload';
export const SETTINGS_RESUME_KEY = 'settingsResume';
// A resume record older than this is ignored (the user went elsewhere).
export const RESUME_MAX_AGE_MS = 10 * 60_000;
// How long the worker waits between noticing the missing API and reloading,
// so the options page can save its form and say what is happening.
export const RELOAD_DELAY_MS = 1500;

// `granted`: the permission is granted. `hasApi`: this context has
// runtime.connectNative. `record`: the stored NATIVE_RELOAD_KEY value.
// Returns { state, action }:
//   state  'ready' (granted, API there), 'pending' (a reload will fix it),
//          'stuck' (it did not), or null (not granted)
//   action 'reload' | 'clear' (remove the record) | 'none'
export function nativeApiDecision({ granted, hasApi, record }) {
  if (!granted) return { state: null, action: record ? 'clear' : 'none' };
  if (hasApi) return { state: 'ready', action: record ? 'clear' : 'none' };
  if (record) return { state: 'stuck', action: 'none' };
  return { state: 'pending', action: 'reload' };
}

const PROVIDER_RE = /^[a-z]{1,40}$/;

// The options page's unsaved choice, cleaned, or null when it is missing,
// malformed or older than RESUME_MAX_AGE_MS.
export function freshResume(record, now) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.at !== 'number' || !(now - record.at >= 0 && now - record.at <= RESUME_MAX_AGE_MS)) return null;
  const provider = typeof record.provider === 'string' && PROVIDER_RE.test(record.provider) ? record.provider : null;
  const runtime = record.runtime === 'extension' || record.runtime === 'helper' ? record.runtime : null;
  const model = typeof record.model === 'string' && record.model.length <= 200 ? record.model : null;
  return { at: record.at, provider, runtime, model, reopen: record.reopen === true };
}

// The worker's side, with every browser call passed in:
//   storage      { get(keys), set(items), remove(key) } (storage.local)
//   permitted()  resolves whether nativeMessaging is granted
//   hasApi()     whether this worker has runtime.connectNative
//   reload()     runtime.reload, or null when the browser has none
//   settingsOpen() resolves whether an options page is open
//   openSettings() opens (or focuses) the options page
//   timers       { setTimeout }, now() the clock, log(text)
// check(granted) is called on every helper refresh with the permission
// state; it schedules the one reload. reopenAfterReload() runs once at
// worker start. state() is what the options page is told.
export function createNativeSetup({ storage, permitted, hasApi, reload, settingsOpen, openSettings, timers, now = () => Date.now(), log = () => {} }) {
  let current = null;
  let reloadTimer = null;

  async function read(key) {
    try {
      const stored = await storage.get([key]);
      return stored ? stored[key] : undefined;
    } catch {
      return undefined;
    }
  }

  async function reloadNow() {
    // Checked again: the permission may have gone, or the API come, meanwhile.
    let granted = false;
    try {
      granted = Boolean(await permitted());
    } catch {
      granted = false;
    }
    const decision = nativeApiDecision({ granted, hasApi: hasApi(), record: await read(NATIVE_RELOAD_KEY) });
    if (decision.action !== 'reload') {
      reloadTimer = null;
      current = decision.state;
      return false;
    }
    const at = now();
    const resume = freshResume(await read(SETTINGS_RESUME_KEY), at);
    let reopen = Boolean(resume);
    if (!reopen) {
      try {
        reopen = Boolean(await settingsOpen());
      } catch {
        reopen = false;
      }
    }
    try {
      const items = { [NATIVE_RELOAD_KEY]: { at } };
      if (reopen) items[SETTINGS_RESUME_KEY] = { ...(resume || { at }), reopen: true };
      await storage.set(items);
    } catch {
      // Without the record a reload could repeat, so none happens.
      reloadTimer = null;
      current = 'stuck';
      return false;
    }
    log('reloading once so the browser turns on Native Messaging');
    reload();
    return true;
  }

  return {
    async check(granted) {
      const decision = nativeApiDecision({ granted, hasApi: hasApi(), record: await read(NATIVE_RELOAD_KEY) });
      current = decision.state;
      if (decision.action === 'clear') {
        try {
          await storage.remove(NATIVE_RELOAD_KEY);
        } catch {
          // tried again on the next check
        }
      }
      if (decision.action === 'reload') {
        if (typeof reload !== 'function') current = 'stuck';
        else if (reloadTimer === null) reloadTimer = timers.setTimeout(() => reloadNow(), RELOAD_DELAY_MS);
      }
      return current;
    },

    async reopenAfterReload() {
      const resume = freshResume(await read(SETTINGS_RESUME_KEY), now());
      if (!resume || !resume.reopen) return false;
      try {
        // Only once, even if this worker starts again before the page reads it.
        await storage.set({ [SETTINGS_RESUME_KEY]: { ...resume, reopen: false } });
      } catch {
        return false;
      }
      await openSettings();
      return true;
    },

    state: () => current,
  };
}
