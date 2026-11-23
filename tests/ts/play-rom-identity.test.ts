import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  announcesRom,
  hashIsTheLoadedRoms,
  looksInLibraryForHostsRom,
  offersHostsRom,
  romDecided,
  romVerdict,
  type RomVerdict,
} from '../../web/src/play/rom-identity.ts';
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
    for (const changing of BOOLS) {
      for (const hashIsLoaded of BOOLS) {
        for (const hashDiffers of BOOLS) {
          for (const sizeDiffers of BOOLS) {
            const v = romVerdict(hasRom, changing, hashIsLoaded, hashDiffers, sizeDiffers);
            const at = JSON.stringify({ hasRom, changing, hashIsLoaded, hashDiffers, sizeDiffers, v });
            if (!hasRom) assert.equal(v, 'noRom', at);
            assert.equal(v === 'mismatch', hasRom && !changing && (sizeDiffers || (hashIsLoaded && hashDiffers)), at);
            assert.equal(v === 'pending', hasRom && (changing || (!sizeDiffers && !hashIsLoaded)), at);
            assert.equal(v === 'match', hasRom && !changing && !sizeDiffers && hashIsLoaded && !hashDiffers, at);
          }
        }
      }
    }
  }
});

test("the previous ROM's hash neither refuses nor passes a drop still being hashed", () => {
  // The host's ROM, dropped over a wrong one: the wrong one's hash differs.
  assert.equal(romVerdict(true, false, false, true, false), 'pending');
  // A wrong ROM the host's size, dropped over the host's: the old hash matches.
  assert.equal(romVerdict(true, false, false, false, false), 'pending');
  // Once its own hash is in, it decides.
  assert.equal(romVerdict(true, false, true, false, false), 'match');
  assert.equal(romVerdict(true, false, true, true, false), 'mismatch');
});

test("a size that is not the host's refuses a ROM before its hash is in", () => {
  assert.equal(romVerdict(true, false, false, false, true), 'mismatch');
});

test("nothing is judged against the host's ROM while it is changing", () => {
  // specs/rom_identity.qnt, hostChangesToTheGuestsRomTest: the guest's ROM is
  // the host's new one, hashed, and the room names no ROM yet. Whatever the
  // page last knew of the host's says nothing about it.
  for (const hashIsLoaded of BOOLS) {
    for (const hashDiffers of BOOLS) {
      for (const sizeDiffers of BOOLS) {
        assert.equal(romVerdict(true, true, hashIsLoaded, hashDiffers, sizeDiffers), 'pending');
      }
    }
  }
  // No ROM is still none.
  assert.equal(romVerdict(false, true, true, false, false), 'noRom');
  // The plans count none and offer nothing while it changes.
  assert.equal(romDecided(romVerdict(true, true, true, false, false)), false);
  assert.equal(offersHostsRom(romVerdict(true, true, true, false, false), true), false);
});

test("a page announces a ROM only once that ROM's own hash is in", () => {
  assert.equal(announcesRom(true, true, false), true);
  assert.equal(announcesRom(true, false, false), false);
  // No ROM (a hash landing after the ROM was cleared): never ready.
  assert.equal(announcesRom(false, true, false), false);
  assert.equal(announcesRom(false, false, false), false);
});

test("a guest says nothing while the host's ROM is changing", () => {
  // specs/rom_identity.qnt, hostChangesAwayFromTheGuestsRomTest: the server
  // has no hash to hold the word against, and the host's new one decides.
  for (const hasRom of BOOLS) {
    for (const hashIsLoaded of BOOLS) {
      assert.equal(announcesRom(hasRom, hashIsLoaded, true), false);
      assert.equal(announcesRom(hasRom, hashIsLoaded, false), hasRom && hashIsLoaded);
    }
  }
});

const VERDICTS: readonly RomVerdict[] = ['noRom', 'pending', 'match', 'mismatch'];

test('the plans count a ROM only once its own hash or its size has decided it', () => {
  for (const v of VERDICTS) {
    assert.equal(romDecided(v), v === 'match' || v === 'mismatch', v);
    for (const shares of [false, true]) {
      assert.equal(offersHostsRom(v, shares), shares && v !== 'pending', `${v} ${shares}`);
    }
  }
  // A drop still being hashed: no ROM yet for the plans, and no offer, so the
  // start waits for it and the hash landing decides.
  assert.equal(romDecided('pending'), false);
  assert.equal(offersHostsRom('pending', true), false);
});

test("a page that wants a ROM and has none looks in its library once the room names the host's ROM", () => {
  for (const wantsRom of BOOLS) {
    for (const hasRom of BOOLS) {
      for (const hostHashKnown of BOOLS) {
        assert.equal(
          looksInLibraryForHostsRom(wantsRom, hasRom, hostHashKnown),
          wantsRom && !hasRom && hostHashKnown,
          JSON.stringify({ wantsRom, hasRom, hostHashKnown }),
        );
      }
    }
  }
  // specs/rom_identity.qnt, guestDroppedFirstTest: refused against the host's
  // previous ROM, the guest holds none when the host's new one is named.
  assert.equal(looksInLibraryForHostsRom(true, false, true), true);
  // While the host's ROM is changing the room names no hash: nothing to look for.
  assert.equal(looksInLibraryForHostsRom(true, false, false), false);
  // A spectator that never held a ROM needs none.
  assert.equal(looksInLibraryForHostsRom(false, false, true), false);
});

test('the play page reads these from the core bundle', () => {
  assert.equal(KNCore.play.romIdentity.romVerdict, romVerdict);
  assert.equal(KNCore.play.romIdentity.hashIsTheLoadedRoms, hashIsTheLoadedRoms);
  assert.equal(KNCore.play.romIdentity.announcesRom, announcesRom);
  assert.equal(KNCore.play.romIdentity.romDecided, romDecided);
  assert.equal(KNCore.play.romIdentity.offersHostsRom, offersHostsRom);
  assert.equal(KNCore.play.romIdentity.looksInLibraryForHostsRom, looksInLibraryForHostsRom);
});
