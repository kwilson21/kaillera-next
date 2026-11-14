import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import type { CapturePolicy } from '../../web/src/page/capture.ts';
import {
  scaledSize,
  startVisionClient,
  visionRequestBody,
  VISION_POST_PATH,
  type SuspectDetail,
  type VisionClient,
  type VisionHost,
} from '../../web/src/page/vision-client.ts';

// How the client behaves next to the real capture policy and the diagnostics
// is tests/capture-privacy.test.mjs. Here the module is held to the script it
// replaced: what it draws, encodes, posts and logs, with an opt-out landing at
// each point where a picture is waited for.

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/kn-vision-client.js as of #166, unchanged.
const OLD_SCRIPT = `/**
 * kn-vision-client.js — Bridges KNDesync.events 'desync-capture' to
 * /api/desync-vision. Captures canvas, downscales to ≤512px, POSTs.
 *
 * 'desync-capture' fires on the frame every peer agreed to screenshot for a
 * suspect (kn-desync-detector.js), not when the suspect was raised: the
 * server compares the peers' pictures, so they must be of one frame.
 *
 * Design intent: thin. No business logic. The detector decided this
 * frame deserves a verdict; the vision client just delivers the
 * goods.
 */
(function () {
  'use strict';

  const TARGET_WIDTH = 512;
  const POST_PATH = '/api/desync-vision';

  async function _captureScaledPng() {
    if (!window.KNCapture?.allowed()) return null;
    const revision = KNCapture.revision;
    const src = document.querySelector('#game canvas');
    if (!src || !src.width || !src.height) return null;
    const ratio = TARGET_WIDTH / src.width;
    const scaled = document.createElement('canvas');
    scaled.width = Math.round(src.width * ratio);
    scaled.height = Math.round(src.height * ratio);
    const ctx = scaled.getContext('2d');
    ctx.drawImage(src, 0, 0, scaled.width, scaled.height);
    const blob = await new Promise((resolve) => scaled.toBlob(resolve, 'image/png'));
    if (!blob || !KNCapture.allowed() || revision !== KNCapture.revision) return null;
    const buf = await blob.arrayBuffer();
    if (!KNCapture.allowed() || revision !== KNCapture.revision) return null;
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  async function _onSuspect(detail) {
    if (!detail || !detail.matchId || !window.KNCapture?.allowed()) return;
    const revision = KNCapture.revision;
    let localPng;
    try {
      localPng = await _captureScaledPng();
    } catch (e) {
      console.warn('[KNVision] capture failed', e);
      return;
    }
    // A disable/re-enable while toBlob or arrayBuffer is pending must not
    // revive an image captured before the user opted out.
    if (!localPng || !KNCapture.allowed() || revision !== KNCapture.revision) return;

    const body = {
      match_id: detail.matchId,
      frame: detail.frame,
      field: detail.field,
      slot: detail.slot,
      trigger: detail.trigger,
      peers: [
        {
          slot: KNState.slot ?? 0,
          png_b64: localPng,
          hash: detail.hashes?.local ?? null,
          captured_frame: detail.captureFrame ?? null,
        },
      ],
      replay_meta: detail.replayMeta,
    };

    try {
      const res = await fetch(POST_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      console.log('[KNVision] response:', json);
    } catch (e) {
      console.warn('[KNVision] POST failed', e);
    }
  }

  function _wire() {
    if (window.KNDesync && KNDesync.events) {
      KNDesync.events.addEventListener('desync-capture', (e) => _onSuspect(e.detail));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire);
  } else {
    _wire();
  }

  window.KNVision = { _captureScaledPng, _onSuspect };
})();
`;

const POLICIES = ['on', 'off', 'absent'] as const;
const CANVASES = ['ok', 'missing', 'flat'] as const;
const ENCODES = ['ok', 'noBlob', 'bufferFails'] as const;
const ACTIONS = ['none', 'off', 'offOn'] as const;
const FETCHES = ['ok', 'offline', 'badJson'] as const;

