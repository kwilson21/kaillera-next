/**
 * The on-screen analog stick: from where a thumb is to the four stick values
 * the engines read. Moved from web/static/virtual-gamepad.js.
 *
 * These values go into `KNState.touchInput` at the stick's input indices and
 * from there into the input every peer applies, so the same touch must always
 * give the same four integers: the order of the arithmetic below is the old
 * script's, operation for operation.
 */

/** How far the knob travels from its origin, in CSS pixels. Full deflection. */
export const STICK_RADIUS = 50;
/** The value of full deflection on one axis. */
export const MAX_AXIS = 32767;
/** 12% of travel ignored (mimics N64 mechanical deadzone). */
export const DEADZONE = 0.12;
/** >1 = softer near center, steeper near edge (N64-like curve). */
export const EDGE_EXPONENT = 1.3;

/** The stick's input indices: one per direction, each 0 or a positive magnitude. */
export const STICK_RIGHT = 16;
export const STICK_LEFT = 17;
export const STICK_DOWN = 18;
export const STICK_UP = 19;

/** A point in the viewport, in CSS pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** An element's box in the viewport, as `getBoundingClientRect` gives it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** What one position of the thumb means: where the knob is drawn and the four values. */
export interface StickReading {
  /** The knob's offset from the stick's origin, never longer than `STICK_RADIUS`. */
  readonly knobX: number;
  readonly knobY: number;
  /** The values for `STICK_RIGHT`, `STICK_LEFT`, `STICK_DOWN`, `STICK_UP`; at most one of each pair is not 0. */
  readonly right: number;
  readonly left: number;
  readonly down: number;
  readonly up: number;
}

/**
 * Where the stick's origin goes when a thumb lands in the zone. Floating
 * center: wherever the thumb lands becomes the origin, kept a margin in from
 * the zone's edges. The margin is half the zone's width less `STICK_RADIUS`
 * (14px for a 128px zone), so a thumb that lands near the edge can push the
 * knob's full travel past the zone on that side; a zone narrower than twice
 * the radius has a margin below zero.
 */
export const stickOrigin = (zone: Box, touchX: number, touchY: number): Point => {
  const margin = zone.width / 2 - STICK_RADIUS;
  return {
    x: Math.max(zone.left + margin, Math.min(zone.right - margin, touchX)),
    y: Math.max(zone.top + margin, Math.min(zone.bottom - margin, touchY)),
  };
};

/** The origin's offset from the middle of the zone: where the knob is drawn on contact. */
export const originOffset = (zone: Box, origin: Point): Point => {
  const cx = zone.left + zone.width / 2;
  const cy = zone.top + zone.height / 2;
  return { x: origin.x - cx, y: origin.y - cy };
};

/** The knob's inline transform for an offset from its resting place. */
export const knobTransform = (dx: number, dy: number): string =>
  `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

/** The knob's inline transform after the thumb lifts. */
export const KNOB_AT_REST = 'translate(-50%, -50%)';

/**
 * The stick values for a thumb at (`clientX`, `clientY`) with the stick's
 * origin at `origin`. The distance is clamped to `STICK_RADIUS`; inside the
 * dead zone every value is 0; beyond it the remaining travel is put through
 * the response curve and scaled to `MAX_AXIS`, each axis rounded to the
 * nearest integer.
 */
export const stickReading = (origin: Point, clientX: number, clientY: number): StickReading => {
  let dx = clientX - origin.x;
  let dy = clientY - origin.y;
  const rawDist = Math.sqrt(dx * dx + dy * dy);
  const clampedDist = Math.min(rawDist, STICK_RADIUS);
  if (rawDist > STICK_RADIUS) {
    dx = (dx / rawDist) * STICK_RADIUS;
    dy = (dy / rawDist) * STICK_RADIUS;
  }
  // N64-style analog: deadzone + non-linear response curve.
  // Normalized magnitude 0–1, then apply deadzone and power curve.
  const mag = clampedDist / STICK_RADIUS;
  let output = 0;
  if (mag > DEADZONE) {
    // Remap deadzone–1 range to 0–1, then apply power curve
    const remapped = (mag - DEADZONE) / (1 - DEADZONE);
    output = Math.pow(remapped, EDGE_EXPONENT);
  }
  // Convert back to directional axis values
  if (clampedDist > 0.001) {
    const ax = (dx / clampedDist) * output * MAX_AXIS;
    const ay = (dy / clampedDist) * output * MAX_AXIS;
    return {
      knobX: dx,
      knobY: dy,
      right: ax > 0 ? Math.round(ax) : 0,
      left: ax < 0 ? Math.round(-ax) : 0,
      down: ay > 0 ? Math.round(ay) : 0,
      up: ay < 0 ? Math.round(-ay) : 0,
    };
  }
  return { knobX: dx, knobY: dy, right: 0, left: 0, down: 0, up: 0 };
};
