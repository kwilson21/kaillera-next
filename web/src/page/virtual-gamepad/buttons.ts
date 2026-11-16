/**
 * The on-screen buttons: which input index each one presses, which button a
 * touch is on, and what a sliding finger presses and lets go. Moved from
 * web/static/virtual-gamepad.js.
 *
 * What these decide is written to `KNState.touchInput` (1 pressed, 0 not) at
 * the button's input index and read by the engines every frame.
 */
import type { Box } from './stick.ts';

/** One button: the input index it presses, the text on it and its class. */
export type ButtonSpec = readonly [index: number, label: string, className: string];

/**
 * N64 button mapping (verified from mupen64plus core source):
 * N64 A = JOYPAD_B = index 0, N64 B = JOYPAD_Y = index 1
 * Z = JOYPAD_L2 = index 12, L = JOYPAD_L = index 10, R = JOYPAD_R = index 11
 *
 * The order is the order the buttons are created in, which is also the order
 * a touch is tested against them.
 */
export const BUTTONS: readonly ButtonSpec[] = [
  [0, 'A', 'vgp-a'],
  [1, 'B', 'vgp-b'],
  [3, 'Start', 'vgp-start'],
  [10, 'L', 'vgp-l'],
  [11, 'R', 'vgp-r'],
  [12, 'Z', 'vgp-z'],
  [4, '▲', 'vgp-du'],
  [5, '▼', 'vgp-dd'],
  [6, '◀︎', 'vgp-dl'],
  [7, '▶︎', 'vgp-dr'],
  [23, 'CU', 'vgp-cu'],
  [22, 'CD', 'vgp-cd'],
  [21, 'CL', 'vgp-cl'],
  [20, 'CR', 'vgp-cr'],
];

/** Where in the controls a button is put. */
export type ButtonPlace = 'shoulders' | 'z' | 'start' | 'dpad' | 'ab' | 'cbuttons' | 'none';

/**
 * The group a button belongs to, from its class. Z and Start are each put in
 * twice (a portrait place and a landscape place; the stylesheet shows one).
 */
export const buttonPlace = (className: string): ButtonPlace => {
  if (className === 'vgp-l' || className === 'vgp-r') return 'shoulders';
  if (className === 'vgp-z') return 'z';
  if (className === 'vgp-start') return 'start';
  if (className.startsWith('vgp-d')) return 'dpad';
  if (className === 'vgp-a' || className === 'vgp-b') return 'ab';
  if (className.startsWith('vgp-c')) return 'cbuttons';
  return 'none';
};

/**
 * Slop for slide-to-press: a thumb has area, not a point, so during a slide
 * neighbors register while the finger straddles the seam (e.g. A→Z). 8px is
 * enough to bridge typical button gaps without bleeding across the C-cluster.
 */
export const SLOP_PX = 8;

/** A button's corner radius in pixels from its computed style; 0 when the style has none. */
export const cornerRadius = (borderTopLeftRadius: string): number => parseFloat(borderTopLeftRadius) || 0;

/** The input index a button carries in `data-idx`; undefined when it carries none. */
export const buttonIndex = (dataIdx: string | undefined): number | undefined =>
  dataIdx === undefined ? undefined : parseInt(dataIdx, 10);

/**
 * Whether a point is on a button's actual visual outline. Round buttons
 * (corner radius ≥ 50% of the shorter side, less 2px) use ellipse math;
 * everything else uses the rectangular bounding box. A button with no size
 * (the copy the stylesheet hides) is never hit.
 */
export const pointOnButton = (box: Box, radius: number, x: number, y: number): boolean => {
  if (box.width === 0 || box.height === 0) return false;
  if (radius >= Math.min(box.width, box.height) / 2 - 2) {
    // Circular / elliptical
    const dx = x - (box.left + box.width / 2);
    const dy = y - (box.top + box.height / 2);
    return (dx * dx) / (box.width / 2) ** 2 + (dy * dy) / (box.height / 2) ** 2 <= 1;
  }
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
};

/** `pointOnButton` with the button grown by `slop` pixels on every side. */
export const pointNearButton = (box: Box, radius: number, x: number, y: number, slop: number): boolean => {
  if (box.width === 0 || box.height === 0) return false;
  if (radius >= Math.min(box.width, box.height) / 2 - 2) {
    const rx = box.width / 2 + slop;
    const ry = box.height / 2 + slop;
    const dx = x - (box.left + box.width / 2);
    const dy = y - (box.top + box.height / 2);
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  }
  return x >= box.left - slop && x <= box.right + slop && y >= box.top - slop && y <= box.bottom + slop;
};

/** What a finger's move changes: the input indices to let go, then the ones to press. */
export interface SlideChange {
  readonly released: readonly number[];
  readonly pressed: readonly number[];
}

/**
 * A finger that was on `held` is now on `under`: it lets go of what it slid
 * off and presses what it slid onto. A button under another finger as well is
 * still let go here; each finger is kept on its own.
 */
export const slideChange = (held: ReadonlySet<number>, under: ReadonlySet<number>): SlideChange => ({
  released: [...held].filter((index) => !under.has(index)),
  pressed: [...under].filter((index) => !held.has(index)),
});
