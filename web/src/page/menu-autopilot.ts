/**
 * Closed-loop menu driver for the rollback demo and the two-player test.
 * Moved from web/static/ssb64-menu-autopilot.js.
 *
 * Gets SSB64 (NTSC-U 1.0) from power-on to a VS battle for P1 and the
 * synthetic P2 by reading the game's own menu state from RDRAM each frame
 * and tapping the button that moves it toward the goal. A press the game
 * drops (menu still in its 10-tic input lockout, landed mid-transition,
 * etc.) is sent again on the next decision, so there is no frame-exact
 * timing to miss.
 *
 * Addresses, struct layouts and menu rules come from the SSB64
 * decompilation (github.com/VetriTheRetri/ssb-decomp-re, symbols_us.txt):
 *   gSCManagerSceneData.scene_curr   0x800A4AD0 (u8)   src/sc/scdef.h SCKind
 *   sMNModeSelectOption              0x80132C88 (s32)  mncommon/mnmodeselect.c
 *   sMNVSModeCursorIndex             0x80134948 (s32)  mnvsmode/mnvsmode.c
 *   sMNPlayersVSSlots[4]             0x8013BA88 (0xBC each) mnplayers/mnplayersvs.c
 *   sMNMapsCursorSlot                0x80134BD8 (s32)  mnmaps/mnmaps.c
 * Pointer walks (slot.puck -> GObj.obj -> SObj.pos) are validated against
 * the SObj's back-pointer to its GObj; any mismatch stops the autopilot
 * (logged as AUTOPILOT-LAYOUT-MISMATCH) instead of steering blind.
 *
 * Input format is the engine's: { buttons, lx, ly, cx, cy } with RetroArch
 * joypad bits (A=0, B=1, START=3, D-pad U/D/L/R=4..7) and ly < 0 = stick up.
 *
 * This module imports no package (only a type), so
 * tests/ssb64-menu-autopilot.test.mjs loads it directly.
 */
import type { WireInput } from '../input-wire.ts';

const SCENE_ADDR = 0x800a4ad0;
const MODE_SELECT_OPTION = 0x80132c88;
const VSMODE_CURSOR = 0x80134948;
const CSS_SLOTS = 0x8013ba88;
const CSS_SLOT_SIZE = 0xbc;
const MAPS_CURSOR_SLOT = 0x80134bd8;

// MNPlayersSlotVS field offsets (mn/mntypes.h)
const SLOT_PUCK = 0x04;
const SLOT_FKIND = 0x48;
const SLOT_CURSOR_STATUS = 0x54;
const SLOT_HELD_PLAYER = 0x80;
const SLOT_IS_FIGHTER_SELECTED = 0x88;
// GObj.obj (sys/objtypes.h), SObj.parent_gobj / SObj.pos
const GOBJ_OBJ = 0x74;
const SOBJ_PARENT = 0x04;
const SOBJ_POS_X = 0x58;
const SOBJ_POS_Y = 0x5c;

/** The game's scene numbers (SCKind) the autopilot knows. */
export const SCENE = {
  TITLE: 1,
  MODE_SELECT: 7,
  VS_MODE: 9,
  PLAYERS_VS: 16,
  MAPS: 21,
  VS_BATTLE: 22,
  UNKNOWN_MARIO: 23,
  /** N64 logo (US only). */
  STARTUP: 27,
  OPENING_FIRST: 28,
  OPENING_LAST: 46,
  AUTO_DEMO: 61,
};
/** nMNModeSelectOptionVSMode */
const MODE_SELECT_VS = 1;
/** nMNVSModeOptionStart */
const VSMODE_START = 0;
/** nMNPlayersCursorStatusGrab */
const CURSOR_GRAB = 1;
const FKIND = { MARIO: 0, DONKEY: 2, NULL: 28 };
/** Dream Land (mnMapsGetGroundKind). */
export const MAPS_TARGET_SLOT = 6;

