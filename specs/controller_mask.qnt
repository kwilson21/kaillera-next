// -*- mode: Bluespec; -*-
//
// Which controllers the game sees as plugged in, frame by frame: the
// controller-present mask (_controllerPresentMask, _applyControllerPresentMask,
// _broadcastRoster and the `roster:` handler in
// web/static/netplay-rollback.js; web/src/controller-mask.ts).
//
// The patched core keeps one mask (kn_controller_present_mask) and sets every
// pad's "present" bit from it on each controller write, forward and replay
// alike; the game reads the bits while the frame runs. The mask is not part
// of the rollback state.
//
// Before ("immediate"): each page set the mask when the roster reached it, at
// whatever frame it was on: the host when it broadcast a roster, a guest when
// the `roster:<frame>:<slots>` message arrived. Two pages with the same
// inputs ran the frames between the two arrival points with different masks,
// and a rollback across the change ran earlier frames again with the new mask.
//
// AT_FRAME ("scheduled"): a roster's mask takes effect at a frame every page
// agrees on, `roster frame + LEAD`, where the roster frame is the host's
// frame in the message (the frame _recordHostInputRoster files the late
// joiner's input floor at: the input admission agreement, reused). Each page
// files the change at that frame, and before every frame it steps (forward,
// replay, catch-up) sets the core mask to the mask filed for that frame. A
// frame run again uses the mask it used the first time as long as no change
// is ever filed at or below a frame the page has already run:
//   - the host files at its own frame + LEAD; its frame is at most a rollback
//     window behind the furthest frame it has run, and LEAD exceeds the
//     window, so the host is never late (hostIsNeverLate);
//   - a guest that hears of a roster after it has run past its frame files it
//     at the same agreed frame and asks the host for a full resync.
//
// Pages from before the scheduled rule (`old` here) keep the immediate rule,
// and a match can span a deploy. A page on one rule and a page on the other
// run up to LEAD frames with different masks, worse than everyone immediate,
// which differ only by arrival time. VERSIONED (the fix for that): one rule
// per match, the host's:
//   - the host schedules only while every player page in the match says it
//     can: starters in `lockstep-ready`'s caps, late joiners in
//     `request-late-join`'s caps; a page that says nothing is old;
//   - once a page that cannot is let in, the host falls back to the immediate
//     rule for the rest of the match (it does not switch back: that would need
//     a frame every page agrees on again, and the old page cannot agree);
//   - each roster the host schedules is preceded, on the same ordered channel,
//     by `roster-mask:<roster frame>`; a new guest schedules exactly the
//     rosters announced so and applies any other at once, and stops
//     scheduling after the first one that is not (an old host never announces
//     one). An old guest drops the announcement unread.
// Without VERSIONED (controller_mask_unversioned, the first fix as written) a
// new page scheduled whatever the others did.
//
// A late joiner is not a page of its own here: a new one loads the host's
// state and filed changes (late-join-state's controllerMasks, only sent while
// the match is scheduled), which is the `resync` step below; an old one is
// the `withOld` roster that lets it in.
//
// What is modelled: the host and one guest, each new or old; the host's frame
// and the guest's (each at most AHEAD frames past the other, the pacing
// gate), rollbacks of up to W frames on either page, roster changes the host
// makes at its current frame (mid-replay included), possibly letting in an
// old joiner, and sends in order, their arrival at any time, and a resync
// that puts the guest on the host's state and frame. Not modelled: three or
// more pages (each guest is this guest), the resync request's own deadline
// (specs/resync_reask.qnt), the frames before the match (the host's state
// carries them), the shadow worker's core (its mask is set once at boot;
// Mode 2 is opt-in).

module controller_mask {
  const AT_FRAME: bool
  const VERSIONED: bool

  // Frames past the host's roster frame the change takes effect at.
  pure val LEAD = 3
  // The rollback window: a page runs again at most this many frames back.
  pure val W = 2
  // Pacing: a page runs at most this many frames past the other.
  pure val AHEAD = 2
  // Bound on frames for the model.
  pure val MAX_F = 9
  // Bound on roster changes for the model.
  pure val MAX_CHANGES = 2
  // The mask before any roster change, and the masks a roster can have.
  pure val BASE = 3
  pure val MASKS = Set(1, 3, 7)

