import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcesRom, hashIsTheLoadedRoms, romVerdict } from '../../web/src/play/rom-identity.ts';
import { KNCore } from '../../web/src/index.ts';

const BOOLS = [false, true] as const;

test("a hash is the loaded ROM's only when it was computed for the load the page holds", () => {
  assert.equal(hashIsTheLoadedRoms(3, 3), true);
  // A drop's hash landing after the player dropped or picked another ROM.
  assert.equal(hashIsTheLoadedRoms(2, 3), false);
  assert.equal(hashIsTheLoadedRoms(0, 0), true);
});

test('the verdict over every input keeps its contract', () => {
  for (const hasRom of BOOLS) {
    for (const hashIsLoaded of BOOLS) {
      for (const hashDiffers of BOOLS) {
        for (const sizeDiffers of BOOLS) {
          const v = romVerdict(hasRom, hashIsLoaded, hashDiffers, sizeDiffers);
          const at = JSON.stringify({ hasRom, hashIsLoaded, hashDiffers, sizeDiffers, v });
          if (!hasRom) assert.equal(v, 'noRom', at);
          assert.equal(v === 'mismatch', hasRom && (sizeDiffers || (hashIsLoaded && hashDiffers)), at);
          assert.equal(v === 'pending', hasRom && !sizeDiffers && !hashIsLoaded, at);
          assert.equal(v === 'match', hasRom && !sizeDiffers && hashIsLoaded && !hashDiffers, at);
        }
      }
    }
  }
});

test("the previous ROM's hash neither refuses nor passes a drop still being hashed", () => {
  // The host's ROM, dropped over a wrong one: the wrong one's hash differs.
  assert.equal(romVerdict(true, false, true, false), 'pending');
  // A wrong ROM the host's size, dropped over the host's: the old hash matches.
  assert.equal(romVerdict(true, false, false, false), 'pending');
  // Once its own hash is in, it decides.
  assert.equal(romVerdict(true, true, false, false), 'match');
  assert.equal(romVerdict(true, true, true, false), 'mismatch');
});

test("a size that is not the host's refuses a ROM before its hash is in", () => {
  assert.equal(romVerdict(true, false, false, true), 'mismatch');
});

test("a page announces a ROM only once that ROM's own hash is in", () => {
  assert.equal(announcesRom(true, true), true);
  assert.equal(announcesRom(true, false), false);
  // No ROM (a hash landing after the ROM was cleared): never ready.
  assert.equal(announcesRom(false, true), false);
  assert.equal(announcesRom(false, false), false);
});

test('the play page reads these from the core bundle', () => {
  assert.equal(KNCore.play.romIdentity.romVerdict, romVerdict);
  assert.equal(KNCore.play.romIdentity.hashIsTheLoadedRoms, hashIsTheLoadedRoms);
  assert.equal(KNCore.play.romIdentity.announcesRom, announcesRom);
});
