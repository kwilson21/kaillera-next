import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/static/version-guard.js', import.meta.url), 'utf8');

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
  const window = {
    KNState: state,
    KNEvent: (_type: string, _line: string, meta: { action: string }) => actions.push(meta.action),
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    location: { reload: () => reloads++, href: '' },
  };
  const context = vm.createContext({
    window,
    document: { hidden, querySelector: () => ({ getAttribute: () => 'old' }) },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 'new' }) }),
    console: { warn: () => undefined },
    setInterval: () => 0,
    setTimeout: (fn: () => void) => fn(),
  });
  vm.runInContext(source, context);
  return {
    focus: async () => {
      await listeners.get('focus')?.();
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
