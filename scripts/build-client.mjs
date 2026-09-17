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
  format: 'esm',
  // Old phones are the whole point of this app, so the bundle is compiled down
  // to what a 2017 phone's browser understands. `?.` and `??` are Chrome 80 and
  // Safari 13.1; a phone older than that does not fail gracefully on them, it
  // refuses to parse the file at all and the app never starts.
  target: ['es2017', 'chrome61', 'safari11', 'firefox60'],
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
