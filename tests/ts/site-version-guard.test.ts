import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  decodeServerVersion,
  gameInProgress,
  guardAction,
  POLL_INTERVAL_MS,
  RELOAD_DELAY_MS,
  safeToReload,
  startVersionGuard,
  type GuardAction,
  type MismatchReport,
  type VersionGuardHost,
  type VersionReply,
} from '../../web/src/site/version-guard.ts';

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/version-guard.js as of #166, unchanged.
const OLD_SCRIPT = `/*
 * Version-mismatch force-reload guard
 * ───────────────────────────────────
 *
 * Every HTML response has a \`<meta name="kn-asset-version">\` tag injected
 * by CacheBustMiddleware that carries the server's asset-version tag at
 * page load time. This module polls \`/api/version\` at startup and
 * periodically, and if the server's current version differs from what the
 * page was loaded with, it logs a VERSION-MISMATCH event (to the console,
 * the session log if available, and the feedback telemetry path) and
 * force-reloads the page with cache bypass.
 *
 * The meta-tag approach (vs an inline <script>) is required so the strict
 * CSP (script-src 'self') on non-/play.html routes doesn't block the value.
 *
 * Why this exists: local testing repeatedly hit cases where a browser tab
 * held a cached netplay-lockstep.js from before a fix landed, silently
 * running stale code and re-triggering a bug the code on disk had already
 * fixed. The \`?v=\` query-param cache-bust in HTML is necessary but
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

  const _meta = document.querySelector('meta[name="kn-asset-version"]');
  const pageLoadedVersion = _meta?.getAttribute('content') || '';
  if (!pageLoadedVersion) {
    // Nothing to compare against — older HTML, static-served pages, or
    // injection failed. The guard is a deploy-staleness detector, not a
    // correctness check; silently no-op rather than spam console.warn on
    // every page load where the meta isn't present.
    return;
  }

  let _reloadScheduled = false;
  let _lastLoggedVersion = '';

  const _logMismatch = (serverVersion, action) => {
    const line = \`VERSION-MISMATCH page=\${pageLoadedVersion} server=\${serverVersion} action=\${action}\`;
    console.warn(\`\${LOG_PREFIX} \${line}\`);
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
      // Force a network-cache-bypassing reload. \`location.reload(true)\`
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
`;

/** What the server answers to one `/api/version` request; `json` is the body's text. */
type Answer =
  | { readonly kind: 'down' }
  | { readonly kind: 'status' }
  | { readonly kind: 'json'; readonly json: string };

/** A JSON body as the page gets it from `response.json()`. */
const parseReply = (json: string): VersionReply => JSON.parse(json);

/** The engine state a page can have, as the guard reads it. */
interface EngineState {
  running?: boolean;
  sessionStats?: { frames?: number };
  _syncLog?: (line: string) => void;
}

/** Whether the page has `location.reload`, and whether it works. */
type ReloadKind = 'works' | 'throws' | 'missing';

interface FakeLocation {
  href: string;
  reload?: () => void;
}

/** The fake page's window: the guard's host, with the globals a test may set. */
interface FakeWindow extends VersionGuardHost {
  KNState?: EngineState;
  KNLockstep?: { logSync: (line: string) => void };
  KNEvent?: (type: string, message: string, meta: MismatchReport) => void;
}

/** A page both versions run on, recording everything they do to it. */
const fakePage = (metaVersion: string | null, reload: ReloadKind = 'works') => {
  const trace: string[] = [];
  const listeners = new Map<string, () => void>();
  const timeouts: { readonly run: () => void; readonly ms: number }[] = [];
  const intervals: { readonly run: () => void; readonly ms: number }[] = [];
  const answers: Answer[] = [{ kind: 'down' }];
  const flags = { hidden: false };
  const location: FakeLocation = {
    get href() {
      return '/play.html?room=AB12';
    },
    set href(value: string) {
      trace.push(`href=${value}`);
    },
  };
  if (reload !== 'missing') {
    location.reload = () => {
      trace.push('reload()');
      if (reload === 'throws') throw new Error('reload refused');
    };
  }
  const window: FakeWindow = {
    document: {
      get hidden() {
        return flags.hidden;
      },
      querySelector: (selector) => {
        assert.equal(selector, 'meta[name="kn-asset-version"]');
        return metaVersion === null ? null : { getAttribute: (name) => (name === 'content' ? metaVersion : null) };
      },
    },
    location,
    console: { warn: (message) => trace.push(`warn ${message}`) },
    fetch: (url, init) => {
      trace.push(`fetch ${url} ${JSON.stringify(init)}`);
      const answer = answers.at(-1) ?? { kind: 'down' };
      if (answer.kind === 'down') return Promise.reject(new TypeError('Failed to fetch'));
      if (answer.kind === 'status') return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(parseReply(answer.json)) });
    },
    setTimeout: (run, ms) => {
      timeouts.push({ run, ms });
    },
    setInterval: (run, ms) => {
      intervals.push({ run, ms });
    },
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
  };
  return {
    trace,
    listeners,
    timeouts,
    intervals,
    window,
    /** What the server answers from now on. */
    setAnswer: (answer: Answer): void => {
      answers.push(answer);
    },
    hidden: (): boolean => flags.hidden,
    setHidden: (hidden: boolean): void => {
      flags.hidden = hidden;
    },
  };
};

