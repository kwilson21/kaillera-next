/**
 * `window.GamepadManager`: profile-based gamepad detection, mapping and slot
 * assignment. Both netplay engines, the lobby and the controller settings
 * panel read pads through it.
 *
 * Profile format:
 *   name:        display name
 *   match(id):   returns true if this profile handles gamepad.id
 *   buttons:     { gamepadButtonIndex: ejsBitmask }
 *   axes:        { name: { index, bits: [posBit, negBit] } }  -- analog directions
 *   axisButtons: { axisIndex: { pos: ejsBitmask, neg: ejsBitmask } }  -- axis-to-digital
 *   axisRange:   raw axis value that means full deflection (optional, default 1)
 *   axisCenter:  'auto' = sample the resting position of the stick axes once per connection and
 *                subtract it (optional)
 *   deadzone:    threshold for axis activation
 *
 * posBit / pos record the direction a positive axis value means (Standard: right, down);
 * a pad whose +Y is up lists the Up bit first. See axisTransform().
 *
 * The axis arithmetic is in ../gamepad-axes.ts and the decoding of a saved
 * profile in ../gamepad-profile.ts. This module reads the pads, the profiles
 * and the player's settings.
 */
import {
  analogScale,
  axisSign,
  digitalSnap,
  gamepadDisplayName,
  n64StickMax,
  normalizeAxis,
  type AxisName,
  type AxisProfile,
} from '../gamepad-axes.ts';
import { decodeGamepadProfile } from '../gamepad-profile.ts';
import type { PageState } from '../kn-state.ts';

/** A gamepad profile: built in, or as the player saved it. */
export interface PadProfile extends AxisProfile {
  name?: string | null | undefined;
  match?: (id: string, mapping?: string) => boolean;
  /** Pad button index to N64 button mask. */
  buttons: Readonly<Record<string, number>>;
  axisCenter?: 'auto' | null | undefined;
  deadzone?: number | null | undefined;
}

/** A profile chosen for a pad: it always has a name and a matcher. */
export interface ResolvedProfile extends PadProfile {
  name: string;
  match: (id: string, mapping?: string) => boolean;
}

/** What the manager reads of a pad from `navigator.getGamepads()`. */
export interface PadReading {
  readonly id: string;
  readonly mapping: string;
  readonly buttons: ArrayLike<{ readonly pressed: boolean }>;
  readonly axes: ArrayLike<number>;
}

/** One read of a pad as N64 input. */
export interface PadInput {
  buttons: number;
  lx: number;
  ly: number;
  cx: number;
  cy: number;
}

/** The page state the manager uses: the ROM hash and the storage helpers. */
export type ManagerState = Pick<PageState, 'romHash' | 'safeGet' | 'safeSet' | 'safeRemove'>;

/** Everything the manager takes from the page it runs in. */
export interface GamepadEnv {
  /** The browser's own getGamepads (the engine overrides the global one). */
  getGamepads: () => ArrayLike<PadReading | null | undefined>;
  /** `window.KNState`, read when it is needed; undefined before it exists. */
  state: () => ManagerState | undefined;
  now: () => number;
  /** Write a setting straight to localStorage. */
  setItem: (key: string, value: string) => void;
  /** Run `poll` when the browser reports a pad connecting or disconnecting. */
  listen: (poll: () => void) => void;
  unlisten: (poll: () => void) => void;
  /** Run `poll` every `ms`; returns how to stop it. */
  every: (poll: () => void, ms: number) => () => void;
  warn: (message: string) => void;
}

interface Detected {
  id: string;
  mapping: string;
  profileName: string;
  profile: ResolvedProfile;
}

interface StartOptions {
  playerSlot?: number;
  onUpdate?: (() => void) | null;
}

// ── Profile Registry ─────────────────────────────────────────────────
// Ordered array. First match wins. Raphnet and Switch 2 Pro before Standard (fallback).

