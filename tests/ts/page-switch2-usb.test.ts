import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  claimHint,
  failureText,
  findEndpoints,
  isPro2Gamepad,
  isSwitch2Pro,
  startSwitch2Usb,
  SWITCH2_COMMANDS,
  SWITCH2_FILTERS,
  type Switch2Host,
  type Switch2Usb,
  type UsbConfiguration,
  type UsbDevice,
} from '../../web/src/page/switch2-usb.ts';

// What the handshake does with a controller, scenario by scenario, is
// tests/switch2-usb.test.mjs. Here the module is held to the script it
// replaced: the bytes it sends, the order of its USB calls, and everything it
// writes to the status line, the Connect button and the console.

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/switch2-usb.js as of #166, unchanged.
const OLD_SCRIPT = `/**
 * switch2-usb.js — WebUSB "wake-up" for the Nintendo Switch 2 Pro Controller (USB-C).
 *
 * The controller stays silent to browsers until a vendor handshake is sent on
 * the bulk endpoints of its vendor-specific interface (interface 1). macOS has
 * no driver for that interface, so nothing else ever sends it. Once the
 * handshake is done the HID interface streams reports and the pad appears in
 * navigator.getGamepads() like any other; the 'Switch 2 Pro' profile in
 * gamepad-manager.js does the rest. The controller forgets the handshake on
 * every power cycle, so it is re-sent whenever the device (re)connects.
 *
 * Chrome needs one click and its device chooser to grant USB access. After that
 * the pad is re-enabled automatically on every page load and replug, and the
 * Connect button stays hidden unless that fails.
 *
 * Wires its own UI (#switch2-connect-btn, #switch2-status in play.html).
 *
 * Consumed by: play.html
 * Exposes: window.Switch2USB
 */
(function () {
  'use strict';

  // Switch 2 Pro only: Joy-Con 2 and the NSO GameCube pad take the same handshake but no
  // gamepad profile maps their buttons. Switch 1 pads use other product IDs and work natively.
  const VENDOR_ID = 0x057e;
  const PRODUCT_IDS = [0x2069];
  const FILTERS = PRODUCT_IDS.map((productId) => ({ vendorId: VENDOR_ID, productId }));

  const CONFIGURATION = 1;
  const INTERFACE = 1; // vendor-specific (class 255); interface 0 is HID and stays with the OS

  // Handshake commands, sent in this order (community-documented sequence).
  const _COMMANDS = [
    [0x03, 0x91, 0x00, 0x0d, 0x00, 0x08, 0x00, 0x00, 0x01, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    [0x07, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00],
    [0x16, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00],
    [
      0x15, 0x91, 0x00, 0x01, 0x00, 0x0e, 0x00, 0x00, 0x00, 0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff,
    ],
    [
      0x15, 0x91, 0x00, 0x02, 0x00, 0x11, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ],
    [0x15, 0x91, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00],
    [0x09, 0x91, 0x00, 0x07, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    [0x0c, 0x91, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x27, 0x00, 0x00, 0x00],
    [0x11, 0x91, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00],
    [
      0x0a, 0x91, 0x00, 0x08, 0x00, 0x14, 0x00, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x35, 0x00,
      0x46, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ],
    [0x0c, 0x91, 0x00, 0x04, 0x00, 0x04, 0x00, 0x00, 0x27, 0x00, 0x00, 0x00],
    [0x03, 0x91, 0x00, 0x0a, 0x00, 0x04, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00],
    [0x10, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00],
    [0x01, 0x91, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x00],
    [0x03, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00],
    [0x0a, 0x91, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0x00],
    [0x09, 0x91, 0x00, 0x07, 0x00, 0x08, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  ].map((bytes) => new Uint8Array(bytes));

  const _inFlight = new Set(); // devices mid-handshake (auto-enable and connect events can race)

  const _matches = (device) => device.vendorId === VENDOR_ID && PRODUCT_IDS.includes(device.productId);
  const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const _byId = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

  function isSupported() {
    return !!window.navigator?.usb;
  }

  // ── UI ───────────────────────────────────────────────────────────────

  function _setStatus(text) {
    const el = _byId('switch2-status');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  // The Connect button is only needed for the first grant, or to retry a failed enable.
  function _setConnectVisible(visible) {
    const el = _byId('switch2-connect-btn');
    if (el) el.hidden = !visible;
  }

  // The error text is our only diagnostic on real hardware, so it is shown verbatim.
  function _setFailure(err, hint = '') {
    console.info(\`[switch2-usb] failed: \${err.name}: \${err.message}\`);
    _setStatus(\`Switch 2 controller: \${err.name}: \${err.message}\${hint ? \` \${hint}\` : ''}\`);
  }

  const _CLAIM_HINT =
    'Another app may be using the controller — quit it and replug. On Windows the WinUSB driver may be needed, and on Linux a udev rule.';
  const _CLAIM_ERRORS = ['SecurityError', 'NetworkError', 'InvalidStateError'];

  // ── Handshake ────────────────────────────────────────────────────────

  function _findEndpoints(device) {
    const iface = device.configuration?.interfaces.find((i) => i.interfaceNumber === INTERFACE);
    if (!iface) throw new Error(\`USB interface \${INTERFACE} not found\`);
    const endpoints = iface.alternates[0]?.endpoints ?? [];
    const out = endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
    const inbound = endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
    if (!out) throw new Error(\`USB interface \${INTERFACE} has no bulk OUT endpoint\`);
    return { out: out.endpointNumber, in: inbound?.endpointNumber };
  }

  // Best-effort read of the controller's reply. WebUSB transferIn has no timeout
  // of its own, so race it against a timer; a losing read is left pending and
  // aborted by close(), and its rejection is swallowed.
  async function _readReply(device, endpoint, timeoutMs) {
    let timer;
    const read = device.transferIn(endpoint, 64).catch(() => null);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([read, timeout]);
    clearTimeout(timer);
  }

  async function _cleanup(device, claimed) {
    if (claimed) {
      try {
        await device.releaseInterface(INTERFACE);
      } catch (err) {
        console.info(\`[switch2-usb] releaseInterface: \${err.name}: \${err.message}\`);
      }
    }
    try {
      await device.close();
    } catch (err) {
      console.info(\`[switch2-usb] close: \${err.name}: \${err.message}\`);
    }
  }

  // Returns true once the handshake was sent, false if one is already running
  // for this device. Rejects with the underlying error after reporting it.
  async function enable(device, opts) {
    const { replyTimeoutMs = 150, gapMs = 50 } = opts ?? {};
    if (_inFlight.has(device)) return false;
    _inFlight.add(device);
    _setStatus('Enabling Switch 2 controller…');
    let claimed = false;
    try {
      if (!device.opened) await device.open();
      if (device.configuration === null) await device.selectConfiguration(CONFIGURATION);
      const endpoints = _findEndpoints(device);
      await device.claimInterface(INTERFACE);
      claimed = true;
      for (const [n, command] of _COMMANDS.entries()) {
        // A stalled endpoint resolves with status 'stall' instead of rejecting.
        const result = await device.transferOut(endpoints.out, command);
        if (result.status !== 'ok') {
          await device.clearHalt('out', endpoints.out).catch(() => {}); // so a retry starts clean
          throw new Error(\`handshake command \${n + 1} of \${_COMMANDS.length}: \${result.status}\`);
        }
        if (endpoints.in !== undefined) await _readReply(device, endpoints.in, replyTimeoutMs);
        await _sleep(gapMs);
      }
      console.info('[switch2-usb] handshake sent');
      _setStatus('Switch 2 controller enabled — press any button.');
      _awaitGamepad();
      return true;
    } catch (err) {
      _setFailure(err, _CLAIM_ERRORS.includes(err.name) ? _CLAIM_HINT : '');
      throw err;
    } finally {
      await _cleanup(device, claimed);
      _inFlight.delete(device);
    }
  }

  // ── Ready feedback ───────────────────────────────────────────────────

  const _isPro2 = (gp) => !!gp && /057e/i.test(gp.id) && /2069/.test(gp.id);
  const _pads = () => window.APISandbox?.nativeGetGamepads() ?? window.navigator?.getGamepads?.() ?? [];

  // Chrome exposes a pad only after its first button press. A single shared handler
  // keeps repeated handshakes from stacking listeners (addEventListener ignores the
  // same function twice); it removes itself once the pad shows up.
  function _onGamepadConnected(e) {
    if (!_isPro2(e.gamepad)) return;
    window.removeEventListener('gamepadconnected', _onGamepadConnected);
    _setStatus('Switch 2 controller ready.');
  }

  function _awaitGamepad() {
    // Browser only: Node (tests) has no window event target unless a test supplies one.
    if (typeof window.addEventListener !== 'function') return;
    // A button pressed before the handshake finished has already exposed the pad: no new event will come.
    if (Array.from(_pads()).some(_isPro2)) {
      _setStatus('Switch 2 controller ready.');
      return;
    }
    window.addEventListener('gamepadconnected', _onGamepadConnected);
  }

  // ── Connect / auto re-enable ─────────────────────────────────────────

  // enable() already reports a failure in the status line; the button doubles as the retry.
  async function _enableAndSync(device) {
    try {
      await enable(device);
      _setConnectVisible(false);
    } catch (_) {
      _setConnectVisible(true);
    }
  }

  // Must run inside a user gesture (requestDevice needs one).
  async function connect() {
    let device;
    try {
      device = await window.navigator.usb.requestDevice({ filters: FILTERS });
    } catch (err) {
      if (err.name === 'NotFoundError') _setStatus('No controller selected.');
      else _setFailure(err);
      return;
    }
    await _enableAndSync(device);
  }

  async function _start() {
    if (!isSupported()) return;
    const usb = window.navigator.usb;
    _byId('switch2-connect-btn')?.addEventListener('click', connect);
    usb.addEventListener('connect', (e) => {
      if (_matches(e.device)) _enableAndSync(e.device);
    });
    usb.addEventListener('disconnect', (e) => {
      if (_matches(e.device)) _setStatus('');
    });
    // getDevices() needs no prompt once the user has granted the device.
    let granted = [];
    try {
      granted = (await usb.getDevices()).filter(_matches);
    } catch (err) {
      console.info(\`[switch2-usb] getDevices: \${err.name}: \${err.message}\`);
    }
    _setConnectVisible(granted.length === 0);
    granted.forEach(_enableAndSync);
  }

  window.Switch2USB = { enable, isSupported };

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _start);
  else _start();
})();
`;

