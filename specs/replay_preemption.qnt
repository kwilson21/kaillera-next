// Native amortized replay (kn_pre_tick / kn_post_tick). The frontier is the
// next frame of live play. The cursor can move backwards again when a second
// correction predates the active replay's start. Saved-state contents and
// input admission are outside this model; restorable represents a ring hit
// and a successful backend restore.
module replay_preemption {
  const KEEP_FRONTIER: bool
  const KEEP_FAILED_REPLAY: bool

  var cursor: int
  var frontier: int
  var start: int        // -1 when not replaying
  var target: int

  action init = all { cursor' = 8, frontier' = 8, start' = -1, target' = 8 }

  action correction(at: int, restorable: bool): bool = {
    val base = if (KEEP_FRONTIER and start != -1) target else cursor
    val inWindow = base - at <= 7
    val accepts = restorable and inWindow
    all {
      0 <= at, at < cursor, start == -1 or at < start,
      frontier' = frontier,
      cursor' = if (accepts) at else cursor,
      start' = if (accepts) at else if (inWindow and not(KEEP_FAILED_REPLAY)) -1 else start,
      target' = if (accepts) base else target,
    }
  }

  action tick = all {
    cursor < 12,
    cursor' = cursor + 1,
    frontier' = if (start == -1) frontier + 1 else frontier,
    start' = if (cursor + 1 == target) -1 else start,
    target' = target,
  }

  action step = any {
    tick,
    nondet at = 0.to(11).oneOf()
    nondet restorable = Set(false, true).oneOf()
    correction(at, restorable),
  }

  val replayEndsAtFrontier = start == -1 or target == frontier
  val liveStartsAtFrontier = start != -1 or cursor == frontier
  val replayStaysInWindow = start == -1 or frontier - start <= 7
  val allHold = replayEndsAtFrontier and liveStartsAtFrontier and replayStaysInWindow

  run earlierInputDuringReplayTest = init.then(correction(5, true)).then(tick)
    .then(correction(3, true)).then(tick).then(tick).then(tick)
    .expect(liveStartsAtFrontier == KEEP_FRONTIER)
    .then(tick).then(tick)
    .expect((cursor == frontier and start == -1) == KEEP_FRONTIER)

  run pastWindowDuringReplayTest = init.then(correction(5, true)).then(tick)
    .then(correction(0, true))
    .expect((cursor == 6 and target == 8) == KEEP_FRONTIER)

  run failedPreemptionTest = init.then(correction(5, true)).then(tick)
    .then(correction(3, false))
    .expect(liveStartsAtFrontier == KEEP_FAILED_REPLAY)
}

module replay_preemption_before {
  import replay_preemption(KEEP_FRONTIER = false, KEEP_FAILED_REPLAY = false).*
}

module replay_preemption_fixed {
  import replay_preemption(KEEP_FRONTIER = true, KEEP_FAILED_REPLAY = true).*
}