const STANDARD_MAPPING = {
  buttons: {
    0: 1 << 0, // face bottom (A/Cross) → N64 A (JOYPAD_B)
    1: 1 << 1, // face right (B/Circle) → N64 B (JOYPAD_Y)
    9: 1 << 3, // start → Start
    12: 1 << 4, // dpad up → D-Up
    13: 1 << 5, // dpad down → D-Down
    14: 1 << 6, // dpad left → D-Left
    15: 1 << 7, // dpad right → D-Right
    4: 1 << 10, // LB → L (JOYPAD_L)
    5: 1 << 11, // RB → R (JOYPAD_R)
    6: 1 << 12, // LT → Z (JOYPAD_L2)
  },
  axes: {
    stickX: { index: 0, bits: [16, 17] }, // X+→right(16), X-→left(17)
    stickY: { index: 1, bits: [18, 19] }, // Y+→down(18), Y-→up(19)
  },
  axisButtons: {
    2: { pos: 1 << 21, neg: 1 << 20 }, // R stick X: pos(right)→CRight(21), neg(left)→CLeft(20) — core inverts X
    3: { pos: 1 << 22, neg: 1 << 23 }, // R stick Y: pos→CDown(22), neg→CUp(23)
  },
  deadzone: 0.15,
} satisfies PadProfile;

const STANDARD_PROFILE: ResolvedProfile = {
  name: 'Standard',
  match: () => true,
  ...STANDARD_MAPPING,
};

const PROFILES: readonly ResolvedProfile[] = [
  {
    name: 'Raphnet N64',
    match: (id) => id.includes('Raphnet') || id.includes('0964'),
    // Uses Standard mapping until verified with hardware — update when tested
    ...STANDARD_MAPPING,
  },
  {
    name: 'Switch 2 Pro',
    // Chrome: "... (Vendor: 057e Product: 2069)"; Firefox: "057e-2069-..." ("57e-2069-..." on macOS).
    // `mapping` is the Gamepad API's own flag: a browser that maps this pad natively as a standard
    // gamepad gets the Standard profile instead.
    match: (id, mapping) => /\b0?57e\b/i.test(id) && /\b2069\b/.test(id) && mapping !== 'standard',
    // Raw (non-standard) HID layout, buttons in HID usage order; positional like Standard:
    // bottom face (B) → N64 A, right face (A) → N64 B. X/Y, stick clicks, Home, Capture,
    // GR/GL, C are left unmapped (like Standard leaves X/Y). ZL/ZR are digital.
    // Measured on hardware (Chrome, macOS): raw HID (mapping ""), 21 buttons, 6 axes exposed as
    // [X, Y, unused, Rx, unused, Rz]. +Y is UP on both sticks (opposite of Standard), and full
    // deflection only travels about 0.75-0.85 from the resting position, hence axisRange. The
    // sticks rest off-centre (measured LY +0.105, RX +0.075), hence axisCenter.
    buttons: {
      0: 1 << 0, // B (bottom face) → N64 A
      1: 1 << 1, // A (right face) → N64 B
      6: 1 << 3, // + → Start
      11: 1 << 4, // dpad up → D-Up
      8: 1 << 5, // dpad down → D-Down
      10: 1 << 6, // dpad left → D-Left
      9: 1 << 7, // dpad right → D-Right
      12: 1 << 10, // L → L
      4: 1 << 11, // R → R
      13: 1 << 12, // ZL → Z
    },
    axes: {
      stickX: { index: 0, bits: [16, 17] }, // X+→right(16), X-→left(17)
      stickY: { index: 1, bits: [19, 18] }, // Y+→up(19), Y-→down(18)
    },
    axisButtons: {
      3: { pos: 1 << 21, neg: 1 << 20 }, // R stick X: pos(right)→CRight(21), neg(left)→CLeft(20)
      5: { pos: 1 << 23, neg: 1 << 22 }, // R stick Y: pos(up)→CUp(23), neg(down)→CDown(22)
    },
    axisRange: 0.8,
    axisCenter: 'auto',
    deadzone: STANDARD_MAPPING.deadzone,
  },
  STANDARD_PROFILE,
];

const builtInProfile = (id: string, mapping: string | undefined): ResolvedProfile =>
  PROFILES.find((p) => p.match(id, mapping)) ?? STANDARD_PROFILE;

// ── Analog Pipeline ────────────────────────────────────────────────
const DEFAULT_DEADZONE = 0.15;
const DEFAULT_RANGE = 66; // percentage — community standard matching N-Rage/RMG-K
const RANGE_CACHE_MS = 1000;

