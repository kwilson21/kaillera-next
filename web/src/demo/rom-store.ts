/**
 * The demo's ROM cache: the last ROM dropped on the demo page, kept in
 * IndexedDB so that Reset (a page reload) comes back into a running engine
 * instead of the drop-ROM screen. Stop clears it, so the next visit starts
 * from the drop screen. Moved from web/static/demo.js unchanged in
 * behaviour; demo.js still decides when to save, load and clear.
 *
 * One record, the ROM's bytes and its file name, under one key. Every call
 * settles and none rejects: a browser without IndexedDB, or one that refuses
 * it, saves nothing and loads nothing, as before.
 *
 * As before, clearing opens the database without creating its store. Run on
 * a browser that never saved, it would leave a version-1 database with no
 * store, and later saves would do nothing. The page clears only on Stop,
 * which needs a running game, so a ROM has been saved by then.
 */

import { Result, Schema } from 'effect';

const DB_NAME = 'kn-demo-rom';
const STORE = 'rom';
const KEY = 'current';

/** What is stored: the ROM's bytes and the name of the file it came from. */
const DemoRom = Schema.Struct({ bytes: Schema.instanceOf(Uint8Array), name: Schema.String });
export type DemoRom = typeof DemoRom.Type;

const decodeDemoRom = Schema.decodeUnknownResult(DemoRom);

/** The record read back, if it holds bytes and a name (as the page checked before restoring). */
const demoRomOf = (record: IDBRequest['result']): DemoRom | null => {
  const decoded = decodeDemoRom(record);
  return Result.isSuccess(decoded) && decoded.success.name !== '' ? decoded.success : null;
};

/**
 * Open the database and run `use` on it, settling with what `use` settles
 * with, or `fallback` if the database cannot be opened or `use` throws.
 * `upgrade` creates the store when the database is new.
 */
const withDb = <A>(
  indexedDb: () => IDBFactory | undefined,
  upgrade: boolean,
  fallback: A,
  use: (db: IDBDatabase, settle: (value: A) => void) => void,
): Promise<A> =>
  new Promise((resolve) => {
    try {
      const factory = indexedDb();
      if (factory === undefined) {
        resolve(fallback);
        return;
      }
      const request = factory.open(DB_NAME, 1);
      if (upgrade) request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const db = request.result;
        const settle = (value: A): void => {
          db.close();
          resolve(value);
        };
        try {
          use(db, settle);
        } catch {
          settle(fallback);
        }
      };
      request.onerror = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });

/** The demo's ROM cache, on the page's IndexedDB unless another is given. */
export const demoRomStore = (indexedDb: () => IDBFactory | undefined = () => globalThis.indexedDB) => ({
  /** Keep this ROM in place of any other. */
  save: (bytes: Uint8Array, name: string): Promise<void> =>
    withDb(indexedDb, true, undefined, (db, settle) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ bytes, name }, KEY);
      tx.oncomplete = () => settle(undefined);
      tx.onerror = () => settle(undefined);
    }),
  /** The ROM kept, or null if there is none. */
  load: (): Promise<DemoRom | null> =>
    withDb<DemoRom | null>(indexedDb, true, null, (db, settle) => {
      const tx = db.transaction(STORE, 'readonly');
      const get = tx.objectStore(STORE).get(KEY);
      get.onsuccess = () => settle(demoRomOf(get.result));
      get.onerror = () => settle(null);
    }),
  /** Forget the ROM kept. */
  clear: (): Promise<void> =>
    withDb(indexedDb, false, undefined, (db, settle) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => settle(undefined);
      tx.onerror = () => settle(undefined);
    }),
});

export type DemoRomStore = ReturnType<typeof demoRomStore>;
