#!/usr/bin/env node
// leetcode-capture-helper install | uninstall | status
//
//   install [--chrome-id <id>]... [--browser <id>]... [--root <folder>]
//     Registers the helper with the browsers found for this user (or only the
//     ones named with --browser). Chrome, Chromium, Edge and Brave need the
//     extension's id, which the extension's settings page shows in the
//     command to copy. --root is the LeetCode Capture folder holding
//     companion/ and relay-server/ (by default the one this helper is in).
//   uninstall  Removes exactly what install wrote.
//   status     Shows what is registered where.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_IDS, install, status, uninstall } from './install.js';
import { resolveRoot } from './host.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, chromeIds: [], browsers: [], root: null, keepSettings: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    const take = () => {
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    if (flag === '--chrome-id') options.chromeIds.push(...take().split(','));
    else if (flag === '--browser') options.browsers.push(...take().split(','));
    else if (flag === '--root') options.root = take();
    else if (flag === '--keep-settings') options.keepSettings = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

const USAGE = `usage: leetcode-capture-helper <install|uninstall|status> [options]

  install [--chrome-id <id>]... [--browser <${BROWSER_IDS.join('|')}>]... [--root <folder>]
  uninstall [--keep-settings]
  status`;

export function run(argv, { home = os.homedir(), env = process.env, platform = process.platform, reg, print = console.log } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    print(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const common = { home, env, platform, ...(reg ? { reg } : {}) };
  try {
    if (options.command === 'install') {
      const result = install({
        ...common,
        root: options.root ? path.resolve(options.root) : resolveRoot(env, HERE),
        chromeIds: options.chromeIds,
        browsers: options.browsers.length ? options.browsers : null,
      });
      if (result.registered.length) print(`Registered the LeetCode Capture helper with: ${result.registered.join(', ')}.`);
      for (const note of result.notes) print(note);
      print(`Files are in ${result.dataDir}. Press Check again on the extension's settings page.`);
      return result.registered.length ? 0 : 1;
    }
    if (options.command === 'uninstall') {
      const result = uninstall({ ...common, keepSettings: options.keepSettings });
      print(result.nothing ? 'The helper is not installed.' : `Removed the helper (${result.removed.length} items).`);
      if (result.leftover.length) {
        print(`Could not remove ${result.leftover.join(', ')} (in use). Close the browser, then run uninstall again.`);
        return 1;
      }
      return 0;
    }
    if (options.command === 'status') {
      const s = status(common);
      print(s.installed ? `Installed (version ${s.version}) in ${s.dataDir}` : 'Not installed.');
      if (s.root) print(`LeetCode Capture folder: ${s.root}${s.rootError ? ` (problem: ${s.rootError})` : ''}`);
      for (const b of s.browsers) print(`  ${b.label}: ${b.registered ? `registered for ${b.allowed.join(', ')}` : 'not registered'}`);
      return s.installed ? 0 : 1;
    }
  } catch (err) {
    print(`leetcode-capture-helper: ${err.message}`);
    return 1;
  }
  print(USAGE);
  return 2;
}

// npx and global installs run this through a symlink in node_modules/.bin.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
