/**
 * An IndexedDB for the demo's ROM cache (web/src/demo/rom-store.ts, and the
 * old web/static/demo.js), kept in memory: open with an upgrade, one object
 * store, put, get, delete, and transactions that complete. A test puts it on
 * a fake page as `indexedDB`. Events fire as microtasks, so a whole open,
 * write and complete has run by the next turn of the event loop. Values are
 * stored and read back through structuredClone, as IndexedDB does.
 *
 * Like the real one, a transaction on a store the database does not have
 * throws (NotFoundError), and opening a database that does not exist creates
 * it, empty, whether or not the caller handles `upgradeneeded`.
 */

/** What the demo keeps under its one key. */
export interface StoredRom {
  readonly bytes: Uint8Array;
  readonly name: string;
}

type Handler = (() => void) | null;

interface GetRequest {
  result: StoredRom | undefined;
  onsuccess: Handler;
  onerror: Handler;
}

interface Transaction {
  oncomplete: Handler;
  onerror: Handler;
  objectStore: (name: string) => {
    put: (value: StoredRom, key: string) => void;
    delete: (key: string) => void;
    get: (key: string) => GetRequest;
  };
}

interface Connection {
  createObjectStore: (name: string) => void;
  close: () => void;
  transaction: (name: string, mode: IDBTransactionMode) => Transaction;
}

interface OpenRequest {
  result: Connection | null;
  onupgradeneeded: Handler;
  onsuccess: Handler;
  onerror: Handler;
}

interface Database {
  readonly version: number;
  readonly stores: Map<string, Map<string, StoredRom>>;
}

export const fakeIndexedDb = () => {
  const databases = new Map<string, Database>();
  let opens = 0;
  let closes = 0;

  const connection = (database: Database): Connection => ({
    createObjectStore: (name) => void database.stores.set(name, new Map()),
    close: () => void closes++,
    transaction: (name) => {
      const store = database.stores.get(name);
      if (store === undefined) throw new DOMException(`no object store ${name}`, 'NotFoundError');
      const tx: Transaction = {
        oncomplete: null,
        onerror: null,
        objectStore: () => ({
          put: (value, key) => void store.set(key, structuredClone(value)),
          delete: (key) => void store.delete(key),
          get: (key) => {
            const request: GetRequest = { result: undefined, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              request.result = structuredClone(store.get(key));
              request.onsuccess?.();
            });
            return request;
          },
        }),
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  });

  const factory = {
    open: (name: string, version: number): OpenRequest => {
      opens++;
      const request: OpenRequest = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        let database = databases.get(name);
        const created = database === undefined;
        if (database === undefined) {
          database = { version, stores: new Map() };
          databases.set(name, database);
        }
        request.result = connection(database);
        if (created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  return {
    factory,
    /** Put a ROM in place before the page loads, as an earlier visit would have. */
    seed: (name: string, store: string, key: string, value: StoredRom): void => {
      const database = databases.get(name) ?? { version: 1, stores: new Map() };
      databases.set(name, database);
      const stored = database.stores.get(store) ?? new Map<string, StoredRom>();
      database.stores.set(store, stored);
      stored.set(key, structuredClone(value));
    },
    /** Every database, store and ROM, and how many connections were opened and closed. */
    describe: (): string =>
      JSON.stringify({
        opens,
        closes,
        databases: [...databases].map(([name, database]) => [
          name,
          database.version,
          [...database.stores].map(([store, values]) => [
            store,
            [...values].map(([key, rom]) => [key, { bytes: [...rom.bytes], name: rom.name }]),
          ]),
        ]),
      }),
  };
};