const FAST = { replyTimeoutMs: 5, gapMs: 0 };

const CONFIGURATIONS = ['unselected', 'full', 'noIn', 'noOut', 'noInterface', 'noAlternates'] as const;
const CLAIMS = ['ok', 'NetworkError', 'SecurityError', 'InvalidStateError', 'NotAllowedError'] as const;
const STALLS = [0, 1, 9, 17] as const;
const READS = ['silent', 'answers', 'rejects'] as const;
const CLEANUPS = ['ok', 'releaseFails', 'closeFails'] as const;
const PADS = ['none', 'listed', 'pressedLater'] as const;

interface DeviceKind {
  readonly configuration: (typeof CONFIGURATIONS)[number];
  readonly claim: (typeof CLAIMS)[number];
  /** The command whose write stalls, counted from 1; 0 for none. */
  readonly stallAt: (typeof STALLS)[number];
  readonly read: (typeof READS)[number];
  readonly cleanup: (typeof CLEANUPS)[number];
  readonly opened: boolean;
  readonly productId: number;
}

const RESPONSIVE: DeviceKind = {
  configuration: 'full',
  claim: 'ok',
  stallAt: 0,
  read: 'answers',
  cleanup: 'ok',
  opened: false,
  productId: 0x2069,
};

const bulk = (endpointNumber: number, direction: string) => ({ endpointNumber, type: 'bulk', direction });

