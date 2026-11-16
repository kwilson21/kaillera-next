/**
 * Who a page waits for before its match runs: the start group
 * (specs/start_group.qnt). web/static/netplay-rollback.js asks these at each
 * decision and carries out the answer.
 *
 * The host decides the start group. A player its startup deadline gives up
 * on, one at the ROM prompt while the host's is not shared, one that has not
 * loaded its emulator by the host's load deadline, or one another guest
 * says it cannot reach is left out: held as a
 * late joiner, it is counted by none of the start's waits, and a host with
 * nobody left to wait for starts alone. The host tells the players
 * (`left-out:<slot>`), the one left out included; a guest takes that word
 * only from the host's own channel and never leaves anyone out itself. A
 * guest told it is out, or whose page started normally but has no channel to
 * the host by its own deadline, joins late instead, so no player whose page
 * is alive ends up in neither the start nor the late join; a guest without that channel never goes on with its start.
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
 * `channelOpen`: that player's channel is open (it answered). `cannotPlay`:
 * it answered but cannot play in this start: it has not loaded its emulator
 * by the host's load deadline, or another guest cannot reach it.
 * `alreadyOut`: it was left out already. A player that answered is left out
 * only when it cannot play.
 */
//@ ensures \result ==> isHost && !running && otherPlayer && !alreadyOut
//@ ensures \result && channelOpen ==> cannotPlay
//@ ensures isHost && !running && otherPlayer && !alreadyOut && (!channelOpen || cannotPlay) ==> \result
export function leavesOut(
  isHost: boolean,
  running: boolean,
  otherPlayer: boolean,
  channelOpen: boolean,
  cannotPlay: boolean,
  alreadyOut: boolean,
): boolean {
  return isHost && !running && otherPlayer && !alreadyOut && (!channelOpen || cannotPlay);
}

/**
 * Is this player behind the host's start?
 *
 * `emuReady`: the player said it has loaded its emulator. `hostReady`: the
 * host has synced and is ready at its barrier itself. `readyThisSync`: the
 * player said `lockstep-ready` to that barrier (the barrier's own record,
 * the only one). A player that has not loaded is behind; one that has, only
 * once the host is ready and it is not: while the host is still syncing
 * itself, the player waits on the host.
 */
//@ ensures !emuReady ==> \result
//@ ensures \result <==> !emuReady || (hostReady && !readyThisSync)
export function behindTheStart(emuReady: boolean, hostReady: boolean, readyThisSync: boolean): boolean {
  return !emuReady || (hostReady && !readyThisSync);
}

/**
 * At a run of the host's load deadline: does it leave this player out?
 *
 * Only a player behind (behindTheStart) that has made no start step for a
 * whole window: `sinceStepMs`, since its last (its channel opening, its
 * emu-ready, its lockstep-ready, or the host's own readiness, which it then
 * waits on, and the deadline's arming), at least `deadlineMs`. A player
 * still loading, or still taking the host's state in, keeps making steps and
 * is never left out (specs/start_group.qnt, aPlayerMakingProgressStays).
 */
//@ requires sinceStepMs >= 0 && deadlineMs > 0
//@ ensures \result ==> behind
//@ ensures \result <==> behind && sinceStepMs >= deadlineMs
export function missedLoadDeadline(behind: boolean, sinceStepMs: number, deadlineMs: number): boolean {
  return behind && sinceStepMs >= deadlineMs;
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
 * The host hears from a guest (`fromSlot`) that it cannot reach another
 * guest (`slot`): `unreachable:<slot>`. Does the host leave that one out?
 *
 * Two guests that each reach the host but not each other wait for each
 * other's emu-ready for ever, and neither may leave the other out. The host
 * leaves out the one named, before its match runs, when both are in the
 * start (`reporterInStart`, `namedInStart`: counted by the start's waits,
 * neither left out nor held as a late joiner; both may say it of each
 * other: the first word counts), and only once the reporter's own deadline
 * on the other could have given up (`sinceStartMs`, since this host's start,
 * at least `giveUpMs`, the deadline's three attempts). A guest could claim
 * any player unreachable to get it left out; that player joins late, and the
 * wait stops a claim made at once. The one that reported plays.
 */
//@ requires sinceStartMs >= 0 && giveUpMs >= 0
//@ ensures \result ==> isHost && !running && reporterInStart && namedInStart && sinceStartMs >= giveUpMs
//@ ensures \result ==> fromSlot > 0 && fromSlot < 4 && slot > 0 && slot < 4 && fromSlot !== slot
export function leavesOutUnreachable(
  isHost: boolean,
  running: boolean,
  fromSlot: number,
  slot: number,
  reporterInStart: boolean,
  namedInStart: boolean,
  sinceStartMs: number,
  giveUpMs: number,
): boolean {
  if (!isHost || running || !reporterInStart || !namedInStart) return false;
  if (sinceStartMs < giveUpMs) return false;
  if (fromSlot <= HOST_SLOT || fromSlot >= 4) return false;
  return slot > HOST_SLOT && slot < 4 && slot !== fromSlot;
}

/**
 * Does a page take `left-out:<slot>` naming itself: the host started without
 * it, so it joins late?
 *
 * Only from the host's own channel (`fromSlot`), only on a guest (`mySlot`),
 * and not when it is joining late already (a late joiner the host held as out
 * hears the word too, when its channel opens). Before its match runs; or
 * once it runs, while it has had no input from the host (`hostInputSeen`):
 * its lockstep-ready crossed the host's cut at the barrier, and it holds the
 * host's own ready, so its match ran while the host's runs without it. The
 * host sends no input to a player it left out (specs/start_group.qnt,
 * RUNNING_TAKES_LEFT_OUT). A guest that has had the host's input is in the
 * host's match: the word is stale.
 */
//@ ensures \result ==> fromSlot === 0 && mySlot > 0 && mySlot < 4 && slot === mySlot && !lateJoin
//@ ensures \result ==> !running || !hostInputSeen
//@ ensures fromSlot !== 0 ==> !\result
export function leftOutItself(
  fromSlot: number,
  mySlot: number,
  running: boolean,
  slot: number,
  lateJoin: boolean,
  hostInputSeen: boolean,
): boolean {
  if (fromSlot !== HOST_SLOT) return false;
  if (mySlot <= HOST_SLOT || mySlot >= 4) return false;
  return slot === mySlot && (!running || !hostInputSeen) && !lateJoin;
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
