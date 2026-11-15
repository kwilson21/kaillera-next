import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blitCrop,
  capturePlan,
  capturePreference,
  coreFpsReset,
  directScaleDownBy,
  isSafariUserAgent,
  preferCodecs,
  sdpSummary,
  setSdpBitrate,
  tuneEncoding,
  tuneOfferSdp,
} from '../../web/src/streaming/video.ts';
import { lcg } from './load-shared.ts';

// ── the engine's own code, kept as an oracle ─────────────────────────────────
// web/static/netplay-streaming.js at this commit, with what it read from the
// page turned into parameters.

/** `getCaptureModePreference` (lines 776-790); `stored` is the localStorage read. */
const oldPreference = (search: string, stored: string | null): string => {
  const params = new URLSearchParams(search);
  let raw = params.get('streamCapture') || params.get('captureMode');
  if (!raw) raw = stored;
  raw = String(raw || '').toLowerCase();
  if (raw === 'blit') return 'blit';
  return 'direct';
};

/** `computeDirectScaleDownBy` (lines 792-805). */
const oldScale = (width: number, height: number): number => {
  const sw = width || 0;
  const sh = height || 0;
  if (!sw || !sh) return 1;
  const targetAspect = 640 / 480;
  const srcAspect = sw / sh;
  if (srcAspect > targetAspect + 0.01) return Math.max(1, sh / 480);
  if (srcAspect < targetAspect - 0.01) return Math.max(1, sw / 640);
  return Math.max(1, sw / 640, sh / 480);
};

/** `computeCrop` in startBlitCanvasCapture (lines 836-850). */
const oldCrop = (sw: number, sh: number) => {
  const TARGET_ASPECT = 4 / 3;
  const srcAspect = sw / sh;
  if (srcAspect > TARGET_ASPECT + 0.01) {
    const cropW = Math.round(sh * TARGET_ASPECT);
    return { sx: Math.round((sw - cropW) / 2), sy: 0, sw: cropW, sh };
  } else if (srcAspect < TARGET_ASPECT - 0.01) {
    const cropH = Math.round(sw / TARGET_ASPECT);
    return { sx: 0, sy: Math.round((sh - cropH) / 2), sw, sh: cropH };
  }
  return { sx: 0, sy: 0, sw, sh };
};

/** `setSDPBitrate` (lines 1028-1045). */
const oldBitrate = (sdp: string, bitrateKbps: number): string => {
  const lines = sdp.split('\r\n');
  const result = [];
  let inVideo = false;
  for (const line of lines) {
    result.push(line);
    if (line.startsWith('m=video')) {
      inVideo = true;
    } else if (line.startsWith('m=') && !line.startsWith('m=video')) {
      inVideo = false;
    }
    if (inVideo && line.startsWith('c=')) {
      result.push(`b=AS:${bitrateKbps}`);
    }
  }
  return result.join('\r\n');
};

/** `preferCodecs` (lines 1047-1087). */
const oldPrefer = (sdp: string): string => {
  const lines = sdp.split('\r\n');
  const codecPts = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) (VP9|H264|VP8)\//i);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const name = m[2].toUpperCase();
      if (!codecPts.get(name)) codecPts.set(name, m[1]);
    }
  }
  const preferred: string[] = [];
  const h264 = codecPts.get('H264');
  const vp9 = codecPts.get('VP9');
  if (h264) preferred.push(h264);
  if (vp9) preferred.push(vp9);
  if (preferred.length === 0) return sdp;
  return lines
    .map((line) => {
      if (line.startsWith('m=video')) {
        const parts = line.split(' ');
        const header = parts.slice(0, 3);
        const pts = parts.slice(3);
        const prefSet = new Set(preferred);
        const rest = pts.filter((p) => !prefSet.has(p));
        return [...header, ...preferred, ...rest].join(' ');
      }
      return line;
    })
    .join('\r\n');
};

type OldEncoding = { [key: string]: string | number | boolean };
type OldParams = { encodings?: OldEncoding[]; degradationPreference?: string; transactionId?: string };

