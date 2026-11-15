/**
 * The per-peer machine run beside the engine, observing (web/src/peer-observe.ts).
 *
 * Each test plays the engine's part by hand: it opens a frame, reports what
 * the engine did, sets what the engine holds, and closes the frame with the
 * event. The observer must stay quiet where the engine and the machine
 * agree, report the first difference once, and leave alone what the machine
 * does not cover (an old page, a late joiner).
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisagreeReport } from '../../web/src/play/observe.ts';
import {
  createPeerObserver,
  newPageId,
  readAttemptId,
  type EngineAction,
  type ObservedEvent,
  type PeerFacts,
} from '../../web/src/peer-observe.ts';

const PAGE = 'page-mine';
const THEIRS = 'page-theirs';

const NONE: PeerFacts = { entry: false, open: false, reconnecting: false };
const WAITING: PeerFacts = { entry: true, open: false, reconnecting: false };
const OPEN: PeerFacts = { entry: true, open: true, reconnecting: false };
const RECONNECTING: PeerFacts = { entry: true, open: false, reconnecting: true };

/** An engine at slot `mySlot` with one other player, under `_peers` key `key`. */
const engine = (mySlot: number, { uploadToken = true } = {}) => {
  const reports: DisagreeReport[] = [];
  const log: string[] = [];
  const facts = new Map<number, PeerFacts>();
  const offers = new Map<number, number>();
  let token = uploadToken;
  const observer = createPeerObserver({
    page: PAGE,
    mySlot: () => mySlot,
    offersMade: (slot) => offers.get(slot) ?? 0,
    facts: (slot) => facts.get(slot) ?? NONE,
    sink: (report) => {
      if (!token) return false;
      reports.push(report);
      return true;
    },
    log: (line) => log.push(line),
  });
  /** One event as the engine handles it: what it did, what it holds after, what the machine is told. */
  const handle = (
    slot: number | null,
    key: string,
    did: readonly EngineAction[],
    after: PeerFacts | null,
    event: ObservedEvent | null,
  ): void => {
    const frame = observer.open(slot, key);
    for (const action of did) {
      if (action.type === 'offer' && slot !== null) offers.set(slot, (offers.get(slot) ?? 0) + 1);
      observer.did(slot, key, action);
    }
    if (after && slot !== null) facts.set(slot, after);
    observer.close(frame, event);
  };
  return {
    observer,
    reports,
    log,
    facts,
    handle,
    offered: (slot: number) => offers.set(slot, (offers.get(slot) ?? 0) + 1),
    giveToken: () => {
      token = true;
    },
  };
};

