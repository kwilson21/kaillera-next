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
    applyInputs(inputs || lastInputs);
    const f = Number.isFinite(frame) ? frame | 0 : currentFrame;
    const frameTime = (f + 1) * FRAME_MS;
    if (mod._kn_set_frame) mod._kn_set_frame(f);
    if (mod._kn_set_frame_time) mod._kn_set_frame_time(frameTime);
    captureSavedRunner();
    if (!savedRunner) return false;
    savedRunner(frameTime);
    currentFrame = f + 1;
    setStatusValue(STATUS_IDX.frame, currentFrame);
    bumpStatusValue(STATUS_IDX.steps);
    return true;
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
    const forceSample = message.reason === 'replay-runahead' || String(message.reason || '').startsWith('prewarm');
    const sample = stepped > 0 && message.wantSample ? sampleFrameBlack(forceSample) : lastFrameSample;
    post({
      type: 'stepped',
      seq: message.seq | 0,
      frame: currentFrame,
      count: stepped,
      reason: message.reason || '',
      black: sample.known ? sample.black : null,
      maxChannel: sample.maxChannel,
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
      }
    } catch (error) {
      fail(message.type || 'message', error);
    }
  };
})();
