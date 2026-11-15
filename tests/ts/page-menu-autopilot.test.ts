import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  BTN,
  createMenuAutopilot,
  isSsb64UsRom,
  MAPS_TARGET_SLOT,
  menuAutopilot,
  PORTRAIT_TARGETS,
  SCENE,
  type MenuAutopilot,
  type MenuAutopilotOptions,
  type PilotActor,
} from '../../web/src/page/menu-autopilot.ts';
import { rng, simulate, type MenuRun } from './menu-sim.ts';

// Whether the autopilot gets the game to the battle is
// tests/ssb64-menu-autopilot.test.mjs. Here the module is held to the script
// it replaced: given the same memory on the same frames, it reads the same
// words in the same order and sends the same input.

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/ssb64-menu-autopilot.js as of #166, unchanged.
const OLD_SCRIPT = `/**
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
  // After a press, wait out the input delay before deciding again, or the
  // next decision reads the menu as it was before the press landed and
  // presses a second time (two DOWNs, then A on the wrong option).
  const TAP_RELEASE = 16;

  const ZERO = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });
  const _tap = (buttons) => ({ input: { ...ZERO, buttons }, hold: TAP_HOLD, release: TAP_RELEASE });
  const _idle = (frames = 1) => ({ input: ZERO, hold: 0, release: frames });

  const _f32 = (() => {
    const buf = new DataView(new ArrayBuffer(4));
    return (word) => {
      buf.setUint32(0, word >>> 0);
      return buf.getFloat32(0);
    };
  })();

  const _isPtr = (p) => p != null && p >= 0x80000000 && p < 0x80800000 && (p & 3) === 0;

  // The puck moves stick/20 px a frame (mnPlayersVS cursor update), and the
  // game ignores a stick at or under 8.
  const PX_PER_FRAME_PER_STICK = 1 / 20;
  const PULSE_MAX_FRAMES = 40;
  // Longer than the engine's largest input delay (12 frames,
  // ROLLBACK_MAX_DELAY_FRAMES in netplay-rollback.js). A puck that has not
  // moved for this many game frames, all of them after the last frame a
  // stick or button was sent for, has nothing of ours still on its way.
  const SETTLE_FRAMES = 16;

  // One burst of stick that should carry the puck (dx, dy): how many frames
  // to hold it and at what deflection. An axis whose share would be under
  // the smallest deflection the game reads is left for the next burst.
  const _pulse = (dx, dy) => {
    const far = Math.max(Math.abs(dx), Math.abs(dy));
    const frames = Math.min(PULSE_MAX_FRAMES, Math.max(1, Math.ceil(far / (PX_PER_FRAME_PER_STICK * STICK_MAX))));
    const axis = (err) => {
      if (Math.abs(err) <= AIM_TOLERANCE / 2) return 0;
      const mag = Math.min(STICK_MAX, Math.round(Math.abs(err) / (PX_PER_FRAME_PER_STICK * frames)));
      if (mag < STICK_MIN) return 0;
      return err < 0 ? -mag : mag;
    };
    return { input: { ...ZERO, lx: axis(dx), ly: axis(dy) }, hold: frames, release: 0 };
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
   * @param {boolean} [opts.anyFighter]  press A on whatever portrait the
   *   puck reaches, and take the stage the cursor starts on. For a ROM whose
   *   character grid and stage list are not SSB64's (Smash Remix): the menu
   *   structs are where SSB64's are, the layout is not.
   * @param {() => number} [opts.currentFrame]  the game frame read32 is
   *   reading. Needed when an actor is asked for frames ahead of the game
   *   (the demo's fake peer does, while the engine is stalled): those calls
   *   read the same memory and must not count as time gone by. Without it,
   *   the frame an actor is asked for is taken to be the game's.
   */
  const create = ({ read32, log = () => {}, anyFighter = false, currentFrame = null }) => {
    let failed = null;
    let lastScene = -1;
    let sceneSince = 0;
    let frameNow = 0;

    const fail = (why) => {
      if (!failed) {
        failed = why;
        log(\`AUTOPILOT-LAYOUT-MISMATCH \${why}\`);
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
      if (!_isPtr(puck)) return \`slot\${i}.puck=\${puck?.toString(16)}\`;
      const sobj = r32(puck + GOBJ_OBJ);
      if (!_isPtr(sobj)) return \`slot\${i}.puck.obj=\${sobj?.toString(16)}\`;
      const parent = r32(sobj + SOBJ_PARENT);
      if (parent !== puck) return \`slot\${i}.sobj.parent=\${parent?.toString(16)}!=\${puck.toString(16)}\`;
      const x = _f32(r32(sobj + SOBJ_POS_X));
      const y = _f32(r32(sobj + SOBJ_POS_Y));
      if (!(x > -100 && x < 420 && y > -100 && y < 340)) return \`slot\${i}.pos=\${x},\${y}\`;
      return {
        x,
        y,
        fkind: s32(base + SLOT_FKIND),
        cursorStatus: s32(base + SLOT_CURSOR_STATUS),
        heldPlayer: s32(base + SLOT_HELD_PLAYER),
        fighterSelected: s32(base + SLOT_IS_FIGHTER_SELECTED) === 1,
      };
    };

    // Per slot: where the puck was last read, the game frame it was last
    // seen to move, and the first frame after the last stick or button sent.
    const steer = [0, 1].map(() => ({ x: NaN, y: NaN, movedAt: 0, quietFrom: 0 }));

    // Move slot i's puck onto its target portrait, then press A.
    //
    // Input reaches the game some frames after it is decided (the engine's
    // input delay), so what is read here is where the puck was, not where
    // it will be when a press lands. Steering continuously and pressing A
    // on arrival put the press wherever the puck had coasted to: another
    // fighter, or the bar above the portraits, where A toggles Team Battle
    // and changes the stock count. So this moves in bursts and decides only
    // at rest: send a burst, send neutral until the puck has been still for
    // SETTLE_FRAMES, then look. A press sent from rest lands at rest.
    const cssPick = (i, frame) => {
      const slot = readSlot(i);
      if (typeof slot === 'string') return notReady(slot);
      if (slot.fighterSelected) return _idle(6);
      if (slot.heldPlayer !== i) return notReady(\`slot\${i}.held_player=\${slot.heldPlayer}\`);
      const st = steer[i];
      const now = currentFrame ? currentFrame() : frame;
      if (slot.x !== st.x || slot.y !== st.y) st.movedAt = now;
      st.x = slot.x;
      st.y = slot.y;
      if (now - Math.max(st.movedAt, st.quietFrom) < SETTLE_FRAMES) return _idle(1);
      const sending = (action) => {
        st.quietFrom = frame + action.hold;
        return action;
      };
      const target = PORTRAIT_TARGETS[i];
      const dx = target.x - slot.x;
      const dy = target.y - slot.y;
      if (Math.abs(dx) <= AIM_TOLERANCE && Math.abs(dy) <= AIM_TOLERANCE) {
        // On the portrait and at rest. A only selects while grabbing a puck
        // over a fighter. A press the game drops is sent again from rest.
        if (slot.cursorStatus !== CURSOR_GRAB || !(anyFighter || slot.fkind === target.fkind)) return _idle(1);
        return sending(_tap(BTN.A));
      }
      return sending(_pulse(dx, dy));
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
          if (!(opt >= 0 && opt <= 3)) return notReady(\`modeSelectOption=\${opt}\`);
          if (opt < MODE_SELECT_VS) return _tap(BTN.DOWN);
          if (opt > MODE_SELECT_VS) return _tap(BTN.UP);
          return _tap(BTN.A);
        }
        case SCENE.VS_MODE: {
          const cur = s32(VSMODE_CURSOR);
          if (!(cur >= 0 && cur <= 3)) return notReady(\`vsModeCursor=\${cur}\`);
          return cur === VSMODE_START ? _tap(BTN.A) : _tap(BTN.UP);
        }
        case SCENE.PLAYERS_VS:
          return cssBothPicked() ? _tap(BTN.START) : cssPick(0, frame);
        case SCENE.MAPS: {
          if (anyFighter) return _tap(BTN.A);
          const slot = s32(MAPS_CURSOR_SLOT);
          if (!(slot >= 0 && slot <= 9)) return notReady(\`mapsCursorSlot=\${slot}\`);
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
      return cssPick(1, frame);
    };

    return {
      p1: _makeActor(decideP1),
      p2: _makeActor(decideP2),
      failure: () => failed,
    };
  };

  globalThis.KNMenuAutopilot = { create, isSsb64UsRom, SCENE, BTN, PORTRAIT_TARGETS, MAPS_TARGET_SLOT };
})();
`;

