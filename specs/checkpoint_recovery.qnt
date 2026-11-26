module checkpoint_recovery {
  // Three players and two input tags stand for a frozen roster and replay interval.
  pure val players = Set(0, 1, 2)
  pure val required = Set((0, 0), (0, 1), (1, 0), (1, 1), (2, 0), (2, 1))
  var s: { phase: str, generation: int, anchored: bool, stopped: Set[int],
           journal: Set[(int, int)], installed: Set[int], released: Set[int] }

  action init = s' = { phase: "idle", generation: 1, anchored: false, stopped: Set(),
                        journal: Set(), installed: Set(), released: Set() }
  // The digest and receipt checks are modeled as predicates supplied by the adapter.
  action begin(allAgreed: bool, sameScope: bool): bool =
    s' = if (s.phase == "idle" and allAgreed and sameScope)
      s.with("anchored", true).with("phase", "freezing") else s

  action freezeAck(slot: int, gen: int): bool =
    s' = if (s.phase == "freezing" and gen == s.generation and players.contains(slot))
      s.with("stopped", s.stopped.union(Set(slot))) else s

  action supply(slot: int, tag: int, gen: int, authored: bool): bool =
    s' = if (s.phase == "freezing" and gen == s.generation and authored and required.contains((slot, tag)))
      s.with("journal", s.journal.union(Set((slot, tag)))) else s

  action replay =
    s' = if (s.phase == "freezing" and s.anchored and s.stopped == players and s.journal == required)
      s.with("phase", "installing") else s

  action installedAck(slot: int, gen: int, matchingDigest: bool, nativeAligned: bool): bool =
    s' = if (s.phase == "installing" and gen == s.generation and players.contains(slot) and
        matchingDigest and nativeAligned) s.with("installed", s.installed.union(Set(slot))) else s

  action commit =
    s' = if (s.phase == "installing" and s.installed == players) s.with("phase", "committed") else s
  action release(slot: int, gen: int): bool =
    s' = if (s.phase == "committed" and gen == s.generation and players.contains(slot))
      s.with("released", s.released.union(Set(slot))) else s

  // A pre-commit cancellation cannot resurrect either partially installed timeline.
  action abort =
    s' = if (s.phase == "freezing" or s.phase == "installing")
      s.with("generation", s.generation + 1).with("phase", "unresolved") else s

  val safe = all {
    s.phase != "installing" or (s.anchored and s.stopped == players and s.journal == required),
    s.phase != "committed" or (s.anchored and s.stopped == players and s.journal == required and s.installed == players),
    s.released == Set() or s.phase == "committed",
  }
  // Check every action interleaving from an installation that can overlap expiry.
  action startInstall = s' = { phase: "installing", generation: 1, anchored: true,
    stopped: players, journal: required, installed: Set(), released: Set() }
  action nearReplay = s' = { phase: "freezing", generation: 1, anchored: true,
    stopped: Set(0, 1), journal: required.exclude(Set((1, 1))), installed: Set(), released: Set() }
  action step = {
    nondet slot = players.oneOf()
    nondet gen = Set(0, 1, 2).oneOf()
    nondet ok = Bool.oneOf()
    nondet valid = Bool.oneOf()
    any {
      begin(ok, valid), freezeAck(slot, gen), supply(slot, 0, gen, ok), supply(slot, 1, gen, ok),
      replay, installedAck(slot, gen, ok, valid), commit, release(slot, gen), abort
    }
  }
  action frozen = init.then(begin(true, true)).then(freezeAck(0, 1)).then(freezeAck(1, 1)).then(freezeAck(2, 1))
  action almost = frozen.then(supply(0, 0, 1, true)).then(supply(0, 1, 1, true))
    .then(supply(1, 0, 1, true)).then(supply(2, 0, 1, true)).then(supply(2, 1, 1, true))
  action staged = almost.then(supply(1, 1, 1, true)).then(replay)
  action twoInstalled = staged.then(installedAck(0, 1, true, true)).then(installedAck(1, 1, true, true))
  run requiredCheckpointTest = init.then(begin(false, true)).then(begin(true, false)).expect(s.phase == "idle")
  run missingOwnerTest = almost.then(supply(1, 1, 1, false)).then(supply(1, 1, 0, true))
    .then(replay).expect(s.phase == "freezing" and safe)
  run missingFreezeTest = init.then(begin(true, true)).then(freezeAck(0, 1)).then(freezeAck(1, 1))
    .then(freezeAck(2, 0)).then(supply(0, 0, 1, true)).then(supply(0, 1, 1, true))
    .then(supply(1, 0, 1, true)).then(supply(1, 1, 1, true)).then(supply(2, 0, 1, true))
    .then(supply(2, 1, 1, true)).then(replay)
    .expect(s.journal == required and s.stopped == Set(0, 1) and s.phase == "freezing")
  run staleDigestAndApplyTest = twoInstalled.then(installedAck(2, 1, false, true))
    .then(installedAck(2, 1, true, false)).then(installedAck(2, 0, true, true))
    .then(commit).then(release(0, 1)).expect(s.phase == "installing" and s.released == Set() and safe)
  run duplicateAckTest = twoInstalled.then(installedAck(1, 1, true, true))
    .then(commit).expect(s.phase == "installing" and s.installed == Set(0, 1))
  run abortAfterPartialApplyTest = twoInstalled.then(abort).then(installedAck(2, 1, true, true))
    .then(commit).then(release(0, 2)).expect(s.phase == "unresolved" and s.released == Set() and safe)
  run commitAndReplayReleaseTest = twoInstalled.then(installedAck(2, 1, true, true)).then(commit)
    .then(release(0, 1)).then(release(0, 1)).then(abort).then(release(1, 1)).then(release(2, 1))
    .expect(s.released == players and safe)
}

// Only the checkpoint protocol observes its deadline. Live execution
// consults the held boundary before committing another frame.
module checkpoint_clock {
  const OWN_CLOCK: bool
  pure val TARGET = 2
  pure val DEADLINE = 3
  var frame: int
  var phase: str

  action init = all { frame' = 0, phase' = "approaching" }
  action wake(at: int, frameTick: bool, nativeSafe: bool): bool = {
    val service = OWN_CLOCK or frameTick
    val nextPhase = if (not(service) or phase != "approaching") phase
      else if (at >= DEADLINE) "unresolved"
      else if (frame == TARGET and nativeSafe) "frozen"
      else if (frame == TARGET) "unresolved"
      else phase
    all {
      phase' = nextPhase,
      frame' = if (frameTick and nextPhase == "approaching" and frame < TARGET) frame + 1 else frame,
    }
  }
  action step = {
    nondet at = Set(1, 2, 3).oneOf()
    nondet tick = Bool.oneOf()
    nondet safe = Bool.oneOf()
    wake(at, tick, safe)
  }
  val neverPassesFreeze = frame <= TARGET

  run stoppedFramePumpStillExpiresTest =
    init.then(wake(2, false, true)).then(wake(DEADLINE, false, true))
      .expect(frame == 0 and phase == (if (OWN_CLOCK) "unresolved" else "approaching"))

  run aDelayedWakeDoesNotOverrunTheBoundaryTest =
    init.then(wake(1, true, true)).then(wake(1, true, true))
      .expect(frame == TARGET and phase == "approaching")
      .then(wake(2, false, true))
      .expect(frame == TARGET and phase == (if (OWN_CLOCK) "frozen" else "approaching"))
}

module checkpoint_clock_before {
  import checkpoint_clock(OWN_CLOCK = false).*
}

module checkpoint_clock_fixed {
  import checkpoint_clock(OWN_CLOCK = true).*
}
