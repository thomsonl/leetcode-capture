// The modules in extension/shared/ (and the background engine built on them)
// run in two places: the companion imports them under Node, and the
// extension's background service worker imports them in the browser. A Node
// built-in (fs, path, process, Buffer, ...) works in the first and breaks the
// second, so this fails the moment any of them reaches for one.
//
// Run with: node --test shared.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SHARED = path.join(__dirname, "shared");
const ENGINE = path.join(__dirname, "engine");

function moduleFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dir, name));
}

// Comments and string contents are dropped first, so a comment that names
// `process` or a prompt that says "Buffer" cannot fail the check.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function importsOf(source) {
  const specs = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

const NODE_GLOBALS = /\b(process|Buffer|require|__dirname|__filename|module\.exports|global|setImmediate)\b/;

const files = [...moduleFiles(SHARED), ...moduleFiles(ENGINE)];

test("there are shared modules to check", () => {
  assert.ok(moduleFiles(SHARED).length >= 5, "extension/shared/ holds the shared modules");
});

for (const file of files) {
  const rel = path.relative(__dirname, file);
  test(`${rel} imports no Node built-in and uses no Node global`, () => {
    const source = fs.readFileSync(file, "utf8");
    for (const spec of importsOf(source)) {
      assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${rel} imports "${spec}": only relative imports work in the extension`);
      const target = path.resolve(path.dirname(file), spec);
      assert.ok(target.startsWith(__dirname + path.sep), `${rel} imports "${spec}" from outside the extension folder`);
      assert.ok(fs.existsSync(target), `${rel} imports "${spec}", which does not exist`);
    }
    const match = codeOnly(source).match(NODE_GLOBALS);
    assert.equal(match, null, `${rel} uses the Node global "${match && match[0]}"`);
  });
}

test("the check itself catches a Node import and a Node global", () => {
  assert.deepEqual(importsOf("import fs from 'node:fs';\nimport { x } from './y.js';"), ["node:fs", "./y.js"]);
  assert.ok(NODE_GLOBALS.test(codeOnly("const a = process.env.X;")));
  assert.ok(!NODE_GLOBALS.test(codeOnly("// process\nconst s = 'process';")));
});
