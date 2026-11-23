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
// Before: each page set the mask when the roster reached it, at whatever
// frame it was on: the host when it broadcast a roster, a guest when the
// `roster:<frame>:<slots>` message arrived. Two pages with the same inputs
// ran the frames between the two arrival points with different masks, and a
// rollback across the change ran earlier frames again with the new mask.
//
// AT_FRAME (the fix): a roster's mask takes effect at a frame every page
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
//   - a guest that hears of a roster after it has run past its frame (the
//     message took longer than LEAD frames, less the guest's lead over the
//     host) files it at the same agreed frame, because a state from the host
//     will put it there, and asks the host for a full resync: the frames it
//     ran past the change are wrong and nothing local can redo them with
//     today's core (no export starts a rollback from JS). Until the host's
//     state is applied the page is excused from both properties.
//
// A late joiner is not a separate action here: it loads the host's state and
// the host's filed changes (the late-join-state message), which is the
// `resync` step below with the schedule taken from the host.
//
// What is modelled: the host and one guest; the host's frame and the guest's
// (each at most AHEAD frames past the other, the pacing gate), rollbacks of
// up to W frames on either page, roster changes the host makes at its current
// frame (mid-replay included) and sends in order, their arrival at any time,
// and a resync that puts the guest on the host's state and frame. Not
// modelled: three or more pages (each guest is this guest), the resync
// request's own deadline (specs/resync_reask.qnt), the frames before the
// match (the host's state carries them), the shadow worker's core (its mask
// is set once at boot; Mode 2 is opt-in).

module controller_mask {
  const AT_FRAME: bool

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

  var frontier: str -> int          // the lowest frame the page has never run
  var cur: str -> int               // the frame the page steps next (below frontier during a replay)
  var ran: str -> (int -> int)      // the mask each frame ran with the first time
  var core: str -> int              // before: the mask the page set when it heard the roster
  var sched: str -> Set[(int, int)] // the fix: changes filed as (from frame, mask)
  var inflight: List[(int, int)]    // rosters on their way to the guest: (roster frame, mask)
  var changes: int
  var awaitingResync: bool          // the guest heard a roster late and asked for the host's state
  var rerunDiffers: bool            // history: a frame run again with another mask than the first time
  var hostLate: bool                // history: the host filed a change below a frame it had run

  pure def maxInt(a: int, b: int): int = if (a > b) a else b

  // The mask filed for frame f: the change with the greatest `from` at or
  // below f, or BASE. controller-mask.ts maskAt.
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

  // The mask page p steps frame f with.
  def used(p: str, f: int): int = if (AT_FRAME) maskIn(sched.get(p), f) else core.get(p)

  action init = all {
    frontier' = Map("host" -> 0, "guest" -> 0),
    cur' = Map("host" -> 0, "guest" -> 0),
    ran' = Map("host" -> Map(), "guest" -> Map()),
    core' = Map("host" -> BASE, "guest" -> BASE),
    sched' = Map("host" -> Set(), "guest" -> Set()),
    inflight' = List(),
    changes' = 0,
    awaitingResync' = false,
    rerunDiffers' = false,
    hostLate' = false,
  }

  // The host changes the roster at the frame it is on (cur: a replay may be
  // under way) and sends it.
  action hostChange(m: int): bool = {
    val r = cur.get("host")
    val e = r + LEAD
    all {
      changes < MAX_CHANGES,
      changes' = changes + 1,
      inflight' = inflight.append((r, m)),
      core' = if (AT_FRAME) core else core.set("host", m),
      sched' = if (AT_FRAME) sched.set("host", file(sched.get("host"), e, m)) else sched,
      hostLate' = (hostLate or (AT_FRAME and e < frontier.get("host"))),
      frontier' = frontier, cur' = cur, ran' = ran, awaitingResync' = awaitingResync, rerunDiffers' = rerunDiffers,
    }
  }

  // The oldest roster on its way reaches the guest.
  action deliver: bool = {
    val msg = inflight.head()
    val e = msg._1 + LEAD
    val g = frontier.get("guest")
    val filed = file(sched.get("guest"), e, msg._2)
    // The guest has run a frame at or past the change with another mask.
    val late = e < g and e.to(g - 1).exists(f => ran.get("guest").get(f) != maskIn(filed, f))
    all {
      inflight.length() > 0,
      inflight' = inflight.tail(),
      core' = if (AT_FRAME) core else core.set("guest", msg._2),
      sched' = if (AT_FRAME) sched.set("guest", filed) else sched,
      awaitingResync' = (awaitingResync or (AT_FRAME and late)),
      frontier' = frontier, cur' = cur, ran' = ran, changes' = changes, rerunDiffers' = rerunDiffers, hostLate' = hostLate,
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
      rerunDiffers' = (rerunDiffers or (not(forward) and not(excused) and ran.get(p).get(f) != u)),
      core' = core, sched' = sched, inflight' = inflight, changes' = changes,
      awaitingResync' = awaitingResync, hostLate' = hostLate,
    }
  }

