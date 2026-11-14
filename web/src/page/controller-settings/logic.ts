/**
 * The controller settings panel's decisions: how a saved key map is read,
 * what a captured key, button or stick does to the saved mapping, what a
 * slider position means, and the words and numbers the panel shows. Moved
 * from web/static/controller-settings.js.
 *
 * Nothing here touches the page, storage or a gamepad: panel.ts reads those
 * and hands over the values. What these functions return is what gets saved,
 * and the engine reads the saved values back, so each one is held to the
 * script it replaced in tests/ts/page-controller-settings.test.ts.
 */
import { Option, Schema } from 'effect';
import type { GamepadProfile } from '../../gamepad-profile.ts';

// ── keyboard ────────────────────────────────────────────────────────────────

/** localStorage key of the saved keyboard mapping (JSON: key code to N64 input bit). */
export const KEYBOARD_MAP_KEY = 'keyboard-mapping';

/**
 * A keyboard mapping as the panel holds it: key code to N64 input bit. The
 * value is whatever was saved for the key. The engine reads the same saved
 * text (web/static/shared.js) without checking the values either, so the
 * panel shows and rewrites exactly what the engine is using.
 */
export type KeyMap = Schema.JsonObject;

/**
 * Saved text the panel takes as a key map: a JSON object, and also a JSON
 * array or string, whose positions the old script read as key codes. A
 * number, a boolean, null or text that is not JSON is not a mapping.
 */
const SavedKeyMap = Schema.fromJsonString(Schema.Union([Schema.JsonObject, Schema.Array(Schema.Json), Schema.String]));
const decodeSavedKeyMap = Schema.decodeUnknownOption(SavedKeyMap);

/**
 * The key map in the saved text, or null when nothing usable is saved
 * (nothing, unreadable text, or a mapping with no entries) and the default
 * keys apply. Keys are read with `parseInt`, as the engine reads them:
 * "12abc" is key 12, and a key that is not a number at all becomes the one
 * key "NaN".
 */
export const savedKeyboardMap = (saved: string | null): KeyMap | null => {
  const entries = Option.match(decodeSavedKeyMap(saved), {
    onNone: () => [],
    onSome: (stored) => Object.entries(stored),
  });
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.map(([key, bit]) => [parseInt(key, 10), bit]));
};

/** The map turned round: N64 input bit to the key code that drives it (the last one, when two do). */
export const invertKeyMap = (map: KeyMap): { readonly [bit: string]: number } =>
  Object.fromEntries(Object.entries(map).map(([keyCode, bit]) => [String(bit), parseInt(keyCode, 10)]));

/**
 * The map after `keyCode` is bound to `bit`: the key leaves whatever it drove
 * before, and the bit loses the keys that drove it.
 */
export const keyMapWithKey = (map: KeyMap, keyCode: number, bit: number): KeyMap =>
  Object.fromEntries([
    ...Object.entries(map).filter(([key, value]) => parseInt(key, 10) !== keyCode && value !== bit),
    [keyCode, bit],
  ]);

const KEY_NAMES: ReadonlyMap<number, string> = new Map([
  [8, 'Bksp'],
  [9, 'Tab'],
  [13, 'Enter'],
  [16, 'Shift'],
  [17, 'Ctrl'],
  [18, 'Alt'],
  [20, 'Caps'],
  [27, 'Esc'],
  [32, 'Space'],
  [37, '←'],
  [38, '↑'],
  [39, '→'],
  [40, '↓'],
  [46, 'Del'],
  [91, 'Meta'],
  [186, ';'],
  [187, '='],
  [188, ','],
  [189, '-'],
  [190, '.'],
  [191, '/'],
  [192, '`'],
  [219, '['],
  [220, '\\'],
  [221, ']'],
  [222, "'"],
]);

/** What a key code is called in the mapping grid; '?' for one with no name. */
export const keyName = (code: number): string => {
  const named = KEY_NAMES.get(code);
  if (named !== undefined) return named;
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 48 && code <= 57) return String(code - 48);
  if (code >= 96 && code <= 105) return 'Num' + (code - 96);
  if (code >= 112 && code <= 123) return 'F' + (code - 111);
  return '?';
};

