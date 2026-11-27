// Exercise the scheduler in the distributed core, including callbacks queued before takeover.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const glue = readFileSync(new URL('../web/static/ejs/cores/mupen64plus_next_libretro.js', import.meta.url), 'utf8');
const scheduler = glue.slice(glue.indexOf('var _emscripten_set_main_loop_timing='), glue.indexOf('var AL='));

function fixture(mode) {
  const queued = [];
  const microtasks = [];
  let steps = 0;
  let pending;
  const enqueue = (fn) => queued.push(fn);
  const ctx = {
    Module: {},
    ABORT: false,
    Asyncify: { currData: null, state: 0, State: { Normal: 0 } },
    queueMicrotask: (fn) => microtasks.push(fn),
    setTimeout: enqueue,
    requestAnimationFrame: enqueue,
    setImmediate: enqueue,
    maybeExit() {},
    _emscripten_get_now: () => 0,
    callUserCallback: (fn) => fn(),
  };
  runInNewContext(scheduler, ctx);
  ctx.setMainLoop(() => steps++, 0, false, 0, true);
  ctx._emscripten_set_main_loop_timing(mode, 1);
  const loop = ctx.MainLoop;
  function own() {
    loop.pause();
    ctx.Module.knSetManualScheduler?.((fn) => {
      pending = fn;
    });
    loop.resume();
  }
  return { ctx, loop, queued, microtasks, own, steps: () => steps, tick: () => pending() };
}

for (const [mode, name] of ['timer', 'rAF', 'immediate'].entries()) {
  test(name + ' resume delivers its runner only to the module owner', () => {
    const f = fixture(mode);
    f.own();
    assert.equal(f.queued.length, 0);
    assert.equal(f.tick(), true);
    assert.equal(f.steps(), 1);
    assert.equal(f.queued.length, 0);
  });
  test(name + ' uses native scheduling again on explicit streaming resume', () => {
    const f = fixture(mode);
    f.own();
    f.loop.pause();
    f.ctx.Module.knSetManualScheduler(null);
    assert.equal(f.queued.length, 0);
    f.loop.resume();
    f.queued.shift()();
    assert.equal(f.steps(), 1);
    assert.equal(f.queued.length, 1);
  });
}

test('a blocker schedules its successor without counting a native dispatch', () => {
  const f = fixture(0);
  let blocked = 0;
  f.own();
  f.loop.queue.push({ func: () => blocked++ });
  assert.equal(f.tick(), false);
  assert.equal(blocked, 1);
  assert.equal(f.steps(), 0);
  assert.equal(f.queued.length, 0);
  assert.equal(f.tick(), true);
});

test('a queued older generation cannot consume a current blocker', () => {
  const f = fixture(1);
  f.loop.scheduler();
  const stale = f.queued.shift();
  f.own();
  f.loop.queue.push({ func() {} });
  stale();
  assert.equal(f.loop.queue.length, 1);
  assert.equal(f.queued.length, 0);
});

test('a vetoed iteration does not report dispatch and other modules keep running', () => {
  const f = fixture(2);
  const other = fixture(0);
  f.own();
  f.loop.preMainLoop.push(() => false);
  assert.equal(f.tick(), false);
  assert.equal(f.steps(), 0);
  other.loop.scheduler();
  other.queued.shift()();
  assert.equal(other.steps(), 1);
});

test('the manual scheduler wakes its state loader after the suspended frame finishes', () => {
  const f = fixture(1);
  f.own();
  const { Asyncify, Module } = f.ctx;
  let wakes = 0;
  assert.equal(
    Module.knWaitForManualSchedulerIdle(() => wakes++),
    false,
  );
  Asyncify.currData = 128;
  assert.equal(
    Module.knWaitForManualSchedulerIdle(() => wakes++),
    true,
  );
  f.loop.notifyManualIdle();
  assert.equal(f.microtasks.length, 0);
  Asyncify.currData = null;
  f.loop.notifyManualIdle();
  f.loop.notifyManualIdle();
  assert.equal(wakes, 0);
  assert.equal(f.microtasks.length, 1);
  f.microtasks.shift()();
  assert.equal(wakes, 1);
});

test('an idle notification queued by an old owner cannot wake a new owner', () => {
  const f = fixture(1);
  f.own();
  const { Asyncify, Module } = f.ctx;
  Asyncify.currData = 128;
  assert.equal(
    Module.knWaitForManualSchedulerIdle(() => assert.fail('old owner woke')),
    true,
  );
  Asyncify.currData = null;
  f.loop.notifyManualIdle();
  Module.knSetManualScheduler(null);
  f.own();
  f.microtasks.shift()();
});

test('lockstep requires dispatch and cycle progress on its owned module', () => {
  const page = readFileSync(new URL('../web/static/netplay-rollback.js', import.meta.url), 'utf8');
  const classify = page.slice(page.indexOf('  const _runCapturedRunner ='), page.indexOf('  const stepOneFrame ='));
  function outcome(dispatched, delta) {
    const f = fixture(0);
    f.own();
    if (!dispatched) f.loop.queue.push({ func() {} });
    let cycles = 0;
    const ctx = {
      _manualSchedulerModule: f.ctx.Module,
      _hasForkedCore: true,
      _prepareFrameStep() {},
      window: { EJS_emulator: { gameManager: { Module: { _kn_get_cycle_time_ms: () => cycles } } } },
      _pendingRunner() {
        const ran = f.tick();
        ctx._pendingRunner = f.tick;
        cycles += delta;
        return ran;
      },
    };
    return runInNewContext(classify + '\n_runCapturedRunner(16)', ctx);
  }
  assert.equal(outcome(false, 1), 'stale');
  assert.equal(outcome(true, 0), 'stale');
  assert.equal(outcome(true, 1), 'emulated');
});
