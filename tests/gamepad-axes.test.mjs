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

// One poll, as GamepadManager.start() runs it; stop() right away leaves no timer running.
function poll() {
  GamepadManager.start({ playerSlot: 0 });
  GamepadManager.stop();
}

// Make a mock pad gamepad 0 (resting at `axes`) and poll it once.
function attach(
  id,
  buttonCount,
  axisCount,
  axes = Array(axisCount).fill(0),
  mapping = id === XBOX_ID ? 'standard' : '',
) {
  const pad = {
    id,
    mapping,
    buttons: Array.from({ length: buttonCount }, () => ({ pressed: false, value: 0 })),
    axes,
  };
  pads[0] = pad;
  poll();
  return pad;
}

// Unplug gamepad 0 and let a poll notice.
function detach() {
  pads[0] = null;
  poll();
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

// ── Switch 2 Pro: the resting position is sampled once per connection and subtracted ──

// Measured resting position of a real pad (Chrome, macOS): [LX, LY, unused, RX, unused, RY].
// LY at rest is 0.105 / 0.8 = 0.131 of full deflection, only just under the 0.15 deadzone.
const REST = [-0.006, 0.105, 0, 0.075, 0, 0];
const NEUTRAL = { lx: 0, ly: 0, cx: 0, cy: 0 };

test('Switch 2 Pro: the rest position is captured on the second matching poll and subtracted', () => {
  detach();
  const pad = attach(SWITCH2_ID, 21, 6, REST);
  assert.equal(GamepadManager.axisCenter(0, 1), 0); // one poll: not yet
  // 0.11 past rest is 0.1375 of full deflection, inside the 0.15 deadzone, but 0.215 raw is not.
  const nudged = REST.with(1, REST[1] + 0.11);
  assert.ok(readSticks(pad, nudged).ly < 0, 'without a centre the offset counts');

  pad.axes = REST;
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), REST[1]);
  assert.equal(readSticks(pad, nudged).ly, 0);
});

test('Switch 2 Pro: every stick reads exactly neutral at rest', () => {
  const restsAt = (axes) => {
    detach();
    const pad = attach(SWITCH2_ID, 21, 6, axes);
    const uncentred = readSticks(pad, axes);
    poll();
    return [uncentred, readSticks(pad, axes)];
  };
  assert.deepEqual(restsAt(REST)[1], NEUTRAL);

  // A worse unit (still inside the 0.15 capture limit): a phantom input without centring.
  const [uncentred, centred] = restsAt([0.02, 0.13, 0, -0.14, 0, 0.12]);
  assert.notDeepEqual(uncentred, NEUTRAL);
  assert.deepEqual(centred, NEUTRAL);
});

test('Switch 2 Pro: full deflection still reaches the full N64 range after centring', () => {
  detach();
  const pad = attach(SWITCH2_ID, 21, 6, REST);
  poll();
  // 0.8 either side of the rest position is full deflection (+Y is up, so up reads negative).
  assert.equal(readSticks(pad, REST.with(1, REST[1] + 0.8)).ly, -83);
  assert.equal(readSticks(pad, REST.with(1, REST[1] - 0.8)).ly, 83);
  assert.equal(readSticks(pad, REST.with(0, REST[0] + 0.8)).lx, 83);
  assert.equal(readSticks(pad, REST.with(3, REST[3] - 0.8)).cx, -83);
});

test('Switch 2 Pro: a stick held away from rest is never taken as the centre', () => {
  detach();
  const held = [0, 0.4, 0, 0, 0, 0]; // pushed up, well past the 0.15 capture limit
  const pad = attach(SWITCH2_ID, 21, 6, held);
  poll();
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), 0);
  assert.equal(readSticks(pad, held).ly, -34); // 0.4 / 0.8 = 0.5 of the way: (0.5 - 0.15) / 0.85 * 83

  // Released: it takes two matching polls at rest to capture it.
  pad.axes = REST;
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), 0);
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), REST[1]);
});

test('the Gamepad API mapping flag decides whether the raw Switch 2 Pro profile applies', () => {
  detach();
  attach(SWITCH2_ID, 21, 6, undefined, '');
  assert.equal(GamepadManager.getDetected()[0].profileName, 'Switch 2 Pro');
  assert.equal(GamepadManager.getDefaultProfile(SWITCH2_ID).name, 'Switch 2 Pro');

  // Same id, but the browser maps the pad natively as a standard gamepad (whatever its id text says).
  detach();
  attach(SWITCH2_ID, 17, 4, undefined, 'standard');
  assert.equal(GamepadManager.getDetected()[0].profileName, 'Standard');
  assert.equal(GamepadManager.getDefaultProfile(SWITCH2_ID).name, 'Standard'); // taken from the detected pad
  detach();
});

