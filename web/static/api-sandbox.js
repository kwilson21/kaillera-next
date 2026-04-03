/**
 * api-sandbox.js — Centralized native browser API reference management.
 *
 * Must be loaded BEFORE all other scripts. Saves native references to
 * browser APIs that lockstep mode overrides, and provides explicit
 * override/restore lifecycle.
 *
 * Usage:
 *   APISandbox.nativeRAF(cb)          — real requestAnimationFrame
 *   APISandbox.nativePerfNow()        — real performance.now()
 *   APISandbox.nativeGetGamepads()    — real navigator.getGamepads()
 *   APISandbox.overrideRAF(fn)        — replace rAF (returns restore fn)
 *   APISandbox.overridePerfNow(fn)    — replace performance.now
 *   APISandbox.overrideGetGamepads(fn) — replace navigator.getGamepads
 *   APISandbox.restoreAll()           — restore all overrides at once
 */
(function () {
  'use strict';

  // Save native references at load time — before anything can override them.
  const _nativeRAF = window.requestAnimationFrame.bind(window);
  const _nativeCancelRAF = window.cancelAnimationFrame.bind(window);
  const _nativePerfNow = performance.now.bind(performance);
  // Use the prototype method directly — survives navigator.getGamepads being overridden.
  const _protoGetGamepads = Navigator.prototype.getGamepads;
  const _nativeGetGamepads = _protoGetGamepads ? () => _protoGetGamepads.call(navigator) : () => [];

  // Track which APIs are currently overridden
  let _rafOverridden = false;
  let _perfNowOverridden = false;
  let _getGamepadsOverridden = false;

  window.APISandbox = {
    // ── Native references (always return real browser behavior) ──
    nativeRAF: (cb) => _nativeRAF(cb),
    nativeCancelRAF: (id) => _nativeCancelRAF(id),
    nativePerfNow: () => _nativePerfNow(),
    nativeGetGamepads: () => _nativeGetGamepads(),

    // ── Individual overrides (applied at different times by lockstep) ──
    overrideRAF: (fn) => {
      window.requestAnimationFrame = fn;
      _rafOverridden = true;
    },

    overridePerfNow: (fn) => {
      performance.now = fn;
      _perfNowOverridden = true;
    },

    overrideGetGamepads: (fn) => {
      navigator.getGamepads = fn;
      _getGamepadsOverridden = true;
    },

    // ── Restore all overrides at once ──
    restoreAll: () => {
      if (_rafOverridden) {
        window.requestAnimationFrame = _nativeRAF;
        _rafOverridden = false;
      }
      if (_perfNowOverridden) {
        performance.now = _nativePerfNow;
        _perfNowOverridden = false;
      }
      if (_getGamepadsOverridden) {
        navigator.getGamepads = _nativeGetGamepads;
        _getGamepadsOverridden = false;
      }
    },

    isOverridden: (api) => {
      if (api === 'raf') return _rafOverridden;
      if (api === 'perfNow') return _perfNowOverridden;
      if (api === 'getGamepads') return _getGamepadsOverridden;
      return false;
    },
  };

  // ── Suppress WebGL "no texture bound" warnings from mupen64plus core ──
  // The WASM core calls glTexParameteri before binding a texture, which is
  // harmless but spams the console. Wrap texParameteri to skip the call
  // when no texture is bound to the target.
  const _origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    // Force preserveDrawingBuffer for WebGL so PostHog session replay
    // (and canvas.toDataURL) can capture the rendered frame.
    if (type === 'webgl' || type === 'webgl2') {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    const ctx = _origGetContext.call(this, type, attrs);
    if (ctx && (type === 'webgl' || type === 'webgl2') && !ctx._kn_patched) {
      const orig = ctx.texParameteri.bind(ctx);
      ctx.texParameteri = function (target, pname, param) {
        const binding = target === ctx.TEXTURE_2D ? ctx.TEXTURE_BINDING_2D : ctx.TEXTURE_BINDING_CUBE_MAP;
        if (!ctx.getParameter(binding)) return; // no texture bound — skip
        orig(target, pname, param);
      };
      ctx._kn_patched = true;
    }
    return ctx;
  };
})();
