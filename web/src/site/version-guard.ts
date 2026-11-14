/**
 * Reloads a page that is older than the server. Moved from
 * web/static/version-guard.js.
 *
 * Every HTML response carries `<meta name="kn-asset-version">` with the
 * server's asset version at the time the page was served (a meta tag, so the
 * strict CSP on pages other than the play page does not block it). The guard
 * asks `/api/version` when it starts, once a minute, and when the tab is
 * looked at again. When the server's version differs from the page's it logs
 * `VERSION-MISMATCH` (console, sync log, session timeline) and reloads.
 *
 * A tab left open across a deploy never fetches the HTML again, so the
 * `?v=` cache-bust on script URLs cannot help it: it would keep running the
 * old engine against a fixed server.
 *
 * A player is never taken out of a match: the page reloads only when no game
 * is in progress or the tab is hidden. With a match on screen the mismatch is
 * logged and the reload waits for the next check that finds the page idle.
 */

/** How often the server is asked. */
export const POLL_INTERVAL_MS = 60_000;
/** Time given to the log line to reach the session log before the page goes. */
export const RELOAD_DELAY_MS = 200;
const VERSION_ENDPOINT = '/api/version';
const LOG_PREFIX = '[version-guard]';

/** What one check does about the version the server reported. */
export type GuardAction = 'nothing' | 'reload' | 'waiting-for-idle' | 'reload-on-idle';

/** The body of a `/api/version` response before it is checked: an object's field can hold anything. */
export interface UncheckedVersionReply {
  readonly version?: unknown;
}
/** Whatever JSON the server sent. */
export type VersionReply = UncheckedVersionReply | string | number | boolean | null;

/**
 * The version in a `/api/version` response: `{version: string}`. Anything
 * else reads as '', which a check treats like a request that failed.
 */
export const decodeServerVersion = (reply: VersionReply): string => {
  if (typeof reply !== 'object' || reply === null) return '';
  return typeof reply.version === 'string' ? reply.version : '';
};

/**
 * `window.KNState` as the guard reads it. The fields are other scripts' to
 * write, so none is taken at its word.
 */
export interface EngineStateView {
  readonly running?: unknown;
  readonly sessionStats?: object | null | undefined;
  readonly _syncLog?: ((line: string) => void) | undefined;
}

/**
 * A match is on: the engine set `KNState.running`, or the session has
 * counted frames. `state` is absent on pages with no engine.
 */
export const gameInProgress = (state: EngineStateView | null | undefined): boolean => {
  if (state?.running === true) return true;
  const stats = state?.sessionStats;
  if (!stats || !('frames' in stats)) return false;
  return typeof stats.frames === 'number' && stats.frames > 0;
};

/** Reloading now interrupts nobody: the tab is hidden, or no match is on. */
export const safeToReload = (hidden: boolean, inGame: boolean): boolean => hidden || !inGame;

/**
 * What a check does, given what the server said.
 *
 * - `nothing`: no answer, the versions agree, or this version was already
 *   logged and the page is still busy (or its reload is already on the way).
 * - `reload`: a version not logged before, and the page is idle.
 * - `waiting-for-idle`: a version not logged before, with a match on screen.
 * - `reload-on-idle`: a version logged earlier, and the page is idle now.
 *
 * Every action but `nothing` is logged; `reload` and `waiting-for-idle` also
 * make `serverVersion` the last logged version.
 */
export const guardAction = (
  pageVersion: string,
  serverVersion: string,
  lastLoggedVersion: string,
  safe: boolean,
  reloadScheduled: boolean,
): GuardAction => {
  if (serverVersion === '' || serverVersion === pageVersion) return 'nothing';
  if (serverVersion !== lastLoggedVersion) return safe ? 'reload' : 'waiting-for-idle';
  return safe && !reloadScheduled ? 'reload-on-idle' : 'nothing';
};

/** The line written to the console and the sync log. */
export const mismatchLine = (pageVersion: string, serverVersion: string, action: GuardAction): string =>
  `VERSION-MISMATCH page=${pageVersion} server=${serverVersion} action=${action}`;

