// -*- mode: Bluespec; -*-
//
// The host's escalation push for one lost input, as a transfer that takes
// time: _escalateLostInput, _checkOverduePushes and the state transfer
// (pushSyncState, _sendSyncChunksTo) in web/static/netplay-rollback.js.
//
// specs/ask_escalation.qnt (push_deadline) makes a push instantaneous: it is
// sent when it is armed, nothing else is being sent, and the host's clock
// runs evenly. None of the three holds, and each hid a defect:
//
// - A push can be queued behind another transfer on the guest's channel (one
//   transfer at a time per guest, _syncSendChains; each chunk may wait up to
//   SYNC_SEND_STALL_MS = 15 s for room). The push was let go as "not sent" 5 s
//   after it was armed, still on its way, and the count began again at 1 when
//   the stall path escalated the same hole: pushes were never bounded and the
//   give-up never came.
// - A transfer taken before the escalation (an earlier frame) can be handed
//   over after it. Any hand-over to that guest started the push's deadline,
//   so time owed to the earlier transfer counted against this push.
// - The host's page can freeze (a long task, the tab not painting while it is
//   shown). The deadline's clock ran through the freeze, and a host that came
//   back from 6 s pushed again or dropped a guest whose answer it had not yet
//   handled. The peer-stale and resync-request clocks are credited for a
//   freeze (_creditLocalFreeze); the push's were not.
//
// COUNT_SURVIVES: a push let go keeps its count for the same hole; a further
//   escalation of that hole pushes again only below MAX_PUSHES, and beyond it
//   leaves the input to the stall path (its 5 s deadline, the phantom and
//   PEER-RECOVERED's resync) rather than pushing for ever.
// LET_GO_ON_OUTCOME: a push is let go when its own transfer ends without
//   handing the state over, not on a timer that a queued transfer outlasts;
//   a backstop B, longer than a transfer queued behind another, remains for
//   a transfer that never reports (I1).
// MARK_BY_FRAME: only a state taken at or after the push's first frame starts
//   its deadline.
// CREDIT_FREEZE: a freeze of the host's page is credited to the push's clocks,
//   as to the others.
//
// Time is discrete. A page that runs handles what is due before more time
// passes (its tick, its message handlers); a frozen page handles nothing.
// What is modelled: one hole; the push and its pushes again; one other
// transfer to the same guest that may be in flight; the guest's
// acknowledgement; the host's freezes. Not modelled: the reconnect and the
// phantom that end a push (specs/ask_escalation.qnt push_deadline), other
// guests (escalation_peers), the stall path's own recovery
// (specs/tick_deadlines.qnt).

module escalation_push {
  const COUNT_SURVIVES: bool
  const LET_GO_ON_OUTCOME: bool
  const MARK_BY_FRAME: bool
  const CREDIT_FREEZE: bool

  pure val MAX_PUSHES = 2
  pure val T = 2    // the push's deadline (OVERDUE_PUSH_TIMEOUT_MS)
  pure val S = 2    // the longest one transfer runs before it ends, handed over or not
  pure val W = 1    // the not-sent window before the fix: shorter than a transfer queued behind another
  pure val B = 5    // the backstop after it: longer than one (2 * S)
  pure val CAP = 6

  type Host = {
    phase: str,          // idle | queued | sending | failed | out | letGo | exhausted | settled | dropped
    earlier: bool,       // another transfer to this guest is in flight ahead of the push
    earlierAge: int,
    sendAge: int,        // how long the push's own transfer has run
    pushes: int,         // pushes counted for this hole
    issued: int,         // history: pushes issued for this hole
    started: bool,       // the deadline runs (push.at set)
    age: int,            // the deadline's clock
    armedAge: int,       // the not-sent clock
    delivered: bool,     // the current push was handed over
    everDelivered: bool,
    liveAge: int,        // time this page could have heard an answer since the hand-over
    frozen: bool,
    ackPending: bool,    // the guest's acknowledgement arrived, not yet handled
    ackInTime: bool,     // it arrived within the deadline's live time
    acked: bool,
    letGoOnItsWay: bool,       // history
    earlyRetry: bool,          // history
    droppedUndelivered: bool,  // history
  }

  var h: Host

  pure def up(x: int): int = if (x >= CAP) CAP else x + 1
  pure val WAITING = Set("queued", "sending", "failed")
  pure val RUNNING = Set("queued", "sending", "failed", "out")
  pure val LET_GO_AFTER = if (LET_GO_ON_OUTCOME) B else W