/** `optimizeVideoEncoding` (lines 1089-1119): what it does to one video sender's parameters. */
const oldEncoding = (params: OldParams, captureMode: string, captureScaleDownBy: number): OldParams => {
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  const first = params.encodings[0];
  assert.ok(first);
  first['maxBitrate'] = 2_500_000;
  first['maxFramerate'] = 60;
  first['networkPriority'] = 'high';
  if (captureMode === 'direct' && captureScaleDownBy > 1.001) {
    first['scaleResolutionDownBy'] = captureScaleDownBy;
  }
  params.degradationPreference = 'maintain-framerate';
  return params;
};

/** The frame-rate watchdog's sample (lines 284-308): does it reset the main loop? */
const oldFpsReset = (elapsed: number, delta: number, now: number, cooldownUntil: number): boolean => {
  if (elapsed <= 0 || delta <= 0) return false;
  const fps = (delta * 1000) / elapsed;
  if (fps <= 70 || now < cooldownUntil) return false;
  return true;
};

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15',
  '',
];

test('the capture mode asked for is the engine own reading of the address and the stored setting', () => {
  const values = ['blit', 'BLIT', 'direct', '', 'nonsense'];
  const stored = [null, ...values];
  for (const a of [undefined, ...values]) {
    for (const b of [undefined, ...values]) {
      for (const s of stored) {
        const query = [a === undefined ? '' : `streamCapture=${a}`, b === undefined ? '' : `captureMode=${b}`];
        const search = `?${query.filter(Boolean).join('&')}`;
        assert.equal(capturePreference(search, s), oldPreference(search, s), `${search} stored=${s}`);
      }
    }
  }
  assert.equal(capturePreference('', null), 'direct');
  assert.equal(capturePreference('?streamCapture=blit', null), 'blit');
});

test('only Safari itself is Safari', () => {
  assert.deepEqual(USER_AGENTS.map(isSafariUserAgent), [true, true, false, false, false, true, false]);
  // isSafariBrowser (line 774).
  for (const ua of USER_AGENTS) assert.equal(isSafariUserAgent(ua), /^((?!chrome|android).)*safari/i.test(ua));
});

test('scale and crop are the engine own, over many canvas sizes', () => {
  const next = lcg(43);
  const sizes: [number, number][] = [
    [640, 480],
    [1280, 960],
    [1920, 1080],
    [320, 240],
    [480, 640],
    [0, 480],
    [640, 0],
    [1283, 960],
  ];
  for (let round = 0; round < 3000; round++) sizes.push([next() % 4000, next() % 3000]);
  for (const [width, height] of sizes) {
    assert.equal(directScaleDownBy(width, height), oldScale(width, height), `${width}x${height}`);
    if (width > 0 && height > 0) assert.deepEqual(blitCrop(width, height), oldCrop(width, height));
  }
  assert.equal(directScaleDownBy(1280, 960), 2);
  assert.deepEqual(blitCrop(1920, 1080), { sx: 240, sy: 0, sw: 1440, sh: 1080 });
});

test('the capture plan is direct unless blit was asked for or the browser is Safari', () => {
  for (const userAgent of USER_AGENTS) {
    for (const search of ['', '?streamCapture=blit', '?captureMode=direct']) {
      for (const stored of [null, 'blit']) {
        const plan = capturePlan({ search, stored, userAgent, width: 1280, height: 960 });
        // startCanvasCapture (lines 899-915), before any fallback.
        const preference = oldPreference(search, stored);
        const safari = /^((?!chrome|android).)*safari/i.test(userAgent);
        const mode = preference === 'direct' && !safari ? 'direct' : 'blit';
        assert.deepEqual(plan, { preference, safari, mode, scale: mode === 'direct' ? 2 : 1 });
      }
    }
  }
});

const CODECS = ['VP8', 'VP9', 'H264', 'h264', 'AV1', 'rtx', 'red', 'ulpfec'];

