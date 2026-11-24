import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SafeStorage } from '../../web/src/kn-state.ts';
import {
  hostReturnClock,
  hostReturnDuration,
  hostReturnKey,
  hostReturnSeconds,
  readHostReturn,
  RoomIdentity,
} from '../../web/src/play/host-return.ts';

const storage = (): SafeStorage => {
  const stores = { localStorage: new Map<string, string>(), sessionStorage: new Map<string, string>() };
  return {
    get: (store, key) => stores[store].get(key) ?? null,
    set: (store, key, value) => {
      stores[store].set(key, value);
    },
    remove: (store, key) => {
      stores[store].delete(key);
    },
  };
};

const credential = (pid: string, room: string, exp = Math.floor(Date.now() / 1000) + 600) =>
  Buffer.from(JSON.stringify({ k: 'reconnect', room, pid, exp })).toString('base64url') + '.' + '0'.repeat(64);

test('the host countdown uses server time and elapsed local time regardless of the clock on the phone', () => {
  assert.equal(hostReturnClock({}, 400), null);
  assert.equal(hostReturnClock({ hostReturnDeadline: 23000 }, 400), null);
  const clock = hostReturnClock({ hostReturnDeadline: 23000, serverTime: 1500 }, 400);
  assert.equal(hostReturnSeconds(clock, 400), 22);
  assert.equal(hostReturnDuration(hostReturnSeconds(clock, 2000)), '0:20');
  assert.equal(hostReturnSeconds(clock, 24000), 0);
  assert.equal(hostReturnDuration(120), '2:00');
});

test('only a current room-specific host credential is offered to another tab', () => {
  const stores = storage();
  const seat = new RoomIdentity('RoomA', stores);
  const token = credential(seat.persistentId, 'RoomA');
  seat.receiveToken(token, null, false);
  assert.equal(seat.savedHost(), null);
  seat.rememberHost(seat.persistentId);
  assert.equal(seat.savedHost()?.token, token);
  assert.equal(readHostReturn('rooma', token), null);
  assert.equal(readHostReturn('RoomA', credential(seat.persistentId, 'RoomA', 1)), null);
  assert.equal(new RoomIdentity('RoomB', stores).reconnectToken, '');
  const guest = new RoomIdentity('RoomB', stores);
  guest.receiveToken(credential(guest.persistentId, 'RoomB'), null, false);
  assert.equal(new RoomIdentity('RoomA', stores).reconnectToken, token);
});

test('a host saves the server-issued ticket and can return from its tab even when the device clock runs ahead', () => {
  const stores = storage();
  const seat = new RoomIdentity('RoomA', stores);
  const token = credential(seat.persistentId, 'RoomA', 5000);
  seat.receiveToken(token, null, true);
  assert.equal(stores.get('localStorage', hostReturnKey('RoomA')), token);
  assert.equal(new RoomIdentity('RoomA', stores).hasRoomToken(), true);
  assert.equal(seat.savedHost(4000000)?.token, token);
  assert.equal(seat.savedHost(5000000), null);
  seat.leaveRoom();
  assert.equal(stores.get('localStorage', hostReturnKey('RoomA')), null);
});

test('a declined return gets a separate seat, and a refused older credential cannot erase a renewed one', () => {
  const stores = storage();
  const seat = new RoomIdentity('RoomA', stores);
  const pid = seat.persistentId;
  const first = credential(pid, 'RoomA', Math.floor(Date.now() / 1000) + 120);
  const renewed = credential(pid, 'RoomA');
  seat.receiveToken(first, null, true);
  const offer = seat.savedHost()!;
  seat.receiveToken(renewed, null, true);
  seat.discardRefused(first);
  assert.equal(stores.get('localStorage', hostReturnKey('RoomA')), renewed);
  seat.joinSeparately(offer);
  assert.notEqual(seat.persistentId, pid);
  assert.equal(seat.reconnectToken, '');
  seat.forgetHost();
  assert.equal(seat.savedHost()?.token, renewed);
  seat.receiveToken(renewed, offer, true);
  seat.acceptReturn(offer);
  assert.equal(seat.persistentId, pid);
  assert.equal(seat.reconnectToken, renewed);
  seat.forgetHost();
  assert.equal(seat.savedHost(), null);
});