  action init = {
    nondet e = Set(false, true).oneOf()
    h' = {
      phase: "idle", earlier: e, earlierAge: 0, sendAge: 0, pushes: 0, issued: 0,
      started: false, age: 0, armedAge: 0, delivered: false, everDelivered: false, liveAge: 0,
      frozen: false, ackPending: false, ackInTime: false, acked: false,
      letGoOnItsWay: false, earlyRetry: false, droppedUndelivered: false,
    }
  }

  // A push for the hole goes onto the guest's chain: behind the transfer in
  // flight, or straight out.
  pure def push(x: Host): Host = {
    ...x,
    phase: if (x.earlier) "queued" else "sending",
    sendAge: 0, issued: x.issued + 1, started: false, age: 0, armedAge: 0,
    delivered: false, liveAge: 0,
  }

  // The stall path's ask goes overdue: push (or, past the limit, leave it to
  // the stall path).
  action escalate = all {
    not(h.frozen), Set("idle", "letGo").contains(h.phase), h.issued < CAP,
    if (COUNT_SURVIVES and h.pushes >= MAX_PUSHES)
      h' = { ...h, phase: "exhausted" }
    else
      h' = push({ ...h, pushes: if (COUNT_SURVIVES) h.pushes + 1 else 1 }),
  }

  // The transfer ahead of the push, taken at an earlier frame, is handed
  // over. Before the fix any hand-over to the guest started the deadline.
  action earlierDone = all {
    not(h.frozen), h.earlier,
    val marks = not(MARK_BY_FRAME) and not(h.started) and WAITING.contains(h.phase)
    h' = {
      ...h,
      earlier: false, earlierAge: 0,
      phase: if (h.phase == "queued") "sending" else h.phase,
      sendAge: if (h.phase == "queued") 0 else h.sendAge,
      started: h.started or marks,
      age: if (marks) 0 else h.age,
    },
  }

  // The push's own transfer ends: handed over, or not (the channel closed,
  // a chunk stalled, the capture failed).
  action sendDone = all {
    not(h.frozen), h.phase == "sending",
    nondet ok = Set(false, true).oneOf()
    h' = if (ok) {
      ...h, phase: "out", delivered: true, everDelivered: true, liveAge: 0,
      started: true, age: if (h.started) h.age else 0,
    } else if (LET_GO_ON_OUTCOME) {
      ...h, phase: "letGo",
    } else {
      ...h, phase: "failed",
    },
  }

  // The guest acknowledges a state from the first push on (perhaps while
  // this page is frozen); the page handles it when it runs.
  action guestAcks = all {
    h.everDelivered, not(h.ackPending), not(h.acked),
    h' = { ...h, ackPending: true, ackInTime: h.liveAge < T },
  }
  action handleAck = all {
    not(h.frozen), h.ackPending,
    h' = { ...h, ackPending: false, acked: true },
  }

  // The deadline (pushDeadlineStep): settled, push again, or give up.
  action check = all {
    not(h.frozen), h.started, RUNNING.contains(h.phase),
    if (h.acked)
      h' = { ...h, phase: "settled" }
    else all {
      h.age >= T,
      // Retried before the guest could have answered this push: not handed
      // over, too little live time since, or its answer waiting unhandled.
      val early = not(h.delivered) or h.liveAge < T or (h.ackPending and h.ackInTime)
      if (h.pushes < MAX_PUSHES)
        h' = push({
          ...h,
          pushes: h.pushes + 1,
          // The push still on its way stays ahead of the new one.
          earlier: h.earlier or h.phase == "sending",
          earlierAge: if (h.earlier) h.earlierAge else h.sendAge,
          earlyRetry: h.earlyRetry or early,
        })
      else
        h' = {
          ...h,
          phase: "dropped",
          earlyRetry: h.earlyRetry or early,
          droppedUndelivered: h.droppedUndelivered or not(h.everDelivered),
        },
    },
  }

  // Not handed over by the window: let go (not counted against the guest).
  action letGoTimer = all {
    not(h.frozen), not(h.started), WAITING.contains(h.phase), h.armedAge >= LET_GO_AFTER,
    h' = {
      ...h,
      phase: "letGo",
      earlier: h.earlier or h.phase == "sending",
      earlierAge: if (h.earlier) h.earlierAge else h.sendAge,
      letGoOnItsWay: h.letGoOnItsWay or h.phase == "queued" or h.phase == "sending",
    },
  }

  action freeze = all { not(h.frozen), h' = { ...h, frozen: true } }
  action unfreeze = all { h.frozen, h' = { ...h, frozen: false } }

  // Time passes. The deadline's clocks run through a freeze unless it is
  // credited; transfers and the time to hear an answer need a running page.
  action elapse = all {
    h.frozen or and {
      not(h.ackPending),
      not(h.started and RUNNING.contains(h.phase) and (h.acked or h.age >= T)),
      not(h.phase == "sending" and h.sendAge >= S),
      not(h.earlier and h.earlierAge >= S),
      not(not(h.started) and WAITING.contains(h.phase) and h.armedAge >= LET_GO_AFTER),
    },
    val counts = not(h.frozen) or not(CREDIT_FREEZE)
    h' = {
      ...h,
      age: if (h.started and counts) up(h.age) else h.age,
      armedAge: if (WAITING.contains(h.phase) and counts) up(h.armedAge) else h.armedAge,
      liveAge: if (h.delivered and not(h.frozen)) up(h.liveAge) else h.liveAge,
      sendAge: if (h.phase == "sending" and not(h.frozen)) up(h.sendAge) else h.sendAge,
      earlierAge: if (h.earlier and not(h.frozen)) up(h.earlierAge) else h.earlierAge,
    },
  }

  action stutter = all { h' = h }

  action step = any {
    escalate, earlierDone, sendDone, guestAcks, handleAck, check, letGoTimer, freeze, unfreeze, elapse, stutter
  }

  // ── Properties ───────────────────────────────────────────────────────────

  // At most MAX_PUSHES pushes for one hole, let-goes and further
  // escalations included (pushesAreBounded, with the let-go modelled).
  val pushesAreBoundedPerHole = h.issued <= MAX_PUSHES
  // A push is never let go while its transfer is still on its way.
  val noLetGoOfAPushOnItsWay = not(h.letGoOnItsWay)
  // Never a push again, or a drop, before the guest could have answered the
  // push: handed over, the deadline's live time passed, its answer handled.
  val noRetryBeforeTheGuestCouldAnswer = not(h.earlyRetry)
  // Never a drop when no push reached the guest.
  val noDropWithoutADeliveredPush = not(h.droppedUndelivered)
  val allHold = and {
    pushesAreBoundedPerHole, noLetGoOfAPushOnItsWay, noRetryBeforeTheGuestCouldAnswer, noDropWithoutADeliveredPush
  }

  // ── Scenarios ────────────────────────────────────────────────────────────

  pure val start: Host = {
    phase: "idle", earlier: false, earlierAge: 0, sendAge: 0, pushes: 0, issued: 0,
    started: false, age: 0, armedAge: 0, delivered: false, everDelivered: false, liveAge: 0,
    frozen: false, ackPending: false, ackInTime: false, acked: false,
    letGoOnItsWay: false, earlyRetry: false, droppedUndelivered: false,
  }
  action from(x: Host): bool = h' = x

  // The push queued behind a transfer in flight.
  run queuedBehindTest =
    from({ ...start, earlier: true }).then(escalate).then(elapse)
      .expect(h.phase == "queued")
      .then(if (LET_GO_ON_OUTCOME) earlierDone else letGoTimer)
      .expect(noLetGoOfAPushOnItsWay == LET_GO_ON_OUTCOME)

  // The transfer ahead of the push is handed over after it was armed.
  run earlierMarksTest =
    from({ ...start, earlier: true }).then(escalate).then(earlierDone)
      .expect(h.started == not(MARK_BY_FRAME))

  // Handed over, then the host freezes past the deadline while the guest
  // answers.
  run freezeTest =
    from({ ...start, phase: "out", pushes: 1, issued: 1, started: true, delivered: true, everDelivered: true })
      .then(freeze).then(elapse).then(elapse).then(guestAcks).then(unfreeze)
      .expect((h.age >= T) == not(CREDIT_FREEZE))
      // Uncredited, the deadline is due before the answer is handled.
      .then(if (CREDIT_FREEZE) handleAck else check)
      .expect(noRetryBeforeTheGuestCouldAnswer == CREDIT_FREEZE)

  // Two failed transfers for the same hole.
  run failTwiceTest =
    from({ ...start, phase: "letGo", pushes: 1, issued: 1 }).then(escalate)
      .expect(h.issued == 2)
      .then(all { h' = { ...h, phase: "letGo" } })
      .then(escalate)
      .expect(pushesAreBoundedPerHole == COUNT_SURVIVES)
}

// Before this round: the count starts again, a push is let go on a timer,
// any hand-over starts its deadline, a freeze counts against it.
module escalation_push_current {
  import escalation_push(COUNT_SURVIVES = false, LET_GO_ON_OUTCOME = false, MARK_BY_FRAME = false, CREDIT_FREEZE = false).*
}

// Each fix alone left out: the property it is for is violated.
module escalation_push_count_resets {
  import escalation_push(COUNT_SURVIVES = false, LET_GO_ON_OUTCOME = true, MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}
module escalation_push_timer_let_go {
  import escalation_push(COUNT_SURVIVES = true, LET_GO_ON_OUTCOME = false, MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}
module escalation_push_any_hand_over {
  import escalation_push(COUNT_SURVIVES = true, LET_GO_ON_OUTCOME = true, MARK_BY_FRAME = false, CREDIT_FREEZE = true).*
}
module escalation_push_no_credit {
  import escalation_push(COUNT_SURVIVES = true, LET_GO_ON_OUTCOME = true, MARK_BY_FRAME = true, CREDIT_FREEZE = false).*
}

// The fix.
module escalation_push_fixed {
  import escalation_push(COUNT_SURVIVES = true, LET_GO_ON_OUTCOME = true, MARK_BY_FRAME = true, CREDIT_FREEZE = true).*
}
