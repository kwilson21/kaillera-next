import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  analogScale,
  axisSign,
  digitalSnap,
  gamepadDisplayName,
  n64StickMax,
  normalizeAxis,
  type AxisName,
  type AxisProfile,
} from '../../web/src/gamepad-axes.ts';
import { decodeGamepadProfile } from '../../web/src/gamepad-profile.ts';
import { createGamepadManager, type PadReading } from '../../web/src/page/gamepad-manager.ts';
import { lcg } from './load-shared.ts';

test('the default range of 66 gives the N64 maximum of 83', () => {
  assert.equal(n64StickMax(66), 83);
  assert.equal(n64StickMax(100), 127);
  assert.equal(n64StickMax(0), 0);
});

test('analogScale is 0 in the dead zone, reaches the maximum, and never passes it', () => {
  for (const range of [0, 33, 66, 100]) {
    const max = n64StickMax(range);
    for (const sensitivity of [0.5, 1, 1.5, 2]) {
      for (const deadzone of [0, 0.15, 0.4]) {
        let previous = -max;
        for (let step = -1000; step <= 1000; step++) {
          const value = step / 1000;
          const out = analogScale(value, deadzone, range, sensitivity);
          const where = `value=${value} dz=${deadzone} range=${range} sens=${sensitivity} out=${out}`;
          if (!Number.isInteger(out) || Math.abs(out) > max) assert.fail(`out of range: ${where}`);
          if (Math.abs(value) < deadzone && out !== 0) assert.fail(`dead zone: ${where}`);
          if (out < previous) assert.fail(`not monotonic: ${where}`);
          if (out + analogScale(-value, deadzone, range, sensitivity) !== 0) assert.fail(`not odd: ${where}`);
          previous = out;
        }
        assert.equal(analogScale(1, deadzone, range, sensitivity), max);
        assert.equal(analogScale(-1, deadzone, range, sensitivity), -max);
      }
    }
  }
});

test('digitalSnap is off in the dead zone and full on outside it', () => {
  assert.equal(digitalSnap(0.1, 0.15, 66), 0);
  assert.equal(digitalSnap(0.15, 0.15, 66), 83);
  assert.equal(digitalSnap(-0.9, 0.15, 66), -83);
  assert.equal(digitalSnap(0.5, 0.15, 100), 127);
});

test('axisSign follows what the profile says each end of an axis means', () => {
  const standard: AxisProfile = {
    axes: { stickX: { index: 0, bits: [16, 17] }, stickY: { index: 1, bits: [18, 19] } },
    axisButtons: { 2: { pos: 1 << 21, neg: 1 << 20 }, 3: { pos: 1 << 22, neg: 1 << 23 } },
  };
  const names: AxisName[] = ['lx', 'ly', 'cx', 'cy'];
  assert.deepEqual(
    names.map((n) => axisSign(standard, n)),
    [1, 1, 1, 1],
  );
  // The Switch 2 Pro layout: +Y is up on both sticks.
  const upIsPositive: AxisProfile = {
    axes: { stickX: { index: 0, bits: [16, 17] }, stickY: { index: 1, bits: [19, 18] } },
    axisButtons: { 3: { pos: 1 << 21, neg: 1 << 20 }, 5: { pos: 1 << 23, neg: 1 << 22 } },
  };
  assert.deepEqual(
    names.map((n) => axisSign(upIsPositive, n)),
    [1, -1, 1, -1],
  );
  // No axis data at all keeps Standard polarity.
  assert.deepEqual(
    names.map((n) => axisSign({}, n)),
    [1, 1, 1, 1],
  );
});

test('normalizeAxis subtracts the rest position, divides out the range and clamps', () => {
  assert.equal(normalizeAxis(0.5, 0, 1, 1), 0.5);
  assert.equal(normalizeAxis(0.5, 0.1, 1, 0.8), 0.5);
  assert.equal(normalizeAxis(0.9, 0, 1, 0.8), 1);
  assert.equal(normalizeAxis(-0.9, 0, -1, 0.8), 1);
});

