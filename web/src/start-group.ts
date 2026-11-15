/**
 * Who a page waits for before its match runs: the start group
 * (specs/start_group.qnt). web/static/netplay-rollback.js asks these at each
 * decision and carries out the answer.
 *
 * The host decides the start group. A player its startup deadline gives up
 * on, or one that says it has no ROM while the host's is not shared, is left
 * out: held as a late joiner, it is counted by none of the start's waits, and
 * a host with nobody left to wait for starts alone. The host tells the other
 * players (`left-out:<slot>`); a guest takes that word only from the host's
 * own channel and never leaves anyone out itself. A guest whose page started
 * normally but has no channel to the host by its own deadline joins late
 * instead, so no player whose page is alive ends up in neither the start nor
 * the late join; a guest without that channel never goes on with its start.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** The host's slot. */
export const HOST_SLOT = 0;

/**
 * Does a start wait (emu-ready, lockstep-ready) count this player?
 *
 * `isPlayer`: the connection is to a player, not a spectator. `heldAsLateJoiner`:
 * the page holds that player as a late joiner. `leftOut`: the host left that
 * player out of this start.
 */
//@ ensures leftOut ==> !\result
//@ ensures heldAsLateJoiner ==> !\result
//@ ensures \result <==> isPlayer && !heldAsLateJoiner && !leftOut
export function countedByStartGates(isPlayer: boolean, heldAsLateJoiner: boolean, leftOut: boolean): boolean {
  return isPlayer && !heldAsLateJoiner && !leftOut;
}

/**
 * Does this page leave the player out of the start?
 *
 * `isHost`: this page is the host (a guest never leaves anyone out).
 * `running`: this page's match runs (the start is over). `otherPlayer`: the
 * connection is to another player, not this page or a synthetic one.
 * `channelOpen`: that player's channel is open (it is in). `alreadyOut`: it
 * was left out already.
 */
//@ ensures \result ==> isHost && !running && otherPlayer && !channelOpen && !alreadyOut
//@ ensures isHost && !running && otherPlayer && !channelOpen && !alreadyOut ==> \result
export function leavesOut(
  isHost: boolean,
  running: boolean,
  otherPlayer: boolean,
  channelOpen: boolean,
  alreadyOut: boolean,
): boolean {
  return isHost && !running && otherPlayer && !channelOpen && !alreadyOut;
}

/**
 * Does the host start its game sequence now, alone?
 *
 * `sequenceStarted`: the game sequence has started (a channel opened).
 * `waitingFor`: the players still in the start group, connecting or open.
 */
//@ requires waitingFor >= 0
//@ ensures \result <==> isHost && !sequenceStarted && waitingFor === 0
export function startsAlone(isHost: boolean, sequenceStarted: boolean, waitingFor: number): boolean {
  return isHost && !sequenceStarted && waitingFor === 0;
}

/**
 * Does a page take the word `left-out:<slot>`?
 *
 * Only from the host's own channel (`fromSlot`), only on a guest (`mySlot`,
 * -1 for a spectator) before its match runs, and only for a guest's slot
 * other than its own and not already left out: the host never leaves itself
 * out.
 */
//@ ensures \result ==> fromSlot === 0 && mySlot > 0 && mySlot < 4
//@ ensures \result ==> !running && !alreadyOut && slot > 0 && slot < 4 && slot !== mySlot
//@ ensures fromSlot !== 0 ==> !\result
export function takesLeftOut(
  fromSlot: number,
  mySlot: number,
  running: boolean,
  slot: number,
  alreadyOut: boolean,
): boolean {
  if (fromSlot !== HOST_SLOT) return false;
  if (mySlot <= HOST_SLOT || mySlot >= 4) return false;
  if (running || alreadyOut) return false;
  return slot > HOST_SLOT && slot < 4 && slot !== mySlot;
}

/**
 * May this page's start go past a wait (emu-ready, the ready barrier)?
 *
 * A guest's start group always holds the host: with no open channel to it, a
 * guest that counted only the players left would sync and run a match of its
 * own. It waits instead; its deadline on the host takes it into the late join
 * if the channel does not come back. `isHost`: this page is the host.
 * `hostChannelOpen`: its channel to the host is open.
 */
//@ ensures \result <==> isHost || hostChannelOpen
export function startHasItsHost(isHost: boolean, hostChannelOpen: boolean): boolean {
  return isHost || hostChannelOpen;
}

/**
 * At a guest's own deadline on its connection to the host: does it join the
 * match late instead (the host started without it)?
 *
 * `isHost`: this page is the host (it never does). `running`: its match runs.
 * `lateJoin`: it is joining late already. `hostChannelOpen`: its channel to
 * the host is open.
 */
//@ ensures \result <==> !isHost && !running && !lateJoin && !hostChannelOpen
export function rejoinsLate(isHost: boolean, running: boolean, lateJoin: boolean, hostChannelOpen: boolean): boolean {
  return !isHost && !running && !lateJoin && !hostChannelOpen;
}
