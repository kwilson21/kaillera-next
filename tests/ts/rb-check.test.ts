import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNCore } from '../../web/src/index.ts';
import { digestFrame, NO_DIGEST } from '../../web/src/desync-confirm.ts';
import { createRbCheckBook, type RbCheckOutcome } from '../../web/src/rb-check-book.ts';
import { pairVerdict, RB_ABSENT, RB_EXPIRED, RB_MATCH, RB_MISMATCH, RB_WAIT } from '../../web/src/rb-check.ts';

const WINDOW = 22; // _rbRollbackMax at delay <= 12
const HISTORY = 600;
const v = (gp: number, game = 0) => ({ gp, game });
const kinds = (outcomes: RbCheckOutcome[]) => outcomes.map((o) => `${o.kind}@${o.frame}/s${o.slot}`);

test('pairVerdict: both values here decide at once, whatever the age', () => {
  assert.equal(pairVerdict(7, 7, 300, 300, HISTORY), RB_MATCH);
  assert.equal(pairVerdict(7, 8, 300, 300, HISTORY), RB_MISMATCH);
  assert.equal(pairVerdict(7, 8, 300, 300 + HISTORY + 50, HISTORY), RB_MISMATCH);
  assert.equal(pairVerdict(0, 0, 0, 0, 0), RB_MATCH);
});

test('pairVerdict: a lone value waits out the history, then expires', () => {
  assert.equal(pairVerdict(7, RB_ABSENT, 300, 300 + HISTORY, HISTORY), RB_WAIT);
  assert.equal(pairVerdict(RB_ABSENT, 7, 300, 300 + HISTORY + 1, HISTORY), RB_EXPIRED);
  assert.equal(pairVerdict(RB_ABSENT, RB_ABSENT, 300, 0, HISTORY), RB_WAIT);
});

// ── Two simulated pages ─────────────────────────────────────────────────────
// Each holds a ring of hashes (frame -> hash, the window + 1 newest frames,
// as the C engine's state ring does) and simulates frames; a frame run on a
// predicted input gets a hash of its own until a rollback rewrites it.

interface Page {
  newest: number;
  ring: Map<number, number>;
  // What each frame's state truly is on this page (a real split differs here).
  truth: (frame: number) => number;
}

const page = (truth: (frame: number) => number): Page => ({ newest: 0, ring: new Map(), truth });
const simulate = (p: Page, wrong = false) => {
  p.newest += 1;
  p.ring.set(p.newest, wrong ? 0xbad0000 + p.newest : p.truth(p.newest));
  for (const f of p.ring.keys()) if (f < p.newest - WINDOW) p.ring.delete(f);
};
const rollback = (p: Page, from: number) => {
  for (const f of p.ring.keys()) if (f >= from) p.ring.set(f, p.truth(f));
};

// The rule now, as the engine runs it each tick: file the frame one window
// back on the cadence, from the ring as it is then; send it.
const fileDue = (p: Page, cadence: number): { frame: number; gp: number } | null => {
  const frame = digestFrame(p.newest, WINDOW, cadence);
  if (frame === NO_DIGEST) return null;
  const gp = p.ring.get(frame) ?? 0;
  return gp === 0 ? null : { frame, gp };
};

// The rule before (netplay-rollback.js until this change): the sender sends
// the hash of the frame it just simulated; the receiver compares it with its
// ring once it is minCheckAge old, and drops it as STALE past the window.
const oldRule = (sent: { frame: number; gp: number }, receiver: Page, minCheckAge: number) => {
  const age = receiver.newest - sent.frame;
  if (age > WINDOW) return 'STALE';
  if (age < minCheckAge) return 'WAIT';
  const local = receiver.ring.get(sent.frame) ?? 0;
  if (local === 0) return 'STALE';
  return local === sent.gp ? 'MATCH' : 'MISMATCH';
};

