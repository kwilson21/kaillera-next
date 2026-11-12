// Bundle the TypeScript core (web/src) into one classic script the existing
// pages load before their own: web/static/dist/kn-core.js, exposing
// window.KNCore. The bundle is committed so serving and deploying need no
// Node step; CI rebuilds it and fails if the committed copy is stale.
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
