// Drives the menu autopilot (web/src/page/menu-autopilot.ts) against a
// simulated SSB64 menu flow built from the decomp's rules
// (tests/ts/menu-sim.ts): tap-edge input, a 10-tic input lockout per scene,
// variable scene load time with stale memory while loading, CSS cursor speed
// stick/20, puck → portrait mapping with locked fighters, the CSS ready/Start
// rules, and stage-select scrolling. The autopilot sees memory only through
// read32, with input delay and randomly dropped presses, and must reach the
// VS battle every time.
//
//   node --test tests/ssb64-menu-autopilot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuAutopilot } from '../web/src/page/menu-autopilot.ts';
import { rng, simulate as simulateWith } from './ts/menu-sim.ts';

const { create, isSsb64UsRom, SCENE, BTN, MAPS_TARGET_SLOT } = menuAutopilot;

const simulate = (opts) => simulateWith(create, opts);

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

// The engine's input delay goes up to 12 frames (ROLLBACK_MAX_DELAY_FRAMES)
// and a slow machine negotiates the top of that range. A press decided on
// where the puck is now lands where the puck is that many frames later.
test('picks the right fighters and presses nothing else at every input delay up to 14 frames', () => {
  for (let delay = 0; delay <= 14; delay++) {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 104729 + delay);
      const opts = {
        seed: seed + delay * 1000,
        delayP1: delay,
        delayP2: Math.max(0, delay - Math.floor(r() * 3)),
        dropProb: r() * 0.2,
        mapsStart: [0, 1, 2, 3, 5, 7, 8, 9][Math.floor(r() * 8)],
        stageSelect: true,
        maxFrames: 9000,
      };
      const res = simulate(opts);
      const at = `delay ${delay} seed ${seed}`;
      assert.ok(res.ok, `${at} stuck: ${JSON.stringify({ ...res, trace: undefined })}`);
      assert.equal(res.slots[0].fkind, 0, `${at}: P1 should be Mario`);
      assert.equal(res.slots[1].fkind, 2, `${at}: P2 should be DK`);
      assert.equal(res.strayPresses, 0, `${at}: A pressed on the bar above the portraits`);
    }
  }
});

test('an actor asked for frames ahead of the game does not take them for time gone by', () => {
  for (const delay of [0, 4, 8, 10, 11, 12, 13, 14]) {
    for (let seed = 1; seed <= 40; seed++) {
      const opts = {
        seed: seed + delay * 1000,
        delayP1: delay,
        delayP2: delay,
        dropProb: 0.1,
        mapsStart: 5,
        stageSelect: true,
        maxFrames: 9000,
        lookaheadP2: 6,
      };
      const res = simulate(opts);
      const at = `delay ${delay} seed ${seed}`;
      assert.ok(res.ok, `${at} stuck: ${JSON.stringify({ ...res, trace: undefined })}`);
      assert.equal(res.slots[1].fkind, 2, `${at}: P2 should be DK`);
      assert.equal(res.strayPresses, 0, `${at}: A pressed on the bar above the portraits`);
    }
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
