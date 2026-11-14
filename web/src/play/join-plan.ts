/**
 * What a page does as it joins a room: whether it comes in as a spectator,
 * what a refusal from the server leads to, and how it gets into a match that
 * is already running. The decisions of `onConnect` in web/static/play.js.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * A page that asked to play joins as a spectator when the room is full. A
 * page that already holds a slot is one of the players counted: rejoining a
 * full room must not turn it into a spectator while the server keeps its
 * slot.
 */
//@ ensures \result ==> !wantsToWatch && !holdsSlot && playerCount >= maxPlayers
//@ ensures !wantsToWatch && !holdsSlot && playerCount >= maxPlayers ==> \result
export function becomesSpectator(
  wantsToWatch: boolean,
  holdsSlot: boolean,
  playerCount: number,
  maxPlayers: number,
): boolean {
  return !wantsToWatch && !holdsSlot && playerCount >= maxPlayers;
}

/**
 * How a page gets into a match already under way. `watch`: it runs no
 * emulator (a spectator, or a streamed game) and starts at once.
 * `askForSharedRom`: it needs the ROM and the host is offering theirs.
 * `askForRom`: it needs the ROM and must bring its own. `wrongRom`: its ROM
 * is not the host's and the host is not sharing. `play`: it has the ROM.
 */
export type LateJoinPlan = 'watch' | 'askForSharedRom' | 'askForRom' | 'wrongRom' | 'play';

/**
 * `needsNoRom`: a spectator or a streamed game. `romDiffers`: the page's ROM
 * is known not to be the host's. `tookHostsRom`: the page's ROM came from the
 * host by sharing, so a mismatch reading is not believed.
 */
//@ ensures needsNoRom ==> \result === "watch"
//@ ensures !needsNoRom && !hasRom && hostShares ==> \result === "askForSharedRom"
//@ ensures !needsNoRom && !hasRom && !hostShares ==> \result === "askForRom"
//@ ensures \result === "wrongRom" ==> !needsNoRom && hasRom && romDiffers && !tookHostsRom && !hostShares
//@ ensures \result === "play" ==> !needsNoRom && hasRom && (!romDiffers || tookHostsRom)
//@ ensures !needsNoRom && hasRom && (!romDiffers || tookHostsRom) ==> \result === "play"
export function lateJoinPlan(
  needsNoRom: boolean,
  hasRom: boolean,
  hostShares: boolean,
  romDiffers: boolean,
  tookHostsRom: boolean,
): LateJoinPlan {
  if (needsNoRom) return 'watch';
  if (!hasRom) {
    if (hostShares) return 'askForSharedRom';
    return 'askForRom';
  }
  if (romDiffers && !tookHostsRom) {
    if (hostShares) return 'askForSharedRom';
    return 'wrongRom';
  }
  return 'play';
}
