/**
 * The ROM library: the ROMs a player has loaded on this device, kept in
 * IndexedDB so the next visit does not need the file again. Moved from
 * web/static/play.js; the page still decides what loading a ROM means and
 * owns the DOM, and reads storage and the list markup from here.
 */
import { Result, Schema } from 'effect';
import { escapeHtml } from './room-text.ts';

const DB_NAME = 'kaillera-rom-cache';
const STORE = 'roms';
const DB_VERSION = 2;

/** Where a ROM came from: the player's own file, or the host over WebRTC. */
export type RomSource = 'local' | 'p2p';

/** What is stored under a ROM's hash. */
const StoredRom = Schema.Struct({
  blob: Schema.instanceOf(ArrayBuffer),
  name: Schema.String,
  size: Schema.Number,
  source: Schema.String,
  verified: Schema.Boolean,
  gameName: Schema.NullOr(Schema.String),
  addedAt: Schema.Number,
  lastUsed: Schema.Number,
});
export type StoredRom = typeof StoredRom.Type;

const decodeStoredRom = Schema.decodeUnknownResult(StoredRom);

/** A library row: everything about a stored ROM except its bytes. */
export type RomEntry = Omit<StoredRom, 'blob'> & { readonly hash: string };

/** ROMs the server knows by hash (`/api/rom-hashes`). */
export type KnownRoms = Readonly<Record<string, { readonly game: string } | undefined>>;

/**
 * The record for a ROM about to be stored. A ROM whose hash the server knows
 * is verified and takes the game's name; any other keeps its file name.
 */
export const newStoredRom = (
  bytes: ArrayBuffer,
  hash: string,
  fileName: string | undefined,
  source: RomSource,
  known: KnownRoms,
  now: number,
): StoredRom => {
  const gameName = known[hash]?.game ?? null;
  return {
    blob: bytes,
    name: gameName || fileName || 'Unknown ROM',
    size: bytes.byteLength,
    source,
    verified: gameName !== null,
    gameName,
    addedAt: now,
    lastUsed: now,
  };
};

/** Most recently used first. */
export const byLastUsed = (entries: readonly RomEntry[]): RomEntry[] =>
  [...entries].sort((a, b) => b.lastUsed - a.lastUsed);

// ── storage ─────────────────────────────────────────────────────────────────

/** The one ROM a version-1 database held, as the page remembered it. */
export type LegacyRom = { readonly name: string | null; readonly hash: string | null };

const whenDone = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const whenCommitted = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/**
 * Version 1 kept a single ROM under the key `current`. Version 2 keys by
 * hash. Everything here stays inside the upgrade transaction: anything
 * asynchronous (hashing the bytes) would let it commit early, so the hash is
 * the one the page cached beside it, and a ROM without one is dropped.
 */
const upgrade = (request: IDBOpenDBRequest, oldVersion: number, legacy: LegacyRom, now: number): void => {
  const db = request.result;
  if (oldVersion < 1) {
    db.createObjectStore(STORE);
    return;
  }
  if (oldVersion >= 2 || request.transaction === null) return;
  const store = request.transaction.objectStore(STORE);
  const current = store.get('current');
  current.onsuccess = () => {
    const bytes: ArrayBuffer | undefined = current.result;
    if (!bytes) return;
    if (legacy.hash) {
      store.put(
        { ...newStoredRom(bytes, legacy.hash, legacy.name ?? undefined, 'local', {}, now), verified: false },
        legacy.hash,
      );
    }
    store.delete('current');
  };
};

/** The library database, or null where there is no IndexedDB or it will not open. */
const openDb = (legacy: LegacyRom): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => upgrade(request, event.oldVersion, legacy, Date.now());
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
};

const rowOf = (hash: string, stored: StoredRom): RomEntry => {
  const { blob: _bytes, ...row } = stored;
  return { ...row, hash };
};

/**
 * The library on this device. `legacy` is read only when a version-1
 * database is upgraded. Every method resolves once its change is committed;
 * where there is no database, reads come back empty and writes do nothing.
 */
