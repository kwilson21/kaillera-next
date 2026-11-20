// -*- mode: Bluespec; -*-
//
// The host's escalation push for one lost input, as a transfer that takes
// time: _escalateLostInput, _checkOverduePushes and the state transfer
// (pushSyncState, sendSyncChunks, _sendSyncChunksTo) in
// web/static/netplay-rollback.js.
//
// specs/ask_escalation.qnt (push_deadline) makes a push instantaneous: it is
// sent when it is armed, nothing else is being sent, and the host's clock
// runs evenly. None of the three holds, and each hid a defect:
//
// - A push can be queued behind another transfer on the guest's channel (one
//   transfer at a time per guest, _syncSendChains). A transfer has no fixed
//   length: sendPaced fails it only when no chunk is accepted for
//   SYNC_SEND_STALL_MS (15 s); while chunks go out it runs as long as the link
//   takes. A push let go on a clock that ran from its start (5 s first, then a
//   60 s backstop) could be let go while still on its way, and a push let go
//   began its count again when the same hole was escalated: pushes were never
//   bounded and the give-up never came.
// - The outcome of a push to several guests was reported only once every
//   guest's transfer had ended (Promise.all), so one guest's slow link held
//   another's deadline: handed over, unreported, and let go meanwhile.
// - A transfer taken before the escalation (an earlier frame) can be handed
//   over after it. Any hand-over to that guest started the push's deadline,
//   so time owed to the earlier transfer counted against this push.
// - The host's page can freeze. The deadline's clock ran through the freeze,
//   and a host that came back pushed again or dropped a guest whose answer it
//   had not yet handled.
//
// - (Third round) the no-progress clock was global: any guest's sync reset
//   it, so a push whose own transfer went silent (its report lost) waited
//   for ever while others synced; and only a chunk counted as progress, so
//   two transfers ahead of the push, each stalling to its own limit, outlasted
//   it and the push was let go while still waiting its turn.
//
// COUNT_SURVIVES: a push let go keeps its count for the same hole (a let-go
//   counts toward the hole's limit, never toward a drop); past
//   MAX_PUSHES the hole is left to the stall path (its 5 s deadline, the
//   phantom and PEER-RECOVERED's resync). Holes taking turns: hole_counts below.
// OUTCOME_REPORTED: a push whose own transfer fails is let go at once.
// LET_GO: when a push not handed over is let go besides its own failure:
//   "timer"    W after it was armed (before #286's second round);
//   "backstop" B after it was armed (the second round);
//   "progress" no progress for N, longer than the transfer's own stall limit
//              S, so a live transfer always fails by itself first (I1: N
//              covers a transfer that never reports).
// CLOCK: what "progress" is for LET_GO "progress":
//   "global"   a chunk accepted for any guest, or any state captured (the
//              third round);
//   "chain"    a transfer started, ended or had a chunk accepted on the push's
//              own guest's chain: the queue the push waits in, and its own
//              transfer.
// PER_TARGET: each guest's outcome is reported as its own chain ends.
// MARK_BY_FRAME: only the push's own state starts its deadline.
// CREDIT_FREEZE: a freeze of the host's page is credited to the push's clocks.
//
// Time is discrete. A page that runs handles what is due before more time
// passes (its tick, its message handlers); a frozen page handles nothing and
// sends nothing.
// What is modelled: one hole; the push and its pushes again; the transfer
// ahead of it on the guest's chain; another guest's transfer of the same
// broadcast; the guest's acknowledgement; the host's freezes. Not modelled:
// the reconnect and the phantom that end a push (specs/ask_escalation.qnt
// push_deadline; the two equal 5 s deadlines are stated there), other guests'
// states (escalation_peers, sync_base below), the stall path's own recovery
// (specs/tick_deadlines.qnt).

module escalation_push {
  const COUNT_SURVIVES: bool
  const OUTCOME_REPORTED: bool
  const LET_GO: str
  const CLOCK: str
  const PER_TARGET: bool
  const MARK_BY_FRAME: bool
  const CREDIT_FREEZE: bool

  pure val MAX_PUSHES = 2
  pure val T = 2    // the push's deadline (OVERDUE_PUSH_TIMEOUT_MS)
  pure val S = 2    // a transfer fails when no chunk is accepted for this long (SYNC_SEND_STALL_MS)
  pure val W = 1    // the first round's not-sent window
  pure val B = 4    // the second round's backstop from the push's start
  pure val N = 3    // the third round's no-progress limit: longer than S
  pure val CAP = 6

