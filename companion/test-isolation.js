// companion/test-isolation.js - loaded by `npm test` (node --test --import)
// into every test process before any test runs.
//
// Every companion.js subprocess a test spawns inherits this environment, so
// pointing LEETCODE_CAPTURE_SETTINGS at a path that does not exist keeps the
// suite from ever reading or writing the real
// ~/.config/leetcode-capture/settings.json (a saved provider or option there
// would otherwise change what a test's companion does). A test that needs a
// settings file sets its own path in the child's env.

import os from 'node:os';
import path from 'node:path';

if (!process.env.LEETCODE_CAPTURE_SETTINGS) {
  process.env.LEETCODE_CAPTURE_SETTINGS = path.join(
    os.tmpdir(),
    `lc-companion-test-no-settings-${process.pid}`,
    'settings.json'
  );
}
