// One consumed mover input at the host of a 3-player rollback match. The
// bystander already ran the authored input. Receiving it does not confirm the
// host snapshot: draining the C queue and native replay are separate events.
// A direct answer settles this tag on delivery. Reset cancels an old request
// and old transport delivery. An irreparable gap is modeled as a common
// ("mesh") repair, not a speculative direct answer.
//
// Abstract scope: a single input below the settlement floor. Room-wide
// delivery is atomic here, so this does not prove actual per-peer delivery,
// target selection, or eventual delivery in an unavailable network.
module reconnect_settle {
  const GUARD: bool

  type State = {
    gen: int,
    requestGen: int,
    owner: str,
    capture: str,
    cleanAtCapture: bool,
    settled: bool
  }
  var s: State

  action init = s' = {
    gen: 0, requestGen: -1, owner: "owed", capture: "none",
    cleanAtCapture: false, settled: false
  }

  action request = all {
    s.requestGen != s.gen,
    not(s.settled),
    s' = s.with("requestGen", s.gen),
  }

  action receive = all {
    s.owner == "owed",
    not(s.settled),
    s' = s.with("owner", "queued"),
  }

  action drain = all {
    s.owner == "queued",
    not(s.settled),
    s' = s.with("owner", "replaying"),
  }

  action replay = all {
    s.owner == "replaying",
    not(s.settled),
    s' = s.with("owner", "confirmed"),
  }

  action loseWindow = all {
    s.owner == "owed" or s.owner == "queued",
    not(s.settled),
    s' = s.with("owner", "irreparable"),
  }

  // The guard belongs here, not at request or transfer admission.
  action takeDirect = all {
    s.requestGen == s.gen,
    s.capture == "none",
    not(s.settled),
    not(GUARD) or s.owner == "confirmed",
    s' = s.with("capture", "direct").with("cleanAtCapture", s.owner == "confirmed"),
  }

  action takeMesh = all {
    s.requestGen == s.gen,
    s.capture == "none",
    s.owner == "irreparable",
    not(s.settled),
    s' = s.with("capture", "mesh"),
  }

  action deliver = all {
    s.requestGen == s.gen,
    s.capture != "none",
    not(s.settled),
    s' = s.with("settled", true),
  }

  action reset = all {
    s.gen == 0,
    not(s.settled),
    s' = s.with("gen", 1).with("capture", "none").with("cleanAtCapture", false),
  }

  action stutter = s' = s

  action step = any { request, receive, drain, replay, loseWindow, takeDirect, takeMesh, deliver, reset, stutter }

  val directSettlementIsConfirmed = not(s.settled and s.capture == "direct") or s.cleanAtCapture
  val staleRequestCannotSettle = s.requestGen != s.gen implies not(s.settled)
}

module reconnect_settle_guarded {
  import reconnect_settle(GUARD = true).*

  run confirmedBacklogTest = init
    .then(request).then(receive).then(drain).then(replay)
    .then(takeDirect).then(deliver)
    .expect(directSettlementIsConfirmed and s.settled)

  run lostWindowUsesMeshTest = init
    .then(request).then(loseWindow).then(takeMesh).then(deliver)
    .expect(directSettlementIsConfirmed and s.settled and s.capture == "mesh")

  run oldGenerationCannotDeliverTest = init
    .then(request).then(receive).then(drain).then(replay).then(takeDirect).then(reset)
    .expect(staleRequestCannotSettle and s.capture == "none")
}

module reconnect_settle_unguarded {
  import reconnect_settle(GUARD = false).*

  run requestBeforeInputCounterexampleTest = init
    .then(request).then(takeDirect).then(deliver)
    .expect(not(directSettlementIsConfirmed))

  run receiptBeforeReplayCounterexampleTest = init
    .then(request).then(receive).then(drain).then(takeDirect).then(deliver)
    .expect(not(directSettlementIsConfirmed))
}

