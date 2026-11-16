/**
 * Is a player who appears in the room held as a late joiner, or are they one
 * of the players this page starts or runs the match with?
 *
 * The players who had loaded when the initial state sync began are the
 * start's cohort. The ready barrier that follows waits for the cohort and
 * for nobody else: a player who joins after the sync began was never sent
 * that state and can never become ready, so counting them stopped the match
 * from ever running, and they never got its state either. In
 * specs/room_lifecycle.qnt this is `startIsNotHeldUpByALateJoiner`, violated
 * when the barrier counts every listed player.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * @param running     this page is running the match
 * @param syncBegun   this page has begun (or finished) the initial sync but is not running yet
 * @param inCohort    the player's slot was one of those that began that sync
 * @param slotActive  the player's slot is already playing in the running match
 */
//@ ensures running ==> \result === !slotActive
//@ ensures !running && !syncBegun ==> \result === false
//@ ensures !running && syncBegun ==> \result === !inCohort
export function heldAsLateJoiner(
  running: boolean,
  syncBegun: boolean,
  inCohort: boolean,
  slotActive: boolean,
): boolean {
  if (running) return !slotActive;
  if (!syncBegun) return false;
  return !inCohort;
}
