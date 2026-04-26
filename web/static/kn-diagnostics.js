/**
 * kn-diagnostics.js — Freeze detection and async event diagnostics.
 *
 * Extracted from netplay-lockstep.js. Handles:
 *   - RENDER-STALL: canvas pixel hash unchanged for 180+ frames
 *   - INPUT-DEAD: local input all-zero for 300+ frames
 *   - AUDIO-STALL: AudioContext not running during gameplay
 *   - Async event hooks (visibility, focus, touch, EJS menu, mainloop)
 *   - DIAG-INPUT: periodic WASM input memory reads
 *
 * Interface:
 *   window.KNDiag.init(ctx)             — set context callbacks
 *   window.KNDiag.installHooks()        — attach event listeners
 *   window.KNDiag.cleanup()             — remove all listeners, reset state
 *   window.KNDiag.checkFreeze(localInput) — per-frame freeze detection (call from tick)
 *   window.KNDiag.captureCanvasHash()   — FNV-1a hash of game canvas pixels
 *   window.KNDiag.captureAndSendScreenshot() — capture + send gameplay screenshot
 *   window.KNDiag.SCREENSHOT_INTERVAL   — frame interval for periodic screenshots
 *   window.KNDiag.diagInput(f, af, force) — DIAG-INPUT logger
 *   window.KNDiag.eventLog              — readonly ref to event log array
 *   window.KNDiag.playerAddrs           — per-player input base addresses
 */
