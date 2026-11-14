// -*- mode: Bluespec; -*-
//
// Inputs around a resync: which inputs a page may wait for after the guest
// has loaded the host's state (applySyncState and the rollback input stall in
// web/static/netplay-rollback.js).
//
// Each page makes one input per frame, keyed by the frame it was made on,
// and sends it to the other. The input keyed k is applied on frame k + DELAY.
// A page may run ahead of the inputs it has received, predicting, but only
// CAP frames past the delay: beyond that a wrong prediction could no longer
// be rolled back. So before each frame f a page waits when
//   - the newest input it has from the other page is DELAY + CAP + 1 or more
//     frames behind f and the one for this frame is missing ("behind"), or
//   - the input keyed f - DELAY - CAP is missing while newer ones have
//     arrived ("gap").
// Both waits end by themselves when the input arrives. If it does not, the
// page gives up on the other after 5 s (RB-INPUT-STALL-TIMEOUT), runs alone,
// and the two resync when the other is heard from again.
//
// A resync moves the guest's frame counter to the host's. When the guest was
// behind (it froze, the host gave up on it and ran on), that jump skips
// frames on the guest:
//   - the guest never made inputs for the skipped frames, so the host has a
//     gap in the guest's inputs that nothing will fill;
//   - the host's inputs for those frames reached the guest while it was far
//     behind, and were dropped as out of range (INPUT-OOR), so the guest has
//     a gap in the host's inputs that nothing will fill.
// Both pages then waited at the same frame for 5 s, gave up on each other
// and resynced again, several times over (found in a two-player run in which
// one page froze for 5 s, 2026-11).
//
// What is modelled: two pages, the wire between them (reliable; the only
// loss is the receiver's range check), giving up, and the resync as one step.
//
// Not modelled: the time a state takes to cross (the host keeps running and
// the guest lands a few frames behind, the ordinary "behind" wait), more than
// two players and a new match in the same session (both in
// specs/resync_mesh.qnt), packet loss on the
// unreliable input channel, the contents of inputs and the rollbacks that
// follow a wrong prediction.
//
// SETTLE_AT_RESYNC: a resync at frame F settles every input keyed before
//   F - DELAY (they are already in the state both pages now hold, so neither
//   waits for one); the guest makes and sends its inputs for the frames it
//   skipped from F - DELAY on, and the host sends its own for that range
//   again. false = before.
//
// A resync can also move the guest back: the host froze, the guest gave up on
// it and ran on. The guest made and sent every input up to where it was, but
// the host, far behind, dropped the later ones as out of range. The guest is
// taken back to F and plays on from there; it never sends the inputs keyed
// F - DELAY to F - 1 again, and the host waits 5 s for them.
//
// RESEND_HELD: at a resync the guest sends its inputs keyed F - DELAY to
//   F - 1 again whether it has just made them or held them already. false =
//   only the ones it has just made, which is what the engine does today.
module resync_inputs {
  const SETTLE_AT_RESYNC: bool
  const RESEND_HELD: bool

  pure val DELAY = 1
  pure val CAP = 2
  // How far past its own frame a page accepts an input (the range check).
  // Wide enough that a page that has not been given up on never trips it.
  pure val MARGIN = 2
  pure val LAST_FRAME = 9

  pure val PAGES = Set("host", "guest")
  pure def other(p: str): str = if (p == "host") "guest" else "host"

  type Page = {
    frame: int,      // the next frame to run
    made: Set[int],  // keys of the inputs this page has made
    got: Set[int],   // keys of the other page's inputs it holds
    floor: int,      // inputs keyed below this are settled
    alone: bool,     // has given up on the other page and runs without it
  }
  type Packet = { dest: str, key: int }

  var pages: str -> Page
  var wire: Set[Packet]
  // One page gave up on the other and they have not resynced since.
  var resyncDue: bool

  // ── what a page waits for ──────────────────────────────────────────────

  pure def newest(s: Set[int]): int = s.fold(-1, (a, k) => if (k > a) k else a)

  pure def edge(pg: Page): int = pg.frame - DELAY - CAP

  pure def waitsOnGap(pg: Page): bool = and {
    not(pg.alone),
    edge(pg) >= 0,
    edge(pg) >= pg.floor,
    edge(pg) < newest(pg.got),
    not(pg.got.contains(edge(pg))),
  }

  pure def waitsBehind(pg: Page): bool = and {
    not(pg.alone),
    pg.frame - DELAY >= 0,
    not(pg.got.contains(pg.frame - DELAY)),
    pg.frame - newest(pg.got) >= DELAY + CAP + 1,
  }

