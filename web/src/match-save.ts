import { Result, Schema } from 'effect';
import type { Input } from './owner-proof.ts';
import { digestBytes, sameInput } from './checkpoint-journal.ts';
import { GameMode, type RoomPlayer } from './protocol.ts';

const cadence = 3000;
const maxAge = 120_000 + cadence * 3;
const id = Schema.String.check(Schema.isBetweenLength(1, 160));
const slot = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }));
const axis = Schema.Int.check(Schema.isBetween({ minimum: -128, maximum: 127 }));
const input = Schema.Tuple([Schema.Int, axis, axis, axis, axis]);
const scopeSchema = Schema.Struct({
  room: id,
  matchId: id,
  hostId: id,
  mode: GameMode,
  romHash: id,
  coreHash: id,
  roster: Schema.Array(Schema.NullOr(id)).check(Schema.isBetweenLength(2, 4)),
});
export const MatchSaveMeta = Schema.Struct({
  scope: scopeSchema,
  capturedAt: Schema.Int,
  rngSeed: Schema.optional(Schema.Int),
  inputRuntime: Schema.optional(id),
  frame: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0x7fffffff })),
  delay: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 })),
  rows: Schema.Array(Schema.Tuple([slot, Schema.Array(input).check(Schema.isBetweenLength(1, 17))])).check(
    Schema.isMaxLength(4),
  ),
});
type Meta = typeof MatchSaveMeta.Type;
type Scope = Meta['scope'];
type Query = Pick<Scope, 'room' | 'matchId' | 'hostId' | 'romHash' | 'mode'> & { remainingMs?: number };
type Config = {
  sessionId: string;
  matchId: string;
  mode: Scope['mode'];
  romHash: string;
  initialPlayers?: { players?: Record<string, RoomPlayer> };
};
type Snapshot = {
  bytes: Uint8Array<ArrayBuffer>;
  hidden: Uint32Array<ArrayBuffer>;
  hle: Uint8Array<ArrayBuffer>;
  fifo: Uint32Array<ArrayBuffer>;
  sram: Uint8Array<ArrayBuffer>;
  lib?: Uint8Array<ArrayBuffer>;
};
type Save = Meta & { snapshot: Snapshot };
type Stored = Save & { seal: string };

