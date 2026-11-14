import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  clampDepth,
  createState,
  reduce,
  render,
  rollbackTimeline,
  timelineCaption,
  type TimelineInput,
  type TimelineRefs,
  type TimelineRenderOptions,
  type TimelineState,
} from '../../web/src/page/rollback-timeline.ts';

// What the instrument does, case by case, is tests/rollback-timeline.test.mjs.
// Here the module is held to the script it replaced.

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/rollback-timeline.js as of #166, unchanged.
const OLD_SCRIPT = `/**
 * rollback-timeline.js — the demo page's live "Rollback" instrument
 * (docs/landing-design.md §5.7f #3, §7.2 M3).
 *
 * A small pure state machine (createState/reduce) plus a thin DOM renderer
 * (render). The reducer takes real engine signals each animation frame —
 * NetplayRollback.getHudCounters()'s mode, rollbackEventsTotal,
 * avgRollbackDepth and delay, plus whether a match is active — and turns
 * them into a playhead position, per-tick colouring and a caption. It never
 * invents an event: a "rewind" only starts when rollbackEventsTotal (a real
 * misprediction count from the C engine) increases, and the depth marked is
 * the engine's own avgRollbackDepth sample.
 *
 *   Rollback mode: playhead advances at a steady pace; each real
 *     misprediction interrupts it with a rewind — the last N ticks (N =
 *     the engine's own recent rollback depth) flash red ("wrong guess"),
 *     then blue ("rewind · replay") as the head re-steps through them —
 *     then normal advancing resumes.
 *   Lockstep mode: the head waits at each tick for a duration that scales
 *     with the engine's actual effective delay (frames), because that is
 *     what lockstep really does — wait out the round trip every frame.
 *     It never rewinds (lockstep has nothing to correct).
 *   No match / reduced motion: a static frame — see render()'s \`still\`
 *     path. Callers should stop feeding events under
 *     prefers-reduced-motion and call render() with \`still: true\` once.
 *
 * Exposes: window.KNRollbackTimeline = { createState, reduce, clampDepth, render }
 */
(function () {
  'use strict';

  var ADVANCE_INTERVAL_MS = 550; // rollback mode: steady per-tick pace
  var REWIND_BAD_MS = 260; // how long a misprediction shows red
  var REPLAY_STEP_MS = 220; // time per replayed tick stepping forward
  var LOCKSTEP_BASE_MS = 260; // lockstep mode: minimum wait per tick
  var LOCKSTEP_MS_PER_FRAME = 90; // extra wait per frame of effective delay

  const createState = (opts) => {
    const trackTicks = (opts && opts.trackTicks) || 11;
    return {
      trackTicks,
      headIndex: 0,
      tickState: new Array(trackTicks).fill('idle'),
      mode: 'rollback',
      phase: 'idle',
      phaseUntil: 0,
      seenRollbackTotal: 0,
      rewindDepth: 0,
      rewindReplayed: 0,
      rewindIdx: [],
      label: null,
      matchActive: false,
    };
  };

  // Clamp a reported rollback depth to something the ring can show: at
  // least 1 tick, at most 4 (or trackTicks-2, whichever is smaller, so a
  // rewind never wraps into overwriting itself on a short track).
  const clampDepth = (raw, trackTicks) => {
    const d = Math.round(raw) || 1;
    const maxDepth = Math.max(1, Math.min(4, trackTicks - 2));
    return Math.max(1, Math.min(maxDepth, d));
  };

  const _resetAnimation = (s) => {
    s.phase = 'idle';
    s.phaseUntil = 0;
    s.tickState = new Array(s.trackTicks).fill('idle');
    s.label = null;
    s.rewindDepth = 0;
    s.rewindReplayed = 0;
    s.rewindIdx = [];
  };

  // Pure reducer: (state, {mode, matchActive, rollbackEventsTotal,
  // avgRollbackDepth, delay}, now) -> next state. \`now\` is a caller-supplied
  // timestamp (performance.now() in the browser; an explicit ms count in
  // tests), so this function is deterministic and needs no timers itself.
  const reduce = (state, input, now) => {
    const s = Object.assign({}, state, { tickState: state.tickState.slice(), rewindIdx: state.rewindIdx.slice() });
    const mode = input.mode === 'lockstep' ? 'lockstep' : 'rollback';

    if (mode !== s.mode) {
      s.mode = mode;
      _resetAnimation(s);
    }

    const matchActive = !!input.matchActive;
    if (matchActive !== s.matchActive) {
      s.matchActive = matchActive;
      _resetAnimation(s);
      // Resync the seen-total on every match boundary so a fresh match
      // doesn't replay a rewind for events counted before it started (or
      // during a previous match).
      s.seenRollbackTotal = input.rollbackEventsTotal || 0;
    }

    if (!s.matchActive) return s;

    if (s.mode === 'rollback') {
      const total = input.rollbackEventsTotal || 0;
      const delta = total - s.seenRollbackTotal;
      const midRewind = s.phase === 'rewind-bad' || s.phase === 'rewind-replay';
      if (delta > 0 && !midRewind) {
        s.seenRollbackTotal = total;
        const depth = clampDepth(input.avgRollbackDepth || 1, s.trackTicks);
        const idx = [];
        for (let i = 0; i < depth; i++) {
          idx.push((((s.headIndex - i) % s.trackTicks) + s.trackTicks) % s.trackTicks);
        }
        idx.forEach((ix) => {
          s.tickState[ix] = 'bad';
        });
        s.rewindIdx = idx;
        s.rewindDepth = depth;
        s.rewindReplayed = 0;
        s.phase = 'rewind-bad';
        s.phaseUntil = now + REWIND_BAD_MS;
        s.label = { text: 'wrong guess', kind: 'bad' };
        return s;
      }
      if (s.phase === 'rewind-bad') {
        if (now >= s.phaseUntil) {
          s.rewindIdx.forEach((ix) => {
            s.tickState[ix] = 'replay';
          });
          s.phase = 'rewind-replay';
          s.phaseUntil = now + REPLAY_STEP_MS;
          s.label = { text: 'rewind · replay', kind: 'replay' };
        }
        return s;
      }
      if (s.phase === 'rewind-replay') {
        if (now >= s.phaseUntil) {
          s.rewindReplayed += 1;
          if (s.rewindReplayed < s.rewindDepth) {
            s.phaseUntil = now + REPLAY_STEP_MS;
          } else {
            s.rewindIdx.forEach((ix) => {
              s.tickState[ix] = 'idle';
            });
            s.rewindIdx = [];
            s.rewindDepth = 0;
            s.rewindReplayed = 0;
            s.phase = 'advance';
            s.phaseUntil = now + ADVANCE_INTERVAL_MS;
            s.label = null;
          }
        }
        return s;
      }
      if (s.phase !== 'advance') {
        s.phase = 'advance';
        s.phaseUntil = now + ADVANCE_INTERVAL_MS;
        return s;
      }
      if (now >= s.phaseUntil) {
        s.headIndex = (s.headIndex + 1) % s.trackTicks;
        s.phaseUntil = now + ADVANCE_INTERVAL_MS;
      }
      return s;
    }

    // Lockstep: no prediction, so no rewind — just a per-tick wait that
    // scales with the real effective delay (frames).
    const delayFrames = Math.max(0, input.delay || 0);
    const waitMs = LOCKSTEP_BASE_MS + delayFrames * LOCKSTEP_MS_PER_FRAME;
    if (s.phase !== 'lockstep-wait') {
      s.phase = 'lockstep-wait';
      s.phaseUntil = now + waitMs;
      s.label = { text: 'waiting for input', kind: 'wait' };
      return s;
    }
    if (now >= s.phaseUntil) {
      s.headIndex = (s.headIndex + 1) % s.trackTicks;
      s.phaseUntil = now + waitMs;
    }
    return s;
  };

  // DOM renderer. \`refs\` = { ticks: [11 elements, index order], head,
  // labelBad, labelReplay, caption }. \`spacing\` matches the SVG's tick
  // pitch (6 user units, ticks at x=2+i*6, head resting at x=1+i*6).
  const render = (state, refs, opts) => {
    if (!refs) return;
    const spacing = (opts && opts.spacing) || 6;
    if (opts && opts.still) {
      // Static illustrative frame for prefers-reduced-motion: matches the
      // landing page's still frame (a wrong guess mid-replay), not live.
      if (refs.ticks) {
        refs.ticks.forEach((el, i) => {
          if (!el) return;
          el.classList.remove('is-bad', 'is-replay');
          if (i === 6) el.classList.add('is-bad');
          else if (i === 4 || i === 5) el.classList.add('is-replay');
        });
      }
      if (refs.head) refs.head.style.transform = \`translateX(\${3 * spacing}px)\`;
      if (refs.labelBad) refs.labelBad.style.opacity = '1';
      if (refs.labelReplay) refs.labelReplay.style.opacity = '0';
      if (refs.caption)
        refs.caption.textContent = 'A wrong guess, a rewind, a replay. It happens all the time; you don’t see it.';
      return;
    }
    if (refs.ticks) {
      refs.ticks.forEach((el, i) => {
        if (!el) return;
        const t = state.tickState[i] || 'idle';
        el.classList.toggle('is-bad', t === 'bad');
        el.classList.toggle('is-replay', t === 'replay');
      });
    }
    if (refs.head) refs.head.style.transform = \`translateX(\${state.headIndex * spacing}px)\`;
    if (refs.labelBad) refs.labelBad.style.opacity = state.label && state.label.kind === 'bad' ? '1' : '0';
    if (refs.labelReplay) refs.labelReplay.style.opacity = state.label && state.label.kind === 'replay' ? '1' : '0';
    if (refs.caption) {
      let text;
      if (!state.matchActive) text = 'Waiting for a match to start.';
      else if (state.label && state.label.kind === 'bad') text = 'Wrong guess — the opponent did something else.';
      else if (state.label && state.label.kind === 'replay')
        text = 'Rewinding and replaying from the last correct frame.';
      else if (state.mode === 'lockstep') text = 'Lockstep: waiting for the opponent’s input every frame.';
      else text = 'Rollback: running ahead, predicting the opponent.';
      refs.caption.textContent = text;
    }
  };

  globalThis.KNRollbackTimeline = { createState, reduce, clampDepth, render };
})();
`;