  pure val PAGES = Set("host", "guest")
  pure def other(p: str): str = if (p == "host") "guest" else "host"

  // A page's rule: "scheduled", "immediate", or (a new guest before the
  // first roster) "undecided", which runs the schedule's starting mask.
  pure val SCHEDULED = "scheduled"
  pure val IMMEDIATE = "immediate"
  pure val UNDECIDED = "undecided"

  var isNew: str -> bool            // the page is from after the scheduled rule
  var rule: str -> str
  var frontier: str -> int          // the lowest frame the page has never run
  var cur: str -> int               // the frame the page steps next (below frontier during a replay)
  var ran: str -> (int -> int)      // the mask each frame ran with the first time
  var core: str -> int              // immediate: the mask the page set when it heard the roster
  var sched: str -> Set[(int, int)] // scheduled: changes filed as (from frame, mask)
  var inflight: List[(int, int, bool)] // rosters on their way to the guest: (roster frame, mask, announced as scheduled)
  var changes: int
  var oldJoined: bool               // a page that cannot schedule was let into the match
  var awaitingResync: bool          // the guest heard a roster late and asked for the host's state
  var rerunDiffers: bool            // history: a scheduled frame run again with another mask than the first time
  var hostLate: bool                // history: the host filed a change below a frame it had run
  var ruleMismatch: bool            // history: a roster run under another rule than the host's
  var everImmediate: bool           // history: some page in the match applied a roster at once

  pure def maxInt(a: int, b: int): int = if (a > b) a else b

  // The mask filed for frame f: the change with the greatest `from` at or
  // below f, or BASE. controller-mask.ts changeInEffect.
  pure def maskIn(s: Set[(int, int)], f: int): int =
    val earlier = s.filter(e => e._1 <= f)
    if (earlier.size() == 0) BASE
    else
      val top = earlier.fold(-1, (acc, e) => maxInt(acc, e._1))
      earlier.filter(e => e._1 == top).fold(BASE, (acc, e) => e._2)

  // File a change: one at the same frame is replaced (the host broadcast
  // twice while paused at one frame; the later word wins on every page,
  // since each channel is ordered). controller-mask.ts fileIndex.
  pure def file(s: Set[(int, int)], from: int, m: int): Set[(int, int)] =
    s.filter(e => e._1 != from).union(Set((from, m)))

  // The host's rule for a match it starts: controller-mask.ts matchScheduled.
  def startRule(hostNew: bool, guestNew: bool): str =
    if (not(AT_FRAME) or not(hostNew)) IMMEDIATE
    else if (VERSIONED and not(guestNew)) IMMEDIATE
    else SCHEDULED

  // A page runs the schedule unless its rule is immediate.
  def usesSchedule(p: str): bool = AT_FRAME and isNew.get(p) and rule.get(p) != IMMEDIATE

  // The mask page p steps frame f with.
  def used(p: str, f: int): int = if (usesSchedule(p)) maskIn(sched.get(p), f) else core.get(p)