type Autopilot = typeof menuAutopilot;
type Create = (options: MenuAutopilotOptions) => MenuAutopilot;

/** The context the old script runs in: it assigns its global here. */
interface OldGlobals {
  KNMenuAutopilot?: Autopilot;
}

const loadOld = (): Autopilot => {
  // The old script assigns globalThis.KNMenuAutopilot; in a new context
  // globalThis is this object.
  const globals: OldGlobals = {};
  vm.runInNewContext(OLD_SCRIPT, globals);
  assert.ok(globals.KNMenuAutopilot, 'the old script did not define KNMenuAutopilot');
  return globals.KNMenuAutopilot;
};

const old = loadOld();

test('the page global has what the old script exposed, with the same constants', () => {
  assert.deepEqual(Object.keys(menuAutopilot).sort(), Object.keys(old).sort());
  assert.deepStrictEqual(SCENE, structuredClone(old.SCENE));
  assert.deepStrictEqual(BTN, structuredClone(old.BTN));
  assert.deepStrictEqual([...PORTRAIT_TARGETS], structuredClone(old.PORTRAIT_TARGETS));
  assert.equal(MAPS_TARGET_SLOT, old.MAPS_TARGET_SLOT);
  assert.equal(menuAutopilot.create, createMenuAutopilot);
});