type Timeline = typeof rollbackTimeline;

/** The context the old script runs in: it assigns its global here. */
interface OldGlobals {
  KNRollbackTimeline?: Timeline;
}

/** One frame's signals while they are being put together. */
interface Signals {
  mode?: string;
  matchActive?: boolean;
  rollbackEventsTotal?: number;
  avgRollbackDepth?: number;
  delay?: number;
}

/** The caption element: only its text. */
interface Caption {
  textContent: string | null;
}

const loadOld = (): Timeline => {
  // The old script assigns globalThis.KNRollbackTimeline; in a new context
  // globalThis is this object.
  const globals: OldGlobals = {};
  vm.runInNewContext(OLD_SCRIPT, globals);
  assert.ok(globals.KNRollbackTimeline, 'the old script did not define KNRollbackTimeline');
  return globals.KNRollbackTimeline;
};

const old = loadOld();

/** A small seeded generator (mulberry32), so a failure can be replayed. */
const seeded = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

test('the page global has the four functions the old script exposed', () => {
  assert.deepEqual(Object.keys(rollbackTimeline).sort(), Object.keys(old).sort());
  assert.deepEqual(Object.keys(rollbackTimeline).sort(), ['clampDepth', 'createState', 'reduce', 'render']);
});

test('createState: same first state for every track length', () => {
  assert.deepStrictEqual(createState(), structuredClone(old.createState()));
  assert.deepStrictEqual(createState(null), structuredClone(old.createState(null)));
  assert.deepStrictEqual(createState({}), structuredClone(old.createState({})));
  for (let trackTicks = 0; trackTicks <= 16; trackTicks++) {
    assert.deepStrictEqual(createState({ trackTicks }), structuredClone(old.createState({ trackTicks })));
  }
});

