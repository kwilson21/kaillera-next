// Build the TypeScript core, the small bundle for pages without the core, the
// standalone landing-page waking art, the invite page and the front page as
// classic scripts.
// The bundles are committed so serving and deploying need no Node
// step; CI rebuilds them and fails if a committed copy is stale.
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

await build({
  absWorkingDir: root,
  entryPoints: ['web/src/site-entry.ts'],
  outfile: 'web/static/dist/kn-site.js',
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
  entryPoints: ['web/src/join-entry.ts'],
  outfile: 'web/static/dist/kn-join.js',
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
  entryPoints: ['web/src/landing-entry.ts'],
  outfile: 'web/static/dist/kn-landing.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});