  // A misprediction: page p rewinds d frames (only once it has caught up).
  action rollback(p: str, d: int): bool = all {
    cur.get(p) == frontier.get(p),
    frontier.get(p) >= d,
    cur' = cur.set(p, frontier.get(p) - d),
    frontier' = frontier, ran' = ran, core' = core, sched' = sched, inflight' = inflight,
    changes' = changes, awaitingResync' = awaitingResync, rerunDiffers' = rerunDiffers, hostLate' = hostLate,
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
      core' = core, sched' = sched, inflight' = inflight, changes' = changes,
      rerunDiffers' = rerunDiffers, hostLate' = hostLate,
    }
  }

  action stutter = all {
    frontier' = frontier, cur' = cur, ran' = ran, core' = core, sched' = sched, inflight' = inflight,
    changes' = changes, awaitingResync' = awaitingResync, rerunDiffers' = rerunDiffers, hostLate' = hostLate,
  }

  action step = any {
    nondet m = MASKS.oneOf()
    hostChange(m),
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

  // Two pages never run the same frame with different masks, except on a
  // guest that has run past a roster it has not heard yet or has heard late
  // and is waiting for the host's state.
  val pagesAgree =
    awaitingResync or guestRanPastAnUnheardRoster or
      ran.get("host").keys().intersect(ran.get("guest").keys())
        .forall(f => ran.get("host").get(f) == ran.get("guest").get(f))

  // A frame run again uses the mask it used the first time.
  val aFrameRunAgainKeepsItsMask = not(rerunDiffers)

  // The host never files a change below a frame it has already run.
  val hostIsNeverLate = not(hostLate)

  val allHold = pagesAgree and aFrameRunAgainKeepsItsMask and hostIsNeverLate

  // ── Scenarios ────────────────────────────────────────────────────────────

  // The host changes the roster at frame 0 and runs on; the guest hears it
  // two frames later. Before: the guest ran frames 0 and 1 with the old mask
  // and the host with the new one. The fix: both change at frame 3.
  run arrivalOrderTest =
    init
      .then(hostChange(7))
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(deliver)
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("host"))
      .expect(if (AT_FRAME) allHold else not(pagesAgree))

  // The guest hears the roster at frame 2, then rolls back 2 frames: before,
  // frames 0 and 1 run again with the new mask. With the fix the change is
  // at frame 3 and the replay uses the masks the frames first ran with.
  run rollbackAcrossTheChangeTest =
    init
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(hostChange(7))
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(deliver)
      .then(rollback("guest", 2))
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .expect(if (AT_FRAME) aFrameRunAgainKeepsItsMask else not(aFrameRunAgainKeepsItsMask))

  // The host changes the roster mid-replay: its roster frame is below frames
  // it has run, but the change is LEAD frames later, past all of them.
  run hostMidReplayTest =
    init
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(rollback("host", 2))
      .then(hostChange(7))
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(stepFrame("guest")).then(stepFrame("guest")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("host"))
      .expect(if (AT_FRAME) allHold else not(allHold))

  // The roster is slow: the guest runs past the change before it arrives.
  // With the fix it files the change at the agreed frame, asks for the
  // host's state, and once that is applied the pages agree again.
  run lateArrivalTest =
    init
      .then(hostChange(7))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(deliver)
      .expect(if (AT_FRAME) awaitingResync else not(pagesAgree))
      .then(if (AT_FRAME) stepFrame("host").then(stepFrame("host")).then(resync) else stutter)
      .then(stepFrame("host")).then(stepFrame("host")).then(stepFrame("guest"))
      .expect(if (AT_FRAME) allHold and not(awaitingResync) else not(pagesAgree))

  // The host, paused for a late joiner, broadcasts twice at one frame (a
  // second joiner became a player): the later roster wins on both pages.
  run twiceAtOneFrameTest =
    init
      .then(hostChange(7)).then(hostChange(1))
      .then(deliver).then(deliver)
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .expect(allHold and (not(AT_FRAME) or ran.get("guest").get(3) == 1))
}

// Before: each page set the mask when it heard the roster.
module controller_mask_before {
  import controller_mask(AT_FRAME = false).*
}

// The fix.
module controller_mask_fixed {
  import controller_mask(AT_FRAME = true).*
}