/** A fighter and the puck position that centres the puck on its portrait. */
export interface PortraitTarget {
  readonly fkind: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Where each player's puck goes. mnPlayersVSGetPuckFighterKind maps
 * (pos.x + 13, pos.y + 12) to a 45-px-wide cell; top row y+12 in (35, 79),
 * columns from x+13 = 25. Mario is column 1, DK column 2: both always
 * unlocked, unlike Luigi/Ness/Falcon/Jigglypuff.
 */
export const PORTRAIT_TARGETS: readonly [PortraitTarget, PortraitTarget] = [
  { fkind: FKIND.MARIO, x: 25 + 45 * 1 + 22 - 13, y: 57 - 12 },
  { fkind: FKIND.DONKEY, x: 25 + 45 * 2 + 22 - 13, y: 57 - 12 },
];
/** px from cell centre; cells are 45 x 43. */
const AIM_TOLERANCE = 8;
/**
 * The scene byte flips as soon as a menu selects the next scene, but the
 * next scene's variables hold whatever the previous overlay left there
 * until it finishes loading. Unreadable state is "not ready yet" for this
 * many frames after a scene change; only past that is it a real mismatch.
 */
const SCENE_READY_BUDGET = 300;

/** RetroArch joypad bits. */
export const BTN = { A: 1 << 0, B: 1 << 1, START: 1 << 3, UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7 };
const STICK_MAX = 83;
/** SSB64 ignores |stick| <= 8 on the CSS. */
const STICK_MIN = 20;
const TAP_HOLD = 3;
/**
 * After a press, wait out the input delay before deciding again, or the
 * next decision reads the menu as it was before the press landed and
 * presses a second time (two DOWNs, then A on the wrong option).
 */
const TAP_RELEASE = 16;

/** One frame of one player's input, as the engine takes it. */
export type PilotInput = Readonly<WireInput>;

/** What a decision sends: an input held for `hold` frames, then neutral for `release` more. */
interface PilotAction {
  readonly input: PilotInput;
  readonly hold: number;
  readonly release: number;
}

const ZERO: PilotInput = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });
const tap = (buttons: number): PilotAction => ({ input: { ...ZERO, buttons }, hold: TAP_HOLD, release: TAP_RELEASE });
const idle = (frames: number): PilotAction => ({ input: ZERO, hold: 0, release: frames });

const f32 = (() => {
  const buf = new DataView(new ArrayBuffer(4));
  return (word: number): number => {
    buf.setUint32(0, word >>> 0);
    return buf.getFloat32(0);
  };
})();

/** A word that can be an RDRAM pointer: in the 8 MB KSEG0 range and word-aligned. */
const isPtr = (p: number): boolean => p >= 0x80000000 && p < 0x80800000 && (p & 3) === 0;

/** A word as it is written in a mismatch report; a word that could not be read prints as "undefined". */
const hex = (word: number | null): string | undefined => word?.toString(16);

/** The puck moves stick/20 px a frame (mnPlayersVS cursor update). */
const PX_PER_FRAME_PER_STICK = 1 / 20;
const PULSE_MAX_FRAMES = 40;
/**
 * Longer than the engine's largest input delay (12 frames,
 * ROLLBACK_MAX_DELAY_FRAMES in netplay-rollback.js). A puck that has not
 * moved for this many game frames, all of them after the last frame a
 * stick or button was sent for, has nothing of ours still on its way.
 */
const SETTLE_FRAMES = 16;

/**
 * One burst of stick that carries the puck (dx, dy): how many frames to hold
 * it and at what deflection. An axis whose share would be under the smallest
 * deflection the game reads is left for the next burst.
 */
export const stickPulse = (dx: number, dy: number): PilotAction => {
  const far = Math.max(Math.abs(dx), Math.abs(dy));
  const frames = Math.min(PULSE_MAX_FRAMES, Math.max(1, Math.ceil(far / (PX_PER_FRAME_PER_STICK * STICK_MAX))));
  const axis = (err: number): number => {
    if (Math.abs(err) <= AIM_TOLERANCE / 2) return 0;
    const mag = Math.min(STICK_MAX, Math.round(Math.abs(err) / (PX_PER_FRAME_PER_STICK * frames)));
    if (mag < STICK_MIN) return 0;
    return err < 0 ? -mag : mag;
  };
  return { input: { ...ZERO, lx: axis(dx), ly: axis(dy) }, hold: frames, release: 0 };
};