(function () {
  'use strict';

  // -- Diag event hooks state --
  const _eventLog = []; // buffered async events [{t, type, detail}]
  let _hookInstalled = false;
  let _visHandler = null;
  let _focusHandler = null;
  let _blurHandler = null;
  let _touchHandlers = []; // [{el, evName, handler}]
  let _observer = null;

  // -- Diag input state --
  const playerAddrs = [null, null, null, null]; // per-player input base addresses
  const DIAG_INPUT_INTERVAL = 300;
  const DIAG_EARLY_FRAMES = 30;

  // -- Canvas hash capture state --
  let _glCtxCache = null;
  let _glPixelBuf = null;
  let _offscreenCanvas = null;
  let _offscreenCtx = null;

  function captureCanvasHash() {
    const canvas = document.querySelector('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) return 0;
    try {
      // Try WebGL direct readback (no intermediate canvas copy)
      if (!_glCtxCache || _glCtxCache.canvas !== canvas) {
        _glCtxCache =
          canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
          canvas.getContext('webgl', { preserveDrawingBuffer: true });
      }
      const gl = _glCtxCache;
      if (gl) {
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const totalBytes = w * h * 4;
        if (!_glPixelBuf || _glPixelBuf.length !== totalBytes) {
          _glPixelBuf = new Uint8Array(totalBytes);
        }
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, _glPixelBuf);
        // FNV-1a hash — stride every 16 pixels, quantize to top 4 bits.
        let hash = 2166136261;
        const stride = 16 * 4;
        for (let i = 0; i < totalBytes; i += stride) {
          hash = Math.imul(hash ^ (_glPixelBuf[i] >> 4), 16777619) >>> 0;
          hash = Math.imul(hash ^ (_glPixelBuf[i + 1] >> 4), 16777619) >>> 0;
          hash = Math.imul(hash ^ (_glPixelBuf[i + 2] >> 4), 16777619) >>> 0;
        }
        return hash;
      }
      // Fallback: 2D canvas full resolution
      if (!_offscreenCanvas || _offscreenCanvas.width !== canvas.width || _offscreenCanvas.height !== canvas.height) {
        _offscreenCanvas = document.createElement('canvas');
        _offscreenCanvas.width = canvas.width;
        _offscreenCanvas.height = canvas.height;
        _offscreenCtx = _offscreenCanvas.getContext('2d', { willReadFrequently: true });
      }
      _offscreenCtx.drawImage(canvas, 0, 0);
      const data = _offscreenCtx.getImageData(0, 0, canvas.width, canvas.height).data;
      let h2 = 2166136261;
      const stride2 = 16 * 4;
      for (let i = 0; i < data.length; i += stride2) {
        h2 = Math.imul(h2 ^ (data[i] >> 4), 16777619) >>> 0;
        h2 = Math.imul(h2 ^ (data[i + 1] >> 4), 16777619) >>> 0;
        h2 = Math.imul(h2 ^ (data[i + 2] >> 4), 16777619) >>> 0;
      }
      return h2;
    } catch (_) {
      return 0;
    }
  }

  // -- Freeze detection state --
  let _renderLastHash = 0;
  let _renderLastChangeFrame = 0;
  let _renderStallLogged = false;
  let _inputLastNonZeroFrame = -1;
  let _inputEverNonZero = false;
  let _inputDeadLogged = false;
  let _audioLastState = '';

  // Context callbacks — set by init()
  let _log = () => {};
  let _getFrame = () => 0;
  let _getSlot = () => -1;
  let _sendScreenshot = null; // (data: {matchId, slot, frame, data}) => void

  function init(ctx) {
    _log = ctx.log || _log;
    _getFrame = ctx.getFrame || _getFrame;
    _getSlot = ctx.getSlot || _getSlot;
    _sendScreenshot = ctx.sendScreenshot || null;
  }

  // -- Diag helpers --

  const _shouldLog = (frameNum, interval) => frameNum < DIAG_EARLY_FRAMES || frameNum % interval === 0;

  function diagInput(frameNum, applyFrame, force = false) {
    if (!force && !_shouldLog(frameNum, DIAG_INPUT_INTERVAL)) return;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?.HEAPU8) return;
    const mem = mod.HEAPU8;
    const vals = [];
    for (let p = 0; p < 4; p++) {
      const addr = playerAddrs[p];
      if (addr === null) {
        vals.push('?');
        continue;
      }
      if (addr + 3 < mem.length) {
        const v = mem[addr] | (mem[addr + 1] << 8) | (mem[addr + 2] << 16) | (mem[addr + 3] << 24);
        vals.push(v);
      } else {
        vals.push('OOB');
      }
    }
    _log(`DIAG-INPUT f=${frameNum} apply=${applyFrame} p0=${vals[0]} p1=${vals[1]} p2=${vals[2]} p3=${vals[3]}`);
  }

  // -- Async event hooks --

  function installHooks() {
    if (_hookInstalled) return;
    _hookInstalled = true;

    _visHandler = () => {
      _eventLog.push({
        t: performance.now(),
        type: 'visibility',
        detail: document.visibilityState,
      });
    };
    document.addEventListener('visibilitychange', _visHandler);

    _focusHandler = () => {
      _eventLog.push({ t: performance.now(), type: 'focus', detail: 'gained' });
    };
    _blurHandler = () => {
      _eventLog.push({ t: performance.now(), type: 'focus', detail: 'lost' });
    };
    window.addEventListener('focus', _focusHandler);
    window.addEventListener('blur', _blurHandler);

    const canvas = document.querySelector('#game canvas, canvas');
    if (canvas) {
      for (const evName of ['touchstart', 'touchend', 'touchmove']) {
        const handler = (e) => {
          _eventLog.push({
            t: performance.now(),
            type: 'touch',
            detail: `${evName}:${e.touches.length}`,
          });
        };
        canvas.addEventListener(evName, handler, { passive: true });
        _touchHandlers.push({ el: canvas, evName, handler });
      }
    }

    _observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (
            node.nodeType === 1 &&
            (node.classList.contains('ejs--settings') || (node.querySelector && node.querySelector('.ejs--settings')))
          ) {
            _eventLog.push({ t: performance.now(), type: 'ejs-menu', detail: 'opened' });
          }
        }
        for (const rnode of mut.removedNodes) {
          if (
            rnode.nodeType === 1 &&
            (rnode.classList.contains('ejs--settings') ||
              (rnode.querySelector && rnode.querySelector('.ejs--settings')))
          ) {
            _eventLog.push({ t: performance.now(), type: 'ejs-menu', detail: 'closed' });
          }
        }
      }
    });
    _observer.observe(document.body, { childList: true, subtree: true });

    const diagMod = window.EJS_emulator?.gameManager?.Module;
    if (diagMod) {
      const origPause = diagMod.pauseMainLoop;
      const origResume = diagMod.resumeMainLoop;
      if (origPause) {
        diagMod.pauseMainLoop = function () {
          _eventLog.push({ t: performance.now(), type: 'mainloop', detail: 'paused' });
          return origPause.apply(this, arguments);
        };
      }
      if (origResume) {
        diagMod.resumeMainLoop = function () {
          _eventLog.push({ t: performance.now(), type: 'mainloop', detail: 'resumed' });
          return origResume.apply(this, arguments);
        };
      }
    }

    _log('DIAG hooks installed');
  }

  // -- Freeze detection (called from tick loop) --

  function checkFreeze(localInput) {
    const frameNum = _getFrame();
    if (frameNum % 60 !== 0 || frameNum <= 300) return;

    // 1. RENDER-STALL: canvas pixel hash unchanged for 180+ frames.
    // WebGL readPixels is a GPU sync point, so determinism stress runs opt out.
    if (!window._knPerfLight) {
      const renderHash = captureCanvasHash();
      if (renderHash !== 0) {
        if (renderHash !== _renderLastHash) {
          _renderLastHash = renderHash;
          _renderLastChangeFrame = frameNum;
          _renderStallLogged = false;
        } else if (frameNum - _renderLastChangeFrame >= 180 && !_renderStallLogged) {
          _log(
            `RENDER-STALL start=${_renderLastChangeFrame} cur=${frameNum} ` +
              `unchanged=${frameNum - _renderLastChangeFrame}f hash=0x${renderHash.toString(16)}`,
          );
          _renderStallLogged = true;
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
      _inputLastNonZeroFrame = frameNum;
      _inputEverNonZero = true;
      _inputDeadLogged = false;
    }
    if (
      _inputEverNonZero &&
      !isNonZero &&
      _inputLastNonZeroFrame >= 0 &&
      frameNum - _inputLastNonZeroFrame >= 300 &&
      !_inputDeadLogged
    ) {
      const hasFocus = document.hasFocus();
      const gpCount = navigator.getGamepads?.()?.filter(Boolean)?.length ?? 0;
      _log(
        `INPUT-DEAD slot=${_getSlot()} zeroSince=${_inputLastNonZeroFrame} ` +
          `cur=${frameNum} gap=${frameNum - _inputLastNonZeroFrame}f ` +
          `focus=${hasFocus} gamepads=${gpCount}`,
      );
      _inputDeadLogged = true;
    }

    // 3. AUDIO-STALL: audioContext not running during active gameplay
    const actx = window.KNAudio?.ctx;
    const aState = actx?.state ?? 'none';
    if (aState !== _audioLastState) {
      if (aState !== 'running' && _audioLastState === 'running') {
        _log(`AUDIO-STALL state=${aState} prev=${_audioLastState} f=${frameNum}`);
      } else if (aState === 'running' && _audioLastState !== '' && _audioLastState !== 'running') {
        _log(`AUDIO-RESUME state=${aState} prev=${_audioLastState} f=${frameNum}`);
      }
      _audioLastState = aState;
    }
  }

  // -- Gameplay screenshot capture --
  const SCREENSHOT_INTERVAL = 300; // ~5 seconds at 60fps
  const SCREENSHOT_WIDTH = 160;
  const SCREENSHOT_HEIGHT = 120;
  let _screenshotCanvas = null;
  let _screenshotCtx = null;
  let _lastScreenshotFrame = -1;
  let _screenshotDebugLogged = false;

  function captureAndSendScreenshot() {
    if (!_sendScreenshot) return;
    const capturedFrame = _getFrame();
    if (capturedFrame === _lastScreenshotFrame) return;
    _lastScreenshotFrame = capturedFrame;
    const canvas = document.querySelector('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) {
      if (!_screenshotDebugLogged) {
        _screenshotDebugLogged = true;
        _log(`screenshot: no canvas (sel=${!!canvas} w=${canvas?.width} h=${canvas?.height})`);
      }
      return;
    }

    try {
      if (!_screenshotCanvas) {
        _screenshotCanvas = document.createElement('canvas');
        _screenshotCanvas.width = SCREENSHOT_WIDTH;
        _screenshotCanvas.height = SCREENSHOT_HEIGHT;
        _screenshotCtx = _screenshotCanvas.getContext('2d');
      }
      const w = canvas.width;
      const h = canvas.height;
      const targetRatio = 4 / 3;
      const srcRatio = w / h;
      let sx = 0,
        sy = 0,
        sw = w,
        sh = h;
      if (srcRatio > targetRatio) {
        sw = Math.round(h * targetRatio);
        sx = Math.round((w - sw) / 2);
      } else if (srcRatio < targetRatio) {
        sh = Math.round(w / targetRatio);
        sy = Math.round((h - sh) / 2);
      }
      _screenshotCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT);
      const dataUrl = _screenshotCanvas.toDataURL('image/jpeg', 0.6);
      if (!dataUrl || dataUrl.length < 100) {
        if (!_screenshotDebugLogged) {
          _screenshotDebugLogged = true;
          _log(`screenshot: toDataURL too small (${dataUrl?.length || 0})`);
        }
        return;
      }
      if (!_screenshotDebugLogged) {
        _screenshotDebugLogged = true;
        _log(`screenshot: ok ${SCREENSHOT_WIDTH}x${SCREENSHOT_HEIGHT} size=${dataUrl.length}`);
      }
      const base64 = dataUrl.split(',')[1];
      _sendScreenshot({
        slot: _getSlot(),
        frame: capturedFrame,
        data: base64,
      });
    } catch (e) {
      if (!_screenshotDebugLogged) {
        _screenshotDebugLogged = true;
        _log(`screenshot: error: ${e.message}`);
      }
    }
  }

  // -- Cleanup --

  function cleanup() {
    if (_hookInstalled) {
      if (_visHandler) {
        document.removeEventListener('visibilitychange', _visHandler);
        _visHandler = null;
      }
      if (_focusHandler) {
        window.removeEventListener('focus', _focusHandler);
        _focusHandler = null;
      }
      if (_blurHandler) {
        window.removeEventListener('blur', _blurHandler);
        _blurHandler = null;
      }
      for (const { el, evName, handler } of _touchHandlers) {
        el.removeEventListener(evName, handler);
      }
      _touchHandlers = [];
      if (_observer) {
        _observer.disconnect();
        _observer = null;
      }
      _hookInstalled = false;
    }
    _eventLog.length = 0;
    _renderLastHash = 0;
    _renderLastChangeFrame = 0;
    _renderStallLogged = false;
    _inputLastNonZeroFrame = -1;
    _inputEverNonZero = false;
    _inputDeadLogged = false;
    _audioLastState = '';
    for (let i = 0; i < playerAddrs.length; i++) playerAddrs[i] = null;
    _glCtxCache = null;
    _glPixelBuf = null;
    _offscreenCanvas = null;
    _offscreenCtx = null;
    _screenshotCanvas = null;
    _screenshotCtx = null;
    _lastScreenshotFrame = -1;
    _screenshotDebugLogged = false;
  }

  window.KNDiag = {
    init,
    installHooks,
    cleanup,
    checkFreeze,
    captureCanvasHash,
    captureAndSendScreenshot,
    SCREENSHOT_INTERVAL,
    diagInput,
    get eventLog() {
      return _eventLog;
    },
    playerAddrs,
  };
})();