  type Host = {
    phase: str,          // idle | queued | sending | lost | failed | unreported | out | letGo | exhausted | settled | dropped
    ahead: int,          // transfers to this guest ahead of the push on its chain
    otherChain: bool,    // another guest's transfer of this broadcast still runs
    chainStall: int,     // the page's no-progress clock (CLOCK)
    ownQuiet: int,       // since the push's own guest's chain last moved (the truth)
    pushes: int,         // pushes counted for this hole
    issued: int,         // history: pushes issued for this hole
    started: bool,       // the deadline runs (push.at set)
    age: int,            // the deadline's clock
    armedAge: int,       // since the push was started
    delivered: bool,     // the current push was handed over
    everDelivered: bool,
    liveAge: int,        // time this page could have heard an answer since the hand-over
    frozen: bool,
    ackPending: bool,
    ackInTime: bool,
    acked: bool,
    letGoOnItsWay: bool,       // history
    earlyRetry: bool,          // history
    droppedUndelivered: bool,  // history
  }

  var h: Host

  pure def up(x: int): int = if (x >= CAP) CAP else x + 1
  pure val WAITING = Set("queued", "sending", "lost", "failed", "unreported")
  pure val ON_ITS_WAY = Set("queued", "sending", "unreported")
  pure val RUNNING = Set("queued", "sending", "lost", "failed", "unreported", "out")

  def chainActive: bool = h.ahead > 0 or h.phase == "sending"
  def letGoDue: bool =
    not(h.started) and WAITING.contains(h.phase) and (
      if (LET_GO == "timer") h.armedAge >= W
      else if (LET_GO == "backstop") h.armedAge >= B
      else h.chainStall >= N
    )

  pure val start: Host = {
    phase: "idle", ahead: 0, otherChain: false, chainStall: 0, ownQuiet: 0, pushes: 0, issued: 0,
    started: false, age: 0, armedAge: 0, delivered: false, everDelivered: false, liveAge: 0,
    frozen: false, ackPending: false, ackInTime: false, acked: false,
    letGoOnItsWay: false, earlyRetry: false, droppedUndelivered: false,
  }

  action init = {
    nondet e = 0.to(2).oneOf()
    h' = { ...start, ahead: e }
  }

  // A push for the hole goes onto the guest's chain, behind the transfer in
  // flight or straight out; a broadcast may have another guest's transfer.
  def push(x: Host, other: bool): Host = {
    ...x,
    phase: if (x.ahead > 0) "queued" else "sending",
    otherChain: other,
    // Straight out, its transfer starting moves its chain.
    chainStall: if (x.ahead > 0) x.chainStall else 0,
    ownQuiet: if (x.ahead > 0) x.ownQuiet else 0,
    issued: x.issued + 1, started: false, age: 0, armedAge: 0,
    delivered: false, liveAge: 0,
  }

  action escalate = all {
    not(h.frozen), Set("idle", "letGo").contains(h.phase), h.issued < CAP,
    if (COUNT_SURVIVES and h.pushes >= MAX_PUSHES)
      h' = { ...h, phase: "exhausted" }
    else {
      nondet other = Set(false, true).oneOf()
      h' = push({ ...h, pushes: if (COUNT_SURVIVES) h.pushes + 1 else 1 }, other)
    },
  }

  // A chunk is accepted on the guest's chain.
  action progress = all {
    not(h.frozen), chainActive,
    h' = { ...h, chainStall: 0, ownQuiet: 0 },
  }

  // Another guest's sync moves: progress only to a global clock.
  action otherProgress = all {
    not(h.frozen), CLOCK == "global",
    h' = { ...h, chainStall: 0 },
  }

  // The push's own transfer goes silent and never reports (a run that
  // rejects unreported, a report lost): nothing moves on its chain again.
  action loseReport = all {
    not(h.frozen), h.phase == "sending",
    h' = { ...h, phase: "lost" },
  }

