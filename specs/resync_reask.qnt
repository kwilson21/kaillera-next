// -*- mode: Bluespec; -*-
//
// A guest's "now" resync request (no target frame) and its deadline: the
// requests sent on a reconnect, a network change, a hidden tab shown again,
// a missing delta base and the socket fallback (sync-request-full,
// sync-request-full-socket), the request's deadline in tick()
// (_checkResyncRequestDeadline, RESYNC-REQUEST-TIMEOUT) and the guest's
// decode of the answer (handleSyncChunksComplete, handleSocketSyncState,
// _handleDecodedSyncPayload) in web/static/netplay-rollback.js.
//
// Each of those requests is sent because the guest's state is known to be
// wrong: after a reconnect it ran on fabricated inputs. The host answers one
// request per guest every 5 s and drops the rest without a word, and the
// guest may ask again inside that window (a reconnect overrides the request
// out: "lifecycle resync always wins"). Each request has a number, and the
// guest drops an answer to an older request that would take it back
// (specs/resync_flow.qnt, lateAndBehind). So the newest request can be
// dropped by the host while the only answer that comes is the older one's,
// and that one is dropped by the guest. The deadline (8 s, longer than the
// host's rate limit) then let the request go and asked nothing: the guest
// ran on with the state it had asked to replace, until a desync check asked
// again, if the match had one (found reading the code, 2026-11). The
// late-join lost-host resync is the one request that asked again, bounded
// (specs/late_join_pause.qnt).
//
// The deadline does not count while an answer is arriving (_syncExpected) or
// held (_pendingResyncState). Between the two the answer is decoded:
// handleSyncChunksComplete sets _syncExpected to 0 and then waits for the
// worker to decompress it (and, for a delta, to XOR it), and the socket path
// waits the same way. A deadline in that window let the request go while its
// answer was on its way; today that is harmless (the answer still ends the
// request), but a deadline that asks again makes the answer an older
// request's, to be dropped if it is behind (askAgainCutsTheDecodeTest).
//
// What is modelled: one guest and the host, the requests and answers in
// order, a request lost with its channel, the host's rate limit, the decode,
// the hold, the deadline, the "now" requests the guest sends on its own (any
// time), and whether an older answer is behind (any way).
//
// Not modelled: the "at frame T" requests after a desync (their target has
// its own deadline, and the desync check asks again; specs/resync_flow.qnt),
// chunks and their own timeout (the chunk timeout asks again over the
// socket), the 15 s lifecycle guard, more than one guest, and the late-join
// lost-host resync (its own bound, checked first by the deadline). The
// decode is a worker round trip; the engine bounds the wait for it
// (SYNC_DECODE_GRACE_MS) so a lost worker reply does not hold the deadline
// off for good (I1).
//
// ASK_AGAIN: at its deadline an unanswered "now" request is sent again, at
//   most MAX_ASKS_AGAIN times; after the last one goes unanswered the guest
//   gives up, visibly (RESYNC-REASK-GIVEUP). The fix.
//
// HOLD_WHILE_DECODING: the deadline does not count while an answer is being
//   decoded (for at most the decode's own bound). The fix's other half.
//
// GUARD_LETS_GO: the lifecycle resync guard (armed by the request a tab
//   shown again sends; it holds the player's input) times out after 15 s
//   and let go of whatever request was out (_resyncRequestInFlight =
//   false). With the ask again, that request is the ask again, sent at 8 s
//   with the guard left as it was: let go one second before its own
//   deadline, it is never asked again (guardLetsGoOfTheAskAgainTest; found
//   by review, #243). The request's own deadline bounds it (I1), so the
//   guard now releases the input only.
module resync_reask {
  const ASK_AGAIN: bool
  const HOLD_WHILE_DECODING: bool
  const GUARD_LETS_GO: bool
  const COORDINATED_OWES: bool

  pure val MAX_ASKS_AGAIN = 2
  // The "now" requests the guest sends on its own in one run.
  pure val MAX_OWN_ASKS = 2

