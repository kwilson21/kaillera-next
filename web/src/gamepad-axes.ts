/**
 * The arithmetic between a gamepad's raw axis values and the N64 stick
 * values that are recorded and sent: polarity, rest position, range,
 * dead zone, sensitivity curve and the N64 maximum.
 *
 * web/src/page/gamepad-manager.ts reads the pads, the profiles and the
 * player's settings; these functions are given the numbers. What they return
 * for the left stick is what every peer applies, so the same raw value must
 * always give the same result.
 */

/** One stick axis of a profile: the pad axis it reads and what each end means. */
export interface StickAxisConfig {
  index: number;
  /** [bit for a positive value, bit for a negative value]; see `axisSign`. */
  bits?: readonly number[] | null | undefined;
}

/** A pad axis that acts as two buttons (the C buttons): the mask each end presses. */
export interface AxisButtonConfig {
  pos: number;
  neg: number;
}

/**
 * The parts of a gamepad profile that say how its axes are read. A part may
 * be null: a saved profile is JSON, which writes null for a missing number.
 */
export interface AxisProfile {
  axes?:
    | { stickX?: StickAxisConfig | null | undefined; stickY?: StickAxisConfig | null | undefined }
    | null
    | undefined;
  axisButtons?: Readonly<Record<string, AxisButtonConfig>> | null | undefined;
  /** The raw value of full deflection, for pads that top out below 1. */
  axisRange?: number | null | undefined;
}

/** An N64 stick axis: the left stick or the C stick, x or y. */
export type AxisName = 'lx' | 'ly' | 'cx' | 'cy';

/**
 * The largest N64 stick value for an analog range setting (a percentage of
 * the stick's hardware maximum of 127; the default 66 gives 83).
 */
export function n64StickMax(rangePercent: number): number {
  return Math.floor(127 * (rangePercent / 100));
}

/**
 * A stick axis in [-1, 1] as an N64 value: 0 inside the dead zone, then the
 * rest of the travel scaled to the N64 maximum, through the sensitivity
 * curve unless sensitivity is exactly 1.
 */
export function analogScale(value: number, deadzone: number, rangePercent: number, sensitivity: number): number {
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  if (abs < deadzone) return 0;
  const n64Max = n64StickMax(rangePercent);
  const scaled = (abs - deadzone) / (1 - deadzone);
  const curved = sensitivity === 1.0 ? scaled : Math.pow(scaled, 1 / sensitivity);
  return sign * Math.min(Math.round(curved * n64Max), n64Max);
}

/** A stick axis as an on/off N64 value (the C buttons): 0 or the N64 maximum with the axis's sign. */
export function digitalSnap(value: number, deadzone: number, rangePercent: number): number {
  const abs = Math.abs(value);
  if (abs < deadzone) return 0;
  return Math.sign(value) * n64StickMax(rangePercent);
}

const C_X_MASK = (1 << 20) | (1 << 21);
const C_Y_MASK = (1 << 22) | (1 << 23);

/**
 * 1 if a positive value on the pad's axis for `name` means what the Standard
 * layout says it means (+X right, +Y down), -1 if it means the opposite.
 *
 * A profile records what each end of an axis means: `axes.stickX/stickY.bits`
 * as [positive, negative] for the left stick, and `axisButtons` pos/neg masks
 * for the C stick (the remap wizard writes both). Missing data keeps Standard
 * polarity. For the C stick the entry used is the last one that touches the
 * axis's two bits, the same one the pad is read from.
 */
export function axisSign(profile: AxisProfile, name: AxisName): 1 | -1 {
  if (name === 'lx' || name === 'ly') {
    const bits = profile.axes?.[name === 'lx' ? 'stickX' : 'stickY']?.bits;
    // Standard: right 16 / left 17, down 18 / up 19.
    const stdPosBit = name === 'lx' ? 16 : 18;
    const stdNegBit = name === 'lx' ? 17 : 19;
    return bits?.[0] === stdNegBit || bits?.[1] === stdPosBit ? -1 : 1;
  }
  const mask = name === 'cx' ? C_X_MASK : C_Y_MASK;
  // Standard: C-Right 21, C-Down 22.
  const stdPosBit = name === 'cx' ? 1 << 21 : 1 << 22;
  let config: AxisButtonConfig | undefined;
  for (const c of Object.values(profile.axisButtons ?? {})) {
    if (c.pos & mask || c.neg & mask) config = c;
  }
  if (config && !(config.pos & stdPosBit) && (config.pos !== 0 || config.neg & stdPosBit)) return -1;
  return 1;
}

/**
 * A raw axis value as a Standard-polarity value in [-1, 1]: the rest
 * position is subtracted, the pad's full-deflection value divided out, the
 * result clamped and given the profile's polarity.
 */
export function normalizeAxis(raw: number, center: number, sign: number, range: number): number {
  return sign * Math.max(-1, Math.min(1, (raw - center) / range));
}

/**
 * A readable name for a gamepad id: without Chrome's trailing
 * "(STANDARD GAMEPAD Vendor: … Product: …)" and Firefox's leading
 * "045e-0b13-" vendor/product prefix. The id itself if nothing is left.
 */
export function gamepadDisplayName(id: string): string {
  const name = id
    .replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '')
    .replace(/\s*\((?:XInput )?(?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/, '')
    .trim();
  return name || id;
}