// ── isSsb64UsRom ─────────────────────────────────────────────────────────────

const header = (name: string, code: string, magic: readonly number[] = [0x80, 0x37, 0x12, 0x40]): Uint8Array => {
  const rom = new Uint8Array(0x40);
  rom.set(magic);
  rom.set(new TextEncoder().encode(name), 0x20);
  rom.set(new TextEncoder().encode(code), 0x3b);
  return rom;
};
const swapped = (rom: Uint8Array, mask: number): Uint8Array => rom.map((_, i) => rom[i ^ mask] ?? 0);

test('isSsb64UsRom: old and new agree on headers in every byte order, and on things that are not ROMs', () => {
  const us = header('SMASH BROTHERS      ', 'NALE');
  const longer = new Uint8Array(0x1000);
  longer.set(us);
  const romLike: Uint8Array[] = [
    us,
    swapped(us, 1),
    swapped(us, 3),
    longer,
    swapped(longer, 1),
    header('SMASH BROTHERS      ', 'NALJ'),
    header('SMASH BROTHERS      ', 'NALP'),
    header('  SMASH BROTHERS    ', 'NALE'),
    header('SMASH BROTHERS', 'NALE'),
    header('SMASH BROTHERS 2    ', 'NALE'),
    header('smash brothers      ', 'NALE'),
    header('SUPER MARIO 64      ', 'NSME'),
    header('SMASH BROTHERS      ', 'NALE', [0x37, 0x80, 0x40, 0x12]),
    header('SMASH BROTHERS      ', 'NALE', [0x40, 0x12, 0x37, 0x80]),
    header('SMASH BROTHERS      ', 'NALE', [0x80, 0x37, 0x12, 0x41]),
    header('SMASH BROTHERS      ', 'NALE', [0, 0, 0, 0]),
    us.slice(0, 0x3f),
    new Uint8Array(0),
    new Uint8Array(0x40),
  ];
  const rand = rng(64);
  for (let i = 0; i < 200; i++) {
    const noise = Uint8Array.from({ length: 0x30 + Math.floor(rand() * 0x40) }, () => Math.floor(rand() * 256));
    romLike.push(noise);
    // A real header with a few bytes knocked out.
    const dented = us.slice();
    for (let k = 0; k < 1 + Math.floor(rand() * 3); k++) dented[Math.floor(rand() * 0x40)] = Math.floor(rand() * 256);
    romLike.push(dented, swapped(dented, 1), swapped(dented, 3));
  }
  let yes = 0;
  for (const rom of romLike) {
    const answer = isSsb64UsRom(rom);
    assert.equal(answer, old.isSsb64UsRom(rom), `bytes ${rom.slice(0, 0x40)}`);
    const buffer = new ArrayBuffer(rom.length);
    new Uint8Array(buffer).set(rom);
    assert.equal(isSsb64UsRom(buffer), old.isSsb64UsRom(buffer));
    assert.equal(isSsb64UsRom(buffer), answer);
    assert.equal(isSsb64UsRom([...rom]), old.isSsb64UsRom([...rom]));
    if (answer) yes++;
  }
  assert.ok(isSsb64UsRom(us) && isSsb64UsRom(swapped(us, 1)) && isSsb64UsRom(swapped(us, 3)));
  assert.ok(yes >= 5, `only ${yes} of the samples were the US ROM`);
});