  var newest: int            // _resyncRequestId: the newest request's number
  var inFlight: bool         // _resyncRequestInFlight
  var owed: bool             // a "now" resync was asked for and none applied since
  // History: a resync was asked for, either way, and none applied since nor
  // given up visibly.
  var asked: bool
  var asksAgain: int         // asks sent again at the deadline for the owed resync
  var ownAsks: int           // requests sent on the guest's own (bound for the model)
  var hostWaits: bool        // the host's rate limit: it drops a request now
  var toHost: List[int]      // requests on their way, by number
  var toGuest: List[int]     // answers on their way, by the request they answer
  var decoding: int          // the request whose answer is being decoded (0 = none)
  var held: int              // _pendingResyncState.answerFor (0 = none)
  var gaveUp: bool           // RESYNC-REASK-GIVEUP
  // History: the deadline let a request go while its own answer was being
  // decoded.
  var cutWhileDecoding: bool

  action init = all {
    newest' = 0, inFlight' = false, owed' = false, asksAgain' = 0, ownAsks' = 0, asked' = false,
    hostWaits' = false, toHost' = List(), toGuest' = List(), decoding' = 0, held' = 0,
    gaveUp' = false, cutWhileDecoding' = false,
  }

  // A request lost with its channel (the channel closed on the way).
  action requestLost = all {
    toHost.length() > 0,
    toHost' = toHost.tail(),
    newest' = newest, inFlight' = inFlight, owed' = owed, asksAgain' = asksAgain, ownAsks' = ownAsks, asked' = asked,
    hostWaits' = hostWaits, toGuest' = toGuest, decoding' = decoding, held' = held,
    gaveUp' = gaveUp, cutWhileDecoding' = cutWhileDecoding,
  }

  // A reconnect, a network change, a tab shown again: the guest sends a
  // "now" request over whatever is out.
  action ownAsk = all {
    ownAsks < MAX_OWN_ASKS,
    ownAsks' = ownAsks + 1,
    newest' = newest + 1, inFlight' = true, owed' = true, asksAgain' = 0, asked' = true,
    toHost' = toHost.append(newest + 1),
    hostWaits' = hostWaits, toGuest' = toGuest, decoding' = decoding, held' = held,
    gaveUp' = false, cutWhileDecoding' = cutWhileDecoding,
  }

  // A dropped peer is back (PEER-RECOVERED): the guest asks for a resync at
  // a frame (`sync-request-full-at:`). Today it owes nothing: when its
  // answer does not come the deadline lets it go (step=letGo), and the
  // desync check meant to ask again sends nothing any more (no page sends
  // `sync-hash:`). With COORDINATED_OWES it is owed like a "now" request.
  action coordAsk = all {
    ownAsks < MAX_OWN_ASKS,
    ownAsks' = ownAsks + 1,
    newest' = newest + 1, inFlight' = true, asked' = true,
    owed' = if (COORDINATED_OWES) true else owed,
    asksAgain' = if (COORDINATED_OWES) 0 else asksAgain,
    toHost' = toHost.append(newest + 1),
    hostWaits' = hostWaits, toGuest' = toGuest, decoding' = decoding, held' = held,
    gaveUp' = false, cutWhileDecoding' = cutWhileDecoding,
  }

  // The host answers, or drops the request inside its rate limit.
  action hostReceives = all {
    toHost.length() > 0,
    toHost' = toHost.tail(),
    if (hostWaits) all { toGuest' = toGuest, hostWaits' = true }
    else all { toGuest' = toGuest.append(toHost.head()), hostWaits' = true },
    newest' = newest, inFlight' = inFlight, owed' = owed, asksAgain' = asksAgain, ownAsks' = ownAsks, asked' = asked,
    decoding' = decoding, held' = held, gaveUp' = gaveUp, cutWhileDecoding' = cutWhileDecoding,
  }

