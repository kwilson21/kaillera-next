/**
 * What a page does when it hears again from a player it held as a phantom
 * (PEER-RECOVERED in web/static/netplay-rollback.js's input handler).
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
