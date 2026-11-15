/**
 * The demo's recorded menu script and what surrounds it: the input each
 * player holds at a frame, when the autopilot has run out of time, the
 * random player 1 of `?randomP1=1`, and the shape of a recording. Moved from
 * web/static/demo.js unchanged in behaviour.
 *
 * These inputs go to the engine as the players' own, so a frame, a button or
 * a stick value that differs from the script changes where the menus end up.
 */

import type { RecordMode } from './options.ts';

/** One controller's input for a frame, as the engine reads it. */
export type PadInput = { buttons: number; lx: number; ly: number; cx: number; cy: number };

/** An input held from `frame` until the next entry. */
type Transition = readonly [frame: number, buttons: number, lx: number, ly: number, cx: number, cy: number];

/**
 * Player 2's way through the character select. To record it again: visit
 * `?record=p2`, play through the select as player 2, and keep only the
 * frames where the input changes.
 */
export const P2_TRANSITIONS: readonly Transition[] = [
  [591, 0, 83, 0, 0, 0],
  [600, 0, 83, -83, 0, 0],
  [620, 0, 83, 0, 0, 0],
  [636, 0, 0, 0, 0, 0],
  [654, 0, 0, -83, 0, 0],
  [659, 0, 0, 0, 0, 0],
  [682, 1, 0, 0, 0, 0],
  [687, 0, 0, 0, 0, 0],
];

/**
 * Player 1's way from the title screen into a match (`?record=1`). Every
 * button press is held at least 5 frames: the engine's tick timing can
 * narrow a press by a frame or two, and a 3-frame confirm on the character
 * grid was sometimes missed.
 */
export const P1_TRANSITIONS: readonly Transition[] = [
  [101, 0, 0, 0, 0, 0],
  [162, 8, 0, 0, 0, 0],
  [167, 0, 0, 0, 0, 0],
  [411, 8, 0, 0, 0, 0],
  [415, 0, 0, 0, 0, 0],
  [439, 0, 0, 83, 0, 0],
  [443, 0, 0, 0, 0, 0],
  [460, 1, 0, 0, 0, 0],
  [464, 0, 0, 0, 0, 0],
  [484, 1, 0, 0, 0, 0],
  [490, 0, 0, 0, 0, 0],
  [586, 0, 83, 0, 0, 0],
  [597, 0, 83, -83, 0, 0],
  [616, 0, 83, 0, 0, 0],
  [645, 0, 0, 0, 0, 0],
  [659, 0, 83, 0, 0, 0],
  [662, 0, 0, 0, 0, 0],
  [677, 1, 0, 0, 0, 0],
  [683, 0, 0, 0, 0, 0],
  [736, 8, 0, 0, 0, 0],
  [742, 0, 0, 0, 0, 0],
  [871, 0, -83, 0, 0, 0],
  [875, 0, 0, 0, 0, 0],
  [895, 0, 0, -83, 0, 0],
  [899, 0, 0, 0, 0, 0],
  [917, 1, 0, 0, 0, 0],
  [922, 0, 0, 0, 0, 0],
];

/** The input a script holds at `frame`: its last entry at or before it. Null before the first entry. */
const scriptedInput = (script: readonly Transition[], frame: number): PadInput | null => {
  let lo = 0;
  let hi = script.length - 1;
  let best: Transition | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = script[mid];
    if (entry !== undefined && entry[0] <= frame) {
      best = entry;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === null) return null;
  return { buttons: best[1], lx: best[2], ly: best[3], cx: best[4], cy: best[5] };
};

/** Player 1's scripted input at `frame`; null before the script starts. */
export const p1ScriptedInput = (frame: number): PadInput | null => scriptedInput(P1_TRANSITIONS, frame);

/** Player 2's scripted input at `frame`; null before the script starts. */
export const p2ScriptedInput = (frame: number): PadInput | null => scriptedInput(P2_TRANSITIONS, frame);

