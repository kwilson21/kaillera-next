// A simulated SSB64 menu flow for the menu autopilot, built from the
// decomp's rules (github.com/VetriTheRetri/ssb-decomp-re): tap-edge input, a
// 10-tic input lockout per scene, variable scene load time with stale memory
// while loading, CSS cursor speed stick/20, puck → portrait mapping with
// locked fighters, the CSS ready/Start rules, and stage-select scrolling.
// The autopilot sees memory only through read32, with input delay and
// randomly dropped presses.
//
// Used by tests/ssb64-menu-autopilot.test.mjs (does the autopilot reach the
// battle) and tests/ts/page-menu-autopilot.test.ts (does it press what the
// script it replaced pressed). The autopilot under test is passed in.
import { BTN, SCENE, type MenuAutopilot, type MenuAutopilotOptions } from '../../web/src/page/menu-autopilot.ts';

// Same addresses/offsets the module uses, restated so a typo there fails here.
const A = {
  scene: 0x800a4ad0,
  modeOpt: 0x80132c88,
  vsCursor: 0x80134948,
  slots: 0x8013ba88,
  mapsSlot: 0x80134bd8,
};
const SLOT = { size: 0xbc, puck: 0x04, fkind: 0x48, status: 0x54, held: 0x80, selected: 0x88 };
const PORTRAIT_FKINDS = [4, 0, 2, 5, 3, 7, 11, 6, 8, 1, 9, 10]; // mnPlayersVSGetFighterKind
const LOCKED = new Set([4, 11, 7, 10]); // Luigi, Ness, Falcon, Jigglypuff on a fresh save
const NULL_FKIND = 28;

