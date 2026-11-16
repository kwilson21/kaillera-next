import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fnvRomHash,
  formatRomSize,
  hashRom,
  hostRomFromData,
  hostRomIdentityKey,
  romFromArchive,
  romHashMismatch,
} from '../../web/src/play/rom.ts';
import { KNCore } from '../../web/src/index.ts';

const HASH = `S${'ab'.repeat(32)}`;
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

test('the host ROM reads the same from every payload that carries it', () => {
  const expected = { hash: HASH, name: 'Smash.z64', size: 16777216, gameId: 'ssb64' };
  // users-updated / the join-room ack: flat camelCase (and more beside it).
  const usersUpdated = { romHash: HASH, romName: 'Smash.z64', romSize: 16777216, gameId: 'ssb64', rom_name: 'x' };
  assert.deepEqual(hostRomFromData(usersUpdated), expected);
  // The REST room body: snake_case.
  assert.deepEqual(
    hostRomFromData({ rom_hash: HASH, rom_name: 'Smash.z64', rom_size: 16777216, game_id: 'ssb64' }),
    expected,
  );
  // Only the nested object.
  const nested = { hostRom: { hash: HASH, name: 'Smash.z64', size: 16777216, game_id: 'ssb64' } };
  assert.deepEqual(hostRomFromData(nested), expected);
});

test('a room with no ROM yet, and no payload at all, read as all-unknown', () => {
  const unknown = { hash: null, name: null, size: null, gameId: null };
  assert.deepEqual(hostRomFromData({ romHash: null, romName: null, romSize: null, hostRom: null }), unknown);
  assert.deepEqual(hostRomFromData(null), unknown);
  assert.deepEqual(hostRomFromData(undefined), unknown);
});

test('a size that arrives as text becomes a number', () => {
  assert.equal(hostRomFromData({ rom_size: '4096' }).size, 4096);
});

test('the identity key changes with the ROM and is empty for none', () => {
  assert.equal(hostRomIdentityKey(HASH, 'Smash.z64', 16777216), `h:${HASH}:16777216`);
  assert.equal(hostRomIdentityKey(HASH, null, null), `h:${HASH}:`);
  // Before the hash is known, the name and size stand in.
  assert.equal(hostRomIdentityKey(null, 'Smash.z64', 16777216), 'n:Smash.z64:16777216');
  assert.equal(hostRomIdentityKey(null, null, 0), 'n::0');
  assert.equal(hostRomIdentityKey(null, null, null), '');
  assert.notEqual(hostRomIdentityKey(HASH, 'a', 1), hostRomIdentityKey(HASH, 'a', 2));
});

test('sizes read as people say them', () => {
  assert.equal(formatRomSize(16777216), '16 MB');
  assert.equal(formatRomSize(1572864), '1.5 MB');
  assert.equal(formatRomSize(524288), '512 KB');
  assert.equal(formatRomSize(12), '12 B');
  assert.equal(formatRomSize('16777216'), '16 MB');
  for (const unknown of [0, -5, null, undefined, 'abc', Number.NaN]) assert.equal(formatRomSize(unknown), '');
});

test('two hashes mismatch only when both are known and of the same algorithm', () => {
  const other = `S${'cd'.repeat(32)}`;
  assert.equal(romHashMismatch(HASH, other), true);
  assert.equal(romHashMismatch(HASH, HASH), false);
  assert.equal(romHashMismatch(HASH, null), false);
  assert.equal(romHashMismatch('', HASH), false);
  assert.equal(romHashMismatch(undefined, undefined), false);
  // SHA-256 on one page, FNV-1a on the other: cannot be compared.
  assert.equal(romHashMismatch(HASH, 'F0123456789abcdef'), false);
  assert.equal(romHashMismatch('F0123456789abcdef', 'Ffedcba9876543210'), true);
});

test('the FNV fallback is stable, tagged, and tells ROMs apart', () => {
  // Empty input leaves both halves at the FNV-1a offset basis.
  assert.equal(fnvRomHash(bytes()), 'F811c9dc5811c9dc5');
  // One byte: index 0 is even, so it lands in the second half.
  assert.equal(fnvRomHash(bytes(0x61)), 'F811c9dc5e40c292c');
  const a = fnvRomHash(bytes(1, 2, 3, 4));
  assert.match(a, /^F[0-9a-f]{16}$/);
  assert.notEqual(a, fnvRomHash(bytes(1, 2, 3, 5)));
  assert.notEqual(a, fnvRomHash(bytes(2, 1, 3, 4)));
});

test('hashRom is SHA-256 where the platform has it', async () => {
  const hash = await hashRom(new TextEncoder().encode('abc').buffer);
  assert.equal(hash, 'Sba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the first non-empty ROM in an archive is picked, by extension', () => {
  const rom = bytes(0x80, 0x37, 0x12, 0x40);
  const found = romFromArchive({ 'readme.txt': bytes(1), 'Games/N64/Smash.Z64': rom, 'other.n64': bytes(9) });
  assert.deepEqual(found, { name: 'Smash.Z64', data: rom });
  assert.equal(romFromArchive({ 'readme.txt': bytes(1), 'empty.z64': bytes() }), null);
  assert.equal(romFromArchive({}), null);
  assert.equal(romFromArchive({ 'disk.ndd': rom })?.name, 'disk.ndd');
});

test('play.js reaches these through KNCore.play', () => {
  assert.equal(KNCore.play.hostRomFromData, hostRomFromData);
  assert.equal(KNCore.play.hashRom, hashRom);
  assert.equal(KNCore.play.romFromArchive, romFromArchive);
});
