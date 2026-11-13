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

interface StateCore {
  initialKNState: typeof initialKNState;
}
interface StateWindow {
  KNState?: PageState;
  KNCore?: StateCore;
}

/** `window.KNState` as web/static/kn-state.js sets it up. */
const loadState = (storage: SafeStorage, core?: StateCore): PageState => {
  const source = readFileSync(new URL('../../web/static/kn-state.js', import.meta.url), 'utf8');
  const window: StateWindow = {};
  if (core) window.KNCore = core;
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

test('kn-state.js takes the state from KNCore when the bundle is loaded', () => {
  let calls = 0;
  const storage = memoryStorage();
  const state = loadState(storage, {
    initialKNState: (given) => {
      calls++;
      return initialKNState(given);
    },
  });
  assert.equal(calls, 1);
  assert.equal(state.slot, -1);
  state.safeSet('localStorage', 'k', 'v');
  assert.equal(state.safeGet('localStorage', 'k'), 'v');
  state.safeRemove('localStorage', 'k');
  assert.equal(state.safeGet('localStorage', 'k'), null);
  assert.deepEqual(storage.calls, [
    'set localStorage k',
    'get localStorage k',
    'remove localStorage k',
    'get localStorage k',
  ]);
});

test('the storage helpers go to the storage either way', () => {
  for (const core of [undefined, { initialKNState }]) {
    const storage = memoryStorage();
    const state = loadState(storage, core);
    state.safeSet('sessionStorage', 'a', '1');
    assert.equal(state.safeGet('sessionStorage', 'a'), '1');
    assert.deepEqual(storage.calls, ['set sessionStorage a', 'get sessionStorage a']);
  }
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