/** A seeded generator (linear congruential), so a run can be repeated. */
export const rng = (seed: number) => (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** One simulated run. */
export interface MenuRun {
  readonly seed: number;
  /** Frames between an input being sent and the game seeing it. */
  readonly delayP1: number;
  readonly delayP2: number;
  /** Chance that the game misses a frame's buttons. */
  readonly dropProb: number;
  /** The stage cursor's first slot. */
  readonly mapsStart: number;
  readonly stageSelect?: boolean;
  readonly maxFrames?: number;
  /**
   * P2's actor is asked for this many frames past the one being simulated,
   * as the demo's fake peer does while the engine is stalled. Those calls
   * read the same memory: no game frame has gone by between them.
   */
  readonly lookaheadP2?: number;
}

/** A character-select slot of the simulated game. */
export interface SimSlot {
  readonly cursor: { x: number; y: number };
  readonly puckGobj: number;
  readonly puckSobj: number;
  fkind: number;
  selected: boolean;
  held: number;
  status: number;
}

/** How a run ended: in the battle, or out of frames. */
export type MenuResult =
  | {
      readonly ok: true;
      readonly frame: number;
      readonly slots: readonly SimSlot[];
      readonly mapsSlot: number;
      readonly trace: readonly string[];
      readonly strayPresses: number;
    }
  | {
      readonly ok: false;
      readonly scene: number;
      readonly pending: number | null;
      readonly slots: readonly SimSlot[];
      readonly mapsSlot: number;
      readonly failure: string | null;
      readonly trace: readonly string[];
      readonly strayPresses: number;
    };

/** What reaches the game for a frame: buttons and the stick. */
interface SimInput {
  readonly buttons: number;
  readonly lx: number;
  readonly ly: number;
}

/** The scene a menu option leads to. */
const sceneFor = (options: readonly number[], index: number): number => {
  const next = options[index];
  if (next === undefined) throw new Error(`no menu option ${index}`);
  return next;
};

/** Run the menus from power-on with `create`'s autopilot at the controls. */
export const simulate = (create: (options: MenuAutopilotOptions) => MenuAutopilot, run: MenuRun): MenuResult => {
  const { seed, delayP1, delayP2, dropProb, mapsStart } = run;
  const stageSelect = run.stageSelect ?? true;
  const maxFrames = run.maxFrames ?? 6000;
  const lookaheadP2 = run.lookaheadP2 ?? 0;
  const rand = rng(seed);
  const mem = new Map<number, number>();
  const w32 = (addr: number, v: number) => mem.set(addr >>> 0, v >>> 0);
  const f32bits = (f: number): number => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, f);
    return dv.getUint32(0);
  };
  const setScene = (sc: number) => w32(A.scene, (sc << 24) | 0x00ab12);
  const garbage = (): void => {
    // Loading: the next overlay's variables are whatever was there before.
    for (const a of [A.modeOpt, A.vsCursor, A.mapsSlot]) w32(a, Math.floor(rand() * 2 ** 32));
    for (let i = 0; i < 4; i++) {
      for (let off = 0; off < SLOT.size; off += 4) w32(A.slots + i * SLOT.size + off, Math.floor(rand() * 2 ** 32));
    }
  };

  let scene = SCENE.STARTUP;
  let loading = 0;
  let tics = 0;
  /** The scene to enter after loading. */
  let pending: number | null = null;
  let modeOpt = 0;
  let vsCursor = 0;
  let mapsSlot = mapsStart;
  let mapsScrollWait = 0;
  let proceedWait = 0;
  let isStart = false;
  // A presses that landed on the bar above the portraits. In the game that
  // bar holds the Free-For-All / Team Battle toggle and the stock arrows.
  let strayPresses = 0;
  const newSlot = (i: number): SimSlot => ({
    cursor: { x: 60 + 70 * i, y: 170 },
    puckGobj: 0x80200000 + i * 0x100,
    puckSobj: 0x80210000 + i * 0x100,
    fkind: NULL_FKIND,
    selected: false,
    held: i,
    status: 0,
  });
  const slots: readonly [SimSlot, SimSlot] = [newSlot(0), newSlot(1)];
  const puckPos = (s: SimSlot) => ({ x: s.cursor.x + 11, y: s.cursor.y - 14 });
  const puckFkind = (s: SimSlot): number => {
    const p = puckPos(s);
    const px = Math.trunc(p.x) + 13;
    const py = Math.trunc(p.y) + 12;
    let idx = -1;
    if (py > 35 && py < 79 && px > 24 && px < 295) idx = Math.trunc((px - 25) / 45);
    else if (py > 78 && py < 122 && px > 24 && px < 295) idx = Math.trunc((px - 25) / 45) + 6;
    if (idx < 0) return NULL_FKIND;
    const fk = PORTRAIT_FKINDS[idx];
    if (fk === undefined) throw new Error(`no portrait ${idx}`);
    return LOCKED.has(fk) ? NULL_FKIND : fk;
  };

  const writeState = (): void => {
    setScene(pending ?? scene);
    if (loading > 0) return;
    if (scene === SCENE.MODE_SELECT) w32(A.modeOpt, modeOpt);
    if (scene === SCENE.VS_MODE) w32(A.vsCursor, vsCursor);
    if (scene === SCENE.MAPS) w32(A.mapsSlot, mapsSlot);
    if (scene === SCENE.PLAYERS_VS) {
      slots.forEach((s, i) => {
        const base = A.slots + i * SLOT.size;
        w32(base + SLOT.puck, s.puckGobj);
        w32(s.puckGobj + 0x74, s.puckSobj);
        w32(s.puckSobj + 0x04, s.puckGobj);
        const p = puckPos(s);
        w32(s.puckSobj + 0x58, f32bits(p.x));
        w32(s.puckSobj + 0x5c, f32bits(p.y));
        w32(base + SLOT.fkind, s.fkind);
        w32(base + SLOT.status, s.status);
        w32(base + SLOT.held, s.held);
        w32(base + SLOT.selected, s.selected ? 1 : 0);
      });
    }
  };

  const goTo = (next: number): void => {
    pending = next;
    loading = 10 + Math.floor(rand() * 70);
    garbage();
  };

  let simFrame = 0;
  const pilot = create({
    read32: (addr) => mem.get(addr >>> 0) ?? 0,
    log: () => undefined,
    currentFrame: () => simFrame,
  });
  const NEUTRAL: SimInput = { buttons: 0, lx: 0, ly: 0 };
  const sent1: SimInput[] = [];
  const sent2: SimInput[] = [];
  let prev1 = 0;
  let prev2 = 0;
  const trace: string[] = [];

  /** One slot's frame on the character select: move the cursor, then take an A press. */
  const stepSlot = (s: SimSlot, inp: SimInput, tapped: number, ready: boolean): void => {
    if (Math.abs(inp.lx) > 8) s.cursor.x += inp.lx / 20;
    if (Math.abs(inp.ly) > 8) s.cursor.y += inp.ly / 20; // ly<0 = up = y decreases
    s.cursor.x = Math.max(0, Math.min(300, s.cursor.x));
    s.cursor.y = Math.max(0, Math.min(230, s.cursor.y));
    if (s.cursor.y > 122 || s.cursor.y < 36) s.status = 0;
    else if (s.selected) s.status = 2;
    else s.status = 1;
    if (!s.selected) s.fkind = puckFkind(s);
    if (tapped & BTN.A && s.cursor.y < 36) strayPresses++;
    if (ready && tapped & BTN.A && s.status === 1 && s.fkind !== NULL_FKIND) {
      s.selected = true;
      s.held = -1;
      s.status = 2;
    }
  };

  for (let frame = 0; frame < maxFrames; frame++) {
    writeState();
    if (scene === SCENE.VS_BATTLE && loading === 0) return { ok: true, frame, slots, mapsSlot, trace, strayPresses };
    simFrame = frame;
    sent1[frame] = pilot.p1(frame);
    for (let f = sent2.length; f <= frame + lookaheadP2; f++) sent2[f] = pilot.p2(f);
    // The input sent for a frame reaches the game an input delay later.
    const in1 = sent1[frame - delayP1] ?? NEUTRAL;
    const in2 = sent2[frame - delayP2] ?? NEUTRAL;
    // A dropped press: the game doesn't see this frame's buttons (e.g. it
    // landed inside a transition).
    const btn1 = rand() < dropProb ? 0 : in1.buttons;
    const btn2 = rand() < dropProb ? 0 : in2.buttons;
    const tap1 = btn1 & ~prev1;
    const tap2 = btn2 & ~prev2;
    prev1 = btn1;
    prev2 = btn2;
    const anyTap = tap1 | tap2;
    const anyHold = btn1 | btn2;

    if (loading > 0) {
      if (--loading === 0) {
        scene = pending ?? scene;
        pending = null;
        tics = 0;
        trace.push(`${frame}:${scene}`);
        if (scene === SCENE.MODE_SELECT) modeOpt = 0; // from title: 1P Game
        if (scene === SCENE.VS_MODE) vsCursor = 0;
        if (scene === SCENE.MAPS) mapsScrollWait = 0;
      }
      continue;
    }
    tics++;
    const ready = tics >= 10;

    switch (scene) {
      case SCENE.STARTUP:
        if (tics > 120 || (ready && anyTap & BTN.START)) goTo(SCENE.OPENING_FIRST);
        break;
      case SCENE.TITLE:
        if (ready && anyTap & (BTN.START | BTN.A)) goTo(SCENE.MODE_SELECT);
        else if (tics > 900) goTo(SCENE.AUTO_DEMO);
        break;
      case SCENE.AUTO_DEMO:
        if (ready && anyTap & BTN.START) goTo(SCENE.TITLE);
        break;
      case SCENE.MODE_SELECT:
        if (!ready) break;
        if (anyTap & (BTN.A | BTN.START)) goTo(sceneFor([8, SCENE.VS_MODE, 57, 58], modeOpt));
        else if (anyTap & BTN.B) goTo(SCENE.TITLE);
        else if (anyTap & BTN.UP) modeOpt = (modeOpt + 3) % 4;
        else if (anyTap & BTN.DOWN) modeOpt = (modeOpt + 1) % 4;
        break;
      case SCENE.VS_MODE:
        if (!ready) break;
        if (anyTap & (BTN.A | BTN.START)) goTo(sceneFor([SCENE.PLAYERS_VS, 9, 9, 10], vsCursor));
        else if (anyTap & BTN.B) goTo(SCENE.MODE_SELECT);
        else if (anyTap & BTN.UP) vsCursor = (vsCursor + 3) % 4;
        else if (anyTap & BTN.DOWN) vsCursor = (vsCursor + 1) % 4;
        break;
      case SCENE.PLAYERS_VS: {
        if (isStart) {
          if (--proceedWait === 0) goTo(stageSelect ? SCENE.MAPS : SCENE.VS_BATTLE);
          break;
        }
        stepSlot(slots[0], in1, tap1, ready);
        stepSlot(slots[1], in2, tap2, ready);
        const readyCount = slots.filter((s) => s.selected).length;
        const noGrab = slots.every((s) => s.status !== 1);
        if (anyTap & BTN.START && tics > 60 && readyCount >= 2 && noGrab) {
          isStart = true;
          proceedWait = 30;
        }
        break;
      }
      case SCENE.MAPS: {
        if (!ready) break;
        if (anyTap & (BTN.A | BTN.START)) {
          goTo(SCENE.VS_BATTLE);
          break;
        }
        if (!(anyHold & (BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT))) mapsScrollWait = 0;
        if (mapsScrollWait > 0) {
          mapsScrollWait--;
          break;
        }
        if (anyHold & BTN.DOWN && mapsSlot < 5) {
          mapsSlot += 5;
          mapsScrollWait = 12;
        } else if (anyHold & BTN.UP && mapsSlot >= 5) {
          mapsSlot -= 5;
          mapsScrollWait = 12;
        } else if (anyHold & BTN.RIGHT) {
          mapsSlot = mapsSlot === 9 ? 0 : mapsSlot + 1;
          mapsScrollWait = 12;
        } else if (anyHold & BTN.LEFT) {
          mapsSlot = mapsSlot === 0 ? 9 : mapsSlot - 1;
          mapsScrollWait = 12;
        }
        break;
      }
      default:
        // Intro movies: Start skips to the title; they also chain on their own.
        if (scene >= SCENE.OPENING_FIRST && scene <= SCENE.OPENING_LAST) {
          if (ready && anyTap & BTN.START) goTo(SCENE.TITLE);
          else if (tics > 200) goTo(scene === SCENE.OPENING_LAST ? SCENE.TITLE : scene + 1);
        } else if (ready && anyTap & BTN.B) {
          goTo(SCENE.MODE_SELECT); // any wrong-turn menu backs out
        }
    }
  }
  return { ok: false, scene, pending, slots, mapsSlot, failure: pilot.failure(), trace, strayPresses };
};
