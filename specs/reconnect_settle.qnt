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
