// A Socket.IO roster send holds the room lock and waits for its recipients'
// transport callbacks. A closed transport can report its disconnect during
// that send. Only room membership needs the lock; the transport can return
// first, and the room later applies its usual grace or leave rule by old SID.
module room_disconnect_cleanup {
  const DEFER_WHILE_SENDING: bool
  const MARK_ON_SIGNAL: bool

  var s: { sending: bool, callback: str, member: str, phase: str, atSignal: str }

  action init = s' = { sending: false, callback: "none", member: "old", phase: "running", atSignal: "" }

  val stopping = s.phase == "lifespan" or (MARK_ON_SIGNAL and s.phase == "signaled")

  action sendRoster = all {
    not(s.sending), s.phase == "running", s.callback == "none",
    s' = s.with("sending", true),
  }

  action transportCloses = all {
    s.callback == "none", s.member == "old",
    val callbackAfter = if (stopping) "done"
               else if (s.sending and not(DEFER_WHILE_SENDING)) "awaitRoom"
               else if (s.sending) "pending" else "done"
    s' = s.with("callback", callbackAfter).with("member",
      if (not(s.sending) and not(stopping)) "removed" else s.member),
  }

  action sendReturns = all {
    s.sending, s.callback != "awaitRoom",
    s' = s.with("sending", false),
  }

  action reclaim = all {
    not(s.sending), s.phase == "running", s.callback == "pending", s.member == "old",
    s' = s.with("member", "new"),
  }

  // Uvicorn handles the signal, closes transports, then runs ASGI lifespan shutdown.
  action shutdownSignal = all {
    s.phase == "running", s' = s.with("phase", "signaled").with("atSignal", s.member),
  }

  action lifespanShutdown = all {
    s.phase == "signaled", not(s.sending), Set("done", "pending").contains(s.callback),
    s' = s.with("phase", "lifespan"),
  }

  action finishCleanup = all {
    not(s.sending), s.callback == "pending",
    s' = s.with("callback", "done").with("member",
      if (stopping or s.member != "old") s.member else "removed"),
  }

  action step = any { sendRoster, transportCloses, sendReturns, reclaim, shutdownSignal, lifespanShutdown, finishCleanup, s' = s }
  val callbackCanReturn = not(s.sending and s.callback == "awaitRoom")
  val shutdownKeepsMembers = s.phase == "running" or s.member == s.atSignal
  val allHold = callbackCanReturn and shutdownKeepsMembers

  run disconnectDuringSendTest = init.then(sendRoster).then(transportCloses)
    .expect(callbackCanReturn == DEFER_WHILE_SENDING)
  run unlockedCleanupTest = init.then(transportCloses).expect(s.member == "removed")
  run signalBeforeTransportCloseTest = init.then(shutdownSignal).then(transportCloses)
    .then(lifespanShutdown).expect(shutdownKeepsMembers == MARK_ON_SIGNAL)
}

module room_disconnect_cleanup_before {
  import room_disconnect_cleanup(DEFER_WHILE_SENDING = false, MARK_ON_SIGNAL = false).*
}

module room_disconnect_cleanup_lifespan_only {
  import room_disconnect_cleanup(DEFER_WHILE_SENDING = true, MARK_ON_SIGNAL = false).*
}

module room_disconnect_cleanup_fixed {
  import room_disconnect_cleanup(DEFER_WHILE_SENDING = true, MARK_ON_SIGNAL = true).*

  run oldSidAfterReclaimTest = init.then(sendRoster).then(transportCloses)
    .then(sendReturns).then(reclaim).then(finishCleanup).expect(s.member == "new")

  run shutdownDuringSendTest = init.then(sendRoster).then(transportCloses)
    .then(shutdownSignal).then(sendReturns).then(finishCleanup).expect(s.member == "old")

  run cleanupAfterSendTest = init.then(sendRoster).then(transportCloses)
    .then(sendReturns).then(finishCleanup).expect(s.member == "removed")
}
