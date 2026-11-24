// Model the native-slot history and bounded first-input wait across repeated
// transport resets (resetPeerState and tick). A current pacing phantom can
// resume after one packet, but that packet does not reset the native ring.
// A listed slot can briefly have no peer object after non-host disconnect.
module kept_slot_recovery {
  const FIXED: bool
  pure val DEADLINE = 3
  pure val REASONS = Set("reconnect", "mesh-heal", "hard-disconnect-non-host")
  var s: {
    now: int, listed: bool, connected: bool, pacingPhantom: bool, dirtyRing: bool,
    waiting: bool, firstInput: bool, deadline: int, kept: bool,
    ranWithoutGuard: bool, keptDirty: bool
  }

  action init = s' = {
    now: 0, listed: true, connected: true, pacingPhantom: false, dirtyRing: false,
    waiting: false, firstInput: true, deadline: -1, kept: false,
    ranWithoutGuard: false, keptDirty: false
  }

  action phantom = s' = s.with("pacingPhantom", true).with("dirtyRing", true)
  // A valid live packet restores pacing. It does not replace the native ring.
  // This transition represents the native feed, after JS admits the packet.
  action feed = all {
    s.connected,
    s' = s.with("pacingPhantom", false).with("waiting", false)
      .with("firstInput", true).with("deadline", -1),
  }
  action attach = s' = s.with("connected", true)
  action wallClock = all { s.now <= DEADLINE + 2, s' = s.with("now", s.now + 1) }
  action nativeReset = s' = s.with("dirtyRing", false)
  action remove = s' = s.with("listed", false).with("waiting", false)
    .with("deadline", -1).with("dirtyRing", false).with("pacingPhantom", false).with("kept", false)
  action reset(reason: str): bool = {
    val keep = s.listed and REASONS.contains(reason) and not(s.pacingPhantom)
      and (not(FIXED) or not(s.dirtyRing))
    val wait = s.listed and (reason == "reconnect" or (FIXED and keep))
    val deadline = if (FIXED and keep and s.waiting) s.deadline else -1
    s' = s.with("kept", keep).with("waiting", wait).with("deadline", deadline)
      .with("dirtyRing", keep and s.dirtyRing).with("pacingPhantom", false)
      .with("connected", reason != "hard-disconnect-non-host").with("firstInput", false)
      .with("keptDirty", s.keptDirty or (keep and s.dirtyRing))
  }

  // The tick stalls before the deadline, even when the listed slot has no
  // current peer. Expiration follows existing phantom recovery semantics.
  val blocked = s.waiting and not(s.pacingPhantom) and (s.deadline < 0 or s.now < s.deadline)
    and (s.connected or FIXED)
  action touchWait = all {
    blocked and s.deadline < 0,
    s' = s.with("deadline", s.now + DEADLINE),
  }
  action advance = {
    val missesWait = s.kept and not(s.firstInput) and not(s.pacingPhantom)
      and (not(s.waiting) or s.deadline < 0 or s.now < s.deadline)
    all {
      not(blocked),
      s' = s.with("ranWithoutGuard", s.ranWithoutGuard or missesWait)
        .with("pacingPhantom", s.pacingPhantom or (s.waiting and s.deadline >= 0 and s.now >= s.deadline))
        .with("dirtyRing", s.dirtyRing or (s.waiting and s.deadline >= 0 and s.now >= s.deadline)),
    }
  }
  action step = any {
    nondet reason = REASONS.oneOf()
    reset(reason),
    phantom, feed, attach, wallClock, nativeReset, remove, touchWait, advance, { s' = s },
  }

  val keepsOnlyCleanNativeHistory = not(s.keptDirty)
  val waitsEvenWithoutPeerObject = not(s.ranWithoutGuard)
  val allHold = keepsOnlyCleanNativeHistory and waitsEvenWithoutPeerObject

  run meshHealAndAbsentPlayerWaitTest =
    init.then(reset("mesh-heal")).expect(if (FIXED) blocked else not(blocked))
      .then(reset("hard-disconnect-non-host"))
      .expect(not(s.connected) and (if (FIXED) blocked else not(blocked)))

  run peerlessDeadlineSurvivesAnotherResetTest =
    init.then(reset("hard-disconnect-non-host"))
      .then(if (FIXED) touchWait else all { s' = s })
      .then(wallClock).then(reset("mesh-heal"))
      .expect(s.connected and (if (FIXED) s.deadline == DEADLINE else not(s.waiting)))
      .then(wallClock).then(wallClock)
      .expect(not(blocked))
      .then(advance)
      .expect(if (FIXED) s.pacingPhantom and allHold else not(allHold))

  run pausedBeforeFirstWaitDoesNotUseItsDeadlineTest =
    init.then(reset("reconnect")).then(wallClock).then(wallClock)
      .expect(blocked and s.deadline < 0)
      .then(touchWait).expect(s.deadline == s.now + DEADLINE and blocked and allHold)

  run phantomRecoveryPacketDoesNotMakeCoreSafeTest =
    init.then(phantom).then(feed)
      .expect(s.dirtyRing and not(s.pacingPhantom))
      .then(reset("reconnect"))
      .expect(if (FIXED) not(s.kept) and allHold else s.kept and not(keepsOnlyCleanNativeHistory))

  run actualNativeResetAllowsPreservingAgainTest =
    init.then(phantom).then(feed).then(nativeReset).then(reset("reconnect"))
      .expect(s.kept and blocked and allHold)
      .then(feed)
      .expect(not(blocked) and allHold)
}

module kept_slot_recovery_before { import kept_slot_recovery(FIXED = false).* }
module kept_slot_recovery_fixed { import kept_slot_recovery(FIXED = true).* }
