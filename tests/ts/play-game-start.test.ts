import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gameEndedMessage, gameStartPlan, handlesGameEnd } from '../../web/src/play/game-start.ts';

const BOOLS = [true, false] as const;
const DECISIONS = ['accepted', 'declined', null] as const;

// onGameStarted's branches in web/static/play.js as of v0.68.18, in their
// order, before it asked gameStartPlan: the old-against-new evidence for the
// switch. `mismatch` is hostRomMismatch(), which is false without a ROM.
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

test('a page takes the same path at a game start that the old branches took', () => {
  let compared = 0;
  for (const isSpectator of BOOLS) {
    for (const mode of ['rollback', 'lockstep', 'streaming']) {
      for (const isHost of BOOLS) {
        for (const hasRom of BOOLS) {
          // hostRomMismatch() is false when no ROM is loaded.
          for (const mismatch of hasRom ? BOOLS : [false]) {
            for (const sharing of BOOLS) {
              for (const decision of DECISIONS) {
                assert.equal(
                  gameStartPlan(
                    isSpectator || (mode === 'streaming' && !isHost),
                    hasRom,
                    mismatch,
                    sharing,
                    decision === 'accepted',
                    decision === null,
                  ),
                  oldGameStart(isSpectator, mode, isHost, hasRom, mismatch, sharing, decision),
                );
                compared++;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(compared, 2 * 3 * 2 * 3 * 2 * 3);
});

test('the host of a streamed game boots it; its guests and spectators watch', () => {
  assert.equal(gameStartPlan(false, true, false, false, false, true), 'play');
  assert.equal(gameStartPlan(true, false, false, false, false, true), 'watch');
  assert.equal(gameStartPlan(true, true, true, true, false, true), 'watch');
});

test('a ROM that is not the host’s: the offer while it stands, else the error', () => {
  assert.equal(gameStartPlan(false, true, true, true, false, true), 'askForSharedRom');
  assert.equal(gameStartPlan(false, true, true, true, false, false), 'wrongRom');
  assert.equal(gameStartPlan(false, true, true, false, false, true), 'wrongRom');
  // Taken from the host: a mismatch reading is not believed.
  assert.equal(gameStartPlan(false, true, true, true, true, false), 'play');
});

test('no ROM while the host shares: wait for the transfer once taken, else keep the offer up', () => {
  assert.equal(gameStartPlan(false, false, false, true, true, false), 'awaitSharedRom');
  assert.equal(gameStartPlan(false, false, false, true, false, true), 'askForSharedRom');
  assert.equal(gameStartPlan(false, false, false, true, false, false), 'askForSharedRom');
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
