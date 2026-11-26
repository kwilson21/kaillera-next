// A guest-local obligation, not a whole-room settlement proof. The only
// completion is successful native apply of the exact numbered host answer
// in the current connection generation and match. Receipt is not apply.
module reconnect_answer_debt {
  type State = {
    id: int,
    gen: int,
    epoch: int,
    held: int,
    heldGen: int,
    heldEpoch: int,
    status: str,
    now: int,
    notices: int
  }
  var s: State

  pure val deadline = 3

  action init = s' = {
    id: 9, gen: 2, epoch: 1, held: -1, heldGen: 0,
    heldEpoch: 0, status: "waiting", now: 0, notices: 0
  }

  action receive(id: int, gen: int, epoch: int): bool = all {
    gen == s.gen and epoch == s.epoch,
    s.held != s.id or id == s.id,
    s' = s.with("held", id).with("heldGen", gen).with("heldEpoch", epoch),
  }

  action apply(aligned: bool): bool = all {
    s.held >= 0,
    s' = s.with("held", -1).with(
      "status",
      if (s.status == "waiting" and aligned and s.held == s.id and s.heldGen == s.gen
          and s.heldEpoch == s.epoch and s.now < deadline) "applied" else s.status
    ),
  }

  action time = {
    val nextNow = s.now + 1
    val expire = s.status == "waiting" and nextNow >= deadline
    all {
      s.now < deadline,
      s' = s.with("now", nextNow).with("status", if (expire) "unresolved" else s.status)
            .with("notices", if (expire) s.notices + 1 else s.notices),
    }
  }

  action rotate = all {
    s.gen == 2,
    s' = s.with("gen", 3).with("id", 10).with("held", -1),
  }

  action stutter = s' = s

  action step = any {
    receive(0, s.gen, s.epoch), receive(s.id, s.gen, s.epoch),
    apply(false), apply(true), time, rotate, stutter,
  }

  val aTerminalFailureCannotBeHidden = s.status != "unresolved" or s.notices == 1
  val deadlineDoesNotLeaveAPendingObligation = s.now < deadline or s.status != "waiting"
  val allHold = aTerminalFailureCannotBeHidden and deadlineDoesNotLeaveAPendingObligation

  run unrelatedStateDoesNotCompleteTest = init.then(receive(0, 2, 1)).then(apply(true))
    .expect(s.status == "waiting")

  run decodeAndFailedNativeApplyDoNotCompleteTest = init.then(receive(9, 2, 1))
    .expect(s.status == "waiting").then(apply(false)).expect(s.status == "waiting")

  run exactAlignedAnswerCompletesTest = init.then(receive(9, 2, 1)).then(apply(true))
    .expect(s.status == "applied")

  run newGenerationInvalidatesQueuedStateTest = init.then(receive(9, 2, 1)).then(rotate)
    .expect(s.status == "waiting" and s.held == -1 and s.id == 10)

  run deadlineIsVisibleAndFinalTest = init.then(time).then(time).then(time)
    .then(receive(9, 2, 1)).then(apply(true))
    .expect(s.status == "unresolved" and s.notices == 1)
}

// Deadline service observes elapsed time even when the browser is responsive
// and no emulator frames can run. These actions never install a snapshot.
module protected_reconnect_clock {
  const RECOVERY_CLOCK: bool
  var attempts: int
  var unresolved: bool

  action init = all { attempts' = 1, unresolved' = false }

  action service(at: int, frameTick: bool, proofBuffered: bool): bool = {
    val active = (RECOVERY_CLOCK or frameTick) and not(unresolved)
    all {
      attempts' = if (active and not(proofBuffered) and at < 4 and attempts < at + 1) attempts + 1 else attempts,
      unresolved' = (unresolved or (active and at >= 4)),
    }
  }

  run stoppedFramesRetryAndExpireTest =
    init.then(service(1, false, false)).then(service(2, false, false))
      .then(service(4, false, false))
      .expect(unresolved == RECOVERY_CLOCK and attempts == (if (RECOVERY_CLOCK) 3 else 1))

  run bufferedProofDoesNotRetryButStillExpiresTest =
    init.then(service(1, true, true)).then(service(4, true, true))
      .expect(unresolved and attempts == 1)
}

module protected_reconnect_clock_before {
  import protected_reconnect_clock(RECOVERY_CLOCK = false).*
}

module protected_reconnect_clock_fixed {
  import protected_reconnect_clock(RECOVERY_CLOCK = true).*
}
