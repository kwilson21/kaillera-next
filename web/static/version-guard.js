/*
 * Version-mismatch force-reload guard
 * ───────────────────────────────────
 *
 * Every HTML response has a `<script>` tag injected by CacheBustMiddleware
 * that sets `window.__KN_ASSET_VERSION` to the server's asset-version tag at
 * page load time. This module polls `/api/version` at startup and
 * periodically, and if the server's current version differs from what the
 * page was loaded with, it logs a VERSION-MISMATCH event (to the console,
 * the session log if available, and the feedback telemetry path) and
 * force-reloads the page with cache bypass.
 *
 * Why this exists: local testing repeatedly hit cases where a browser tab
 * held a cached netplay-lockstep.js from before a fix landed, silently
 * running stale code and re-triggering a bug the code on disk had already
 * fixed. The `?v=` query-param cache-bust in HTML is necessary but
 * insufficient because it only takes effect on HTML reloads — a tab left
 * open across commits never re-fetches the HTML. This guard gives us a
 * reliable detection + force-reload path for that edge case.
 *
 * No automatic recovery of in-progress games — the guard only reloads
 * when the page is idle (no active game, or tab not visible). If a match
 * is in progress we log the mismatch and wait for the next idle window.
 * Safety: we never reload during an active game unless the tab is also
 * hidden, so players don't get yanked mid-match.
 */
(() => {
  'use strict';

  const POLL_INTERVAL_MS = 60_000; // once a minute is plenty
  const VERSION_ENDPOINT = '/api/version';
  const LOG_PREFIX = '[version-guard]';

  const pageLoadedVersion = window.__KN_ASSET_VERSION || '';
  if (!pageLoadedVersion) {
    // Nothing to compare against — older HTML or injection failed.
    // Silently do nothing so we don't break those pages.
    console.warn(`${LOG_PREFIX} __KN_ASSET_VERSION not set; guard disabled`);
    return;
  }

  let _reloadScheduled = false;
  let _lastLoggedVersion = '';

  const _logMismatch = (serverVersion, action) => {
    const line = `VERSION-MISMATCH page=${pageLoadedVersion} server=${serverVersion} action=${action}`;
    console.warn(`${LOG_PREFIX} ${line}`);
    // Forward to lockstep sync log if available so analyze_match.py can
    // surface the event from session-log exports.
    try {
      if (window.KNLockstep?.logSync) {
        window.KNLockstep.logSync(line);
      } else if (window.KNState?._syncLog) {
        window.KNState._syncLog(line);
      }
    } catch (_e) {}
    // Also emit as a KNEvent so the session timeline picks it up.
    try {
      if (typeof window.KNEvent === 'function') {
        window.KNEvent('version_mismatch', line, {
          page_version: pageLoadedVersion,
          server_version: serverVersion,
          action,
        });
      }
    } catch (_e) {}
  };

  const _gameInProgress = () => {
    // Rough heuristic: netplay-lockstep flips KNState.running or
    // KNState.sessionStats when a match is active.
    try {
      if (window.KNState?.running === true) return true;
      const stats = window.KNState?.sessionStats;
      if (stats && typeof stats.frames === 'number' && stats.frames > 0) {
        return true;
      }
    } catch (_e) {}
    return false;
  };

  const _safeToReload = () => {
    // Always safe if the tab is hidden — user isn't actively playing.
    if (document.hidden) return true;
    // Safe if no game in progress.
    return !_gameInProgress();
  };

  const _forceReload = () => {
    if (_reloadScheduled) return;
    _reloadScheduled = true;
    // Small delay so the log line has a chance to flush to the session
    // log before the page goes away.
    setTimeout(() => {
      // Force a network-cache-bypassing reload. `location.reload(true)`
      // is deprecated but still works in Safari; the fallback sets
      // location.href which respects the server's cache headers (no-store
      // on HTML means the next load is guaranteed fresh).
      try {
        if (typeof window.location.reload === 'function') {
          window.location.reload();
        } else {
          window.location.href = window.location.href;
        }
      } catch (_e) {
        window.location.href = window.location.href;
      }
    }, 200);
  };

  const _checkVersion = async () => {
    try {
      // no-store prevents the fetch itself from being cached
      const resp = await fetch(VERSION_ENDPOINT, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const serverVersion = data?.version || '';
      if (!serverVersion) return;
      if (serverVersion === pageLoadedVersion) return;

      // Mismatch detected
      if (serverVersion !== _lastLoggedVersion) {
        _lastLoggedVersion = serverVersion;
        if (_safeToReload()) {
          _logMismatch(serverVersion, 'reload');
          _forceReload();
        } else {
          _logMismatch(serverVersion, 'waiting-for-idle');
        }
      } else if (_safeToReload() && !_reloadScheduled) {
        // Already logged, but now we're idle — take the action.
        _logMismatch(serverVersion, 'reload-on-idle');
        _forceReload();
      }
    } catch (_e) {
      // Network error or server down — ignore, retry next interval
    }
  };

  // Check once at startup (lets us catch stale tabs immediately on reload)
  // then poll periodically. Also check whenever the tab regains focus —
  // that's the most common time for a user to return to a stale session.
  _checkVersion();
  setInterval(_checkVersion, POLL_INTERVAL_MS);
  window.addEventListener('visibilitychange', () => {
    if (!document.hidden) _checkVersion();
  });
  window.addEventListener('focus', _checkVersion);
})();