type Page = ReturnType<typeof fakePage>;

/** The old script on a page: its globals are the page's. */
const startOld = (page: Page): void => {
  const { window } = page;
  vm.runInNewContext(OLD_SCRIPT, {
    window,
    document: window.document,
    fetch: window.fetch,
    setTimeout: window.setTimeout,
    setInterval: window.setInterval,
    console: window.console,
  });
};

/** Let the checks in flight finish: each is a fetch and a json(), both already settled. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A small deterministic generator, so a failing sequence can be found again from its seed. */
const rng = (seed: number) => {
  let s = seed >>> 0;
  return (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 0x1_0000_0000) * n);
  };
};

const ANSWERS: readonly Answer[] = [
  { kind: 'down' },
  { kind: 'status' },
  { kind: 'json', json: 'null' },
  { kind: 'json', json: '{}' },
  { kind: 'json', json: '{"version":""}' },
  { kind: 'json', json: '{"version":"v1"}' },
  { kind: 'json', json: '{"version":"v2"}' },
  { kind: 'json', json: '{"version":"v2"}' },
  { kind: 'json', json: '{"version":"v3"}' },
];

/** One thing that happens to a page between checks. */
const step = (page: Page, pick: (n: number) => number): string => {
  const kind = pick(9);
  if (kind === 0) {
    page.setHidden(!page.hidden());
    return `hidden=${page.hidden()}`;
  }
  if (kind === 1) {
    const frames = [0, 0, 120][pick(3)] ?? 0;
    const running = pick(2) === 0;
    page.window.KNState = { ...page.window.KNState, running, sessionStats: { frames } };
    return `state running=${running} frames=${frames}`;
  }
  if (kind === 2) {
    const answer = ANSWERS[pick(ANSWERS.length)] ?? { kind: 'down' };
    page.setAnswer(answer);
    return `answer ${JSON.stringify(answer)}`;
  }
  if (kind === 3) {
    for (const timeout of page.timeouts.splice(0)) timeout.run();
    return 'timeouts';
  }
  if (kind === 4) {
    page.listeners.get('focus')?.();
    return 'focus';
  }
  if (kind === 5) {
    page.listeners.get('visibilitychange')?.();
    return 'visibilitychange';
  }
  for (const interval of page.intervals) interval.run();
  return 'interval';
};

/** How a page's logging globals are set up for a run. */
type Loggers = 'none' | 'lockstep' | 'syncLog' | 'both' | 'throwing';

const addLoggers = (page: Page, loggers: Loggers): void => {
  const { window, trace } = page;
  if (loggers === 'none') return;
  if (loggers === 'throwing') {
    window.KNLockstep = {
      logSync: () => {
        throw new Error('log full');
      },
    };
    window.KNEvent = () => {
      throw new Error('no socket');
    };
    return;
  }
  if (loggers === 'lockstep' || loggers === 'both') {
    window.KNLockstep = { logSync: (line: string) => trace.push(`logSync ${line}`) };
  }
  if (loggers === 'syncLog' || loggers === 'both') {
    window.KNState = { ...window.KNState, _syncLog: (line: string) => trace.push(`_syncLog ${line}`) };
  }
  window.KNEvent = (...args: unknown[]) => trace.push(`KNEvent ${JSON.stringify(args)}`);
};

