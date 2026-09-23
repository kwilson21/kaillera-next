// Drives web/static/ssb64-menu-autopilot.js against a simulated SSB64 menu
// flow built from the decomp's rules (github.com/VetriTheRetri/ssb-decomp-re):
// tap-edge input, a 10-tic input lockout per scene, variable scene load time
// with stale memory while loading, CSS cursor speed stick/20, puck → portrait
// mapping with locked fighters, the CSS ready/Start rules, and stage-select
// scrolling. The autopilot sees memory only through read32, with input delay
// and randomly dropped presses, and must reach the VS battle every time.
//
//   node --test tests/ssb64-menu-autopilot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/static/ssb64-menu-autopilot.js'));
const { create, isSsb64UsRom, SCENE, BTN, MAPS_TARGET_SLOT } = globalThis.KNMenuAutopilot;

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

const rng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

function simulate({ seed, delayP1, delayP2, dropProb, mapsStart, stageSelect = true, maxFrames = 6000 }) {
  const rand = rng(seed);
  const mem = new Map();
  const w32 = (addr, v) => mem.set(addr >>> 0, v >>> 0);
  const f32bits = (f) => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, f);
    return dv.getUint32(0);
  };
  const setScene = (sc) => w32(A.scene, (sc << 24) | 0x00ab12);
  const garbage = () => {
    // Loading: the next overlay's variables are whatever was there before.
    for (const a of [A.modeOpt, A.vsCursor, A.mapsSlot]) w32(a, Math.floor(rand() * 2 ** 32));
    for (let i = 0; i < 4; i++) {
      for (let off = 0; off < SLOT.size; off += 4) w32(A.slots + i * SLOT.size + off, Math.floor(rand() * 2 ** 32));
    }
  };

  let scene = SCENE.STARTUP;
  let loading = 0;
  let tics = 0;
  let pending = null; // scene to enter after loading
  let modeOpt = 0;
  let vsCursor = 0;
  let mapsSlot = mapsStart;
  let mapsScrollWait = 0;
  let proceedWait = 0;
  let isStart = false;
  const slots = [0, 1].map((i) => ({
    cursor: { x: 60 + 70 * i, y: 170 },
    puckGobj: 0x80200000 + i * 0x100,
    puckSobj: 0x80210000 + i * 0x100,
    fkind: NULL_FKIND,
    selected: false,
    held: i,
    status: 0,
  }));
  const puckPos = (s) => ({ x: s.cursor.x + 11, y: s.cursor.y - 14 });
  const puckFkind = (s) => {
    const p = puckPos(s);
    const px = Math.trunc(p.x) + 13;
    const py = Math.trunc(p.y) + 12;
    let idx = -1;
    if (py > 35 && py < 79 && px > 24 && px < 295) idx = Math.trunc((px - 25) / 45);
    else if (py > 78 && py < 122 && px > 24 && px < 295) idx = Math.trunc((px - 25) / 45) + 6;
    if (idx < 0) return NULL_FKIND;
    const fk = PORTRAIT_FKINDS[idx];
    return LOCKED.has(fk) ? NULL_FKIND : fk;
  };

  const writeState = () => {
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

  const goTo = (next) => {
    pending = next;
    loading = 10 + Math.floor(rand() * 70);
    garbage();
  };

  const pilot = create({ read32: (addr) => mem.get(addr >>> 0) ?? 0, log: () => {} });
  const q1 = [];
  const q2 = [];
  let prev = [0, 0];
  const trace = [];

  for (let frame = 0; frame < maxFrames; frame++) {
    writeState();
    if (scene === SCENE.VS_BATTLE && loading === 0) return { ok: true, frame, slots, mapsSlot, trace };
    q1.push(pilot.p1(frame));
    q2.push(pilot.p2(frame));
    const in1 = q1.length > delayP1 ? q1.shift() : { buttons: 0, lx: 0, ly: 0 };
    const in2 = q2.length > delayP2 ? q2.shift() : { buttons: 0, lx: 0, ly: 0 };
    const inputs = [in1, in2];
    // A dropped press: the game doesn't see this frame's buttons (e.g. it
    // landed inside a transition).
    const btns = inputs.map((inp) => (rand() < dropProb ? 0 : inp.buttons));
    const taps = btns.map((b, i) => b & ~prev[i]);
    prev = btns;
    const anyTap = taps[0] | taps[1];
    const anyHold = btns[0] | btns[1];

    if (loading > 0) {
      if (--loading === 0) {
        scene = pending;
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
        if (anyTap & (BTN.A | BTN.START)) goTo([8, SCENE.VS_MODE, 57, 58][modeOpt]);
        else if (anyTap & BTN.B) goTo(SCENE.TITLE);
        else if (anyTap & BTN.UP) modeOpt = (modeOpt + 3) % 4;
        else if (anyTap & BTN.DOWN) modeOpt = (modeOpt + 1) % 4;
        break;
      case SCENE.VS_MODE:
        if (!ready) break;
        if (anyTap & (BTN.A | BTN.START)) goTo([SCENE.PLAYERS_VS, 9, 9, 10][vsCursor]);
        else if (anyTap & BTN.B) goTo(SCENE.MODE_SELECT);
        else if (anyTap & BTN.UP) vsCursor = (vsCursor + 3) % 4;
        else if (anyTap & BTN.DOWN) vsCursor = (vsCursor + 1) % 4;
        break;
      case SCENE.PLAYERS_VS: {
        if (isStart) {
          if (--proceedWait === 0) goTo(stageSelect ? SCENE.MAPS : SCENE.VS_BATTLE);
          break;
        }
        slots.forEach((s, i) => {
          const inp = inputs[i];
          if (Math.abs(inp.lx) > 8) s.cursor.x += inp.lx / 20;
          if (Math.abs(inp.ly) > 8) s.cursor.y += inp.ly / 20; // ly<0 = up = y decreases
          s.cursor.x = Math.max(0, Math.min(300, s.cursor.x));
          s.cursor.y = Math.max(0, Math.min(230, s.cursor.y));
          if (s.cursor.y > 122 || s.cursor.y < 36) s.status = 0;
          else if (s.selected) s.status = 2;
          else s.status = 1;
          if (!s.selected) s.fkind = puckFkind(s);
          if (ready && taps[i] & BTN.A && s.status === 1 && s.fkind !== NULL_FKIND) {
            s.selected = true;
            s.held = -1;
            s.status = 2;
          }
        });
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
        if (anyHold & BTN.DOWN && mapsSlot < 5) (mapsSlot += 5), (mapsScrollWait = 12);
        else if (anyHold & BTN.UP && mapsSlot >= 5) (mapsSlot -= 5), (mapsScrollWait = 12);
        else if (anyHold & BTN.RIGHT) (mapsSlot = mapsSlot === 9 ? 0 : mapsSlot + 1), (mapsScrollWait = 12);
        else if (anyHold & BTN.LEFT) (mapsSlot = mapsSlot === 0 ? 9 : mapsSlot - 1), (mapsScrollWait = 12);
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
  return { ok: false, scene, pending, slots, mapsSlot, failure: pilot.failure(), trace };
}

test('reaches the VS battle with both fighters picked, across seeds, delays and dropped presses', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed * 7919);
    const opts = {
      seed,
      delayP1: 2 + Math.floor(r() * 4),
      delayP2: 2 + Math.floor(r() * 4),
      dropProb: r() * 0.3,
      mapsStart: [0, 1, 2, 3, 5, 7, 8, 9][Math.floor(r() * 8)],
      stageSelect: r() < 0.8,
    };
    const res = simulate(opts);
    assert.ok(res.ok, `seed ${seed} ${JSON.stringify(opts)} stuck: ${JSON.stringify(res)}`);
    assert.equal(res.slots[0].fkind, 0, `seed ${seed}: P1 should be Mario`);
    assert.equal(res.slots[1].fkind, 2, `seed ${seed}: P2 should be DK`);
    if (opts.stageSelect) assert.equal(res.mapsSlot, MAPS_TARGET_SLOT, `seed ${seed}: stage`);
    assert.ok(res.frame < 3600, `seed ${seed}: took ${res.frame} frames`);
  }
});

test('stops on a layout mismatch instead of steering blind', () => {
  // CSS pointers that never validate (e.g. a different ROM revision).
  const mem = new Map([[0x800a4ad0, SCENE.PLAYERS_VS << 24]]);
  const logs = [];
  const pilot = create({ read32: (a) => mem.get(a >>> 0) ?? 0, log: (m) => logs.push(m) });
  let pressed = 0;
  for (let f = 0; f < 400; f++) {
    const a = pilot.p1(f);
    const b = pilot.p2(f);
    pressed |= a.buttons | b.buttons | a.lx | a.ly | b.lx | b.ly;
  }
  assert.equal(pressed, 0);
  assert.match(pilot.failure() ?? '', /slot0\.puck/);
  assert.ok(logs.some((m) => m.startsWith('AUTOPILOT-LAYOUT-MISMATCH')));
});

test('repeated reads of a frame return the same input', () => {
  const mem = new Map([[0x800a4ad0, SCENE.TITLE << 24]]);
  const pilot = create({ read32: (a) => mem.get(a >>> 0) ?? 0 });
  const first = [0, 1, 2, 3].map((f) => pilot.p1(f).buttons);
  mem.set(0x800a4ad0, SCENE.MODE_SELECT << 24);
  assert.deepEqual(
    [0, 1, 2, 3].map((f) => pilot.p1(f).buttons),
    first,
  );
  assert.equal(first[0], BTN.START);
});

test('recognizes the US ROM header in all three byte orders', () => {
  const z64 = new Uint8Array(0x40);
  z64.set([0x80, 0x37, 0x12, 0x40]);
  z64.set(new TextEncoder().encode('SMASH BROTHERS      '), 0x20);
  z64.set(new TextEncoder().encode('NALE'), 0x3b);
  const swap = (b, mask) => b.map((_, i) => b[i ^ mask]);
  assert.ok(isSsb64UsRom(z64));
  assert.ok(isSsb64UsRom(swap(z64, 1)));
  assert.ok(isSsb64UsRom(swap(z64, 3)));
  const jp = z64.slice();
  jp[0x3e] = 'J'.charCodeAt(0);
  assert.ok(!isSsb64UsRom(jp));
  assert.ok(!isSsb64UsRom(new Uint8Array(0x40)));
});
