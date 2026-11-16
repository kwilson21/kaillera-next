/**
 * The decisions a guest makes about its resync requests: which state ends
 * the request that is out, which state answers a request given up on, when
 * such a late answer is dropped or kept out of the way of the awaited one,
 * what a late joiner that lost its channel to the host does next, and what
 * a request's deadline does. The engine (web/static/netplay-rollback.js:
 * _endsResyncRequest, _answersAnOlderRequest, _isLateAnswerBehind,
 * _keepsAwaitedAnswer, _resyncAfterLostHost, _checkResyncRequestDeadline)
 * calls these through window.KNCore.resyncRequest; they decide, and its own
 * copies are gone (tests/ts/resync-request.test.ts keeps them, checked
 * against these over a grid of inputs).
 *
 * Requests are numbered from 1, per match; the state that answers one
 * carries its number, and a state the host sent for its own reasons carries
 * 0. The orderings these rules are used in are model-checked in
 * specs/resync_flow.qnt (onlyItsAnswerEndsARequest,
 * aLateAnswerDoesNotTakeTheGuestBack, theAwaitedAnswerIsNotLost) and
 * specs/late_join_pause.qnt (aJoinerIsNotMadeAPlayerBehindTheHost) and
 * specs/resync_reask.qnt (anOwedResyncIsNotForgotten).
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

/**
 * What the resync request's deadline does on a tick. `noRequest`: no
 * request is out. `wait`: the request is out and its answer is arriving, held, or being
 * decoded, or its time has not run out. Once it has run out the request is
 * let go, and then: `lostHost`, the late joiner's lost-host step decides
 * (bounded there); `askAgain`, a "now" resync is owed and is asked for again;
 * `stopAsking`, it was asked for again `maxAsksAgain` times: stop,
 * visibly;
 * `letGo`, nothing is owed (a host state was applied while the request was
 * out: the resync it asked for has happened).
 */
export type DeadlineStep = 'noRequest' | 'wait' | 'lostHost' | 'askAgain' | 'stopAsking' | 'letGo';

/**
 * The resync request's deadline (specs/resync_reask.qnt; I1).
 *
 * A "now" request (a reconnect, a network change, a tab shown again, a
 * missing delta base, the socket fallback) is sent because the guest's state
 * is known to be wrong. The host drops a request inside its 5 s rate limit
 * without a word, and drops nothing it has not received, and the guest drops
 * an older request's answer that would take it back: the request can go
 * unanswered. Its deadline asks again, at most `maxAsksAgain` times
 * (anOwedResyncIsNotForgotten). It does not count while an answer is being
 * decoded, for at most `graceMs` (theDecodedAnswerIsNotCut).
 *
 * @param requestOut     a resync request is out
 * @param answerComing   its answer is arriving or held, or a coordinated target is set
 * @param decoding       an answer is being decoded
 * @param decodingForMs  how long the newest decode has run
 * @param graceMs        the most the deadline waits for a decode
 * @param waitedMs       how long since the request was sent
 * @param timeoutMs      the request's deadline
 * @param lostHostOwed   the late joiner's lost-host resync is owed
 * @param owed           a "now" resync was asked for and none applied since
 * @param asksAgain      asks sent again for it
 * @param maxAsksAgain   the most asks sent again
 */
//@ requires asksAgain >= 0 && maxAsksAgain >= 1
//@ ensures !requestOut ==> \result === "noRequest"
//@ ensures requestOut && answerComing ==> \result === "wait"
//@ ensures requestOut && decoding && decodingForMs < graceMs ==> \result === "wait"
//@ ensures requestOut && waitedMs < timeoutMs ==> \result === "wait"
//@ ensures \result === "lostHost" ==> lostHostOwed
//@ ensures \result === "askAgain" ==> owed && !lostHostOwed && asksAgain < maxAsksAgain
//@ ensures \result === "stopAsking" ==> owed && !lostHostOwed && asksAgain >= maxAsksAgain
//@ ensures \result === "letGo" ==> !owed && !lostHostOwed
//@ ensures requestOut && !answerComing && !(decoding && decodingForMs < graceMs) && waitedMs >= timeoutMs ==> \result !== "wait" && \result !== "noRequest"
export function resyncDeadlineStep(
  requestOut: boolean,
  answerComing: boolean,
  decoding: boolean,
  decodingForMs: number,
  graceMs: number,
  waitedMs: number,
  timeoutMs: number,
  lostHostOwed: boolean,
  owed: boolean,
  asksAgain: number,
  maxAsksAgain: number,
): DeadlineStep {
  if (!requestOut) return 'noRequest';
  if (answerComing) return 'wait';
  if (decoding && decodingForMs < graceMs) return 'wait';
  if (waitedMs < timeoutMs) return 'wait';
  if (lostHostOwed) return 'lostHost';
  if (!owed) return 'letGo';
  if (asksAgain >= maxAsksAgain) return 'stopAsking';
  return 'askAgain';
}