  // 5 s pass on the host's side.
  action hostRateLimitEnds = all {
    hostWaits,
    hostWaits' = false,
    newest' = newest, inFlight' = inFlight, owed' = owed, asksAgain' = asksAgain, ownAsks' = ownAsks, asked' = asked,
    toHost' = toHost, toGuest' = toGuest, decoding' = decoding, held' = held,
    gaveUp' = gaveUp, cutWhileDecoding' = cutWhileDecoding,
  }

  // The last chunk arrives: the guest starts decoding it (one at a time:
  // the next answer's chunks wait behind it on the channel).
  action answerArrives = all {
    toGuest.length() > 0, decoding == 0,
    toGuest' = toGuest.tail(), decoding' = toGuest.head(), toHost' = toHost,
    newest' = newest, inFlight' = inFlight, owed' = owed, asksAgain' = asksAgain, ownAsks' = ownAsks, asked' = asked,
    hostWaits' = hostWaits, held' = held, gaveUp' = gaveUp, cutWhileDecoding' = cutWhileDecoding,
  }

  // The decode finishes. The newest request's answer ends it and is held.
  // An older one's is dropped if it is behind; if not, it is held unless the
  // newest one's is (_keepsAwaitedAnswer).
  action decoded(behind: bool): bool = all {
    decoding != 0,
    decoding' = 0,
    if (decoding == newest) all { inFlight' = false, held' = decoding }
    else all {
      inFlight' = inFlight,
      held' = if (behind or held == newest) held else decoding,
    },
    newest' = newest, owed' = owed, asksAgain' = asksAgain, ownAsks' = ownAsks, asked' = asked,
    hostWaits' = hostWaits, toHost' = toHost, toGuest' = toGuest,
    gaveUp' = gaveUp, cutWhileDecoding' = cutWhileDecoding,
  }

  // The held state is applied at the next frame boundary: the owed resync is done.
  action apply = all {
    held != 0,
    held' = 0, owed' = false, asksAgain' = 0, asked' = false,
    newest' = newest, inFlight' = inFlight, ownAsks' = ownAsks,
    hostWaits' = hostWaits, toHost' = toHost, toGuest' = toGuest, decoding' = decoding,
    gaveUp' = gaveUp, cutWhileDecoding' = cutWhileDecoding,
  }

  // RESYNC-REQUEST-TIMEOUT: 8 s since the request was sent, nothing held and
  // nothing arriving. The host's rate limit (5 s) has ended by then: it began
  // with a request the host took before this one was sent.
  action deadline = all {
    inFlight, held == 0, not(hostWaits),
    not(HOLD_WHILE_DECODING) or decoding == 0,
    val again = ASK_AGAIN and owed and asksAgain < MAX_ASKS_AGAIN
    val giveUp = ASK_AGAIN and owed and asksAgain >= MAX_ASKS_AGAIN
    all {
      cutWhileDecoding' = (cutWhileDecoding or decoding == newest),
      asked' = if (giveUp) false else asked,
      if (again) all {
        newest' = newest + 1, inFlight' = true, asksAgain' = asksAgain + 1,
        toHost' = toHost.append(newest + 1), owed' = owed, gaveUp' = false,
      } else all {
        newest' = newest, inFlight' = false, asksAgain' = asksAgain, toHost' = toHost,
        owed' = if (giveUp) false else owed, gaveUp' = giveUp,
      },
    },
    ownAsks' = ownAsks, hostWaits' = hostWaits, toGuest' = toGuest, decoding' = decoding, held' = held,
  }

  // The lifecycle guard's timeout lets the request that is out go.
  action guardTimesOut = all {
    GUARD_LETS_GO, inFlight,
    inFlight' = false,
    newest' = newest, owed' = owed, asksAgain' = asksAgain, ownAsks' = ownAsks, asked' = asked,
    hostWaits' = hostWaits, toHost' = toHost, toGuest' = toGuest, decoding' = decoding, held' = held,
    gaveUp' = gaveUp, cutWhileDecoding' = cutWhileDecoding,
  }

