/**
 * WebUSB "wake-up" for the Nintendo Switch 2 Pro Controller (USB-C). Moved
 * from web/static/switch2-usb.js.
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
 * Wires its own controls (#switch2-connect-btn, #switch2-status in play.html).
 */
import { Duration, Effect } from 'effect';

// Switch 2 Pro only: Joy-Con 2 and the NSO GameCube pad take the same handshake but no
// gamepad profile maps their buttons. Switch 1 pads use other product IDs and work natively.
export const SWITCH2_VENDOR_ID = 0x057e;
export const SWITCH2_PRODUCT_IDS: readonly number[] = [0x2069];
/** What the browser's device chooser is asked to list. */
export const SWITCH2_FILTERS = SWITCH2_PRODUCT_IDS.map((productId) => ({ vendorId: SWITCH2_VENDOR_ID, productId }));

const CONFIGURATION = 1;
const INTERFACE = 1; // vendor-specific (class 255); interface 0 is HID and stays with the OS

/** Handshake commands, sent in this order (community-documented sequence). */
export const SWITCH2_COMMANDS: readonly Uint8Array[] = [
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

/** A USB endpoint, as its descriptor reads. */
export interface UsbEndpoint {
  readonly endpointNumber: number;
  readonly type: string;
  readonly direction: string;
}

/** A device's selected configuration, as far as the endpoints are looked up in it. */
export interface UsbConfiguration {
  readonly interfaces: readonly {
    readonly interfaceNumber: number;
    readonly alternates: readonly { readonly endpoints: readonly UsbEndpoint[] }[];
  }[];
}

/** The part of a WebUSB `USBDevice` the handshake uses. */
export interface UsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly opened: boolean;
  /** null until a configuration is selected. */
  readonly configuration: UsbConfiguration | null;
  open(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(value: number): Promise<void>;
  transferOut(endpoint: number, data: Uint8Array): Promise<{ readonly status: string }>;
  transferIn(endpoint: number, length: number): Promise<object>;
  clearHalt(direction: 'out', endpoint: number): Promise<void>;
  releaseInterface(value: number): Promise<void>;
  close(): Promise<void>;
}

/** The device is a Switch 2 Pro Controller. */
export const isSwitch2Pro = (device: { readonly vendorId: number; readonly productId: number }): boolean =>
  device.vendorId === SWITCH2_VENDOR_ID && SWITCH2_PRODUCT_IDS.includes(device.productId);

/**
 * The bulk endpoints of the vendor interface: where commands are written, and
 * where replies are read if the interface has an IN endpoint. Read from the
 * descriptor, never assumed. Throws when the interface or its OUT endpoint is
 * missing; the message is shown to the player as it is.
 */
export const findEndpoints = (configuration: UsbConfiguration | null | undefined) => {
  const iface = configuration?.interfaces.find((i) => i.interfaceNumber === INTERFACE);
  if (!iface) throw new Error(`USB interface ${INTERFACE} not found`);
  const endpoints = iface.alternates[0]?.endpoints ?? [];
  const out = endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
  const inbound = endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
  if (!out) throw new Error(`USB interface ${INTERFACE} has no bulk OUT endpoint`);
  return { out: out.endpointNumber, in: inbound?.endpointNumber };
};

const CLAIM_HINT =
  'Another app may be using the controller — quit it and replug. On Windows the WinUSB driver may be needed, and on Linux a udev rule.';
const CLAIM_ERRORS: readonly string[] = ['SecurityError', 'NetworkError', 'InvalidStateError'];

/** The advice added to a failure that means the interface could not be claimed; empty for any other. */
export const claimHint = (errorName: string): string => (CLAIM_ERRORS.includes(errorName) ? CLAIM_HINT : '');

/** The status line for a failure. The error text is the only diagnostic on real hardware, so it is shown verbatim. */
export const failureText = (errorName: string, message: string, hint: string): string =>
  `Switch 2 controller: ${errorName}: ${message}${hint ? ` ${hint}` : ''}`;

/** A gamepad the browser lists is the Switch 2 Pro (its id carries the vendor and product ids). */
export const isPro2Gamepad = (gamepad: { readonly id: string } | null | undefined): boolean =>
  !!gamepad && /057e/i.test(gamepad.id) && /2069/.test(gamepad.id);

/**
 * The wait after a command: the controller's reply, for at most
 * `replyTimeoutMs`, then the gap before the next command.
 *
 * The reply is best-effort. WebUSB's transferIn has no timeout of its own, so
 * it is given one here; a read that loses is left pending and aborted when the
 * device is closed, and a read that fails is ignored either way. `inbound` is
 * undefined for an interface with no IN endpoint: then only the gap is waited.
 */
export const replyThenGap = Effect.fnUntraced(function* (
  device: Pick<UsbDevice, 'transferIn'>,
  inbound: number | undefined,
  replyTimeoutMs: number,
  gapMs: number,
): Effect.fn.Return<void> {
  if (inbound !== undefined) {
    yield* Effect.tryPromise(() => device.transferIn(inbound, 64)).pipe(
      Effect.ignore,
      Effect.timeoutOption(Duration.millis(replyTimeoutMs)),
    );
  }
  yield* Effect.sleep(Duration.millis(gapMs));
});

/** How long the handshake waits; the defaults are what real hardware gets. */
export interface EnableOptions {
  readonly replyTimeoutMs?: number;
  readonly gapMs?: number;
}

/** `window.Switch2USB`. */
export interface Switch2Usb {
  /**
   * Send the handshake. Resolves true once it was sent, false if one is
   * already running for this device. Rejects with the underlying error after
   * reporting it in the status line.
   */
  readonly enable: (device: UsbDevice, opts?: EnableOptions) => Promise<boolean>;
  /** The browser has WebUSB. */
  readonly isSupported: () => boolean;
}

/** The status line or the Connect button. */
interface Switch2Control {
  textContent: string | null;
  /** Written as a boolean; an element's own `hidden` can also read 'until-found'. */
  hidden: boolean | string;
  addEventListener(type: 'click', listener: () => void): void;
}

/** A gamepad, as far as it is told apart. */
interface ListedGamepad {
  readonly id: string;
}

/** A WebUSB connection event. */
interface UsbConnectionEvent {
  readonly device: UsbDevice;
}

/** The part of `navigator.usb` used here. */
interface Usb {
  requestDevice(options: { filters: typeof SWITCH2_FILTERS }): Promise<UsbDevice>;
  getDevices(): Promise<readonly UsbDevice[]>;
  addEventListener(type: 'connect' | 'disconnect', listener: (event: UsbConnectionEvent) => void): void;
}

/** The part of `window` the module uses. Everything is optional: tests run `enable` with no page at all. */
export interface Switch2Host {
  readonly navigator?:
    | {
        readonly usb?: Usb | undefined;
        getGamepads?(): ArrayLike<ListedGamepad | null>;
      }
    | undefined;
  readonly document?:
    | {
        readonly readyState: string;
        getElementById(id: string): Switch2Control | null;
        addEventListener(type: 'DOMContentLoaded', listener: () => void): void;
      }
    | undefined;
  /** The browser's own getGamepads, kept from before the emulator replaced it (api-sandbox.js). */
  readonly APISandbox?: { nativeGetGamepads(): ArrayLike<ListedGamepad | null> } | undefined;
  /** A page's console; the global one is used when the host has none of its own. */
  readonly console?: { info(message: string): void } | undefined;
  addEventListener?(
    type: 'gamepadconnected',
    listener: (event: { readonly gamepad: ListedGamepad | null }) => void,
  ): void;
  removeEventListener?(
    type: 'gamepadconnected',
    listener: (event: { readonly gamepad: ListedGamepad | null }) => void,
  ): void;
}

/**
 * Wire the Connect button, re-enable a controller the player granted before,
 * follow it being plugged and unplugged, and return `window.Switch2USB`.
 * A host with no document gets `enable` and nothing wired.
 */
export const startSwitch2Usb = (host: Switch2Host): Switch2Usb => {
  /** Devices mid-handshake: the automatic enable and a connect event can race. */
  const inFlight = new Set<UsbDevice>();

  const info = (message: string): void => {
    (host.console ?? console).info(message);
  };
  const byId = (id: string): Switch2Control | null => host.document?.getElementById(id) ?? null;

  const isSupported = (): boolean => !!host.navigator?.usb;

  // ── Controls ─────────────────────────────────────────────────────────

  const setStatus = (text: string): void => {
    const el = byId('switch2-status');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  };

  // The Connect button is only needed for the first grant, or to retry a failed enable.
  const setConnectVisible = (visible: boolean): void => {
    const el = byId('switch2-connect-btn');
    if (el) el.hidden = !visible;
  };

  const setFailure = (err: Error, hint = ''): void => {
    info(`[switch2-usb] failed: ${err.name}: ${err.message}`);
    setStatus(failureText(err.name, err.message, hint));
  };

  // ── Ready feedback ───────────────────────────────────────────────────

  const pads = (): ArrayLike<ListedGamepad | null> =>
    host.APISandbox?.nativeGetGamepads() ?? host.navigator?.getGamepads?.() ?? [];

  // Chrome exposes a pad only after its first button press. A single shared handler
  // keeps repeated handshakes from stacking listeners (addEventListener ignores the
  // same function twice); it removes itself once the pad shows up.
  const onGamepadConnected = (e: { readonly gamepad: ListedGamepad | null }): void => {
    if (!isPro2Gamepad(e.gamepad)) return;
    host.removeEventListener?.('gamepadconnected', onGamepadConnected);
    setStatus('Switch 2 controller ready.');
  };

  const awaitGamepad = (): void => {
    // A page only: a host with no event target (tests that run `enable` alone) is told nothing more.
    if (typeof host.addEventListener !== 'function') return;
    // A button pressed before the handshake finished has already exposed the pad: no new event will come.
    if (Array.from(pads()).some(isPro2Gamepad)) {
      setStatus('Switch 2 controller ready.');
      return;
    }
    host.addEventListener('gamepadconnected', onGamepadConnected);
  };

  // ── Handshake ────────────────────────────────────────────────────────

  const cleanup = async (device: UsbDevice, claimed: boolean): Promise<void> => {
    if (claimed) {
      try {
        await device.releaseInterface(INTERFACE);
      } catch (thrown) {
        // USB failures are DOMExceptions, which are Errors.
        const err = thrown instanceof Error ? thrown : new Error(String(thrown));
        info(`[switch2-usb] releaseInterface: ${err.name}: ${err.message}`);
      }
    }
    try {
      await device.close();
    } catch (thrown) {
      // USB failures are DOMExceptions, which are Errors.
      const err = thrown instanceof Error ? thrown : new Error(String(thrown));
      info(`[switch2-usb] close: ${err.name}: ${err.message}`);
    }
  };

  const enable = async (device: UsbDevice, opts?: EnableOptions): Promise<boolean> => {
    const { replyTimeoutMs = 150, gapMs = 50 } = opts ?? {};
    if (inFlight.has(device)) return false;
    inFlight.add(device);
    setStatus('Enabling Switch 2 controller…');
    let claimed = false;
    try {
      if (!device.opened) await device.open();
      if (device.configuration === null) await device.selectConfiguration(CONFIGURATION);
      const endpoints = findEndpoints(device.configuration);
      await device.claimInterface(INTERFACE);
      claimed = true;
      for (const [n, command] of SWITCH2_COMMANDS.entries()) {
        // A stalled endpoint resolves with status 'stall' instead of rejecting.
        const result = await device.transferOut(endpoints.out, command);
        if (result.status !== 'ok') {
          // Cleared so that a retry starts clean.
          await device.clearHalt('out', endpoints.out).catch(() => undefined);
          throw new Error(`handshake command ${n + 1} of ${SWITCH2_COMMANDS.length}: ${result.status}`);
        }
        await Effect.runPromise(replyThenGap(device, endpoints.in, replyTimeoutMs, gapMs));
      }
      info('[switch2-usb] handshake sent');
      setStatus('Switch 2 controller enabled — press any button.');
      awaitGamepad();
      return true;
    } catch (thrown) {
      // USB failures are DOMExceptions, which are Errors.
      const err = thrown instanceof Error ? thrown : new Error(String(thrown));
      setFailure(err, claimHint(err.name));
      throw thrown;
    } finally {
      await cleanup(device, claimed);
      inFlight.delete(device);
    }
  };

  // ── Connect / auto re-enable ─────────────────────────────────────────

  // enable() already reports a failure in the status line; the button doubles as the retry.
  const enableAndSync = async (device: UsbDevice): Promise<void> => {
    try {
      await enable(device);
      setConnectVisible(false);
    } catch {
      setConnectVisible(true);
    }
  };

  const start = async (usb: Usb): Promise<void> => {
    // Must run inside a user gesture (requestDevice needs one).
    const connect = async (): Promise<void> => {
      let device: UsbDevice;
      try {
        device = await usb.requestDevice({ filters: SWITCH2_FILTERS });
      } catch (thrown) {
        // USB failures are DOMExceptions, which are Errors.
        const err = thrown instanceof Error ? thrown : new Error(String(thrown));
        if (err.name === 'NotFoundError') setStatus('No controller selected.');
        else setFailure(err);
        return;
      }
      await enableAndSync(device);
    };
    byId('switch2-connect-btn')?.addEventListener('click', connect);
    usb.addEventListener('connect', (e) => {
      if (isSwitch2Pro(e.device)) void enableAndSync(e.device);
    });
    usb.addEventListener('disconnect', (e) => {
      if (isSwitch2Pro(e.device)) setStatus('');
    });
    // getDevices() needs no prompt once the user has granted the device.
    let granted: readonly UsbDevice[] = [];
    try {
      granted = (await usb.getDevices()).filter(isSwitch2Pro);
    } catch (thrown) {
      // USB failures are DOMExceptions, which are Errors.
      const err = thrown instanceof Error ? thrown : new Error(String(thrown));
      info(`[switch2-usb] getDevices: ${err.name}: ${err.message}`);
    }
    setConnectVisible(granted.length === 0);
    for (const device of granted) void enableAndSync(device);
  };

  const startWhenSupported = (): void => {
    const usb = host.navigator?.usb;
    if (usb) void start(usb);
  };

  const { document } = host;
  if (document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWhenSupported);
    else startWhenSupported();
  }

  return { enable, isSupported };
};

declare global {
  interface Window {
    Switch2USB?: Switch2Usb;
  }
}
