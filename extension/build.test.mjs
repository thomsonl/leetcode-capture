import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, defaultOut, parseArgs } from './scripts/build.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'lc-build-'));
const source = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const walk = (dir) => readdirSync(dir, { recursive: true });

test('source manifest declares both background keys', () => {
  assert.ok(source.background.service_worker);
  assert.ok(Array.isArray(source.background.scripts));
});

test('the store name is the chosen one and fits both stores', () => {
  // Chrome Web Store allows 75 characters, addons.mozilla.org 50.
  assert.equal(source.name, "Thomson's LeetCode Tutor");
  assert.ok(source.name.length <= 50, source.name);
});

test('chrome build drops background.scripts and keeps the rest', () => {
  const out = build({ browser: 'chrome', out: join(tmp, 'chrome') });
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal('scripts' in m.background, false);
  assert.equal(m.background.service_worker, source.background.service_worker);
  const { background: _a, ...rest } = m;
  const { background: _b, ...srcRest } = source;
  assert.deepEqual(rest, srcRest);
});

test('firefox build keeps the manifest unchanged', () => {
  const out = build({ browser: 'firefox', out: join(tmp, 'firefox') });
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(m, source);
});

test('no test, e2e, tooling or doc files leak, and runtime files are present', () => {
  for (const browser of ['chrome', 'firefox']) {
    const files = walk(join(tmp, browser));
    for (const f of files) {
      assert.doesNotMatch(f, /\.test\.(js|mjs)$/, f);
      assert.doesNotMatch(f, /(^|\/)(e2e|scripts|node_modules|web-ext-artifacts|store-assets)(\/|$)/, f);
      assert.doesNotMatch(f, /(^|\/)package\.json$/, f);
      assert.doesNotMatch(f, /_CHECKLIST\.md$|PRIVACY_POLICY\.md$/, f);
      assert.doesNotMatch(f, /^icons\/screenshot/, f);
      assert.doesNotMatch(f, /dev-seed\.json$|\.map$/, f);
    }
    for (const f of ['manifest.json', 'background.js', 'content.js', 'shared/tutor-engine.js']) {
      assert.ok(files.includes(f), `${browser} build is missing ${f}`);
    }
  }
});

test('cleanup', () => rmSync(tmp, { recursive: true, force: true }));

test('without --out a build goes to dist/<browser> at the repo root, through Node paths only', () => {
  const src = resolve('/x/repo/extension');
  assert.equal(defaultOut('chrome', src), resolve('/x/repo/dist/chrome'));
  assert.deepEqual(parseArgs(['--browser', 'chrome'], src), { browser: 'chrome', out: resolve('/x/repo/dist/chrome') });
  assert.deepEqual(parseArgs(['--browser', 'firefox', '--out', 'y'], src), { browser: 'firefox', out: 'y' });
  // An unknown browser still fails in build(), with no default made up.
  assert.equal(parseArgs(['--browser', 'safari'], src).out, undefined);
  assert.throws(() => parseArgs(['--zip'], src), /unknown argument/);
  // npm runs scripts through cmd.exe on Windows, which has no ${VAR:-default}.
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  for (const [name, script] of Object.entries(pkg.scripts)) assert.doesNotMatch(script, /\$\{|\$[A-Z]/, name);
});
