import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { initialKNState, type PageState, type SafeStorage } from '../../web/src/kn-state.ts';
import { plain } from './load-shared.ts';

const memoryStorage = (): SafeStorage & { calls: string[] } => {
  const values = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    get: (store, key) => {
      calls.push(`get ${store} ${key}`);
      return values.get(`${store}:${key}`) ?? null;
    },
    set: (store, key, value) => {
      calls.push(`set ${store} ${key}`);
      values.set(`${store}:${key}`, value);
    },
    remove: (store, key) => {
      calls.push(`remove ${store} ${key}`);
      values.delete(`${store}:${key}`);
    },
  };
};

interface StateWindow {
  KNState?: PageState;
}

/** `window.KNState` as web/static/kn-state.js sets it up. */
const loadState = (storage: SafeStorage): PageState => {
  const source = readFileSync(new URL('../../web/static/kn-state.js', import.meta.url), 'utf8');
  const window: StateWindow = {};
  vm.runInContext(source, vm.createContext({ window, KNStorage: storage }));
  assert.ok(window.KNState, 'kn-state.js did not define window.KNState');
  return window.KNState;
};

/** The fields that are data, without the storage functions. */
const dataOf = (state: PageState): Record<string, string> =>
  Object.fromEntries(
    Object.entries(plain(JSON.parse(JSON.stringify(state)))).map(([key, value]) => [key, JSON.stringify(value)]),
  );

test('the state built into kn-state.js and the typed one are the same', () => {
  const builtIn = loadState(memoryStorage());
  const typed = initialKNState(memoryStorage());
  assert.deepEqual(Object.keys(builtIn).sort(), Object.keys(typed).sort());
  assert.deepEqual(dataOf(builtIn), dataOf(typed));
  assert.equal(typed.slot, -1);
  assert.equal(typed.delayAutoValue, 2);
  assert.deepEqual(typed.DEFAULT_ICE_SERVERS, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
});

test('the storage helpers go to the storage in both', () => {
  for (const build of [loadState, initialKNState]) {
    const storage = memoryStorage();
    const state = build(storage);
    state.safeSet('sessionStorage', 'a', '1');
    assert.equal(state.safeGet('sessionStorage', 'a'), '1');
    state.safeRemove('sessionStorage', 'a');
    assert.equal(state.safeGet('sessionStorage', 'a'), null);
    assert.deepEqual(storage.calls, [
      'set sessionStorage a',
      'get sessionStorage a',
      'remove sessionStorage a',
      'get sessionStorage a',
    ]);
  }
});

test('a peer without a data channel yet fits the type', () => {
  const state = initialKNState(memoryStorage());
  // createBasePeer in shared.js starts every peer with `dc: null`.
  state.peers['sid'] = { slot: 1, dc: null };
  assert.equal(state.peers['sid']?.dc ?? null, null); // play.js sets the slot to null for a spectator.
  state.slot = null;
  assert.equal(state.slot, null);
});

test('every page gets its own state objects', () => {
  const storage = memoryStorage();
  const a = initialKNState(storage);
  const b = initialKNState(storage);
  a.sessionStats.reconnects = 3;
  a.touchInput['4'] = 1;
  a.peers['sid'] = { slot: 0 };
  assert.equal(b.sessionStats.reconnects, 0);
  assert.deepEqual(b.touchInput, {});
  assert.deepEqual(b.peers, {});
});