/** The part of `window` the guard uses. */
export interface VersionGuardHost {
  readonly document: {
    readonly hidden: boolean;
    readonly querySelector: (selector: string) => { readonly getAttribute: (name: string) => string | null } | null;
  };
  readonly location: { href: string; readonly reload?: (() => void) | undefined };
  readonly console: { readonly warn: (message: string) => void };
  readonly fetch: (
    url: string,
    init: { cache: 'no-store'; credentials: 'same-origin' },
  ) => Promise<{ readonly ok: boolean; readonly json: () => Promise<VersionReply> }>;
  readonly setTimeout: (handler: () => void, ms: number) => void;
  readonly setInterval: (handler: () => void, ms: number) => void;
  readonly addEventListener: (type: string, listener: () => void) => void;
  /** The engine's state (kn-state.js); read for the match in progress and the sync log. */
  readonly KNState?: EngineStateView | undefined;
  /** The engine, when one is running; its `logSync` is preferred for the log line. */
  readonly KNLockstep?: { readonly logSync?: ((line: string) => void) | undefined } | undefined;
  /** The session timeline's reporter (shared.js). */
  readonly KNEvent?: ((type: string, message: string, meta: MismatchReport) => void) | undefined;
}

/** What the session timeline is told about a mismatch. */
export interface MismatchReport {
  readonly page_version: string;
  readonly server_version: string;
  readonly action: GuardAction;
}

/**
 * Start the guard on a page. Does nothing on a page served without the
 * version meta tag (a static copy, or older HTML): there is nothing to
 * compare the server against.
 */
export const startVersionGuard = (host: VersionGuardHost): void => {
  const pageVersion = host.document.querySelector('meta[name="kn-asset-version"]')?.getAttribute('content') || '';
  if (!pageVersion) return;

  let reloadScheduled = false;
  let lastLoggedVersion = '';

  const logMismatch = (serverVersion: string, action: GuardAction): void => {
    const line = mismatchLine(pageVersion, serverVersion, action);
    host.console.warn(`${LOG_PREFIX} ${line}`);
    // The sync log is what analyze_match.py reads from a session-log export.
    try {
      if (host.KNLockstep?.logSync) host.KNLockstep.logSync(line);
      else if (host.KNState?._syncLog) host.KNState._syncLog(line);
    } catch {
      /* a failing log must not stop the reload */
    }
    try {
      if (typeof host.KNEvent === 'function') {
        host.KNEvent('version_mismatch', line, {
          page_version: pageVersion,
          server_version: serverVersion,
          action,
        });
      }
    } catch {
      /* a failing report must not stop the reload */
    }
  };

  const isSafeToReload = (): boolean => {
    if (host.document.hidden) return true;
    let inGame = false;
    try {
      inGame = gameInProgress(host.KNState);
    } catch {
      /* state that cannot be read is not a match in progress */
    }
    return safeToReload(false, inGame);
  };

  const forceReload = (): void => {
    if (reloadScheduled) return;
    reloadScheduled = true;
    host.setTimeout(() => {
      // HTML is served no-store, so navigating to the same address also loads a fresh page.
      const navigateHere = (): void => {
        const href = host.location.href;
        host.location.href = href;
      };
      try {
        if (typeof host.location.reload === 'function') host.location.reload();
        else navigateHere();
      } catch {
        navigateHere();
      }
    }, RELOAD_DELAY_MS);
  };

  const checkVersion = async (): Promise<void> => {
    try {
      const response = await host.fetch(VERSION_ENDPOINT, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return;
      const serverVersion = decodeServerVersion(await response.json());
      if (serverVersion === '' || serverVersion === pageVersion) return;
      const action = guardAction(pageVersion, serverVersion, lastLoggedVersion, isSafeToReload(), reloadScheduled);
      if (action === 'nothing') return;
      if (action !== 'reload-on-idle') lastLoggedVersion = serverVersion;
      logMismatch(serverVersion, action);
      if (action !== 'waiting-for-idle') forceReload();
    } catch {
      /* the server is unreachable: the next check asks again */
    }
  };

  // A stale tab is caught as it loads, then once a minute, and when the
  // player comes back to it, which is when a stale tab is usually found.
  void checkVersion();
  host.setInterval(() => void checkVersion(), POLL_INTERVAL_MS);
  host.addEventListener('visibilitychange', () => {
    if (!host.document.hidden) void checkVersion();
  });
  host.addEventListener('focus', () => void checkVersion());
};