export const openRomLibrary = (legacy: LegacyRom) => {
  const db = openDb(legacy);

  /** Every stored ROM, most recently used first. Entries that are not a ROM record are skipped. */
  const list = async (): Promise<RomEntry[]> => {
    const database = await db;
    if (database === null) return [];
    // A cursor, so only one ROM's bytes are in memory at a time: a library
    // can hold hundreds of megabytes.
    const tx = database.transaction(STORE, 'readonly');
    const cursorRequest = tx.objectStore(STORE).openCursor();
    const entries: RomEntry[] = [];
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null) return;
      const stored = decodeStoredRom(cursor.value);
      if (typeof cursor.key === 'string' && Result.isSuccess(stored)) entries.push(rowOf(cursor.key, stored.success));
      cursor.continue();
    };
    await whenCommitted(tx);
    return byLastUsed(entries);
  };

  /** One stored ROM with its bytes, or null. */
  const get = async (hash: string): Promise<StoredRom | null> => {
    const database = await db;
    if (database === null) return null;
    const stored = decodeStoredRom(
      await whenDone(database.transaction(STORE, 'readonly').objectStore(STORE).get(hash)),
    );
    return Result.isSuccess(stored) ? stored.success : null;
  };

  /** Store a ROM under its hash, replacing any there. */
  const put = async (hash: string, rom: StoredRom): Promise<void> => {
    const database = await db;
    if (database === null) return;
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rom, hash);
    await whenCommitted(tx);
  };

  /** Record that a ROM was just used, so it sorts first. */
  const touch = async (hash: string, now: number): Promise<void> => {
    const database = await db;
    if (database === null) return;
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.get(hash);
    request.onsuccess = () => {
      const stored = decodeStoredRom(request.result);
      if (Result.isSuccess(stored)) store.put({ ...stored.success, lastUsed: now }, hash);
    };
    await whenCommitted(tx);
  };

  const remove = async (hash: string): Promise<void> => {
    const database = await db;
    if (database === null) return;
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(hash);
    await whenCommitted(tx);
  };

  /**
   * Mark stored ROMs the server now knows as verified, under the game's
   * name. Resolves to whether any entry changed.
   */
  const verifyAgainst = async (known: KnownRoms): Promise<boolean> => {
    const database = await db;
    if (database === null) return false;
    const tx = database.transaction(STORE, 'readwrite');
    const cursorRequest = tx.objectStore(STORE).openCursor();
    let changed = false;
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null) return;
      const stored = decodeStoredRom(cursor.value);
      const game = typeof cursor.key === 'string' ? known[cursor.key]?.game : undefined;
      if (game !== undefined && Result.isSuccess(stored) && !stored.success.verified) {
        cursor.update({ ...stored.success, verified: true, gameName: game, name: game });
        changed = true;
      }
      cursor.continue();
    };
    await whenCommitted(tx);
    return changed;
  };

  return { list, get, put, touch, remove, verifyAgainst };
};

// ── the list, as markup ─────────────────────────────────────────────────────

/** Whole megabytes or kilobytes, as the library shows a size. */
export const librarySize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

/** Who is looking at the library, and which ROMs matter to them. */
export type LibraryView = {
  readonly isHost: boolean;
  /** The ROM this page has loaded. */
  readonly activeHash: string | null;
  /** The ROM the host has loaded, as a guest knows it. */
  readonly hostHash: string | null;
};

const itemHtml = (entry: RomEntry, view: LibraryView): string => {
  const isActive = entry.hash === view.activeHash;
  // A guest is told which of their ROMs is the host's exact game.
  const matchesHost = !view.isHost && view.hostHash !== null && view.hostHash !== '' && entry.hash === view.hostHash;
  let verified = '<span class="unverified">Unverified</span>';
  if (matchesHost) verified = `<span class="verified">Matches host's game</span>`;
  else if (entry.verified) verified = `<span class="verified">Verified — ${escapeHtml(entry.gameName ?? '')}</span>`;
  const hash = escapeHtml(entry.hash);
  const classes = `rom-library-item${isActive ? ' active' : ''}${matchesHost ? ' matches-host' : ''}`;
  return [
    `<div class="${classes}" data-hash="${hash}">`,
    '<span class="rom-check">✓</span>',
    '<div class="rom-info">',
    `<div class="rom-name">${escapeHtml(entry.name)}</div>`,
    `<div class="rom-meta">${verified}<span>${librarySize(entry.size)}</span>`,
    entry.source === 'p2p' ? '<span>From host</span>' : '',
    '</div>',
    '</div>',
    isActive ? '' : `<button class="rom-use small-btn" data-hash="${hash}" type="button">Use</button>`,
    `<button class="rom-delete" data-hash="${hash}" title="Remove from library">✕</button>`,
    '</div>',
  ].join('');
};

/** The library panel's contents. Names and hashes are escaped. */
export const romLibraryHtml = (entries: readonly RomEntry[], view: LibraryView): string => {
  const label = view.isHost ? 'ROM Library' : 'Your ROMs on this device';
  const count = `${entries.length} ROM${entries.length === 1 ? '' : 's'}`;
  return [
    `<div class="rom-library-header"><span>${label}</span><span class="rom-count">${count}</span></div>`,
    '<div class="rom-library-list">',
    ...entries.map((entry) => itemHtml(entry, view)),
    '</div>',
  ].join('');
};
