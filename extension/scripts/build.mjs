#!/usr/bin/env node
// Copies the extension into an output folder for a given browser.
// Usage: node scripts/build.mjs --browser chrome|firefox --out <dir>
// The repo manifest lists both background.service_worker (Chrome) and
// background.scripts (Firefox). Chrome warns about the latter, so the chrome
// build drops it from the output manifest only. The source is never modified.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Names excluded at any depth.
const EXCLUDED_NAMES = new Set(['e2e', 'package.json', 'PRIVACY_POLICY.md', 'web-ext-artifacts', 'node_modules', 'scripts']);

export function isExcluded(relPath) {
  const parts = relPath.split(sep);
  const name = basename(relPath);
  if (parts.some((p) => EXCLUDED_NAMES.has(p))) return true;
  if (/\.test\.(js|mjs)$/.test(name)) return true;
  if (name.endsWith('_CHECKLIST.md')) return true;
  if (parts.length === 2 && parts[0] === 'icons' && name.startsWith('screenshot')) return true;
  return false;
}

export function build({ browser, out, src = SRC }) {
  if (browser !== 'chrome' && browser !== 'firefox') {
    throw new Error('--browser must be chrome or firefox');
  }
  if (!out) throw new Error('--out <dir> is required');
  const dest = resolve(out);
  if (dest === src || src.startsWith(dest + sep)) {
    throw new Error('--out must not be the extension folder or one of its parents');
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      if (from === src) return true;
      return !isExcluded(from.slice(src.length + 1));
    },
  });
  if (browser === 'chrome') {
    const path = join(dest, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.background) delete manifest.background.scripts;
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  }
  return dest;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--browser') args.browser = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dest = build(parseArgs(process.argv.slice(2)));
    console.log(`built ${dest}`);
  } catch (err) {
    console.error(err.message);
    console.error('usage: node scripts/build.mjs --browser chrome|firefox --out <dir>');
    process.exit(1);
  }
}
