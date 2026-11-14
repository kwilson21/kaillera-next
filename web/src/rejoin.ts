/**
 * What a page does when its signaling socket comes back and the server tells
 * it what the room is doing now.
 *
 * A page whose socket was down hears none of the room's broadcasts. Before
 * this, it rejoined silently and carried on, so it could sit in a game the
 * host had ended, or keep joining a match that had been replaced by a new
 * one. specs/room_lifecycle.qnt has both as violated properties without this
 * rule (`pagesAgreeWithServer`, `lateJoinersChaseTheCurrentMatch`) and as
 * holding with it (`reconciled` there is this function).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * `keep`: the page is in step with the server. `gameEnded`: the room is back
 * in the lobby and the page missed it. `matchReplaced`: the room is playing a
 * different match from the one the page is in.
 */
export type RejoinVerdict = 'keep' | 'gameEnded' | 'matchReplaced';

/**
 * @param inGame        the page believes a game is on (anything but the lobby)
 * @param pageMatchId   the match the page is in or joining; empty if unknown
 * @param roomPlaying   the server says the room is playing
 * @param roomMatchId   the match the server is running; empty if none or unknown
 */
//@ ensures !inGame ==> \result === "keep"
//@ ensures inGame && !roomPlaying ==> \result === "gameEnded"
//@ ensures \result === "matchReplaced" ==> inGame && roomPlaying && pageMatchId !== roomMatchId
//@ ensures inGame && roomPlaying && pageMatchId === roomMatchId ==> \result === "keep"
//@ ensures inGame && roomPlaying && pageMatchId.length > 0 && roomMatchId.length > 0 && pageMatchId !== roomMatchId ==> \result === "matchReplaced"
export function reconcileRejoin(
  inGame: boolean,
  pageMatchId: string,
  roomPlaying: boolean,
  roomMatchId: string,
): string {
  if (!inGame) return 'keep';
  if (!roomPlaying) return 'gameEnded';
  // A match id either side does not know cannot show a replacement.
  if (pageMatchId.length > 0 && roomMatchId.length > 0 && pageMatchId !== roomMatchId) return 'matchReplaced';
  return 'keep';
}

/**
 * What one answer to a rejoin means.
 *
 * `resumed`: the page has its place in the room back. `retry`: ask again
 * (the server answered "Rate limited"). `dropped`: the page is not in the room any more, or cannot
 * get back into it (the grace window ran out, the room is gone, the token is
 * no good): its game is over, and it joins again as a fresh page would,
 * which shows the player whatever error that join meets.
 *
 * @param error  the error text of the server's answer; empty for none
 */
export type RejoinAnswer = 'resumed' | 'retry' | 'dropped';

//@ ensures error.length === 0 ==> \result === "resumed"
//@ ensures error === "Rate limited" ==> \result === "retry"
//@ ensures error.length > 0 && error !== "Rate limited" ==> \result === "dropped"
export function rejoinAnswer(error: string): string {
  if (error.length === 0) return 'resumed';
  if (error === 'Rate limited') return 'retry';
  return 'dropped';
}
