import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disconnectDisposition } from '../../web/src/peer-signaling.ts';
import { checkRelayed } from '../../web/src/relay.ts';
import type { Slot } from '../../web/src/streaming/roster.ts';
import {
  channelOpenAction,
  connectionLost,
  lateJoinReadyAction,
  signalAction,
  signalKind,
  type LateJoinReadyInput,
  type SignalKind,
} from '../../web/src/streaming/signal.ts';
import { lcg } from './load-shared.ts';

// ── the engine's own code, kept as an oracle ─────────────────────────────────
// web/static/netplay-streaming.js at this commit, with the engine's variables
// turned into parameters and its effects into the names of what they do.

type Signal = { sender?: string; offer?: object; answer?: object; candidate?: object };

/** `onWebRTCSignal` (lines 582-617). */
const oldSignal = (data: Signal | null, peers: Map<string, Slot>, known: Map<string, Slot>) => {
  const nothing = { create: false, slot: null, act: 'none' };
  if (!data) return nothing;
  const senderSid = data.sender;
  if (!senderSid) return nothing;
  let created: { slot: number | null } | null = null;
  if (data.offer && !peers.has(senderSid)) {
    created = { slot: known.has(senderSid) ? (known.get(senderSid) ?? null) : null };
    peers.set(senderSid, created.slot);
  }
  if (!peers.has(senderSid)) return nothing;
  let act = 'none';
  if (data.offer) act = 'offer';
  else if (data.answer) act = 'answer';
  else if (data.candidate) act = 'candidate';
  return { create: created !== null, slot: created ? created.slot : null, act };
};

/** `onDataMessage` (lines 619-655); `checkRelayed` is the same function the engine calls. */
const oldLateJoinReady = (input: LateJoinReadyInput) => {
  const ignore = { act: 'ignore', create: false, slot: null };
  const data = input.message;
  if (!data || data.type !== 'streaming-late-join-ready') return ignore;
  if (input.mySlot !== 0) return ignore;
  const from = checkRelayed(data);
  if (!from.allowed) return ignore;
  const remoteSid = from.sid;
  if (!remoteSid || remoteSid === input.mySid) return ignore;
  const known = input.roster.find((player) => player.sid === remoteSid);
  if (!known && from.slot !== null) return ignore;
  const remoteSlot = known ? known.slot : null;
  const peer = input.connections.find((connection) => connection.sid === remoteSid);
  if (peer?.linked) return ignore;
  let slot = peer?.slot;
  let pendingOffer = false;
  if (!peer) slot = remoteSlot;
  else {
    if (remoteSlot !== null && remoteSlot !== undefined) slot = remoteSlot;
    pendingOffer = peer.pendingOffer;
  }
  return { act: pendingOffer ? 'resend' : 'offer', create: !peer, slot: slot ?? null };
};

/** `onOpen` in setupDataChannel (lines 662-704). */
const oldChannelOpen = (s: Parameters<typeof channelOpenAction>[0]): string => {
  if (s.mySlot === 0) {
    if (!s.running) return 'startHost';
    else if (s.live) {
      if (s.hasEntry) return s.hasTracks ? 'tracksPresent' : 'addTracks';
      return 'none';
    } else return 'streamNotReady';
  } else if (!s.spectator) return 'startGuestInput';
  return 'spectator';
};

const BOOLS = [false, true];
const SLOTS: readonly Slot[] = [0, 1, 2, 3, null, undefined];

test('a signal is read as its first set part', () => {
  assert.equal(signalKind({ offer: {}, answer: {}, candidate: {} }), 'offer');
  assert.equal(signalKind({ answer: {}, candidate: {} }), 'answer');
  assert.equal(signalKind({ candidate: {} }), 'candidate');
  assert.equal(signalKind({ candidate: null }), 'none');
  assert.equal(signalKind({}), 'none');
});

test('an incoming signal does what the engine does with it, for every case', () => {
  const parts: readonly Signal[] = [{}, { offer: {} }, { answer: {} }, { candidate: {} }, { offer: {}, answer: {} }];
  for (const part of parts) {
    for (const sender of ['p2', '', undefined]) {
      for (const hasEntry of BOOLS) {
        for (const knownSlot of SLOTS) {
          for (const onRoster of BOOLS) {
            const data: Signal = sender === undefined ? part : { ...part, sender };
            const peers = new Map<string, Slot>(hasEntry ? [['p2', 1]] : []);
            const known = new Map<string, Slot>(onRoster ? [['p2', knownSlot]] : []);
            const mine = signalAction(Boolean(data.sender), signalKind(data), hasEntry, known.get('p2'));
            assert.deepEqual(mine, oldSignal(data, peers, known), JSON.stringify({ data, hasEntry, knownSlot }));
          }
        }
      }
    }
  }
  assert.deepEqual(oldSignal(null, new Map(), new Map()), signalAction(false, 'none', false, undefined));
});

