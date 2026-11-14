/**
 * localStorage and sessionStorage that keep working when the browser blocks
 * them. Moved from web/static/storage.js.
 *
 * Brave on a phone, and other privacy browsers, throw on any use of the
 * storage APIs. A blocked store is replaced by a map in memory: what a page
 * saves lasts until it is closed, which is what the browser's setting asked
 * for.
 */
import type { SafeStorage } from '../kn-state.ts';

export type StoreName = 'localStorage' | 'sessionStorage';

/** The part of `window` the helpers use. */
export type StorageHost = { readonly [store in StoreName]: Storage };

const PROBE_KEY = '__kn__';

/** Whether a store takes a write. Reading `host[store]` can itself throw. */
const usable = (host: StorageHost, store: StoreName): boolean => {
  try {
    host[store].setItem(PROBE_KEY, '1');
    host[store].removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
};

/** Each store is probed once, here; a store that fails the probe is in memory for the life of the page. */
export const createSafeStorage = (host: StorageHost): SafeStorage => {
  const memory = new Map<string, string>();
  const ok: Record<StoreName, boolean> = {
    localStorage: usable(host, 'localStorage'),
    sessionStorage: usable(host, 'sessionStorage'),
  };
  return {
    get: (store, key) => (ok[store] ? host[store].getItem(key) : (memory.get(`${store}:${key}`) ?? null)),
    set: (store, key, value) => {
      if (ok[store]) host[store].setItem(key, value);
      else memory.set(`${store}:${key}`, value);
    },
    remove: (store, key) => {
      if (ok[store]) host[store].removeItem(key);
      else memory.delete(`${store}:${key}`);
    },
  };
};

declare global {
  interface Window {
    KNStorage?: SafeStorage;
  }
}

/** Put the helpers on the page as `window.KNStorage`, where the plain scripts read them. */
export const installSafeStorage = (): void => {
  window.KNStorage = createSafeStorage(window);
};
