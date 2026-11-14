import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  disconnectDisposition,
  hasAttemptLeft,
  shouldInitiate,
  signalDisposition,
  staleHoldersOf,
} from '../../web/src/peer-signaling.ts';

const SLOTS = [0, 1, 2, 3];
const BOOLS = [false, true];

test('of two players in the lobby exactly one offers: the lower slot', () => {
  for (const a of SLOTS) {
    for (const b of SLOTS) {
      if (a === b) continue;
      const aOffers = shouldInitiate(false, false, false, false, a, b);
      const bOffers = shouldInitiate(false, false, false, false, b, a);
      assert.notEqual(aOffers, bOffers, `slots ${a} and ${b}`);
      assert.equal(aOffers, a < b);
    }
  }
});

test('a late joiner offers to the players in the match, and they wait for it', () => {
  for (const joiner of SLOTS) {
    for (const player of SLOTS) {
      if (joiner === player) continue;
      assert.equal(shouldInitiate(false, true, false, false, joiner, player), true);
      // The running page, whether or not it has marked the joiner as held yet.
      for (const held of BOOLS) assert.equal(shouldInitiate(false, false, true, held, player, joiner), false);
    }
  }
});

test('a page whose initial sync has begun waits for a player it holds as a late joiner', () => {
  assert.equal(shouldInitiate(false, false, false, true, 0, 1), false);
});

test('a spectator never offers, even one who joined a streamed match in play', () => {
  for (const slot of SLOTS) {
    for (const lateJoiner of BOOLS) {
      for (const running of BOOLS) {
        for (const held of BOOLS) assert.equal(shouldInitiate(true, lateJoiner, running, held, -1, slot), false);
      }
    }
  }
});

test("the answer is the one onUsersUpdated's ladder gives, for every input", () => {
  // The ladder in onUsersUpdated (web/static/netplay-rollback.js), in its own order.
  const engine = (
    spectator: boolean,
    lateJoin: boolean,
    running: boolean,
    held: boolean,
    mySlot: number,
    theirSlot: number,
  ): boolean => {
    if (lateJoin && !spectator) return true;
    if (running) return false;
    if (held) return false;
    if (spectator) return false;
    return mySlot < theirSlot;
  };
  for (const spectator of BOOLS) {
    for (const lateJoin of BOOLS) {
      for (const running of BOOLS) {
        for (const held of BOOLS) {
          for (const mine of SLOTS) {
            for (const theirs of SLOTS) {
              assert.equal(
                shouldInitiate(spectator, lateJoin, running, held, mine, theirs),
                engine(spectator, lateJoin, running, held, mine, theirs),
              );
            }
          }
        }
      }
    }
  }
});

test('known gap: two players joining a match at the same moment both offer', () => {
  // Kept as the engine does it today. The fix belongs in the model first.
  assert.equal(shouldInitiate(false, true, false, false, 2, 3), true);
  assert.equal(shouldInitiate(false, true, false, false, 3, 2), true);
});

test('an answer or a candidate never creates, replaces or resets a connection', () => {
  for (const reconnect of BOOLS) {
    for (const underEarlierId of BOOLS) {
      assert.equal(signalDisposition(false, reconnect, underEarlierId, true), 'apply');
      assert.equal(signalDisposition(false, reconnect, underEarlierId, false), 'drop');
    }
  }
});

test('an offer before the roster makes the entry on demand', () => {
  assert.equal(signalDisposition(true, false, false, false), 'create');
  assert.equal(signalDisposition(true, true, false, false), 'create');
  // Once it exists, the same offer is applied to it, or resets it.
  assert.equal(signalDisposition(true, false, false, true), 'apply');
  assert.equal(signalDisposition(true, true, false, true), 'reset');
});

test('a fresh offer under a kept connection means a new page: the kept one goes', () => {
  for (const hasEntry of BOOLS) assert.equal(signalDisposition(true, false, true, hasEntry), 'replaceKept');
});

test('a reconnect offer under a kept connection resets it and keeps the entry', () => {
  assert.equal(signalDisposition(true, true, true, true), 'reset');
});

test('a player who left on purpose is never reconnected to', () => {
  for (const beforeStart of BOOLS) {
    for (const initiator of BOOLS) {
      for (const pending of BOOLS) {
        for (const running of BOOLS) {
          assert.equal(disconnectDisposition(beforeStart, initiator, true, pending, running), 'hardDisconnect');
        }
      }
    }
  }
});

test('the answer is the one handlePeerDisconnect gives, for every input', () => {
  // handlePeerDisconnect's own order of tests (web/static/netplay-rollback.js).
  const engine = (
    beforeStart: boolean,
    initiator: boolean,
    intentional: boolean,
    pending: boolean,
    running: boolean,
  ): string => {
    if (beforeStart && initiator && !intentional) return 'retryStartup';
    if (pending) return 'hardDisconnect';
    if (running && !intentional) return 'reconnect';
    return 'hardDisconnect';
  };
  for (const beforeStart of BOOLS) {
    for (const initiator of BOOLS) {
      for (const intentional of BOOLS) {
        for (const pending of BOOLS) {
          for (const running of BOOLS) {
            assert.equal(
              disconnectDisposition(beforeStart, initiator, intentional, pending, running),
              engine(beforeStart, initiator, intentional, pending, running),
            );
          }
        }
      }
    }
  }
});

test('before the match the page that offered offers again; the other drops the entry', () => {
  assert.equal(disconnectDisposition(true, true, false, false, false), 'retryStartup');
  assert.equal(disconnectDisposition(true, false, false, false, false), 'hardDisconnect');
});

test('in a running match a lost connection is reconnected, unless the player was still held', () => {
  assert.equal(disconnectDisposition(false, true, false, false, true), 'reconnect');
  assert.equal(disconnectDisposition(false, false, false, false, true), 'reconnect');
  assert.equal(disconnectDisposition(false, false, false, true, true), 'hardDisconnect');
});

test('attempts stop at the maximum', () => {
  assert.deepEqual(
    [1, 2, 3].map((attempt) => hasAttemptLeft(attempt, 3)),
    [true, true, false],
  );
});

test('a new player replaces whatever else holds their slot, and nothing more', () => {
  const holders = [
    { key: 'old', slot: 1 },
    { key: 'new', slot: 1 },
    { key: 'other', slot: 2 },
    { key: 'spectator', slot: -1 },
  ];
  assert.deepEqual(staleHoldersOf(holders, 'new', 1), ['old']);
  assert.deepEqual(staleHoldersOf(holders, 'new', 3), []);
});
