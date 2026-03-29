/**
 * storage.js — Safe localStorage/sessionStorage with in-memory fallback.
 *
 * Brave mobile (and other privacy-focused browsers) block storage APIs.
 * This provides a transparent fallback: data survives within the session
 * but not across browser restarts — respecting the privacy intent.
 *
 * Load before all other kaillera-next scripts.
 */
(function () {
  'use strict';

  const mem = new Map();
  const canUse = (store) => {
    try { const k = '__kn__'; window[store].setItem(k, '1'); window[store].removeItem(k); return true; } catch (_) { return false; }
  };
  const ok = { localStorage: canUse('localStorage'), sessionStorage: canUse('sessionStorage') };

  window.KNStorage = {
    get: (store, key) => ok[store] ? window[store].getItem(key) : (mem.get(`${store}:${key}`) ?? null),
    set: (store, key, val) => ok[store] ? window[store].setItem(key, val) : mem.set(`${store}:${key}`, val),
    remove: (store, key) => ok[store] ? window[store].removeItem(key) : mem.delete(`${store}:${key}`),
  };
})();
