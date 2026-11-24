import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  decodeServerVersion,
  gameInProgress,
  guardAction,
  POLL_INTERVAL_MS,
  RELOAD_DELAY_MS,
  startVersionGuard,
  type GuardAction,
  type MismatchReport,
  type VersionGuardHost,
  type VersionReply,
} from '../../web/src/site/version-guard.ts';

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/version-guard.js as of #182, unchanged.
const OLD_SCRIPT = readFileSync(new URL('./fixtures/version-guard.old.js', import.meta.url), 'utf8');

/** What the server answers to one `/api/version` request; `json` is the body's text. */
type Answer =
  | { readonly kind: 'down' }
  | { readonly kind: 'status' }
  | { readonly kind: 'json'; readonly json: string };

/** A JSON body as the page gets it from `response.json()`. */
const parseReply = (json: string): VersionReply => JSON.parse(json);

/**
 * The shared state a page can have. `gameOn` is what the guard reads; the
 * sync log is there to show neither version writes to it any more.
 */
interface EngineState {
  gameOn?: () => boolean;
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
    const answer = ['on', 'off', 'absent', 'throws'][pick(4)] ?? 'off';
    const { gameOn: _dropped, ...rest } = page.window.KNState ?? {};
    if (answer === 'absent') page.window.KNState = rest;
    else if (answer === 'throws') {
      page.window.KNState = {
        ...rest,
        gameOn: () => {
          throw new Error('machine stopped');
        },
      };
    } else page.window.KNState = { ...rest, gameOn: () => answer === 'on' };
    return `state gameOn=${answer}`;
  }
  if (kind === 2) {
    const answer = ANSWERS[pick(ANSWERS.length)] ?? { kind: 'down' };
    page.setAnswer(answer);
    return `answer ${JSON.stringify(answer)}`;
  }
  // Compare the old and new implementations on their common behavior. The
  // two intentional differences have their own timer and hidden-tab tests.
  if (oldGameInProgress(page.window.KNState)) {
    if (kind === 3 && page.timeouts.length) return 'hold timer until idle';
    if (kind >= 4 && kind !== 5 && page.hidden()) return 'hold hidden match poll';
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

test('unaffected version checks match the old script over random sequences', async () => {
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
      if (seed % 2 === 0) page.window.KNState = { gameOn: () => true };
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

test('a running match waits for its end even when its tab is hidden', async () => {
  const page = fakePage('v1');
  page.setAnswer({ kind: 'json', json: '{"version":"v2"}' });
  page.window.KNState = { gameOn: () => true };
  page.setHidden(true);
  startVersionGuard(page.window);
  await settle();
  assert.equal(page.trace.at(-1), 'warn [version-guard] VERSION-MISMATCH page=v1 server=v2 action=waiting-for-idle');
  page.intervals[0]?.run();
  await settle();
  assert.equal(page.timeouts.length, 0);
  page.window.KNState = { gameOn: () => false };
  page.intervals[0]?.run();
  await settle();
  assert.equal(page.trace.at(-1), 'warn [version-guard] VERSION-MISMATCH page=v1 server=v2 action=reload-on-idle');
  assert.equal(page.timeouts.length, 1);
  page.timeouts[0]?.run();
  assert.equal(page.trace.at(-1), 'reload()');
});

test('a game that starts during the reload delay can finish before the page reloads', async () => {
  const page = fakePage('v1');
  page.setAnswer({ kind: 'json', json: '{"version":"v2"}' });
  startVersionGuard(page.window);
  await settle();
  assert.equal(page.timeouts.length, 1);
  page.window.KNState = { gameOn: () => true };
  page.timeouts.shift()?.run();
  page.intervals[0]?.run();
  await settle();
  assert.ok(!page.trace.includes('reload()'));
  assert.equal(page.timeouts.length, 0);
  page.window.KNState = { gameOn: () => false };
  page.intervals[0]?.run();
  await settle();
  assert.equal(page.timeouts.length, 1);
  page.timeouts[0]?.run();
  assert.equal(page.trace.at(-1), 'reload()');
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

/** `_gameInProgress` of web/static/version-guard.js as of #182, with `window.KNState` as a parameter. */
const oldGameInProgress = (state: EngineState | null | undefined): boolean => {
  try {
    return state?.gameOn?.() === true;
  } catch {
    return false;
  }
};

/**
 * The branch of `_checkVersion` of web/static/version-guard.js as of #182
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

test('gameInProgress agrees with the old code', () => {
  const states: readonly (EngineState | null | undefined)[] = [
    undefined,
    null,
    {},
    { gameOn: () => true },
    { gameOn: () => false },
    {
      gameOn: () => {
        throw new Error('machine stopped');
      },
    },
  ];
  for (const state of states) {
    assert.equal(gameInProgress(state), oldGameInProgress(state));
  }
  // Only the answer `true` is a match: an answer of another kind is not.
  for (const answer of ['yes', 1, {}, null, undefined]) {
    assert.equal(gameInProgress({ gameOn: () => answer }), false);
  }
});

// ── the caller left in web/static ────────────────────────────────────────────

const CALLER = readFileSync(new URL('../../web/static/version-guard.js', import.meta.url), 'utf8');

test('the caller starts the guard at once when its bundle has run', () => {
  const started: string[] = [];
  const listeners = new Map<string, () => void>();
  const window = {
    KNSite: { startVersionGuard: () => started.push('start') },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  };
  vm.runInNewContext(CALLER, { window });
  assert.deepEqual(started, ['start']);
  assert.equal(listeners.size, 0);
});

/** A page as the caller sees it before its bundle has run. */
interface LatePage {
  KNSite?: { startVersionGuard: () => void };
  addEventListener: (type: string, listener: () => void) => void;
}

test('on a page that loads the bundle after the caller, the guard starts once the scripts have run', () => {
  // HTML from before the script order changed, with this deploy's scripts.
  const starts = { count: 0 };
  const listeners = new Map<string, () => void>();
  const window: LatePage = { addEventListener: (type, listener) => listeners.set(type, listener) };
  vm.runInNewContext(CALLER, { window });
  assert.equal(starts.count, 0);
  window.KNSite = { startVersionGuard: () => starts.count++ };
  listeners.get('DOMContentLoaded')?.();
  assert.equal(starts.count, 1);
});

test('a page whose bundle never arrives is left alone', () => {
  const listeners = new Map<string, () => void>();
  const window = { addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) };
  vm.runInNewContext(CALLER, { window });
  assert.doesNotThrow(() => listeners.get('DOMContentLoaded')?.());
});

test('a real window is a host the guard accepts', () => {
  // The caller in web/static is plain script, so the compiler checks the fit here.
  const fits: typeof window extends VersionGuardHost ? true : false = true;
  assert.ok(fits);
});
