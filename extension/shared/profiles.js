// extension/shared/profiles.js - saved model profiles, the entries of the
// Tutor panel's model switcher. Shared by the extension's settings
// (extension-settings.js) and the companion's (companion/settings.js), so both
// stores keep them the same way.
//
// A profile is { id, provider, model, label }: which provider, which model of
// it (null means the provider's own default) and an optional name. Everything
// else a provider needs (its server URL, its API key, where it runs) stays in
// that provider's saved fields, shared by all of its profiles. A profile never
// carries a secret, so the whole list may be shown to the panel.
//
// Settings that predate profiles hold one provider and its model; they become
// one profile with the id DEFAULT_PROFILE_ID (see migrateProfiles).
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_PROFILES = 30;
export const MAX_PROFILE_LABEL = 60;
export const DEFAULT_PROFILE_ID = 'default';

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function cleanText(value, max) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max || CONTROL_RE.test(trimmed)) return undefined;
  return trimmed;
}

// One profile made safe, or null when it cannot be kept. `providers` is the
// catalog (providers.js's PROVIDERS).
export function cleanProfile(raw, providers) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !PROFILE_ID_RE.test(raw.id)) return null;
  if (typeof raw.provider !== 'string' || !Object.prototype.hasOwnProperty.call(providers, raw.provider)) return null;
  const model = cleanText(raw.model, 200);
  const label = cleanText(raw.label, MAX_PROFILE_LABEL);
  if (model === undefined || label === undefined) return null;
  return { id: raw.id, provider: raw.provider, model, label };
}

// A list of profiles made safe: malformed entries, repeated ids and anything
// past MAX_PROFILES are left out. With `strict`, a bad entry throws a
// ProfileError instead (an options-page save is refused rather than quietly
// changed).
export class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
  }
}

export function cleanProfiles(raw, providers, { strict = false } = {}) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    if (strict) throw new ProfileError('profiles must be a list');
    return [];
  }
  if (strict && raw.length > MAX_PROFILES) throw new ProfileError(`at most ${MAX_PROFILES} models can be saved`);
  const out = [];
  const ids = new Set();
  for (const entry of raw) {
    const profile = cleanProfile(entry, providers);
    if (!profile || ids.has(profile.id)) {
      if (strict) throw new ProfileError(profile ? `two saved models share the id "${profile.id}"` : 'a saved model is not valid');
      continue;
    }
    ids.add(profile.id);
    out.push(profile);
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

export function findProfile(profiles, id) {
  if (typeof id !== 'string' || !Array.isArray(profiles)) return null;
  return profiles.find((p) => p.id === id) || null;
}

// The id kept as active: `id` when it names a profile, else null.
export function cleanActiveProfile(profiles, id) {
  return findProfile(profiles, id) ? id : null;
}

// Settings from before profiles: one profile for the provider (and model)
// they chose, made the active one. `model` is that provider's saved model,
// or null. Returns { profiles, activeProfile }.
export function migrateProfiles({ profiles, activeProfile, provider, model }) {
  if (Array.isArray(profiles) && profiles.length) {
    return { profiles, activeProfile: cleanActiveProfile(profiles, activeProfile) };
  }
  if (!provider) return { profiles: [], activeProfile: null };
  const profile = { id: DEFAULT_PROFILE_ID, provider, model: model || null, label: null };
  return { profiles: [profile], activeProfile: profile.id };
}

// What a profile is called in the switcher and the options page: its own
// label, else its model, else its provider's label.
export function profileName(profile, providers) {
  if (!profile) return '';
  return profile.label || profile.model || (providers[profile.provider] && providers[profile.provider].label) || profile.provider;
}