test('clampDepth: same answer over depths and track lengths, whole and fractional', () => {
  const depths = [Number.NaN, -3, -0.4, 0, 0.2, 0.5, 1, 1.49, 1.5, 2, 2.5, 3.4, 3.5, 4, 4.6, 7, 20, 1e9];
  for (let trackTicks = -1; trackTicks <= 16; trackTicks++) {
    for (const depth of depths) {
      assert.equal(clampDepth(depth, trackTicks), old.clampDepth(depth, trackTicks), `${depth} on ${trackTicks}`);
    }
  }
});

/** One frame's signals, drawn the way a match produces them, with the odd missing or bad value. */
const nextInput = (rand: () => number, total: number): TimelineInput => {
  const input: Signals = {};
  const modeRoll = rand();
  if (modeRoll < 0.8) input.mode = 'rollback';
  else if (modeRoll < 0.97) input.mode = 'lockstep';
  if (rand() < 0.93) input.matchActive = rand() < 0.9;
  if (rand() < 0.95) input.rollbackEventsTotal = total;
  if (rand() < 0.9) input.avgRollbackDepth = rand() < 0.05 ? Number.NaN : rand() * 7;
  if (rand() < 0.9) input.delay = Math.floor(rand() * 12) - 1;
  return input;
};

test('reduce: old and new agree on every state over long random runs', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = seeded(seed);
    const lengths = [undefined, 11, 2, 3, 5, 8];
    const trackTicks = lengths[seed % lengths.length];
    const opts = trackTicks === undefined ? undefined : { trackTicks };
    let mine = createState(opts);
    let theirs = old.createState(opts);
    let now = 0;
    let total = 0;
    for (let step = 0; step < 600; step++) {
      now += rand() < 0.1 ? rand() * 900 : rand() * 40;
      if (rand() < 0.08) total += 1 + Math.floor(rand() * 3);
      // A new session's counter starts again from zero.
      if (rand() < 0.01) total = 0;
      const input = nextInput(rand, total);
      const before = structuredClone(mine);
      const next = reduce(mine, input, now);
      assert.deepStrictEqual(mine, before, 'reduce changed the state it was given');
      mine = next;
      theirs = old.reduce(theirs, input, now);
      assert.deepStrictEqual(mine, structuredClone(theirs), `seed ${seed} step ${step}`);
    }
  }
});