test('Switch 2 Pro: a pad that has not reported yet (all zeros) is not taken as the centre', () => {
  detach();
  const pad = attach(SWITCH2_ID, 21, 6); // every axis exactly 0, as before its first report
  poll();
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), 0);

  // Its first real report arrives.
  pad.axes = REST;
  poll();
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), REST[1]);
});

test('Switch 2 Pro: a resting offset past the capture limit is never captured, on any axis', () => {
  detach();
  const pad = attach(SWITCH2_ID, 21, 6, REST.with(1, 0.2));
  poll();
  poll();
  for (const axis of [0, 1, 3, 5]) assert.equal(GamepadManager.axisCenter(0, axis), 0, `axis ${axis}`);
  assert.deepEqual(readSticks(pad, REST.with(1, 0.2)), { ...NEUTRAL, ly: -10 }); // read as before
});

test('Switch 2 Pro: a stick still moving between polls is not captured until it settles', () => {
  detach();
  const pad = attach(SWITCH2_ID, 21, 6, REST.with(1, 0.05));
  pad.axes = REST.with(1, 0.1); // 0.05 apart, both inside the capture limit
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), 0);
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), 0.1);
});

test('Switch 2 Pro: only the stick axes count, the unused axes are neither read nor captured', () => {
  detach();
  attach(SWITCH2_ID, 21, 6, REST.with(2, 1).with(4, -1));
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), REST[1]);
  assert.equal(GamepadManager.axisCenter(0, 2), 0);
  assert.equal(GamepadManager.axisCenter(0, 4), 0);
});

test('a standard-mapping pad resting off-centre is never centred', () => {
  detach();
  const axes = [0.1, 0.1, 0.1, 0.1];
  // Shrink the deadzone so that 0.1 is live: centring would change these readings.
  for (const stick of ['lx', 'ly', 'cx', 'cy']) store.set(`kn-deadzone-${stick}`, '0.05');
  try {
    const pad = attach(XBOX_ID, 17, 4, axes);
    const first = readSticks(pad, axes);
    poll();
    poll();
    assert.equal(GamepadManager.axisCenter(0, 0), 0);
    assert.equal(GamepadManager.axisCenter(0, 1), 0);
    assert.deepEqual(readSticks(pad, axes), first);
    assert.deepEqual(first, { lx: 4, ly: 4, cx: 83, cy: 83 }); // (0.1 - 0.05) / 0.95 * 83; C stick snaps
  } finally {
    for (const stick of ['lx', 'ly', 'cx', 'cy']) store.delete(`kn-deadzone-${stick}`);
  }
});

test('Switch 2 Pro: a replugged or different pad is sampled again', () => {
  detach();
  attach(SWITCH2_ID, 21, 6, REST);
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), REST[1]);

  detach(); // unplugged: the old rest position is forgotten
  assert.equal(GamepadManager.axisCenter(0, 1), 0);
  const other = REST.with(1, -0.09).with(3, 0.02);
  const pad = attach(SWITCH2_ID, 21, 6, other);
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), -0.09);
  assert.deepEqual(readSticks(pad, other), NEUTRAL);

  // Another pad in the same slot without an unplug in between: the id changes.
  const again = REST.with(1, 0.06);
  attach(`${SWITCH2_ID} #2`, 21, 6, again);
  assert.equal(GamepadManager.axisCenter(0, 1), 0);
  poll();
  assert.equal(GamepadManager.axisCenter(0, 1), 0.06);
});

test('axisCenter is 0 for pads and axes nothing was captured for', () => {
  detach();
  assert.equal(GamepadManager.axisCenter(0, 1), 0);
  assert.equal(GamepadManager.axisCenter(3, 1), 0);
  attach(SWITCH2_ID, 21, 6, REST);
  poll();
  assert.equal(GamepadManager.axisCenter(0, 0), REST[0]);
  assert.equal(GamepadManager.axisCenter(0, 3), REST[3]);
  assert.equal(GamepadManager.axisCenter(0, 5), 0); // captured, and resting at exactly 0
  assert.equal(GamepadManager.axisCenter(0, 9), 0);
  assert.equal(GamepadManager.axisCenter(3, 1), 0);
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
