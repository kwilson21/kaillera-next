import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SafeStorage } from '../../web/src/kn-state.ts';
import {
  hostReturnClock,
  hostReturnDuration,
  hostReturnKey,
  playerReturnKey,
  hostReturnSeconds,
  readHostReturn,
  RoomIdentity,
} from '../../web/src/play/host-return.ts';

const storage = (): SafeStorage => {
  const stores = { localStorage: new Map<string, string>(), sessionStorage: new Map<string, string>() };
  return {
    keys: (store, prefix) => [...stores[store].keys()].filter((key) => key.startsWith(prefix)),
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

test('old creation bookmarks keep only a bounded history of case-sensitive room codes', () => {
  const stores = storage();
  for (let i = 0; i < 40; ++i) {
    const seat = new RoomIdentity('Room' + i, stores);
    seat.receiveToken(credential(seat.persistentId, seat.room), null, true);
    seat.leaveRoom();
  }
  assert.equal(stores.keys!('localStorage', '').length, 32);
  assert.equal(stores.keys!('localStorage', 'kn-host-return:').length, 0);
  assert.equal(new RoomIdentity('Room39', stores).wasInRoom(), true);
  assert.equal(new RoomIdentity('room39', stores).wasInRoom(), false);
  assert.equal(new RoomIdentity('Unused', stores).wasInRoom(), false);
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

test('a player can return from a new tab without claiming another guest’s seat or a spectator seat', () => {
  const stores = storage();
  const first = new RoomIdentity('RoomA', stores);
  const firstToken = credential(first.persistentId, first.room);
  first.receiveToken(firstToken, null, false, true);
  stores.remove('sessionStorage', 'kn-player-id');
  const second = new RoomIdentity(first.room, stores);
  const secondToken = credential(second.persistentId, second.room);
  second.receiveToken(secondToken, null, false);
  assert.equal(second.savedPlayer(second.persistentId), null);
  second.rememberPlayer(second.persistentId);
  assert.equal(second.savedPlayer(second.persistentId)?.token, secondToken);
  assert.equal(second.savedHost(), null);
  assert.equal(second.savedPlayer(first.persistentId)?.token, firstToken);
  second.rememberHost(second.persistentId);
  assert.equal(second.savedPlayer(second.persistentId), null);
  assert.equal(second.savedHost()?.token, secondToken);
  first.leaveRoom();
  assert.equal(stores.get('localStorage', playerReturnKey(first.room, first.persistentId)), null);
  assert.equal(second.savedHost()?.token, secondToken);
  assert.equal(second.savedPlayer(first.persistentId), null);
});

test('refusing a signed guest entry does not discard a newer credential or a promoted host seat', () => {
  const stores = storage();
  const seat = new RoomIdentity('RoomA', stores);
  const older = credential(seat.persistentId, seat.room, 50);
  const newer = credential(seat.persistentId, seat.room);
  seat.receiveToken(older, null, false, true);
  seat.receiveToken(newer, null, false, true);
  seat.discardPlayer(older);
  assert.equal(seat.savedPlayer(seat.persistentId)?.token, newer);
  seat.rememberHost(seat.persistentId);
  seat.discardPlayer(newer);
  assert.equal(seat.savedHost()?.token, newer);
});