// ── the same memory on the same frames ───────────────────────────────────────

/**
 * An autopilot whose every read, every answer and every log line goes on a
 * tape: [-1, addr] for a read, [-2 or -3, frame, buttons, lx, ly, cx, cy] for
 * P1's or P2's input for a frame.
 */
const taped = (create: Create) => {
  const tape: number[] = [];
  const logs: string[] = [];
  let made: MenuAutopilot | null = null;
  const actor =
    (mark: number, inner: PilotActor): PilotActor =>
    (frame) => {
      const out = inner(frame);
      tape.push(mark, frame, out.buttons, out.lx, out.ly, out.cx, out.cy);
      return out;
    };
  const wrapped: Create = (options) => {
    const pilot = create({
      ...options,
      read32: (addr) => {
        tape.push(-1, addr);
        return options.read32(addr);
      },
      log: (msg) => {
        logs.push(msg);
        options.log?.(msg);
      },
    });
    made = { p1: actor(-2, pilot.p1), p2: actor(-3, pilot.p2), failure: pilot.failure };
    return made;
  };
  return { create: wrapped, tape, logs, failure: (): string | null => made?.failure() ?? null };
};

/** Where two tapes first differ, or -1. */
const firstDifference = (a: readonly number[], b: readonly number[]): number => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
};

const sameTapes = (mine: ReturnType<typeof taped>, theirs: ReturnType<typeof taped>, at: string): void => {
  const i = firstDifference(mine.tape, theirs.tape);
  assert.equal(
    i,
    -1,
    `${at}: tapes differ at ${i}: new ${mine.tape.slice(Math.max(0, i - 7), i + 7)} old ${theirs.tape.slice(Math.max(0, i - 7), i + 7)}`,
  );
  assert.deepEqual(mine.logs, theirs.logs, at);
  assert.equal(mine.failure(), theirs.failure(), at);
};

