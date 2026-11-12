// Build the TypeScript core and standalone landing-page waking art as classic
// scripts. Both bundles are committed so serving and deploying need no Node
// step; CI rebuilds them and fails if either committed copy is stale.
//
//   node scripts/build-web.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['web/src/index.ts'],
  outfile: 'web/static/dist/kn-core.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

await build({
  absWorkingDir: root,
  entryPoints: ['web/src/wake-art-entry.ts'],
  outfile: 'web/static/dist/kn-wake-art.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});