interface Scenario {
  readonly policy: (typeof POLICIES)[number];
  readonly canvas: (typeof CANVASES)[number];
  readonly encode: (typeof ENCODES)[number];
  /** What the player does while the PNG is being encoded. */
  readonly atBlob: (typeof ACTIONS)[number];
  /** What the player does while the PNG's bytes are being read. */
  readonly atBuffer: (typeof ACTIONS)[number];
  readonly fetch: (typeof FETCHES)[number];
  readonly slot: number | null;
  readonly readyState: string;
}

const DETAILS: readonly (SuspectDetail | null)[] = [
  null,
  { frame: 300, field: 'stocks', slot: 1 },
  { matchId: '', frame: 300 },
  { matchId: 'match-1', frame: 300, field: 'stocks', slot: 1 },
  {
    matchId: 'match-2',
    frame: 4242,
    field: 'heartbeat',
    slot: null,
    trigger: 'heartbeat',
    hashes: { local: 0xdeadbeef },
    captureFrame: 4260,
    replayMeta: { depth: 3, frames: [4240, 4241] },
  },
  { matchId: 'match-3', hashes: null, captureFrame: 0, trigger: 'field' },
];

type DesyncListener = (event: { readonly detail?: SuspectDetail | null }) => void;

/** A fake page that records, in order, everything the client does to it. */
const page = (scenario: Scenario) => {
  const trace: string[] = [];
  const blobWaits: (() => void)[] = [];
  const bufferWaits: (() => void)[] = [];
  const desyncListeners: DesyncListener[] = [];
  const domReadyListeners: (() => void)[] = [];
  let on = scenario.policy === 'on';
  let revision = 0;
  // The policy as web/src/page/capture.ts keeps it: every change moves the revision.
  const capture: CapturePolicy = {
    allowed: () => on,
    setEnabled: (value) => {
      if (on === value) return;
      on = value;
      revision++;
    },
    forcedOff: false,
    get revision() {
      return revision;
    },
  };
  const source = scenario.canvas === 'missing' ? null : { width: scenario.canvas === 'flat' ? 0 : 640, height: 480 };
  const blob = {
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        bufferWaits.push(() => {
          if (scenario.encode === 'bufferFails') reject(new Error('synthetic encode failure'));
          else resolve(new Uint8Array([1, 2, 3, 250]).buffer);
        });
      }),
  };
  const host: VisionHost & { KNCapture?: CapturePolicy; KNVision?: VisionClient; window?: unknown } = {
    KNState: { slot: scenario.slot },
    KNDesync: {
      events: {
        addEventListener: (type, listener) => {
          trace.push(`listen ${type}`);
          desyncListeners.push(listener);
        },
      },
    },
    console: {
      log: (...args) => {
        trace.push(`log ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`);
      },
      warn: (...args) => {
        trace.push(`warn ${args.map(String).join(' ')}`);
      },
    },
    document: {
      readyState: scenario.readyState,
      querySelector: (selectors) => {
        trace.push(`query ${selectors}`);
        return source;
      },
      createElement: (tag) => {
        trace.push(`create ${tag}`);
        const scaled = {
          width: 0,
          height: 0,
          getContext: (type: string) => ({
            drawImage: (from: typeof source, x: number, y: number, width: number, height: number) => {
              trace.push(`draw ${type} ${from === source} ${x} ${y} ${width} ${height}`);
            },
          }),
          toBlob: (done: (encoded: typeof blob | null) => void, type: string) => {
            trace.push(`encode ${scaled.width}x${scaled.height} ${type}`);
            blobWaits.push(() => done(scenario.encode === 'noBlob' ? null : blob));
          },
        };
        return scaled;
      },
      addEventListener: (type, listener) => {
        trace.push(`document listen ${type}`);
        domReadyListeners.push(listener);
      },
    },
    fetch: (url, init) => {
      trace.push(`fetch ${url} ${JSON.stringify(init)}`);
      if (scenario.fetch === 'offline') return Promise.reject(new Error('offline'));
      return Promise.resolve({
        json: () =>
          scenario.fetch === 'badJson' ? Promise.reject(new Error('not json')) : Promise.resolve({ verdict: 'same' }),
      });
    },
    btoa: (data) => Buffer.from(data, 'binary').toString('base64'),
  };
  if (scenario.policy !== 'absent') host.KNCapture = capture;
  const act = (action: (typeof ACTIONS)[number]): void => {
    if (action === 'none') return;
    capture.setEnabled(false);
    if (action === 'offOn') capture.setEnabled(true);
  };
  const release = (waits: (() => void)[]): void => {
    for (const go of waits.splice(0)) go();
  };
  return {
    host,
    trace,
    act,
    releaseBlob: () => release(blobWaits),
    releaseBuffer: () => release(bufferWaits),
    domReady: () => release(domReadyListeners),
    desyncListeners,
  };
};

