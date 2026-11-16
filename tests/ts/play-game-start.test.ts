import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endMatchesCurrent, gameEndedMessage, gameStartPlan, handlesGameEnd } from '../../web/src/play/game-start.ts';
import { lateJoinPlan } from '../../web/src/play/join-plan.ts';

const BOOLS = [true, false] as const;
// What the player did with the host's offer: took it, or not (yet). The old
// branches also read a 'declined', which nothing on the page sets any more
// (declineRomSharing is gone with its button); a player turns the offer
// down by loading a ROM of its own.
const DECISIONS = ['accepted', null] as const;

// onGameStarted's branches in web/static/play.js as of v0.68.18, in their
// order, before it asked gameStartPlan: the old-against-new evidence for the
// switch. `mismatch` is hostRomMismatch(), which is false without a ROM.
// One difference is the fix specs/rom_at_start.qnt shows
// (startBeforeTheClearArrivesTest): with no ROM and none to take from the
// host, the old branches booted the game; the plan asks for a ROM.
const oldGameStart = (
  isSpectator: boolean,
  mode: string,
  isHost: boolean,
  hasRom: boolean,
  mismatch: boolean,
  sharing: boolean,
  decision: string | null,
) => {
  if (isSpectator || (mode === 'streaming' && !isHost)) return 'watch';
  if (mismatch && decision !== 'accepted') {
    if (sharing && decision === null) return 'askForSharedRom';
    return 'wrongRom';
  }
  if (sharing && !hasRom) return decision === 'accepted' ? 'awaitSharedRom' : 'askForSharedRom';
  return 'play';
};

test('a page takes the same path at a game start that the old branches took, but one', () => {
  let compared = 0;
  let askForRom = 0;
  for (const isSpectator of BOOLS) {
    for (const mode of ['rollback', 'lockstep', 'streaming']) {
      for (const isHost of BOOLS) {
        for (const hasRom of BOOLS) {
          // hostRomMismatch() is false when no ROM is loaded.
          for (const mismatch of hasRom ? BOOLS : [false]) {
            for (const sharing of BOOLS) {
              for (const decision of DECISIONS) {
                const old = oldGameStart(isSpectator, mode, isHost, hasRom, mismatch, sharing, decision);
                const plan = gameStartPlan(
                  isSpectator || (mode === 'streaming' && !isHost),
                  hasRom,
                  mismatch,
                  sharing,
                  decision === 'accepted',
                );
                // The named difference: no ROM, nothing shared, the old branches played.
                const noRomToPlay = old === 'play' && !hasRom && !sharing;
                assert.equal(plan, noRomToPlay ? 'askForRom' : old);
                if (noRomToPlay) askForRom++;
                compared++;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(compared, 2 * 3 * 2 * 3 * 2 * 2);
  // Every player page (not a spectator, not a streamed game's guest) with no
  // ROM and no sharing, whatever it did about an offer: 5 page kinds x 2.
  assert.equal(askForRom, 10);
});

test('a page never boots a game without a ROM: with none to take, it asks for one', () => {
  for (const decision of DECISIONS) {
    assert.equal(gameStartPlan(false, false, false, false, decision === 'accepted'), 'askForRom');
  }
  for (const needsNoRom of BOOLS)
    for (const hasRom of BOOLS)
      for (const romDiffers of BOOLS)
        for (const hostShares of BOOLS)
          for (const took of BOOLS) {
            if (gameStartPlan(needsNoRom, hasRom, romDiffers, hostShares, took) === 'play') assert.equal(hasRom, true);
          }
});

test('the host of a streamed game boots it; its guests and spectators watch', () => {
  assert.equal(gameStartPlan(false, true, false, false, false), 'play');
  assert.equal(gameStartPlan(true, false, false, false, false), 'watch');
  assert.equal(gameStartPlan(true, true, true, true, false), 'watch');
});

test('a ROM that is not the host’s: the offer while it stands, else the error', () => {
  assert.equal(gameStartPlan(false, true, true, true, false), 'askForSharedRom');
  assert.equal(gameStartPlan(false, true, true, false, false), 'wrongRom');
  // Taken from the host: a mismatch reading is not believed.
  assert.equal(gameStartPlan(false, true, true, true, true), 'play');
});

test('a ROM that is not the host’s gets the same answer at a start as at a late join', () => {
  // The start used to give `wrongRom` to a player who had declined the
  // offer, where a late join showed it again; nothing declines it now.
  for (const hostShares of BOOLS)
    for (const took of BOOLS) {
      assert.equal(
        gameStartPlan(false, true, true, hostShares, took),
        lateJoinPlan(false, true, hostShares, true, took),
        `hostShares=${hostShares} took=${took}`,
      );
    }
});

test('no ROM while the host shares: wait for the transfer once taken, else keep the offer up', () => {
  assert.equal(gameStartPlan(false, false, false, true, true), 'awaitSharedRom');
  assert.equal(gameStartPlan(false, false, false, true, false), 'askForSharedRom');
});

// onGameEnded's early returns as of v0.68.18, before it asked handlesGameEnd.
const oldHandlesEnd = (ended: string | null, last: string | null, leftByMachine: boolean, gameOn: boolean) => {
  if (ended && last === ended) return false;
  if (!leftByMachine && !gameOn) return false;
  return true;
};

test('a game end is handled when the old checks handled it', () => {
  let compared = 0;
  for (const ended of ['m1', 'm2', null]) {
    for (const last of ['m1', null]) {
      for (const leftByMachine of BOOLS) {
        for (const gameOn of BOOLS) {
          assert.equal(
            handlesGameEnd(ended ?? '', last ?? '', leftByMachine, gameOn),
            oldHandlesEnd(ended, last, leftByMachine, gameOn),
          );
          compared++;
        }
      }
    }
  }
  assert.equal(compared, 24);
  // The same match's end twice: the second is ignored, even with a game on.
  assert.equal(handlesGameEnd('m1', 'm1', true, true), false);
  // No match id: never taken for one already handled.
  assert.equal(handlesGameEnd('', '', false, true), true);
});

test('the toast at a game end says why', () => {
  assert.equal(gameEndedMessage('dropped'), 'You were disconnected for too long. Rejoining...');
  for (const reason of [undefined, null, '', 'ended'])
    assert.equal(gameEndedMessage(reason), 'The host has ended the game');
});

test('an end acknowledgement for an old match cannot end the rematch', () => {
  assert.equal(endMatchesCurrent('old', 'new'), false);
  assert.equal(endMatchesCurrent('same', 'same'), true);
  assert.equal(endMatchesCurrent('', 'same'), true);
});
