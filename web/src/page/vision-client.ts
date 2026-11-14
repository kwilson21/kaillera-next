/**
 * Delivers this peer's picture of a suspect frame to /api/desync-vision.
 * Moved from web/static/kn-vision-client.js.
 *
 * `desync-capture` fires on `KNDesync.events` on the frame every peer agreed
 * to screenshot for a suspect (kn-desync-detector.js), not when the suspect
 * was raised: the server compares the peers' pictures, so they must be of one
 * frame. The detector decided the frame deserves a verdict; this takes the
 * picture, scales it down to 512 pixels wide and posts it.
 *
 * A picture is dropped unless `KNCapture.allowed()` holds and
 * `KNCapture.revision` has not moved, checked again after every wait: an
 * opt-out while a picture is being encoded throws it away, even when pictures
 * were turned on again in between. A page without `KNCapture` takes none.
 *
 * This file imports no package at run time: tests/capture-privacy.test.mjs
 * loads it with plain node, before anything is installed.
 */
import type { CapturePolicy } from './capture.ts';

/** Width of the posted picture, in pixels. */
export const VISION_TARGET_WIDTH = 512;
/** Where the picture is posted. */
export const VISION_POST_PATH = '/api/desync-vision';

/** What the desync detector says about the frame to capture. Only `matchId` is read; the rest is passed on. */
export interface SuspectDetail {
  readonly matchId?: unknown;
  readonly frame?: unknown;
  readonly field?: unknown;
  readonly slot?: unknown;
  readonly trigger?: unknown;
  readonly hashes?: { readonly local?: unknown } | null | undefined;
  readonly captureFrame?: unknown;
  readonly replayMeta?: unknown;
}

/** The JSON posted to /api/desync-vision (server/src/api/desync_vision.py). */
export interface VisionRequestBody {
  readonly match_id: unknown;
  readonly frame: unknown;
  readonly field: unknown;
  readonly slot: unknown;
  readonly trigger: unknown;
  readonly peers: readonly [
    {
      readonly slot: number;
      readonly png_b64: string;
      readonly hash: unknown;
      readonly captured_frame: unknown;
    },
  ];
  readonly replay_meta: unknown;
}

/**
 * The request for one suspect: the detector's account of it and this peer's
 * picture. `localSlot` is the page's own slot; a spectator (null) and a page
 * with no slot yet are sent as 0. The order of the keys is the order on the
 * wire.
 */
export const visionRequestBody = (
  detail: SuspectDetail,
  localSlot: number | null | undefined,
  pngBase64: string,
): VisionRequestBody => ({
  match_id: detail.matchId,
  frame: detail.frame,
  field: detail.field,
  slot: detail.slot,
  trigger: detail.trigger,
  peers: [
    {
      slot: localSlot ?? 0,
      png_b64: pngBase64,
      hash: detail.hashes?.local ?? null,
      captured_frame: detail.captureFrame ?? null,
    },
  ],
  replay_meta: detail.replayMeta,
});

/** The size of the scaled picture for a canvas of the given size. */
export const scaledSize = (width: number, height: number) => {
  const ratio = VISION_TARGET_WIDTH / width;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
};

/** An encoded picture, as far as its bytes are read. */
interface PictureBlob {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The canvas the picture is scaled onto. */
interface ScaledCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): {
    drawImage(source: never, x: number, y: number, width: number, height: number): void;
  } | null;
  toBlob(done: (blob: PictureBlob | null) => void, type: string): void;
}

/**
 * What the game canvas lookup finds, as far as it is read here. An element
 * with no size is not a canvas to take a picture of.
 */
interface GameCanvas {
  readonly width?: number;
  readonly height?: number;
}

/** The server's answer. It is only logged. */
type VisionAnswer = object | string | number | boolean | null;

/** The part of `console` the client writes to. */
interface VisionConsole {
  log(...args: readonly unknown[]): void;
  warn(...args: readonly unknown[]): void;
}