  // The transfer ahead of the push ends: handed over at any time, failed when
  // it made no progress for S. Before the fix a hand-over to the guest started
  // the push's deadline.
  action earlierEndsAs(ok: bool): bool = all {
    not(h.frozen), h.ahead > 0,
    all {
      ok or h.ownQuiet >= S,
      val marks = ok and not(MARK_BY_FRAME) and not(h.started) and WAITING.contains(h.phase)
      val turn = h.ahead == 1 and h.phase == "queued"
      h' = {
        ...h,
        ahead: h.ahead - 1,
        // A transfer that ended, and the next one starting, move the chain;
        // a global clock counts only the chunk a hand-over ended on.
        chainStall: if (ok or CLOCK == "chain") 0 else h.chainStall,
        ownQuiet: 0,
        phase: if (turn) "sending" else h.phase,
        started: h.started or marks,
        age: if (marks) 0 else h.age,
      },
    },
  }
  action earlierEnds = { nondet ok = Set(false, true).oneOf() earlierEndsAs(ok) }

  // The push's own transfer ends: handed over (reported now, or once every
  // guest's transfer has ended), or failed for want of progress.
  action sendDone = all {
    not(h.frozen), h.phase == "sending",
    val handed = { ...h, delivered: true, everDelivered: true, liveAge: 0, chainStall: 0, ownQuiet: 0 }
    h' = if (PER_TARGET or not(h.otherChain))
      { ...handed, phase: "out", started: true, age: if (h.started) h.age else 0 }
    else
      { ...handed, phase: "unreported" },
  }
  action sendFails = all {
    not(h.frozen), h.phase == "sending", h.ownQuiet >= S,
    h' = {
      ...h,
      phase: if (OUTCOME_REPORTED) "letGo" else "failed",
      chainStall: if (CLOCK == "chain") 0 else h.chainStall,
      ownQuiet: 0,
    },
  }

  // The other guest's transfer ends (it may run as long as its link takes).
  action otherDone = all {
    not(h.frozen), h.otherChain,
    h' = {
      ...h,
      otherChain: false,
      phase: if (h.phase == "unreported") "out" else h.phase,
      started: h.started or h.phase == "unreported",
      age: if (h.phase == "unreported" and not(h.started)) 0 else h.age,
    },
  }

  action guestAcks = all {
    h.everDelivered, not(h.ackPending), not(h.acked),
    h' = { ...h, ackPending: true, ackInTime: h.liveAge < T },
  }
  action handleAck = all {
    not(h.frozen), h.ackPending,
    h' = { ...h, ackPending: false, acked: true },
  }

  // The deadline (pushDeadlineStep): settled, push again (to this guest
  // alone), or give up.
  action check = all {
    not(h.frozen), h.started, RUNNING.contains(h.phase),
    if (h.acked)
      h' = { ...h, phase: "settled" }
    else all {
      h.age >= T,
      val early = not(h.delivered) or h.liveAge < T or (h.ackPending and h.ackInTime)
      if (h.pushes < MAX_PUSHES)
        h' = push({
          ...h,
          pushes: h.pushes + 1,
          ahead: if (h.phase == "sending") h.ahead + 1 else h.ahead,
          earlyRetry: h.earlyRetry or early,
        }, false)
      else
        h' = {
          ...h,
          phase: "dropped",
          earlyRetry: h.earlyRetry or early,
          droppedUndelivered: h.droppedUndelivered or not(h.everDelivered),
        },
    },
  }

  // Not handed over (or not reported), by the rule in LET_GO: let go, not
  // counted against the guest.
  action letGoTimer = all {
    not(h.frozen), letGoDue,
    h' = {
      ...h,
      phase: "letGo",
      ahead: if (h.phase == "sending") h.ahead + 1 else h.ahead,
      letGoOnItsWay: h.letGoOnItsWay or ON_ITS_WAY.contains(h.phase),
    },
  }

  action freeze = all { not(h.frozen), h' = { ...h, frozen: true } }
  action unfreeze = all { h.frozen, h' = { ...h, frozen: false } }

  // Time passes. Credited, a freeze does not run the push's clocks; a frozen
  // page sends nothing, so no chunk is accepted meanwhile either.
  action elapse = all {
    h.frozen or and {
      not(h.ackPending),
      not(h.started and RUNNING.contains(h.phase) and (h.acked or h.age >= T)),
      not(chainActive and h.ownQuiet >= S),
      not(letGoDue),
    },
    val counts = not(h.frozen) or not(CREDIT_FREEZE)
    h' = {
      ...h,
      age: if (h.started and counts) up(h.age) else h.age,
      armedAge: if (WAITING.contains(h.phase) and counts) up(h.armedAge) else h.armedAge,
      chainStall: if (counts) up(h.chainStall) else h.chainStall,
      ownQuiet: if (counts) up(h.ownQuiet) else h.ownQuiet,
      liveAge: if (h.delivered and not(h.frozen)) up(h.liveAge) else h.liveAge,
    },
  }

  action stutter = all { h' = h }

  action step = any {
    escalate, progress, otherProgress, loseReport, earlierEnds, sendDone, sendFails, otherDone, guestAcks, handleAck, check,
    letGoTimer, freeze, unfreeze, elapse, stutter
  }

  // ── Properties ───────────────────────────────────────────────────────────

  val pushesAreBoundedPerHole = h.issued <= MAX_PUSHES
  // Never let go while its transfer (or the report of it) is still on its
  // way: only its own failure ends it before the hand-over.
  val noLetGoOfAPushOnItsWay = not(h.letGoOnItsWay)
  val noRetryBeforeTheGuestCouldAnswer = not(h.earlyRetry)
  val noDropWithoutADeliveredPush = not(h.droppedUndelivered)
  // A push whose own guest's chain has not moved for N is let go (I1): a
  // silent transfer does not hold the push, and other guests' syncs do not
  // keep it alive.
  val aLostPushIsLetGo = not(WAITING.contains(h.phase) and h.ownQuiet > N)
  val allHold = and {
    pushesAreBoundedPerHole, noLetGoOfAPushOnItsWay, noRetryBeforeTheGuestCouldAnswer, noDropWithoutADeliveredPush,
    aLostPushIsLetGo
  }

  // ── Scenarios ────────────────────────────────────────────────────────────

  action from(x: Host): bool = h' = x

  // The push queued behind a transfer in flight.
  run queuedBehindTest =
    from({ ...start, ahead: 1 }).then(escalate).then(elapse)
      .expect(h.phase == "queued")
      .then(if (LET_GO == "timer") letGoTimer else earlierEnds)
      .expect(noLetGoOfAPushOnItsWay == (LET_GO != "timer"))

  // A transfer that keeps making progress past the backstop.
  run progressingTest =
    if (LET_GO == "timer") from(start) else
    from({ ...start, phase: "sending", pushes: 1, issued: 1 })
      .then(elapse).then(progress).then(elapse).then(progress).then(elapse).then(progress).then(elapse)
      .expect(h.armedAge == 4 and h.chainStall == 1)
      .then(if (LET_GO == "backstop") letGoTimer else sendDone)
      .expect(noLetGoOfAPushOnItsWay == (LET_GO != "backstop"))

  // Handed over while another guest's transfer of the broadcast goes on.
  run slowOtherGuestTest =
    from({ ...start, phase: "sending", otherChain: true, pushes: 1, issued: 1 })
      .then(sendDone)
      .expect(h.started == PER_TARGET)

  // The transfer ahead of the push is handed over after it was armed.
  run earlierMarksTest =
    from({ ...start, ahead: 1 }).then(escalate).then(earlierEnds)
      .expect(h.started == not(MARK_BY_FRAME))

  // Handed over, then the host freezes past the deadline while the guest
  // answers.
  run freezeTest =
    from({ ...start, phase: "out", pushes: 1, issued: 1, started: true, delivered: true, everDelivered: true })
      .then(freeze).then(elapse).then(elapse).then(guestAcks).then(unfreeze)
      .expect((h.age >= T) == not(CREDIT_FREEZE))
      .then(if (CREDIT_FREEZE) handleAck else check)
      .expect(noRetryBeforeTheGuestCouldAnswer == CREDIT_FREEZE)

  // Two transfers ahead of the push, each stalling to its own limit.
  run twoAheadTest =
    if (LET_GO != "progress") from(start) else
    from({ ...start, ahead: 2 }).then(escalate).then(elapse).then(elapse)
      .then(earlierEndsAs(false))
      .then(if (CLOCK == "chain") elapse.then(elapse).then(earlierEndsAs(false)) else elapse.then(letGoTimer))
      .expect(noLetGoOfAPushOnItsWay == (CLOCK == "chain"))

  // The push's transfer goes silent while another guest keeps syncing.
  run lostReportTest =
    if (LET_GO != "progress") from(start) else
    from({ ...start, phase: "sending", pushes: 1, issued: 1 }).then(loseReport)
      .then(elapse).then(elapse)
      .then(if (CLOCK == "global") otherProgress.then(elapse).then(elapse) else elapse.then(letGoTimer))
      .expect(aLostPushIsLetGo == (CLOCK == "chain"))

  // Two failed transfers for the same hole.
  run failTwiceTest =
    from({ ...start, phase: "letGo", pushes: 1, issued: 1 }).then(escalate)
      .expect(h.issued == 2)
      .then(all { h' = { ...h, phase: "letGo" } })
      .then(escalate)
      .expect(pushesAreBoundedPerHole == COUNT_SURVIVES)
}

// Before #286's second round.
module escalation_push_current {
  import escalation_push(COUNT_SURVIVES = false, OUTCOME_REPORTED = false, LET_GO = "timer", CLOCK = "chain", PER_TARGET = false,
    MARK_BY_FRAME = false, CREDIT_FREEZE = false).*
}
// The third round (68b3b87): a global no-progress clock that counts chunks
// only.
module escalation_push_round_three {
  import escalation_push(COUNT_SURVIVES = true, OUTCOME_REPORTED = true, LET_GO = "progress", CLOCK = "global",
    PER_TARGET = true, MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}

// The second round (1169568): a 60 s backstop from the push's start, and a
// broadcast reported once every guest's transfer has ended.
module escalation_push_round_two {
  import escalation_push(COUNT_SURVIVES = true, OUTCOME_REPORTED = true, LET_GO = "backstop", CLOCK = "chain", PER_TARGET = false,
    MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}

// Each fix alone left out: the property it is for is violated.
module escalation_push_count_resets {
  import escalation_push(COUNT_SURVIVES = false, OUTCOME_REPORTED = true, LET_GO = "progress", CLOCK = "chain", PER_TARGET = true,
    MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}
module escalation_push_timer_let_go {
  import escalation_push(COUNT_SURVIVES = true, OUTCOME_REPORTED = true, LET_GO = "timer", CLOCK = "chain", PER_TARGET = true,
    MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}
module escalation_push_backstop {
  import escalation_push(COUNT_SURVIVES = true, OUTCOME_REPORTED = true, LET_GO = "backstop", CLOCK = "chain", PER_TARGET = true,
    MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}
module escalation_push_reported_together {
  import escalation_push(COUNT_SURVIVES = true, OUTCOME_REPORTED = true, LET_GO = "progress", CLOCK = "chain", PER_TARGET = false,
    MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}
module escalation_push_any_hand_over {
  import escalation_push(COUNT_SURVIVES = true, OUTCOME_REPORTED = true, LET_GO = "progress", CLOCK = "chain", PER_TARGET = true,
    MARK_BY_FRAME = false, CREDIT_FREEZE = true).*
}
module escalation_push_no_credit {
  import escalation_push(COUNT_SURVIVES = true, OUTCOME_REPORTED = true, LET_GO = "progress", CLOCK = "chain", PER_TARGET = true,
    MARK_BY_FRAME = true, CREDIT_FREEZE = false).*
}

// The fix.
module escalation_push_fixed {
  import escalation_push(COUNT_SURVIVES = true, OUTCOME_REPORTED = true, LET_GO = "progress", CLOCK = "chain", PER_TARGET = true,
    MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}

// ── The host's delta base and a targeted state ─────────────────────────────
//
// The host kept one delta base (_lastSyncState) for every guest: a state it
// sent as a delta was the XOR against it, and a guest applied the delta onto
// its own base. That holds only while every guest holds the host's base. Any
// state sent to one guest moves the host's base and leaves the others on the
// old one: an escalation push to one guest, and equally the answer to one
// guest's request. The next delta to another guest was applied, without a
// word, onto a base it never got: the pages load different emulator memory.
// Today every request a page sends is full and clears the base first, so this
// needs an older page's `sync-request`.
//
// HOST_DELTAS:
//   "any"         a delta whenever the host has a base (before);
//   "escClears"   an escalation push is full and clears the base, but the
//                 answer to one guest's request still moves it: not enough
//                 (otherGuestAsksAfterAnAnswerTest);
//   "none"        the host never sends a delta: every state is full, and no
//                 guest's base matters.

module sync_base {
  const HOST_DELTAS: str

  // States are numbered; 0 is "none".
  var hostBase: int
  var guestBase: int -> int     // guest (1, 2) -> its base
  var fresh: int
  var corrupt: bool             // history: a delta applied onto a base its guest never got

  pure val GUESTS = Set(1, 2)
  pure val MAX_STATE = 4

  action init = all {
    hostBase' = 0, guestBase' = GUESTS.mapBy(_ => 0), fresh' = 1, corrupt' = false,
  }

  // A coordinated sync to every guest.
  action coordinated = all {
    fresh <= MAX_STATE,
    hostBase' = fresh, guestBase' = GUESTS.mapBy(_ => fresh), fresh' = fresh + 1, corrupt' = corrupt,
  }

  // An escalation push to one guest, full.
  action targetedPushTo(g: int): bool = all {
    fresh <= MAX_STATE,
    guestBase' = guestBase.set(g, fresh),
    hostBase' = if (HOST_DELTAS == "any") fresh else 0,
    fresh' = fresh + 1, corrupt' = corrupt,
  }

  // One guest asks for a state and is answered alone: a delta when the host
  // sends deltas and has a base.
  action answerTo(g: int): bool = all {
    fresh <= MAX_STATE,
    corrupt' = (corrupt or (HOST_DELTAS != "none" and hostBase != 0 and guestBase.get(g) != hostBase)),
    guestBase' = guestBase.set(g, fresh),
    hostBase' = if (HOST_DELTAS == "none") 0 else fresh,
    fresh' = fresh + 1,
  }

  action targetedPush = { nondet g = GUESTS.oneOf() targetedPushTo(g) }
  action request = { nondet g = GUESTS.oneOf() answerTo(g) }
  action stutter = all { hostBase' = hostBase, guestBase' = guestBase, fresh' = fresh, corrupt' = corrupt }
  action step = any { coordinated, targetedPush, request, stutter }

  val noDeltaOnAForeignBase = not(corrupt)

  // Two guests, a targeted push to one, then the other's request.
  run otherGuestAsksTest =
    init.then(coordinated).then(targetedPushTo(1)).then(answerTo(2))
      .expect(noDeltaOnAForeignBase == (HOST_DELTAS != "any"))

  // Two guests, one answered alone, then the other's request.
  run otherGuestAsksAfterAnAnswerTest =
    init.then(coordinated).then(answerTo(1)).then(answerTo(2))
      .expect(noDeltaOnAForeignBase == (HOST_DELTAS == "none"))
}

module sync_base_current {
  import sync_base(HOST_DELTAS = "any").*
}
module sync_base_esc_clears {
  import sync_base(HOST_DELTAS = "escClears").*
}
module sync_base_fixed {
  import sync_base(HOST_DELTAS = "none").*
}

// ── Pushes counted per hole ─────────────────────────────────────────────────
//
// One record per slot held the count of the last hole pushed: two holes
// escalated in turn (each push let go) each found the other's record, began
// again at 1, and were pushed for ever; a hole whose pushes ran out was
// overwritten by the next and pushed again.
//
// PER_HOLE: the count is kept per hole (a per-slot map by the hole's frame),
//   cleared with the peer (I2) and when it recovers.

module hole_counts {
  const PER_HOLE: bool

  pure val HOLES = Set(1, 2)
  pure val MAX_PUSHES = 2
  pure val CAP = 6

  var counted: int -> int       // the count the page has for each hole
  var lastHole: int             // the one record's hole (single record), 0 none
  var issued: int -> int        // history: pushes issued per hole

  action init = all {
    counted' = HOLES.mapBy(_ => 0), lastHole' = 0, issued' = HOLES.mapBy(_ => 0),
  }

  // A hole's ask goes overdue; its push is let go (never handed over).
  action escalateHole(hole: int): bool = {
    val have = if (PER_HOLE) counted.get(hole) else if (lastHole == hole) counted.get(hole) else 0
    all {
      issued.get(hole) < CAP,
      have < MAX_PUSHES,
      counted' = if (PER_HOLE) counted.set(hole, have + 1)
                 else HOLES.mapBy(x => if (x == hole) have + 1 else 0),
      lastHole' = hole,
      issued' = issued.set(hole, issued.get(hole) + 1),
    }
  }

  action escalateAndLetGo = { nondet hole = HOLES.oneOf() escalateHole(hole) }
  action stutter = all { counted' = counted, lastHole' = lastHole, issued' = issued }
  action step = any { escalateAndLetGo, stutter }

  val pushesAreBoundedForEveryHole = HOLES.forall(x => issued.get(x) <= MAX_PUSHES)

  // Two holes in turn.
  run alternatingHolesTest =
    init.then(escalateHole(1)).then(escalateHole(2)).then(escalateHole(1)).then(escalateHole(2))
      .expect(pushesAreBoundedForEveryHole)
      .then(if (PER_HOLE) stutter else escalateHole(1))
      .expect(pushesAreBoundedForEveryHole == PER_HOLE)
}

module hole_counts_one_record {
  import hole_counts(PER_HOLE = false).*
}
module hole_counts_fixed {
  import hole_counts(PER_HOLE = true).*
}
