/**
 * The streaming host's video choices: how the canvas is captured, what the
 * offer's SDP asks for, the encoder's limits, and when a core running too
 * fast is reset. Each is the rule web/static/netplay-streaming.js applies
 * today (getCaptureModePreference, computeDirectScaleDownBy, computeCrop,
 * setSDPBitrate, preferCodecs, optimizeVideoEncoding, the frame-rate
 * watchdog). The engine still decides; observe.ts compares.
 */
import type { WirePayload } from '../wire.ts';

/** The picture guests are sent: 4:3 at the N64's size. */
export const TARGET_WIDTH = 640;
export const TARGET_HEIGHT = 480;
const TARGET_ASPECT = TARGET_WIDTH / TARGET_HEIGHT;
/** How far a canvas may be from 4:3 and still count as 4:3. */
const ASPECT_SLACK = 0.01;

export type CaptureMode = 'direct' | 'blit';

/**
 * The capture mode asked for: `?streamCapture=` (or `?captureMode=`) in the
 * page address, else the stored `kn-stream-capture`. Only `blit` asks for
 * the older path; anything else is the default, direct capture.
 */
export const capturePreference = (search: string, stored: string | null): CaptureMode => {
  const params = new URLSearchParams(search);
  const raw = params.get('streamCapture') || params.get('captureMode') || stored;
  return String(raw || '').toLowerCase() === 'blit' ? 'blit' : 'direct';
};

/** Safari, where direct canvas capture is not used. Chrome and Android browsers also say "Safari". */
export const isSafariUserAgent = (userAgent: string): boolean => /^((?!chrome|android).)*safari/i.test(userAgent);

/**
 * How much the encoder scales a directly captured canvas down so that its
 * 4:3 middle is no larger than 640x480; never below 1 (it does not scale up).
 */
export const directScaleDownBy = (width: number, height: number): number => {
  const sw = width || 0;
  const sh = height || 0;
  if (!sw || !sh) return 1;
  const aspect = sw / sh;
  if (aspect > TARGET_ASPECT + ASPECT_SLACK) return Math.max(1, sh / TARGET_HEIGHT);
  if (aspect < TARGET_ASPECT - ASPECT_SLACK) return Math.max(1, sw / TARGET_WIDTH);
  return Math.max(1, sw / TARGET_WIDTH, sh / TARGET_HEIGHT);
};

/** The 4:3 middle of a canvas, for the blit path: a wider canvas loses its sides, a taller one its top and bottom. */
export const blitCrop = (width: number, height: number) => {
  const aspect = width / height;
  if (aspect > TARGET_ASPECT + ASPECT_SLACK) {
    const cropW = Math.round(height * TARGET_ASPECT);
    return { sx: Math.round((width - cropW) / 2), sy: 0, sw: cropW, sh: height };
  }
  if (aspect < TARGET_ASPECT - ASPECT_SLACK) {
    const cropH = Math.round(width / TARGET_ASPECT);
    return { sx: 0, sy: Math.round((height - cropH) / 2), sw: width, sh: cropH };
  }
  return { sx: 0, sy: 0, sw: width, sh: height };
};

/**
 * How the host captures its canvas: directly unless blit was asked for or
 * the browser is Safari. The engine falls back to blit if direct capture
 * throws; that is an effect, not part of this plan.
 */
export const capturePlan = (page: {
  readonly search: string;
  readonly stored: string | null;
  readonly userAgent: string;
  readonly width: number;
  readonly height: number;
}) => {
  const preference = capturePreference(page.search, page.stored);
  const safari = isSafariUserAgent(page.userAgent);
  const mode: CaptureMode = preference === 'direct' && !safari ? 'direct' : 'blit';
  return { preference, safari, mode, scale: mode === 'direct' ? directScaleDownBy(page.width, page.height) : 1 };
};

// ── the offer's SDP ──────────────────────────────────────────────────────────

/** The bitrate the offer asks the other side to stay under, kbit/s. */
export const OFFER_BITRATE_KBPS = 3000;