test('only an offer makes a connection; an answer or a candidate for none is dropped', () => {
  assert.deepEqual(signalAction(true, 'offer', false, 2), { create: true, slot: 2, act: 'offer' });
  assert.deepEqual(signalAction(true, 'offer', false, undefined), { create: true, slot: null, act: 'offer' });
  assert.deepEqual(signalAction(true, 'offer', true, 2), { create: false, slot: null, act: 'offer' });
  const later: readonly SignalKind[] = ['answer', 'candidate'];
  for (const kind of later) {
    assert.equal(signalAction(true, kind, false, 1).act, 'none');
    assert.equal(signalAction(true, kind, true, 1).act, kind);
  }
});

const stamped = (sid: string, slot: number | null) => ({
  type: 'streaming-late-join-ready',
  senderSid: 'whatever-the-page-wrote',
  knFrom: { sid, slot, owner: false },
});

test('a late joiner saying it is ready leads to what the engine does, over random rooms', () => {
  const next = lcg(23);
  const sids = ['host', 'p2', 'p3', 'w1'];
  const some = <T>(items: readonly T[]): T[] => items.filter(() => next() % 2 === 0);
  const messages = [
    ...sids.flatMap((sid) => [stamped(sid, null), stamped(sid, 1), stamped(sid, 2)]),
    { type: 'streaming-late-join-ready', senderSid: 'p2' },
    { type: 'streaming-late-join-ready', knFrom: 'not a stamp' },
    { ...stamped('p2', 1), type: 'late-join-ready' },
    stamped('', 1),
  ];
  const acts = new Set<string>();
  for (let round = 0; round < 6000; round++) {
    const input: LateJoinReadyInput = {
      message: messages[next() % messages.length] ?? {},
      mySlot: next() % 5 === 0 ? 1 : 0,
      mySid: next() % 9 === 0 ? undefined : 'host',
      roster: some(sids).map((sid) => ({ sid, slot: SLOTS[next() % SLOTS.length] })),
      connections: some(sids).map((sid) => ({
        sid,
        slot: SLOTS[next() % SLOTS.length],
        linked: next() % 4 === 0,
        pendingOffer: next() % 2 === 0,
      })),
    };
    const mine = lateJoinReadyAction(input);
    acts.add(`${mine.act}${mine.create ? '+create' : ''}`);
    assert.deepEqual(mine, oldLateJoinReady(input), JSON.stringify(input));
  }
  assert.deepEqual([...acts].sort(), ['ignore', 'offer', 'offer+create', 'resend']);
});

test('the sender is the one the server stamped, not the one the message names', () => {
  const room = { mySlot: 0, mySid: 'host', roster: [{ sid: 'p3', slot: 2 }], connections: [] };
  assert.deepEqual(lateJoinReadyAction({ ...room, message: stamped('p3', 2) }), {
    act: 'offer',
    create: true,
    slot: 2,
  });
  // No stamp: refused, whoever it claims to be.
  const unstamped = { type: 'streaming-late-join-ready', senderSid: 'p3' };
  assert.equal(lateJoinReadyAction({ ...room, message: unstamped }).act, 'ignore');
  // A player the roster does not list yet waits for the roster; a spectator is let through.
  assert.equal(lateJoinReadyAction({ ...room, message: stamped('p4', 3) }).act, 'ignore');
  assert.deepEqual(lateJoinReadyAction({ ...room, message: stamped('w1', null) }), {
    act: 'offer',
    create: true,
    slot: null,
  });
});

test('a data channel opening leads to what the engine does, for every state', () => {
  for (const mySlot of SLOTS) {
    for (const spectator of BOOLS) {
      for (const running of BOOLS) {
        for (const live of BOOLS) {
          for (const hasEntry of BOOLS) {
            for (const hasTracks of BOOLS) {
              const state = { mySlot, spectator, running, live, hasEntry, hasTracks };
              assert.equal(channelOpenAction(state), oldChannelOpen(state), JSON.stringify(state));
            }
          }
        }
      }
    }
  }
});

test('a failed or disconnected connection is dropped at once, where the mesh would reconnect', () => {
  // onconnectionstatechange in createPeer (lines 374-382).
  const oldLost = (state: string, current: boolean): boolean => {
    if (state === 'failed' || state === 'disconnected') {
      if (!current) return false;
      return true;
    }
    return false;
  };
  for (const state of ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']) {
    for (const current of BOOLS) assert.equal(connectionLost(state, current), oldLost(state, current));
  }
  // The rollback rule for the same event during a match.
  assert.equal(disconnectDisposition(false, false, false, false, true), 'reconnect');
});
