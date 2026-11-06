// extension/shared/providers.js - the tutor's provider catalog, shared by the
// companion's settings (companion/settings.js) and the extension's options
// page and background worker, so both list the same providers the same way.
//
// Pure data with no Node API (extension/shared.test.js checks that).

// `fields` are what the options page shows for a provider; `requires` must be
// present before a backend can be built for it. `runtimes` says where the
// tutor can run for it: 'extension' (inside the browser extension's own
// background worker, nothing to install) and/or 'helper' (the companion
// process on the user's machine, which the subscription providers need
// because they use a local sign-in). The first one listed is the default.
export const PROVIDERS = {
  local: {
    label: 'Local model',
    hint: 'Ollama, LM Studio, or any OpenAI-compatible server running on your machine.',
    fields: ['baseUrl', 'model', 'contextTokens', 'apiKey'],
    requires: ['model'],
    runtimes: ['extension', 'helper'],
  },
  claude: {
    label: 'Claude subscription',
    hint: 'Uses your Claude Code sign-in (Claude Pro or Max). To sign in, run claude in a terminal and type /login.',
    fields: ['model'],
    requires: [],
    runtimes: ['helper'],
  },
  anthropic: {
    label: 'Anthropic API key',
    hint: 'Pay-as-you-go with a key from console.anthropic.com.',
    fields: ['apiKey', 'model'],
    requires: ['apiKey'],
    runtimes: ['extension', 'helper'],
  },
  openai: {
    label: 'OpenAI API key',
    hint: 'Pay-as-you-go with a key from platform.openai.com.',
    fields: ['apiKey', 'model', 'baseUrl'],
    requires: ['apiKey', 'model'],
    runtimes: ['extension', 'helper'],
  },
  chatgpt: {
    label: 'ChatGPT subscription',
    hint: 'Uses your Codex CLI sign-in (ChatGPT Plus, Pro, Business). To sign in, run codex login in a terminal and choose ChatGPT.',
    fields: ['model'],
    requires: [],
    runtimes: ['helper'],
  },
};

export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

// The runtime a provider uses unless the user picked another one it allows.
export function defaultRuntime(provider) {
  const spec = PROVIDERS[provider];
  return spec ? spec.runtimes[0] : 'helper';
}