test('the pair connects in the lobby and starts: the lower slot sees no difference', () => {
  const host = engine(0);
  host.handle(1, 'guest', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  host.handle(1, 'guest', [{ type: 'applyAnswer', page: PAGE, attempt: 1 }], WAITING, {
    type: 'answer',
    page: PAGE,
    attempt: 1,
  });
  host.handle(1, 'guest', [{ type: 'applyCandidate', page: PAGE, attempt: 1 }], WAITING, {
    type: 'candidate',
    page: PAGE,
    attempt: 1,
  });
  host.handle(1, 'guest', [], OPEN, { type: 'opened', page: PAGE, attempt: 1 });
  host.observer.matchStarted();
  host.observer.check(1);
  assert.deepEqual(host.reports, []);
  assert.deepEqual(host.observer.status().watched, [{ slot: 1, state: 'open' }]);
  host.observer.stop();
});

test('the same from the higher slot, with their offer arriving before the roster names them', () => {
  const guest = engine(1);
  // The entry is made on demand for a sender the roster has yet to name.
  guest.handle(null, 'host', [{ type: 'answer', page: THEIRS, attempt: 1, connection: 'new' }], null, {
    type: 'offer',
    page: THEIRS,
    attempt: 1,
    mode: 'first',
    underEarlierId: false,
  });
  assert.deepEqual(guest.observer.status().watched, []);
  guest.facts.set(0, WAITING);
  guest.observer.identify('host', 0);
  guest.handle(0, 'host', [], WAITING, { type: 'roster' });
  guest.handle(0, 'host', [{ type: 'applyCandidate', page: THEIRS, attempt: 1 }], WAITING, {
    type: 'candidate',
    page: THEIRS,
    attempt: 1,
  });
  guest.handle(0, 'host', [], OPEN, { type: 'opened', page: THEIRS, attempt: 1 });
  assert.deepEqual(guest.reports, []);
  assert.deepEqual(guest.observer.status().watched, [{ slot: 0, state: 'open' }]);
  guest.observer.stop();
});

test('a drop in the match: the lower slot offers again and the guest clears its state when the channel opens', () => {
  const host = engine(0);
  const guest = engine(1);
  host.handle(1, 'g', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  guest.handle(0, 'h', [], WAITING, { type: 'roster' });
  guest.handle(0, 'h', [{ type: 'answer', page: PAGE, attempt: 1, connection: 'kept' }], WAITING, {
    type: 'offer',
    page: PAGE,
    attempt: 1,
    mode: 'first',
    underEarlierId: false,
  });
  host.handle(1, 'g', [{ type: 'applyAnswer', page: PAGE, attempt: 1 }], WAITING, {
    type: 'answer',
    page: PAGE,
    attempt: 1,
  });
  host.handle(1, 'g', [], OPEN, { type: 'opened', page: PAGE, attempt: 1 });
  guest.handle(0, 'h', [], OPEN, { type: 'opened', page: PAGE, attempt: 1 });
  host.observer.matchStarted();
  guest.observer.matchStarted();
  host.handle(1, 'g', [{ type: 'offer', attempt: 2, mode: 'reconnect' }], RECONNECTING, {
    type: 'lost',
    page: PAGE,
    attempt: 1,
  });
  guest.handle(0, 'h', [], RECONNECTING, { type: 'lost', page: PAGE, attempt: 1 });
  guest.handle(0, 'h', [{ type: 'answer', page: PAGE, attempt: 2, connection: 'new' }], RECONNECTING, {
    type: 'offer',
    page: PAGE,
    attempt: 2,
    mode: 'reconnect',
    underEarlierId: false,
  });
  host.handle(1, 'g', [{ type: 'applyAnswer', page: PAGE, attempt: 2 }], RECONNECTING, {
    type: 'answer',
    page: PAGE,
    attempt: 2,
  });
  guest.handle(0, 'h', [{ type: 'reset', reason: 'reconnect' }], OPEN, { type: 'opened', page: PAGE, attempt: 2 });
  host.handle(1, 'g', [], OPEN, { type: 'opened', page: PAGE, attempt: 2 });
  assert.deepEqual([...host.reports, ...guest.reports], []);
  host.observer.stop();
  guest.observer.stop();
});

test("the engine's timer takes the machine's deadline for the same wait: a startup retry agrees", () => {
  const host = engine(0);
  host.handle(1, 'g', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  host.handle(1, 'g', [{ type: 'offer', attempt: 2, mode: 'startup' }], WAITING, {
    type: 'deadline',
    deadline: 'startupAfter',
  });
  host.handle(1, 'g', [{ type: 'offer', attempt: 3, mode: 'startup' }], WAITING, {
    type: 'deadline',
    deadline: 'startupAfter',
  });
  host.handle(1, 'g', [{ type: 'stalled' }], WAITING, { type: 'deadline', deadline: 'startupAfter' });
  assert.deepEqual(host.reports, []);
  assert.deepEqual(host.observer.status().watched, [{ slot: 1, state: 'stalled' }]);
  host.observer.stop();
});

test('a difference is reported once, and the player is not watched after it', () => {
  const guest = engine(1);
  guest.handle(0, 'h', [], WAITING, { type: 'roster' });
  guest.handle(0, 'h', [{ type: 'answer', page: THEIRS, attempt: 1, connection: 'kept' }], WAITING, {
    type: 'offer',
    page: THEIRS,
    attempt: 1,
    mode: 'first',
    underEarlierId: false,
  });
  guest.handle(0, 'h', [], OPEN, { type: 'opened', page: THEIRS, attempt: 1 });
  guest.observer.matchStarted();
  // The channel died with no event; today's health check offers from either slot.
  guest.handle(
    0,
    'h',
    [
      { type: 'reset', reason: 'heal' },
      { type: 'offer', attempt: 1, mode: 'reconnect' },
    ],
    WAITING,
    { type: 'heal', page: THEIRS, attempt: 1 },
  );
  assert.equal(guest.reports.length, 1);
  assert.equal(guest.reports[0]?.message, 'heal slot=0');
  assert.match(guest.reports[0]?.old ?? '', /"offer"/);
  assert.match(guest.reports[0]?.next ?? '', /reconnecting/);
  assert.match(guest.log.join('\n'), /PEER-DISAGREE slot=0 heal/);
  assert.deepEqual(guest.observer.status().unwatched, { 0: 'disagreed on heal' });
  // Nothing more is said about that player.
  guest.handle(0, 'h', [{ type: 'drop' }], NONE, { type: 'lost', page: THEIRS, attempt: 1 });
  guest.observer.check(0);
  assert.equal(guest.reports.length, 1);
  guest.observer.stop();
});

test('a report waits for the upload token and is sent at the next comparison', () => {
  const host = engine(0, { uploadToken: false });
  host.handle(1, 'g', [], WAITING, { type: 'roster' });
  assert.equal(host.reports.length, 0);
  assert.match(host.log.join('\n'), /PEER-DISAGREE slot=1 roster/);
  host.giveToken();
  host.handle(2, 'third', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  assert.deepEqual(
    host.reports.map((r) => r.message),
    ['roster slot=1'],
  );
  host.observer.stop();
});

test('a signal with no attempt id: that player is left alone, and nothing is reported', () => {
  const host = engine(0);
  host.handle(1, 'g', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  const frame = host.observer.open(1, 'g');
  host.observer.stopWatching(1, 'g', 'their page sends no attempt id (answer)');
  host.observer.close(frame, null);
  host.handle(1, 'g', [], OPEN, { type: 'opened', page: PAGE, attempt: 1 });
  assert.deepEqual(host.reports, []);
  assert.deepEqual(host.observer.status(), {
    watched: [],
    unwatched: { 1: 'their page sends no attempt id (answer)' },
  });
  host.observer.stop();
});

test('a page that joined a match in play, and a player offered to before being watched, are left alone', () => {
  const joiner = engine(2);
  joiner.observer.joinedLate();
  joiner.handle(0, 'h', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  assert.deepEqual(joiner.reports, []);
  assert.deepEqual(joiner.observer.status().unwatched, { 0: 'this page joined a match in play' });

  const host = engine(0);
  // An offer made before the machine was watching (here: before this page held a slot).
  host.offered(1);
  host.handle(1, 'g', [], WAITING, { type: 'roster' });
  assert.deepEqual(host.reports, []);
  assert.deepEqual(host.observer.status().unwatched, { 1: 'the engine offered to this player before it was watched' });
  assert.deepEqual(host.observer.status().watched, []);
  host.observer.stop();
});

test('an engine act outside any event of a watched player is reported', () => {
  const host = engine(0);
  host.handle(1, 'g', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  host.observer.did(1, 'g', { type: 'close' });
  assert.deepEqual(
    host.reports.map((r) => r.message),
    ['unframed slot=1'],
  );
  host.observer.stop();
});

test('an event the machine is not given, after which the engine acted, ends the watch', () => {
  const host = engine(0);
  host.handle(1, 'g', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  host.handle(1, 'g', [{ type: 'drop' }], NONE, null);
  assert.deepEqual(host.observer.status().unwatched, {
    1: 'the engine acted on an event the machine was not given',
  });
  assert.deepEqual(host.reports, []);
  host.observer.stop();
});

test('a frame the engine did not close is let go, and its player is not watched', async () => {
  const host = engine(0);
  host.handle(1, 'g', [{ type: 'offer', attempt: 1, mode: 'first' }], WAITING, { type: 'roster' });
  host.observer.open(1, 'g');
  await Promise.resolve();
  assert.deepEqual(host.observer.status().unwatched, { 1: 'an event was not closed' });
  assert.deepEqual(host.reports, []);
  host.observer.stop();
});

test('an observer that throws stops and says so once; the engine is not reached', () => {
  const reports: DisagreeReport[] = [];
  const observer = createPeerObserver({
    page: PAGE,
    mySlot: () => 0,
    offersMade: () => 0,
    facts: () => {
      throw new Error('boom');
    },
    sink: (report) => reports.push(report) > 0,
    log: () => undefined,
  });
  const frame = observer.open(1, 'g');
  observer.did(1, 'g', { type: 'offer', attempt: 1, mode: 'first' });
  assert.doesNotThrow(() => observer.close(frame, { type: 'roster' }));
  assert.doesNotThrow(() => observer.check(1));
  assert.deepEqual(
    reports.map((r) => [r.message, r.next]),
    [['observer', '"threw: boom"']],
  );
});

test('attempt ids are read only when well formed; a page id is new each time', () => {
  assert.deepEqual(readAttemptId({ page: 'abc', attempt: 3 }), { page: 'abc', attempt: 3 });
  assert.equal(readAttemptId(undefined), null);
  assert.equal(readAttemptId({ page: '', attempt: 1 }), null);
  assert.equal(readAttemptId({ page: 'abc', attempt: 0 }), null);
  assert.equal(readAttemptId({ page: 'abc', attempt: 1.5 }), null);
  assert.equal(readAttemptId({ page: 'x'.repeat(65), attempt: 1 }), null);
  assert.equal(readAttemptId({ page: 'abc' }), null);
  assert.notEqual(newPageId(), newPageId());
  assert.match(newPageId(), /^[0-9a-f]{18}$/);
});
