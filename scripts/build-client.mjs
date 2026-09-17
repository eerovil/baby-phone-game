/**
 * Bundle the TypeScript client into the one file the page loads.
 *
 * The Worker serves `public/` verbatim, so `public/app.js` is a build output
 * rather than something anybody edits. `--check` proves the committed bundle
 * matches the sources.
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'public', 'app.js');

const result = await build({
  entryPoints: [join(root, 'client', 'main.ts')],
  bundle: true,
  // A classic script, not a module: `<script type="module">` is Chrome 61,
  // and an IIFE bundle drops that floor to Chrome 55 — which is as low as
  // esbuild can compile `async` to anyway.
  format: 'iife',
  // Old phones are the whole point of this app, so the bundle is compiled down
  // to what a 2015-era browser engine understands — the floor is Android 5.
  // Modern syntax does not fail gracefully on an old engine: it is a parse
  // error, the whole file is thrown away, and the app never starts at all.
  // `?.`/`??` are Chrome 80 and async/await is Chrome 55, which is the floor:
  // esbuild cannot compile `async` any lower than that.
  // Safari 12 rather than 11: esbuild refuses to compile `for…of` for Safari 11,
  // which has a known bug in it. iOS 12 runs back to the iPhone 5s.
  target: ['es2017', 'chrome55', 'safari12', 'firefox60'],
  minify: false,
  sourcemap: false,
  write: false,
  logLevel: 'warning',
});

const bundled = result.outputFiles[0].text;

if (process.argv.includes('--check')) {
  let existing = '';
  try {
    existing = readFileSync(outfile, 'utf8');
  } catch {
    // Never built here before; any content at all counts as a mismatch.
  }
  if (existing !== bundled) {
    console.error('public/app.js is stale. Run: npm run build');
    process.exit(1);
  }
  console.log('public/app.js is up to date');
} else {
  writeFileSync(outfile, bundled);
  console.log(`wrote public/app.js (${bundled.length} bytes)`);
}
