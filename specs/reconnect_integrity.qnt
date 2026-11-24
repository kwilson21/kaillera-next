// An unrecoverable input belongs to the match, not the current slot transport.
module reconnect_integrity {
  type State = { phase: str, oldMatch: bool, slot: bool, proven: bool, unsafe: bool, owner: bool }
  var s: State
  action init = s' = {
    phase: "checking", oldMatch: true, slot: true, proven: false, unsafe: false, owner: false
  }
  action proofBeforeHandoff = all {
    s.phase == "checking",
    s' = s.with("proven", true)
  }
  action unverifiedFailure = all {
    s.phase == "checking",
    s' = s.with("phase", if (s.proven) "delivery-unresolved" else "unverified").with("unsafe", not(s.proven))
  }
  action remove = all {
    s.slot,
    s' = s.with("slot", false).with(
      "phase", if (s.phase == "checking" and not(s.proven)) "unverified" else s.phase
    ).with("unsafe", s.unsafe or (s.phase == "checking" and not(s.proven)))
  }
  action reuse = all { not(s.slot), s' = s.with("slot", true) }
  action explicitEnd = all {
    s.phase == "unverified",
    s' = s.with("phase", "end-pending").with("owner", true)
  }
  action timeoutOrCancel = all { s.phase == "end-pending", s' = s.with("phase", "unverified").with("owner", false) }
  action matchedEnd = all { s.phase == "end-pending" and s.owner, s' = s.with("phase", "lobby") }
  action newStart = all {
    s.phase == "lobby",
    s' = s.with("oldMatch", false).with("phase", "new-match").with("unsafe", false)
  }
  action stutter = s' = s
  action step = any { proofBeforeHandoff, unverifiedFailure, remove, reuse, explicitEnd, timeoutOrCancel, matchedEnd, newStart, stutter }

  val captureAllowed = not(s.unsafe) and s.phase != "lobby" and (s.phase != "checking" or s.proven)
  val unsafeMatchNeverCaptures = not(s.unsafe and captureAllowed)
  val oldUnverifiedMatchIsNotHealthy = not(s.oldMatch and s.unsafe and s.phase == "new-match")

  run expiredThenReusedIsStillUnsafeTest = init.then(unverifiedFailure).then(remove).then(reuse)
    .expect(s.unsafe and not(captureAllowed))
  run leavingBeforeProofLatchesTest = init.then(remove).then(reuse)
    .expect(s.unsafe and not(captureAllowed))
  run deliveryFailureAfterLocalProofLeavesOtherCapturesSafeTest = init.then(proofBeforeHandoff).then(unverifiedFailure).then(remove)
    .expect(s.phase == "delivery-unresolved" and captureAllowed)
  run cancelDoesNotEndOrResumeTest = init.then(unverifiedFailure).then(explicitEnd).then(timeoutOrCancel)
    .expect(s.phase == "unverified" and not(captureAllowed))
  run exactOwnerEndThenExplicitNewMatchClearsScopeTest = init.then(unverifiedFailure).then(explicitEnd).then(matchedEnd).then(newStart)
    .expect(captureAllowed and not(s.oldMatch))
}