/**
 * Is this ROM the US SSB64? Checks the N64 header: internal name
 * "SMASH BROTHERS", game code NALE. Handles .z64 (big-endian), .v64
 * (byte-swapped) and .n64 (word-swapped). Anything that is not ROM bytes
 * is not.
 */
export const isSsb64UsRom = (bytes: Uint8Array | ArrayBuffer | ArrayLike<number>): boolean => {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 0x40) return false;
    const byte = (i: number): number => b[i] ?? 0;
    const magic = (byte(0) << 24) | (byte(1) << 16) | (byte(2) << 8) | byte(3);
    let at: (i: number) => number;
    if (magic === 0x80371240 >> 0) at = (i) => byte(i);
    else if (magic === 0x37804012) at = (i) => byte(i ^ 1);
    else if (magic === 0x40123780) at = (i) => byte(i ^ 3);
    else return false;
    let name = '';
    for (let i = 0x20; i < 0x34; i++) name += String.fromCharCode(at(i));
    let code = '';
    for (let i = 0x3b; i < 0x3f; i++) code += String.fromCharCode(at(i));
    return name.trim() === 'SMASH BROTHERS' && code === 'NALE';
  } catch {
    return false;
  }
};

/** One player's input for an engine frame. */
export type PilotActor = (frame: number) => PilotInput;

/**
 * One player's input stream. Decisions are keyed to engine frames and
 * cached, so repeated or out-of-order reads of a frame agree.
 */
const makeActor = (decide: (frame: number) => PilotAction): PilotActor => {
  const cache = new Map<number, PilotInput>();
  let start = -1;
  let hold = 0;
  let busyUntil = -1;
  let current = ZERO;
  return (frame) => {
    const cached = cache.get(frame);
    if (cached !== undefined) return cached;
    if (frame >= busyUntil) {
      const action = decide(frame);
      start = frame;
      hold = action.hold;
      busyUntil = frame + Math.max(1, action.hold + action.release);
      current = action.input;
    }
    const out = frame >= start && frame < start + hold ? current : ZERO;
    cache.set(frame, out);
    if (cache.size > 256) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return out;
  };
};

/** How the autopilot reaches the game. */
export interface MenuAutopilotOptions {
  /** An aligned big-endian RDRAM word, or null when memory cannot be read. */
  readonly read32: (addr: number) => number | null | undefined;
  readonly log?: ((msg: string) => void) | undefined;
  /**
   * Press A on whatever portrait the puck reaches, and take the stage the
   * cursor starts on. For a ROM whose character grid and stage list are not
   * SSB64's (Smash Remix): the menu structs are where SSB64's are, the
   * layout is not.
   */
  readonly anyFighter?: boolean | undefined;
  /**
   * The game frame read32 is reading. Needed when an actor is asked for
   * frames ahead of the game (the demo's fake peer does, while the engine is
   * stalled): those calls read the same memory and must not count as time
   * gone by. Without it, the frame an actor is asked for is taken to be the
   * game's.
   */
  readonly currentFrame?: (() => number) | null | undefined;
}

/** The two players' input streams, and why the autopilot stopped (null while it has not). */
export interface MenuAutopilot {
  readonly p1: PilotActor;
  readonly p2: PilotActor;
  readonly failure: () => string | null;
}

/** One character-select slot as read from memory. */
interface CssSlot {
  readonly x: number;
  readonly y: number;
  readonly fkind: number | null;
  readonly cursorStatus: number | null;
  readonly heldPlayer: number | null;
  readonly fighterSelected: boolean;
}

/**
 * Per slot: where the puck was last read, the game frame it was last seen
 * to move, and the first frame after the last stick or button sent.
 */
interface Steering {
  x: number;
  y: number;
  movedAt: number;
  quietFrom: number;
}

/** The two slots the autopilot drives: P1 and the synthetic P2. */
type PilotSlot = 0 | 1;