test('gamepadDisplayName strips the vendor decorations browsers add', () => {
  assert.equal(
    gamepadDisplayName('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'),
    'Xbox Wireless Controller',
  );
  assert.equal(gamepadDisplayName('045e-0b13-Xbox Wireless Controller'), 'Xbox Wireless Controller');
  assert.equal(gamepadDisplayName('Switch 2 Pro Controller (Vendor: 057e Product: 2069)'), 'Switch 2 Pro Controller');
  assert.equal(gamepadDisplayName('(Vendor: 057e Product: 2069)'), '(Vendor: 057e Product: 2069)');
});

// ── The manager itself (web/src/page/gamepad-manager.ts) ──────────────────

const PAD_IDS = [
  'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  'Switch 2 Pro Controller (Vendor: 057e Product: 2069)',
  '0079-0006-Generic USB Joystick',
];

/**
 * Run the gamepad manager against scripted pads, profiles and settings, and
 * return every input it read. -0 is kept apart from 0: the pipeline produces
 * it and the values are sent to other peers. `stored`, if given, is put in
 * storage as every pad's saved profile, exactly as written, in place of the
 * profiles the script saves itself.
 */
const runManager = (stored?: string): string[] => {
  const pads: (PadReading | null)[] = [];
  const store = new Map<string, string>();
  let clock = 0;
  const manager = createGamepadManager({
    getGamepads: () => pads,
    state: () => ({
      romHash: null,
      safeGet: (_area, key) => store.get(key) ?? null,
      safeSet: (_area, key, value) => void store.set(key, value),
      safeRemove: (_area, key) => void store.delete(key),
    }),
    // Advance past the settings cache on every read, so a changed range applies.
    now: () => (clock += 2000),
    setItem: (key, value) => void store.set(key, value),
    listen: () => undefined,
    unlisten: () => undefined,
    every: () => () => undefined,
    warn: () => undefined,
  });
  const poll = (): void => {
    manager.start({ playerSlot: 0 });
    manager.stop();
  };

  const next = lcg(64);
  const axis = (): number => {
    const r = next() % 10;
    if (r === 0) return 0;
    if (r === 1) return next() % 2 === 0 ? 1 : -1;
    // Mostly small values around the dead zone, sometimes anywhere.
    return r < 6 ? ((next() % 600) - 300) / 1000 : ((next() % 2001) - 1000) / 1000;
  };
  const seen: string[] = [];
  const show = (v: number): string => (Object.is(v, -0) ? '-0' : String(v));
  for (let round = 0; round < 60; round++) {
    const id = PAD_IDS[round % PAD_IDS.length]!;
    pads[0] = null;
    poll();
    store.clear();
    if (stored !== undefined) store.set(`gamepad-profile:${id}`, stored);
    if (round % 4 === 1 && stored === undefined) {
      // A remapped pad: both sticks' Y flipped, C stick on other axes.
      manager.saveGamepadProfile(id, {
        buttons: { 0: 1, 1: 2, 2: 1 << 20, 3: 1 << 23 },
        axes: { stickX: { index: 0, bits: [17, 16] }, stickY: { index: 1, bits: [19, 18] } },
        axisButtons: { 2: { pos: 1 << 20, neg: 1 << 21 }, 3: { pos: 1 << 23, neg: 1 << 22 } },
        axisRange: 0.9,
        deadzone: 0.15,
      });
    }
    // Two rounds in three change the range, cycling through three values.
    if (round % 3 !== 0) manager.setSetting('kn-analog-range', [33, 100, 50][Math.floor(round / 3) % 3]!);
    if (round % 5 === 2) manager.setSetting('kn-analog-sensitivity', [0.5, 1.5, 2][round % 3]!);
    if (round % 7 === 3) manager.setSetting('kn-deadzone-lx', 0.3);
    const rest = Array.from({ length: 6 }, () => ((next() % 200) - 100) / 1000);
    const pad = {
      id,
      mapping: id.includes('STANDARD') ? 'standard' : '',
      buttons: Array.from({ length: 21 }, () => ({ pressed: false, value: 0 })),
      axes: rest,
    };
    pads[0] = pad;
    // Two polls at rest, as a real pad gives before anyone touches it.
    poll();
    poll();
    seen.push(manager.displayName(id));
    for (let n = 0; n < 150; n++) {
      pad.axes = Array.from({ length: 6 }, axis);
      for (const b of pad.buttons) b.pressed = next() % 9 === 0;
      const input = manager.readGamepad(0);
      assert.ok(input, 'no gamepad assigned');
      seen.push([input.buttons, input.lx, input.ly, input.cx, input.cy].map(show).join(','));
    }
  }
  return seen;
};