  pure def waits(pg: Page): bool = waitsOnGap(pg) or waitsBehind(pg)

  // ── actions ────────────────────────────────────────────────────────────

  action init = all {
    pages' = PAGES.mapBy(p => { frame: 0, made: Set(), got: Set(), floor: 0, alone: false }),
    wire' = Set(),
    resyncDue' = false,
  }

  // Run one frame: make this frame's input and send it. A page that never
  // takes this step is a frozen page.
  action tick(p: str): bool = {
    val pg = pages.get(p)
    all {
      not(waits(pg)),
      pg.frame < LAST_FRAME,
      pages' = pages.set(p, { ...pg, frame: pg.frame + 1, made: pg.made.union(Set(pg.frame)) }),
      wire' = wire.union(Set({ dest: other(p), key: pg.frame })),
      resyncDue' = resyncDue,
    }
  }

  pure def accepts(pg: Page, key: int): bool = key <= pg.frame + DELAY + MARGIN

  action deliver(m: Packet): bool = {
    val pg = pages.get(m.dest)
    all {
      wire.contains(m),
      wire' = wire.exclude(Set(m)),
      pages' = if (accepts(pg, m.key)) pages.set(m.dest, { ...pg, got: pg.got.union(Set(m.key)) }) else pages,
      resyncDue' = resyncDue,
    }
  }