/**
 * What a page does about an ask for a missing input that has gone
 * unanswered (specs/ask_escalation.qnt; I1).
 *
 * A page missing a peer's input asks for it every 500 ms and predicts it
 * meanwhile. If the answer never comes, it predicted that input for the rest
 * of the match while the peer ran on its real value. After `minAsks` asks
 * and `minAgeMs` since the first, it is a resync instead: the host pushes its
 * state to that guest unasked; a guest asks for a coordinated resync. Below
 * either threshold it waits: an answer comes in under 170 ms in good runs and
 * asks go out every 500 ms, so a slow answer is never taken for a lost one
 * (noEarlyEscalation). Nothing is done while a resync is already out.
 *
 * @param isHost         this page is the host
 * @param asksSent       asks sent for the missing input
 * @param firstAskAgeMs  how long since the first of them
 * @param minAsks        the asks before a resync
 * @param minAgeMs       the time since the first ask before a resync
 * @param resyncOut      a push or a coordinated request is out already
 */
export type OverdueAskStep = 'wait' | 'push' | 'ask';
//@ requires minAsks >= 1 && minAgeMs >= 0
//@ ensures (resyncOut || asksSent < minAsks || firstAskAgeMs < minAgeMs) ==> \result === "wait"
//@ ensures \result === "push" <==> !resyncOut && asksSent >= minAsks && firstAskAgeMs >= minAgeMs && isHost
//@ ensures \result === "ask" <==> !resyncOut && asksSent >= minAsks && firstAskAgeMs >= minAgeMs && !isHost
export function overdueAskStep(
  isHost: boolean,
  asksSent: number,
  firstAskAgeMs: number,
  minAsks: number,
  minAgeMs: number,
  resyncOut: boolean,
): OverdueAskStep {
  if (resyncOut || asksSent < minAsks || firstAskAgeMs < minAgeMs) return 'wait';
  return isHost ? 'push' : 'ask';
}

/**
 * The deadline on the host's push to a guest whose input went unanswered
 * (specs/ask_escalation.qnt push_deadline, specs/escalation_push.qnt; I1).
 *
 * A push is a transfer that takes time and has no fixed length: it may wait
 * behind another transfer to that guest, and a transfer runs as long as its
 * chunks keep being accepted. Its deadline starts only when its own state is
 * handed over (MARK_BY_FRAME). The guest's `inputs-settled:` for a state from
 * the first push on ends it (done); a reconnect or a phantom ends it too, its
 * own resync superseding the push (ended). Until the hand-over it is
 * `sending`: a transfer that ended without handing the state over lets it go,
 * and so does a guest's chain that accepted no chunk for `quietLimitMs`,
 * longer than a transfer's own stall limit, so a live transfer always fails
 * by itself first (LET_GO "progress"): never a clock from the push's start.
 * Handed over and unanswered by `timeoutMs`, the host pushes again, up to
 * `maxPushes`, then gives up and drops the player, who rejoins onto the host's
 * state (pushesAreBounded, everyAskEnds). The caller credits a freeze of its
 * page to the clocks (CREDIT_FREEZE).
 *
 * @param pushOut       a push is out
 * @param guestAway     the guest is reconnecting, a phantom, or gone
 * @param settled       the guest acknowledged a state from the first push on
 * @param handedOver    this push's own state was handed over
 * @param sendFailed    this push's own transfer ended without handing it over
 * @param quietMs       since a chunk was last accepted on the guest's chain, or the push started
 * @param quietLimitMs  the most that may pass with no chunk accepted
 * @param waitedMs      how long since it was handed over
 * @param timeoutMs     the deadline after the hand-over
 * @param pushes        pushes sent for this hole
 * @param maxPushes     the most pushes
 */