// Model wall-clock wakes while the frame pump is idle. Native readiness
// means the current owner's input has been replayed at an aligned frame.
module host_reconnect_clock {
  const RECOVERY_CLOCK: bool
  pure val LIMIT = 3
  var asks: int
  var outcome: str
  var confirmed: bool

  action init = all { asks' = 0, outcome' = "waiting", confirmed' = false }
  action wake(at: int, frameTick: bool, nativeReady: bool): bool = {
    val service = (RECOVERY_CLOCK or frameTick) and outcome == "waiting"
    all {
      asks' = if (service and at < LIMIT and not(nativeReady) and asks < at) asks + 1 else asks,
      outcome' =
        if (not(service)) outcome
        else if (at >= LIMIT) "expired"
        else if (nativeReady) "captured"
        else "waiting",
      confirmed' = (confirmed or (service and (at < LIMIT) and nativeReady)),
    }
  }
  action step = {
    nondet at = 1.to(LIMIT).oneOf()
    nondet frameTick = Set(false, true).oneOf()
    nondet nativeReady = Set(false, true).oneOf()
    wake(at, frameTick, nativeReady)
  }
  val noCaptureBeforeProof = outcome != "captured" or confirmed

  run stoppedFramesStillRetryAndExpireTest =
    init.then(wake(1, false, false)).then(wake(2, false, false)).then(wake(3, false, false))
      .expect(outcome == (if (RECOVERY_CLOCK) "expired" else "waiting") and asks == (if (RECOVERY_CLOCK) 2 else 0))
      .then(wake(3, false, true))
      .expect(outcome != "captured")

  run stoppedFramesCanSettleAfterReplayTest =
    init.then(wake(1, false, false)).expect(outcome == "waiting")
      .then(wake(2, false, true))
      .expect(outcome == (if (RECOVERY_CLOCK) "captured" else "waiting"))
}

module host_reconnect_clock_before {
  import host_reconnect_clock(RECOVERY_CLOCK = false).*
}

module host_reconnect_clock_fixed {
  import host_reconnect_clock(RECOVERY_CLOCK = true).*
}

// A pacing decision is not evidence about a consumed input. The returning
// owner already has a nonce- and route-scoped native receipt ledger.
module host_reconnect_pacing_proof {
  const TRUST_LEDGER: bool
  var missing: int
  var returnedPhantom: bool
  var bystanderUnproved: bool
  var captured: bool

  action init = all { missing' = 0, returnedPhantom' = false, bystanderUnproved' = false, captured' = false }
  action observe(missingInputs: int, returning: bool, bystander: bool): bool = all {
    missing' = missingInputs,
    returnedPhantom' = returning,
    bystanderUnproved' = bystander,
    captured' = false,
  }
  action tryCapture = all {
    missing' = missing,
    returnedPhantom' = returnedPhantom,
    bystanderUnproved' = bystanderUnproved,
    captured' = (missing == 0 and not(bystanderUnproved) and (TRUST_LEDGER or not(returnedPhantom))),
  }
  action step = {
    nondet missingInputs = Set(0, 1, 2).oneOf()
    nondet returning = Bool.oneOf()
    nondet bystander = Bool.oneOf()
    any { observe(missingInputs, returning, bystander), tryCapture }
  }
  val captureNeedsEachOwnersInputs = not(captured) or (missing == 0 and not(bystanderUnproved))

  run unchangedHistoryCanStillCaptureTest =
    init.then(observe(0, true, false)).then(tryCapture).expect(captured == TRUST_LEDGER)

  run unprovedInputsStillBlockCaptureTest =
    init.then(observe(1, true, false)).then(tryCapture).expect(not(captured))
      .then(observe(0, true, true)).then(tryCapture).expect(not(captured))
}

module host_reconnect_pacing_proof_before {
  import host_reconnect_pacing_proof(TRUST_LEDGER = false).*
}

module host_reconnect_pacing_proof_fixed {
  import host_reconnect_pacing_proof(TRUST_LEDGER = true).*
}