const CENTER_MAX = 0.15; // a stick further from 0 than this is held, never at rest
const CENTER_STEADY = 0.02; // two readings this close mean the stick is not moving

const C_X_MASK = (1 << 20) | (1 << 21);
const C_Y_MASK = (1 << 22) | (1 << 23);

/**
 * Returns (rawAxisValue, center = 0) => value in [-1, 1] for name 'lx' | 'ly' | 'cx' | 'cy', in the Standard
 * convention (+X = right, +Y = down) that the analog pipeline and the N64 output expect.
 * A profile records what a positive/negative axis value means in axes.stickX/stickY bits
 * [pos, neg] and axisButtons pos/neg (the remap wizard writes them), so an axis whose positive
 * end is the other direction is flipped. Missing data keeps Standard polarity. The rest position
 * (center, see axisCenter) is subtracted, then axisRange (the raw value of full deflection) is divided
 * out so pads that top out below 1 still reach the full N64 range.
 */
export const axisTransform = (profile: AxisProfile, name: AxisName): ((raw: number, center?: number) => number) => {
  const sign = axisSign(profile, name);
  const range = profile.axisRange ?? 1;
  return (raw, center = 0) => normalizeAxis(raw, center, sign, range);
};

/** The manager, given the page it runs in. Each call has its own pads and assignments. */
export const createGamepadManager = (env: GamepadEnv) => {
  const getSetting = (
    key: string,
    parse: (stored: string) => number,
    validate: (value: number) => boolean,
    fallback: number,
  ): number => {
    try {
      const state = env.state();
      if (!state) return fallback;
      // Per-game override first. Nothing stored parses to NaN, which no setting accepts.
      const hash = state.romHash;
      if (hash) {
        const gv = parse(state.safeGet('localStorage', `kn-gamepad:${hash}:${key}`) ?? '');
        if (validate(gv)) return gv;
      }
      // Global setting
      const v = parse(state.safeGet('localStorage', key) ?? '');
      if (validate(v)) return v;
    } catch {
      // Storage that throws reads as nothing stored.
    }
    return fallback;
  };

  let cachedRange: number | null = null;
  let cachedRangeTime = 0;

  const getRange = (): number => {
    const now = env.now();
    if (cachedRange !== null && now - cachedRangeTime < RANGE_CACHE_MS) return cachedRange;
    const range = getSetting(
      'kn-analog-range',
      (s) => parseInt(s, 10),
      (v) => v >= 0 && v <= 100,
      DEFAULT_RANGE,
    );
    cachedRange = range;
    cachedRangeTime = now;
    return range;
  };

  const getDeadzone = (key: string): number => getSetting(key, parseFloat, (v) => v >= 0 && v <= 1, DEFAULT_DEADZONE);

  const getSensitivity = (): number =>
    getSetting('kn-analog-sensitivity', parseFloat, (v) => v >= 0.5 && v <= 2.0, 1.0);

  // Inside the dead zone the settings are not read at all.
  const scaleAnalog = (value: number, dz: number): number =>
    Math.abs(value) < dz ? 0 : analogScale(value, dz, getRange(), getSensitivity());

  const snapDigital = (value: number, dz: number): number =>
    Math.abs(value) < dz ? 0 : digitalSnap(value, dz, getRange());

  // ── State ────────────────────────────────────────────────────────────

  let stopPolling: (() => void) | null = null;
  let playerSlot = 0;
  let onUpdate: (() => void) | null = null;

  // { playerSlot: gamepadIndex }
  const assignments: Record<string, number> = {};

  // { gamepadIndex: { id, profileName, profile } }
  const detected: Record<string, Detected> = {};

  // Previous gamepad IDs for change detection
  let prevIds = new Map<number, string>();

  // Resting position of the stick axes of profiles with axisCenter: 'auto'.
  // { gamepadIndex: { axisIndex: restValue } }, and the reading awaiting a second, matching poll.
  const centers: Record<string, Record<string, number>> = {};
  const centerCandidates: Record<string, number[]> = {};

  // ── Profile Resolution ───────────────────────────────────────────────

  const resolveProfile = (id: string, mapping: string | undefined): ResolvedProfile => {
    // Check localStorage for custom profile. What is stored is decoded
    // (../gamepad-profile.ts, an Effect Schema) before it is used; one that
    // does not fit is ignored and the pad gets its built-in profile.
    try {
      const saved = env.state()?.safeGet('localStorage', `gamepad-profile:${id}`);
      if (saved) {
        const profile = decodeGamepadProfile(JSON.parse(saved));
        if (profile) return { ...profile, name: 'Custom', match: () => true };
        env.warn(`[gamepad] saved profile for "${id}" is not usable; using the built-in one`);
      }
    } catch {
      // Not JSON, or storage that throws: the built-in profile.
    }

    // Fall through to built-in profiles
    return builtInProfile(id, mapping);
  };

  // Rest position of an axis (0 until sampled, or for profiles without axisCenter: 'auto').
  const axisCenter = (gpIndex: number, axisIndex: number): number => centers[gpIndex]?.[axisIndex] ?? 0;

  // For profiles with axisCenter: 'auto', sample the stick axes' resting position once per connection.
  // Called every poll until it succeeds. It only counts when every stick is near 0 and two polls in a
  // row agree, so a stick held away from rest never becomes the centre. All axes are sampled together.
  const updateCenter = (i: number, gp: PadReading, profile: PadProfile): void => {
    if (profile.axisCenter !== 'auto' || centers[i]) return;
    const axes = [profile.axes?.stickX?.index, profile.axes?.stickY?.index, ...Object.keys(profile.axisButtons ?? {})]
      .map(Number)
      .filter((a) => a < gp.axes.length);
    const values = axes.map((a) => gp.axes[a] ?? Number.NaN);
    if (values.every((v) => v === 0)) return; // no report yet: a real stick never rests at exactly 0 on every axis
    if (values.some((v) => Math.abs(v) > CENTER_MAX)) {
      delete centerCandidates[i];
      return;
    }
    const prev = centerCandidates[i];
    if (prev && values.every((v, n) => Math.abs(v - (prev[n] ?? Number.NaN)) <= CENTER_STEADY)) {
      centers[i] = Object.fromEntries(axes.map((a, n): [number, number] => [a, values[n] ?? Number.NaN]));
      delete centerCandidates[i];
    } else {
      centerCandidates[i] = values;
    }
  };

  // ── Polling / Scanning ───────────────────────────────────────────────

  const poll = (): void => {
    const gamepads = env.getGamepads();
    let changed = false;
    const currentIds = new Map<number, string>();

    // Scan all gamepad slots
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp) {
        // Gamepad gone — remove if was detected
        if (detected[i]) {
          // Remove assignment if this gamepad was assigned
          for (const slot of Object.keys(assignments)) {
            if (assignments[slot] === i) {
              delete assignments[slot];
            }
          }
          delete detected[i];
          delete centers[i];
          delete centerCandidates[i];
          changed = true;
        }
        continue;
      }

      currentIds.set(i, gp.id);

      // New or changed gamepad
      let entry = detected[i];
      if (!entry || prevIds.get(i) !== gp.id) {
        const profile = resolveProfile(gp.id, gp.mapping);
        entry = { id: gp.id, mapping: gp.mapping, profileName: profile.name, profile };
        detected[i] = entry;
        delete centers[i];
        delete centerCandidates[i];
        changed = true;

        // Auto-assign to player slot if unassigned
        if (assignments[playerSlot] === undefined) {
          assignments[playerSlot] = i;
        }
      }

      updateCenter(i, gp, entry.profile);
    }

    prevIds = currentIds;

    if (changed && onUpdate) {
      onUpdate();
    }
  };

  // ── Read Gamepad ─────────────────────────────────────────────────────

  const readGamepad = (slot: number): PadInput | null => {
    const gpIndex = assignments[slot];
    if (gpIndex === undefined) return null;

    const gp = env.getGamepads()[gpIndex];
    if (!gp) return null;

    const entry = detected[gpIndex];
    if (!entry) return null;

    const profile = entry.profile;
    let buttons = 0;

    // Map buttons (digital — unchanged)
    for (const [btnIdx, bitmask] of Object.entries(profile.buttons)) {
      const idx = parseInt(btnIdx, 10);
      if (idx < gp.buttons.length && gp.buttons[idx]?.pressed) {
        buttons |= bitmask;
      }
    }

    // Axis value in [-1, 1]: polarity, rest position and range applied (see axisTransform)
    const readAxis = (name: AxisName, axisIndex: number): number =>
      axisTransform(profile, name)(gp.axes[axisIndex] ?? Number.NaN, axisCenter(gpIndex, axisIndex));

    // Left stick — true analog via three-stage pipeline (per-axis deadzone)
    let lx = 0;
    let ly = 0;
    if (profile.axes) {
      const axX = profile.axes.stickX;
      const axY = profile.axes.stickY;
      if (axX && axX.index < gp.axes.length) {
        lx = scaleAnalog(readAxis('lx', axX.index), getDeadzone('kn-deadzone-lx'));
      }
      if (axY && axY.index < gp.axes.length) {
        ly = scaleAnalog(readAxis('ly', axY.index), getDeadzone('kn-deadzone-ly'));
      }
    }

    // C-stick — digital snap (N64 C-buttons are on/off, per-axis deadzone)
    let cx = 0;
    let cy = 0;
    const axBtn = profile.axisButtons;
    if (axBtn) {
      for (const [idx, cfg] of Object.entries(axBtn)) {
        const ai = parseInt(idx, 10);
        if (ai >= gp.axes.length) continue;
        // C-Left(20)/C-Right(21) → X axis, C-Down(22)/C-Up(23) → Y axis
        if (cfg.pos & C_X_MASK || cfg.neg & C_X_MASK) {
          cx = snapDigital(readAxis('cx', ai), getDeadzone('kn-deadzone-cx'));
        }
        if (cfg.pos & C_Y_MASK || cfg.neg & C_Y_MASK) {
          cy = snapDigital(readAxis('cy', ai), getDeadzone('kn-deadzone-cy'));
        }
      }
    }

    // Digital C-button fallback: when C-buttons are remapped to digital
    // buttons, bits 20-23 end up in the buttons bitmask but applyInputToWasm
    // only reads cx/cy for C-stick. Convert bitmask bits to cx/cy values.
    if (cx === 0) {
      const cr = buttons & (1 << 20); // C-Right → positive cx
      const cl = buttons & (1 << 21); // C-Left  → negative cx
      if (cr && !cl) cx = n64StickMax(getRange());
      else if (cl && !cr) cx = -n64StickMax(getRange());
    }
    if (cy === 0) {
      const cd = buttons & (1 << 22); // C-Down → positive cy
      const cu = buttons & (1 << 23); // C-Up   → negative cy
      if (cd && !cu) cy = n64StickMax(getRange());
      else if (cu && !cd) cy = -n64StickMax(getRange());
    }

    return { buttons, lx, ly, cx, cy };
  };

  // Re-resolve the profile of every detected pad with this id, after its saved profile changed.
  const reresolve = (gamepadId: string): void => {
    for (const entry of Object.values(detected)) {
      if (entry.id === gamepadId) {
        const resolved = resolveProfile(gamepadId, entry.mapping);
        entry.profile = resolved;
        entry.profileName = resolved.name;
      }
    }
    if (onUpdate) onUpdate();
  };

  // ── Public API ───────────────────────────────────────────────────────

  return {
    start: (opts?: StartOptions | null): void => {
      playerSlot = opts?.playerSlot ?? 0;
      onUpdate = opts?.onUpdate ?? null;

      // Immediate first poll
      poll();

      // Also listen for browser events for faster response
      env.listen(poll);

      // Polling loop as source of truth (500ms for faster detection)
      if (stopPolling) stopPolling();
      stopPolling = env.every(poll, 500);
    },

    stop: (): void => {
      if (stopPolling) {
        stopPolling();
        stopPolling = null;
      }
      env.unlisten(poll);
    },

    readGamepad,
    axisTransform,
    axisCenter,
    /** Human-readable name for a gamepad id (see gamepadDisplayName). */
    displayName: gamepadDisplayName,

    hasGamepad: (slot: number): boolean => {
      const gpIndex = assignments[slot];
      return gpIndex !== undefined && !!detected[gpIndex];
    },

    getAssignments: () => {
      const result: Record<string, { gamepadIndex: number; profileName: string; gamepadId: string }> = {};
      for (const [slot, gpIndex] of Object.entries(assignments)) {
        const entry = detected[gpIndex];
        if (entry) {
          result[slot] = {
            gamepadIndex: gpIndex,
            profileName: entry.profileName,
            gamepadId: entry.id,
          };
        }
      }
      return result;
    },

    reassignSlot: (slot: number, gamepadIndex: number): void => {
      if (detected[gamepadIndex]) {
        assignments[slot] = gamepadIndex;
        if (onUpdate) onUpdate();
      }
    },

    getDetected: () =>
      Object.entries(detected).map(([idx, entry]) => ({
        index: parseInt(idx, 10),
        id: entry.id,
        profileName: entry.profileName,
      })),

    saveGamepadProfile: (gamepadId: string, profile: PadProfile): void => {
      try {
        env.state()?.safeSet('localStorage', `gamepad-profile:${gamepadId}`, JSON.stringify(profile));
      } catch {
        // A profile that cannot be stored lasts until the pad is next resolved.
      }
      reresolve(gamepadId);
    },

    clearGamepadProfile: (gamepadId: string): void => {
      try {
        env.state()?.safeRemove('localStorage', `gamepad-profile:${gamepadId}`);
      } catch {
        // Nothing to remove.
      }
      reresolve(gamepadId);
    },

    // `mapping` defaults to that of the detected gamepad with this id, when there is one.
    getDefaultProfile: (
      gamepadId: string,
      mapping: string | undefined = Object.values(detected).find((e) => e.id === gamepadId)?.mapping,
    ): ResolvedProfile => builtInProfile(gamepadId, mapping),

    hasCustomProfile: (gamepadId: string): boolean => {
      try {
        const state = env.state();
        return state !== undefined && state.safeGet('localStorage', `gamepad-profile:${gamepadId}`) !== null;
      } catch {
        return false;
      }
    },

    // Expose the real getGamepads (before lockstep overrides it)
    nativeGetGamepads: () => env.getGamepads(),

    getCurrentSettings: () => ({
      range: getRange(),
      sensitivity: getSensitivity(),
      deadzones: {
        lx: getDeadzone('kn-deadzone-lx'),
        ly: getDeadzone('kn-deadzone-ly'),
        cx: getDeadzone('kn-deadzone-cx'),
        cy: getDeadzone('kn-deadzone-cy'),
      },
    }),

    getActiveProfile: (slot: number) => {
      const gpIndex = assignments[slot];
      if (gpIndex === undefined) return null;
      const entry = detected[gpIndex];
      return entry ? { id: entry.id, profileName: entry.profileName, profile: entry.profile } : null;
    },

    setSetting: (key: string, value: number | string, scope?: string): void => {
      const hash = scope === 'game' ? env.state()?.romHash : null;
      env.setItem(hash ? `kn-gamepad:${hash}:${key}` : key, String(value));
      // Bust range cache so changes take effect immediately
      cachedRange = null;
      cachedRangeTime = 0;
    },
  };
};

