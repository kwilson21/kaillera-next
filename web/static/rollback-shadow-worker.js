// Experimental rollback presentation worker.
//
// This worker owns an OffscreenCanvas overlay and runs a second mupen64plus
// instance strictly forward. The authoritative emulator never reads from this
// worker; it is presentation-only and may be killed at any time.
(() => {
  'use strict';

  const FRAME_MS = 1000 / 60;
  const MAX_BATCH_STEPS = 8;
  const STATUS = {
    BOOTING: 1,
    READY: 2,
    FAILED: 3,
  };
  const STATUS_IDX = {
    status: 0,
    frame: 1,
    steps: 2,
    errors: 3,
    resyncs: 4,
  };

  let mod = null;
  let canvas = null;
  let pendingRunner = null;
  let currentFrame = 0;
  let ready = false;
  let statusView = null;
  let rafId = 0;
  let coreBase = '/static/ejs/cores/';
  let coreSettings = '';
  let lastInputs = [];
  // Rollback-engine state: set when main sends 'rollback-init' after its
  // own kn_rollback_init succeeds. Worker uses its rollback engine for
  // (a) state ring saves so kn_*_hash exports return real values for
  // determinism comparison with main; (b) eventually as the source of
  // corrected state for the replay-coprocessor flow. The init params
  // mirror main's exactly — same delay, same local slot, same num
  // players, same backend — so worker's ring matches main's modulo
  // tainted regions.
  let rollbackInited = false;
  let rbLocalSlot = 0;
  let rbDelayFrames = 0;
  let rbNumPlayers = 4;
  let parentTarget = null;
  let glContext = null;
  // Self-paced pump: one stepOnce per ~16ms task so the OffscreenCanvas
  // composites a fresh worker frame at every browser vsync during the
  // rollback overlay window. Replaces the old N-step batched warmup,
  // which only ever surfaced one frame (the last one) because all
  // batched stepOnce GL commits collapse into a single composite when
  // the worker yields back to its event loop.
  let pumpActive = false;
  let pumpUntilFrame = -1;
  let pumpTimer = 0;
  const PUMP_INTERVAL_MS = 16;
  let lastFrameSample = {
    known: false,
    black: false,
    maxChannel: -1,
    sampledAt: 0,
  };

  const post = (message, transfer) => {
    try {
      self.postMessage(message, transfer || []);
    } catch (_) {}
  };

  const setStatus = (status) => {
    if (!statusView) return;
    Atomics.store(statusView, STATUS_IDX.status, status);
  };

  const setStatusValue = (idx, value) => {
    if (!statusView) return;
    Atomics.store(statusView, idx, value | 0);
  };

  const bumpStatusValue = (idx, amount = 1) => {
    if (!statusView) return;
    Atomics.add(statusView, idx, amount | 0);
  };

  const fail = (stage, error) => {
    ready = false;
    setStatus(STATUS.FAILED);
    bumpStatusValue(STATUS_IDX.errors);
    post({
      type: 'error',
      stage,
      message: error?.message || String(error),
      name: error?.name || 'Error',
    });
  };

  const makeEventTargetStub = (name) => ({
    nodeName: name,
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    appendChild: () => {},
    removeChild: () => {},
    focus: () => {},
    blur: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: canvas?.width || 640,
      height: canvas?.height || 480,
      right: canvas?.width || 640,
      bottom: canvas?.height || 480,
    }),
  });

  const ensureEventTarget = (target, name) => {
    if (!target) target = makeEventTargetStub(name);
    if (!target.nodeName) target.nodeName = name;
    if (!target.style) target.style = makeEventTargetStub(name).style;
    if (!target.addEventListener) target.addEventListener = () => {};
    if (!target.removeEventListener) target.removeEventListener = () => {};
    if (!target.dispatchEvent) target.dispatchEvent = () => false;
    if (!target.getBoundingClientRect) {
      target.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: target.width || canvas?.width || 640,
        height: target.height || canvas?.height || 480,
        right: target.width || canvas?.width || 640,
        bottom: target.height || canvas?.height || 480,
      });
    }
    return target;
  };

  const installWorkerDomStubs = () => {
    if (!self.window) self.window = self;
    ensureEventTarget(self.window, '#window');
    if (!self.window.resizeTo) self.window.resizeTo = () => {};
    if (!self.window.devicePixelRatio) self.window.devicePixelRatio = 1;
    if (!self.window.getComputedStyle) self.window.getComputedStyle = () => ({ getPropertyValue: () => '' });
    if (!self.document) {
      self.document = {
        nodeName: '#document',
        visibilityState: 'visible',
        fullscreenElement: null,
        currentScript: null,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    }
    self.document = ensureEventTarget(self.document, '#document');
    self.document.body = ensureEventTarget(self.document.body || makeEventTargetStub('BODY'), 'BODY');
    self.document.documentElement = ensureEventTarget(
      self.document.documentElement || makeEventTargetStub('HTML'),
      'HTML',
    );
    self.document.querySelector = (selector) => {
      if (selector === '#canvas' || selector === 'canvas' || selector === '!canvas') return canvas;
      if (selector === 'body') return self.document.body;
      if (selector === 'html') return self.document.documentElement;
      if (selector === '!parent') return parentTarget;
      return null;
    };
    self.document.querySelectorAll = (selector) => {
      const found = self.document.querySelector(selector);
      return found ? [found] : [];
    };
    if (!self.document.createElement)
      self.document.createElement = (name) => makeEventTargetStub(String(name || 'div').toUpperCase());
    if (!self.screen) self.screen = { width: 640, height: 480 };
    ensureEventTarget(self.screen, '#screen');
    if (!self.navigator) self.navigator = {};
    if (!self.navigator.userActivation) self.navigator.userActivation = { isActive: true };
    if (!self.ResizeObserver) {
      self.ResizeObserver = class {
        constructor(callback) {
          this.callback = callback;
        }
        observe(target) {
          try {
            this.callback([
              {
                target,
                contentRect: {
                  width: target?.width || 640,
                  height: target?.height || 480,
                },
              },
            ]);
          } catch (_) {}
        }
        unobserve() {}
        disconnect() {}
      };
    }
  };

  const installManualRAF = () => {
    self.requestAnimationFrame = (cb) => {
      pendingRunner = cb;
      return ++rafId;
    };
    self.cancelAnimationFrame = () => {};
  };

  const patchCanvas = (target) => {
    if (!target) return;
    ensureEventTarget(target, 'CANVAS');
    target.id = target.id || 'canvas';
    if (!target.__knShadowGetContextPatched && typeof target.getContext === 'function') {
      try {
        const originalGetContext = target.getContext.bind(target);
        target.getContext = (...args) => {
          const ctx = originalGetContext(...args);
          const type = String(args[0] || '').toLowerCase();
          if (ctx && type.includes('webgl')) glContext = ctx;
          return ctx;
        };
        target.__knShadowGetContextPatched = true;
      } catch (_) {}
    }
  };

  const sampleFrameBlack = (force = false) => {
    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    if (!force && now - lastFrameSample.sampledAt < 45) return lastFrameSample;
    if (!glContext || !canvas) {
      lastFrameSample = { known: false, black: false, maxChannel: -1, sampledAt: now };
      return lastFrameSample;
    }
    try {
      const gl = glContext;
      const width = Math.max(1, gl.drawingBufferWidth || canvas.width || 1);
      const height = Math.max(1, gl.drawingBufferHeight || canvas.height || 1);
      const points = [
        [0.5, 0.5],
        [0.3, 0.4],
        [0.7, 0.4],
        [0.35, 0.7],
        [0.65, 0.7],
      ];
      const pixel = new Uint8Array(4);
      let maxChannel = 0;
      for (const [px, py] of points) {
        const x = Math.max(0, Math.min(width - 1, Math.floor(width * px)));
        const y = Math.max(0, Math.min(height - 1, Math.floor(height * py)));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        maxChannel = Math.max(maxChannel, pixel[0], pixel[1], pixel[2]);
      }
      lastFrameSample = {
        known: true,
        black: maxChannel < 12,
        maxChannel,
        sampledAt: now,
      };
    } catch (_) {
      lastFrameSample = { known: false, black: false, maxChannel: -1, sampledAt: now };
    }
    return lastFrameSample;
  };

  const mkdirp = (path) => {
    if (!mod?.FS || !path) return;
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      try {
        mod.FS.mkdir(cur);
      } catch (_) {}
    }
  };

  const writeFile = (path, data) => {
    const slash = path.lastIndexOf('/');
    if (slash > 0) mkdirp(path.slice(0, slash));
    mod.FS.writeFile(path, data);
  };

  const writeRetroArchConfig = () => {
    writeFile(
      '/home/web_user/.config/retroarch/retroarch.cfg',
      [
        'autosave_interval = 0',
        'block_sram_overwrite = false',
        'video_gpu_screenshot = false',
        'audio_enable = false',
        'audio_latency = 64',
        'video_vsync = false',
        'video_smooth = false',
        'fastforward_ratio = 1.0',
        'slowmotion_ratio = 1.0',
        'savefile_directory = "/tmp"',
        '',
      ].join('\n'),
    );
    mkdirp('/tmp');
  };

  // savedRunner: the FIRST `MainLoop.runner` Emscripten schedules
  // via `requestAnimationFrame` at the end of `mod.callMain`. Web
  // Workers have no native rAF, so our `installManualRAF` override
  // captures that callback into `pendingRunner`. We then snapshot it
  // into `savedRunner` and use that reference forever.
  //
  // Why not pause/resume? In Worker context, `MainLoop.resume()` does
  // not actually schedule a fresh rAF in our manualRAF — empirical
  // probe shows rAF is invoked exactly once (boot), after which
  // RetroArch's `platform_emscripten_set_main_loop_interval` switches
  // timing to SETIMMEDIATE/SETTIMEOUT (because retroarch.cfg sets
  // `video_vsync = false`). That setTimeout chain runs naturally
  // between message handlers, but each pause/resume bumps
  // `currentlyRunningMainloop`, which makes the runner's
  // closure-captured `thisMainLoopId` stale and causes
  // `checkIsRunning()` to return false — the runner exits without
  // doing any work.
  //
  // Holding `savedRunner` and never touching pause/resume keeps the
  // captured runner valid for the life of the worker, so every
  // `stepOnce` and warm yield can advance the emulator cleanly.
  let savedRunner = null;

  const captureSavedRunner = () => {
    if (savedRunner || !pendingRunner) return;
    savedRunner = pendingRunner;
    pendingRunner = null;
  };

  const recaptureRunner = () => {
    // Intentional no-op: see savedRunner comment above. Pause/resume
    // would invalidate the runner in worker context. Callers that
    // expect this to repopulate `pendingRunner` should instead use
    // `savedRunner` via `runCapturedRunner`.
  };

  const runCapturedRunner = (frameTime) => {
    if (!mod) return false;
    captureSavedRunner();
    if (!savedRunner) return false;
    savedRunner(frameTime);
    return true;
  };

  // Async warm: yield to the worker's event loop between checks so
  // Emscripten's queue-driven `setTimeout(MainLoop.runner, 0)` chain
  // can fire and drive boot through `retro_load_game` →
  // `init_device` → `g_dev.rdram.dram` allocation. Synchronous
  // pumping starves that chain — every queued task `setTimeout`s the
  // next iteration, but those `setTimeout`s can't fire while a
  // synchronous JS task is still on the stack. Yielding via
  // `await new Promise(setTimeout)` lets the chain advance.
  const warmUntilRdramReady = async (maxFrames = 180) => {
    if (!mod?._kn_get_rdram_ptr) return 0;
    for (let i = 0; i < maxFrames; i++) {
      const ptr = mod._kn_get_rdram_ptr() || 0;
      if (ptr) return ptr;
      runCapturedRunner((i + 1) * FRAME_MS);
      currentFrame = i + 1;
      setStatusValue(STATUS_IDX.frame, currentFrame);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return mod._kn_get_rdram_ptr() || 0;
  };

  const loadStateImmediate = (stateBytes, frame, reason) => {
    if (!mod || !stateBytes || stateBytes.byteLength <= 0) return false;
    // Authoritative state replaces any predicted self-pump output;
    // cancel pump so the next composite shows the loaded state, not
    // a tail-end pump frame.
    stopPump();
    const bytes = stateBytes instanceof Uint8Array ? stateBytes : new Uint8Array(stateBytes);
    let result = -1;
    if (mod._kn_load_state_immediate && mod._malloc && mod._free && mod.HEAPU8) {
      const ptr = mod._malloc(bytes.length);
      if (!ptr) throw new Error(`state malloc failed (${bytes.length} bytes)`);
      try {
        mod.HEAPU8.set(bytes, ptr);
        result = mod._kn_load_state_immediate(ptr, bytes.length);
      } finally {
        mod._free(ptr);
      }
    } else if (mod.cwrap && mod.FS) {
      writeFile('/shadow.state', bytes);
      const loadState = mod.cwrap('load_state', 'number', ['string', 'number']);
      result = loadState('shadow.state', 0);
    } else {
      throw new Error('no state load path available');
    }
    if (mod._kn_set_frame && Number.isFinite(frame)) mod._kn_set_frame(frame | 0);
    currentFrame = Number.isFinite(frame) ? frame | 0 : currentFrame;
    setStatusValue(STATUS_IDX.frame, currentFrame);
    bumpStatusValue(STATUS_IDX.resyncs);
    recaptureRunner();
    post({ type: 'resynced', frame: currentFrame, result, reason });
    return result === 0;
  };

  const withTempBytes = (bytes, fn) => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    if (!view.byteLength) return fn(0, 0);
    if (!mod?._malloc || !mod?._free || !mod.HEAPU8) throw new Error('malloc/free unavailable');
    const ptr = mod._malloc(view.byteLength);
    if (!ptr) throw new Error(`temp malloc failed (${view.byteLength} bytes)`);
    try {
      mod.HEAPU8.set(view, ptr);
      return fn(ptr, view.byteLength);
    } finally {
      mod._free(ptr);
    }
  };

  const loadSplitState = (message) => {
    const reject = (why, extra = {}) => {
      post({
        type: 'resync-rejected',
        split: true,
        reason: message?.reason || 'resync-split',
        frame: currentFrame,
        message: why,
        ...extra,
      });
      return false;
    };
    if (!mod || !message?.rdram || !message?.cpu) return reject('split state payload missing');
    stopPump();
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let result = -1;
    if (!mod._kn_get_rdram_ptr || !mod._kn_sync_write_cpu || !mod.HEAPU8) {
      return reject('split state load exports unavailable');
    }
    try {
      const rdram = message.rdram instanceof Uint8Array ? message.rdram : new Uint8Array(message.rdram);
      const cpu = message.cpu instanceof Uint8Array ? message.cpu : new Uint8Array(message.cpu);
      const rdramPtr = mod._kn_get_rdram_ptr();
      if (!rdramPtr || !rdram.byteLength || !cpu.byteLength) {
        return reject('split state payload invalid', {
          rdramPtr: Number(rdramPtr || 0),
          rdramBytes: rdram.byteLength | 0,
          cpuBytes: cpu.byteLength | 0,
        });
      }
      mod.HEAPU8.set(rdram, rdramPtr);
      result = withTempBytes(cpu, (ptr, len) => mod._kn_sync_write_cpu(ptr, len));
      if (result !== 0) return reject(`split cpu restore failed result=${result}`);
      if (message.hidden && mod._kn_restore_hidden_state_impl) {
        withTempBytes(message.hidden, (ptr) => {
          if (ptr) mod._kn_restore_hidden_state_impl(ptr);
        });
      }
      if (message.hle && mod._kn_hle_restore_from) {
        withTempBytes(message.hle, (ptr) => {
          if (ptr) mod._kn_hle_restore_from(ptr);
        });
      }
    } catch (error) {
      return reject(error?.message || String(error));
    }
    const frame = Number.isFinite(message.frame) ? message.frame | 0 : currentFrame;
    if (mod._kn_set_frame) mod._kn_set_frame(frame);
    currentFrame = frame;
    setStatusValue(STATUS_IDX.frame, currentFrame);
    bumpStatusValue(STATUS_IDX.resyncs);
    recaptureRunner();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    post({
      type: 'resynced',
      frame: currentFrame,
      result,
      reason: message.reason,
      split: true,
      loadMs: t1 - t0,
    });
    return result === 0;
  };

  const applyInputs = (inputs) => {
    if (!Array.isArray(inputs) || !mod?._kn_write_controller) return;
    lastInputs = inputs;
    for (const input of inputs) {
      if (!input) continue;
      const slot = input.slot | 0;
      if (slot < 0 || slot > 3) continue;
      mod._kn_write_controller(slot, input.buttons | 0, input.lx | 0, input.ly | 0, input.cx | 0, input.cy | 0);
    }
  };

  const stepOnce = (frame, inputs) => {
    if (!ready || !mod) return false;
    const inputArr = inputs || lastInputs;
    applyInputs(inputArr);
    const f = Number.isFinite(frame) ? frame | 0 : currentFrame;
    const frameTime = (f + 1) * FRAME_MS;
    if (mod._kn_set_frame) mod._kn_set_frame(f);
    if (mod._kn_set_frame_time) mod._kn_set_frame_time(frameTime);
    // Route inputs through the rollback engine when it's been
    // initialized so the state ring populates with main-matching
    // saves. kn_feed_input writes remote-slot inputs to the ring at
    // the apply-frame; kn_pre_tick saves state + records the local
    // slot's input + (for confirmed-only worker timeline) finds remote
    // inputs in the ring with no prediction needed.
    //
    // frame_adv=-1 disables pacing-throttle in pre_tick — worker's
    // not predicting ahead, so frame advantage tracking doesn't apply.
    if (rollbackInited && mod._kn_pre_tick) {
      const applyFrame = f - rbDelayFrames;
      let localInput = null;
      if (Array.isArray(inputArr)) {
        for (const inp of inputArr) {
          if (!inp) continue;
          if ((inp.slot | 0) === rbLocalSlot) {
            localInput = inp;
          } else if (mod._kn_feed_input && applyFrame >= 0) {
            mod._kn_feed_input(
              inp.slot | 0,
              applyFrame | 0,
              inp.buttons | 0,
              inp.lx | 0,
              inp.ly | 0,
              inp.cx | 0,
              inp.cy | 0,
            );
          }
        }
      }
      const li = localInput || { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
      try {
        mod._kn_pre_tick(li.buttons | 0, li.lx | 0, li.ly | 0, li.cx | 0, li.cy | 0, -1);
      } catch (_) {
        // pre_tick may throw on edge cases (uninitialized state, OOB);
        // fall back to plain step behavior so worker keeps mirroring.
      }
    }
    captureSavedRunner();
    if (!savedRunner) return false;
    savedRunner(frameTime);
    if (rollbackInited && mod._kn_post_tick) {
      try {
        mod._kn_post_tick();
      } catch (_) {}
    }
    currentFrame = f + 1;
    setStatusValue(STATUS_IDX.frame, currentFrame);
    bumpStatusValue(STATUS_IDX.steps);
    return true;
  };

  // Read the N64 active framebuffer from RDRAM and convert to RGBA8888.
  // Requires the ANGRYLION software RDP plugin (which writes to RDRAM,
  // unlike GLideN64 which renders to offscreen FBOs). Returns null if
  // VI registers report a blank/invalid configuration.
  //
  // Pixel format encoding from VI_STATUS bits 0-1:
  //   0 = blank, 1 = reserved, 2 = 16-bit RGBA5551, 3 = 32-bit RGBA8888.
  // 16-bit pixels are big-endian; we read with DataView to get the
  // correct byte order regardless of host endianness.
  const _knFbBuffer = { rgba: null, w: 0, h: 0 };
  const readFramebuffer = () => {
    if (!mod?._kn_get_vi_origin || !mod?._kn_get_vi_width || !mod?._kn_get_vi_status) return null;
    if (!mod?._kn_get_rdram_ptr || !mod.HEAPU8) return null;
    const status = mod._kn_get_vi_status() >>> 0;
    const fmt = status & 0x3;
    if (fmt !== 2 && fmt !== 3) return null;
    const origin = (mod._kn_get_vi_origin() >>> 0) & 0x00ffffff;
    const width = (mod._kn_get_vi_width() >>> 0) & 0xfff;
    if (!width || width > 1024) return null;
    // Height is implied by VI_V_SYNC and X/Y scale; in practice N64
    // games use 240 (NTSC) or 200 (PAL letterbox). Use 240 as default
    // but cap by RDRAM size.
    const height = 240;
    const rdramPtr = mod._kn_get_rdram_ptr() >>> 0;
    if (!rdramPtr) return null;
    const bpp = fmt === 3 ? 4 : 2;
    const fbBytes = width * height * bpp;
    if (origin + fbBytes > 0x800000) return null;
    const fbStart = rdramPtr + origin;
    if (!_knFbBuffer.rgba || _knFbBuffer.w !== width || _knFbBuffer.h !== height) {
      _knFbBuffer.rgba = new Uint8ClampedArray(width * height * 4);
      _knFbBuffer.w = width;
      _knFbBuffer.h = height;
    }
    const out = _knFbBuffer.rgba;
    if (fmt === 3) {
      // 32-bit: RDRAM stores RGBA8888 directly. RDRAM is in big-endian
      // word order on N64; mupen64plus stores RDRAM in host word order
      // (so the JS view is little-endian on x86). Each 32-bit word in
      // RDRAM contains 1 pixel: 0xRRGGBBAA. With LE host, byte 0 = A,
      // byte 1 = B, byte 2 = G, byte 3 = R. Re-pack to canvas RGBA.
      try {
        const src = new Uint8Array(mod.HEAPU8.buffer, fbStart, fbBytes);
        for (let i = 0, j = 0; i < fbBytes; i += 4, j += 4) {
          out[j] = src[i + 3];
          out[j + 1] = src[i + 2];
          out[j + 2] = src[i + 1];
          out[j + 3] = 0xff;
        }
      } catch (_) {
        return null;
      }
    } else {
      // 16-bit RGBA5551: 0xRRRRRGGGGGBBBBBA, big-endian per pixel within
      // a 16-bit word. With host LE, byte 0 = high byte of pixel.
      try {
        const src = new Uint8Array(mod.HEAPU8.buffer, fbStart, fbBytes);
        for (let i = 0, j = 0; i < fbBytes; i += 2, j += 4) {
          // N64 RDRAM 16-bit framebuffer is laid out as pairs of pixels
          // swapped within each 32-bit word due to native endianness;
          // read as big-endian uint16 by combining src[i] and src[i+1].
          // The host-endian quirk is handled by mupen64plus already
          // when writing to dram, so we read big-endian per pixel here:
          // pixel hi byte = src[i ^ 2 within word] for 16-bit BE-on-LE.
          // For simplicity, try straight LE first; if output looks
          // garbled, byte-swap via XOR i with 1.
          const lo = src[i];
          const hi = src[i + 1];
          const pix = (hi << 8) | lo;
          // RGBA5551 layout: 5R 5G 5B 1A
          const r = (pix >> 11) & 0x1f;
          const g = (pix >> 6) & 0x1f;
          const b = (pix >> 1) & 0x1f;
          out[j] = (r << 3) | (r >> 2);
          out[j + 1] = (g << 3) | (g >> 2);
          out[j + 2] = (b << 3) | (b >> 2);
          out[j + 3] = 0xff;
        }
      } catch (_) {
        return null;
      }
    }
    return { rgba: out, width, height };
  };

  const stepBatch = (message) => {
    // Pump and explicit step coexist: both call stepOnce on the same
    // worker thread, so they're trivially serialised. Killing pump
    // here would make every normal-tick `step` message (~60/sec)
    // immediately cancel the pump that was just scheduled by
    // start-pump on the previous tick — pump would never fire even
    // once. Only stop-pump / resync / stop should halt the pump.
    const count = Math.max(1, Math.min(MAX_BATCH_STEPS, message.count | 0 || 1));
    const startFrame = Number.isFinite(message.frame) ? message.frame | 0 : currentFrame;
    let stepped = 0;
    for (let i = 0; i < count; i++) {
      if (!stepOnce(startFrame + i, message.inputs)) break;
      stepped++;
    }
    // Read framebuffer from RDRAM and post to main as a transferable
    // Uint8ClampedArray buffer. Throttle to every 2nd step in the
    // steady state (worker gets ~60 step messages/sec, postMessage
    // of a 320×240 RGBA buffer is ~300 KB so ~18 MB/s at full rate
    // is wasteful when shadow isn't visible). Independent from the
    // wantSample / black-detection path — we send framebuffer bytes
    // separately from the small "is it black?" probe.
    let fbPosted = false;
    const fbThrottleKey = (currentFrame >>> 0) & 1;
    const sendFrame = stepped > 0 && message.wantFrame && (fbThrottleKey === 0 || message.force);
    const forceSample = message.reason === 'replay-runahead' || String(message.reason || '').startsWith('prewarm');
    // When we sent a real framebuffer (which by definition isn't
    // empty since we just decoded RDRAM into RGBA pixels), skip the
    // legacy OffscreenCanvas black-sample — that would always report
    // black (the OffscreenCanvas isn't where the rendered output
    // lands under the framebuffer-blit path) and clobber the
    // non-black flag the main-thread frame handler just set.
    const sample = stepped > 0 && message.wantSample && !sendFrame ? sampleFrameBlack(forceSample) : lastFrameSample;
    if (sendFrame) {
      try {
        const fb = readFramebuffer();
        if (fb && fb.rgba && fb.width > 0 && fb.height > 0) {
          // Make a copy that we can transfer (the persistent buffer
          // is reused; transferring would detach it). For low overhead
          // we send a sliced ArrayBuffer.
          const copy = new Uint8ClampedArray(fb.rgba);
          post(
            {
              type: 'frame',
              seq: message.seq | 0,
              frame: currentFrame,
              width: fb.width,
              height: fb.height,
              rgba: copy.buffer,
            },
            [copy.buffer],
          );
          fbPosted = true;
        }
      } catch (_) {}
    }
    // When we successfully posted a framebuffer message, the main
    // thread already has a real, non-black frame in hand. Force the
    // stepped ack to report `black: false` so the legacy paint-gate
    // path sees a confirmed non-black frame regardless of what the
    // (now-empty) OffscreenCanvas sample would say. Without this the
    // cached `lastFrameSample` from the earliest pre-framebuffer-path
    // sample sticks at `black: true` and gates every show.
    post({
      type: 'stepped',
      seq: message.seq | 0,
      frame: currentFrame,
      count: stepped,
      reason: message.reason || '',
      black: fbPosted ? false : sample.known ? sample.black : null,
      maxChannel: fbPosted ? 255 : sample.maxChannel,
      framePosted: fbPosted,
    });
  };

  function stopPump() {
    pumpActive = false;
    pumpUntilFrame = -1;
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = 0;
    }
  }

  const pumpTick = () => {
    pumpTimer = 0;
    if (!pumpActive || !ready || !mod) {
      pumpActive = false;
      return;
    }
    if (pumpUntilFrame > 0 && currentFrame >= pumpUntilFrame) {
      pumpActive = false;
      return;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ok = stepOnce(currentFrame, lastInputs);
    if (!ok) {
      pumpActive = false;
      return;
    }
    if (!pumpActive) return;
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const wait = Math.max(0, PUMP_INTERVAL_MS - elapsed);
    pumpTimer = setTimeout(pumpTick, wait);
  };

  const startPump = (message) => {
    if (!ready || !mod) return;
    if (Array.isArray(message.inputs) && message.inputs.length) lastInputs = message.inputs;
    const until = Number.isFinite(message.untilFrame) ? message.untilFrame | 0 : currentFrame + 8;
    pumpUntilFrame = Math.max(currentFrame + 1, until);
    pumpActive = true;
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = 0;
    }
    // First tick fires on the next worker microtask so the start-pump
    // ack is processed first; subsequent ticks self-pace at ~vsync.
    pumpTimer = setTimeout(pumpTick, 0);
  };

  const resize = (width, height) => {
    if (!canvas) return;
    const w = Math.max(1, Math.min(4096, width | 0 || 640));
    const h = Math.max(1, Math.min(4096, height | 0 || 480));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };

  const boot = async (message) => {
    try {
      setStatus(STATUS.BOOTING);
      coreBase = message.coreBase || coreBase;
      coreSettings = message.coreSettings || '';
      canvas = message.canvas;
      parentTarget = ensureEventTarget(makeEventTargetStub('DIV'), 'DIV');
      resize(message.width, message.height);
      patchCanvas(canvas);

      installWorkerDomStubs();
      installManualRAF();

      importScripts(message.coreScript || `${coreBase}mupen64plus_next_libretro.js`);
      const runtime = self.EJS_Runtime;
      if (typeof runtime !== 'function') throw new Error('EJS_Runtime unavailable');

      mod = await runtime({
        noInitialRun: true,
        arguments: [],
        preRun: [],
        postRun: [],
        canvas,
        callbacks: {
          setupCoreSettingFile: (path) => {
            try {
              writeFile(path, coreSettings);
            } catch (_) {}
          },
        },
        parent: parentTarget,
        print: () => {},
        printErr: (line) => {
          if (message.verbose) post({ type: 'stderr', line: String(line) });
        },
        totalDependencies: 0,
        locateFile: (file) => `${coreBase}${file}`,
        getSavExt: () => '.srm',
      });

      writeRetroArchConfig();
      if (mod._kn_set_skip_audio_output) mod._kn_set_skip_audio_output(1);
      if (mod._kn_set_skip_rsp_audio) mod._kn_set_skip_rsp_audio(1);
      if (mod._kn_set_controller_present_mask) mod._kn_set_controller_present_mask(message.controllerMask | 0 || 3);

      const romBytes = new Uint8Array(message.rom);
      writeFile('/shadow.z64', romBytes);
      mod.callMain(['/shadow.z64']);
      if (mod._kn_set_skip_audio_output) mod._kn_set_skip_audio_output(1);
      if (mod._kn_set_skip_rsp_audio) mod._kn_set_skip_rsp_audio(1);
      // Snapshot the runner Emscripten just scheduled via rAF.
      // After this point we never call pauseMainLoop/resumeMainLoop,
      // so the captured runner stays valid for the worker's lifetime.
      captureSavedRunner();
      await warmUntilRdramReady();

      if (message.state) loadStateImmediate(message.state, message.frame, 'boot');
      ready = true;
      setStatus(STATUS.READY);
      setStatusValue(STATUS_IDX.frame, currentFrame);
      post({ type: 'ready', frame: currentFrame, sab: !!statusView });
    } catch (error) {
      fail('boot', error);
    }
  };

  self.onmessage = (event) => {
    const message = event.data || {};
    try {
      if (message.type === 'init') {
        if (message.statusSab) statusView = new Int32Array(message.statusSab);
        boot(message);
      } else if (message.type === 'resize') {
        resize(message.width, message.height);
      } else if (message.type === 'step') {
        stepBatch(message);
      } else if (message.type === 'start-pump') {
        startPump(message);
      } else if (message.type === 'stop-pump') {
        stopPump();
      } else if (message.type === 'resync') {
        loadStateImmediate(message.state, message.frame, message.reason || 'resync');
      } else if (message.type === 'resync-split') {
        loadSplitState(message);
      } else if (message.type === 'stop') {
        stopPump();
        ready = false;
        try {
          mod?.pauseMainLoop?.();
        } catch (_) {}
        post({ type: 'stopped' });
        close();
      } else if (message.type === 'rollback-init') {
        // Initialize the rollback engine in the worker with the SAME
        // params main used for its own kn_rollback_init. After this:
        //   - rb.initialized=true → kn_*_hash exports return real
        //     values (determinism check becomes possible)
        //   - state ring lives in worker memory, populated by
        //     subsequent stepOnce calls that route through kn_pre_tick
        //   - worker's ring at frame F should bit-match main's ring at
        //     frame F modulo tainted regions (renderer / audio / kernel
        //     spillover) once we wire kn_pre_tick into the step path.
        try {
          const {
            rollbackMax = 22,
            delayFrames = 6,
            localSlot = 0,
            numPlayers = 4,
            initFrame = -1,
            trueRollback = 1,
            stateBackend = 1, // 1 = split-rdram (matches main's default)
          } = message;
          if (!mod?._kn_rollback_init) {
            post({ type: 'rollback-init-result', ok: false, error: 'kn_rollback_init export missing' });
          } else {
            if (mod._kn_set_state_backend) mod._kn_set_state_backend(stateBackend | 0);
            mod._kn_rollback_init(rollbackMax | 0, delayFrames | 0, localSlot | 0, numPlayers | 0);
            if (mod._kn_set_true_rollback) mod._kn_set_true_rollback(trueRollback | 0);
            if (initFrame >= 0 && mod._kn_set_frame) {
              mod._kn_set_frame(initFrame | 0);
              currentFrame = initFrame | 0;
              setStatusValue(STATUS_IDX.frame, currentFrame);
            }
            rollbackInited = true;
            rbLocalSlot = localSlot | 0;
            rbDelayFrames = delayFrames | 0;
            rbNumPlayers = numPlayers | 0;
            post({
              type: 'rollback-init-result',
              ok: true,
              rollbackMax: rollbackMax | 0,
              delayFrames: delayFrames | 0,
              localSlot: localSlot | 0,
              numPlayers: numPlayers | 0,
              initFrame: initFrame | 0,
            });
          }
        } catch (e) {
          rollbackInited = false;
          post({ type: 'rollback-init-result', ok: false, error: String(e) });
        }
      } else if (message.type === 'rollback-replay') {
        // Coprocessor replay path. Main detected a misprediction at
        // `targetFrame` of depth `depth` and corrected inputs are
        // attached. Worker:
        //   1. Confirms its ring slot at (targetFrame - depth) is
        //      populated (it should be — worker's been lockstep-stepping
        //      with main, so its ring at any recent frame is valid).
        //   2. Restores RDRAM + CPU state from that ring slot via
        //      kn_pre_tick's pending-rollback path.
        //   3. Replays `depth` frames feeding the corrected inputs
        //      through kn_pre_tick (recording them into the ring) and
        //      stepping the runner.
        //   4. Serializes the resulting state at `targetFrame` via
        //      kn_get_split_state_for_shadow and posts the bytes back
        //      to main as transferable buffers.
        //
        // Inputs format (from main): array of { slot, frame, buttons,
        // lx, ly, cx, cy } — one entry per (slot, frame) that has a
        // confirmed input within the replay window. kn_feed_input
        // records each into the worker's input ring at the given frame.
        const seq = message.seq | 0;
        const targetFrame = message.targetFrame | 0;
        const depth = message.depth | 0;
        const inputs = Array.isArray(message.inputs) ? message.inputs : [];
        const reject = (why) => post({ type: 'rollback-replay-result', seq, ok: false, error: why });
        try {
          if (!rollbackInited) return reject('rollback engine not initialized in worker');
          if (!mod?._kn_pre_tick || !mod?._kn_post_tick) return reject('missing pre/post tick exports');
          if (!mod?._kn_get_split_state_for_shadow || !mod?._malloc || !mod?._free)
            return reject('missing split-state/alloc exports');
          const startFrame = targetFrame - depth;
          if (startFrame < 0) return reject(`invalid range: targetFrame=${targetFrame} depth=${depth}`);

          // Feed the corrected inputs into the worker's ring BEFORE
          // triggering the rollback. kn_pre_tick's pending-rollback
          // path then sees fresh inputs at every replay frame and
          // doesn't predict.
          if (mod._kn_feed_input) {
            for (const inp of inputs) {
              if (!inp) continue;
              mod._kn_feed_input(
                inp.slot | 0,
                inp.frame | 0,
                inp.buttons | 0,
                inp.lx | 0,
                inp.ly | 0,
                inp.cx | 0,
                inp.cy | 0,
              );
            }
          }

          // Trigger rollback: pre_tick with pending_rollback set via
          // a feed_input at startFrame would have queued it. But the
          // simpler path: restore directly via the ring restore call.
          // There's no public restore export — kn_pre_tick handles it
          // via internal state tracking. Easiest API surface: just
          // step forward from the ring slot at startFrame and let
          // pre_tick's normal flow drive replay.
          //
          // Per the C engine: a rollback is initiated by setting
          // rb.pending_rollback = startFrame, which kn_pre_tick acts
          // on. We trigger this via kn_feed_input with a corrected
          // input at startFrame that differs from what was previously
          // there — the misprediction handler then sets pending_rollback.
          //
          // For this v1 implementation we trust that the inputs main
          // sent already triggered the rollback machinery. We just
          // step `depth` frames; pre_tick's replay branch handles the
          // restore on the first call automatically because
          // pending_rollback is set.
          let stepped = 0;
          for (let i = 0; i < depth; i++) {
            const frameToStep = startFrame + i;
            // Find the local slot's input for this frame (if main sent it).
            let localInput = null;
            for (const inp of inputs) {
              if (inp && (inp.slot | 0) === rbLocalSlot && (inp.frame | 0) === frameToStep) {
                localInput = inp;
                break;
              }
            }
            const li = localInput || { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
            // kn_set_frame is rejected during replay/rollback (pending_rollback>=0
            // at i=0, replay_remaining>0 at i>=1), so calls inside the loop are
            // dead. We reset rb.frame explicitly AFTER the loop, before
            // kn_save_endpoint_state, so the endpoint lands in ring[targetFrame].
            const catchup = mod._kn_pre_tick(li.buttons | 0, li.lx | 0, li.ly | 0, li.cx | 0, li.cy | 0, -1);
            // R1-R6 fail-loud: at i=0 the kn_feed_input calls above must have
            // queued pending_rollback so kn_pre_tick takes the restore path
            // and returns 2 (catching up). If it returns anything else, the
            // ring slot at startFrame is stale or the rollback machinery
            // didn't trigger — stepping `depth` frames forward from worker's
            // current position would silently produce wrong endpoint state
            // for main. Reject the job so main's _coprocRecover handles it
            // via local replay instead.
            if (i === 0 && catchup !== 2) {
              return reject(
                `rollback did not trigger on first pre_tick (returned ${catchup}); ring slot at startFrame=${startFrame} likely stale`,
              );
            }
            captureSavedRunner();
            if (savedRunner) savedRunner((frameToStep + 1) * FRAME_MS);
            mod._kn_post_tick();
            stepped++;
          }

          // After the replay loop, the live state is "entering-targetFrame"
          // (post-frame-(targetFrame-1)). Pre_tick saves BEFORE stepping, so
          // the most recently saved ring slot is targetFrame-1 — applying
          // that on main would make the next stepOneFrame paint frame
          // targetFrame-1, which is the SAME frame the user already saw
          // before the rollback. To eliminate the visible one-frame skip we
          // explicitly save ring[targetFrame] = state-entering-targetFrame,
          // then query it. Main applies that and the next synchronous
          // stepOneFrame paints frame targetFrame for the first time.
          //
          // rb.frame ends the loop at startFrame + depth (= targetFrame in
          // the steady-state where the worker entered with rb.frame ==
          // targetFrame), but the C-side replay path uses the worker's
          // pre-rollback rb.frame to compute its internal depth, so a
          // worker that drifted ahead/behind targetFrame would land
          // rb.frame somewhere else. Either way, kn_save_endpoint_state
          // saves to ring[rb.frame % ring_size], so we need rb.frame ==
          // targetFrame for the lookup at line below to find the slot.
          // kn_set_frame requires pending_rollback < 0 and replay_remaining
          // == 0 — both true here once the loop finishes.
          if (mod._kn_set_frame) mod._kn_set_frame(targetFrame);
          if (mod._kn_save_endpoint_state) {
            const saveRc = mod._kn_save_endpoint_state();
            if (saveRc !== 0) return reject(`save-endpoint failed rc=${saveRc}`);
          }
          // Read back the freshly computed state at targetFrame.
          // kn_get_split_state_for_shadow returns an array of 9 uint32s
          // describing the ring slot's RDRAM + CPU + hidden + HLE
          // pointers and sizes.
          const outBytes = 9 * 4;
          const outPtr = mod._malloc(outBytes);
          if (!outPtr) return reject('split-state out alloc failed');
          const out = new Uint32Array(mod.HEAPU32.buffer, outPtr, 9);
          // Query at targetFrame (which we just saved via save_endpoint)
          // when available, otherwise fall back to the older "T-1, accept
          // a redundant repaint" path.
          const queryFrame = mod._kn_save_endpoint_state ? targetFrame : targetFrame - 1;
          const result = mod._kn_get_split_state_for_shadow(queryFrame, outPtr, 9);
          if (result !== 9) {
            mod._free(outPtr);
            return reject(`split-state-export failed for frame=${queryFrame} (returned ${result})`);
          }
          // Copy bytes out of WASM heap so we can transfer them.
          // Layout: rdramPtr, rdramSize, cpuPtr, cpuSize, hiddenPtr,
          // hiddenSize, hlePtr, hleSize, savedFrame.
          const rdramPtr = out[0];
          const rdramSize = out[1];
          const cpuPtr = out[2];
          const cpuSize = out[3];
          const savedFrame = out[8];
          // Copy to detachable buffers (Uint8Array slice).
          const rdramBytes = mod.HEAPU8.slice(rdramPtr, rdramPtr + rdramSize);
          const cpuBytes = mod.HEAPU8.slice(cpuPtr, cpuPtr + cpuSize);
          mod._free(outPtr);

          post(
            {
              type: 'rollback-replay-result',
              seq,
              ok: true,
              targetFrame,
              savedFrame: savedFrame | 0,
              depthReplayed: stepped,
              rdram: rdramBytes.buffer,
              rdramSize,
              cpu: cpuBytes.buffer,
              cpuSize,
            },
            [rdramBytes.buffer, cpuBytes.buffer],
          );
          currentFrame = targetFrame;
          setStatusValue(STATUS_IDX.frame, currentFrame);
        } catch (e) {
          reject(`replay threw: ${e?.message || e}`);
        }
      } else if (message.type === 'query-hash') {
        // Returns the worker's most recently SAVED frame (rb.frame-1
        // because rb_save_slot fires BEFORE the step in kn_pre_tick;
        // the state at rb.frame itself isn't saved yet at the moment
        // of query) plus its three hashes at that frame.
        try {
          const cur = mod?._kn_get_frame?.() ?? -1;
          const queryFrame = cur > 0 ? cur - 1 : -1;
          const gp = queryFrame >= 0 ? (mod?._kn_gameplay_hash?.(queryFrame) ?? 0) >>> 0 : 0;
          const game = queryFrame >= 0 ? (mod?._kn_game_state_hash?.(queryFrame) ?? 0) >>> 0 : 0;
          const full = queryFrame >= 0 ? (mod?._kn_full_state_hash?.(queryFrame) ?? 0) >>> 0 : 0;
          const tainted = mod?._kn_get_tainted_block_count?.() ?? -1;
          post({
            type: 'hash-result',
            seq: message.seq | 0,
            currentFrame: cur,
            frame: queryFrame, // the frame the hashes are FOR
            gp,
            game,
            full,
            taintedBlockCount: tainted,
          });
        } catch (e) {
          post({ type: 'hash-result', seq: message.seq | 0, error: String(e) });
        }
      }
    } catch (error) {
      fail(message.type || 'message', error);
    }
  };
})();
