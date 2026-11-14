/**
 * The demo page's live "Rollback" instrument (docs/landing-design.md §5.7f #3,
 * §7.2 M3). Moved from web/static/rollback-timeline.js.
 *
 * A small pure state machine (`createState`/`reduce`) and a renderer
 * (`render`) that writes to the elements it is handed. The reducer takes real
 * engine signals each animation frame (NetplayRollback.getHudCounters()'s
 * mode, rollbackEventsTotal, avgRollbackDepth and delay, plus whether a match
 * is active) and turns them into a playhead position, a colour per tick and a
 * caption. It never invents an event: a rewind only starts when
 * rollbackEventsTotal (a real misprediction count from the C engine) goes up,
 * and the depth marked is the engine's own avgRollbackDepth sample.
 *
 *   Rollback mode: the playhead advances at a steady pace; each real
 *     misprediction interrupts it with a rewind. The last N ticks (N = the
 *     engine's own recent rollback depth) flash red ("wrong guess"), then
 *     blue ("rewind · replay") as the head steps through them again, then
 *     normal advancing resumes.
 *   Lockstep mode: the head waits at each tick for a time that grows with the
 *     engine's effective delay (frames), because that is what lockstep does:
 *     wait out the round trip every frame. It never rewinds.
 *   No match / reduced motion: a still frame (`render` with `still: true`).
 *     Under prefers-reduced-motion the caller stops feeding events and
 *     renders the still frame once.
 *
 * This module imports nothing, so tests/rollback-timeline.test.mjs loads it
 * with no packages installed.
 */

/** Rollback mode: the steady pace per tick. */
const ADVANCE_INTERVAL_MS = 550;
/** How long a misprediction shows red. */
const REWIND_BAD_MS = 260;
/** Time per replayed tick as the head steps forward again. */
const REPLAY_STEP_MS = 220;
/** Lockstep mode: the shortest wait per tick. */
const LOCKSTEP_BASE_MS = 260;
/** Lockstep mode: extra wait per frame of effective delay. */
const LOCKSTEP_MS_PER_FRAME = 90;

/** How one tick of the track is drawn. */
export type TimelineTick = 'idle' | 'bad' | 'replay';

/** What the playhead is doing. */
export type TimelinePhase = 'idle' | 'advance' | 'rewind-bad' | 'rewind-replay' | 'lockstep-wait';

/** The words over the track, and which of the page's labels shows them. */
export interface TimelineLabel {
  readonly text: string;
  readonly kind: 'bad' | 'replay' | 'wait';
}

/** The instrument's whole state. `reduce` returns a new one each call. */
export interface TimelineState {
  trackTicks: number;
  headIndex: number;
  tickState: TimelineTick[];
  mode: 'rollback' | 'lockstep';
  phase: TimelinePhase;
  /** The time (`now` of `reduce`) the current phase lasts until. */
  phaseUntil: number;
  /** The engine's misprediction count already shown. */
  seenRollbackTotal: number;
  rewindDepth: number;
  rewindReplayed: number;
  /** The ticks the rewind in progress covers, newest first. */
  rewindIdx: number[];
  label: TimelineLabel | null;
  matchActive: boolean;
}

/** One frame's engine signals. A missing number counts as 0 (depth: as 1). */
export interface TimelineInput {
  /** 'lockstep' is lockstep; anything else is rollback. */
  readonly mode?: string | undefined;
  readonly matchActive?: boolean | undefined;
  readonly rollbackEventsTotal?: number | undefined;
  readonly avgRollbackDepth?: number | undefined;
  readonly delay?: number | undefined;
}

