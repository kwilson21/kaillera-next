import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { matchSave, confirmInputs, recentAtDisconnect } from '../../web/src/match-save.ts';
import type { RoomPlayer } from '../../web/src/protocol.ts';

const seat = (slot: number, away = false): RoomPlayer => ({
  slot,
  away,
  playerName: 'player',
  socketId: String(slot),
  romReady: true,
  inputType: 'keyboard',
  deviceType: 'desktop',
});
const config = {
  sessionId: 'room',
  matchId: 'source-fight',
  mode: 'rollback' as const,
  romHash: 'rom',
  initialPlayers: { players: { guest: seat(3), host: seat(0) } },
};
const identity = matchSave.scope(config, 'core')!;
test('a blocked save lookup falls back and closes the database if the open later succeeds', async (t) => {
  const close = t.mock.fn();
  const request = { result: { close }, onsuccess() {}, onblocked() {} };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        queueMicrotask(() => request.onblocked());
        return request;
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  assert.equal(await matchSave.available(identity), false);
  request.onsuccess();
  assert.equal(close.mock.callCount(), 1);
});
test('a save names permanent owners in their actual controller ports', () => {
  assert.deepEqual(identity.roster, ['host', null, null, 'guest']);
  assert.equal(identity.hostId, 'host');
  const invalidRosters: Record<string, RoomPlayer>[] = [
    { host: seat(0) },
    { host: seat(0), guest: seat(2, true) },
    { host: seat(0), guest: seat(0) },
    { guest: seat(2) },
  ];
  for (const players of invalidRosters) {
    assert.equal(matchSave.scope({ ...config, initialPlayers: { players } }, 'core'), null);
  }
});
test('a save was recent at disconnect even if the host returns in the last second', () => {
  const now = 500_000;
  assert.equal(recentAtDisconnect(now - 122_000, 1000, now), true);
  assert.equal(recentAtDisconnect(now - 120_000, 119_900, now), false);
  assert.equal(recentAtDisconnect(now - 3000, 0, now), false);
  assert.equal(recentAtDisconnect(now - 131_000, 100, now), false);
});
const snapshot = {
  bytes: Uint8Array.of(1),
  hidden: new Uint32Array(18),
  hle: Uint8Array.of(3),
  fifo: new Uint32Array(0),
  sram: Uint8Array.of(5),
};
const pad = [1, 0, 0, 0, 0] as const;
const rows = [
  [0, [pad, pad]],
  [3, [pad, pad]],
] as const;
const stamp = Date.now();
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sectionHashes = Object.values(snapshot).map((x) => hash(new Uint8Array(x.buffer)));
const inputRuntime = '[2,true,"retro"]';
const sealFor = (mode: string) =>
  hash(
    JSON.stringify([
      1,
      'room',
      'source-fight',
      'host',
      mode,
      'rom',
      'core',
      identity.roster,
      1234,
      stamp,
      123,
      inputRuntime,
      1,
      rows,
      sectionHashes,
    ]),
  );
const save = {
  scope: identity,
  frame: 1234,
  capturedAt: stamp,
  rngSeed: 123,
  inputRuntime,
  delay: 1,
  rows,
  seal: sealFor(identity.mode),
  snapshot,
};
test('only the complete signed frame, roster, history and cartridge memory install', async () => {
  assert.equal(await matchSave.verify(save, identity), true);
  for (const scope of [
    { ...identity, romHash: 'other' },
    { ...identity, mode: 'lockstep' as const },
    { ...identity, coreHash: 'other' },
    { ...identity, roster: ['host', 'guest'] },
  ]) {
    assert.equal(await matchSave.verify(save, scope), false);
  }
  assert.equal(await matchSave.verify({ ...save, rows: rows.slice(0, 1) }, identity), false);
  assert.equal(await matchSave.verify({ ...save, rngSeed: 124 }, identity), false);
  for (const key of ['bytes', 'hle', 'sram'] as const) {
    assert.equal(
      await matchSave.verify({ ...save, snapshot: { ...snapshot, [key]: Uint8Array.of(99) } }, identity),
      false,
    );
  }
  assert.equal(
    await matchSave.verify({ ...save, snapshot: { ...snapshot, hidden: new Uint32Array(17) } }, identity),
    false,
  );
});

test('legacy Classic saves verify with their original mode in the seal', async () => {
  const scope = { ...identity, mode: 'lockstep' as const };
  const classic = { ...scope, mode: 'classic' as const };
  const legacy = { ...save, scope, seal: sealFor(scope.mode) };
  assert.equal(await matchSave.verify(legacy, classic), true);
  assert.equal(await matchSave.verify(legacy, identity), false);
  assert.equal(await matchSave.verify({ ...legacy, scope: classic }, classic), false);
});

test('a predicted capture becomes eligible only after every consumed owner tuple agrees', () => {
  const seen = [
    { slot: 1, tag: 8, applied: pad },
    { slot: 3, tag: 9, applied: pad },
  ];
  assert.equal(
    confirmInputs(seen, (slot) => (slot === 1 ? pad : null)),
    'waiting',
  );
  assert.equal(
    confirmInputs(seen, () => pad),
    'confirmed',
  );
  assert.equal(
    confirmInputs(seen, (slot) => (slot === 1 ? null : [1, 0, 0, 1, 0])),
    'changed',
  );
});