// ── the N64 controller ──────────────────────────────────────────────────────

/** A row of the mapping grid: an N64 input, the bit it drives, and the group it is listed under. */
export type N64Button = {
  readonly label: string;
  readonly bit: number;
  readonly group: 'face' | 'dpad' | 'stick' | 'cbutton';
};

/** The grid's rows, in order. The bits and their order are the remap wizard's (play/remap-wizard.ts). */
export const N64_BUTTONS: readonly N64Button[] = [
  { label: 'A', bit: 0, group: 'face' },
  { label: 'B', bit: 1, group: 'face' },
  { label: 'Start', bit: 3, group: 'face' },
  { label: 'Z', bit: 12, group: 'face' },
  { label: 'L', bit: 10, group: 'face' },
  { label: 'R', bit: 11, group: 'face' },
  { label: 'D-Up', bit: 4, group: 'dpad' },
  { label: 'D-Down', bit: 5, group: 'dpad' },
  { label: 'D-Left', bit: 6, group: 'dpad' },
  { label: 'D-Right', bit: 7, group: 'dpad' },
  { label: 'Stick Up', bit: 19, group: 'stick' },
  { label: 'Stick Down', bit: 18, group: 'stick' },
  { label: 'Stick Left', bit: 17, group: 'stick' },
  { label: 'Stick Right', bit: 16, group: 'stick' },
  { label: 'C-Up', bit: 23, group: 'cbutton' },
  { label: 'C-Down', bit: 22, group: 'cbutton' },
  { label: 'C-Left', bit: 20, group: 'cbutton' },
  { label: 'C-Right', bit: 21, group: 'cbutton' },
];

/** The heading over a group of rows. The face buttons come first and have none. */
export const groupLabel = (group: N64Button['group']): string => {
  if (group === 'dpad') return 'D-Pad';
  if (group === 'stick') return 'Analog Stick';
  if (group === 'cbutton') return 'C-Buttons';
  return group;
};

/** The bit is one of the four stick directions (16 to 19). */
export const isStickBit = (bit: number): boolean => bit >= 16 && bit <= 19;

/** The bit is one of the four C buttons (20 to 23). */
export const isCButtonBit = (bit: number): boolean => bit >= 20 && bit <= 23;

/** What a cell says while it waits for the player to press something. */
export const listeningText = (type: 'gamepad' | 'keyboard', bit: number): string => {
  if (type === 'keyboard') return 'Press a key...';
  return bit >= 16 && bit <= 23 ? 'Button or stick...' : 'Press a button...';
};

// ── gamepad profile ─────────────────────────────────────────────────────────

/**
 * What drives `bit` on the pad, as the grid names it: a button, an axis that
 * acts as buttons, or a stick axis, looked for in that order. '—' when
 * nothing does or no pad is connected.
 */
export const gamepadBindingName = (bit: number, profile: GamepadProfile | null): string => {
  if (!profile) return '—';
  for (const [button, mask] of Object.entries(profile.buttons)) {
    if (mask === 1 << bit) return `Btn ${button}`;
  }
  if (profile.axisButtons) {
    for (const [axis, masks] of Object.entries(profile.axisButtons)) {
      if (masks.pos & (1 << bit)) return `Axis${axis}+`;
      if (masks.neg & (1 << bit)) return `Axis${axis}-`;
    }
  }
  if (profile.axes) {
    for (const stick of Object.values(profile.axes)) {
      if (!stick) continue;
      if (stick.bits?.[0] === bit) return `Axis${stick.index}+`;
      if (stick.bits?.[1] === bit) return `Axis${stick.index}-`;
    }
  }
  return '—';
};

/** What the player did on the pad while a cell was listening. */
export type Captured =
  | { readonly kind: 'button'; readonly index: number }
  | { readonly kind: 'axis'; readonly index: number; readonly positive: boolean };

