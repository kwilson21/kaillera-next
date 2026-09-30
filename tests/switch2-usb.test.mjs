// Switch 2 Pro Controller support: the built-in gamepad profile and the WebUSB
// handshake module, exercised against a mock USBDevice (no hardware needed).
//
//   node --test tests/switch2-usb.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.window = globalThis;
const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/static');
await import(path.join(staticDir, 'gamepad-manager.js'));
await import(path.join(staticDir, 'switch2-usb.js'));
const { GamepadManager, Switch2USB } = globalThis;

const FAST = { replyTimeoutMs: 5, gapMs: 0 };
const COMMAND_COUNT = 17;

// ── Profile selection ────────────────────────────────────────────────

test('Switch 2 Pro is picked for Chrome- and Firefox-style ids only', () => {
  const name = (id) => GamepadManager.getDefaultProfile(id).name;
  assert.equal(name('Nintendo Co., Ltd. Switch 2 Pro Controller (Vendor: 057e Product: 2069)'), 'Switch 2 Pro');
  assert.equal(name('057e-2069-Switch 2 Pro Controller'), 'Switch 2 Pro');
  assert.equal(name('57e-2069-Switch 2 Pro Controller'), 'Switch 2 Pro'); // Firefox on macOS drops the leading zero
  // A browser that maps the pad natively as a standard gamepad (its own `mapping` flag) must not get the raw HID layout.
  assert.equal(
    GamepadManager.getDefaultProfile('Switch 2 Pro Controller (Vendor: 057e Product: 2069)', 'standard').name,
    'Standard',
  );
  assert.equal(
    GamepadManager.getDefaultProfile('Switch 2 Pro Controller (Vendor: 057e Product: 2069)', '').name,
    'Switch 2 Pro',
  );
  assert.equal(name('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'Standard');
  assert.equal(name('057e-2009-Pro Controller'), 'Standard'); // Switch 1 Pro works natively
});

// ── WebUSB handshake ─────────────────────────────────────────────────

const CONFIGURATION = {
  interfaces: [
    { interfaceNumber: 0, alternates: [{ endpoints: [] }] },
    {
      interfaceNumber: 1,
      alternates: [
        {
          endpoints: [
            { endpointNumber: 4, type: 'bulk', direction: 'out' },
            { endpointNumber: 5, type: 'bulk', direction: 'in' },
          ],
        },
      ],
    },
  ],
};

// transferIn never resolves on its own, like a controller that stays silent;
// close() aborts the pending reads, like a real USBDevice.
function mockDevice({ configuration = null, claimError = null, transferIn = null, stallAt = null } = {}) {
  const calls = [];
  const pending = [];
  const device = {
    vendorId: 0x057e,
    productId: 0x2069,
    opened: false,
    configuration,
    calls,
    open: async () => {
      calls.push(['open']);
      device.opened = true;
    },
    selectConfiguration: async (n) => {
      calls.push(['selectConfiguration', n]);
      device.configuration = CONFIGURATION;
    },
    claimInterface: async (n) => {
      calls.push(['claimInterface', n]);
      if (claimError) throw claimError;
    },
    transferOut: async (endpoint) => {
      calls.push(['transferOut', endpoint]);
      // A stalled endpoint resolves with status 'stall' rather than rejecting.
      return { status: calls.filter((c) => c[0] === 'transferOut').length === stallAt ? 'stall' : 'ok' };
    },
    clearHalt: async (direction, endpoint) => {
      calls.push(['clearHalt', direction, endpoint]);
    },
    transferIn:
      transferIn ??
      ((endpoint) => {
        calls.push(['transferIn', endpoint]);
        return new Promise((_, reject) => pending.push(reject));
      }),
    releaseInterface: async (n) => {
      calls.push(['releaseInterface', n]);
    },
    close: async () => {
      calls.push(['close']);
      device.opened = false;
      pending.forEach((reject) => reject(new DOMException('aborted', 'AbortError')));
    },
  };
  return device;
}

const names = (device) => device.calls.map((c) => c[0]);
const count = (device, name) => names(device).filter((n) => n === name).length;

// enable() writes to #switch2-status; give it a fake element to write to.
function withStatusElement(fn) {
  const el = { textContent: '', hidden: true };
  globalThis.document = { getElementById: (id) => (id === 'switch2-status' ? el : null) };
  return fn(el).finally(() => delete globalThis.document);
}

test('enable() sends every command and cleans up even if the pad never replies', async () => {
  const device = mockDevice({ configuration: CONFIGURATION });
  device.opened = true;
  await withStatusElement(async (status) => {
    assert.equal(await Switch2USB.enable(device, FAST), true);
    assert.match(status.textContent, /enabled/);
    assert.equal(status.hidden, false);
  });

  assert.equal(count(device, 'transferOut'), COMMAND_COUNT);
  assert.deepEqual(
    device.calls.find((c) => c[0] === 'claimInterface'),
    ['claimInterface', 1],
  );
  // Endpoints come from the descriptor, not hardcoded.
  assert.ok(device.calls.filter((c) => c[0] === 'transferOut').every((c) => c[1] === 4));
  assert.ok(device.calls.filter((c) => c[0] === 'transferIn').every((c) => c[1] === 5));
  assert.deepEqual(names(device).slice(-2), ['releaseInterface', 'close']);
  // Already open and configured: neither is repeated.
  assert.equal(count(device, 'open'), 0);
  assert.equal(count(device, 'selectConfiguration'), 0);
});

test('enable() opens and selects configuration 1 when the device has none', async () => {
  const device = mockDevice({ configuration: null });
  await Switch2USB.enable(device, FAST);
  assert.deepEqual(device.calls.slice(0, 3), [['open'], ['selectConfiguration', 1], ['claimInterface', 1]]);
  assert.equal(count(device, 'transferOut'), COMMAND_COUNT);
});

test('a failing reply read does not abort the handshake', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const device = mockDevice({
      configuration: CONFIGURATION,
      transferIn: () => Promise.reject(new DOMException('stalled', 'NetworkError')),
    });
    await Switch2USB.enable(device, FAST);
    await new Promise((resolve) => setImmediate(resolve)); // let any stray rejection surface
    assert.equal(count(device, 'transferOut'), COMMAND_COUNT);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a second enable() while one is running is a no-op', async () => {
  const device = mockDevice({ configuration: CONFIGURATION });
  const [first, second] = await Promise.all([Switch2USB.enable(device, FAST), Switch2USB.enable(device, FAST)]);
  assert.deepEqual([first, second], [true, false]);
  assert.equal(count(device, 'claimInterface'), 1);
  assert.equal(count(device, 'transferOut'), COMMAND_COUNT);
  // Once finished, the device can be enabled again (e.g. after a power cycle).
  assert.equal(await Switch2USB.enable(device, FAST), true);
});

test('a claim failure rejects, shows the verbatim error, and still closes the device', async () => {
  const error = new DOMException('Unable to claim interface.', 'NetworkError');
  const device = mockDevice({ configuration: CONFIGURATION, claimError: error });
  await withStatusElement(async (status) => {
    await assert.rejects(Switch2USB.enable(device, FAST), { name: error.name, message: error.message });
    assert.ok(status.textContent.includes('NetworkError: Unable to claim interface.'), status.textContent);
    assert.equal(status.hidden, false);
  });
  assert.equal(count(device, 'transferOut'), 0);
  assert.equal(count(device, 'close'), 1);
});

test('a stalled write fails the handshake instead of reporting the controller as enabled', async () => {
  const device = mockDevice({ configuration: CONFIGURATION, stallAt: 3 });
  await withStatusElement(async (status) => {
    await assert.rejects(Switch2USB.enable(device, FAST), /handshake command 3 of \d+: stall/);
    assert.match(status.textContent, /stall/);
    assert.doesNotMatch(status.textContent, /enabled/);
  });
  assert.equal(count(device, 'transferOut'), 3); // stopped at the stall
  assert.deepEqual(
    device.calls.find((c) => c[0] === 'clearHalt'),
    ['clearHalt', 'out', 4],
  );
  assert.deepEqual(names(device).slice(-2), ['releaseInterface', 'close']);
  // Not stuck "in flight": a retry runs the whole handshake again.
  assert.equal(await Switch2USB.enable(device, FAST), true);
});

// ── Ready feedback ───────────────────────────────────────────────────

const PRO2_ID = 'Switch 2 Pro Controller (Vendor: 057e Product: 2069)';
const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';

test('the Switch 2 Pro appearing as a gamepad sets the ready status once and removes the listener', async () => {
  const target = new EventTarget(); // follows the DOM rule that a repeated listener is ignored
  globalThis.addEventListener = target.addEventListener.bind(target);
  globalThis.removeEventListener = target.removeEventListener.bind(target);
  const connected = (id) => Object.assign(new Event('gamepadconnected'), { gamepad: { id } });
  try {
    await withStatusElement(async (status) => {
      const device = mockDevice({ configuration: CONFIGURATION });
      await Switch2USB.enable(device, FAST);
      await Switch2USB.enable(device, FAST); // a repeated handshake must not stack listeners

      target.dispatchEvent(connected(XBOX_ID));
      assert.match(status.textContent, /press any button/);

      target.dispatchEvent(connected(PRO2_ID));
      assert.equal(status.textContent, 'Switch 2 controller ready.');

      status.textContent = 'something else';
      target.dispatchEvent(connected(PRO2_ID));
      assert.equal(status.textContent, 'something else');
    });
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
  }
});

test('a pad exposed before the handshake finished is ready straight away', async () => {
  const target = new EventTarget();
  globalThis.addEventListener = target.addEventListener.bind(target);
  globalThis.removeEventListener = target.removeEventListener.bind(target);
  globalThis.APISandbox = { nativeGetGamepads: () => [null, { id: PRO2_ID }] };
  try {
    await withStatusElement(async (status) => {
      await Switch2USB.enable(mockDevice({ configuration: CONFIGURATION }), FAST);
      assert.equal(status.textContent, 'Switch 2 controller ready.');
    });
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.APISandbox;
  }
});

// ── Auto-enable and the Connect button ───────────────────────────────

// _start() runs when the script loads once a document exists, so each scenario re-evaluates
// the script (a plain CommonJS file: drop it from the require cache) against a fake page
// and navigator.usb.
const require = createRequire(import.meta.url);
const modulePath = path.join(staticDir, 'switch2-usb.js');
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function loadOnPage({ buttonHidden = true, devices = [], getDevicesError = null, requestDevice = null } = {}) {
  const status = { textContent: '', hidden: true };
  const button = {
    hidden: buttonHidden,
    onClick: null,
    addEventListener(type, handler) {
      if (type === 'click') this.onClick = handler;
    },
  };
  const elements = { 'switch2-status': status, 'switch2-connect-btn': button };
  const usb = {
    getDevices: async () => {
      if (getDevicesError) throw getDevicesError;
      return devices;
    },
    requestDevice,
    addEventListener: () => {},
  };
  globalThis.document = { readyState: 'complete', getElementById: (id) => elements[id] ?? null };
  Object.defineProperty(globalThis, 'navigator', { value: { usb }, configurable: true, writable: true });
  delete require.cache[modulePath];
  require(modulePath);
  return { status, button };
}

function leavePage() {
  delete globalThis.document;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete globalThis.navigator;
}

async function until(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the page to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// transferIn answers at once so the default handshake pacing (gapMs) is the only wait.
const responsiveDevice = (options) =>
  mockDevice({ configuration: CONFIGURATION, transferIn: async () => ({}), ...options });
const finished = async (device) => {
  await until(() => count(device, 'close') > 0);
  await new Promise((resolve) => setImmediate(resolve)); // let the caller's continuation run
};

test('a granted controller is enabled automatically and the Connect button stays hidden', async () => {
  const device = responsiveDevice();
  try {
    const { button } = loadOnPage({ buttonHidden: false, devices: [device] });
    await until(() => button.hidden);
    assert.equal(count(device, 'close'), 0); // hidden while the handshake runs, not only after it
    await finished(device);
    assert.equal(count(device, 'transferOut'), COMMAND_COUNT);
    assert.equal(button.hidden, true);
  } finally {
    leavePage();
  }
});

test('the Connect button is shown when no matching controller has been granted', async () => {
  const switch1Pro = mockDevice();
  switch1Pro.productId = 0x2009;
  try {
    const { button } = loadOnPage({ devices: [switch1Pro] });
    await until(() => !button.hidden);
    assert.equal(count(switch1Pro, 'open'), 0);
  } finally {
    leavePage();
  }
});

test('the Connect button is shown when the granted devices cannot be listed', async () => {
  try {
    const { button } = loadOnPage({ getDevicesError: new DOMException('blocked', 'SecurityError') });
    await until(() => !button.hidden);
  } finally {
    leavePage();
  }
});

test('the Connect button comes back when the automatic enable fails', async () => {
  const device = responsiveDevice({ claimError: new DOMException('Unable to claim interface.', 'NetworkError') });
  try {
    const { button, status } = loadOnPage({ devices: [device] });
    await finished(device);
    assert.equal(button.hidden, false);
    assert.match(status.textContent, /NetworkError: Unable to claim interface\./);
  } finally {
    leavePage();
  }
});

test('clicking Connect: cancelling the chooser keeps the button, a successful enable hides it', async () => {
  const device = responsiveDevice();
  const answers = [() => Promise.reject(new DOMException('No device selected.', 'NotFoundError')), async () => device];
  try {
    const { button, status } = loadOnPage({ requestDevice: () => answers.shift()() });
    await until(() => !button.hidden);

    await button.onClick();
    assert.equal(status.textContent, 'No controller selected.');
    assert.equal(button.hidden, false);

    await button.onClick();
    assert.equal(count(device, 'transferOut'), COMMAND_COUNT);
    assert.equal(button.hidden, true);
  } finally {
    leavePage();
  }
});
