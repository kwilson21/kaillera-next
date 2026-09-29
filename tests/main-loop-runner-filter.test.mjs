// KNShared.isMainLoopRunner: the "is this callback Emscripten's main-loop
// runner?" predicate (#62 — clicking the toolbar/feedback form during a
// rollback match desyncs peers). rollback's rAF interceptor used to capture
// ANY callback passed to requestAnimationFrame as _pendingRunner, so a page
// UI callback (e.g. toggleMoreDropdown in play.js, _openModal in
// feedback.js) firing rAF during a match would overwrite the real runner
// and strand the emulator. The fix makes the interceptor capture only the
// callback this predicate matches and pass everything else to the native
// rAF — see docs/netplay-invariants.md §R2.
//
//   node --test tests/main-loop-runner-filter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

globalThis.window = globalThis;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(__dirname, '../web/static/shared.js'));
const { isMainLoopRunner } = globalThis.KNShared;

test('Emscripten main-loop runner is recognized', () => {
  function MainLoop_runner() {}
  assert.equal(isMainLoopRunner(MainLoop_runner), true);
});

test('anonymous arrow function is not the runner', () => {
  const cb = () => {};
  assert.equal(isMainLoopRunner(cb), false);
});

test('anonymous function expression is not the runner', () => {
  const cb = function () {};
  assert.equal(isMainLoopRunner(cb), false);
});

test('named UI callback is not the runner', () => {
  function positionMoreDropdown() {}
  assert.equal(isMainLoopRunner(positionMoreDropdown), false);
});

test('non-functions are not the runner', () => {
  assert.equal(isMainLoopRunner(undefined), false);
  assert.equal(isMainLoopRunner(null), false);
  assert.equal(isMainLoopRunner('MainLoop_runner'), false);
  assert.equal(isMainLoopRunner(42), false);
});

// Pins the name isMainLoopRunner matches against to the name actually
// exported by the shipped core build, so an emsdk bump that renames the
// runner fails loudly here instead of silently breaking the rAF filter.
test('shipped core JS glue still exports MainLoop_runner by that name', () => {
  const corePath = path.join(__dirname, '../web/static/ejs/cores/mupen64plus_next_libretro.js');
  const src = fs.readFileSync(corePath, 'utf8');
  assert.match(src, /function MainLoop_runner\(/);
});
