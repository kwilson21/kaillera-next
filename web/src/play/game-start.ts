/**
 * What a page in the room does when the host starts a game, and whether it
 * has anything to do when the game ends. The decisions of `onGameStarted`
 * and `onGameEnded` in web/static/play.js, which are observed against these
 * (`game-start-plan`, `game-end-handled`) before these decide.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * `watch`: the page runs no emulator (a spectator, or a guest of a streamed
 * game) and starts at once. `askForSharedRom`: its ROM is missing or not the
 * host's, the host is sharing theirs, and the player has not taken it yet;
 * the lobby stays up with the offer. `awaitSharedRom`: the player took the
 * host's ROM and it has not all arrived. `wrongRom`: its ROM is not the
 * host's and it cannot take the host's. `play`: it boots the game.
 */
export type GameStartPlan = 'watch' | 'askForSharedRom' | 'awaitSharedRom' | 'wrongRom' | 'play';

/**
 * `needsNoRom`: a spectator, or a guest when the game is streamed.
 * `hasRom`: a ROM is loaded on the page. `romDiffers`: that ROM is known not
 * to be the host's. `hostShares`: the host offers its ROM. `tookHostsRom`:
 * the player accepted it (so a mismatch reading is not believed).
 * `undecided`: the player has neither accepted nor declined it.
 */
//@ ensures needsNoRom ==> \result === "watch"
//@ ensures !needsNoRom && hasRom && (!romDiffers || tookHostsRom) ==> \result === "play"
//@ ensures \result === "play" ==> !needsNoRom && (!romDiffers || tookHostsRom) && (hasRom || !hostShares)
//@ ensures \result === "wrongRom" ==> !needsNoRom && romDiffers && !tookHostsRom && !(hostShares && undecided)
//@ ensures \result === "awaitSharedRom" ==> !needsNoRom && hostShares && tookHostsRom && !hasRom
//@ ensures \result === "askForSharedRom" ==> !needsNoRom && hostShares && !tookHostsRom
export function gameStartPlan(
  needsNoRom: boolean,
  hasRom: boolean,
  romDiffers: boolean,
  hostShares: boolean,
  tookHostsRom: boolean,
  undecided: boolean,
): GameStartPlan {
  if (needsNoRom) return 'watch';
  if (romDiffers && !tookHostsRom) {
    if (hostShares && undecided) return 'askForSharedRom';
    return 'wrongRom';
  }
  if (hostShares && !hasRom) {
    if (tookHostsRom) return 'awaitSharedRom';
    return 'askForSharedRom';
  }
  return 'play';
}

/**
 * Whether the page handles a game's end. `endedMatchId` and
 * `lastHandledMatchId` are match ids, '' when there is none: an end the page
 * already handled is not handled twice. `gameOn`: the page has a game to
 * end (one running, an engine, or a late join under way).
 * `leftByMachine`: the caller already moved the page to the lobby and asks
 * for the clean-up anyway.
 */
//@ ensures \result ==> leftByMachine || gameOn
//@ ensures \result ==> endedMatchId === "" || endedMatchId !== lastHandledMatchId
//@ ensures (leftByMachine || gameOn) && (endedMatchId === "" || endedMatchId !== lastHandledMatchId) ==> \result
export function handlesGameEnd(
  endedMatchId: string,
  lastHandledMatchId: string,
  leftByMachine: boolean,
  gameOn: boolean,
): boolean {
  if (endedMatchId !== '' && endedMatchId === lastHandledMatchId) return false;
  return leftByMachine || gameOn;
}

/** The toast a page shows when its game ends. */
export const gameEndedMessage = (reason: string | null | undefined): string =>
  reason === 'dropped' ? 'You were disconnected for too long. Rejoining...' : 'The host has ended the game';