  // Everything on the wire arrives (for scenarios).
  action drain = all {
    wire != Set(),
    pages' = PAGES.mapBy(p => {
      val pg = pages.get(p)
      val arriving = wire.filter(m => m.dest == p and accepts(pg, m.key)).map(m => m.key)
      { ...pg, got: pg.got.union(arriving) }
    }),
    wire' = Set(),
    resyncDue' = resyncDue,
  }

  // The 5 s deadline: a page that hears nothing gives up on the other.
  action giveUp(p: str): bool = {
    val pg = pages.get(p)
    all {
      not(pg.alone),
      pages' = pages.set(p, { ...pg, alone: true }),
      wire' = wire,
      resyncDue' = true,
    }
  }

  pure def keysFrom(from: int, until: int): Set[int] = 0.to(LAST_FRAME).filter(k => k >= from and k < until)

  // The guest loads the host's state: its counter becomes the host's.
  action resync = {
    val h = pages.get("host")
    val g = pages.get("guest")
    val f = h.frame
    val settled = if (f - DELAY > 0) f - DELAY else 0
    // The guest's inputs from the settled point up to F that it never made.
    val skipped = keysFrom(settled, f).exclude(g.made)
    all {
      resyncDue,
      pages' = if (SETTLE_AT_RESYNC) Map(
        "host" -> { ...h, floor: settled, alone: false },
        "guest" -> { ...g, frame: f, floor: settled, alone: false, made: g.made.union(skipped) },
      ) else Map(
        "host" -> { ...h, alone: false },
        "guest" -> { ...g, frame: f, alone: false },
      ),
      wire' = if (SETTLE_AT_RESYNC)
        wire
          .union((if (RESEND_HELD) keysFrom(settled, f) else skipped).map(k => { dest: "host", key: k }))
          .union(keysFrom(settled, f).intersect(h.made).map(k => { dest: "guest", key: k }))
      else wire,
      resyncDue' = false,
    }
  }

  action step = any {
    nondet p = oneOf(PAGES)
    any { tick(p), giveUp(p) },
    nondet m = oneOf(wire)
    deliver(m),
    resync,
  }

  // ── properties ─────────────────────────────────────────────────────────

  // The input can still reach the page: it is on its way, or the other page
  // has not made it yet.
  def canArrive(p: str, key: int): bool =
    wire.contains({ dest: p, key: key }) or key >= pages.get(other(p)).frame

  // Once the pages have resynced, nobody waits for an input that will never
  // come. (While a resync is due the wait has that resync to end it.)
  // Violated before the fix: after a forward resync both pages hold gaps.
  val noWaitForAnInputThatCannotArrive =
    resyncDue or PAGES.forall(p => and {
      waitsOnGap(pages.get(p)) implies canArrive(p, edge(pages.get(p))),
      waitsBehind(pages.get(p)) implies canArrive(p, pages.get(p).frame - DELAY),
    })

  // The two pages are never both waiting with nothing on the wire and no
  // resync due: only the 5 s deadline would end that.
  // Violated before the fix, by the same ordering.
  val neverBothWaitingOnNothing =
    resyncDue or wire != Set() or PAGES.exists(p => not(waits(pages.get(p))))

  val allHold = noWaitForAnInputThatCannotArrive and neverBothWaitingOnNothing

  // ── scenarios ──────────────────────────────────────────────────────────

  // The run that found it. The guest freezes; the host runs out of
  // prediction room, gives up on it and runs on alone; the host's inputs
  // reach the guest while it is far behind; the pages resync.
  run guestFreezesThenResyncsForwardTest =
    init
      .then(3.reps(_ => tick("host")))
      .expect(waits(pages.get("host")))
      .then(giveUp("host"))
      .then(4.reps(_ => tick("host")))
      .then(drain)
      // The guest, still at frame 0, kept inputs 0..3 and dropped 4..6.
      .expect(pages.get("guest").got == Set(0, 1, 2, 3))
      .then(resync)
      .expect(pages.get("guest").frame == 7)
      // Fixed: the inputs for frame 6, sent again, arrive and both run on.
      // Before: nothing is coming, and the 5 s deadline ends the wait.
      .then(if (SETTLE_AT_RESYNC) drain else giveUp("guest"))
      .expect(SETTLE_AT_RESYNC implies PAGES.forall(p => not(waits(pages.get(p)))))

  // The same ordering, stopped right after the resync: before the fix both
  // pages are waiting and nothing is on its way.
  run bothWaitAfterAForwardResyncTest =
    init
      .then(3.reps(_ => tick("host")))
      .then(giveUp("host"))
      .then(4.reps(_ => tick("host")))
      .then(drain)
      .then(resync)
      .expect(neverBothWaitingOnNothing == SETTLE_AT_RESYNC)

  // After the resync the guest plays on (before the fix: once its own wait
  // has timed out) and its new input reaches the host. Before the fix the
  // host then finds the hole the skipped frames left.
  run hostFindsTheHoleTheGuestSkippedTest =
    init
      .then(3.reps(_ => tick("host")))
      .then(giveUp("host"))
      .then(4.reps(_ => tick("host")))
      .then(drain)
      .then(resync)
      .then(if (SETTLE_AT_RESYNC) drain else giveUp("guest"))
      .then(tick("guest"))
      .then(drain)
      .expect(waitsOnGap(pages.get("host")) == not(SETTLE_AT_RESYNC))

  // The guest is ahead and is taken back, and the host has every input the
  // guest sent: nothing is missing, with or without the fix.
  run backwardResyncTest =
    init
      .then(3.reps(_ => tick("guest")))
      .then(drain)
      .then(giveUp("guest"))
      .then(2.reps(_ => tick("guest")))
      .then(drain)
      .then(tick("host"))
      .then(drain)
      .then(resync)
      .expect(pages.get("guest").frame == 1)
      .expect(allHold)
      .then(tick("host"))
      .then(drain)
      .expect(allHold)

  // Found by `quint run` on today's rule (seed 0xc4580084f3094).
  // The host freezes at frame 0; the guest gives up on it and runs to frame
  // 9; the host keeps the guest's inputs 0..3 and drops the rest as out of
  // range, gives up in turn and runs to frame 7 alone; the pages resync
  // there. The guest made input 6 long ago and is not taken back past it, so
  // only sending it again can fill the hole.
  run hostFreezesThenResyncsBackwardTest =
    init
      .then(3.reps(_ => tick("guest")))
      .then(giveUp("guest"))
      .then(6.reps(_ => tick("guest")))
      .then(drain)
      .expect(pages.get("host").got == Set(0, 1, 2, 3))
      .then(giveUp("host"))
      .then(7.reps(_ => tick("host")))
      .then(resync)
      .expect(pages.get("guest").frame == 7)
      .expect(waitsBehind(pages.get("host")))
      .expect(noWaitForAnInputThatCannotArrive == RESEND_HELD)
      .then(drain)
      .expect(waits(pages.get("host")) == not(RESEND_HELD))
}

// Before: a resync changed the guest's frame counter and nothing else.
module resync_inputs_before {
  import resync_inputs(SETTLE_AT_RESYNC = false, RESEND_HELD = false).*
}

// Today (#160): a resync settles the inputs before its frame, and the guest
// makes and sends the ones it skipped. noWaitForAnInputThatCannotArrive is
// still violated: a resync that moves the guest back past inputs the host
// dropped leaves the host waiting (hostFreezesThenResyncsBackwardTest).
// neverBothWaitingOnNothing holds.
module resync_inputs_current {
  import resync_inputs(SETTLE_AT_RESYNC = true, RESEND_HELD = false).*
}

// With the guest's inputs for the frames before the resync sent again
// whether it has just made them or held them already. Not in the engine.
module resync_inputs_fixed {
  import resync_inputs(SETTLE_AT_RESYNC = true, RESEND_HELD = true).*
}