const configurationOf = (kind: (typeof CONFIGURATIONS)[number]): UsbConfiguration => {
  const hid = { interfaceNumber: 0, alternates: [{ endpoints: [bulk(1, 'in')] }] };
  if (kind === 'noInterface') return { interfaces: [hid] };
  if (kind === 'noAlternates') return { interfaces: [hid, { interfaceNumber: 1, alternates: [] }] };
  const endpoints = [
    { endpointNumber: 3, type: 'interrupt', direction: 'out' },
    ...(kind === 'noOut' ? [] : [bulk(4, 'out')]),
    ...(kind === 'noIn' ? [] : [bulk(5, 'in')]),
  ];
  return { interfaces: [hid, { interfaceNumber: 1, alternates: [{ endpoints }] }] };
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** A fake controller that records every call made to it under its name. */
const fakeDevice = (name: string, kind: DeviceKind, trace: string[]) => {
  const pendingReads: ((reason: Error) => void)[] = [];
  const sent: string[] = [];
  let writes = 0;
  let closes = 0;
  const say = (line: string): void => {
    trace.push(`${name} ${line}`);
  };
  const device: UsbDevice & { opened: boolean; configuration: UsbConfiguration | null } = {
    vendorId: 0x057e,
    productId: kind.productId,
    opened: kind.opened,
    configuration: kind.configuration === 'unselected' ? null : configurationOf(kind.configuration),
    open: async () => {
      say('open');
      device.opened = true;
    },
    selectConfiguration: async (value) => {
      say(`selectConfiguration ${value}`);
      device.configuration = configurationOf('full');
    },
    claimInterface: async (value) => {
      say(`claimInterface ${value}`);
      if (kind.claim !== 'ok') throw new DOMException('Unable to claim interface.', kind.claim);
    },
    transferOut: async (endpoint, data) => {
      writes++;
      say(`transferOut ${endpoint} ${hex(data)}`);
      sent.push(hex(data));
      return { status: writes === kind.stallAt ? 'stall' : 'ok' };
    },
    transferIn: (endpoint, length) => {
      say(`transferIn ${endpoint} ${length}`);
      if (kind.read === 'answers') return Promise.resolve({});
      if (kind.read === 'rejects') return Promise.reject(new DOMException('stalled', 'NetworkError'));
      // A controller that stays silent: the read ends only when the device is closed.
      return new Promise((_, reject) => {
        pendingReads.push(reject);
      });
    },
    clearHalt: async (direction, endpoint) => {
      say(`clearHalt ${direction} ${endpoint}`);
    },
    releaseInterface: async (value) => {
      say(`releaseInterface ${value}`);
      if (kind.cleanup === 'releaseFails') throw new DOMException('not claimed', 'InvalidStateError');
    },
    close: async () => {
      say('close');
      closes++;
      device.opened = false;
      for (const reject of pendingReads.splice(0)) reject(new DOMException('aborted', 'AbortError'));
      if (kind.cleanup === 'closeFails') throw new DOMException('gone', 'NotFoundError');
    },
  };
  return { device, sent, closes: () => closes };
};

type PadListener = (event: { readonly gamepad: { readonly id: string } | null }) => void;
type UsbListener = (event: { readonly device: UsbDevice }) => void;

interface PageKind {
  /** 'none' for a host with no document at all. */
  readonly readyState: 'complete' | 'loading' | 'none';
  readonly usb: boolean;
  readonly granted: readonly UsbDevice[];
  readonly getDevicesFails: boolean;
  /** What the device chooser answers, one per click. */
  readonly chooser: readonly (UsbDevice | Error)[];
  readonly pads: (typeof PADS)[number];
}

const BARE: PageKind = {
  readyState: 'none',
  usb: false,
  granted: [],
  getDevicesFails: false,
  chooser: [],
  pads: 'none',
};

const PRO2_ID = 'Switch 2 Pro Controller (Vendor: 057e Product: 2069)';
const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';

/** A fake page that records, in order, everything written to its controls and console. */
const page = (kind: PageKind, trace: string[]) => {
  const clicks: (() => void)[] = [];
  const domReady: (() => void)[] = [];
  const padListeners = new Set<PadListener>();
  const usbListeners = new Map<string, UsbListener[]>();
  const answers = [...kind.chooser];
  const control = (name: string) => {
    let text: string | null = '';
    let hidden: boolean | string = true;
    return {
      get textContent() {
        return text;
      },
      set textContent(value: string | null) {
        text = value;
        trace.push(`${name} text ${value}`);
      },
      get hidden() {
        return hidden;
      },
      set hidden(value: boolean | string) {
        hidden = value;
        trace.push(`${name} hidden ${value}`);
      },
      addEventListener: (type: string, listener: () => void) => {
        trace.push(`${name} listen ${type}`);
        clicks.push(listener);
      },
    };
  };
  const status = control('status');
  const button = control('button');
  const controls = new Map([
    ['switch2-status', status],
    ['switch2-connect-btn', button],
  ]);
  const usb = {
    requestDevice: (options: { filters: typeof SWITCH2_FILTERS }) => {
      trace.push(`requestDevice ${JSON.stringify(options)}`);
      const answer = answers.shift();
      if (!answer || answer instanceof Error)
        return Promise.reject(answer ?? new Error('the chooser was not expected'));
      return Promise.resolve(answer);
    },
    getDevices: () => {
      trace.push('getDevices');
      if (kind.getDevicesFails) return Promise.reject(new DOMException('blocked', 'SecurityError'));
      return Promise.resolve(kind.granted);
    },
    addEventListener: (type: string, listener: UsbListener) => {
      trace.push(`usb listen ${type}`);
      usbListeners.set(type, [...(usbListeners.get(type) ?? []), listener]);
    },
  };
  const getGamepads = () => (kind.pads === 'listed' ? [null, { id: XBOX_ID }, { id: PRO2_ID }] : [{ id: XBOX_ID }]);
  const host: { -readonly [Key in keyof Switch2Host]: Switch2Host[Key] } & { Switch2USB?: Switch2Usb } = {
    navigator: kind.usb ? { usb, getGamepads } : { getGamepads },
    console: {
      info: (message) => {
        trace.push(`info ${message}`);
      },
    },
  };
  if (kind.readyState !== 'none') {
    host.document = {
      readyState: kind.readyState,
      getElementById: (id) => controls.get(id) ?? null,
      addEventListener: (type, listener) => {
        trace.push(`document listen ${type}`);
        domReady.push(listener);
      },
    };
  }
  if (kind.pads !== 'none') {
    // The DOM ignores a listener that is already registered.
    host.addEventListener = (type, listener) => {
      trace.push(`window listen ${type}`);
      padListeners.add(listener);
    };
    host.removeEventListener = (type, listener) => {
      trace.push(`window unlisten ${type}`);
      padListeners.delete(listener);
    };
  }
  return {
    host,
    status,
    button,
    click: (): void => {
      for (const listener of clicks) listener();
    },
    domReady: (): void => {
      for (const listener of domReady.splice(0)) listener();
    },
    padConnected: (id: string | null): void => {
      for (const listener of padListeners) listener({ gamepad: id === null ? null : { id } });
    },
    padListeners: () => padListeners.size,
    usbEvent: (type: string, device: UsbDevice): void => {
      for (const listener of usbListeners.get(type) ?? []) listener({ device });
    },
  };
};

type Page = ReturnType<typeof page>;

const startOld = (fake: Page): Switch2Usb => {
  const window = fake.host;
  vm.runInNewContext(OLD_SCRIPT, {
    window,
    document: window.document,
    console: window.console,
    setTimeout,
    clearTimeout,
  });
  assert.ok(window.Switch2USB, 'the old script did not define window.Switch2USB');
  return window.Switch2USB;
};

const startNew = (fake: Page): Switch2Usb => startSwitch2Usb(fake.host);

const STARTS = [startOld, startNew] as const;

/** Let every promise that can settle do so. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await settle();
};

/** How an enable() ended, as a caller sees it. */
const outcomeOf = async (enabling: Promise<boolean>): Promise<string> => {
  try {
    return `resolved ${await enabling}`;
  } catch (thrown) {
    return thrown instanceof Error ? `rejected ${thrown.name}: ${thrown.message}` : `rejected ${String(thrown)}`;
  }
};

// ── the handshake's bytes ────────────────────────────────────────────────────

test('the 17 handshake commands are byte for byte the old script’s', async () => {
  const sent: string[][] = [];
  for (const start of STARTS) {
    const trace: string[] = [];
    const controller = fakeDevice('pad', RESPONSIVE, trace);
    assert.equal(await start(page(BARE, trace)).enable(controller.device, FAST), true);
    sent.push(controller.sent);
  }
  const [oldSent, newSent] = sent;
  assert.equal(oldSent?.length, 17);
  assert.deepEqual(newSent, oldSent);
  assert.deepEqual(SWITCH2_COMMANDS.map(hex), oldSent);
  // The first and the last, written out: a table that was reordered or cut short reads differently.
  assert.equal(oldSent?.[0], '0391000d0008000001' + '00' + 'ffffffffffff');
  assert.equal(oldSent?.[16], '09910007000800000100000000000000');
});

// ── enable() ─────────────────────────────────────────────────────────────────

/** One enable() on a page with a status line, and what a pad showing up afterwards does. */
const enableOnce = async (start: (fake: Page) => Switch2Usb, kind: DeviceKind, pads: (typeof PADS)[number]) => {
  const trace: string[] = [];
  const fake = page({ ...BARE, readyState: 'complete', pads }, trace);
  const controller = fakeDevice('pad', kind, trace);
  const api = start(fake);
  trace.push(await outcomeOf(api.enable(controller.device, FAST)));
  await settle();
  for (const id of [null, XBOX_ID, PRO2_ID, PRO2_ID]) {
    fake.padConnected(id);
    trace.push(`after pad ${id}: ${fake.status.textContent} (${fake.padListeners()} listening)`);
  }
  return trace;
};

test('every handshake makes the USB calls, and reports, as the old script did', async () => {
  const kinds: { readonly kind: DeviceKind; readonly pads: (typeof PADS)[number] }[] = [];
  for (const configuration of CONFIGURATIONS) {
    for (const claim of CLAIMS) {
      for (const stallAt of STALLS) {
        for (const read of READS) {
          const n = kinds.length;
          kinds.push({
            kind: {
              configuration,
              claim,
              stallAt,
              read,
              cleanup: CLEANUPS[n % CLEANUPS.length] ?? 'ok',
              opened: n % 2 === 0,
              productId: 0x2069,
            },
            pads: PADS[Math.floor(n / 3) % PADS.length] ?? 'none',
          });
        }
      }
    }
  }
  assert.equal(kinds.length, CONFIGURATIONS.length * CLAIMS.length * STALLS.length * READS.length);
  const runs = await Promise.all(
    kinds.map(async ({ kind, pads }) => ({
      kind,
      pads,
      oldTrace: await enableOnce(startOld, kind, pads),
      newTrace: await enableOnce(startNew, kind, pads),
    })),
  );
  let sentAll = 0;
  for (const { kind, pads, oldTrace, newTrace } of runs) {
    assert.deepEqual(newTrace, oldTrace, JSON.stringify({ kind, pads }));
    if (newTrace.includes('resolved true')) sentAll++;
  }
  // Enabled only with an OUT endpoint to write to, a claim that worked and no stall.
  assert.equal(sentAll, 3 * READS.length);
});

test('a second enable() while one is running sends nothing, as before', async () => {
  for (const start of STARTS) {
    const trace: string[] = [];
    const controller = fakeDevice('pad', { ...RESPONSIVE, read: 'silent' }, trace);
    const api = start(page(BARE, trace));
    const [first, second] = await Promise.all([
      api.enable(controller.device, FAST),
      api.enable(controller.device, FAST),
    ]);
    assert.deepEqual([first, second], [true, false]);
    assert.equal(trace.filter((line) => line.startsWith('pad claimInterface')).length, 1);
    assert.equal(controller.sent.length, 17);
    assert.equal(await api.enable(controller.device, FAST), true);
    assert.equal(controller.sent.length, 34);
  }
});

test('a silent controller is waited for no longer than the reply timeout, command by command', async () => {
  const trace: string[] = [];
  const controller = fakeDevice('pad', { ...RESPONSIVE, read: 'silent', opened: true }, trace);
  const started = Date.now();
  assert.equal(await startNew(page(BARE, trace)).enable(controller.device, { replyTimeoutMs: 20, gapMs: 0 }), true);
  const took = Date.now() - started;
  assert.ok(took >= 17 * 15, `the 17 reply waits took only ${took} ms`);
  assert.ok(took < 5000, `the 17 reply waits took ${took} ms`);
  // Each command is written, then its reply is read, before the next is written.
  const calls = trace.flatMap((line) => (line.startsWith('pad transfer') ? [line.split(' ')[1]] : []));
  assert.deepEqual(
    calls,
    Array.from({ length: 34 }, (_, i) => (i % 2 === 0 ? 'transferOut' : 'transferIn')),
  );
});

// ── the page: automatic enable, the Connect button, plugging and unplugging ──

interface PageScenario {
  readonly name: string;
  readonly kind: (devices: ReturnType<typeof fakeDevice>[]) => PageKind;
  readonly devices: readonly DeviceKind[];
  readonly steps: (fake: Page, devices: ReturnType<typeof fakeDevice>[], api: Switch2Usb) => Promise<void>;
}

const ON_PAGE: PageKind = { ...BARE, readyState: 'complete', usb: true };
const SWITCH1_PRO: DeviceKind = { ...RESPONSIVE, productId: 0x2009 };

const PAGE_SCENARIOS: readonly PageScenario[] = [
  {
    name: 'a granted controller is enabled without a click',
    devices: [RESPONSIVE],
    kind: ([pad]) => ({ ...ON_PAGE, granted: pad ? [pad.device] : [], pads: 'pressedLater' }),
    steps: async (fake, [pad]) => {
      await until(() => pad?.closes() === 1, 'the automatic enable');
      fake.padConnected(PRO2_ID);
    },
  },
  {
    name: 'a granted controller that cannot be claimed brings the button back',
    devices: [{ ...RESPONSIVE, claim: 'NetworkError' }],
    kind: ([pad]) => ({ ...ON_PAGE, granted: pad ? [pad.device] : [] }),
    steps: async (_, [pad]) => {
      await until(() => pad?.closes() === 1, 'the failed enable');
    },
  },
  {
    name: 'only another Nintendo pad was granted',
    devices: [SWITCH1_PRO],
    kind: ([pad]) => ({ ...ON_PAGE, granted: pad ? [pad.device] : [] }),
    steps: async (fake) => {
      await until(() => fake.button.hidden === false, 'the button');
    },
  },
  {
    name: 'the granted devices cannot be listed',
    devices: [],
    kind: () => ({ ...ON_PAGE, getDevicesFails: true }),
    steps: async (fake) => {
      await until(() => fake.button.hidden === false, 'the button');
    },
  },
  {
    name: 'Connect: chooser cancelled, chooser failing, then a controller chosen',
    devices: [RESPONSIVE],
    kind: ([pad]) => ({
      ...ON_PAGE,
      chooser: [
        new DOMException('No device selected.', 'NotFoundError'),
        new DOMException('Must be handling a user gesture.', 'SecurityError'),
        ...(pad ? [pad.device] : []),
      ],
    }),
    steps: async (fake, [pad]) => {
      await until(() => fake.button.hidden === false, 'the button');
      fake.click();
      await until(() => fake.status.textContent === 'No controller selected.', 'the cancelled chooser');
      fake.click();
      await until(() => fake.status.textContent?.includes('SecurityError') === true, 'the failing chooser');
      fake.click();
      await until(() => pad?.closes() === 1 && fake.button.hidden === true, 'the chosen controller');
    },
  },
  {
    name: 'plugging in: a granted pad is enabled, another pad is left alone; unplugging clears the status',
    devices: [RESPONSIVE, SWITCH1_PRO],
    kind: () => ON_PAGE,
    steps: async (fake, [pad, other]) => {
      await until(() => fake.button.hidden === false, 'the button');
      if (!pad || !other) return;
      fake.usbEvent('connect', other.device);
      fake.usbEvent('disconnect', other.device);
      fake.usbEvent('connect', pad.device);
      await until(() => pad.closes() === 1 && fake.button.hidden === true, 'the plugged-in controller');
      fake.usbEvent('disconnect', pad.device);
    },
  },
  {
    name: 'a browser without WebUSB wires nothing',
    devices: [],
    kind: () => ({ ...ON_PAGE, usb: false }),
    steps: async (fake, _, api) => {
      await settle();
      fake.click();
      assert.equal(api.isSupported(), false);
    },
  },
  {
    name: 'a page still loading is wired when it is ready',
    devices: [],
    kind: () => ({ ...ON_PAGE, readyState: 'loading' }),
    steps: async (fake, _, api) => {
      await settle();
      assert.equal(api.isSupported(), true);
      fake.domReady();
      await until(() => fake.button.hidden === false, 'the button');
    },
  },
  {
    name: 'no document: nothing is wired',
    devices: [],
    kind: () => ({ ...BARE, usb: true }),
    steps: async () => {
      await settle();
    },
  },
];

const runOnPage = async (start: (fake: Page) => Switch2Usb, scenario: PageScenario): Promise<string[]> => {
  const trace: string[] = [];
  const devices = scenario.devices.map((kind, i) => fakeDevice(`pad${i}`, kind, trace));
  const fake = page(scenario.kind(devices), trace);
  const api = start(fake);
  await scenario.steps(fake, devices, api);
  await settle();
  trace.push(`button hidden: ${fake.button.hidden}; status: ${fake.status.textContent}`);
  return trace;
};

test('each page scenario leaves the same trail as the old script, at the real pacing', async () => {
  const runs = await Promise.all(
    PAGE_SCENARIOS.map(async (scenario) => ({
      scenario,
      traces: await Promise.all([runOnPage(startOld, scenario), runOnPage(startNew, scenario)]),
    })),
  );
  for (const { scenario, traces } of runs) {
    const [oldTrace, newTrace] = traces;
    assert.deepEqual(newTrace, oldTrace, scenario.name);
    assert.ok(newTrace.length > 0, scenario.name);
  }
  const wired = runs.filter(({ traces }) => traces[1].includes('getDevices')).length;
  assert.equal(wired, PAGE_SCENARIOS.length - 2);
});

// ── the pure pieces ──────────────────────────────────────────────────────────

// web/static/switch2-usb.js as of #166: _matches, _findEndpoints, _isPro2 and
// the text _setFailure wrote, with the constants they closed over.
const oldMatches = (device: { vendorId: number; productId: number }) =>
  device.vendorId === 0x057e && [0x2069].includes(device.productId);
const oldFindEndpoints = (device: { configuration: UsbConfiguration | null }) => {
  const iface = device.configuration?.interfaces.find((i) => i.interfaceNumber === 1);
  if (!iface) throw new Error(`USB interface ${1} not found`);
  const endpoints = iface.alternates[0]?.endpoints ?? [];
  const out = endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
  const inbound = endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
  if (!out) throw new Error(`USB interface ${1} has no bulk OUT endpoint`);
  return { out: out.endpointNumber, in: inbound?.endpointNumber };
};
const oldIsPro2 = (gp: { id: string } | null | undefined) => !!gp && /057e/i.test(gp.id) && /2069/.test(gp.id);
const OLD_CLAIM_HINT =
  'Another app may be using the controller — quit it and replug. On Windows the WinUSB driver may be needed, and on Linux a udev rule.';
const oldFailureText = (err: { name: string; message: string }, hint = '') =>
  `Switch 2 controller: ${err.name}: ${err.message}${hint ? ` ${hint}` : ''}`;
const oldHint = (name: string) =>
  ['SecurityError', 'NetworkError', 'InvalidStateError'].includes(name) ? OLD_CLAIM_HINT : '';

/** What a lookup returned, or the message it threw. */
const attempt = (lookup: () => { out: number; in: number | undefined }): string => {
  try {
    return JSON.stringify(lookup());
  } catch (thrown) {
    return thrown instanceof Error ? `throws ${thrown.message}` : 'throws something else';
  }
};

test('only the Switch 2 Pro is matched, as a USB device and as a gamepad', () => {
  for (const vendorId of [0x057e, 0x045e, 0]) {
    for (const productId of [0x2069, 0x2009, 0x2066, 0x2067, 0x2073, 0]) {
      assert.equal(isSwitch2Pro({ vendorId, productId }), oldMatches({ vendorId, productId }));
    }
  }
  assert.equal(isSwitch2Pro({ vendorId: 0x057e, productId: 0x2069 }), true);
  assert.deepEqual(SWITCH2_FILTERS, [{ vendorId: 0x057e, productId: 0x2069 }]);
  const pads = [
    null,
    undefined,
    { id: PRO2_ID },
    { id: XBOX_ID },
    { id: '057e-2069-Switch 2 Pro Controller' },
    { id: '057E-2069-Switch 2 Pro Controller' },
    { id: '57e-2069-Switch 2 Pro Controller' },
    { id: '057e-2009-Pro Controller' },
    { id: '' },
  ];
  for (const pad of pads) assert.equal(isPro2Gamepad(pad), oldIsPro2(pad), JSON.stringify(pad));
  assert.equal(isPro2Gamepad({ id: PRO2_ID }), true);
});

test('the endpoints come from the descriptor, or the same error is thrown', () => {
  const descriptors: (UsbConfiguration | null)[] = [
    null,
    ...CONFIGURATIONS.map(configurationOf),
    { interfaces: [] },
    {
      interfaces: [
        { interfaceNumber: 1, alternates: [{ endpoints: [bulk(9, 'in'), bulk(2, 'out'), bulk(7, 'out')] }] },
      ],
    },
    {
      interfaces: [
        { interfaceNumber: 1, alternates: [{ endpoints: [] }, { endpoints: [bulk(2, 'out')] }] },
        { interfaceNumber: 1, alternates: [{ endpoints: [bulk(6, 'out')] }] },
      ],
    },
  ];
  for (const configuration of descriptors) {
    assert.equal(
      attempt(() => findEndpoints(configuration)),
      attempt(() => oldFindEndpoints({ configuration })),
    );
  }
  assert.deepEqual(findEndpoints(configurationOf('full')), { out: 4, in: 5 });
  assert.deepEqual(findEndpoints(configurationOf('noIn')), { out: 4, in: undefined });
});

test('a failure reads as the old script wrote it', () => {
  const names = ['SecurityError', 'NetworkError', 'InvalidStateError', 'NotFoundError', 'Error', ''];
  for (const name of names) {
    assert.equal(claimHint(name), oldHint(name));
    for (const message of ['Unable to claim interface.', 'handshake command 3 of 17: stall', '']) {
      assert.equal(failureText(name, message, claimHint(name)), oldFailureText({ name, message }, oldHint(name)));
      assert.equal(failureText(name, message, ''), oldFailureText({ name, message }));
    }
  }
});

test('a real window satisfies the host the module asks for', () => {
  const accepts = (host: Switch2Host): Switch2Host => host;
  const check = (win: Window): Switch2Host => accepts(win);
  assert.equal(typeof check, 'function');
});
