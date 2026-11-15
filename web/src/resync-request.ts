/**
 * The decisions a guest makes about its resync requests: which state ends
 * the request that is out, which state answers a request given up on, when
 * such a late answer is dropped or kept out of the way of the awaited one,
 * and what a late joiner that lost its channel to the host does next. Each
 * is the rule the engine applies today (web/static/netplay-rollback.js:
 * _endsResyncRequest, _answersAnOlderRequest, _isLateAnswerBehind,
 * _keepsAwaitedAnswer, _resyncAfterLostHost), written as a function with a
 * contract so the rule can be proved and then called from one place.
 *
 * Requests are numbered from 1, per match; the state that answers one
 * carries its number, and a state the host sent for its own reasons carries
 * 0. The orderings these rules are used in are model-checked in
 * specs/resync_flow.qnt (onlyItsAnswerEndsARequest,
 * aLateAnswerDoesNotTakeTheGuestBack, theAwaitedAnswerIsNotLost) and
 * specs/late_join_pause.qnt (aJoinerIsNotMadeAPlayerBehindTheHost).
 * Nothing here changes behaviour: the engine runs these beside its own rules
 * and reports a difference as a `resync-disagree` client event.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * Does this state end the request that is out?
 *
 * Only its own answer does (onlyItsAnswerEndsARequest): the answer to a
 * request given up on never ends the newer one. A state with no number ends
 * it only while the host has not shown that it numbers its answers (a host
 * on a version that does not), as every state did before.
 *
 * @param answerFor    the number of the request the state answers; 0 for none
 * @param newest       the number of the newest request this page sent
 * @param hostNumbers  the host has numbered an answer since its peer state was reset
 */
//@ ensures answerFor > 0 ==> \result === (answerFor === newest)
//@ ensures answerFor <= 0 ==> \result === !hostNumbers
//@ ensures answerFor > 0 && answerFor !== newest ==> !\result
export function endsRequest(answerFor: number, newest: number, hostNumbers: boolean): boolean {
  if (answerFor > 0) return answerFor === newest;
  return !hostNumbers;
}

/**
 * Is this state the answer to a request older than the newest one?
 *
 * A state with no number answers no request, so it is never one.
 *
 * @param answerFor  the number of the request the state answers; 0 for none
 * @param newest     the number of the newest request this page sent
 */
//@ ensures \result === (answerFor > 0 && answerFor !== newest)
//@ ensures \result ==> answerFor !== newest
//@ ensures answerFor <= 0 ==> !\result
export function answersAnOlderRequest(answerFor: number, newest: number): boolean {
  return answerFor > 0 && answerFor !== newest;
}

/**
 * Is the held state an older request's answer that, applied now, would take
 * the guest back: from before the frame the guest is on, or from before the
 * frame the newest request named (aLateAnswerDoesNotTakeTheGuestBack, the
 * model's lateAndBehind)? It is dropped. Checked on each tick before the
 * state is held or applied, so a late answer is applied only at or ahead of
 * the guest, whether or not the newest request named a frame. The frame
 * named is the request's, not the live target: the target's deadline gives
 * the target up, and the state is as old after it as before.
 *
 * Never the newest request's own answer, and never a state with no number:
 * a state the host sent for its own reasons is applied as before (the model
 * leaves it out on purpose).
 *
 * @param answerFor   the number of the request the held state answers; 0 for none
 * @param frame       the held state's frame
 * @param newest      the number of the newest request this page sent
 * @param askedAt     the frame the newest request named; 0 or less when it named none
 * @param guestFrame  the frame this page is on
 */