/** A controller with nothing pressed. */
export const zeroInput = (): PadInput => ({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

/** An input with every field as a whole number, as recordings and the fake peer take it. */
export const wholeInput = (input: PadInput): PadInput => ({
  buttons: input.buttons | 0,
  lx: input.lx | 0,
  ly: input.ly | 0,
  cx: input.cx | 0,
  cy: input.cy | 0,
});

/** One frame of a recording, in the short keys the downloaded file uses. */
export type RecordedFrame = { f: number; b: number; lx: number; ly: number; cx: number; cy: number };

/** The recording's entry for the input read at `frame`. */
export const recordedFrame = (frame: number, input: PadInput): RecordedFrame => ({
  f: frame,
  b: input.buttons | 0,
  lx: input.lx | 0,
  ly: input.ly | 0,
  cx: input.cx | 0,
  cy: input.cy | 0,
});

/**
 * The downloaded recording's file name: player 2's own for `p2`, player 1's
 * for any other recording (`true` is one started from the console).
 */
export const recordingFileName = (recordMode: RecordMode | true): string =>
  recordMode === 'p2' ? 'kn-demo-autopilot-p2.json' : 'kn-demo-autopilot.json';

/** The battle load and the 3-2-1 countdown after the last scripted press: about 10 s at 60 fps. */
const SCRIPT_GRACE_FRAMES = 600;

/**
 * The frame by which the recorded script must have reached a battle. The
 * script is keyed to frames with no feedback from the game, so one press a
 * frame outside its menu window leaves the game on a menu for good.
 */
export const SCRIPT_DEADLINE_FRAME =
  Math.max(P1_TRANSITIONS[P1_TRANSITIONS.length - 1]?.[0] ?? 0, P2_TRANSITIONS[P2_TRANSITIONS.length - 1]?.[0] ?? 0) +
  SCRIPT_GRACE_FRAMES;

/**
 * The same deadline for the closed-loop autopilot, which presses again when
 * a press is dropped and so has no script end to measure from: a minute of
 * frames.
 */
export const CLOSED_LOOP_DEADLINE_FRAME = 3600;

/** The scene number of a VS battle. */
export const BATTLE_SCENE = 22;

/** Where the autopilot stands when the page checks on it. */
export type AutopilotCheck = {
  readonly frame: number;
  /** The game's scene; undefined until the engine can read it. */
  readonly scene: number | undefined;
  /** The closed-loop autopilot is driving, not the recorded script. */
  readonly closedLoop: boolean;
  /** Why the closed-loop autopilot gave up; null or empty while it has not. */
  readonly pilotFailure: string | null;
};

/**
 * The autopilot has failed to reach a match: it said so itself, or its
 * deadline passed with the game not in a battle.
 */
export const autopilotStalled = (check: AutopilotCheck): boolean => {
  if (check.pilotFailure) return true;
  const deadline = check.closedLoop ? CLOSED_LOOP_DEADLINE_FRAME : SCRIPT_DEADLINE_FRAME;
  return !(check.frame < deadline || check.scene === BATTLE_SCENE);
};

/** The console line for a stalled autopilot. */
export const stallLogLine = (
  check: AutopilotCheck,
  status: number | undefined,
  delay: number | null | undefined,
): string =>
  `[demo] AUTOPILOT-STALL frame=${check.frame} scene=${String(check.scene)} status=${String(status)} ` +
  `delay=${delay ?? '?'} mode=${check.closedLoop ? 'closed-loop' : 'script'}` +
  (check.pilotFailure ? ` failure=${check.pilotFailure}` : '') +
  ' — match not reached';

/** The buttons the random player 1 presses, as bit numbers. */
const RANDOM_P1_BUTTON_BITS = [0, 1, 4, 5, 6, 7, 11, 12];

/** A stick pushed 35 % to 100 % of the way (never under 18) in either direction. */
const randomAxis = (random: () => number, stickMax: number): number => {
  const mag = Math.max(18, Math.round((0.35 + random() * 0.65) * stickMax));
  return random() < 0.5 ? -mag : mag;
};

/**
 * One random input for player 1: a single button about two times in three,
 * otherwise the main stick or the C stick. `random` is `Math.random`, drawn
 * from in a fixed order; `stickMax` is the stick's full deflection.
 */
export const randomP1Input = (random: () => number, stickMax: number): PadInput => {
  if (random() < 0.65) {
    const bit = RANDOM_P1_BUTTON_BITS[Math.floor(random() * RANDOM_P1_BUTTON_BITS.length)] ?? 0;
    return { buttons: 1 << bit, lx: 0, ly: 0, cx: 0, cy: 0 };
  }
  if (random() < 0.5) {
    const lx = randomAxis(random, stickMax);
    return { buttons: 0, lx, ly: randomAxis(random, stickMax), cx: 0, cy: 0 };
  }
  const cx = randomAxis(random, stickMax);
  return { buttons: 0, lx: 0, ly: 0, cx, cy: randomAxis(random, stickMax) };
};

/**
 * The frame until which a random input drawn at `frame` is held: 30 to 89
 * frames, the fake peer's own hold, so wrong predictions come at the pace of
 * a person's inputs.
 */
export const randomP1HoldUntil = (frame: number, random: () => number): number =>
  frame + 30 + Math.floor(random() * 60);