/**
 * The input a pad reading binds to `bit`, or null when nothing counts yet.
 * The lowest pressed button wins. An axis counts only for a stick direction
 * or a C button, and only when it is pushed past half way and has moved more
 * than 0.3 from where it was when the cell started listening, so a stick
 * already held does not bind at once. `baseline` is those starting values;
 * an axis without one started at 0.
 */
export const capturedInput = (
  bit: number,
  buttons: readonly { readonly pressed: boolean }[],
  axes: readonly number[],
  baseline: readonly number[],
): Captured | null => {
  const button = buttons.findIndex((b) => b.pressed);
  if (button >= 0) return { kind: 'button', index: button };
  if (!isStickBit(bit) && !isCButtonBit(bit)) return null;
  for (const [index, value] of axes.entries()) {
    const base = baseline[index] ?? 0;
    if (Math.abs(value) > 0.5 && Math.abs(value - base) > 0.3) return { kind: 'axis', index, positive: value > 0 };
  }
  return null;
};

type AxisButtons = NonNullable<GamepadProfile['axisButtons']>;
type AxisButton = AxisButtons[string];

/** The axis-button table with `bit` taken out of every entry; an entry left pressing nothing goes. */
const axisButtonsWithout = (axisButtons: AxisButtons, bit: number): AxisButtons =>
  Object.fromEntries(
    Object.entries(axisButtons).flatMap(([axis, masks]): (readonly [string, AxisButton])[] => {
      const pos = masks.pos & ~(1 << bit);
      const neg = masks.neg & ~(1 << bit);
      return pos === 0 && neg === 0 ? [] : [[axis, { ...masks, pos, neg }]];
    }),
  );

/** The pad buttons without any that pressed exactly `bit`. */
const buttonsWithout = (buttons: GamepadProfile['buttons'], bit: number): GamepadProfile['buttons'] =>
  Object.fromEntries(Object.entries(buttons).filter(([, mask]) => mask !== 1 << bit));

/**
 * The profile to save after the player bound `captured` to `bit`. The bit's
 * old button goes in every case. A button also takes the bit away from the
 * stick axis or C-button axis that drove it. A stick axis becomes that end
 * of its stick (X for bits 16 and 17, Y for 18 and 19), the other end keeping
 * what it had, or the standard bit when it had nothing. A C-button axis gets
 * the bit on the pushed end, and no other axis keeps it.
 */
export const profileAfterCapture = (profile: GamepadProfile, bit: number, captured: Captured): GamepadProfile => {
  const buttons = buttonsWithout(profile.buttons, bit);
  if (captured.kind === 'button') {
    const bound = { ...profile, buttons: { ...buttons, [captured.index]: 1 << bit } };
    if (isStickBit(bit) && profile.axes) {
      const axes = Object.fromEntries(
        Object.entries(profile.axes).filter(([, stick]) => stick?.bits?.[0] !== bit && stick?.bits?.[1] !== bit),
      );
      return { ...bound, axes };
    }
    if (isCButtonBit(bit) && profile.axisButtons) {
      return { ...bound, axisButtons: axisButtonsWithout(profile.axisButtons, bit) };
    }
    return bound;
  }
  if (isStickBit(bit)) {
    const group = bit === 16 || bit === 17 ? 'stickX' : 'stickY';
    const standard: readonly [number, number] = group === 'stickX' ? [16, 17] : [18, 19];
    const had = profile.axes?.[group]?.bits;
    const bits = captured.positive ? [bit, had?.[1] ?? standard[1]] : [had?.[0] ?? standard[0], bit];
    return { ...profile, buttons, axes: { ...profile.axes, [group]: { index: captured.index, bits } } };
  }
  const cleared = axisButtonsWithout(profile.axisButtons ?? {}, bit);
  const masks = cleared[captured.index] ?? { pos: 0, neg: 0 };
  const pressed = captured.positive
    ? { ...masks, pos: masks.pos | (1 << bit) }
    : { ...masks, neg: masks.neg | (1 << bit) };
  return { ...profile, buttons, axisButtons: { ...cleared, [captured.index]: pressed } };
};

/** The pad axis index of each C-stick direction. */
export type CStickAxes = { readonly cx: number; readonly cy: number };