export type PushDeadlineStep = 'noPush' | 'ended' | 'done' | 'sending' | 'letGo' | 'wait' | 'pushAgain' | 'giveUp';
//@ requires pushes >= 1 && maxPushes >= 1
//@ ensures !pushOut ==> \result === "noPush"
//@ ensures pushOut && guestAway ==> \result === "ended"
//@ ensures pushOut && !guestAway && settled ==> \result === "done"
//@ ensures \result === "sending" <==> pushOut && !guestAway && !settled && !handedOver && !sendFailed && quietMs < quietLimitMs
//@ ensures \result === "letGo" <==> pushOut && !guestAway && !settled && !handedOver && (sendFailed || quietMs >= quietLimitMs)
//@ ensures \result === "wait" <==> pushOut && !guestAway && !settled && handedOver && waitedMs < timeoutMs
//@ ensures \result === "pushAgain" <==> pushOut && !guestAway && !settled && handedOver && waitedMs >= timeoutMs && pushes < maxPushes
//@ ensures \result === "giveUp" <==> pushOut && !guestAway && !settled && handedOver && waitedMs >= timeoutMs && pushes >= maxPushes
export function pushDeadlineStep(
  pushOut: boolean,
  guestAway: boolean,
  settled: boolean,
  handedOver: boolean,
  sendFailed: boolean,
  quietMs: number,
  quietLimitMs: number,
  waitedMs: number,
  timeoutMs: number,
  pushes: number,
  maxPushes: number,
): PushDeadlineStep {
  if (!pushOut) return 'noPush';
  if (guestAway) return 'ended';
  if (settled) return 'done';
  if (!handedOver) return sendFailed || quietMs >= quietLimitMs ? 'letGo' : 'sending';
  if (waitedMs < timeoutMs) return 'wait';
  return pushes < maxPushes ? 'pushAgain' : 'giveUp';
}

/**
 * What an overdue hole of a guest gets (specs/escalation_push.qnt,
 * COUNT_SURVIVES and hole_counts). A push out for that guest holds every
 * further escalation (it brings the guest onto the host's state). Pushes are
 * counted per hole, a push let go included, so holes taking turns cannot
 * reset each other's count: below `maxPushes` the hole is pushed, and past it
 * it is left to the stall path (its deadline, the phantom and its resync)
 * instead of being pushed for ever.
 *
 * @param pushOut     a push is out for this guest
 * @param holePushes  pushes this hole has had
 * @param maxPushes   the most pushes
 */
export type EscalationForHole = 'wait' | 'push' | 'exhausted';
//@ requires maxPushes >= 1 && holePushes >= 0
//@ ensures pushOut ==> \result === "wait"
//@ ensures \result === "push" <==> !pushOut && holePushes < maxPushes
//@ ensures \result === "exhausted" <==> !pushOut && holePushes >= maxPushes
export function escalationForHole(pushOut: boolean, holePushes: number, maxPushes: number): EscalationForHole {
  if (pushOut) return 'wait';
  return holePushes < maxPushes ? 'push' : 'exhausted';
}

/**
 * Whether a transfer's outcome is the push's (specs/escalation_push.qnt,
 * MARK_BY_FRAME): only the push still out, its latest attempt, for the guest
 * it is for, and only once.
 *
 * @param pushIsCurrent     the push is still the one out for its guest
 * @param attemptIsCurrent  the transfer carried the push's latest attempt
 * @param forThisGuest      the outcome is for the push's guest (or for every guest)
 * @param decided           the attempt was already handed over or failed
 */
//@ ensures \result <==> pushIsCurrent && attemptIsCurrent && forThisGuest && !decided
export function transferReportApplies(
  pushIsCurrent: boolean,
  attemptIsCurrent: boolean,
  forThisGuest: boolean,
  decided: boolean,
): boolean {
  return pushIsCurrent && attemptIsCurrent && forThisGuest && !decided;
}

/** Only a fresh acknowledgement of this delivered push may settle it.
 * Pre-delivery high-water marks cannot acknowledge a future transfer.
 * specs/recovery_delivery.qnt prematureAckTest.
 */
//@ ensures \result <==> handedOver && deliveredBefore >= 0 && acknowledgedBefore === deliveredBefore
export function acknowledgesDeliveredPush(
  handedOver: boolean,
  deliveredBefore: number,
  acknowledgedBefore: number,
): boolean {
  return handedOver && deliveredBefore >= 0 && acknowledgedBefore === deliveredBefore;
}

/** A missing hand-over remains owed, with bounded retries and backoff.
 * Call only after pushDeadlineStep returns letGo. */
export type MissedDeliveryStep = 'wait' | 'pushAgain' | 'giveUp';
//@ requires pushes >= 1 && maxPushes >= 1
//@ ensures failed && failedForMs < backoffMs ==> \result === "wait"
//@ ensures \result === "pushAgain" <==> !(failed && failedForMs < backoffMs) && pushes < maxPushes
//@ ensures \result === "giveUp" <==> !(failed && failedForMs < backoffMs) && pushes >= maxPushes
export function missedDeliveryStep(
  failed: boolean,
  failedForMs: number,
  backoffMs: number,
  pushes: number,
  maxPushes: number,
): MissedDeliveryStep {
  if (failed && failedForMs < backoffMs) return 'wait';
  return pushes < maxPushes ? 'pushAgain' : 'giveUp';
}

/** Cumulative per-source capture admission, independent of per-hole ACKs.
 * A rejection triggers source-only eviction rather than indefinite prediction. */
//@ ensures \result === (used < limit)
//@ ensures used >= limit ==> !\result
export function sourceCaptureAllowed(used: number, limit: number): boolean {
  return used < limit;
}