test('everything the guard does to a page matches the old script, over random sequences', async () => {
  const loggerKinds: readonly Loggers[] = ['none', 'lockstep', 'syncLog', 'both', 'throwing'];
  const reloadKinds = ['works', 'throws', 'missing'] as const;
  let reloads = 0;
  let waits = 0;
  let idleReloads = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const pick = rng(seed);
    const loggers = loggerKinds[seed % loggerKinds.length] ?? 'none';
    const reload = reloadKinds[seed % reloadKinds.length] ?? 'works';
    const first = ANSWERS[pick(ANSWERS.length)] ?? { kind: 'down' };
    const pages = [fakePage('v1', reload), fakePage('v1', reload)] as const;
    const pickers = [rng(seed * 7919), rng(seed * 7919)] as const;
    for (const page of pages) {
      page.setAnswer(first);
      // Half the pages load with a match already on.
      if (seed % 2 === 0) page.window.KNState = { running: true };
      addLoggers(page, loggers);
    }
    startOld(pages[0]);
    startVersionGuard(pages[1].window);
    await settle();
    const script: string[] = [];
    for (let i = 0; i < 25; i++) {
      script.push(step(pages[0], pickers[0]));
      step(pages[1], pickers[1]);
      await settle();
      assert.deepEqual(pages[1].trace, pages[0].trace, `seed ${seed} after ${script.join(' | ')}`);
      assert.deepEqual(
        pages[1].timeouts.map((t) => t.ms),
        pages[0].timeouts.map((t) => t.ms),
      );
    }
    assert.deepEqual([...pages[1].listeners.keys()], [...pages[0].listeners.keys()]);
    assert.deepEqual(
      pages[1].intervals.map((t) => t.ms),
      pages[0].intervals.map((t) => t.ms),
    );
    const text = pages[1].trace.join('\n');
    if (text.includes('action=reload\n') || text.endsWith('action=reload')) reloads++;
    if (text.includes('action=waiting-for-idle')) waits++;
    if (text.includes('action=reload-on-idle')) idleReloads++;
  }
  // The sequences reach every action, so the comparison above is not vacuous.
  assert.ok(reloads > 20, `reload seen in ${reloads} runs`);
  assert.ok(waits > 20, `waiting-for-idle seen in ${waits} runs`);
  assert.ok(idleReloads > 5, `reload-on-idle seen in ${idleReloads} runs`);
});

test('a page without the version meta tag is left alone, as before', async () => {
  for (const meta of [null, '']) {
    const pages = [fakePage(meta), fakePage(meta)] as const;
    for (const page of pages) page.setAnswer({ kind: 'json', json: '{"version":"v2"}' });
    startOld(pages[0]);
    startVersionGuard(pages[1].window);
    await settle();
    for (const page of pages) {
      assert.deepEqual(page.trace, []);
      assert.equal(page.intervals.length, 0);
      assert.equal(page.listeners.size, 0);
    }
  }
});

test('an idle page with a newer server logs once and reloads after the delay', async () => {
  const page = fakePage('v1');
  page.setAnswer({ kind: 'json', json: '{"version":"v2"}' });
  const events: unknown[][] = [];
  page.window.KNEvent = (...args: unknown[]) => events.push(args);
  startVersionGuard(page.window);
  await settle();
  assert.deepEqual(page.trace, [
    'fetch /api/version {"cache":"no-store","credentials":"same-origin"}',
    'warn [version-guard] VERSION-MISMATCH page=v1 server=v2 action=reload',
  ]);
  assert.deepEqual(events, [
    [
      'version_mismatch',
      'VERSION-MISMATCH page=v1 server=v2 action=reload',
      { page_version: 'v1', server_version: 'v2', action: 'reload' },
    ],
  ]);
  assert.deepEqual(
    page.timeouts.map((t) => t.ms),
    [RELOAD_DELAY_MS],
  );
  assert.deepEqual(
    page.intervals.map((t) => t.ms),
    [POLL_INTERVAL_MS],
  );
  // Later checks before the reload fires neither log nor schedule again.
  page.intervals[0]?.run();
  page.listeners.get('focus')?.();
  await settle();
  assert.equal(page.timeouts.length, 1);
  assert.equal(page.trace.filter((line) => line.startsWith('warn')).length, 1);
  page.timeouts[0]?.run();
  assert.equal(page.trace.at(-1), 'reload()');
});

test('a player in a match is not reloaded until the match is over or the tab is hidden', async () => {
  for (const release of ['matchEnds', 'tabHidden'] as const) {
    const page = fakePage('v1');
    page.setAnswer({ kind: 'json', json: '{"version":"v2"}' });
    page.window.KNState = { running: true };
    startVersionGuard(page.window);
    await settle();
    page.intervals[0]?.run();
    await settle();
    assert.deepEqual(
      page.trace.filter((line) => line.startsWith('warn')),
      ['warn [version-guard] VERSION-MISMATCH page=v1 server=v2 action=waiting-for-idle'],
    );
    assert.equal(page.timeouts.length, 0);
    if (release === 'matchEnds') page.window.KNState = { running: false };
    else page.setHidden(true);
    page.intervals[0]?.run();
    await settle();
    assert.equal(page.trace.at(-1), 'warn [version-guard] VERSION-MISMATCH page=v1 server=v2 action=reload-on-idle');
    assert.equal(page.timeouts.length, 1);
  }
});

