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

import { PEER_TIMING } from '../../web/src/peer-connection.ts';

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

// ── The mesh health check: the machine decides (specs/peer_connection.qnt,
//    peer_connection_heal_one_side) ─────────────────────────────────────

/** A pair connected and in a match, as the engine at `mySlot` sees it. */
const connectedInMatch = (mySlot: number, theirSlot: number) => {
  const page = engine(mySlot);
  const lower = mySlot < theirSlot;
  page.handle(theirSlot, 'k', { type: 'roster' }, { offer: lower });
  if (lower) {
    page.handle(theirSlot, 'k', { type: 'answer', page: PAGE, attempt: 1 });
    page.handle(theirSlot, 'k', { type: 'opened', page: PAGE, attempt: 1 });
  } else {
    page.handle(theirSlot, 'k', { type: 'offer', page: THEIRS, attempt: 1, mode: 'first', underEarlierId: false });
    page.handle(theirSlot, 'k', { type: 'opened', page: THEIRS, attempt: 1 });
  }
  page.driver.matchStarted();
  return page;
};
const heal = (page: ReturnType<typeof engine>, theirSlot: number, found = { page: PAGE, attempt: 1 }) =>
  page.driver.decideHeal(page.driver.open(theirSlot, 'k'), found);

test('heal: the lower slot offers a reconnect', () => {
  const host = connectedInMatch(0, 1);
  const commands = heal(host, 1);
  assert.ok(commands);
  assert.deepEqual(
    commands.filter((c) => c.type === 'offer').map((c) => (c.type === 'offer' ? c.mode : '')),
    ['reconnect'],
  );
  assert.deepEqual(host.state(), [{ slot: 1, state: 'reconnecting.offering' }]);
  host.driver.stop();
});

test('heal: the higher slot does not offer; it waits for the lower slot', () => {
  const guest = connectedInMatch(1, 0);
  const commands = heal(guest, 0, { page: THEIRS, attempt: 1 });
  assert.ok(commands);
  assert.equal(
    commands.some((c) => c.type === 'offer'),
    false,
  );
  assert.deepEqual(guest.state(), [{ slot: 0, state: 'reconnecting.awaitingOffer' }]);
  guest.driver.stop();
});

test('heal: a player the machine does not drive is left to the engine (null)', () => {
  const late = engine(2);
  late.driver.joinedLate();
  assert.equal(heal(late, 0), null);
  const old = connectedInMatch(1, 0);
  old.driver.stopWatching(0, 'k', 'their page sends no attempt id (offer)');
  assert.equal(heal(old, 0, { page: THEIRS, attempt: 1 }), null);
  old.driver.stop();
});

test('heal, old against new: only the higher slot changes, from offering to waiting', () => {
  // The engine's rule before: every slot whose channel is dead resets and offers.
  const oldRuleOffers = (_mySlot: number, _theirSlot: number) => true;
  const pairs: readonly (readonly [number, number])[] = [
    [0, 1],
    [0, 2],
    [1, 2],
    [1, 0],
    [2, 0],
    [3, 1],
  ];
  for (const [mySlot, theirSlot] of pairs) {
    const page = connectedInMatch(mySlot, theirSlot);
    const commands = heal(
      page,
      theirSlot,
      mySlot < theirSlot ? { page: PAGE, attempt: 1 } : { page: THEIRS, attempt: 1 },
    );
    assert.ok(commands, `${mySlot}->${theirSlot}`);
    const offers = commands.some((c) => c.type === 'offer');
    assert.equal(offers, mySlot < theirSlot, `${mySlot}->${theirSlot}`);
    assert.equal(offers === oldRuleOffers(mySlot, theirSlot), mySlot < theirSlot, `${mySlot}->${theirSlot}`);
    page.driver.stop();
  }
});

test('a reconnect on an unlabelled peer uses the same scoped retries and stops with the session', async () => {
  const commands: string[] = [];
  const driver = createPeerDriver({
    page: 'mine',
    mySlot: () => 0,
    offersMade: () => 4,
    log: () => {},
    timing: { ...PEER_TIMING, attemptAfterMs: 500, retryAfterMs: 5, giveUpAfterMs: 2000 },
  });
  driver.stopWatching(1, 'old', 'unlabelled page');
  const reconnect = driver.reconnect(1, (command) =>
    commands.push(command.type === 'offer' ? `offer ${command.attempt}` : command.type),
  );
  assert.ok(reconnect);
  reconnect.start();
  reconnect.failed({ page: 'mine', attempt: 5 });
  reconnect.failed({ page: 'mine', attempt: 5 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(commands, ['offer 5', 'backoff', 'offer 6']);
  reconnect.failed({ page: 'mine', attempt: 5 });
  reconnect.failed({ page: 'mine', attempt: 6 });
  driver.sessionEnded();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(commands, ['offer 5', 'backoff', 'offer 6', 'backoff']);
  driver.stop();
});

test('only the lower slot owns offers and a replaced controller cannot fail its successor', () => {
  const high = engine(1);
  assert.equal(
    high.driver.reconnect(0, () => assert.fail('higher slot offered')),
    null,
  );
  high.driver.stop();
  const low = connectedInMatch(0, 1);
  const first: string[] = [],
    second: string[] = [];
  const old = low.driver.reconnect(1, (c) => first.push(c.type));
  assert.ok(old);
  old.start();
  const current = low.driver.reconnect(1, (c) => second.push(c.type));
  assert.ok(current);
  current.start();
  old.failed({ page: PAGE, attempt: 2 });
  old.stop();
  assert.deepEqual(first, ['offer']);
  assert.deepEqual(second, ['offer']);
  current.stop();
  low.driver.stop();
});