/** The page's elements, recording what the renderer did to them. */
const fakeRefs = (ticks: number) => {
  const classes = Array.from({ length: ticks }, () => new Set<string>());
  const head = { style: { transform: '' } };
  const labelBad = { style: { opacity: '' } };
  const labelReplay = { style: { opacity: '' } };
  const caption: Caption = { textContent: null };
  const refs = {
    ticks: classes.map((set) => ({
      classList: {
        add: (...tokens: string[]): void => {
          for (const token of tokens) set.add(token);
        },
        remove: (...tokens: string[]): void => {
          for (const token of tokens) set.delete(token);
        },
        toggle: (token: string, force?: boolean): void => {
          if (force) set.add(token);
          else set.delete(token);
        },
      },
    })),
    head,
    labelBad,
    labelReplay,
    caption,
  } satisfies TimelineRefs;
  const drawn = () => ({
    ticks: classes.map((set) => [...set].sort()),
    head: head.style.transform,
    bad: labelBad.style.opacity,
    replay: labelReplay.style.opacity,
    caption: caption.textContent,
  });
  return { refs, drawn };
};

const RENDER_OPTIONS: ReadonlyArray<TimelineRenderOptions | undefined> = [
  undefined,
  {},
  { spacing: 6 },
  { spacing: 10 },
  { still: true },
  { still: true, spacing: 4 },
];

test('render: old and new draw the same thing for every state of a run', () => {
  let rewinds = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const rand = seeded(1000 + seed);
    let state = createState();
    let now = 0;
    let total = 0;
    const mine = fakeRefs(11);
    const theirs = fakeRefs(11);
    for (let step = 0; step < 300; step++) {
      now += rand() * 120;
      if (rand() < 0.1) total += 1;
      state = reduce(state, nextInput(rand, total), now);
      if (state.phase === 'rewind-replay') rewinds++;
      const opts = RENDER_OPTIONS[Math.floor(rand() * RENDER_OPTIONS.length)];
      render(state, mine.refs, opts);
      old.render(state, theirs.refs, opts);
      assert.deepEqual(mine.drawn(), theirs.drawn(), `seed ${seed} step ${step}`);
      if (!opts?.still) assert.equal(mine.drawn().caption, timelineCaption(state));
    }
  }
  assert.ok(rewinds > 20, `the runs reached a replay only ${rewinds} times`);
});

test('render: missing elements are skipped the same way', () => {
  const state: TimelineState = reduce(createState(), { mode: 'rollback', matchActive: true }, 0);
  for (const opts of RENDER_OPTIONS) {
    render(state, null, opts);
    old.render(state, null, opts);
    render(state, {}, opts);
    old.render(state, {}, opts);
    const mine = fakeRefs(3);
    const theirs = fakeRefs(3);
    render(state, { ...mine.refs, ticks: [null, ...mine.refs.ticks], head: null, caption: undefined }, opts);
    old.render(state, { ...theirs.refs, ticks: [null, ...theirs.refs.ticks], head: null, caption: undefined }, opts);
    assert.deepEqual(mine.drawn(), theirs.drawn());
  }
});