/** The part of `window` the client uses. */
export interface VisionHost {
  readonly KNCapture?: CapturePolicy | undefined;
  readonly KNState?: { readonly slot: number | null } | undefined;
  readonly KNDesync?:
    | {
        readonly events?:
          | {
              addEventListener(
                type: 'desync-capture',
                listener: (event: { readonly detail?: SuspectDetail | null }) => void,
              ): void;
            }
          | undefined;
      }
    | undefined;
  /** A page's console; the global one is used when the host has none of its own. */
  readonly console?: VisionConsole | undefined;
  readonly document: {
    readonly readyState: string;
    querySelector(selectors: string): GameCanvas | null;
    createElement(tag: 'canvas'): ScaledCanvas;
    addEventListener(type: 'DOMContentLoaded', listener: () => void): void;
  };
  fetch(
    url: string,
    init: { method: string; headers: { 'Content-Type': string }; body: string },
  ): Promise<{ json(): Promise<VisionAnswer> }>;
  btoa(data: string): string;
}

/** `window.KNVision`: the two steps, exposed for the tests that drive them. */
export interface VisionClient {
  /** This page's game canvas as a base64 PNG, or null when no picture may be taken or there is no canvas. */
  readonly _captureScaledPng: () => Promise<string | null>;
  /** Take the picture for a suspect and post it. */
  readonly _onSuspect: (detail: SuspectDetail | null | undefined) => Promise<void>;
}

/**
 * Listen for the detector's capture events on this page and return the
 * client. Nothing is posted for a page that has opted out.
 */
export const startVisionClient = (host: VisionHost): VisionClient => {
  const out = (): VisionConsole => host.console ?? console;

  /** Pictures are allowed and no opt-out has happened since `revision` was read. */
  const stillAllowed = (revision: number): boolean => {
    const capture = host.KNCapture;
    return !!capture && capture.allowed() && revision === capture.revision;
  };

  const _captureScaledPng = async (): Promise<string | null> => {
    const capture = host.KNCapture;
    if (!capture?.allowed()) return null;
    const revision = capture.revision;
    const src = host.document.querySelector('#game canvas');
    if (!src || !src.width || !src.height) return null;
    const size = scaledSize(src.width, src.height);
    const scaled = host.document.createElement('canvas');
    scaled.width = size.width;
    scaled.height = size.height;
    const ctx = scaled.getContext('2d');
    if (!ctx) throw new TypeError('no 2d context for the scaled picture');
    // SAFETY: `src` is the element found under `#game canvas` and has a size,
    // so it is the game's canvas; what a context accepts as a source is the
    // page's own type, which this module does not name.
    ctx.drawImage(src as never, 0, 0, scaled.width, scaled.height);
    const blob = await new Promise<PictureBlob | null>((resolve) => scaled.toBlob(resolve, 'image/png'));
    if (!blob || !stillAllowed(revision)) return null;
    const buf = await blob.arrayBuffer();
    if (!stillAllowed(revision)) return null;
    return host.btoa(String.fromCharCode(...new Uint8Array(buf)));
  };

  const _onSuspect = async (detail: SuspectDetail | null | undefined): Promise<void> => {
    if (!detail || !detail.matchId) return;
    const capture = host.KNCapture;
    if (!capture?.allowed()) return;
    const revision = capture.revision;
    let localPng: string | null;
    try {
      localPng = await _captureScaledPng();
    } catch (e) {
      out().warn('[KNVision] capture failed', e);
      return;
    }
    // Turning pictures off and on again while the picture was being encoded
    // must not revive one taken before the player opted out.
    if (!localPng || !stillAllowed(revision)) return;

    const body = visionRequestBody(detail, host.KNState?.slot, localPng);

    try {
      const res = await host.fetch(VISION_POST_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      out().log('[KNVision] response:', json);
    } catch (e) {
      out().warn('[KNVision] POST failed', e);
    }
  };

  const wire = (): void => {
    host.KNDesync?.events?.addEventListener('desync-capture', (e) => {
      void _onSuspect(e.detail);
    });
  };
  if (host.document.readyState === 'loading') host.document.addEventListener('DOMContentLoaded', wire);
  else wire();

  return { _captureScaledPng, _onSuspect };
};

declare global {
  interface Window {
    KNVision?: VisionClient;
  }
}