export type GamepadManager = ReturnType<typeof createGamepadManager>;

// web/static/api-sandbox.js: the browser's own functions, kept from before the engine overrides them.
declare const APISandbox: { nativeGetGamepads: () => (Gamepad | null)[] };

/** The page the browser gives: real pads, `window.KNState`, localStorage and timers. */
const browserEnv = (): GamepadEnv => ({
  getGamepads: () => APISandbox.nativeGetGamepads(),
  state: () => window.KNState,
  now: () => performance.now(),
  setItem: (key, value) => localStorage.setItem(key, value),
  listen: (poll) => {
    window.addEventListener('gamepadconnected', poll);
    window.addEventListener('gamepaddisconnected', poll);
  },
  unlisten: (poll) => {
    window.removeEventListener('gamepadconnected', poll);
    window.removeEventListener('gamepaddisconnected', poll);
  },
  every: (poll, ms) => {
    const id = window.setInterval(poll, ms);
    return () => window.clearInterval(id);
  },
  warn: (message) => console.warn(message),
});

/** Define `window.GamepadManager`. Nothing on the page is read until it is used. */
export const installGamepadManager = (): void => {
  window.GamepadManager = createGamepadManager(browserEnv());
};

declare global {
  interface Window {
    GamepadManager?: GamepadManager;
  }
}