test('coming back to the tab checks; hiding it does not', async () => {
  const page = fakePage('v1');
  page.setAnswer({ kind: 'json', json: '{"version":"v1"}' });
  startVersionGuard(page.window);
  await settle();
  const fetches = (): number => page.trace.filter((line) => line.startsWith('fetch')).length;
  assert.equal(fetches(), 1);
  page.setHidden(true);
  page.listeners.get('visibilitychange')?.();
  assert.equal(fetches(), 1);
  page.setHidden(false);
  page.listeners.get('visibilitychange')?.();
  assert.equal(fetches(), 2);
});

test('a response off its shape is ignored like a failed request', async () => {
  for (const json of [
    '5',
    '"v2"',
    '[]',
    'true',
    '{"version":5}',
    '{"version":null}',
    '{"version":["v2"]}',
    '{"Version":"v2"}',
  ]) {
    assert.equal(decodeServerVersion(parseReply(json)), '');
    const page = fakePage('v1');
    page.setAnswer({ kind: 'json', json });
    startVersionGuard(page.window);
    await settle();
    assert.equal(page.trace.length, 1, json);
    assert.equal(page.timeouts.length, 0);
  }
  assert.equal(decodeServerVersion(parseReply('{"version":"v2","extra":1}')), 'v2');
});

// ── the decisions, against the old code's own ────────────────────────────────

/** `_gameInProgress` of web/static/version-guard.js as of #166, with `window.KNState` as a parameter. */
const oldGameInProgress = (state: EngineState | null | undefined): boolean => {
  try {
    if (state?.running === true) return true;
    const stats = state?.sessionStats;
    if (stats && typeof stats.frames === 'number' && stats.frames > 0) {
      return true;
    }
  } catch {
    /* as the old code: unreadable state is no game */
  }
  return false;
};

/**
 * The branch of `_checkVersion` of web/static/version-guard.js as of #166
 * that follows a successful response, as the action it logged ('nothing'
 * when it logged none).
 */
const oldAction = (
  page: string,
  server: string,
  lastLogged: string,
  safe: boolean,
  scheduled: boolean,
): GuardAction => {
  if (!server) return 'nothing';
  if (server === page) return 'nothing';
  if (server !== lastLogged) {
    if (safe) return 'reload';
    return 'waiting-for-idle';
  } else if (safe && !scheduled) {
    return 'reload-on-idle';
  }
  return 'nothing';
};

test('guardAction agrees with the old branch for every input', () => {
  const versions = ['', 'v1', 'v2', 'v3'];
  let compared = 0;
  for (const page of versions.slice(1)) {
    for (const server of versions) {
      for (const lastLogged of versions) {
        for (const safe of [false, true]) {
          for (const scheduled of [false, true]) {
            assert.equal(
              guardAction(page, server, lastLogged, safe, scheduled),
              oldAction(page, server, lastLogged, safe, scheduled),
            );
            compared++;
          }
        }
      }
    }
  }
  assert.equal(compared, 3 * 4 * 4 * 2 * 2);
});

test('gameInProgress and safeToReload agree with the old code', () => {
  const states: readonly (EngineState | null | undefined)[] = [
    undefined,
    null,
    {},
    { running: true },
    { running: false },
    { sessionStats: {} },
    { sessionStats: { frames: 0 } },
    { sessionStats: { frames: 1 } },
    { running: false, sessionStats: { frames: 9000 } },
    { running: true, sessionStats: { frames: 0 } },
    { sessionStats: { frames: Number.NaN } },
    { sessionStats: { frames: -1 } },
  ];
  for (const state of states) {
    assert.equal(gameInProgress(state), oldGameInProgress(state), JSON.stringify(state));
    for (const hidden of [false, true]) {
      // _safeToReload of the old script: `if (document.hidden) return true; return !_gameInProgress();`
      const old = hidden ? true : !oldGameInProgress(state);
      assert.equal(safeToReload(hidden, gameInProgress(state)), old);
    }
  }
  // A value that is not the engine's state at all is no game.
  for (const junk of [{ running: 'yes' }, { running: 1 }, { sessionStats: { frames: '12' } }, { sessionStats: [] }]) {
    assert.equal(gameInProgress(junk), false);
  }
});

test('a real window is a host the guard accepts', () => {
  // The caller in web/static is plain script, so the compiler checks the fit here.
  const fits: typeof window extends VersionGuardHost ? true : false = true;
  assert.ok(fits);
});
