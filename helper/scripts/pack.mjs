#!/usr/bin/env node
// Builds helper/runtime/: the companion and relay the helper runs, copied
// from their one canonical source in this repository, so the npm package is
// self-contained. `prepack` runs it and `postpack` removes the folder again,
// so the copy never lives in the checkout.
//
//   node scripts/pack.mjs          build runtime/
//   node scripts/pack.mjs --clean  remove it
//
// The copy keeps the repository's relative layout, because the code imports
// across folders by relative path (the companion imports
// ../extension/shared/*.js and ../vault-tool/vault-notes.js). Every relative
// import reachable from the entry points must land inside the copy and every
// package import must be a dependency of the helper package, or the build
// fails (checkBundle below, which the tests also run).

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HELPER_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(HELPER_DIR, '..');
export const RUNTIME_DIR = path.join(HELPER_DIR, 'runtime');

// The folders copied, each with every .js file in it except tests.
export const SOURCES = ['companion', 'relay-server', 'extension/shared', 'vault-tool'];
// What the helper starts; the import walk begins here.
export const ENTRY_POINTS = ['companion/companion.js', 'relay-server/server.js'];
// The marker that tells the host this root is a bundled copy.
export const BUNDLE_MARKER = 'bundle.json';

const isTestFile = (name) => name.endsWith('.test.js') || name === 'test-isolation.js';

export function runtimeFiles(repoRoot = REPO_ROOT) {
  const files = [];
  for (const dir of SOURCES) {
    for (const name of fs.readdirSync(path.join(repoRoot, dir)).sort()) {
      if (name.endsWith('.js') && !isTestFile(name)) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

// Each copied folder gets a package.json carrying only its module type, which
// decides how Node loads its .js files (the relay and vault tool are
// CommonJS, the rest ES modules). Without it the helper's own package.json
// ("type": "module") would apply to them.
function moduleTypeFile(repoRoot, dir) {
  let type = 'commonjs';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'));
    if (pkg.type === 'module') type = 'module';
  } catch {
    // no package.json there: CommonJS
  }
  return `${JSON.stringify({ private: true, type }, null, 2)}\n`;
}

export function build({ repoRoot = REPO_ROOT, out = RUNTIME_DIR, helperPkg = readHelperPackage() } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  const files = runtimeFiles(repoRoot);
  for (const rel of files) {
    fs.mkdirSync(path.join(out, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), path.join(out, rel));
  }
  for (const dir of SOURCES) fs.writeFileSync(path.join(out, dir, 'package.json'), moduleTypeFile(repoRoot, dir));
  fs.writeFileSync(
    path.join(out, BUNDLE_MARKER),
    `${JSON.stringify({ version: helperPkg.version, note: 'Built by scripts/pack.mjs from the LeetCode Capture repository. Do not edit.', files }, null, 2)}\n`,
  );
  const problems = checkBundle(out, helperPkg);
  if (problems.length) {
    fs.rmSync(out, { recursive: true, force: true });
    throw new Error(`the bundled runtime is incomplete:\n  ${problems.join('\n  ')}`);
  }
  return files;
}

export function readHelperPackage() {
  return JSON.parse(fs.readFileSync(path.join(HELPER_DIR, 'package.json'), 'utf8'));
}

// String-literal imports: `from '...'`, `import '...'`, `import('...')`,
// `require('...')`. Comments are stripped first so prose that mentions a
// path does not count.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

export function importsOf(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const found = new Set();
  for (const match of code.matchAll(IMPORT_RE)) found.add(match[2]);
  return [...found];
}

const BUILTINS = new Set(builtinModules);
const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

// Walks the import graph from the entry points inside `root` and returns a
// list of problems: relative imports that are missing or leave the copy, and
// package imports the helper package does not declare.
export function checkBundle(root, helperPkg = readHelperPackage()) {
  const declared = new Set(Object.keys({ ...helperPkg.dependencies, ...helperPkg.optionalDependencies }));
  const problems = [];
  const seen = new Set();
  const queue = ENTRY_POINTS.map((rel) => path.join(root, rel));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const shown = path.relative(root, file);
    if (!fs.existsSync(file)) {
      problems.push(`${shown} is missing`);
      continue;
    }
    for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        const resolved = [target, `${target}.js`].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
        if (path.relative(root, target).startsWith('..')) problems.push(`${shown} imports ${spec}, outside the bundle`);
        else if (!resolved) problems.push(`${shown} imports ${spec}, which is not in the bundle`);
        else queue.push(resolved);
      } else if (!spec.startsWith('node:') && !BUILTINS.has(spec) && !declared.has(packageName(spec))) {
        problems.push(`${shown} imports the package ${packageName(spec)}, which is not a dependency of the helper package`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--clean')) {
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  } else {
    const files = build();
    console.error(`runtime/: ${files.length} files from ${SOURCES.join(', ')}`);
  }
}
