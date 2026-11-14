import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installsState, relayAllowed } from '../../web/src/relay-sender.ts';
import { checkRelayed, RELAY_SENDER_KEY } from '../../web/src/relay.ts';

const STATE_TYPES = ['save-state', 'late-join-state', 'sync-state-socket'];
const REQUEST_TYPES = [
  'request-late-join',
  'sync-request-full-socket',
  'late-join-ready',
  'rom-accepted',
  'streaming-late-join-ready',
];

const stamped = (type: string, sid: string, slot: number | null, owner: boolean) => ({
  type,
  [RELAY_SENDER_KEY]: { sid, slot, owner },
});

test('the messages that install emulator state are the three the engine loads', () => {
  for (const type of STATE_TYPES) assert.equal(installsState(type), true);
  for (const type of [...REQUEST_TYPES, 'mode-select', '']) assert.equal(installsState(type), false);
});

test('emulator state is taken only from slot 0', () => {
  for (const type of STATE_TYPES) {
    assert.equal(relayAllowed(type, true, 0, true), true);
    assert.equal(relayAllowed(type, true, 0, false), true);
    assert.equal(relayAllowed(type, true, 1, false), false);
    // A spectator, even one who owns the room.
    assert.equal(relayAllowed(type, true, -1, false), false);
    assert.equal(relayAllowed(type, true, -1, true), false);
  }
});

test('mode-select is taken only from the owner', () => {
  assert.equal(relayAllowed('mode-select', true, 0, true), true);
  assert.equal(relayAllowed('mode-select', true, -1, true), true);
  assert.equal(relayAllowed('mode-select', true, 0, false), false);
  assert.equal(relayAllowed('mode-select', true, -1, false), false);
});

test('requests are allowed from any member; the stamp says who to answer', () => {
  for (const type of REQUEST_TYPES) {
    assert.equal(relayAllowed(type, true, 1, false), true);
    assert.equal(relayAllowed(type, true, -1, false), true);
  }
});

test('a message with no stamp, from a server older than the stamp, is allowed as before', () => {
  for (const type of [...STATE_TYPES, ...REQUEST_TYPES, 'mode-select']) {
    assert.equal(relayAllowed(type, false, -1, false), true);
  }
  assert.deepEqual(checkRelayed({ type: 'save-state' }), {
    allowed: true,
    stamped: false,
    sid: null,
    slot: null,
    owner: false,
  });
});

test("a spectator's state is refused, and its declared sender is not the one reported", () => {
  const forged = { ...stamped('late-join-state', 'sid-spec', null, false), senderSid: 'sid-host' };
  assert.deepEqual(checkRelayed(forged), {
    allowed: false,
    stamped: true,
    sid: 'sid-spec',
    slot: null,
    owner: false,
  });
});

test("the host's state is allowed and reported with the host's socket", () => {
  assert.deepEqual(checkRelayed(stamped('sync-state-socket', 'sid-host', 0, true)), {
    allowed: true,
    stamped: true,
    sid: 'sid-host',
    slot: 0,
    owner: true,
  });
});

test('a request reports the socket that really sent it', () => {
  const request = { ...stamped('request-late-join', 'sid-guest', 1, false), requesterSid: 'sid-other' };
  const verdict = checkRelayed(request);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.sid, 'sid-guest');
});

test('a stamp that cannot be read is refused, not treated as missing', () => {
  for (const bad of [null, undefined, 'sid-host', {}, { sid: 'a', slot: '0', owner: true }, { sid: 1, slot: 0 }]) {
    const verdict = checkRelayed({ type: 'request-late-join', [RELAY_SENDER_KEY]: bad });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.stamped, true);
  }
});

test('a stamped message with no type is allowed: no handler acts on it', () => {
  assert.equal(checkRelayed({ [RELAY_SENDER_KEY]: { sid: 'sid-spec', slot: null, owner: false } }).allowed, true);
});