test('simulated menus: old and new read the same words and send the same input on every frame', () => {
  const runs: MenuRun[] = [];
  for (let delay = 0; delay <= 14; delay++) {
    for (let seed = 1; seed <= 6; seed++) {
      const r = rng(seed * 104729 + delay);
      runs.push({
        seed: seed + delay * 1000,
        delayP1: delay,
        delayP2: Math.max(0, delay - Math.floor(r() * 3)),
        dropProb: r() * 0.3,
        mapsStart: Math.floor(r() * 10),
        stageSelect: r() < 0.8,
        maxFrames: 9000,
        lookaheadP2: seed % 3 === 0 ? 6 : 0,
      });
    }
  }
  // Runs that never get there: most presses dropped.
  for (let seed = 1; seed <= 6; seed++) {
    runs.push({ seed, delayP1: 3, delayP2: 5, dropProb: 0.95, mapsStart: 2, maxFrames: 2500 });
  }
  let reached = 0;
  let frames = 0;
  for (const run of runs) {
    const mine = taped(createMenuAutopilot);
    const theirs = taped(old.create);
    const myResult = simulate(mine.create, run);
    const theirResult = simulate(theirs.create, run);
    sameTapes(mine, theirs, JSON.stringify(run));
    assert.deepEqual(myResult, theirResult, JSON.stringify(run));
    if (myResult.ok) {
      reached++;
      frames += myResult.frame;
    }
  }
  assert.ok(reached >= 90, `only ${reached} runs reached the battle`);
  assert.ok(frames > 50_000, `only ${frames} frames compared`);
});

// Memory the simulator never shows the autopilot: scenes it does not know,
// words that cannot be read, pointers that do not validate, a puck that
// jumps, frames asked for out of order.

const ADDR = {
  scene: 0x800a4ad0,
  modeOpt: 0x80132c88,
  vsCursor: 0x80134948,
  slots: 0x8013ba88,
  slotSize: 0xbc,
  mapsSlot: 0x80134bd8,
};

const floatBits = (f: number): number => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, f);
  return view.getUint32(0);
};

/** One of the list, by a roll in [0, 1). */
const oneOf = (list: readonly number[], roll: number): number => list[Math.floor(roll * list.length)] ?? 0;

const SCENES_SEEN = [...Object.values(SCENE), 0, 8, 10, 30, 45, 57, 255];

/**
 * A memory that changes a little each step, shared by the two autopilots
 * reading it. `sceneChange` is the chance per step that the scene changes.
 */
const wanderingMemory = (rand: () => number, sceneChange: number) => {
  const mem = new Map<number, number>();
  const unreadable = new Set<number>();
  let unreadableAs: null | undefined = null;
  const set = (addr: number, value: number) => mem.set(addr >>> 0, value >>> 0);
  const layOutSlot = (i: number): void => {
    const base = ADDR.slots + i * ADDR.slotSize;
    const puck = 0x80200000 + i * 0x100;
    const sobj = 0x80210000 + i * 0x100;
    const kind = rand();
    // Mostly a slot that validates; sometimes a null, unaligned or out-of-range pointer, or a wrong back-pointer.
    set(base + 0x04, kind < 0.85 ? puck : oneOf([0, puck + 2, 0x80900000, 0x12345678], rand()));
    set(puck + 0x74, kind < 0.9 ? sobj : oneOf([0, sobj + 1, 0x7fffff00], rand()));
    set(sobj + 0x04, kind < 0.95 ? puck : puck + 4);
  };
  const movePuck = (i: number): void => {
    const sobj = 0x80210000 + i * 0x100;
    const target = PORTRAIT_TARGETS[i === 0 ? 0 : 1];
    const near = rand() < 0.6;
    const x = near ? target.x + (rand() - 0.5) * 30 : rand() * 600 - 150;
    const y = near ? target.y + (rand() - 0.5) * 30 : rand() * 500 - 150;
    set(sobj + 0x58, floatBits(x));
    set(sobj + 0x5c, floatBits(y));
  };
  const setSlotFields = (i: number): void => {
    const base = ADDR.slots + i * ADDR.slotSize;
    set(base + 0x48, oneOf([0, 2, 28, 5, 0, 2], rand()));
    set(base + 0x54, oneOf([0, 1, 1, 1, 2], rand()));
    set(base + 0x80, oneOf([i, i, i, i, -1, 1 - i], rand()));
    set(base + 0x88, oneOf([0, 0, 0, 1, 2], rand()));
  };
  set(ADDR.scene, SCENE.STARTUP << 24);
  for (const i of [0, 1]) {
    layOutSlot(i);
    movePuck(i);
    setSlotFields(i);
  }
  const step = (): void => {
    if (rand() < sceneChange) set(ADDR.scene, (oneOf(SCENES_SEEN, rand()) << 24) | Math.floor(rand() * 0x1000000));
    if (rand() < 0.05) set(ADDR.modeOpt, rand() < 0.9 ? Math.floor(rand() * 5) - 1 : Math.floor(rand() * 2 ** 32));
    if (rand() < 0.05) set(ADDR.vsCursor, rand() < 0.9 ? Math.floor(rand() * 5) - 1 : Math.floor(rand() * 2 ** 32));
    if (rand() < 0.05) set(ADDR.mapsSlot, rand() < 0.9 ? Math.floor(rand() * 11) - 1 : Math.floor(rand() * 2 ** 32));
    for (const i of [0, 1]) {
      if (rand() < 0.004) layOutSlot(i);
      if (rand() < 0.03) movePuck(i);
      if (rand() < 0.03) setSlotFields(i);
    }
    unreadable.clear();
    if (rand() < 0.02) {
      unreadableAs = rand() < 0.5 ? null : undefined;
      const all = [ADDR.scene, ADDR.modeOpt, ADDR.vsCursor, ADDR.mapsSlot, ...mem.keys()];
      for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) unreadable.add(oneOf(all, rand()));
    }
  };
  const read32 = (addr: number): number | null | undefined =>
    unreadable.has(addr) ? unreadableAs : (mem.get(addr >>> 0) ?? 0);
  return { step, read32, set };
};

