/**
 * The per-peer machine driven from the engine's events (web/src/peer-driver.ts).
 *
 * Each test plays the engine's part by hand: it opens a frame, closes it
 * with the event, and checks the state the machine reached and which
 * players are left to the engine (an old page, a late joiner).
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPeerDriver, type DrivenEvent } from '../../web/src/peer-driver.ts';

const PAGE = 'page-mine';
const THEIRS = 'page-theirs';

/** An engine at slot `mySlot`. */
const engine = (mySlot: number) => {
  const log: string[] = [];
  const offers = new Map<number, number>();
  const driver = createPeerDriver({
    page: PAGE,
    mySlot: () => mySlot,
    offersMade: (slot) => offers.get(slot) ?? 0,
    log: (line) => log.push(line),
  });
  /** One event as the engine handles it; `offer` counts an offer the engine made while handling it. */
  const handle = (slot: number | null, key: string, event: DrivenEvent | null, { offer = false } = {}): void => {
    const frame = driver.open(slot, key);
    if (offer && slot !== null) offers.set(slot, (offers.get(slot) ?? 0) + 1);
    driver.close(frame, event);
  };
  const state = () => driver.status().watched;
  return { driver, log, handle, state, offered: (slot: number) => offers.set(slot, (offers.get(slot) ?? 0) + 1) };
};

test('the pair connects in the lobby and starts: the lower slot reaches open', () => {
  const host = engine(0);
  host.handle(1, 'guest', { type: 'roster' }, { offer: true });
  host.handle(1, 'guest', { type: 'answer', page: PAGE, attempt: 1 });
  host.handle(1, 'guest', { type: 'candidate', page: PAGE, attempt: 1 });
  host.handle(1, 'guest', { type: 'opened', page: PAGE, attempt: 1 });
  host.driver.matchStarted();
  assert.deepEqual(host.state(), [{ slot: 1, state: 'open' }]);
  host.driver.stop();
});

test('the same from the higher slot, with their offer arriving before the roster names them', () => {
  const guest = engine(1);
  guest.handle(null, 'host', { type: 'offer', page: THEIRS, attempt: 1, mode: 'first', underEarlierId: false });
  // Held until the roster names the sender's slot.
  assert.deepEqual(guest.state(), []);
  guest.driver.identify('host', 0);
  guest.handle(0, 'host', { type: 'roster' });
  guest.handle(0, 'host', { type: 'candidate', page: THEIRS, attempt: 1 });
  guest.handle(0, 'host', { type: 'opened', page: THEIRS, attempt: 1 });
  assert.deepEqual(guest.state(), [{ slot: 0, state: 'open' }]);
  guest.driver.stop();
});

test("the engine's timer takes the machine's deadline for the same wait: startup retries, then stalled", () => {
  const host = engine(0);
  host.handle(1, 'g', { type: 'roster' }, { offer: true });
  host.handle(1, 'g', { type: 'deadline', deadline: 'startupAfter' }, { offer: true });
  host.handle(1, 'g', { type: 'deadline', deadline: 'startupAfter' }, { offer: true });
  host.handle(1, 'g', { type: 'deadline', deadline: 'startupAfter' });
  assert.deepEqual(host.state(), [{ slot: 1, state: 'stalled' }]);
  host.driver.stop();
});

test('a drop in the match: the lower slot reconnects and is open again', () => {
  const host = engine(0);
  host.handle(1, 'g', { type: 'roster' }, { offer: true });
  host.handle(1, 'g', { type: 'answer', page: PAGE, attempt: 1 });
  host.handle(1, 'g', { type: 'opened', page: PAGE, attempt: 1 });
  host.driver.matchStarted();
  host.handle(1, 'g', { type: 'lost', page: PAGE, attempt: 1 }, { offer: true });
  assert.notDeepEqual(host.state(), [{ slot: 1, state: 'open' }]);
  host.handle(1, 'g', { type: 'answer', page: PAGE, attempt: 2 });
  host.handle(1, 'g', { type: 'opened', page: PAGE, attempt: 2 });
  assert.deepEqual(host.state(), [{ slot: 1, state: 'open' }]);
  host.driver.stop();
});

test('a signal with no attempt id: that player is left to the engine', () => {
  const guest = engine(1);
  guest.handle(0, 'h', { type: 'roster' });
  guest.driver.stopWatching(0, 'h', 'their page sends no attempt id (offer)');
  guest.handle(0, 'h', { type: 'opened', page: THEIRS, attempt: 1 });
  assert.deepEqual(guest.state(), []);
  assert.deepEqual(guest.driver.status().unwatched, { 0: 'their page sends no attempt id (offer)' });
  guest.driver.stop();
});

test('a page that joined a match in play, and a player offered to before it had a machine, are left to the engine', () => {
  const late = engine(2);
  late.driver.joinedLate();
  late.handle(0, 'h', { type: 'roster' });
  assert.deepEqual(late.state(), []);
  assert.equal(late.driver.status().unwatched[0], 'this page joined a match in play');

  const host = engine(0);
  host.offered(1);
  host.handle(1, 'g', { type: 'roster' });
  assert.deepEqual(host.state(), []);
  assert.equal(host.driver.status().unwatched[1], 'the engine offered to this player before it had a machine');
});

test('a frame the engine did not close is let go, and its player is left to the engine', async () => {
  const host = engine(0);
  host.driver.open(1, 'g');
  await Promise.resolve();
  assert.deepEqual(host.state(), []);
  assert.equal(host.driver.status().unwatched[1], 'an event was not closed');
});

test('signals held past the bound before the roster names the player leave them to the engine', () => {
  const guest = engine(1);
  for (let i = 0; i < 65; i++) guest.handle(null, 'h', { type: 'candidate', page: THEIRS, attempt: 1 });
  guest.driver.identify('h', 0);
  assert.equal(guest.driver.status().unwatched[0], 'too many signals before the roster named the player');
});

test('a driver that throws stops and says so once; the engine is not reached', () => {
  const log: string[] = [];
  const driver = createPeerDriver({
    page: PAGE,
    mySlot: () => {
      throw new Error('boom');
    },
    offersMade: () => 0,
    log: (line) => log.push(line),
  });
  assert.equal(driver.open(1, 'g'), null);
  assert.equal(driver.open(1, 'g'), null);
  assert.deepEqual(log, ['PEER-DRIVER stopped: threw boom']);
});
