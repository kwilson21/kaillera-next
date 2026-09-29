// Stick polarity and range in gamepad-manager.js: a profile records what a positive
// axis value means (axes.stickX/stickY bits[0], axisButtons pos) and, optionally, the
// raw value of full deflection (axisRange). readGamepad must honor both, and leave
// Standard pads exactly as they were.
//
//   node --test tests/gamepad-axes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.window = globalThis;
const pads = [];
const store = new Map(); // stands in for localStorage (saved custom profiles)
globalThis.APISandbox = { nativeGetGamepads: () => pads };
globalThis.KNState = {
  safeGet: (_area, key) => store.get(key) ?? null,
  safeSet: (_area, key, value) => store.set(key, value),
  safeRemove: (_area, key) => store.delete(key),
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/static/gamepad-manager.js'));
const { GamepadManager } = globalThis;

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const SWITCH2_ID = 'Switch 2 Pro Controller (Vendor: 057e Product: 2069)';

// Make a mock pad gamepad 0. start() polls once; stop() right away leaves no timer running.
function attach(id, buttonCount, axisCount) {
  const pad = {
    id,
    mapping: id === XBOX_ID ? 'standard' : '',
    buttons: Array.from({ length: buttonCount }, () => ({ pressed: false, value: 0 })),
    axes: Array(axisCount).fill(0),
  };
  pads[0] = pad;
  GamepadManager.start({ playerSlot: 0 });
  GamepadManager.stop();
  return pad;
}

const press = (pad, index) => {
  pad.buttons[index] = { pressed: true, value: 1 };
};

function readSticks(pad, axes) {
  pad.axes = axes;
  const { lx, ly, cx, cy } = GamepadManager.readGamepad(0);
  return { lx, ly, cx, cy };
}

// ── Standard pads are unchanged ──────────────────────────────────────

// Expected values come from the pre-change pipeline (gamepad-manager.js at b72cec5c, before
// axisTransform existed) fed the same mock pad and inputs, with default settings (range 66,
// so N64 max 83; deadzone 0.15; sensitivity 1). -0 is what that pipeline returns for a
// stick just past the deadzone that rounds to zero; it is pinned as-is.
const STANDARD_CASES = [
  { axes: [0, 0, 0, 0], expected: { lx: 0, ly: 0, cx: 0, cy: 0 } }, // rest
  { axes: [0.5, -0.5, 0.9, -0.9], expected: { lx: 34, ly: -34, cx: 83, cy: -83 } },
  { axes: [1, -1, 1, -1], expected: { lx: 83, ly: -83, cx: 83, cy: -83 } }, // full deflection
  { axes: [-1, 1, -1, 1], expected: { lx: -83, ly: 83, cx: -83, cy: 83 } },
  { axes: [0.149, -0.149, 0.149, -0.149], expected: { lx: 0, ly: 0, cx: 0, cy: 0 } }, // inside deadzone
  { axes: [0.151, -0.151, 0.151, -0.151], expected: { lx: 0, ly: -0, cx: 83, cy: -83 } }, // just outside
  { axes: [0.3, 0.75, -0.3, 0.6], expected: { lx: 15, ly: 59, cx: -83, cy: 83 } },
  { axes: [-0.62, 0.08, 0.14, -0.16], expected: { lx: -46, ly: 0, cx: 0, cy: -83 } },
];

test('a standard-mapping pad reads exactly as before', () => {
  const pad = attach(XBOX_ID, 17, 4);
  press(pad, 0); // face bottom → N64 A
  press(pad, 12); // dpad up → D-Up
  for (const { axes, expected } of STANDARD_CASES) {
    assert.deepEqual(readSticks(pad, axes), expected, `axes ${JSON.stringify(axes)}`);
    assert.equal(GamepadManager.readGamepad(0).buttons, (1 << 0) | (1 << 4));
  }
});

// ── Switch 2 Pro: +Y is up on both sticks, full deflection is about 0.8 ──

test('Switch 2 Pro sticks move the way they are pushed, to full N64 range', () => {
  const xbox = attach(XBOX_ID, 17, 4);
  const max = readSticks(xbox, [1, 0, 0, 0]).lx; // a Standard pad pushed fully right
  assert.ok(max > 0);
  assert.equal(readSticks(xbox, [0, -1, 0, 0]).ly, -max); // ... and fully up

  const pad = attach(SWITCH2_ID, 21, 6);
  const at = (axis, value) => {
    const axes = Array(6).fill(0);
    axes[axis] = value;
    return readSticks(pad, axes);
  };
  const rest = { lx: 0, ly: 0, cx: 0, cy: 0 };

  // Left stick: axes 0 (X) and 1 (Y, positive = up).
  assert.deepEqual(at(1, 0.8), { ...rest, ly: -max }); // up
  assert.deepEqual(at(1, -0.8), { ...rest, ly: max }); // down
  assert.deepEqual(at(0, 0.8), { ...rest, lx: max }); // right
  assert.deepEqual(at(0, -0.8), { ...rest, lx: -max }); // left

  // Right stick (C buttons): axes 3 (X) and 5 (Y, positive = up).
  assert.deepEqual(at(5, 0.8), { ...rest, cy: -max }); // C-Up
  assert.deepEqual(at(5, -0.8), { ...rest, cy: max }); // C-Down
  assert.deepEqual(at(3, 0.8), { ...rest, cx: max }); // C-Right
  assert.deepEqual(at(3, -0.8), { ...rest, cx: -max }); // C-Left

  // The unused axes (2 and 4) never reach the C stick.
  assert.deepEqual(at(2, 1), rest);
  assert.deepEqual(at(4, 1), rest);

  // Measured resting drift stays inside the deadzone.
  assert.deepEqual(readSticks(pad, [-0.01, 0.1, 0, 0.07, 0, 0]), rest);

  press(pad, 6); // "+" → Start (Standard would read this as Z)
  assert.equal(GamepadManager.readGamepad(0).buttons, 1 << 3);
});

// ── Saved profiles: what the remap wizard records is honored ─────────

test('a saved profile with an inverted axis flips that axis only', () => {
  const pad = attach(XBOX_ID, 17, 4);
  // Same as the wizard: start from the current profile and change the recorded axes.
  const save = (edit) => {
    const profile = JSON.parse(JSON.stringify(GamepadManager.getDefaultProfile(XBOX_ID)));
    edit(profile);
    GamepadManager.saveGamepadProfile(XBOX_ID, profile);
  };
  try {
    // positive Y = up
    save((p) => {
      p.axes.stickY.bits = [19, 18];
    });
    assert.deepEqual(readSticks(pad, [0, 0.5, 0, 0]), { lx: 0, ly: -34, cx: 0, cy: 0 });

    // positive Y = down, as Standard
    save((p) => {
      p.axes.stickY.bits = [18, 19];
    });
    assert.deepEqual(readSticks(pad, [0, 0.5, 0, 0]), { lx: 0, ly: 34, cx: 0, cy: 0 });

    // positive X = left
    save((p) => {
      p.axes.stickX.bits = [17, 16];
    });
    assert.deepEqual(readSticks(pad, [0.5, 0, 0, 0]), { lx: -34, ly: 0, cx: 0, cy: 0 });

    save((p) => {
      // positive C-stick X = C-Left, positive Y = C-Up
      p.axisButtons = { 2: { pos: 1 << 20, neg: 1 << 21 }, 3: { pos: 1 << 23, neg: 1 << 22 } };
    });
    assert.deepEqual(readSticks(pad, [0, 0, 0.9, 0.9]), { lx: 0, ly: 0, cx: -83, cy: -83 });
  } finally {
    GamepadManager.clearGamepadProfile(XBOX_ID);
  }
});

test('axisTransform: Standard polarity by default, axisRange divided out and clamped', () => {
  const transform = (profile, name) => GamepadManager.axisTransform(profile, name);
  for (const name of ['lx', 'ly', 'cx', 'cy']) assert.equal(transform({}, name)(0.5), 0.5);
  assert.equal(transform({ axes: { stickY: { index: 1 } } }, 'ly')(0.5), 0.5); // no bits recorded

  assert.equal(transform({ axisRange: 0.8 }, 'lx')(0.4), 0.5);
  assert.equal(transform({ axisRange: 0.8 }, 'lx')(1), 1);
  assert.equal(transform({ axisRange: 0.8 }, 'lx')(-1), -1);

  // A pair with only the far end recorded is judged by that end too.
  const ly = (bits) => transform({ axes: { stickY: { index: 1, bits } } }, 'ly')(0.5);
  assert.equal(ly([18, 19]), 0.5);
  assert.equal(ly([19, 18]), -0.5);
  assert.equal(ly([18, 18]), -0.5);
  assert.equal(ly([19, 19]), -0.5);

  // A C-stick entry naming only one end is judged by that end.
  assert.equal(transform({ axisButtons: { 3: { pos: 0, neg: 1 << 22 } } }, 'cy')(0.5), -0.5); // negative = C-Down
  assert.equal(transform({ axisButtons: { 3: { pos: 0, neg: 1 << 23 } } }, 'cy')(0.5), 0.5); // negative = C-Up
});

// ── Display names ────────────────────────────────────────────────────

test('displayName drops the browser-specific vendor/product decoration', () => {
  const names = {
    'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)': 'Xbox Wireless Controller',
    '045e-0b13-Xbox Wireless Controller': 'Xbox Wireless Controller',
    [SWITCH2_ID]: 'Switch 2 Pro Controller',
    '057e-2069-Switch 2 Pro Controller': 'Switch 2 Pro Controller',
    '54c-9cc-Wireless Controller': 'Wireless Controller', // leading zeros dropped
    'Xbox 360 Controller (XInput STANDARD GAMEPAD)': 'Xbox 360 Controller', // Chrome on Windows
    'Wireless Controller': 'Wireless Controller', // already clean
    '(Vendor: 057e Product: 2069)': '(Vendor: 057e Product: 2069)', // nothing left: keep the id
  };
  for (const [id, expected] of Object.entries(names)) assert.equal(GamepadManager.displayName(id), expected, id);
});
