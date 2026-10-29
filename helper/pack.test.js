import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUNDLE_MARKER, ENTRY_POINTS, REPO_ROOT, build, checkBundle, importsOf, readHelperPackage, runtimeFiles } from './scripts/pack.mjs';
import { dataEnv, resolveRoot } from './host.js';

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function builtRuntime(t) {
  const out = path.join(tempDir(t, 'lc-helper-pack-'), 'runtime');
  build({ out });
  return out;
}

test('the bundle holds everything the companion and relay import, and no tests', (t) => {
  const out = builtRuntime(t);
  assert.deepEqual(checkBundle(out), []);
  for (const rel of ENTRY_POINTS) assert.ok(fs.existsSync(path.join(out, rel)), rel);
  const marker = JSON.parse(fs.readFileSync(path.join(out, BUNDLE_MARKER), 'utf8'));
  assert.deepEqual(marker.files, runtimeFiles());
  assert.ok(marker.files.includes('extension/shared/context-summary.js'));
  assert.ok(marker.files.includes('vault-tool/vault-notes.js'));
  assert.ok(!marker.files.some((f) => f.endsWith('.test.js') || f.endsWith('test-isolation.js')));
  assert.ok(!fs.existsSync(path.join(out, 'relay-server', 'data')), 'no capture data is bundled');
  // Each copy is identical to its one source.
  for (const rel of marker.files) assert.ok(fs.readFileSync(path.join(out, rel)).equals(fs.readFileSync(path.join(REPO_ROOT, rel))), rel);
});

test('each copied folder keeps its module type', (t) => {
  const out = builtRuntime(t);
  const type = (dir) => JSON.parse(fs.readFileSync(path.join(out, dir, 'package.json'), 'utf8')).type;
  assert.equal(type('companion'), 'module');
  assert.equal(type('extension/shared'), 'module');
  assert.equal(type('relay-server'), 'commonjs');
  assert.equal(type('vault-tool'), 'commonjs');
});

test('a file the companion imports that is missing from the bundle is caught', (t) => {
  const out = builtRuntime(t);
  fs.rmSync(path.join(out, 'extension', 'shared', 'sanitize.js'));
  fs.rmSync(path.join(out, 'vault-tool', 'vault-notes.js'));
  const problems = checkBundle(out);
  assert.ok(problems.some((p) => p.includes('../extension/shared/sanitize.js')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('../vault-tool/vault-notes.js')), problems.join('\n'));
});

test('a package the companion imports must be a dependency of the helper', (t) => {
  const out = builtRuntime(t);
  const problems = checkBundle(out, { ...readHelperPackage(), dependencies: {} });
  assert.ok(problems.some((p) => p.includes('@anthropic-ai/claude-agent-sdk')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('marked-terminal')), problems.join('\n'));
  // And the build refuses to leave an incomplete bundle behind.
  const again = path.join(path.dirname(out), 'again');
  assert.throws(() => build({ out: again, helperPkg: { ...readHelperPackage(), dependencies: {} } }), /incomplete/);
  assert.equal(fs.existsSync(again), false);
});

test("the helper's dependencies are exactly the companion's", () => {
  const companion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'companion', 'package.json'), 'utf8'));
  assert.deepEqual(readHelperPackage().dependencies, companion.dependencies);
});

test('importsOf reads every import form and skips comments', () => {
  const source = [
    "import a from './a.js';",
    "import './side.js';",
    "const b = await import('./b.js');",
    'const c = require("../c.js");',
    "export { d } from './d.js';",
    "// import x from './comment.js';",
    "/* require('./block.js') */",
    "const url = 'https://example.com/x'; // from './trailing.js'",
  ].join('\n');
  assert.deepEqual(importsOf(source).sort(), ['../c.js', './a.js', './b.js', './d.js', './side.js']);
});

test('resolveRoot uses the bundled copy when there is one, and a saved root wins over it', (t) => {
  const here = tempDir(t, 'lc-helper-root-');
  assert.equal(resolveRoot({}, here), path.resolve(here, '..'));
  fs.mkdirSync(path.join(here, 'runtime'));
  fs.writeFileSync(path.join(here, 'runtime', BUNDLE_MARKER), '{}');
  assert.equal(resolveRoot({}, here), path.join(here, 'runtime'));
  fs.writeFileSync(path.join(here, 'helper-config.json'), JSON.stringify({ root: '/checkout' }));
  assert.equal(resolveRoot({}, here), '/checkout');
  assert.equal(resolveRoot({ LEETCODE_CAPTURE_ROOT: '/env' }, here), path.resolve('/env'));
});

test('a bundled root keeps its data in the helper folder; a checkout keeps its own', (t) => {
  const out = builtRuntime(t);
  const data = '/helper/app';
  assert.deepEqual(dataEnv(REPO_ROOT, data, {}), {});
  assert.deepEqual(dataEnv(out, data, {}), {
    CAPTURE_LOG_PATH: path.join(data, 'data', 'captures.jsonl'),
    LEETCODE_CAPTURES_FILE: path.join(data, 'data', 'captures.jsonl'),
    LEETCODE_COMPANION_STATE_FILE: path.join(data, 'data', 'companion-state.json'),
  });
  // One set variable moves both sides of the log together.
  const moved = dataEnv(out, data, { CAPTURE_LOG_PATH: '/x/log.jsonl' });
  assert.equal(moved.LEETCODE_CAPTURES_FILE, '/x/log.jsonl');
});
