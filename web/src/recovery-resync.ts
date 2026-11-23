/**
 * What a page does when it hears again from a player it held as a phantom
 * (PEER-RECOVERED in web/static/netplay-rollback.js's input handler), and how
 * the host answers a guest that asks for a resync after its channel was
 * reconnected (syncRequestAnswer, below).
 *
 * While a page holds a player as a phantom it runs that player's frames on
 * its own predictions, and so may every other page, each on its own: some
 * hear the player all along and run its real inputs, some predict, and a
 * late input lands inside one page's rollback window and past another's.
 * Which pages end up having run those frames on which inputs is a matter of
 * timing. The host settles the player's inputs from before its frame when it
 * hears it again (it never hands them to its engine), so only a state the
 * host takes after that brings a page back to the host's frames:
 *
 *  - The host resyncs every guest, not only the one it heard again. A guest
 *    that ran that player's real inputs where the host ran predictions
 *    (or the other way round) has split from the host, and nothing else
 *    compares them. One capture goes to all of them (the scheduled requests
 *    fall due together), so the settled point the returning guest announces
 *    (`inputs-settled:`) is for a state every guest loads.
 *  - A guest that hears again from the host asks for a coordinated resync,
 *    as before (`sync-request-full-at:`).
 *  - A guest that hears again from another guest asks the host for a resync
 *    (`sync-request-full`), unless one is out already. It may have held that
 *    guest as a phantom after the host's own state landed, and an input of it
 *    lost then is behind this page's window by now: never asked for again,
 *    never compared.
 *
 * Modelled in specs/recovery_bystander.qnt: hostAndBystanderAgree holds on
 * recovery_bystander_fixed; it is violated when the resync goes to the
 * returning guest alone (recovery_bystander_before;
 * onlyTheHostDroppedItTest, bystanderAppliesWhatTheHostSettledTest) and,
 * with inputs lost, when only the host's return makes a guest ask
 * (recovery_bystander_broadcast_only; bystanderStillPhantomTest).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * `nothing`: nothing to do. `resync-guests`: (host) schedule a resync for every
 * guest and settle the returning player's inputs before this frame.
 * `ask-at`: (guest) ask the host for a coordinated resync. `ask`: (guest) ask
 * the host for a resync now.
 */
export type RecoveryStep = 'nothing' | 'resync-guests' | 'ask-at' | 'ask';

/**
 * @param isHost           this page is the host
 * @param recoveredIsHost  the player heard again is the host
 * @param resyncEnabled    resyncs are on in this match (the host's toggle)
 * @param requestOut       this page has a resync request out already
 */
//@ ensures !resyncEnabled ==> \result === "nothing"
//@ ensures resyncEnabled && isHost ==> \result === "resync-guests"
//@ ensures resyncEnabled && !isHost && recoveredIsHost ==> \result === "ask-at"
//@ ensures resyncEnabled && !isHost && !recoveredIsHost && requestOut ==> \result === "nothing"
//@ ensures resyncEnabled && !isHost && !recoveredIsHost && !requestOut ==> \result === "ask"
//@ ensures \result === "resync-guests" ==> isHost
//@ ensures (\result === "ask-at" || \result === "ask") ==> !isHost
export function recoveryStep(
  isHost: boolean,
  recoveredIsHost: boolean,
  resyncEnabled: boolean,
  requestOut: boolean,
): RecoveryStep {
  if (!resyncEnabled) return 'nothing';
  if (isHost) return 'resync-guests';
  if (recoveredIsHost) return 'ask-at';
  if (requestOut) return 'nothing';
  return 'ask';
}

/**
 * How the host answers a guest's request for a resync (its channel handler
 * for `sync-request-full` and `sync-request-full-at:<frame>`).
 *
 * When the channel between the host and a guest dies and is healed (its
 * close event, or the mesh health check), the host resets its entry for that
 * guest (resetPeerState): the phantom flag goes, so no PEER-RECOVERED follows
 * and recoveryStep never runs. The guest asks for a resync from the new
 * channel's open handler. While the channel was dead the host ran the
 * guest's frames on predictions and every other guest (a bystander) ran them
 * on its real inputs, heard all along; those inputs never reach the host.
 * A state for the returning guest alone leaves every bystander on frames the
 * host ran on other inputs, and nothing compares them again. So:
 *
 *  - `resync-guests`: the first request from a guest whose channel the host
 *    reset for a reconnect. One capture goes to every guest (the requests
 *    share their frame and deadline and fall due together), as for
 *    PEER-RECOVERED.
 *  - `scheduled`: a coordinated request whose target frame is still ahead:
 *    a state at that frame, for that guest.
 *  - `direct`: a state now, for that guest.
 *
 * Modelled in specs/recovery_bystander.qnt: hostAndBystanderAgree holds on
 * recovery_bystander_fixed; it is violated when the answer goes to the
 * reconnected guest alone (recovery_bystander_reconnect_before;
 * reconnectBystanderTest).
 */
export type SyncRequestAnswer = 'resync-guests' | 'scheduled' | 'direct';

/**
 * @param reconnected  the host reset its entry for this guest for a
 *                     reconnect and has answered no request of it since
 * @param targetAhead  the request names a frame (`-at:`) the host has not
 *                     reached yet
 */
//@ ensures reconnected ==> \result === "resync-guests"
//@ ensures !reconnected && targetAhead ==> \result === "scheduled"
//@ ensures !reconnected && !targetAhead ==> \result === "direct"
export function syncRequestAnswer(reconnected: boolean, targetAhead: boolean): SyncRequestAnswer {
  if (reconnected) return 'resync-guests';
  if (targetAhead) return 'scheduled';
  return 'direct';
}