  // Time passes and nothing happens (for the scenarios).
  action nothingHappens = all {
    newest' = newest, inFlight' = inFlight, owed' = owed, asksAgain' = asksAgain, ownAsks' = ownAsks, asked' = asked,
    hostWaits' = hostWaits, toHost' = toHost, toGuest' = toGuest, decoding' = decoding, held' = held,
    gaveUp' = gaveUp, cutWhileDecoding' = cutWhileDecoding,
  }

  action step = any {
    ownAsk, coordAsk, hostReceives, requestLost, hostRateLimitEnds, answerArrives, apply, deadline, guardTimesOut,
    nondet behind = oneOf(Set(true, false))
    decoded(behind),
  }

  // ── properties ─────────────────────────────────────────────────────────

  // Nothing is coming for the owed resync and nothing will ask for it.
  def forgotten: bool =
    owed and not(inFlight) and held == 0 and decoding == 0 and toGuest == List() and toHost == List()

  // An owed resync is asked for again or given up visibly; it is never
  // forgotten. Violated today: the deadline lets the request go and asks
  // nothing (lateAnswerBehindTest, lostRequestTest).
  val anOwedResyncIsNotForgotten = not(forgotten)

  // The deadline does not let a request go while its own answer is being
  // decoded. Violated today and with the ask again alone
  // (askAgainCutsTheDecodeTest).
  val theDecodedAnswerIsNotCut = not(cutWhileDecoding)

  // The asks again are bounded.
  val asksAgainAreBounded = asksAgain <= MAX_ASKS_AGAIN

  // A resync asked for either way is applied, still on its way, or given
  // up visibly: never left with nothing out. Violated with a coordinated
  // request that owes nothing (coordinatedAnswerLostTest; found by the
  // two-player run UNANSWERED_SOCKET_RESYNC=letgo).
  val aResyncAskedForIsNotForgotten =
    not(asked and not(inFlight) and held == 0 and decoding == 0 and toGuest == List() and toHost == List())

  val allHold = anOwedResyncIsNotForgotten and theDecodedAnswerIsNotCut and asksAgainAreBounded and
    aResyncAskedForIsNotForgotten

  // ── scenarios ──────────────────────────────────────────────────────────

  // Two reconnects close together: the host answers the first and drops the
  // second; the first's answer is behind and is dropped. At the deadline
  // the guest asks again (fixed) or forgets (today).
  run lateAnswerBehindTest =
    init
      .then(ownAsk).then(hostReceives)
      .then(ownAsk).then(hostReceives)
      .expect(toGuest == List(1) and toHost == List())
      .then(answerArrives).then(decoded(true))
      .expect(held == 0 and inFlight and newest == 2)
      .then(hostRateLimitEnds)
      .then(deadline)
      .expect(anOwedResyncIsNotForgotten == ASK_AGAIN)
      .expect(if (ASK_AGAIN) toHost == List(3) and asksAgain == 1 else not(inFlight))
      .then(if (ASK_AGAIN) hostReceives.then(answerArrives).then(decoded(false)).then(apply) else nothingHappens)
      .expect(if (ASK_AGAIN) not(owed) and allHold else forgotten)

  // The request is lost with its channel: nothing at all comes.
  run lostRequestTest =
    init
      .then(ownAsk).then(requestLost)
      .then(deadline)
      .expect(anOwedResyncIsNotForgotten == ASK_AGAIN)
      .expect(if (ASK_AGAIN) toHost == List(2) else forgotten)

  // Every ask is lost: the guest gives up after the last one, visibly.
  run askAgainGivesUpTest =
    if (not(ASK_AGAIN)) init else init
      .then(ownAsk).then(requestLost).then(deadline)
      .expect(asksAgain == 1 and toHost == List(2))
      .then(requestLost).then(deadline)
      .expect(asksAgain == 2 and toHost == List(3))
      .then(requestLost).then(deadline)
      .expect(not(owed) and gaveUp and not(inFlight) and toHost == List() and allHold)

