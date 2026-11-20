// A guest that restored the running host's timeline, then checked the
// original inputs through the bounded handoff, did not independently boot.
// An ordinary timed legacy boot correction can rewind that guest onto a
// speculative host state. This gate does not change real recovery requests.
module late_join_boot_continuation {
  const FIXED: bool

  type Run = {
    fromHost: bool,
    remaining: int,
    obsolete: bool,
    knSyncStartup: bool,
    deadlineFired: bool,
    verifiedAtBoot: bool,
    bootAsked: bool,
    explicitAsked: bool,
    speculativeApplied: bool,
  }
  var session: Run

  action initial(fromHost: bool, knSyncStartup: bool): bool =
    session' = {
      fromHost: fromHost, remaining: 2, obsolete: false,
      knSyncStartup: knSyncStartup, deadlineFired: false, verifiedAtBoot: false,
      bootAsked: false, explicitAsked: false, speculativeApplied: false,
    }

  action init = any { initial(true, false), initial(false, false), initial(false, true) }
  action freshLegacy = initial(false, false)
  action freshKnSync = initial(false, true)
  action validatedHandoff = initial(true, false)

  action consumeReal = all {
    session.remaining > 0,
    session' = session.with("remaining", session.remaining - 1),
  }
  action miss = session' = session
  action invalidate = session' = session.with("obsolete", true)
  action boot = all {
    not(session.deadlineFired),
    session' = session.with("deadlineFired", true)
      .with("verifiedAtBoot", session.fromHost and session.remaining == 0 and not(session.obsolete)).with(
      "bootAsked",
      not(session.knSyncStartup or (FIXED and session.fromHost and session.remaining == 0 and not(session.obsolete)))
    ),
  }
  action explicitRecovery = session' = session.with("explicitAsked", true)
  action speculativeBootAnswer = all {
    session.bootAsked,
    session' = session.with("speculativeApplied", true),
  }
  action step = any { consumeReal, miss, invalidate, boot, explicitRecovery, speculativeBootAnswer }

  // Today's code violates this: fully caught-up late join sends a generic
  // boot request despite never having independently booted that timeline.
  val noGenericBootAfterValidatedHandoff =
    not(session.verifiedAtBoot) or
    not(session.bootAsked and session.deadlineFired)
  // Only evaluate at the gate: the boot action is one shot, not withdrawn
  // retroactively if validation happens after the deadline.
  run legacySpeculativeRewindTest = validatedHandoff.then(consumeReal).then(consumeReal).then(boot)
    .expect(session.bootAsked == not(FIXED))
  run oldBootCanApplySpeculationTest = validatedHandoff.then(consumeReal).then(consumeReal).then(boot)
    .then(if (FIXED) miss else speculativeBootAnswer).expect(session.speculativeApplied == not(FIXED))
  run lateCompletionDoesNotChangePriorBootTest = validatedHandoff.then(consumeReal).then(boot)
    .then(consumeReal).expect(session.bootAsked)
  run staleGenerationKeepsSafetyTest = validatedHandoff.then(consumeReal).then(consumeReal).then(invalidate)
    .then(boot).expect(session.bootAsked)
  run independentLegacyStartKeepsSafetyTest = freshLegacy.then(boot).expect(session.bootAsked)
  run independentKnSyncStartStillSkipsTest = freshKnSync.then(boot).expect(not(session.bootAsked))
  run explicitRecoveryUnchangedTest = validatedHandoff.then(consumeReal).then(consumeReal)
    .then(boot).then(explicitRecovery).expect(session.explicitAsked)
}
module late_join_boot_continuation_before {
  import late_join_boot_continuation(FIXED=false).*
}
module late_join_boot_continuation_fixed {
  import late_join_boot_continuation(FIXED=true).*
}