function scope(config: Config, coreHash: string, matchId = config.matchId): Scope | null {
  const roster: (string | null)[] = [];
  for (const [pid, player] of Object.entries(config.initialPlayers?.players ?? {})) {
    const i = player.slot;
    if (i === null || !Number.isInteger(i) || i < 0 || i > 3 || roster[i] || player.away) return null;
    roster[i] = pid;
  }
  const hostId = roster[0];
  if (!hostId || roster.length < 2 || !coreHash || !config.romHash || !matchId) return null;
  return {
    room: config.sessionId,
    matchId,
    mode: config.mode,
    hostId,
    coreHash,
    romHash: config.romHash,
    roster: Array.from(roster, (p) => p ?? null),
  };
}
const fresh = (stamp: number) => stamp <= Date.now() + 1000 && Date.now() - stamp <= maxAge;
function valid(s: Save, query: Query | Scope, checkTime: boolean): boolean {
  if (!s || !Result.isSuccess(Schema.decodeUnknownResult(MatchSaveMeta)(s))) return false;
  const { scope: p, snapshot: b } = s;
  if (
    p.hostId !== p.roster[0] ||
    p.room !== query.room ||
    p.matchId !== query.matchId ||
    p.hostId !== query.hostId ||
    p.mode !== query.mode ||
    p.romHash !== query.romHash ||
    (checkTime && !fresh(s.capturedAt))
  )
    return false;
  if (
    'coreHash' in query &&
    (p.coreHash !== query.coreHash || JSON.stringify(p.roster) !== JSON.stringify(query.roster))
  )
    return false;
  const slots = p.roster.flatMap((pid, i) => (pid === null ? [] : [i]));
  if (
    slots.length < 2 ||
    new Set(p.roster.filter(Boolean)).size !== slots.length ||
    !b ||
    !(b.bytes instanceof Uint8Array && b.bytes.length && b.bytes.length <= 9 * 1024 * 1024) ||
    !(b.hidden instanceof Uint32Array && b.hidden.length === 18) ||
    !(b.hle instanceof Uint8Array && b.hle.length > 0 && b.hle.length <= 65536) ||
    !(b.fifo instanceof Uint32Array && (b.fifo.length === 0 || b.fifo.length === 4)) ||
    !(b.sram instanceof Uint8Array && b.sram.length && b.sram.length <= 2 * 1024 * 1024)
  )
    return false;
  if (p.mode === 'streaming')
    return s.rows.length === 0 && b.lib instanceof Uint8Array && b.lib.length > 0 && b.lib.length <= 32 * 1024 * 1024;
  return (
    s.rngSeed !== undefined &&
    !!s.inputRuntime &&
    !b.lib &&
    s.rows.length === slots.length &&
    s.rows.every(([n, row], i) => n === slots[i] && row.length === Math.min(s.frame, s.delay + 1))
  );
}
async function seal(s: Save): Promise<string> {
  const { scope: p, frame, capturedAt, delay, rows, snapshot: b } = s;
  const sections = [b.bytes, b.hidden, b.hle, b.fifo, b.sram, ...(b.lib ? [b.lib] : [])];
  const hashes = await Promise.all(
    sections.map((x) => digestBytes(new Uint8Array(x.buffer, x.byteOffset, x.byteLength))),
  );
  return digestBytes(
    new TextEncoder().encode(
      JSON.stringify([
        1,
        p.room,
        p.matchId,
        p.hostId,
        p.mode,
        p.romHash,
        p.coreHash,
        p.roster,
        frame,
        capturedAt,
        s.rngSeed ?? null,
        s.inputRuntime ?? null,
        delay,
        rows,
        hashes,
      ]),
    ),
  );
}
async function verify(s: Stored, query: Scope, checkTime = false): Promise<boolean> {
  return valid(s, query, checkTime) && (await seal(s)) === s.seal;
}
// A valid return can be claimed with a second left. Core boot and the authorized
// all-player handshake may finish after the original seat deadline.
let claimed: { save: Stored; until: number } | null = null;
const STORE = 'matches';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kn-match-return', 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE).createIndex('capturedAt', 'capturedAt');
    r.onsuccess = () => resolve(r.result);
    r.onerror = r.onblocked = () => reject(new Error('Match save storage unavailable'));
  });
}
async function transaction<T>(
  write: boolean,
  initial: T,
  fn: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  try {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        let result = initial;
        const tx = db.transaction(STORE, write ? 'readwrite' : 'readonly');
        const store = tx.objectStore(STORE);
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error);
        fn(store, (v) => {
          result = v;
        });
      });
    } finally {
      db.close();
    }
  } catch {
    return initial;
  }
}
// Check the time inside the same transaction as put: an older capture can finish hashing last.
async function write(s: Save, current = () => true): Promise<boolean> {
  if (!valid(s, s.scope, true)) return false;
  const mark = await seal(s);
  if (!current()) return false;
  return transaction(true, false, (store, done) => {
    const old = store.get(s.scope.room);
    old.onsuccess = () => {
      if (!current() || (old.result?.capturedAt ?? 0) > s.capturedAt) return;
      store.put({ ...s, seal: mark }, s.scope.room);
      done(true);
    };
    const expired = store.index('capturedAt').openKeyCursor(IDBKeyRange.upperBound(Date.now() - maxAge, true));
    expired.onsuccess = () => {
      const cursor = expired.result;
      if (cursor) {
        if (cursor.primaryKey !== s.scope.room) store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
}
const read = (room: string) =>
  transaction<Stored | null>(false, null, (store, done) => {
    const r = store.get(room);
    r.onsuccess = () => done(r.result ?? null);
  });
async function load(p: Scope): Promise<Stored | null> {
  const held = claimed;
  claimed = null;
  if (held && held.until >= Date.now() && (await verify(held.save, p))) return held.save;
  const s = await read(p.room);
  return s && (await verify(s, p, true)) ? s : null;
}
export function recentAtDisconnect(capturedAt: number, left: number | undefined, now = Date.now()): boolean {
  if (left !== undefined && (!Number.isFinite(left) || left <= 0)) return false;
  const oldest = now - maxAge + Math.min(120_000, left ?? 0);
  return capturedAt >= oldest && capturedAt <= now + 1000;
}
async function available(p: Query): Promise<boolean> {
  const s = await read(p.room);
  claimed = null;
  if (!s || !valid(s, p, true)) return false;
  if (!recentAtDisconnect(s.capturedAt, p.remainingMs)) return false;
  if ((await seal(s)) !== s.seal) return false;
  claimed = { save: s, until: Date.now() + 120000 };
  return true;
}
function remove(room: string, matchId: string, hostId: string) {
  const p = claimed?.save.scope;
  if (p?.room === room && p.matchId === matchId && p.hostId === hostId) claimed = null;
  return transaction(true, false, (store, done) => {
    const r = store.get(room);
    r.onsuccess = () => {
      if (r.result?.scope?.matchId === matchId && r.result.scope.hostId === hostId) {
        store.delete(room);
        done(true);
      }
    };
  });
}
// The native prediction is the exact tuple the captured frame consumed. An
// unanswered owner can still confirm it; a correction makes the whole state obsolete.
export function confirmInputs(
  samples: readonly { slot: number; tag: number; applied: Input }[],
  owner: (slot: number, tag: number) => Input | null,
) {
  let waiting = false;
  for (const { slot, tag, applied } of samples) {
    const value = owner(slot, tag);
    if (!value) waiting = true;
    else if (!sameInput(value, applied)) return 'changed';
  }
  return waiting ? 'waiting' : 'confirmed';
}
export const matchSave = { confirmInputs, cadence, scope, write, load, available, remove, verify };
