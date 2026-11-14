/**
 * `window.KNDiag`: freeze detection and async event diagnostics for the
 * engines. It reads the game canvas, the audio state and the emulator from
 * the browser and writes log lines; the arithmetic is in ../diagnostics.ts.
 *
 *   - RENDER-STALL: canvas pixel hash unchanged for 180+ frames
 *   - CANVAS-HEALTH: early solid pale/yellow canvas detector
 *   - INPUT-DEAD: local input all-zero for 300+ frames
 *   - AUDIO-STALL: AudioContext not running during gameplay
 *   - Async event hooks (visibility, focus, touch, EJS menu, mainloop)
 *   - DIAG-INPUT: periodic WASM input memory reads
 *
 * Interface:
 *   KNDiag.init(ctx)                  set context callbacks
 *   KNDiag.installHooks()             attach event listeners
 *   KNDiag.cleanup()                  remove all listeners, reset state
 *   KNDiag.checkFreeze(localInput)    per-frame freeze detection (call from tick)
 *   KNDiag.captureCanvasHash()        FNV-1a hash of game canvas pixels
 *   KNDiag.captureAndSendScreenshot() capture + send gameplay screenshot
 *   KNDiag.SCREENSHOT_INTERVAL        frame interval for periodic screenshots
 *   KNDiag.diagInput(f, af, force)    DIAG-INPUT logger
 *   KNDiag.eventLog                   readonly ref to event log array
 *   KNDiag.playerAddrs                per-player input base addresses
 *
 * Every canvas read that leaves the page as an image, or that costs a GPU
 * sync, asks `window.KNCapture.allowed()` first (web/static/kn-capture.js).
 */
import { audioTransition, hashPixels, measureCanvasHealth, screenshotCrop, type CanvasHealth } from '../diagnostics.ts';

/** The part of the Emscripten module the diagnostics read and wrap. */
interface DiagModule {
  HEAPU8?: Uint8Array;
  _kn_get_scene_curr?: () => number;
  pauseMainLoop?: MainLoopControl;
  resumeMainLoop?: MainLoopControl;
}
type MainLoopControl = (this: DiagModule, ...args: number[]) => void;

/** The globals of other scripts that the diagnostics read, each at call time. */
interface DiagWindow extends Window {
  KNCapture?: { allowed: () => boolean };
  KNAudio?: { ctx?: { state: string } | null };
  EJS_emulator?: { paused?: boolean; gameManager?: { Module?: DiagModule } };
}

/** A health sample with the canvas's sizes beside it. */
export interface SampledCanvas extends CanvasHealth {
  canvas: { width: number; height: number; clientWidth: number; clientHeight: number };
}
/** What `sampleCanvasHealth` returns when the canvas could be read, or why it could not. */
export type CanvasSample = SampledCanvas | { error: string };

type SolidPaleMeta = CanvasSample & { frame: number; reason: string; ejsPaused: boolean; scene: number | null };

/** One buffered async event. */
export interface DiagEvent {
  t: number;
  type: 'visibility' | 'focus' | 'touch' | 'ejs-menu' | 'mainloop';
  detail: string;
}

/** A screenshot handed to the engine to send. */
export interface ScreenshotPayload {
  slot: number;
  frame: number;
  /** JPEG, base64. */
  data: string;
}

/** The engine's callbacks. Each one left out keeps what was set before. */
export interface DiagContext {
  log?: (line: string) => void;
  getFrame?: () => number;
  getSlot?: () => number;
  sendScreenshot?: (shot: ScreenshotPayload) => void;
}

/** The local input fields the INPUT-DEAD check reads. */
export interface DiagInput {
  buttons: number;
  lx: number;
  ly: number;
  cx: number;
  cy: number;
}

type GlContext = WebGL2RenderingContext | WebGLRenderingContext;
const TOUCH_EVENTS = ['touchstart', 'touchend', 'touchmove'] as const;
interface TouchHook {
  el: HTMLElement;
  evName: (typeof TOUCH_EVENTS)[number];
  handler: (e: TouchEvent) => void;
}

const DIAG_INPUT_INTERVAL = 300;
const DIAG_EARLY_FRAMES = 30;
const SCREENSHOT_INTERVAL = 300; // ~5 seconds at 60fps
// 160x120 for desync triage. The host of a listed room captures 320x240:
// it doubles as the room's live preview on the front-page board.
const SCREENSHOT_WIDTH = 160;
const SCREENSHOT_HEIGHT = 120;