test('(a) a stale prediction is not flagged (rb_check.qnt healthyMispredictionTest)', () => {
  const truth = (f: number) => 1000 + f;
  const host = page(truth);
  const guest = page(truth);
  const hostBook = createRbCheckBook(HISTORY);
  const outcomes: RbCheckOutcome[] = [];
  // Frame 300 runs on the host on a predicted input; the guest's real input
  // arrives 3 frames later and the host rolls back.
  for (let t = 1; t <= 299; t++) {
    simulate(host);
    simulate(guest);
  }
  simulate(host, true);
  simulate(guest);
  const oldSent = { frame: 300, gp: host.ring.get(300) ?? 0 };
  for (let t = 0; t < 3; t++) {
    simulate(host, true);
    simulate(guest);
  }
  rollback(host, 300);
  // Before: the guest compared the host's predicted hash with its own final one.
  let old = 'WAIT';
  for (let t = 0; t < 30 && old === 'WAIT'; t++) {
    simulate(guest);
    old = oldRule(oldSent, guest, 12);
  }
  assert.equal(old, 'MISMATCH');
  // Now: each files frame 300 a window later, after the rollback.
  for (let t = 0; t < 40; t++) {
    simulate(host);
    simulate(guest);
    const h = fileDue(host, 300);
    const g = fileDue(guest, 300);
    if (h) outcomes.push(...hostBook.fileLocal(h.frame, v(h.gp)));
    if (g) {
      const got = hostBook.filePeer(1, g.frame, v(g.gp));
      if (got) outcomes.push(got);
    }
  }
  assert.deepEqual(kinds(outcomes), ['match@300/s1']);
});

test('(b) a confirmed split is flagged, and a late one is no longer dropped (rb_check.qnt splitLocalFirstTest)', () => {
  const host = page((f) => 1000 + f);
  const guest = page((f) => (f >= 280 ? 5000 + f : 1000 + f));
  const guestBook = createRbCheckBook(HISTORY);
  let hostValue: { frame: number; gp: number } | null = null;
  const outcomes: RbCheckOutcome[] = [];
  for (let t = 1; t <= 360; t++) {
    simulate(host);
    simulate(guest);
    hostValue = fileDue(host, 300) ?? hostValue;
    const g = fileDue(guest, 300);
    if (g) outcomes.push(...guestBook.fileLocal(g.frame, v(g.gp)));
  }
  assert.deepEqual(outcomes, []);
  // The host's value for 300 arrives 38 frames after the guest filed its own:
  // past the window. Before, the guest dropped it as STALE.
  assert.ok(hostValue);
  assert.equal(oldRule({ frame: 300, gp: hostValue.gp }, guest, 12), 'STALE');
  const got = guestBook.filePeer(0, hostValue.frame, v(hostValue.gp));
  assert.equal(got?.kind, 'mismatch');
  assert.equal(got?.frame, 300);
  if (got?.kind === 'mismatch') {
    assert.equal(got.local.gp, 5300);
    assert.equal(got.peer.gp, 1300);
  }
});

test('(c) the peer value first, then the local one: compared when the local one is filed', () => {
  const book = createRbCheckBook(HISTORY);
  assert.equal(book.filePeer(1, 300, v(42)), null);
  assert.deepEqual(book.size(), { local: 0, peer: 1 });
  assert.deepEqual(kinds(book.fileLocal(300, v(42))), ['match@300/s1']);
  assert.deepEqual(book.size(), { local: 1, peer: 0 });
});

test('(c) the local value first, then the peer one, long after the window: compared on arrival', () => {
  const book = createRbCheckBook(HISTORY);
  assert.deepEqual(book.fileLocal(300, v(42)), []);
  assert.deepEqual(book.expire(300 + WINDOW + 100), []);
  const got = book.filePeer(1, 300, v(43));
  assert.equal(got?.kind, 'mismatch');
});

test('(c) each peer is compared with the same local value, in a four-player mesh', () => {
  const book = createRbCheckBook(HISTORY);
  book.filePeer(1, 600, v(9));
  book.filePeer(2, 600, v(8));
  assert.deepEqual(kinds(book.fileLocal(600, v(9))), ['match@600/s1', 'mismatch@600/s2']);
  assert.equal(book.filePeer(3, 600, v(9))?.kind, 'match');
});