// What web/static/gamepad-manager.js read for this script at ff53345, while
// it was a plain script with its own axis arithmetic.
const GOLDEN = { reads: 9060, sha256: '004d3d10d0df8e00a9424fd55c8157cceabdeab429c58fdb6a6863dc45d8d790' };

test('the gamepad manager reads the same inputs as the plain script it replaced', () => {
  const reads = runManager();
  assert.equal(reads.length, GOLDEN.reads);
  assert.equal(createHash('sha256').update(reads.join('\n')).digest('hex'), GOLDEN.sha256);
  // The script must move the sticks: more than a handful of distinct reads.
  assert.ok(new Set(reads).size > 2000, `only ${new Set(reads).size} distinct reads`);
  // The range setting must have taken effect: full deflection reaches the
  // maximum of each range the script sets (100 gives 127, 33 gives 41).
  for (const max of ['127', '41']) {
    assert.ok(
      reads.some((line) => line.split(',').includes(max)),
      `no read at the maximum ${max}`,
    );
  }
  assert.ok(
    reads.some((line) => line.includes('-0')),
    'no negative zero in the script',
  );
});

// ── Saved profiles are decoded before they are used ───────────────────────

test('decodeGamepadProfile accepts what the wizard saves and nothing unusable', () => {
  // What play.js writes after a remap: JSON drops the undefined range and centre.
  const saved = {
    name: 'Custom',
    buttons: { 0: 1, 1: 2, 9: 8 },
    axes: { stickX: { index: 0, bits: [16, 17] }, stickY: { index: 1, bits: [19, 18] } },
    axisButtons: { 2: { pos: 1 << 21, neg: 1 << 20 } },
    deadzone: 0.3,
  };
  assert.deepStrictEqual(decodeGamepadProfile(JSON.parse(JSON.stringify(saved))), saved);
  // The Switch 2 Pro's extra fields, and a null where JSON wrote a non-number.
  const full = { ...saved, axisRange: 0.8, axisCenter: 'auto', axes: null };
  assert.deepStrictEqual(decodeGamepadProfile(full), full);
  // Keys this version does not know are left out, not an error.
  assert.deepStrictEqual(decodeGamepadProfile({ buttons: {}, rumble: true }), { buttons: {} });

  for (const bad of [
    null,
    'profile',
    [],
    {},
    { buttons: null },
    { buttons: { 0: 'A' } },
    { buttons: { 0: 1.5 } },
    { buttons: {}, axes: { stickX: { index: -1 } } },
    { buttons: {}, axes: { stickX: { bits: [16, 17] } } },
    { buttons: {}, axisButtons: { 2: { pos: 1 } } },
    // An index below zero, or not a number, has no entry in the pad's arrays.
    { buttons: { '-1': 1 } },
    { buttons: { A: 1 } },
    { buttons: { '1.5': 1 } },
    { buttons: {}, axisButtons: { '-2': { pos: 1, neg: 2 } } },
    { buttons: {}, axisRange: 0 },
    { buttons: {}, axisCenter: 'manual' },
  ]) {
    assert.equal(decodeGamepadProfile(bad), null, JSON.stringify(bad));
  }
});

test('a saved profile that does not fit is ignored and the pad reads as built in', () => {
  // The whole script with every pad's saved profile unusable, against the
  // same script with nothing usable saved at all (an empty string, which the
  // manager treats as no profile): the reads must be the same.
  const builtIn = runManager('');
  assert.ok(new Set(builtIn).size > 2000);
  for (const stored of [
    '{}',
    '{"buttons":null}',
    '{"buttons":{"0":"A"}}',
    '{"buttons":{"-1":1}}',
    '{"buttons":{},"axisButtons":{"-2":{"pos":1,"neg":2}}}',
    '[1,2,3]',
    '"x"',
    '{not json',
  ]) {
    assert.deepStrictEqual(runManager(stored), builtIn, `stored ${stored}`);
  }
});