const C_X_MASK = (1 << 20) | (1 << 21);
const C_Y_MASK = (1 << 22) | (1 << 23);

/**
 * The pad axes the preview reads the C stick from: for each direction the
 * last axis whose buttons include a C button of that direction, or axes 2
 * and 3 when the profile names none.
 */
export const cStickAxes = (axisButtons: GamepadProfile['axisButtons']): CStickAxes => {
  let cx = -1;
  let cy = -1;
  if (axisButtons) {
    for (const [axis, masks] of Object.entries(axisButtons)) {
      const index = parseInt(axis, 10);
      if (masks.pos & C_X_MASK || masks.neg & C_X_MASK) cx = index;
      if (masks.pos & C_Y_MASK || masks.neg & C_Y_MASK) cy = index;
    }
  }
  return { cx: cx < 0 ? 2 : cx, cy: cy < 0 ? 3 : cy };
};

// ── analog settings ─────────────────────────────────────────────────────────

/** The settings GamepadManager saves for the panel, by storage key. */
export const RANGE_KEY = 'kn-analog-range';
export const SENSITIVITY_KEY = 'kn-analog-sensitivity';

/** The dead-zone settings: left stick x and y, then C stick x and y. */
export type DeadzoneKey = 'kn-deadzone-lx' | 'kn-deadzone-ly' | 'kn-deadzone-cx' | 'kn-deadzone-cy';

/** Every analog setting, in the order Reset removes them. */
const ANALOG_KEYS = [
  RANGE_KEY,
  SENSITIVITY_KEY,
  'kn-deadzone-lx',
  'kn-deadzone-ly',
  'kn-deadzone-cx',
  'kn-deadzone-cy',
] as const;

/** The key a setting is saved under for one game only. */
export const gameSettingKey = (romHash: string, key: string): string => `kn-gamepad:${romHash}:${key}`;

/**
 * The storage keys Reset removes, in order: every analog setting, each with
 * its per-game twin when a game is loaded, then the keyboard mapping.
 */
export const resetStorageKeys = (romHash: string | null | undefined): readonly string[] => [
  ...ANALOG_KEYS.flatMap((key) => (romHash ? [key, gameSettingKey(romHash, key)] : [key])),
  KEYBOARD_MAP_KEY,
];

/** Where a changed setting is saved: for this game only when the box is ticked. */
export const settingScope = (perGame: boolean | undefined): 'game' | 'global' => (perGame ? 'game' : 'global');

/** The range slider's position as the saved range, a percentage. */
export const rangeFromSlider = (position: string): number => parseInt(position, 10);

/** The range as the panel shows it. */
export const rangeText = (range: number): string => `${range}%`;

/** A slider position in hundredths as the saved value: sensitivity (50 to 200) and dead zone (0 to 50). */
export const hundredthsFromSlider = (position: string): number => parseInt(position, 10) / 100;

/** The slider position, in hundredths, for a saved sensitivity or dead zone. */
export const sliderHundredths = (value: number): string => String(Math.round(value * 100));

/** The sensitivity as the panel shows it. */
export const sensitivityText = (sensitivity: number): string => `${sensitivity.toFixed(1)}×`;

/** A dead zone as the panel shows it. */
export const deadzoneText = (deadzone: number): string => deadzone.toFixed(2);

// ── what the panel shows ────────────────────────────────────────────────────

/** The line under the title: the pad in use and its profile, cut to fit. */
export const padStatusText = (displayName: string, profileName: string): string =>
  `${displayName.substring(0, 36)} (${profileName})`;

/** The radius of a dead-zone ring in a stick drawing of radius `full`; never smaller than 2. */
export const deadzoneRingRadius = (full: number, deadzone: number): number => Math.max(Math.round(full * deadzone), 2);

/** The radius of the left stick's range ring. */
export const rangeRingRadius = (range: number): number => Math.round(56 * (range / 100));

/** A stick value in [-1, 1] as the preview prints it: a percentage in a fixed width. */
export const percentText = (value: number): string =>
  `${value < 0 ? '' : ' '}${String(Math.round(value * 100)).padStart(3)}%`;