test('the first value filed for a frame on either side is the one compared', () => {
  const book = createRbCheckBook(HISTORY);
  book.fileLocal(300, v(1));
  assert.deepEqual(book.fileLocal(300, v(2)), []);
  assert.equal(book.filePeer(1, 300, v(1))?.kind, 'match');
  // A repeat of a compared peer value is not compared again.
  assert.equal(book.filePeer(1, 300, v(1)), null);
  book.filePeer(1, 600, v(5));
  book.filePeer(1, 600, v(6));
  assert.deepEqual(kinds(book.fileLocal(600, v(5))), ['match@600/s1']);
});

test('(d) a peer value with no local counterpart is reported once after the history', () => {
  const book = createRbCheckBook(HISTORY);
  book.filePeer(1, 300, v(7));
  assert.deepEqual(book.expire(300 + HISTORY), []);
  const out = book.expire(300 + HISTORY + 1);
  assert.deepEqual(out, [{ kind: 'uncompared', frame: 300, slot: 1, missing: 'local', value: v(7) }]);
  assert.deepEqual(book.expire(300 + HISTORY + 2), []);
  assert.deepEqual(book.size(), { local: 0, peer: 0 });
  // Arriving again later, it waits again rather than being compared with nothing.
  assert.deepEqual(book.fileLocal(300, v(7)), []);
});

test('(d) a local value is reported once for each peer that sends values but not this one', () => {
  const book = createRbCheckBook(HISTORY);
  book.filePeer(1, 0, v(1));
  book.fileLocal(0, v(1));
  book.filePeer(2, 0, v(1));
  book.fileLocal(0, v(1));
  book.fileLocal(300, v(3));
  book.filePeer(2, 300, v(3));
  const out = book.expire(300 + HISTORY + 1);
  assert.deepEqual(out, [{ kind: 'uncompared', frame: 300, slot: 1, missing: 'peer', value: v(3) }]);
  assert.deepEqual(book.expire(300 + HISTORY + 2), []);
});

test('(d) no report for a peer that never sends one (a page from before rb-final) or joined later', () => {
  const book = createRbCheckBook(HISTORY);
  book.fileLocal(300, v(3));
  book.fileLocal(600, v(4));
  // Slot 2 joins late: its first value is for frame 900.
  book.filePeer(2, 900, v(5));
  assert.deepEqual(book.expire(600 + HISTORY + 1), []);
  assert.deepEqual(book.size(), { local: 0, peer: 1 });
});

test('a resync forgets what this page filed for the frames it runs again, not what peers sent', () => {
  const book = createRbCheckBook(HISTORY);
  book.fileLocal(300, v(3));
  book.fileLocal(600, v(4));
  book.filePeer(1, 900, v(9));
  book.forgetFrom(600);
  assert.deepEqual(book.size(), { local: 1, peer: 1 });
  // Frame 600, run again, is filed afresh.
  assert.deepEqual(book.fileLocal(600, v(6)), []);
  assert.equal(book.filePeer(1, 600, v(6))?.kind, 'match');
});

test('a peer reset drops what it sent; clear drops everything', () => {
  const book = createRbCheckBook(HISTORY);
  book.filePeer(1, 300, v(1));
  book.filePeer(2, 300, v(1));
  book.forgetPeer(1);
  assert.deepEqual(book.size(), { local: 0, peer: 1 });
  assert.deepEqual(kinds(book.fileLocal(300, v(1))), ['match@300/s2']);
  book.clear();
  assert.deepEqual(book.size(), { local: 0, peer: 0 });
});

test('values that are not unsigned 32-bit hashes, or frames that are not frames, are not filed', () => {
  const book = createRbCheckBook(HISTORY);
  assert.deepEqual(book.fileLocal(-1, v(1)), []);
  assert.deepEqual(book.fileLocal(300, v(-5)), []);
  assert.equal(book.filePeer(1, 300, v(2 ** 32)), null);
  assert.equal(book.filePeer(1, 1.5, v(2)), null);
  assert.deepEqual(book.size(), { local: 0, peer: 0 });
});

test('the plain-script engine reaches it through KNCore', () => {
  assert.equal(KNCore.rbCheck.pairVerdict, pairVerdict);
  assert.equal(KNCore.rbCheck.createBook, createRbCheckBook);
});
