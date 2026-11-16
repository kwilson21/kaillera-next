import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { startVersionGuard, type MismatchReport } from '../../web/src/site/version-guard.ts';

interface Page {
  /** Run the guard's version check as a regained focus does. */
  focus: () => Promise<void>;
  reloads: () => number;
  actions: string[];
}

/** A page on version "old" whose server now answers "new". */
const loadGuard = (state: { gameOn?: () => boolean } | undefined, hidden = false): Page => {
  const listeners = new Map<string, () => void>();
  const actions: string[] = [];
  let reloads = 0;
  startVersionGuard({
    KNState: state,
    KNEvent: (_type: string, _line: string, meta: MismatchReport) => actions.push(meta.action),
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    location: { reload: () => reloads++, href: '' },
    document: { hidden, querySelector: () => ({ getAttribute: () => 'old' }) },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 'new' }) }),
    console: { warn: () => undefined },
    setInterval: () => undefined,
    setTimeout: (fn: () => void) => fn(),
  });
  return {
    focus: async () => {
      listeners.get('focus')?.();
      // The check is a fetch and a json(), both already settled.
      for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    },
    reloads: () => reloads,
    actions,
  };
};

test('a visible page with a game on is not reloaded by a new version', async () => {
  const page = loadGuard({ gameOn: () => true });
  await page.focus();
  await page.focus();
  assert.equal(page.reloads(), 0);
  assert.equal(page.actions[0], 'waiting-for-idle');
});

test('the page is reloaded once its game is over', async () => {
  let on = true;
  const page = loadGuard({ gameOn: () => on });
  await page.focus();
  assert.equal(page.reloads(), 0);
  on = false;
  await page.focus();
  assert.equal(page.reloads(), 1);
  assert.ok(page.actions.includes('reload-on-idle'));
});

test('a page with no game, or no page state at all, is reloaded', async () => {
  for (const state of [{ gameOn: () => false }, {}, undefined]) {
    const page = loadGuard(state);
    await page.focus();
    assert.equal(page.reloads(), 1);
  }
});

test('the play page publishes its session machine as KNState.gameOn', () => {
  const play = readFileSync(new URL('../../web/static/play.js', import.meta.url), 'utf8');
  assert.match(
    play,
    /const isGameRunning = \(\) => _session\?\.gameOn\(\) \?\? false;\n\s*KNState\.gameOn = isGameRunning;/,
  );
});