/** A menu driver over one game's memory. */
export const createMenuAutopilot = (options: MenuAutopilotOptions): MenuAutopilot => {
  const { read32 } = options;
  const log = options.log ?? (() => undefined);
  const anyFighter = options.anyFighter ?? false;
  const currentFrame = options.currentFrame ?? null;
  let failed: string | null = null;
  let lastScene = -1;
  let sceneSince = 0;
  let frameNow = 0;

  const fail = (why: string): PilotAction => {
    if (!failed) {
      failed = why;
      log(`AUTOPILOT-LAYOUT-MISMATCH ${why}`);
    }
    return idle(60);
  };
  const notReady = (why: string): PilotAction => (frameNow - sceneSince > SCENE_READY_BUDGET ? fail(why) : idle(4));

  const r32 = (addr: number): number | null => {
    const v = read32(addr);
    return v === null || v === undefined ? null : v >>> 0;
  };
  const s32 = (addr: number): number | null => {
    const v = r32(addr);
    return v === null ? null : v | 0;
  };
  /** The current scene, noting the frame it changed (shared by both actors). */
  const observeScene = (frame: number): number => {
    frameNow = Math.max(frameNow, frame);
    const w = r32(SCENE_ADDR);
    const sc = w === null ? -1 : w >>> 24;
    if (sc !== lastScene) {
      lastScene = sc;
      sceneSince = frameNow;
    }
    return sc;
  };

  const slotAddr = (i: PilotSlot): number => CSS_SLOTS + i * CSS_SLOT_SIZE;

  /** One CSS slot, or a string describing what did not validate. */
  const readSlot = (i: PilotSlot): CssSlot | string => {
    const base = slotAddr(i);
    const puck = r32(base + SLOT_PUCK);
    if (puck === null || !isPtr(puck)) return `slot${i}.puck=${hex(puck)}`;
    const sobj = r32(puck + GOBJ_OBJ);
    if (sobj === null || !isPtr(sobj)) return `slot${i}.puck.obj=${hex(sobj)}`;
    const parent = r32(sobj + SOBJ_PARENT);
    if (parent !== puck) return `slot${i}.sobj.parent=${hex(parent)}!=${puck.toString(16)}`;
    // A word that cannot be read is taken as 0.
    const x = f32(r32(sobj + SOBJ_POS_X) ?? 0);
    const y = f32(r32(sobj + SOBJ_POS_Y) ?? 0);
    if (!(x > -100 && x < 420 && y > -100 && y < 340)) return `slot${i}.pos=${x},${y}`;
    return {
      x,
      y,
      fkind: s32(base + SLOT_FKIND),
      cursorStatus: s32(base + SLOT_CURSOR_STATUS),
      heldPlayer: s32(base + SLOT_HELD_PLAYER),
      fighterSelected: s32(base + SLOT_IS_FIGHTER_SELECTED) === 1,
    };
  };

  const steer: readonly [Steering, Steering] = [
    { x: NaN, y: NaN, movedAt: 0, quietFrom: 0 },
    { x: NaN, y: NaN, movedAt: 0, quietFrom: 0 },
  ];

  /**
   * Move slot i's puck onto its target portrait, then press A.
   *
   * Input reaches the game some frames after it is decided (the engine's
   * input delay), so what is read here is where the puck was, not where it
   * will be when a press lands. Steering continuously and pressing A on
   * arrival put the press wherever the puck had coasted to: another fighter,
   * or the bar above the portraits, where A toggles Team Battle and changes
   * the stock count. So this moves in bursts and decides only at rest: send
   * a burst, send neutral until the puck has been still for SETTLE_FRAMES,
   * then look. A press sent from rest lands at rest.
   */
  const cssPick = (i: PilotSlot, frame: number): PilotAction => {
    const slot = readSlot(i);
    if (typeof slot === 'string') return notReady(slot);
    if (slot.fighterSelected) return idle(6);
    if (slot.heldPlayer !== i) return notReady(`slot${i}.held_player=${slot.heldPlayer}`);
    const st = steer[i];
    const now = currentFrame ? currentFrame() : frame;
    if (slot.x !== st.x || slot.y !== st.y) st.movedAt = now;
    st.x = slot.x;
    st.y = slot.y;
    if (now - Math.max(st.movedAt, st.quietFrom) < SETTLE_FRAMES) return idle(1);
    const sending = (action: PilotAction): PilotAction => {
      st.quietFrom = frame + action.hold;
      return action;
    };
    const target = PORTRAIT_TARGETS[i];
    const dx = target.x - slot.x;
    const dy = target.y - slot.y;
    if (Math.abs(dx) <= AIM_TOLERANCE && Math.abs(dy) <= AIM_TOLERANCE) {
      // On the portrait and at rest. A only selects while grabbing a puck
      // over a fighter. A press the game drops is sent again from rest.
      if (slot.cursorStatus !== CURSOR_GRAB || !(anyFighter || slot.fkind === target.fkind)) return idle(1);
      return sending(tap(BTN.A));
    }
    return sending(stickPulse(dx, dy));
  };

  const cssBothPicked = (): boolean => {
    const both: readonly PilotSlot[] = [0, 1];
    for (const i of both) {
      const slot = readSlot(i);
      if (typeof slot === 'string' || !slot.fighterSelected || slot.cursorStatus === CURSOR_GRAB) return false;
    }
    return true;
  };

  const decideP1 = (frame: number): PilotAction => {
    if (failed) return idle(60);
    const sc = observeScene(frame);
    switch (sc) {
      case -1:
      case SCENE.VS_BATTLE:
        return idle(6);
      case SCENE.MODE_SELECT: {
        // A word that cannot be read counts as option 0.
        const opt = s32(MODE_SELECT_OPTION) ?? 0;
        if (!(opt >= 0 && opt <= 3)) return notReady(`modeSelectOption=${opt}`);
        if (opt < MODE_SELECT_VS) return tap(BTN.DOWN);
        if (opt > MODE_SELECT_VS) return tap(BTN.UP);
        return tap(BTN.A);
      }
      case SCENE.VS_MODE: {
        // A word that cannot be read is in range but is not the Start option.
        const cur = s32(VSMODE_CURSOR);
        if (cur !== null && !(cur >= 0 && cur <= 3)) return notReady(`vsModeCursor=${cur}`);
        return cur === VSMODE_START ? tap(BTN.A) : tap(BTN.UP);
      }
      case SCENE.PLAYERS_VS:
        return cssBothPicked() ? tap(BTN.START) : cssPick(0, frame);
      case SCENE.MAPS: {
        if (anyFighter) return tap(BTN.A);
        // A word that cannot be read counts as slot 0.
        const slot = s32(MAPS_CURSOR_SLOT) ?? 0;
        if (!(slot >= 0 && slot <= 9)) return notReady(`mapsCursorSlot=${slot}`);
        if (slot < 5) return tap(BTN.DOWN);
        if (slot < MAPS_TARGET_SLOT) return tap(BTN.RIGHT);
        if (slot > MAPS_TARGET_SLOT) return tap(BTN.LEFT);
        return tap(BTN.A);
      }
      default:
        // Boot logo, intro movies, title, attract demo: Start skips ahead.
        if (
          sc === SCENE.TITLE ||
          sc === SCENE.STARTUP ||
          sc === SCENE.UNKNOWN_MARIO ||
          sc === SCENE.AUTO_DEMO ||
          (sc >= SCENE.OPENING_FIRST && sc <= SCENE.OPENING_LAST)
        ) {
          return tap(BTN.START);
        }
        // Any other menu is a wrong turn; B backs out toward the main menu.
        return tap(BTN.B);
    }
  };

  // P2 only has a job on the character select; everywhere else it stays
  // idle so it never fights P1 for menus that accept any controller.
  const decideP2 = (frame: number): PilotAction => {
    if (failed || observeScene(frame) !== SCENE.PLAYERS_VS) return idle(6);
    return cssPick(1, frame);
  };

  return {
    p1: makeActor(decideP1),
    p2: makeActor(decideP2),
    failure: () => failed,
  };
};

/** What the demo page and the two-player test read as `window.KNMenuAutopilot`. */
export const menuAutopilot = {
  create: createMenuAutopilot,
  isSsb64UsRom,
  SCENE,
  BTN,
  PORTRAIT_TARGETS,
  MAPS_TARGET_SLOT,
};

declare global {
  interface Window {
    KNMenuAutopilot?: typeof menuAutopilot;
  }
}