//@ ensures \result === (answerFor > 0 && answerFor !== newest && (frame < guestFrame || (askedAt > 0 && frame < askedAt)))
//@ ensures \result ==> frame < guestFrame || frame < askedAt
//@ ensures answerFor > 0 && answerFor !== newest && frame < guestFrame ==> \result
//@ ensures answerFor === newest ==> !\result
//@ ensures answerFor <= 0 ==> !\result
//@ ensures frame >= guestFrame && askedAt <= 0 ==> !\result
//@ ensures frame >= guestFrame && frame >= askedAt ==> !\result
export function isLateAnswerBehind(
  answerFor: number,
  frame: number,
  newest: number,
  askedAt: number,
  guestFrame: number,
): boolean {
  if (answerFor <= 0 || answerFor === newest) return false;
  return frame < guestFrame || (askedAt > 0 && frame < askedAt);
}

/**
 * Is this state set aside because the answer to the newest request is
 * already held? An older request's answer finishing its decode later (one
 * over the socket, one over the channel) does not take that answer's place
 * (theAwaitedAnswerIsNotLost). Any other state is buffered as before.
 *
 * @param answerFor      the number of the request the arriving state answers; 0 for none
 * @param newest         the number of the newest request this page sent
 * @param heldAnswerFor  the number the held state answers; -1 when no state is held
 */
//@ ensures \result === (answerFor > 0 && answerFor !== newest && heldAnswerFor === newest)
//@ ensures answerFor > 0 && answerFor !== newest && heldAnswerFor === newest ==> \result
//@ ensures \result ==> heldAnswerFor === newest
//@ ensures answerFor === newest ==> !\result
//@ ensures answerFor <= 0 ==> !\result
//@ ensures newest >= 0 && heldAnswerFor < 0 ==> !\result
export function keepsAwaitedAnswer(answerFor: number, newest: number, heldAnswerFor: number): boolean {
  if (answerFor <= 0 || answerFor === newest) return false;
  return heldAnswerFor === newest;
}

/**
 * `idle`: there is nothing to ask for (no lost host channel on record, this
 * page is the host, or the match is not running here). `waitForChannel`: the
 * channel to the host is not open; its opening asks. `inFlight`: a request
 * is already out; its answer, applied, clears the marker, and its deadline
 * asks again if none comes. `giveUp`: the bound is reached; stop asking,
 * visibly. `ask`: send a full resync request.
 */
export type LostHostStep = 'idle' | 'waitForChannel' | 'inFlight' | 'giveUp' | 'ask';

/**
 * What a late joiner that lost its channel to the host while it waited for
 * or loaded the state does next (specs/late_join_pause.qnt,
 * aJoinerIsNotMadeAPlayerBehindTheHost; resyncRequestUnansweredTest).
 *
 * It asks only with the channel open and no request out, and never more
 * than `maxAsks` times: each ask counts, and at the bound it gives up.
 *
 * @param marked       the channel to the host was lost during the late join, and no host state has been applied since
 * @param isHost       this page is the host
 * @param running      the match is running on this page
 * @param channelOpen  the data channel to the host is open
 * @param requestOut   a resync request is out
 * @param asks         requests sent since the marker was set
 * @param maxAsks      the most requests it sends
 */
//@ requires asks >= 0 && maxAsks >= 1
//@ ensures !marked || isHost || !running ==> \result === "idle"
//@ ensures marked && !isHost && running && !channelOpen ==> \result === "waitForChannel"
//@ ensures marked && !isHost && running && channelOpen && requestOut ==> \result === "inFlight"
//@ ensures marked && !isHost && running && channelOpen && !requestOut && asks >= maxAsks ==> \result === "giveUp"
//@ ensures marked && !isHost && running && channelOpen && !requestOut && asks < maxAsks ==> \result === "ask"
//@ ensures \result === "ask" ==> channelOpen && !requestOut && asks < maxAsks
//@ ensures \result === "giveUp" ==> asks >= maxAsks
export function lateJoinLostHostStep(
  marked: boolean,
  isHost: boolean,
  running: boolean,
  channelOpen: boolean,
  requestOut: boolean,
  asks: number,
  maxAsks: number,
): LostHostStep {
  if (!marked || isHost || !running) return 'idle';
  if (!channelOpen) return 'waitForChannel';
  if (requestOut) return 'inFlight';
  if (asks >= maxAsks) return 'giveUp';
  return 'ask';
}
