/**
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
    console.info(`[switch2-usb] failed: ${err.name}: ${err.message}`);
    _setStatus(`Switch 2 controller: ${err.name}: ${err.message}${hint ? ` ${hint}` : ''}`);
  }

  const _CLAIM_HINT =
    'Another app may be using the controller — quit it and replug. On Windows the WinUSB driver may be needed; on Linux a udev rule.';
  const _CLAIM_ERRORS = ['SecurityError', 'NetworkError', 'InvalidStateError'];

  // ── Handshake ────────────────────────────────────────────────────────

  function _findEndpoints(device) {
    const iface = device.configuration?.interfaces.find((i) => i.interfaceNumber === INTERFACE);
    if (!iface) throw new Error(`USB interface ${INTERFACE} not found`);
    const endpoints = iface.alternates[0]?.endpoints ?? [];
    const out = endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
    const inbound = endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
    if (!out) throw new Error(`USB interface ${INTERFACE} has no bulk OUT endpoint`);
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
        console.info(`[switch2-usb] releaseInterface: ${err.name}: ${err.message}`);
      }
    }
    try {
      await device.close();
    } catch (err) {
      console.info(`[switch2-usb] close: ${err.name}: ${err.message}`);
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
      for (const command of _COMMANDS) {
        await device.transferOut(endpoints.out, command);
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
      console.info(`[switch2-usb] getDevices: ${err.name}: ${err.message}`);
    }
    _setConnectVisible(granted.length === 0);
    granted.forEach(_enableAndSync);
  }

  window.Switch2USB = { enable, isSupported };

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _start);
  else _start();
})();
