// Bundles fixture.jsx with React and flexlayout-react into one script and
// returns it with the library's dark theme CSS. Used by layout.e2e.mjs (in
// memory, nothing written); `npm run build` here just checks it builds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildFixture() {
  const out = await build({
    entryPoints: [path.join(here, 'fixture.jsx')],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    minify: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(here, 'node_modules', 'flexlayout-react', 'package.json'), 'utf8'));
  return {
    js: out.outputFiles[0].text,
    css: fs.readFileSync(path.join(here, 'node_modules', 'flexlayout-react', 'style', 'dark.css'), 'utf8'),
    version: pkg.version,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { js, version } = await buildFixture();
  console.log(`built the fixture with flexlayout-react ${version}: ${js.length} bytes`);
}
