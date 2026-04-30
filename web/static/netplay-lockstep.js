/**
 * netplay-lockstep.js - DEPRECATED COMPAT SHIM
 *
 * The implementation moved to /static/netplay-rollback.js. This file exists
 * so cached play.html responses from before the rename still load the real
 * engine instead of only avoiding a 404.
 *
 * Remove this file in a follow-up deploy once cached tabs are gone.
 */
(() => {
  'use strict';

  if (window.NetplayRollback) {
    window.NetplayLockstep = window.NetplayLockstep || window.NetplayRollback;
    return;
  }

  const current = document.currentScript;
  let search = '';
  try {
    search = current?.src ? new URL(current.src, window.location.href).search : '';
  } catch (_e) {}
  const rollbackSrc = `/static/netplay-rollback.js${search}`;

  // Cached old HTML loads this file in a parser-blocking script slot. Use
  // document.write in that narrow case so rollback loads before play.js.
  if (document.readyState === 'loading' && current) {
    document.write(`<script src="${rollbackSrc}"><\/script>`);
    return;
  }

  const script = document.createElement('script');
  script.src = rollbackSrc;
  script.async = false;
  script.onload = () => {
    if (window.NetplayRollback) {
      window.NetplayLockstep = window.NetplayLockstep || window.NetplayRollback;
    }
  };
  document.head.appendChild(script);
})();
