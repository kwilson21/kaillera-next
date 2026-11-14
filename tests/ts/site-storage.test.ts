import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSafeStorage, type StorageHost, type StoreName } from '../../web/src/site/storage.ts';

/** A Storage that works, or one that throws on every use the way a blocked store does. */
const fakeStore = (blocked: boolean): Storage & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>();
  const refuse = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return {
    values,
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => (blocked ? refuse() : (values.get(key) ?? null)),
    setItem: (key, value) => {
      if (blocked) refuse();
      values.set(key, value);
    },
    removeItem: (key) => {
      if (blocked) refuse();
      values.delete(key);
    },
  };
};

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/storage.js as of #166, with `window` as a parameter.
const oldStorage = (win: StorageHost) => {
  const mem = new Map<string, string>();
  const canUse = (store: StoreName) => {
    try {
      const k = '__kn__';
      win[store].setItem(k, '1');
      win[store].removeItem(k);
      return true;
    } catch {
      return false;
    }
  };
  const ok = { localStorage: canUse('localStorage'), sessionStorage: canUse('sessionStorage') };
  return {
    get: (store: StoreName, key: string) =>
      ok[store] ? win[store].getItem(key) : (mem.get(`${store}:${key}`) ?? null),
    set: (store: StoreName, key: string, val: string) =>
      ok[store] ? win[store].setItem(key, val) : mem.set(`${store}:${key}`, val),
    remove: (store: StoreName, key: string) => (ok[store] ? win[store].removeItem(key) : mem.delete(`${store}:${key}`)),
  };
};

const STORES: readonly StoreName[] = ['localStorage', 'sessionStorage'];

test('reads, writes and removals match the old script, with either store blocked', () => {
  let compared = 0;
  for (const localBlocked of [false, true]) {
    for (const sessionBlocked of [false, true]) {
      const oldHost = { localStorage: fakeStore(localBlocked), sessionStorage: fakeStore(sessionBlocked) };
      const newHost = { localStorage: fakeStore(localBlocked), sessionStorage: fakeStore(sessionBlocked) };
      const old = oldStorage(oldHost);
      const next = createSafeStorage(newHost);
      const same = (): void => {
        for (const store of STORES) {
          for (const key of ['a', 'b', 'missing']) {
            assert.equal(next.get(store, key), old.get(store, key));
            compared++;
          }
          assert.deepEqual([...newHost[store].values], [...oldHost[store].values]);
        }
      };
      same();
      for (const store of STORES) {
        old.set(store, 'a', `${store}-1`);
        next.set(store, 'a', `${store}-1`);
        old.set(store, 'b', '2');
        next.set(store, 'b', '2');
      }
      same();
      for (const store of STORES) {
        old.remove(store, 'a');
        next.remove(store, 'a');
      }
      same();
    }
  }
  assert.equal(compared, 4 * 3 * 2 * 3);
});

test('a blocked store keeps what the page saved, in memory, apart from the other store', () => {
  const host = { localStorage: fakeStore(true), sessionStorage: fakeStore(false) };
  const storage = createSafeStorage(host);
  storage.set('localStorage', 'name', 'Fox');
  storage.set('sessionStorage', 'name', 'Falco');
  assert.equal(storage.get('localStorage', 'name'), 'Fox');
  assert.equal(storage.get('sessionStorage', 'name'), 'Falco');
  assert.equal(host.sessionStorage.values.get('name'), 'Falco');
  storage.remove('localStorage', 'name');
  assert.equal(storage.get('localStorage', 'name'), null);
});

test('the probe leaves nothing behind in a store that works', () => {
  const host = { localStorage: fakeStore(false), sessionStorage: fakeStore(false) };
  createSafeStorage(host);
  assert.equal(host.localStorage.values.size, 0);
  assert.equal(host.sessionStorage.values.size, 0);
});

test('a window whose storage property itself throws is treated as blocked', () => {
  const host: StorageHost = {
    get localStorage(): Storage {
      throw new DOMException('denied', 'SecurityError');
    },
    sessionStorage: fakeStore(false),
  };
  const storage = createSafeStorage(host);
  storage.set('localStorage', 'k', 'v');
  assert.equal(storage.get('localStorage', 'k'), 'v');
});
