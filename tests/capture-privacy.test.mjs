// Run: node --test tests/capture-privacy.test.mjs (synthetic canvas; no ROM or network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
const sources = Object.fromEntries(
  ['kn-capture', 'kn-diagnostics', 'kn-vision-client'].map((name) => [name, read(`static/${name}.js`)]),
);
const key = 'kn-diagnostic-images';

function harness({
  search = '',
  saved = null,
  storageFails = false,
  policy = true,
  delayedBlob = false,
  delayedBuffer = false,
  bufferFails = false,
} = {}) {
  const listeners = new Map();
  const counts = { draws: 0, pixels: 0, encodes: 0, uploads: 0, fetches: 0 };
  const logs = [];
  const storage = new Map(saved === null ? [] : [[key, saved]]);
  const controls = Object.fromEntries(
    ['opt-diagnostic-images', 'toolbar-diagnostic-images', 'diagnostic-images-status'].map((id) => [
      id,
      {
        handlers: {},
        attributes: {},
        addEventListener(type, cb) {
          this.handlers[type] = cb;
        },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      },
    ]),
  );
  const blobCallbacks = [];
  const bufferCallbacks = [];
  const pixels = new Uint8Array(32 * 24 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([220, 225, 180, 255], i);
  const canvas = {
    width: 640,
    height: 480,
    getContext: (type) =>
      type === '2d'
        ? {
            drawImage() {
              counts.draws++;
            },
            getImageData() {
              counts.pixels++;
              return { data: pixels };
            },
          }
        : null,
    toDataURL() {
      counts.encodes++;
      return `data:image/jpeg;base64,${'x'.repeat(120)}`;
    },
    toBlob(cb) {
      counts.encodes++;
      const finish = () =>
        cb({
          arrayBuffer: async () => {
            if (bufferFails) throw new Error('synthetic encode failure');
            if (delayedBuffer) await new Promise((resolve) => bufferCallbacks.push(resolve));
            return new Uint8Array([1, 2, 3]).buffer;
          },
        });
      if (delayedBlob) blobCallbacks.push(finish);
      else finish();
    },
  };
  let frame = 60;
  const context = vm.createContext({
    URLSearchParams,
    console: { log() {}, warn() {} },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    Uint8Array,
    KNState: { slot: 0, boardFrame: false },
    KNAudio: { ctx: { state: 'running' } },
    location: { search },
    localStorage: {},
    KNStorage: {
      get: () => {
        if (storageFails) throw new Error('blocked');
        return storage.get(key) ?? null;
      },
      set: (_, k, value) => {
        if (storageFails) throw new Error('blocked');
        storage.set(k, value);
      },
    },
    navigator: { getGamepads: () => [] },
    document: {
      readyState: 'complete',
      querySelector: () => canvas,
      createElement: () => ({ ...canvas }),
      getElementById: (id) => controls[id],
      hasFocus: () => true,
    },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    fetch: async () => {
      counts.fetches++;
      return { json: async () => ({}) };
    },
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
  });
  context.window = context;
  for (const name of Object.keys(sources)) {
    if (name !== 'kn-capture' || policy) vm.runInContext(sources[name], context);
  }
  context.KNDiag.init({
    getFrame: () => frame,
    getSlot: () => 0,
    sendScreenshot: () => counts.uploads++,
    log: (message) => logs.push(message),
  });
  return {
    context,
    counts,
    logs,
    storage,
    controls,
    blobCallbacks,
    bufferCallbacks,
    setFrame: (value) => (frame = value),
  };
}
const input = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
const suspect = { matchId: 'synthetic-match', frame: 300, field: 'test', slot: 0 };

for (const options of [
  { search: '?screenshots=off' },
  { search: '?knperf=light' },
  { saved: 'off' },
  { policy: false },
]) {
  test(`all image entry points fail closed: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    h.context.KNDiag.captureAndSendScreenshot();
    h.context.KNDiag.checkCanvasHealth(60, 'error');
    h.context.KNDiag.checkFreeze(input);
    assert.equal(h.context.KNDiag.captureCanvasHash(), 0);
    assert.equal(h.context.KNDiag.sampleCanvasHealth(), null);
    h.setFrame(600);
    h.context.KNDiag.checkFreeze(input);
    await h.context.KNVision._onSuspect(suspect);
    assert.equal(await h.context.KNVision._captureScaledPng(), null);
    assert.deepEqual(h.counts, { draws: 0, pixels: 0, encodes: 0, uploads: 0, fetches: 0 });
  });
}

test('enabled paths capture periodic, solid-pale and desync images', async () => {
  const h = harness();
  h.context.KNDiag.captureAndSendScreenshot();
  assert.equal(h.counts.uploads, 1);
  h.setFrame(120);
  h.context.KNDiag.checkFreeze(input);
  assert.equal(h.counts.uploads, 2);
  assert.ok(h.logs.some((line) => line.includes('solidPale=true')));
  await h.context.KNVision._onSuspect(suspect);
  assert.equal(h.counts.fetches, 1);
});

test('both periodic engine paths consult live policy instead of a startup snapshot', () => {
  const engine = read('static/netplay-rollback.js');
  const declaration = engine.match(/const _knScreenshots = .*;/)[0];
  const h = harness();
  vm.runInContext(`${declaration}; window.periodicAllowed = _knScreenshots;`, h.context);
  assert.equal(h.context.periodicAllowed(), true);
  h.context.KNCapture.setEnabled(false);
  assert.equal(h.context.periodicAllowed(), false);
  h.context.KNCapture.setEnabled(true);
  assert.equal(h.context.periodicAllowed(), true);
  assert.equal((engine.match(/if \(_knScreenshots\(\) &&/g) || []).length, 2);
});

test('repeated toggles apply immediately, reset image dedup state, preserve listing consent and persist', () => {
  const h = harness();
  h.context.KNState.boardFrame = true;
  for (let i = 1; i <= 3; i++) {
    h.context.KNCapture.setEnabled(false);
    h.context.KNDiag.captureAndSendScreenshot();
    assert.equal(h.counts.uploads, i - 1);
    assert.equal(h.controls['opt-diagnostic-images'].checked, false);
    assert.equal(h.controls['toolbar-diagnostic-images'].attributes['aria-checked'], 'false');
    h.context.KNCapture.setEnabled(true);
    h.context.KNDiag.captureAndSendScreenshot();
    assert.equal(h.counts.uploads, i);
    assert.equal(h.controls['opt-diagnostic-images'].checked, true);
  }
  assert.equal(h.context.KNState.boardFrame, true);
  h.context.KNCapture.setEnabled(false);
  assert.equal(h.storage.get(key), 'off');
  assert.equal(harness({ saved: h.storage.get(key) }).context.KNCapture.allowed(), false);
});

test('checkbox and in-game menu update each other without changing the URL', () => {
  const h = harness();
  const cb = h.controls['opt-diagnostic-images'];
  cb.checked = false;
  cb.handlers.change();
  assert.equal(h.context.KNCapture.allowed(), false);
  h.controls['toolbar-diagnostic-images'].handlers.click();
  assert.equal(cb.checked, true);
  assert.equal(h.context.location.search, '');
});

for (const search of ['?screenshots=off', '?knperf=light']) {
  test(`URL opt-out cannot be overridden by preference or another tab: ${search}`, () => {
    const h = harness({ search });
    h.context.KNCapture.setEnabled(true);
    h.context.dispatchEvent({ type: 'storage', storageArea: h.context.localStorage, key, newValue: 'on' });
    assert.equal(h.context.KNCapture.allowed(), false);
    assert.equal(h.controls['opt-diagnostic-images'].disabled, true);
    assert.equal(h.controls['toolbar-diagnostic-images'].disabled, true);
    assert.equal(h.controls['diagnostic-images-status'].hidden, false);
  });
}

test('storage-unavailable mode still honors the current tab opt-out', () => {
  const h = harness({ storageFails: true });
  h.context.KNCapture.setEnabled(false);
  assert.equal(h.context.KNCapture.allowed(), false);
  h.context.KNDiag.captureAndSendScreenshot();
  assert.equal(h.counts.draws, 0);
});

test('another tab updates the live setting and controls', () => {
  const h = harness();
  h.context.dispatchEvent({ type: 'storage', storageArea: h.context.localStorage, key, newValue: 'off' });
  assert.equal(h.context.KNCapture.allowed(), false);
  assert.equal(h.controls['opt-diagnostic-images'].checked, false);
});

for (const reenable of [false, true]) {
  test(`pending image is discarded after opting out, even if enabled again: ${reenable}`, async () => {
    const h = harness({ delayedBlob: true });
    const pending = h.context.KNVision._onSuspect(suspect);
    assert.equal(h.blobCallbacks.length, 1);
    h.context.KNCapture.setEnabled(false);
    if (reenable) h.context.KNCapture.setEnabled(true);
    h.blobCallbacks[0]();
    await pending;
    assert.equal(h.counts.fetches, 0);
  });
}

test('input and audio diagnostics remain functional with images off', () => {
  const h = harness({ saved: 'off' });
  h.setFrame(360);
  h.context.KNDiag.checkFreeze({ ...input, buttons: 1 });
  h.context.KNAudio.ctx.state = 'suspended';
  h.setFrame(660);
  h.context.KNDiag.checkFreeze(input);
  assert.ok(h.logs.some((line) => line.startsWith('INPUT-DEAD')));
  assert.ok(h.logs.some((line) => line.startsWith('AUDIO-STALL')));
  assert.equal(h.counts.draws, 0);
});

test('all diagnostic pages load shared policy before any capturing module', () => {
  for (const page of ['play.html', 'demo.html']) {
    const html = read(page);
    assert.ok(html.indexOf('/static/kn-capture.js') >= 0);
    assert.ok(html.indexOf('/static/kn-capture.js') < html.indexOf('/static/kn-diagnostics.js'));
    assert.ok(html.indexOf('/static/kn-capture.js') < html.indexOf('/static/netplay-rollback.js'));
  }
});

test('opting out while blob bytes are pending discards the image', async () => {
  const h = harness({ delayedBuffer: true });
  const pending = h.context.KNVision._onSuspect(suspect);
  await Promise.resolve();
  assert.equal(h.bufferCallbacks.length, 1);
  h.context.KNCapture.setEnabled(false);
  h.context.KNCapture.setEnabled(true);
  h.bufferCallbacks[0]();
  await pending;
  assert.equal(h.counts.fetches, 0);
});

test('encoding failures settle without uploading or unhandled rejections', async () => {
  const h = harness({ bufferFails: true });
  await h.context.KNVision._onSuspect(suspect);
  assert.equal(h.counts.fetches, 0);
});

test('a blocked localStorage getter does not break incoming storage events', () => {
  const h = harness();
  Object.defineProperty(h.context, 'localStorage', {
    get() {
      throw new Error('blocked');
    },
  });
  assert.doesNotThrow(() => h.context.dispatchEvent({ type: 'storage', key, newValue: 'off' }));
});

test('optional rollback diagnostic probe also honors image opt-outs', () => {
  const engine = read('static/netplay-rollback.js');
  assert.match(
    engine,
    /const _probeCanvasHash = \(\) => {\s*if \(!RB_PROBE \|\| !window.KNCapture\?\.allowed\(\)\) return 0;/,
  );
});