/** Add `b=AS:<kbps>` after each connection line of the video section. */
export const setSdpBitrate = (sdp: string, kbps: number): string => {
  const result: string[] = [];
  let inVideo = false;
  for (const line of sdp.split('\r\n')) {
    result.push(line);
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    if (inVideo && line.startsWith('c=')) result.push(`b=AS:${kbps}`);
  }
  return result.join('\r\n');
};

/**
 * Put H264, then VP9, first among the video section's payload types, the
 * rest in their original order: phones decode H264 in hardware, and iOS may
 * never deliver frames from a VP9 track. Each codec's first payload type is
 * the one moved. An SDP offering neither is returned unchanged.
 */
export const preferCodecs = (sdp: string): string => {
  const lines = sdp.split('\r\n');
  const first = new Map<string, string>();
  for (const line of lines) {
    const [, payload, codec] = /^a=rtpmap:(\d+) (VP9|H264|VP8)\//i.exec(line) ?? [];
    if (payload !== undefined && codec !== undefined && !first.has(codec.toUpperCase())) {
      first.set(codec.toUpperCase(), payload);
    }
  }
  const preferred = [first.get('H264'), first.get('VP9')].filter((payload) => payload !== undefined);
  if (preferred.length === 0) return sdp;
  return lines
    .map((line) => {
      if (!line.startsWith('m=video')) return line;
      const parts = line.split(' ');
      const rest = parts.slice(3).filter((payload) => !preferred.includes(payload));
      return [...parts.slice(0, 3), ...preferred, ...rest].join(' ');
    })
    .join('\r\n');
};

/** The SDP the host sends for an offer the browser made. */
export const tuneOfferSdp = (sdp: string): string => preferCodecs(setSdpBitrate(sdp, OFFER_BITRATE_KBPS));

/**
 * The parts of an SDP these rules write, for comparing two without putting
 * the rest (ICE credentials, fingerprints) into a report.
 */
export const sdpSummary = (sdp: string) => {
  const lines = sdp.split('\r\n');
  return {
    length: sdp.length,
    video: lines.filter((line) => line.startsWith('m=video')),
    caps: lines.filter((line) => line.startsWith('b=AS:')),
  };
};

// ── the encoder ──────────────────────────────────────────────────────────────

type Json = { readonly [key: string]: WirePayload };

const isObject = (value: WirePayload): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 2.5 Mbit/s is ample for 640x480. */
export const MAX_BITRATE = 2_500_000;
export const MAX_FRAMERATE = 60;

/**
 * A video sender's parameters as the host sets them: capped bitrate, 60 fps,
 * high network priority, and resolution given up before frame rate. Only the
 * first encoding is touched (one is made if the browser listed none). A
 * directly captured canvas larger than the target is scaled down by the
 * encoder; any other capture leaves the encoding's scale as the browser had it.
 */
export const tuneEncoding = (params: WirePayload, mode: string, scale: number) => {
  const given = isObject(params) ? params : {};
  const listed = given['encodings'];
  const [head, ...rest] = Array.isArray(listed) && listed.length > 0 ? listed : [{}];
  const limits = { maxBitrate: MAX_BITRATE, maxFramerate: MAX_FRAMERATE, networkPriority: 'high' };
  const tuned = mode === 'direct' && scale > 1.001 ? { ...limits, scaleResolutionDownBy: scale } : limits;
  const first = head !== undefined && isObject(head) ? { ...head, ...tuned } : tuned;
  return { ...given, encodings: [first, ...rest], degradationPreference: 'maintain-framerate' };
};

// ── the core's frame rate ────────────────────────────────────────────────────

/** A core measured above this many frames a second is running unpaced. */
export const CORE_FPS_RESET_THRESHOLD = 70;
/** After a reset, the next one waits this long. */
export const CORE_FPS_RESET_COOLDOWN_MS = 5000;

/**
 * Is the host's main loop reset after this sample? Only when the core ran
 * faster than the threshold over the sample and no reset is cooling down. A
 * sample with no time or no frames in it says nothing.
 */
export const coreFpsReset = (elapsedMs: number, frames: number, now: number, cooldownUntil: number): boolean => {
  if (elapsedMs <= 0 || frames <= 0) return false;
  return (frames * 1000) / elapsedMs > CORE_FPS_RESET_THRESHOLD && now >= cooldownUntil;
};
