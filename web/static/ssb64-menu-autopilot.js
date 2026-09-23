/**
 * ssb64-menu-autopilot.js — closed-loop menu driver for the rollback demo.
 *
 * Gets SSB64 (NTSC-U 1.0) from power-on to a VS battle for P1 and the
 * synthetic P2 by reading the game's own menu state from RDRAM each frame
 * and tapping the button that moves it toward the goal. A press the game
 * drops (menu still in its 10-tic input lockout, landed mid-transition,
 * etc.) is simply re-issued on the next decision, so there is no
 * frame-exact timing to miss.
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
 * Exposes: window.KNMenuAutopilot = { create, isSsb64UsRom, ... }
 */
(function () {
  'use strict';

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

  const SCENE = {
    TITLE: 1,
    MODE_SELECT: 7,
    VS_MODE: 9,
    PLAYERS_VS: 16,
    MAPS: 21,
    VS_BATTLE: 22,
    UNKNOWN_MARIO: 23,
    STARTUP: 27, // N64 logo (US only)
    OPENING_FIRST: 28,
    OPENING_LAST: 46,
    AUTO_DEMO: 61,
  };
  const MODE_SELECT_VS = 1; // nMNModeSelectOptionVSMode
  const VSMODE_START = 0; // nMNVSModeOptionStart
  const CURSOR_GRAB = 1; // nMNPlayersCursorStatusGrab
  const FKIND = { MARIO: 0, DONKEY: 2, NULL: 28 };
  const MAPS_TARGET_SLOT = 6; // Dream Land (mnMapsGetGroundKind)

  // Puck position that centers it on a portrait. mnPlayersVSGetPuckFighterKind
  // maps (pos.x + 13, pos.y + 12) to a 45-px-wide cell; top row y+12 in
  // (35, 79), columns from x+13 = 25. Mario is column 1, DK column 2 — both
  // always unlocked, unlike Luigi/Ness/Falcon/Jigglypuff.
  const PORTRAIT_TARGETS = [
    { fkind: FKIND.MARIO, x: 25 + 45 * 1 + 22 - 13, y: 57 - 12 },
    { fkind: FKIND.DONKEY, x: 25 + 45 * 2 + 22 - 13, y: 57 - 12 },
  ];
  const AIM_TOLERANCE = 8; // px from cell center; cells are 45 x 43
  // The scene byte flips as soon as a menu selects the next scene, but the
  // next scene's variables hold whatever the previous overlay left there
  // until it finishes loading. Unreadable state is "not ready yet" for this
  // many frames after a scene change; only past that is it a real mismatch.
  const SCENE_READY_BUDGET = 300;

  const BTN = { A: 1 << 0, B: 1 << 1, START: 1 << 3, UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7 };
  const STICK_MAX = 83;
  const STICK_MIN = 20; // SSB64 ignores |stick| <= 8 on the CSS
  const TAP_HOLD = 3;
  const TAP_RELEASE = 9;

  const ZERO = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });
  const _tap = (buttons) => ({ input: { ...ZERO, buttons }, hold: TAP_HOLD, release: TAP_RELEASE });
  const _idle = (frames = 1) => ({ input: ZERO, hold: 0, release: frames });
  const _stick = (lx, ly) => ({ input: { ...ZERO, lx, ly }, hold: 1, release: 0 });

  const _f32 = (() => {
    const buf = new DataView(new ArrayBuffer(4));
    return (word) => {
      buf.setUint32(0, word >>> 0);
      return buf.getFloat32(0);
    };
  })();

  const _isPtr = (p) => p != null && p >= 0x80000000 && p < 0x80800000 && (p & 3) === 0;

  // Axis command toward a target: same sign as the error, speed proportional
  // to distance so the few frames of input delay don't overshoot a cell.
  const _axis = (err) => {
    if (Math.abs(err) <= AIM_TOLERANCE / 2) return 0;
    const mag = Math.min(STICK_MAX, Math.max(STICK_MIN, Math.round(Math.abs(err) * 3)));
    return err < 0 ? -mag : mag;
  };

  // Checks the N64 header: internal name "SMASH BROTHERS", game code NALE.
  // Handles .z64 (big-endian), .v64 (byte-swapped) and .n64 (word-swapped).
  const isSsb64UsRom = (bytes) => {
    try {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (b.length < 0x40) return false;
      const magic = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
      let at;
      if (magic === 0x80371240 >> 0) at = (i) => b[i];
      else if (magic === 0x37804012) at = (i) => b[i ^ 1];
      else if (magic === 0x40123780) at = (i) => b[i ^ 3];
      else return false;
      let name = '';
      for (let i = 0x20; i < 0x34; i++) name += String.fromCharCode(at(i));
      let code = '';
      for (let i = 0x3b; i < 0x3f; i++) code += String.fromCharCode(at(i));
      return name.trim() === 'SMASH BROTHERS' && code === 'NALE';
    } catch (_) {
      return false;
    }
  };

  // One player's input stream. Decisions are keyed to engine frames and
  // cached, so repeated or out-of-order reads of a frame agree.
  const _makeActor = (decide) => {
    const cache = new Map();
    let start = -1;
    let hold = 0;
    let busyUntil = -1;
    let current = ZERO;
    return (frame) => {
      if (cache.has(frame)) return cache.get(frame);
      if (frame >= busyUntil) {
        const action = decide(frame);
        start = frame;
        hold = action.hold;
        busyUntil = frame + Math.max(1, action.hold + action.release);
        current = action.input;
      }
      const out = frame >= start && frame < start + hold ? current : ZERO;
      cache.set(frame, out);
      if (cache.size > 256) cache.delete(cache.keys().next().value);
      return out;
    };
  };

  /**
   * @param {object} opts
   * @param {(addr: number) => number|null} opts.read32  aligned big-endian RDRAM word
   * @param {(msg: string) => void} [opts.log]
   */
  const create = ({ read32, log = () => {} }) => {
    let failed = null;
    let lastScene = -1;
    let sceneSince = 0;
    let frameNow = 0;

    const fail = (why) => {
      if (!failed) {
        failed = why;
        log(`AUTOPILOT-LAYOUT-MISMATCH ${why}`);
      }
      return _idle(60);
    };
    const notReady = (why) => (frameNow - sceneSince > SCENE_READY_BUDGET ? fail(why) : _idle(4));

    const r32 = (addr) => {
      const v = read32(addr);
      return v == null ? null : v >>> 0;
    };
    const s32 = (addr) => {
      const v = r32(addr);
      return v == null ? null : v | 0;
    };
    // Current scene, noting the frame it changed (shared by both actors).
    const observeScene = (frame) => {
      frameNow = Math.max(frameNow, frame);
      const w = r32(SCENE_ADDR);
      const sc = w == null ? -1 : w >>> 24;
      if (sc !== lastScene) {
        lastScene = sc;
        sceneSince = frameNow;
      }
      return sc;
    };

    const slotAddr = (i) => CSS_SLOTS + i * CSS_SLOT_SIZE;

    // Reads one CSS slot, or returns a string describing what didn't validate.
    const readSlot = (i) => {
      const base = slotAddr(i);
      const puck = r32(base + SLOT_PUCK);
      if (!_isPtr(puck)) return `slot${i}.puck=${puck?.toString(16)}`;
      const sobj = r32(puck + GOBJ_OBJ);
      if (!_isPtr(sobj)) return `slot${i}.puck.obj=${sobj?.toString(16)}`;
      const parent = r32(sobj + SOBJ_PARENT);
      if (parent !== puck) return `slot${i}.sobj.parent=${parent?.toString(16)}!=${puck.toString(16)}`;
      const x = _f32(r32(sobj + SOBJ_POS_X));
      const y = _f32(r32(sobj + SOBJ_POS_Y));
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

    // Steer slot i's puck onto its target portrait, then press A.
    const cssPick = (i) => {
      const slot = readSlot(i);
      if (typeof slot === 'string') return notReady(slot);
      if (slot.fighterSelected) return _idle(6);
      if (slot.heldPlayer !== i) return notReady(`slot${i}.held_player=${slot.heldPlayer}`);
      const target = PORTRAIT_TARGETS[i];
      const dx = target.x - slot.x;
      const dy = target.y - slot.y;
      if (Math.abs(dx) <= AIM_TOLERANCE && Math.abs(dy) <= AIM_TOLERANCE) {
        // On the portrait. The hover registers a frame after the puck
        // arrives; A only selects while grabbing a puck over a fighter.
        if (slot.cursorStatus === CURSOR_GRAB && slot.fkind === target.fkind) return _tap(BTN.A);
        return _idle(2);
      }
      return _stick(_axis(dx), _axis(dy));
    };

    const cssBothPicked = () => {
      for (let i = 0; i < 2; i++) {
        const slot = readSlot(i);
        if (typeof slot === 'string' || !slot.fighterSelected || slot.cursorStatus === CURSOR_GRAB) return false;
      }
      return true;
    };

    const decideP1 = (frame) => {
      if (failed) return _idle(60);
      const sc = observeScene(frame);
      switch (sc) {
        case -1:
        case SCENE.VS_BATTLE:
          return _idle(6);
        case SCENE.MODE_SELECT: {
          const opt = s32(MODE_SELECT_OPTION);
          if (!(opt >= 0 && opt <= 3)) return notReady(`modeSelectOption=${opt}`);
          if (opt < MODE_SELECT_VS) return _tap(BTN.DOWN);
          if (opt > MODE_SELECT_VS) return _tap(BTN.UP);
          return _tap(BTN.A);
        }
        case SCENE.VS_MODE: {
          const cur = s32(VSMODE_CURSOR);
          if (!(cur >= 0 && cur <= 3)) return notReady(`vsModeCursor=${cur}`);
          return cur === VSMODE_START ? _tap(BTN.A) : _tap(BTN.UP);
        }
        case SCENE.PLAYERS_VS:
          return cssBothPicked() ? _tap(BTN.START) : cssPick(0);
        case SCENE.MAPS: {
          const slot = s32(MAPS_CURSOR_SLOT);
          if (!(slot >= 0 && slot <= 9)) return notReady(`mapsCursorSlot=${slot}`);
          if (slot < 5) return _tap(BTN.DOWN);
          if (slot < MAPS_TARGET_SLOT) return _tap(BTN.RIGHT);
          if (slot > MAPS_TARGET_SLOT) return _tap(BTN.LEFT);
          return _tap(BTN.A);
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
            return _tap(BTN.START);
          }
          // Any other menu is a wrong turn; B backs out toward the main menu.
          return _tap(BTN.B);
      }
    };

    // P2 only has a job on the character select; everywhere else it stays
    // idle so it never fights P1 for menus that accept any controller.
    const decideP2 = (frame) => {
      if (failed || observeScene(frame) !== SCENE.PLAYERS_VS) return _idle(6);
      return cssPick(1);
    };

    return {
      p1: _makeActor(decideP1),
      p2: _makeActor(decideP2),
      failure: () => failed,
    };
  };

  globalThis.KNMenuAutopilot = { create, isSsb64UsRom, SCENE, BTN, PORTRAIT_TARGETS, MAPS_TARGET_SLOT };
})();