  action initWith(hostNew: bool, guestNew: bool): bool = all {
    isNew' = Map("host" -> hostNew, "guest" -> guestNew),
    rule' = Map(
      "host" -> startRule(hostNew, guestNew),
      "guest" -> if (AT_FRAME and guestNew) UNDECIDED else IMMEDIATE,
    ),
    frontier' = Map("host" -> 0, "guest" -> 0),
    cur' = Map("host" -> 0, "guest" -> 0),
    ran' = Map("host" -> Map(), "guest" -> Map()),
    core' = Map("host" -> BASE, "guest" -> BASE),
    sched' = Map("host" -> Set(), "guest" -> Set()),
    inflight' = List(),
    changes' = 0,
    oldJoined' = false,
    awaitingResync' = false,
    rerunDiffers' = false,
    hostLate' = false,
    ruleMismatch' = false,
    everImmediate' = false,
  }

  action init = {
    nondet hostNew = Set(true, false).oneOf()
    nondet guestNew = Set(true, false).oneOf()
    initWith(hostNew, guestNew)
  }

  // The host changes the roster at the frame it is on (cur: a replay may be
  // under way) and sends it. `withOld`: the roster lets in a joiner that
  // cannot schedule.
  action hostChange(m: int, withOld: bool): bool = {
    val r = cur.get("host")
    val e = r + LEAD
    val joinedOld = oldJoined or withOld
    // A versioned host stops scheduling once a page that cannot is in.
    val newRule =
      if (rule.get("host") == SCHEDULED and VERSIONED and joinedOld) IMMEDIATE else rule.get("host")
    val scheduled = newRule == SCHEDULED
    all {
      changes < MAX_CHANGES,
      changes' = changes + 1,
      oldJoined' = joinedOld,
      rule' = rule.set("host", newRule),
      // Announced only by a host that schedules this roster.
      inflight' = inflight.append((r, m, scheduled)),
      core' = if (scheduled) core else core.set("host", m),
      sched' = if (scheduled) sched.set("host", file(sched.get("host"), e, m)) else sched,
      hostLate' = (hostLate or (scheduled and e < frontier.get("host"))),
      // The old joiner applies rosters at once: a scheduled host is on another rule.
      ruleMismatch' = (ruleMismatch or (withOld and scheduled)),
      everImmediate' = (everImmediate or not(scheduled) or withOld),
      isNew' = isNew, frontier' = frontier, cur' = cur, ran' = ran, awaitingResync' = awaitingResync,
      rerunDiffers' = rerunDiffers,
    }
  }

  // The oldest roster on its way reaches the guest.
  action deliver: bool = {
    val msg = inflight.head()
    val e = msg._1 + LEAD
    val g = frontier.get("guest")
    // The rule the guest runs this roster under.
    val applied =
      if (not(AT_FRAME) or not(isNew.get("guest"))) IMMEDIATE
      else if (not(VERSIONED)) SCHEDULED
      else if (msg._3 and rule.get("guest") != IMMEDIATE) SCHEDULED
      else IMMEDIATE
    val filed = file(sched.get("guest"), e, msg._2)
    // The guest has run a frame at or past the change with another mask.
    val late = e < g and e.to(g - 1).exists(f => ran.get("guest").get(f) != maskIn(filed, f))
    all {
      inflight.length() > 0,
      inflight' = inflight.tail(),
      rule' = rule.set("guest", applied),
      core' = if (applied == SCHEDULED) core else core.set("guest", msg._2),
      sched' = if (applied == SCHEDULED) sched.set("guest", filed) else sched,
      awaitingResync' = (awaitingResync or (applied == SCHEDULED and late)),
      ruleMismatch' = (ruleMismatch or (applied == SCHEDULED) != msg._3),
      everImmediate' = (everImmediate or applied == IMMEDIATE),
      isNew' = isNew, frontier' = frontier, cur' = cur, ran' = ran, changes' = changes,
      oldJoined' = oldJoined, rerunDiffers' = rerunDiffers, hostLate' = hostLate,
    }
  }

  // Page p steps frame cur[p]: forward when it is the frontier, a replay
  // frame otherwise.
  action stepFrame(p: str): bool = {
    val f = cur.get(p)
    val u = used(p, f)
    val forward = f == frontier.get(p)
    val excused = p == "guest" and awaitingResync
    all {
      f < MAX_F,
      not(forward) or frontier.get(p) + 1 - frontier.get(other(p)) <= AHEAD,
      cur' = cur.set(p, f + 1),
      frontier' = if (forward) frontier.set(p, f + 1) else frontier,
      ran' = if (forward) ran.set(p, ran.get(p).put(f, u)) else ran,
      rerunDiffers' = (rerunDiffers or (usesSchedule(p) and not(forward) and not(excused) and ran.get(p).get(f) != u)),
      isNew' = isNew, rule' = rule, core' = core, sched' = sched, inflight' = inflight, changes' = changes,
      oldJoined' = oldJoined, awaitingResync' = awaitingResync, hostLate' = hostLate,
      ruleMismatch' = ruleMismatch, everImmediate' = everImmediate,
    }
  }

  // A misprediction: page p rewinds d frames (only once it has caught up).
  action rollback(p: str, d: int): bool = all {
    cur.get(p) == frontier.get(p),
    frontier.get(p) >= d,
    cur' = cur.set(p, frontier.get(p) - d),
    isNew' = isNew, rule' = rule, frontier' = frontier, ran' = ran, core' = core, sched' = sched,
    inflight' = inflight, changes' = changes, oldJoined' = oldJoined, awaitingResync' = awaitingResync,
    rerunDiffers' = rerunDiffers, hostLate' = hostLate, ruleMismatch' = ruleMismatch,
    everImmediate' = everImmediate,
  }

  // The host's state reaches the guest: the guest is on the host's frame
  // with the host's history (a late joiner's load is this step too, its
  // schedule taken from the host).
  action resync: bool = {
    val x = frontier.get("host")
    all {
      awaitingResync,
      cur.get("host") == x,
      frontier' = frontier.set("guest", x),
      cur' = cur.set("guest", x),
      ran' = ran.set("guest", ran.get("host")),
      awaitingResync' = false,
      isNew' = isNew, rule' = rule, core' = core, sched' = sched, inflight' = inflight, changes' = changes,
      oldJoined' = oldJoined, rerunDiffers' = rerunDiffers, hostLate' = hostLate,
      ruleMismatch' = ruleMismatch, everImmediate' = everImmediate,
    }
  }

  action stutter = all {
    isNew' = isNew, rule' = rule, frontier' = frontier, cur' = cur, ran' = ran, core' = core,
    sched' = sched, inflight' = inflight, changes' = changes, oldJoined' = oldJoined,
    awaitingResync' = awaitingResync, rerunDiffers' = rerunDiffers, hostLate' = hostLate,
    ruleMismatch' = ruleMismatch, everImmediate' = everImmediate,
  }

  action step = any {
    nondet m = MASKS.oneOf()
    nondet withOld = Set(true, false).oneOf()
    hostChange(m, withOld),
    deliver,
    nondet p = PAGES.oneOf()
    any {
      stepFrame(p),
      nondet d = 1.to(W).oneOf()
      rollback(p, d),
    },
    resync,
    stutter,
  }

  // ── Properties ───────────────────────────────────────────────────────────

  // The guest has run past the frame of a roster still on its way to it. No
  // rule can stop that (the message may take any time); the guest finds out
  // when the roster arrives (`deliver` sets awaitingResync).
  def guestRanPastAnUnheardRoster: bool =
    inflight.indices().exists(i => inflight.nth(i)._1 + LEAD < frontier.get("guest"))

  // In a match every page schedules, two pages never run the same frame
  // with different masks, except on a guest that has run past a roster it
  // has not heard yet or has heard late and is waiting for the host's state.
  // A match on the immediate rule differs by arrival time, as before.
  def ranAlike: bool =
    ran.get("host").keys().intersect(ran.get("guest").keys())
      .forall(f => ran.get("host").get(f) == ran.get("guest").get(f))

  val pagesAgree = everImmediate or awaitingResync or guestRanPastAnUnheardRoster or ranAlike

  // A scheduled frame run again uses the mask it used the first time.
  val aFrameRunAgainKeepsItsMask = not(rerunDiffers)

  // The host never files a change below a frame it has already run.
  val hostIsNeverLate = not(hostLate)

  // Pages in one match never run a roster under different rules: each
  // roster runs on every page under the host's rule for it.
  val oneRulePerMatch = not(ruleMismatch)

  // A match whose pages are all new is scheduled throughout.
  val anAllNewMatchIsScheduled =
    (AT_FRAME and isNew.get("host") and isNew.get("guest") and not(oldJoined)) implies
      (rule.get("host") == SCHEDULED and rule.get("guest") != IMMEDIATE)

  val allHold =
    pagesAgree and aFrameRunAgainKeepsItsMask and hostIsNeverLate and oneRulePerMatch and anAllNewMatchIsScheduled

  // ── Scenarios ────────────────────────────────────────────────────────────

  // The host changes the roster at frame 0 and runs on; the guest hears it
  // two frames later. Before: the guest ran frames 0 and 1 with the old mask
  // and the host with the new one. Scheduled: both change at frame 3.
  run arrivalOrderTest =
    initWith(true, true)
      .then(hostChange(7, false))
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(deliver)
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("host"))
      .expect(if (AT_FRAME) allHold else not(ranAlike))

  // The guest hears the roster at frame 2, then rolls back 2 frames: before,
  // frames 0 and 1 run again with the new mask. Scheduled, the change is at
  // frame 3 and the replay uses the masks the frames first ran with.
  run rollbackAcrossTheChangeTest =
    initWith(true, true)
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(hostChange(7, false))
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(deliver)
      .then(rollback("guest", 2))
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .expect(if (AT_FRAME) aFrameRunAgainKeepsItsMask else ran.get("guest").get(0) != core.get("guest"))

  // The host changes the roster mid-replay: its roster frame is below frames
  // it has run, but the change is LEAD frames later, past all of them.
  run hostMidReplayTest =
    initWith(true, true)
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(rollback("host", 2))
      .then(hostChange(7, false))
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(stepFrame("guest")).then(stepFrame("guest")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("host"))
      .expect(if (AT_FRAME) allHold and ran.get("host").get(3) == 7 else ran.get("host").get(0) == 3)

  // The roster is slow: the guest runs past the change before it arrives.
  // Scheduled, it files the change at the agreed frame, asks for the host's
  // state, and once that is applied the pages agree again.
  run lateArrivalTest =
    initWith(true, true)
      .then(hostChange(7, false))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(deliver)
      .expect(if (AT_FRAME) awaitingResync else not(ranAlike))
      .then(if (AT_FRAME) stepFrame("host").then(stepFrame("host")).then(resync) else stutter)
      .then(stepFrame("host")).then(stepFrame("host")).then(stepFrame("guest"))
      .expect(if (AT_FRAME) allHold and not(awaitingResync) else not(ranAlike))

  // The host, paused for a late joiner, broadcasts twice at one frame (a
  // second joiner became a player): the later roster wins on both pages.
  run twiceAtOneFrameTest =
    initWith(true, true)
      .then(hostChange(7, false)).then(hostChange(1, false))
      .then(deliver).then(deliver)
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .expect(not(AT_FRAME) or (allHold and ran.get("guest").get(3) == 1))

  // A new host with a guest tab loaded before the deploy. Versioned: the host
  // sees no capability, runs the match immediate and announces nothing.
  // Unversioned: the host schedules while the guest applies at once.
  run oldGuestTest =
    initWith(true, false)
      .then(hostChange(7, false))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(deliver)
      .expect(
        if (not(AT_FRAME)) everImmediate
        else if (VERSIONED) oneRulePerMatch and rule.get("host") == IMMEDIATE
        else not(oneRulePerMatch)
      )

  // A host loaded before the deploy with a new guest: it announces nothing,
  // so a versioned guest applies the roster at once, as the host does.
  run oldHostTest =
    initWith(false, true)
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(hostChange(7, false))
      .then(deliver)
      .expect(
        if (not(AT_FRAME)) everImmediate
        else if (VERSIONED) oneRulePerMatch and rule.get("guest") == IMMEDIATE and core.get("guest") == 7
        else not(oneRulePerMatch)
      )

  // An all-new match, scheduled, lets in a late joiner loaded before the
  // deploy. Versioned: that roster and every later one are immediate on
  // both pages. Unversioned: the host keeps scheduling beside the old page.
  run oldJoinerTest =
    initWith(true, true)
      .then(hostChange(7, false))
      .then(deliver)
      .expect(not(AT_FRAME) or (allHold and rule.get("guest") == SCHEDULED))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(hostChange(1, true))
      .then(deliver)
      .expect(
        if (not(AT_FRAME)) everImmediate
        else if (VERSIONED)
          oneRulePerMatch and rule.get("host") == IMMEDIATE and rule.get("guest") == IMMEDIATE
        else not(oneRulePerMatch)
      )
}

// Before: each page set the mask when it heard the roster.
module controller_mask_before {
  import controller_mask(AT_FRAME = false, VERSIONED = true).*
}

// The first fix as written: a new page schedules whatever the other pages
// do, so a match spanning a deploy runs on two rules.
module controller_mask_unversioned {
  import controller_mask(AT_FRAME = true, VERSIONED = false).*
}

// The fix: one rule per match, the host's.
module controller_mask_fixed {
  import controller_mask(AT_FRAME = true, VERSIONED = true).*
}