const randomSdp = (next: () => number): string => {
  const lines = ['v=0', 'o=- 46117327 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2'];
  const sections = 1 + (next() % 3);
  for (let section = 0; section < sections; section++) {
    const kind = ['video', 'audio', 'application'][next() % 3];
    const payloads = Array.from({ length: next() % 7 }, (_, i) => String(96 + i + section * 10));
    lines.push(`m=${kind} 9 UDP/TLS/RTP/SAVPF ${payloads.join(' ')}`.trimEnd());
    if (next() % 5 !== 0) lines.push('c=IN IP4 0.0.0.0');
    lines.push('a=rtcp:9 IN IP4 0.0.0.0', `a=mid:${section}`);
    for (const payload of payloads) lines.push(`a=rtpmap:${payload} ${CODECS[next() % CODECS.length]}/90000`);
  }
  return `${lines.join('\r\n')}\r\n`;
};

test('the offer SDP is rewritten as the engine rewrites it, over random SDPs', () => {
  const next = lcg(47);
  let moved = 0;
  for (let round = 0; round < 3000; round++) {
    const sdp = randomSdp(next);
    assert.equal(setSdpBitrate(sdp, 3000), oldBitrate(sdp, 3000), sdp);
    assert.equal(preferCodecs(sdp), oldPrefer(sdp), sdp);
    const tuned = tuneOfferSdp(sdp);
    assert.equal(tuned, oldPrefer(oldBitrate(sdp, 3000)), sdp);
    if (tuned !== sdp) moved += 1;
  }
  assert.ok(moved > 1000, `only ${moved} SDPs were changed`);
});

test('H264 goes first, then VP9, and the video section is capped', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 100 102',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 VP8/90000',
    'a=rtpmap:98 VP9/90000',
    'a=rtpmap:100 VP9/90000',
    'a=rtpmap:102 H264/90000',
    '',
  ].join('\r\n');
  const summary = sdpSummary(tuneOfferSdp(sdp));
  assert.deepEqual(summary.video, ['m=video 9 UDP/TLS/RTP/SAVPF 102 98 96 97 100']);
  assert.deepEqual(summary.caps, ['b=AS:3000']);
  // The summary holds nothing of the SDP but the lines these rules write.
  assert.deepEqual(Object.keys(summary), ['length', 'video', 'caps']);
});

test('the encoder is tuned as the engine tunes it', () => {
  const starts: OldParams[] = [
    {},
    { encodings: [] },
    { encodings: [{}], transactionId: 't1' },
    { encodings: [{ active: true, scaleResolutionDownBy: 1, maxBitrate: 1 }], degradationPreference: 'balanced' },
    { encodings: [{ active: true }, { rid: 'low', active: false }] },
  ];
  for (const start of starts) {
    for (const mode of ['direct', 'blit', 'none']) {
      for (const scale of [1, 1.001, 1.0011, 2, 3.75]) {
        const old = oldEncoding(structuredClone(start), mode, scale);
        assert.deepEqual(
          tuneEncoding(structuredClone(start), mode, scale),
          old,
          JSON.stringify({ start, mode, scale }),
        );
      }
    }
  }
  assert.deepEqual(tuneEncoding({}, 'direct', 2), {
    encodings: [{ maxBitrate: 2_500_000, maxFramerate: 60, networkPriority: 'high', scaleResolutionDownBy: 2 }],
    degradationPreference: 'maintain-framerate',
  });
});

test('the main loop is reset when the engine would reset it', () => {
  const next = lcg(53);
  let resets = 0;
  for (let round = 0; round < 5000; round++) {
    const elapsed = (next() % 1300) - 50;
    const frames = (next() % 140) - 10;
    const now = next() % 20000;
    const cooldownUntil = next() % 3 === 0 ? 0 : next() % 20000;
    const old = oldFpsReset(elapsed, frames, now, cooldownUntil);
    assert.equal(coreFpsReset(elapsed, frames, now, cooldownUntil), old);
    if (old) resets += 1;
  }
  assert.ok(resets > 100, `only ${resets} resets`);
  assert.equal(coreFpsReset(1000, 70, 0, 0), false);
  assert.equal(coreFpsReset(1000, 71, 0, 0), true);
  assert.equal(coreFpsReset(1000, 120, 4999, 5000), false);
});
