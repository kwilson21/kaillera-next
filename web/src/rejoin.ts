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
