// KNShared.createSyncLogRing: delta-flush support (entriesAfter). Session
// logs used to resend the ENTIRE ring every 5s (up to 60,000 entries, ~3MB
// after 2m45s), which queued behind end-game on the same Socket.IO
// connection and delayed the game-ended broadcast. entriesAfter lets the
// client send only new entries since the server's last-acked seq.
//
//   node --test tests/sync-log-ring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.window = globalThis;
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/static/shared.js'));
const { createSyncLogRing } = globalThis.KNShared;

test('entriesAfter returns nothing on an empty ring', () => {
  const ring = createSyncLogRing(10);
  assert.deepEqual(ring.entriesAfter(0, 100), []);
});

test('entriesAfter(-1, max) returns all entries oldest-first on first flush, including seq 0', () => {
  const ring = createSyncLogRing(10);
  for (let i = 0; i < 5; i++) ring.push({ t: i, f: i, msg: `m${i}` });
  const out = ring.entriesAfter(-1, 100);
  assert.deepEqual(
    out.map((e) => e.seq),
    [0, 1, 2, 3, 4],
  );
  assert.equal(out[0].msg, 'm0');
});

test('entriesAfter only returns entries newer than the given seq', () => {
  const ring = createSyncLogRing(10);
  for (let i = 0; i < 5; i++) ring.push({ t: i, f: i, msg: `m${i}` });
  const out = ring.entriesAfter(2, 100);
  assert.deepEqual(
    out.map((e) => e.seq),
    [3, 4],
  );
});

test('entriesAfter caps the number of entries returned, leaving the rest for next call', () => {
  const ring = createSyncLogRing(100);
  for (let i = 0; i < 50; i++) ring.push({ t: i, f: i, msg: `m${i}` });
  const first = ring.entriesAfter(-1, 10);
  assert.equal(first.length, 10);
  assert.deepEqual(
    first.map((e) => e.seq),
    Array.from({ length: 10 }, (_, i) => i),
  );
  // Advancing the cursor by the acked seq picks up the remainder next time.
  const acked = first[first.length - 1].seq;
  const second = ring.entriesAfter(acked, 10);
  assert.deepEqual(
    second.map((e) => e.seq),
    Array.from({ length: 10 }, (_, i) => i + 10),
  );
});

test('entriesAfter still works once the ring has wrapped (oldest entries evicted)', () => {
  const ring = createSyncLogRing(5);
  for (let i = 0; i < 8; i++) ring.push({ t: i, f: i, msg: `m${i}` });
  // Entries 0-2 were evicted; only 3-7 remain in the ring.
  const out = ring.entriesAfter(-1, 100);
  assert.deepEqual(
    out.map((e) => e.seq),
    [3, 4, 5, 6, 7],
  );
});

test('entriesAfter returns nothing once the caller has caught up', () => {
  const ring = createSyncLogRing(10);
  for (let i = 0; i < 3; i++) ring.push({ t: i, f: i, msg: `m${i}` });
  assert.deepEqual(ring.entriesAfter(2, 100), []);
});

test('clear() resets seq so entriesAfter(-1, max) sees post-clear entries from the start', () => {
  const ring = createSyncLogRing(10);
  ring.push({ t: 0, f: 0, msg: 'before' });
  ring.push({ t: 1, f: 1, msg: 'before2' });
  ring.clear();
  ring.push({ t: 0, f: 0, msg: 'after' });
  const out = ring.entriesAfter(0, 100);
  assert.deepEqual(out, []); // seq 0 is not > afterSeq 0
  const out2 = ring.entriesAfter(-1, 100);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].msg, 'after');
});

// ── epoch (reload / reconnect / slot-reuse dedup guard) ─────────────────────
//
// A page reload, a fresh reconnect tab, or a spectator claiming a slot a
// previous player used all create a brand-new ring that restarts seq at 0.
// The server tells these apart from an ordinary resend by a per-ring epoch
// string that changes whenever the ring is (re)created or cleared.

test('epoch is a non-empty string, stable across pushes', () => {
  const ring = createSyncLogRing(10);
  const e1 = ring.epoch;
  assert.equal(typeof e1, 'string');
  assert.ok(e1.length > 0);
  ring.push({ t: 0, f: 0, msg: 'a' });
  ring.push({ t: 1, f: 1, msg: 'b' });
  assert.equal(ring.epoch, e1);
});

test('clear() changes the epoch', () => {
  const ring = createSyncLogRing(10);
  const before = ring.epoch;
  ring.clear();
  assert.notEqual(ring.epoch, before);
});

test('two separately created rings (e.g. two tabs) have different epochs', () => {
  const a = createSyncLogRing(10);
  const b = createSyncLogRing(10);
  assert.notEqual(a.epoch, b.epoch);
});

// ── entriesAfter byte budget (finding 5: cap a single flush's estimated
// JSON size in addition to the entry count, so one flush can't approach the
// 4MB Socket.IO max_http_buffer_size) ───────────────────────────────────────

test('entriesAfter stops adding entries once the byte budget is exceeded', () => {
  const ring = createSyncLogRing(1000);
  const bigMsg = 'x'.repeat(1000);
  for (let i = 0; i < 20; i++) ring.push({ t: i, f: i, msg: bigMsg });
  // Each entry costs ~1000 (msg) + 64 (overhead) = ~1064 bytes. A 5000-byte
  // budget should fit about 4-5 entries, well short of the 20 available and
  // the 1000-entry count cap.
  const out = ring.entriesAfter(-1, 1000, 5000);
  assert.ok(out.length > 0);
  assert.ok(out.length < 20);
  assert.deepEqual(
    out.map((e) => e.seq),
    Array.from({ length: out.length }, (_, i) => i),
  );
});

test('entriesAfter always returns at least one entry even if it alone exceeds the byte budget', () => {
  const ring = createSyncLogRing(10);
  ring.push({ t: 0, f: 0, msg: 'x'.repeat(10000) });
  ring.push({ t: 1, f: 1, msg: 'y'.repeat(10000) });
  const out = ring.entriesAfter(-1, 100, 100);
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 0);
});

test('entriesAfter defaults to a 1MB byte budget when none is given', () => {
  const ring = createSyncLogRing(10);
  for (let i = 0; i < 5; i++) ring.push({ t: i, f: i, msg: `m${i}` });
  // Tiny entries, well under any reasonable default budget — all present.
  const out = ring.entriesAfter(-1, 100);
  assert.equal(out.length, 5);
});
