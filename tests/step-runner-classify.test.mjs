// KNShared.classifyRunnerStep: the "did stepOneFrame's runner actually
// emulate the frame?" decision (#62 — clicking the toolbar/feedback form
// during a rollback match desyncs peers). A focus change bumps Emscripten's
// currentlyRunningMainloop, which makes a previously-captured MainLoop
// runner stale: calling it returns immediately without emulating the frame
// or scheduling its successor. stepOneFrame used to count that frame
// anyway, leaving this peer one tick behind. The fix samples two signals
// around the runner call — whether a fresh runner got rescheduled, and
// whether CP0 Count (kn_get_cycle_time_ms) moved — and this function turns
// them into the emulated/stale/unknown verdict.
//
//   node --test tests/step-runner-classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.window = globalThis;
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/static/shared.js'));
const { classifyRunnerStep } = globalThis.KNShared;

test('a normal step (rescheduled, cycle time advanced) is emulated', () => {
  assert.equal(classifyRunnerStep(true, 0, 8.65), 'emulated');
});

test('a normal step that also reschedules with unchanged cycle time is emulated', () => {
  // Some legitimate steps (e.g. very first frame) may not move the cycle
  // counter; rescheduling alone is enough to prove the runner ran.
  assert.equal(classifyRunnerStep(true, 0, 0), 'emulated');
});

test('#62: no reschedule and unchanged cycle time is stale', () => {
  assert.equal(classifyRunnerStep(false, 0, 0), 'stale');
});

test('no reschedule but cycle time advanced is emulated (legit mid-frame pause)', () => {
  // The runner emulated the frame but paused mid-frame before scheduling
  // its successor (e.g. a rollback-triggered pauseMainLoop). Do not re-step
  // — the frame was already advanced.
  assert.equal(classifyRunnerStep(false, 3.2, 11.85), 'emulated');
});

test('stock core (no kn_get_cycle_time_ms export) is unknown regardless of reschedule', () => {
  assert.equal(classifyRunnerStep(true, null, null), 'unknown');
  assert.equal(classifyRunnerStep(false, null, null), 'unknown');
});