type Page = ReturnType<typeof page>;

const startOld = (fake: Page): VisionClient => {
  const window = fake.host;
  // The old script read `KNCapture`, `KNState`, `document`, `fetch` and `btoa`
  // as globals, so the fake page is the script's global object.
  vm.createContext(window);
  window.window = window;
  vm.runInContext(OLD_SCRIPT, window);
  assert.ok(window.KNVision, 'the old script did not define window.KNVision');
  return window.KNVision;
};

const startNew = (fake: Page): VisionClient => startVisionClient(fake.host);

/** Let every promise that can settle do so. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One suspect from start to finish, with the scenario's opt-outs at the two waits. */
const suspect = async (
  client: VisionClient,
  fake: Page,
  scenario: Scenario,
  detail: SuspectDetail | null,
): Promise<string[]> => {
  const done = client._onSuspect(detail);
  await settle();
  fake.act(scenario.atBlob);
  fake.releaseBlob();
  await settle();
  fake.act(scenario.atBuffer);
  fake.releaseBuffer();
  await settle();
  await done;
  return fake.trace;
};

test('every suspect is drawn, encoded, posted and logged as the old script did it', async () => {
  let compared = 0;
  let posted = 0;
  for (const policy of POLICIES) {
    for (const canvas of CANVASES) {
      for (const encode of ENCODES) {
        for (const atBlob of ACTIONS) {
          for (const atBuffer of ACTIONS) {
            for (const fetch of FETCHES) {
              for (const [index, detail] of DETAILS.entries()) {
                const slot = [0, 2, null][index % 3] ?? null;
                const scenario: Scenario = {
                  policy,
                  canvas,
                  encode,
                  atBlob,
                  atBuffer,
                  fetch,
                  slot,
                  readyState: 'complete',
                };
                const oldPage = page(scenario);
                const newPage = page(scenario);
                const oldTrace = await suspect(startOld(oldPage), oldPage, scenario, detail);
                const newTrace = await suspect(startNew(newPage), newPage, scenario, detail);
                assert.deepEqual(newTrace, oldTrace, JSON.stringify({ scenario, detail }));
                compared++;
                if (newTrace.some((line) => line.startsWith('fetch '))) posted++;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(
    compared,
    POLICIES.length * CANVASES.length * ENCODES.length * ACTIONS.length ** 2 * FETCHES.length * DETAILS.length,
  );
  // Posted only with pictures on, a canvas, a good encode, no opt-out at
  // either wait, and one of the three suspects that name their match.
  assert.equal(posted, FETCHES.length * 3);
});

const PLAIN: Scenario = {
  policy: 'on',
  canvas: 'ok',
  encode: 'ok',
  atBlob: 'none',
  atBuffer: 'none',
  fetch: 'ok',
  slot: 2,
  readyState: 'complete',
};

test('an opt-out at either wait drops the picture, even when pictures are turned on again', async () => {
  for (const atBlob of ACTIONS) {
    for (const atBuffer of ACTIONS) {
      const scenario: Scenario = { ...PLAIN, atBlob, atBuffer };
      const fake = page(scenario);
      const trace = await suspect(startNew(fake), fake, scenario, { matchId: 'm' });
      const fetches = trace.filter((line) => line.startsWith('fetch ')).length;
      assert.equal(fetches, atBlob === 'none' && atBuffer === 'none' ? 1 : 0, `${atBlob}/${atBuffer}`);
    }
  }
});

test('the picture is posted once, as JSON, to the vision endpoint', async () => {
  const fake = page(PLAIN);
  const trace = await suspect(startNew(fake), fake, PLAIN, { matchId: 'm', frame: 9, captureFrame: 12 });
  const body = {
    match_id: 'm',
    frame: 9,
    peers: [{ slot: 2, png_b64: 'AQID+g==', hash: null, captured_frame: 12 }],
  };
  assert.deepEqual(trace, [
    'listen desync-capture',
    'query #game canvas',
    'create canvas',
    'draw 2d true 0 0 512 384',
    'encode 512x384 image/png',
    `fetch ${VISION_POST_PATH} ${JSON.stringify({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })}`,
    'log [KNVision] response: {"verdict":"same"}',
  ]);
});

test("the client listens for the detector's capture events as the old script did", async () => {
  for (const readyState of ['loading', 'interactive', 'complete']) {
    const scenario: Scenario = { ...PLAIN, readyState };
    const traces: string[][] = [];
    for (const start of [startOld, startNew]) {
      const fake = page(scenario);
      start(fake);
      fake.domReady();
      assert.equal(fake.desyncListeners.length, 1, readyState);
      for (const listener of fake.desyncListeners) listener({ detail: { matchId: 'from-the-detector', frame: 7 } });
      await settle();
      fake.releaseBlob();
      await settle();
      fake.releaseBuffer();
      await settle();
      traces.push(fake.trace);
    }
    assert.deepEqual(traces[1], traces[0], readyState);
    assert.ok(traces[1]?.some((line) => line.includes('from-the-detector')));
  }
});

test('a page with no desync detector starts without listening', () => {
  const fake = page(PLAIN);
  const { KNDesync: _none, ...rest } = fake.host;
  const client = startVisionClient(rest);
  assert.equal(typeof client._onSuspect, 'function');
  assert.deepEqual(fake.trace, []);
});

// web/static/kn-vision-client.js as of #166 built the request inline in
// _onSuspect; this is that object literal, with the globals it read as
// parameters.
const oldBody = (detail: SuspectDetail, slot: number | null, localPng: string) => ({
  match_id: detail.matchId,
  frame: detail.frame,
  field: detail.field,
  slot: detail.slot,
  trigger: detail.trigger,
  peers: [
    {
      slot: slot ?? 0,
      png_b64: localPng,
      hash: detail.hashes?.local ?? null,
      captured_frame: detail.captureFrame ?? null,
    },
  ],
  replay_meta: detail.replayMeta,
});

test('the request body is the one the old script built, key for key', () => {
  let compared = 0;
  for (const detail of DETAILS) {
    if (!detail) continue;
    for (const slot of [0, 1, 3, null]) {
      for (const png of ['', 'AQID']) {
        assert.equal(JSON.stringify(visionRequestBody(detail, slot, png)), JSON.stringify(oldBody(detail, slot, png)));
        compared++;
      }
    }
  }
  assert.equal(compared, (DETAILS.length - 1) * 4 * 2);
  assert.equal(visionRequestBody({ matchId: 'm' }, undefined, 'x').peers[0].slot, 0);
});

test('the picture is 512 wide and keeps the canvas shape', () => {
  const sizes: readonly (readonly [number, number])[] = [
    [640, 480],
    [320, 240],
    [1280, 720],
    [512, 384],
    [333, 777],
    [1, 1],
  ];
  for (const [width, height] of sizes) {
    const ratio = 512 / width;
    assert.deepEqual(scaledSize(width, height), {
      width: Math.round(width * ratio),
      height: Math.round(height * ratio),
    });
  }
  assert.deepEqual(scaledSize(640, 480), { width: 512, height: 384 });
});

test('a real window satisfies the host the client asks for', () => {
  const accepts = (host: VisionHost): VisionHost => host;
  const check = (win: Window): VisionHost => accepts(win);
  assert.equal(typeof check, 'function');
});