test('wandering memory: old and new agree on every read and every input, whatever the game shows', () => {
  let pressed = 0;
  let sticks = 0;
  let failures = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const rand = rng(seed * 2654435761);
    // A scene that stays long enough for unreadable state to count as a mismatch, on half the runs.
    const memory = wanderingMemory(rand, seed % 2 === 0 ? 0.02 : 0.001);
    // A scene to start from, so most runs spend time on a menu.
    memory.set(ADDR.scene, oneOf([SCENE.PLAYERS_VS, SCENE.PLAYERS_VS, SCENE.MODE_SELECT, SCENE.MAPS], rand()) << 24);
    let gameFrame = 0;
    const withGameFrame = seed % 3 !== 0;
    const options: MenuAutopilotOptions = {
      read32: memory.read32,
      anyFighter: seed % 4 === 0,
      currentFrame: withGameFrame ? () => gameFrame : seed % 2 === 0 ? null : undefined,
    };
    const mine = taped(createMenuAutopilot);
    const theirs = taped(old.create);
    const pilots = [mine.create(options), theirs.create(options)];
    const lookahead = seed % 5 === 0 ? 8 : 0;
    let asked2 = 0;
    for (let frame = 0; frame < 4000; frame++) {
      memory.step();
      // The game sometimes stalls while frames go on being asked for.
      if (rand() < 0.97) gameFrame = frame;
      const again = rand() < 0.05 ? Math.max(0, frame - Math.floor(rand() * 300)) : -1;
      for (const pilot of pilots) {
        const out = pilot.p1(frame);
        for (let f = asked2; f <= frame + lookahead; f++) pilot.p2(f);
        if (again >= 0) {
          pilot.p1(again);
          pilot.p2(again);
        }
        if (pilot === pilots[0]) {
          if (out.buttons) pressed++;
          if (out.lx || out.ly) sticks++;
        }
      }
      asked2 = frame + lookahead + 1;
    }
    sameTapes(mine, theirs, `seed ${seed}`);
    if (mine.failure() !== null) failures++;
  }
  assert.ok(pressed > 2000, `buttons were held on only ${pressed} frames`);
  assert.ok(sticks > 1000, `the stick was held on only ${sticks} frames`);
  assert.ok(failures > 5 && failures < 80, `${failures} of 80 runs ended in a layout mismatch`);
});