const isElement = (node: Node): node is Element => node.nodeType === 1;
const hasSettingsMenu = (node: Node): boolean =>
  isElement(node) && (node.classList.contains('ejs--settings') || node.querySelector('.ejs--settings') !== null);

const shouldLog = (frameNum: number, interval: number): boolean =>
  frameNum < DIAG_EARLY_FRAMES || frameNum % interval === 0;

/**
 * Build the diagnostics. Nothing here runs until a method is called, except
 * that the caches are dropped whenever the image preference changes
 * (`kn-capture-change`).
 */
export const createDiagnostics = () => {
  const page = (): DiagWindow => window;
  const captureAllowed = (): boolean => page().KNCapture?.allowed() === true;
  const emulatorModule = (): DiagModule | undefined => page().EJS_emulator?.gameManager?.Module;

  // -- Diag event hooks state --
  const eventLog: DiagEvent[] = [];
  let hookInstalled = false;
  let visHandler: (() => void) | null = null;
  let focusHandler: (() => void) | null = null;
  let blurHandler: (() => void) | null = null;
  let touchHandlers: TouchHook[] = [];
  let observer: MutationObserver | null = null;

  // -- Diag input state --
  const playerAddrs: (number | null)[] = [null, null, null, null]; // per-player input base addresses

  // -- Canvas hash capture state --
  let glCtxCache: GlContext | null = null;
  let glPixelBuf: Uint8Array | null = null;
  let offscreenCanvas: HTMLCanvasElement | null = null;
  let offscreenCtx: CanvasRenderingContext2D | null = null;
  let healthCanvas: HTMLCanvasElement | null = null;
  let healthCtx: CanvasRenderingContext2D | null = null;
  let solidPaleLogged = false;

  // -- Freeze detection state --
  let renderLastHash = 0;
  let renderLastChangeFrame = 0;
  let renderStallLogged = false;
  let inputLastNonZeroFrame = -1;
  let inputEverNonZero = false;
  let inputDeadLogged = false;
  let audioLastState = '';

  // -- Screenshot state --
  let screenshotCanvas: HTMLCanvasElement | null = null;
  let screenshotCtx: CanvasRenderingContext2D | null = null;
  let lastScreenshotFrame = -1;
  let screenshotDebugLogged = false;

  // Context callbacks, set by init()
  let log: (line: string) => void = () => {};
  let getFrame: () => number = () => 0;
  let getSlot: () => number = () => -1;
  let sendScreenshot: ((shot: ScreenshotPayload) => void) | null = null;

  const init = (ctx: DiagContext): void => {
    log = ctx.log || log;
    getFrame = ctx.getFrame || getFrame;
    getSlot = ctx.getSlot || getSlot;
    sendScreenshot = ctx.sendScreenshot || null;
  };

  const captureCanvasHash = (): number => {
    if (!captureAllowed()) return 0;
    const canvas = document.querySelector<HTMLCanvasElement>('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) return 0;
    try {
      // Try WebGL direct readback (no intermediate canvas copy)
      if (!glCtxCache || glCtxCache.canvas !== canvas) {
        glCtxCache =
          canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
          canvas.getContext('webgl', { preserveDrawingBuffer: true });
      }
      const gl = glCtxCache;
      // GLideN64's color-buffer-to-RDRAM readback leaves a PIXEL_PACK_BUFFER
      // bound across the Emscripten event-loop yield. WebGL2 forbids the
      // typed-array form of readPixels while a PBO is bound — calling it
      // here would spam INVALID_OPERATION every capture. The previous
      // attempt to save/unbind/restore was reverted: mutating GL state
      // from JS while the C core is suspended mid-frame corrupted the
      // core's render pipeline and surfaced as a WASM OOB on match start
      // (see commits 51b180c, 0ed1399).
      //
      // Detect-and-skip is cheap (getParameter is a synchronous query on
      // driver-cached state, not a GPU sync) and never mutates state. The
      // 2D-canvas drawImage fallback would also work, but drawImage from a
      // WebGL canvas forces a full GPU→CPU sync that produced a visible
      // ~once-per-second stutter on the main thread. Returning 0 instead
      // tells the RENDER-STALL detector to skip this capture (see
      // `if (renderHash !== 0)` at the call site) — the detector is the
      // only consumer, so "skip" is the cheapest correct behavior.
      const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      if (isWebGL2 && gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING)) return 0;
      if (gl) {
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const totalBytes = w * h * 4;
        if (!glPixelBuf || glPixelBuf.length !== totalBytes) {
          glPixelBuf = new Uint8Array(totalBytes);
        }
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, glPixelBuf);
        return hashPixels(glPixelBuf);
      }
      // No GL context at all (extremely rare) — fall back to a 2D copy.
      if (!offscreenCanvas || offscreenCanvas.width !== canvas.width || offscreenCanvas.height !== canvas.height) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = canvas.width;
        offscreenCanvas.height = canvas.height;
        offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!offscreenCtx) return 0;
      offscreenCtx.drawImage(canvas, 0, 0);
      const data = offscreenCtx.getImageData(0, 0, canvas.width, canvas.height).data;
      return hashPixels(data);
    } catch (_) {
      return 0;
    }
  };

  // Local-only startup renderer repair needs this even when image sharing is
  // off. It returns numeric health data, never encodes or uploads an image.
  const sampleCanvasHealth = (): CanvasSample | null => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) return null;
    try {
      const sampleW = 32;
      const sampleH = 24;
      if (!healthCanvas) {
        healthCanvas = document.createElement('canvas');
        healthCanvas.width = sampleW;
        healthCanvas.height = sampleH;
        healthCtx = healthCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!healthCtx) throw new Error('no 2d context for the health sample');
      healthCtx.drawImage(canvas, 0, 0, sampleW, sampleH);
      const data = healthCtx.getImageData(0, 0, sampleW, sampleH).data;
      return {
        ...measureCanvasHealth(data),
        canvas: {
          width: canvas.width,
          height: canvas.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
        },
      };
    } catch (e) {
      return { error: (e instanceof Error && e.message) || String(e) };
    }
  };

  const captureAndSendScreenshot = (): void => {
    if (!captureAllowed() || !sendScreenshot) return;
    const capturedFrame = getFrame();
    if (capturedFrame === lastScreenshotFrame) return;
    lastScreenshotFrame = capturedFrame;
    const canvas = document.querySelector<HTMLCanvasElement>('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) {
      if (!screenshotDebugLogged) {
        screenshotDebugLogged = true;
        log(`screenshot: no canvas (sel=${!!canvas} w=${canvas?.width} h=${canvas?.height})`);
      }
      return;
    }

    try {
      const scale = window.KNState?.boardFrame ? 2 : 1;
      const outW = SCREENSHOT_WIDTH * scale;
      const outH = SCREENSHOT_HEIGHT * scale;
      if (!screenshotCanvas || screenshotCanvas.width !== outW) {
        screenshotCanvas = document.createElement('canvas');
        screenshotCanvas.width = outW;
        screenshotCanvas.height = outH;
        screenshotCtx = screenshotCanvas.getContext('2d');
      }
      if (!screenshotCtx) throw new Error('no 2d context for the screenshot');
      const { sx, sy, sw, sh } = screenshotCrop(canvas.width, canvas.height);
      screenshotCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, outW, outH);
      const dataUrl = screenshotCanvas.toDataURL('image/jpeg', 0.6);
      if (!dataUrl || dataUrl.length < 100) {
        if (!screenshotDebugLogged) {
          screenshotDebugLogged = true;
          log(`screenshot: toDataURL too small (${dataUrl?.length || 0})`);
        }
        return;
      }
      if (!screenshotDebugLogged) {
        screenshotDebugLogged = true;
        log(`screenshot: ok ${outW}x${outH} size=${dataUrl.length}`);
      }
      sendScreenshot({
        slot: getSlot(),
        frame: capturedFrame,
        data: dataUrl.split(',')[1] ?? '',
      });
    } catch (e) {
      if (!screenshotDebugLogged) {
        screenshotDebugLogged = true;
        log(`screenshot: error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const checkCanvasHealth = (frameNum: number, reason: string): void => {
    if (!captureAllowed()) return;
    const health = sampleCanvasHealth();
    if (!health) return;
    const measured = 'error' in health ? null : health;
    const ejsPaused = !!page().EJS_emulator?.paused;
    const scene = emulatorModule()?._kn_get_scene_curr?.();
    log(
      `CANVAS-HEALTH reason=${reason} f=${frameNum} ` +
        `rgb=${measured?.meanR ?? '?'},${measured?.meanG ?? '?'},${measured?.meanB ?? '?'} ` +
        `bright=${measured?.brightness ?? '?'} stdev=${measured?.stdev ?? '?'} range=${measured?.range ?? '?'} ` +
        `paleRatio=${measured?.paleRatio ?? '?'} yellowGreenRatio=${measured?.yellowGreenRatio ?? '?'} ` +
        `solidPale=${!!measured?.solidPale} canvas=${measured?.canvas.width ?? '?'}x${measured?.canvas.height ?? '?'} ` +
        `css=${measured?.canvas.clientWidth ?? '?'}x${measured?.canvas.clientHeight ?? '?'} ` +
        `ejsPaused=${ejsPaused} scene=${scene ?? '?'}`,
    );
    if (measured?.solidPale && !solidPaleLogged) {
      solidPaleLogged = true;
      page().KNEvent?.('canvas_solid_pale', '', {
        frame: frameNum,
        reason,
        ...health,
        ejsPaused,
        scene: scene ?? null,
      });
      window.dispatchEvent(
        new CustomEvent('kn-canvas-solid-pale', {
          detail: {
            frame: frameNum,
            reason,
            health,
            ejsPaused,
            scene: scene ?? null,
          },
        }),
      );
      captureAndSendScreenshot();
    }
  };

  // -- Diag helpers --

  const diagInput = (frameNum: number, applyFrame: number, force = false): void => {
    if (!force && !shouldLog(frameNum, DIAG_INPUT_INTERVAL)) return;
    const mem = emulatorModule()?.HEAPU8;
    if (!mem) return;
    const vals = playerAddrs.map((addr): number | string => {
      if (addr === null) return '?';
      if (addr + 3 >= mem.length) return 'OOB';
      return (
        (mem[addr] ?? 0) | ((mem[addr + 1] ?? 0) << 8) | ((mem[addr + 2] ?? 0) << 16) | ((mem[addr + 3] ?? 0) << 24)
      );
    });
    log(`DIAG-INPUT f=${frameNum} apply=${applyFrame} p0=${vals[0]} p1=${vals[1]} p2=${vals[2]} p3=${vals[3]}`);
  };

  // -- Async event hooks --

  const record = (type: DiagEvent['type'], detail: string): void => {
    eventLog.push({ t: performance.now(), type, detail });
  };

  const installHooks = (): void => {
    if (hookInstalled) return;
    hookInstalled = true;

    visHandler = () => record('visibility', document.visibilityState);
    document.addEventListener('visibilitychange', visHandler);

    focusHandler = () => record('focus', 'gained');
    blurHandler = () => record('focus', 'lost');
    window.addEventListener('focus', focusHandler);
    window.addEventListener('blur', blurHandler);

    const canvas = document.querySelector<HTMLElement>('#game canvas, canvas');
    if (canvas) {
      for (const evName of TOUCH_EVENTS) {
        const handler = (e: TouchEvent): void => record('touch', `${evName}:${e.touches.length}`);
        canvas.addEventListener(evName, handler, { passive: true });
        touchHandlers.push({ el: canvas, evName, handler });
      }
    }

    observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (hasSettingsMenu(node)) record('ejs-menu', 'opened');
        }
        for (const node of mut.removedNodes) {
          if (hasSettingsMenu(node)) record('ejs-menu', 'closed');
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const diagMod = emulatorModule();
    if (diagMod) {
      const origPause = diagMod.pauseMainLoop;
      const origResume = diagMod.resumeMainLoop;
      if (origPause) {
        diagMod.pauseMainLoop = function (...args) {
          record('mainloop', 'paused');
          return origPause.apply(this, args);
        };
      }
      if (origResume) {
        diagMod.resumeMainLoop = function (...args) {
          record('mainloop', 'resumed');
          return origResume.apply(this, args);
        };
      }
    }

    log('DIAG hooks installed');
  };

  // -- Freeze detection (called from tick loop) --

  const checkFreeze = (localInput: DiagInput): void => {
    const frameNum = getFrame();
    // All diagnostic canvas reads share the image preference, including URL opt-outs.
    if (captureAllowed() && frameNum > 0 && frameNum <= 300 && frameNum % 60 === 0) {
      checkCanvasHealth(frameNum, 'early');
    }
    if (frameNum % 60 !== 0 || frameNum <= 300) return;

    // 1. RENDER-STALL: canvas pixel hash unchanged for 180+ frames.
    // WebGL readPixels is a GPU sync point, so determinism stress runs opt out.
    if (captureAllowed()) {
      const renderHash = captureCanvasHash();
      if (renderHash !== 0) {
        if (renderHash !== renderLastHash) {
          renderLastHash = renderHash;
          renderLastChangeFrame = frameNum;
          renderStallLogged = false;
        } else if (frameNum - renderLastChangeFrame >= 180 && !renderStallLogged) {
          log(
            `RENDER-STALL start=${renderLastChangeFrame} cur=${frameNum} ` +
              `unchanged=${frameNum - renderLastChangeFrame}f hash=0x${renderHash.toString(16)}`,
          );
          checkCanvasHealth(frameNum, 'render-stall');
          renderStallLogged = true;
        }
      }
    }

    // 2. INPUT-DEAD: local input all-zero for 300+ frames after being non-zero
    const isNonZero =
      localInput.buttons !== 0 ||
      localInput.lx !== 0 ||
      localInput.ly !== 0 ||
      localInput.cx !== 0 ||
      localInput.cy !== 0;
    if (isNonZero) {
      inputLastNonZeroFrame = frameNum;
      inputEverNonZero = true;
      inputDeadLogged = false;
    }
    if (
      inputEverNonZero &&
      !isNonZero &&
      inputLastNonZeroFrame >= 0 &&
      frameNum - inputLastNonZeroFrame >= 300 &&
      !inputDeadLogged
    ) {
      const hasFocus = document.hasFocus();
      const gpCount = navigator.getGamepads?.()?.filter(Boolean)?.length ?? 0;
      log(
        `INPUT-DEAD slot=${getSlot()} zeroSince=${inputLastNonZeroFrame} ` +
          `cur=${frameNum} gap=${frameNum - inputLastNonZeroFrame}f ` +
          `focus=${hasFocus} gamepads=${gpCount}`,
      );
      inputDeadLogged = true;
    }

    // 3. AUDIO-STALL: audioContext not running during active gameplay
    const aState = page().KNAudio?.ctx?.state ?? 'none';
    if (aState !== audioLastState) {
      const change = audioTransition(audioLastState, aState);
      if (change === 'stall') {
        log(`AUDIO-STALL state=${aState} prev=${audioLastState} f=${frameNum}`);
      } else if (change === 'resume') {
        log(`AUDIO-RESUME state=${aState} prev=${audioLastState} f=${frameNum}`);
      }
      audioLastState = aState;
    }
  };

  const dropCanvasCaches = (): void => {
    glCtxCache = null;
    glPixelBuf = null;
    offscreenCanvas = null;
    offscreenCtx = null;
    healthCanvas = null;
    healthCtx = null;
    screenshotCanvas = null;
    screenshotCtx = null;
    lastScreenshotFrame = -1;
    renderLastHash = 0;
    renderLastChangeFrame = 0;
    renderStallLogged = false;
    solidPaleLogged = false;
  };

  window.addEventListener('kn-capture-change', dropCanvasCaches);

  // -- Cleanup --

  const cleanup = (): void => {
    if (hookInstalled) {
      if (visHandler) {
        document.removeEventListener('visibilitychange', visHandler);
        visHandler = null;
      }
      if (focusHandler) {
        window.removeEventListener('focus', focusHandler);
        focusHandler = null;
      }
      if (blurHandler) {
        window.removeEventListener('blur', blurHandler);
        blurHandler = null;
      }
      for (const { el, evName, handler } of touchHandlers) {
        el.removeEventListener(evName, handler);
      }
      touchHandlers = [];
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      hookInstalled = false;
    }
    eventLog.length = 0;
    dropCanvasCaches();
    inputLastNonZeroFrame = -1;
    inputEverNonZero = false;
    inputDeadLogged = false;
    audioLastState = '';
    playerAddrs.fill(null);
    screenshotDebugLogged = false;
  };

  return {
    init,
    installHooks,
    cleanup,
    checkFreeze,
    checkCanvasHealth,
    sampleCanvasHealth,
    captureCanvasHash,
    captureAndSendScreenshot,
    SCREENSHOT_INTERVAL,
    diagInput,
    get eventLog(): DiagEvent[] {
      return eventLog;
    },
    playerAddrs,
  };
};

export type Diagnostics = ReturnType<typeof createDiagnostics>;

declare global {
  interface Window {
    KNDiag?: Diagnostics;
  }
}

/** Define `window.KNDiag`, as web/static/kn-diagnostics.js did when it loaded. */
export const installDiagnostics = (): void => {
  window.KNDiag = createDiagnostics();
};
