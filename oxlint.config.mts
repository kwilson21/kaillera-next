import { defineConfig } from 'oxlint';

export default defineConfig({
  ignorePatterns: [
    'web/static/ejs/**',
    'web/static/dist/**',
    '**/*.min.js',
    'build/**',
    'tools/oxlint/anti-slop/**',
    'node_modules/**',
  ],
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
  rules: {
    // Existing code has findings for the rules set to 'warn'; they are a
    // backlog, not a gate. Rules at 'error' are clean today and stay clean.
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    'oxc/no-accumulating-spread': 'error',
    'anti-slop/no-array-filter-map': 'warn',
    'anti-slop/no-reduce-accumulator-copy': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'warn',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    // Off: plain JS has no types, so `typeof` is the only runtime guard there is.
    'anti-slop/no-runtime-typeof': 'off',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    // Off: blank-line style belongs to the formatter (oxfmt), and this flags ~6,900 lines.
    'anti-slop/require-readable-spacing': 'off',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
  },
});