/** A fresh instrument: head on the first tick, nothing marked, no match. */
export const createState = (opts?: { readonly trackTicks?: number } | null): TimelineState => {
  const trackTicks = opts?.trackTicks || 11;
  return {
    trackTicks,
    headIndex: 0,
    tickState: new Array<TimelineTick>(trackTicks).fill('idle'),
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

/**
 * A reported rollback depth as a number of ticks the ring can show: at least
 * 1, at most 4 (or trackTicks-2 when that is smaller, so a rewind on a short
 * track never wraps onto itself).
 */
export const clampDepth = (raw: number, trackTicks: number): number => {
  const d = Math.round(raw) || 1;
  const maxDepth = Math.max(1, Math.min(4, trackTicks - 2));
  return Math.max(1, Math.min(maxDepth, d));
};

const resetAnimation = (s: TimelineState): void => {
  s.phase = 'idle';
  s.phaseUntil = 0;
  s.tickState = new Array<TimelineTick>(s.trackTicks).fill('idle');
  s.label = null;
  s.rewindDepth = 0;
  s.rewindReplayed = 0;
  s.rewindIdx = [];
};

/**
 * The next state from this frame's engine signals. `now` is the caller's
 * clock (performance.now() on the page, a plain count of ms in tests), so
 * the function is deterministic and uses no timers. The state passed in is
 * left untouched.
 */
export const reduce = (state: TimelineState, input: TimelineInput, now: number): TimelineState => {
  const s: TimelineState = { ...state, tickState: state.tickState.slice(), rewindIdx: state.rewindIdx.slice() };
  const mode = input.mode === 'lockstep' ? 'lockstep' : 'rollback';

  if (mode !== s.mode) {
    s.mode = mode;
    resetAnimation(s);
  }

  const matchActive = !!input.matchActive;
  if (matchActive !== s.matchActive) {
    s.matchActive = matchActive;
    resetAnimation(s);
    // The count already shown is taken again at every match boundary, so a
    // new match does not replay a rewind for events counted before it
    // started (or during the previous match).
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
      const idx: number[] = [];
      for (let i = 0; i < depth; i++) {
        idx.push((((s.headIndex - i) % s.trackTicks) + s.trackTicks) % s.trackTicks);
      }
      for (const ix of idx) s.tickState[ix] = 'bad';
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
        for (const ix of s.rewindIdx) s.tickState[ix] = 'replay';
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
          for (const ix of s.rewindIdx) s.tickState[ix] = 'idle';
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

  // Lockstep predicts nothing, so it never rewinds: only a wait per tick
  // that grows with the real effective delay (frames).
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

/** A tick mark of the track, as far as the renderer uses it. */
interface TimelineTickElement {
  readonly classList: {
    readonly add: (...tokens: string[]) => void;
    readonly remove: (...tokens: string[]) => void;
    readonly toggle: (token: string, force?: boolean) => boolean | void;
  };
}

/** The playhead: moved with a transform. */
interface TimelineHeadElement {
  readonly style: { transform: string };
}

/** One of the two labels over the track: shown and hidden by opacity. */
interface TimelineLabelElement {
  readonly style: { opacity: string };
}

/** The sentence under the track. */
interface TimelineCaptionElement {
  textContent: string | null;
}

/**
 * The elements the renderer writes to: the tick marks in index order, the
 * playhead, the two labels and the caption. Any of them may be missing.
 */
export interface TimelineRefs {
  readonly ticks?: ReadonlyArray<TimelineTickElement | null | undefined> | null | undefined;
  readonly head?: TimelineHeadElement | null | undefined;
  readonly labelBad?: TimelineLabelElement | null | undefined;
  readonly labelReplay?: TimelineLabelElement | null | undefined;
  readonly caption?: TimelineCaptionElement | null | undefined;
}

/**
 * How to draw. `spacing` is the SVG's tick pitch (6 user units: ticks at
 * x=2+i*6, head resting at x=1+i*6). `still` draws the fixed frame for
 * prefers-reduced-motion instead of the state.
 */
export interface TimelineRenderOptions {
  readonly spacing?: number | undefined;
  readonly still?: boolean | undefined;
}

/** The sentence under the track for a state. */
export const timelineCaption = (state: TimelineState): string => {
  if (!state.matchActive) return 'Waiting for a match to start.';
  if (state.label?.kind === 'bad') return 'Wrong guess — the opponent did something else.';
  if (state.label?.kind === 'replay') return 'Rewinding and replaying from the last correct frame.';
  if (state.mode === 'lockstep') return 'Lockstep: waiting for the opponent’s input every frame.';
  return 'Rollback: running ahead, predicting the opponent.';
};

/** Draw a state (or the still frame) on the page's elements. */
export const render = (
  state: TimelineState,
  refs: TimelineRefs | null | undefined,
  opts?: TimelineRenderOptions | null,
): void => {
  if (!refs) return;
  const spacing = opts?.spacing || 6;
  if (opts?.still) {
    // The fixed frame for prefers-reduced-motion: the same picture as the
    // front page's still frame (a wrong guess part-way through its replay).
    refs.ticks?.forEach((el, i) => {
      if (!el) return;
      el.classList.remove('is-bad', 'is-replay');
      if (i === 6) el.classList.add('is-bad');
      else if (i === 4 || i === 5) el.classList.add('is-replay');
    });
    if (refs.head) refs.head.style.transform = `translateX(${3 * spacing}px)`;
    if (refs.labelBad) refs.labelBad.style.opacity = '1';
    if (refs.labelReplay) refs.labelReplay.style.opacity = '0';
    if (refs.caption)
      refs.caption.textContent = 'A wrong guess, a rewind, a replay. It happens all the time; you don’t see it.';
    return;
  }
  refs.ticks?.forEach((el, i) => {
    if (!el) return;
    const t = state.tickState[i] || 'idle';
    el.classList.toggle('is-bad', t === 'bad');
    el.classList.toggle('is-replay', t === 'replay');
  });
  if (refs.head) refs.head.style.transform = `translateX(${state.headIndex * spacing}px)`;
  if (refs.labelBad) refs.labelBad.style.opacity = state.label?.kind === 'bad' ? '1' : '0';
  if (refs.labelReplay) refs.labelReplay.style.opacity = state.label?.kind === 'replay' ? '1' : '0';
  if (refs.caption) refs.caption.textContent = timelineCaption(state);
};

/** What the demo page reads as `window.KNRollbackTimeline`. */
export const rollbackTimeline = { createState, reduce, clampDepth, render };

declare global {
  interface Window {
    KNRollbackTimeline?: typeof rollbackTimeline;
  }
}