  // The answer's last chunk arrived and is being decoded when 8 s pass. Today
  // the deadline lets the request go (harmless: the answer still ends it).
  // Asking again there makes the answer an older request's, dropped when it
  // is behind. Holding while it decodes, the answer ends the request.
  run askAgainCutsTheDecodeTest =
    init
      .then(ownAsk).then(hostReceives).then(hostRateLimitEnds)
      .then(answerArrives)
      .expect(decoding == 1)
      .then(if (HOLD_WHILE_DECODING) decoded(true) else deadline)
      .expect(theDecodedAnswerIsNotCut == HOLD_WHILE_DECODING)
      .expect(if (HOLD_WHILE_DECODING) held == 1 and not(inFlight)
              else if (ASK_AGAIN) newest == 2 and inFlight else not(inFlight))
      .then(if (HOLD_WHILE_DECODING) apply else decoded(true))
      // Fixed: applied. Asking again unguarded: the answer was dropped and a
      // second one is on its way. Today: held, since it still ends the request.
      .expect(if (HOLD_WHILE_DECODING) not(owed) else if (ASK_AGAIN) held == 0 and owed else held == 1)

  // A tab shown again asks; the request is lost; at its deadline the guest
  // asks again, and that one is lost too. The guard, armed by the first,
  // times out before the ask again's deadline: today and with the ask again
  // alone it lets the request go, and nothing asks again.
  run guardLetsGoOfTheAskAgainTest =
    init
      .then(ownAsk).then(requestLost).then(deadline)
      .then(if (ASK_AGAIN) requestLost else nothingHappens)
      // Today the first deadline already let it go: there is nothing out.
      .then(if (not(ASK_AGAIN)) nothingHappens else if (GUARD_LETS_GO) guardTimesOut else deadline)
      .expect(anOwedResyncIsNotForgotten == (ASK_AGAIN and not(GUARD_LETS_GO)))
      .expect(if (ASK_AGAIN and not(GUARD_LETS_GO)) asksAgain == 2 and toHost == List(3) else true)

  // A dropped peer is back and the guest asks at a frame; the request is
  // lost. Today the deadline lets it go and nothing asks again; with the
  // fix it is asked for again.
  run coordinatedAnswerLostTest =
    init
      .then(coordAsk).then(requestLost).then(deadline)
      .expect(aResyncAskedForIsNotForgotten == (COORDINATED_OWES and ASK_AGAIN))
      .expect(if (COORDINATED_OWES and ASK_AGAIN) toHost == List(2) and asksAgain == 1 else not(inFlight))

  // The plain case: asked, answered, applied; the deadline never fires.
  run answeredTest =
    init
      .then(ownAsk).then(hostReceives).then(answerArrives).then(decoded(false)).then(apply)
      .expect(not(owed) and not(inFlight) and allHold)
}

// Today: the deadline lets the request go and asks nothing.
module resync_reask_current {
  import resync_reask(
    ASK_AGAIN = false, HOLD_WHILE_DECODING = false, GUARD_LETS_GO = true, COORDINATED_OWES = false
  ).*
}

// Asking again without holding the deadline while an answer decodes.
module resync_reask_unguarded {
  import resync_reask(
    ASK_AGAIN = true, HOLD_WHILE_DECODING = false, GUARD_LETS_GO = false, COORDINATED_OWES = false
  ).*
}

// Asking again, holding while an answer decodes, and the guard's timeout
// still letting the request go (#243 as first pushed).
module resync_reask_guard_lets_go {
  import resync_reask(
    ASK_AGAIN = true, HOLD_WHILE_DECODING = true, GUARD_LETS_GO = true, COORDINATED_OWES = false
  ).*
}

// #248: the ask again with the decode hold and the guard's timeout fixed;
// a coordinated request still owes nothing.
module resync_reask_coordinated_let_go {
  import resync_reask(
    ASK_AGAIN = true, HOLD_WHILE_DECODING = true, GUARD_LETS_GO = false, COORDINATED_OWES = false
  ).*
}

// The fix.
module resync_reask_fixed {
  import resync_reask(
    ASK_AGAIN = true, HOLD_WHILE_DECODING = true, GUARD_LETS_GO = false, COORDINATED_OWES = true
  ).*
}
