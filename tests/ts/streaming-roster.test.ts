import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldInitiate } from '../../web/src/peer-signaling.ts';
import {
  controllerPresentMask,
  hostRosterPlan,
  isPlayerSlot,
  offersConnections,
  type RosterInput,
  type Slot,
} from '../../web/src/streaming/roster.ts';
import { lcg } from './load-shared.ts';

// ── the engine's own code, kept as an oracle ─────────────────────────────────
// web/static/netplay-streaming.js at this commit, with the engine's variables
// turned into parameters and createPeer / sendOffer into the steps they stand for.

/** `_isValidPlayerSlot` and `_controllerPresentMask` (lines 178-193). */
const oldMask = (playerSlot: Slot, known: readonly Slot[], peers: readonly Slot[]): number => {
  // Number.isInteger is false for anything but a number; the typeof only tells the compiler so.
  const valid = (slot: Slot): slot is number =>
    typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < 4;
  const slots = new Set<number>();
  const addSlot = (slot: Slot) => {
    if (valid(slot)) slots.add(slot);
  };
  addSlot(playerSlot);
  for (const slot of known) addSlot(slot);
  for (const slot of peers) addSlot(slot);
  let mask = 0;
  for (const slot of slots) mask |= 1 << slot;
  return mask & 0x0f;
};

/** `onUsersUpdated` (lines 313-365), up to where it tells the controller. */
const oldRoster = (input: RosterInput) => {
  let playerSlot = input.mySlot;
  const peers = new Map<string, { slot: Slot; step: string }>();
  for (const held of input.connections) peers.set(held.sid, { slot: held.slot, step: 'kept' });
  const myPlayerEntry = input.players.find((p) => p.socketId === input.mySid);
  if (myPlayerEntry) playerSlot = myPlayerEntry.slot;
  if (playerSlot === 0) {
    const others = input.players.filter((p) => p.socketId !== input.mySid);
    for (const p of others) {
      const held = peers.get(p.socketId);
      if (held) {
        held.slot = p.slot;
        continue;
      }
      peers.set(p.socketId, { slot: p.slot, step: input.live ? 'awaitReady' : 'offer' });
    }
    for (const s of input.spectators) {
      if (s.socketId === input.mySid) continue;
      if (peers.has(s.socketId)) continue;
      peers.set(s.socketId, { slot: null, step: input.live ? 'awaitReady' : 'offer' });
    }
  }
  return {
    mySlot: playerSlot ?? null,
    connections: [...peers].map(([sid, peer]) => ({ sid, slot: peer.slot ?? null, step: peer.step })),
  };
};

const SLOT_VALUES: readonly Slot[] = [0, 1, 2, 3, null, undefined, -1, 4, 1.5, Number.NaN];
const SIDS = ['a', 'b', 'c', 'd', 'e', 'f'];

test('a controller port is a whole number from 0 to 3', () => {
  assert.deepEqual(
    SLOT_VALUES.filter((slot) => isPlayerSlot(slot)),
    [0, 1, 2, 3],
  );
});

test('the controller mask is the engine own, for every mix of slots', () => {
  const next = lcg(7);
  const pick = (): Slot => SLOT_VALUES[next() % SLOT_VALUES.length];
  for (let round = 0; round < 3000; round++) {
    const known = Array.from({ length: next() % 4 }, pick);
    const peers = Array.from({ length: next() % 4 }, pick);
    const mine = pick();
    assert.equal(controllerPresentMask(mine, [...known, ...peers]), oldMask(mine, known, peers));
  }
  assert.equal(controllerPresentMask(0, [1, 2]), 0b0111);
  assert.equal(controllerPresentMask(null, [null]), 0);
});

test('only the host offers, which is not the rollback rule', () => {
  assert.deepEqual(
    SLOT_VALUES.filter((slot) => offersConnections(slot)),
    [0],
  );
  // The mesh has the lower slot offer, and a late joiner offer to everyone.
  assert.equal(shouldInitiate(false, false, false, false, 1, 2), true);
  assert.equal(offersConnections(1), false);
  assert.equal(shouldInitiate(false, true, false, false, 2, 0), true);
  assert.equal(offersConnections(2), false);
});

test('a roster does to the connection table what the engine does, over random rooms', () => {
  const next = lcg(11);
  const some = <T>(items: readonly T[]): T[] => items.filter(() => next() % 2 === 0);
  for (let round = 0; round < 4000; round++) {
    const input: RosterInput = {
      mySid: next() % 8 === 0 ? undefined : 'a',
      mySlot: SLOT_VALUES[next() % 6],
      players: some(SIDS).map((socketId) => ({ socketId, slot: SLOT_VALUES[next() % 5] })),
      spectators: some(SIDS).map((socketId) => ({ socketId })),
      connections: some(SIDS.slice(1)).map((sid) => ({ sid, slot: SLOT_VALUES[next() % 6] })),
      live: next() % 2 === 0,
    };
    assert.deepEqual(hostRosterPlan(input), oldRoster(input), JSON.stringify(input));
  }
});

test('the host offers to new pages in the lobby, and waits for a late joiner to be ready', () => {
  const room = {
    mySid: 'host',
    mySlot: 0,
    players: [
      { socketId: 'host', slot: 0 },
      { socketId: 'p2', slot: 1 },
      { socketId: 'p3', slot: 2 },
    ],
    spectators: [{ socketId: 'watcher' }],
    connections: [{ sid: 'p2', slot: 3 }],
  };
  assert.deepEqual(hostRosterPlan({ ...room, live: false }).connections, [
    { sid: 'p2', slot: 1, step: 'kept' },
    { sid: 'p3', slot: 2, step: 'offer' },
    { sid: 'watcher', slot: null, step: 'offer' },
  ]);
  assert.deepEqual(
    hostRosterPlan({ ...room, live: true }).connections.map((c) => c.step),
    ['kept', 'awaitReady', 'awaitReady'],
  );
});

test('a guest or a spectator changes nothing: it waits to be offered to', () => {
  for (const mySlot of [1, 2, 3, null]) {
    const plan = hostRosterPlan({
      mySid: 'me',
      mySlot,
      players: [
        { socketId: 'host', slot: 0 },
        { socketId: 'other', slot: 2 },
      ],
      spectators: [{ socketId: 'watcher' }],
      connections: [{ sid: 'host', slot: 0 }],
      live: false,
    });
    assert.deepEqual(plan, { mySlot, connections: [{ sid: 'host', slot: 0, step: 'kept' }] });
  }
});
