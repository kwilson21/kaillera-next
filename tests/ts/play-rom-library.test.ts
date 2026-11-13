import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  byLastUsed,
  librarySize,
  newStoredRom,
  openRomLibrary,
  romLibraryHtml,
  type RomEntry,
} from '../../web/src/play/rom-library.ts';

const HASH = `S${'ab'.repeat(32)}`;
const OTHER = `S${'cd'.repeat(32)}`;
const known = { [HASH]: { game: 'Super Smash Bros.' } };

const entry = (overrides: Partial<RomEntry> = {}): RomEntry => ({
  hash: HASH,
  name: 'Super Smash Bros.',
  size: 16777216,
  source: 'local',
  verified: true,
  gameName: 'Super Smash Bros.',
  addedAt: 1000,
  lastUsed: 1000,
  ...overrides,
});

test('a ROM the server knows is stored verified, under the game name', () => {
  const bytes = new ArrayBuffer(4096);
  const stored = newStoredRom(bytes, HASH, 'smash (U) [!].z64', 'local', known, 1700000000000);
  assert.deepEqual(stored, {
    blob: bytes,
    name: 'Super Smash Bros.',
    size: 4096,
    source: 'local',
    verified: true,
    gameName: 'Super Smash Bros.',
    addedAt: 1700000000000,
    lastUsed: 1700000000000,
  });
});

test('an unknown ROM keeps its file name and is unverified', () => {
  const stored = newStoredRom(new ArrayBuffer(8), OTHER, 'homebrew.z64', 'p2p', known, 5);
  assert.equal(stored.name, 'homebrew.z64');
  assert.equal(stored.verified, false);
  assert.equal(stored.gameName, null);
  assert.equal(stored.source, 'p2p');
  assert.equal(newStoredRom(new ArrayBuffer(8), OTHER, undefined, 'local', {}, 5).name, 'Unknown ROM');
});

test('the library lists the most recently used ROM first, without reordering its input', () => {
  const entries = [
    entry({ hash: 'a', lastUsed: 1 }),
    entry({ hash: 'b', lastUsed: 3 }),
    entry({ hash: 'c', lastUsed: 2 }),
  ];
  assert.deepEqual(
    byLastUsed(entries).map((e) => e.hash),
    ['b', 'c', 'a'],
  );
  assert.equal(entries[0]?.hash, 'a');
});

test('sizes are whole units', () => {
  assert.equal(librarySize(16777216), '16 MB');
  assert.equal(librarySize(1572864), '2 MB');
  assert.equal(librarySize(4096), '4 KB');
  assert.equal(librarySize(12), '12 B');
});

test('the host sees a ROM Library with the loaded ROM active and no Use button on it', () => {
  const html = romLibraryHtml([entry(), entry({ hash: OTHER, name: 'Other', verified: false, gameName: null })], {
    isHost: true,
    activeHash: HASH,
    hostHash: null,
  });
  assert.ok(html.includes('<span>ROM Library</span><span class="rom-count">2 ROMs</span>'));
  assert.ok(html.includes(`<div class="rom-library-item active" data-hash="${HASH}">`));
  assert.ok(html.includes('<span class="verified">Verified — Super Smash Bros.</span><span>16 MB</span>'));
  assert.ok(html.includes('<span class="unverified">Unverified</span>'));
  // One Use button: for the ROM that is not loaded. A delete button for each.
  assert.equal(html.split('class="rom-use small-btn"').length - 1, 1);
  assert.ok(html.includes(`<button class="rom-use small-btn" data-hash="${OTHER}" type="button">Use</button>`));
  assert.equal(html.split('class="rom-delete"').length - 1, 2);
});

test("a guest is told which ROM is the host's game", () => {
  const view = { isHost: false, activeHash: null, hostHash: HASH };
  const html = romLibraryHtml([entry({ source: 'p2p' })], view);
  assert.ok(html.includes('<span>Your ROMs on this device</span><span class="rom-count">1 ROM</span>'));
  assert.ok(html.includes('rom-library-item matches-host'));
  assert.ok(html.includes(`<span class="verified">Matches host's game</span>`));
  assert.ok(html.includes('<span>From host</span>'));
  // The host never sees its own ROM flagged as matching itself.
  assert.ok(!romLibraryHtml([entry()], { ...view, isHost: true }).includes('matches-host'));
  // No host ROM known yet: nothing matches.
  assert.ok(!romLibraryHtml([entry()], { ...view, hostHash: null }).includes('matches-host'));
});

test('file names and hashes are escaped in the markup', () => {
  const hostile = entry({
    hash: 'x" onclick="y',
    name: '<img src=x onerror=alert(1)>',
    verified: false,
    gameName: null,
  });
  const html = romLibraryHtml([hostile], { isHost: true, activeHash: null, hostHash: null });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('data-hash="x&quot; onclick=&quot;y"'));
});

test('where there is no IndexedDB the library reads empty and writes do nothing', async () => {
  // Node has no indexedDB, as a browser with storage disabled has none.
  const library = openRomLibrary({ name: null, hash: null });
  assert.deepEqual(await library.list(), []);
  assert.equal(await library.get(HASH), null);
  await library.put(HASH, newStoredRom(new ArrayBuffer(8), HASH, 'a.z64', 'local', known, 1));
  await library.touch(HASH, 2);
  await library.remove(HASH);
  assert.equal(await library.verifyAgainst(known), false);
  assert.deepEqual(await library.list(), []);
});
