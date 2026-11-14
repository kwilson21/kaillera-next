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
// specs/resync_mesh.qnt), packet loss on the unreliable input channel, the
// contents of inputs and the rollbacks that follow a wrong prediction. (A
// settled input is not handed to the engine at all, so a returning peer's
// backlog is never judged against what was predicted for it.)
//
// SETTLE_AT_RESYNC: a resync at frame F settles every input keyed before
//   F - DELAY (they are already in the state both pages now hold, so neither
//   waits for one); the guest makes and sends its inputs for the frames it
//   skipped from F - DELAY on, and the host sends its own for that range
//   again. false = before.
//
// RESEND_OWN_AT_RESYNC: at a resync the guest sends every input of its own
//   from F - DELAY up to F, the ones it had already made included. false =
//   as first written: only the ones it had never made. An input it made in
//   an earlier stretch (it ran ahead, was taken back, and is now moved
//   forward again) may have been dropped by the host as out of range, and
//   nothing sent it again (found by the sampler in CI, 2026-11).
//
// KEEP_OWN_INPUT_WHEN_ALONE: a page that has given up on the other keeps its
//   own input for every frame it runs alone. false = before: it had run out
//   of prediction room when it gave up, the engine's pacing gate stayed shut,
//   and each frame was run past the gate without the page's own input being
//   stored. The page applied nothing for itself on those frames while it
//   sent the other page its real input. A resync hides that for the frames
//   before it, but the inputs from F - DELAY on are applied after it: the
//   two pages then differ for good (found in a two-player run, 2026-11).
module resync_inputs {
  const SETTLE_AT_RESYNC: bool
  const KEEP_OWN_INPUT_WHEN_ALONE: bool
  const RESEND_OWN_AT_RESYNC: bool

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
    made: Set[int],  // keys of the inputs this page has made (and sent)
    kept: Set[int],  // keys of its own inputs its engine holds, to apply them
    capped: bool,    // was out of prediction room when it gave up on the other
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
    pages' = PAGES.mapBy(p => {
      frame: 0, made: Set(), kept: Set(), capped: false, got: Set(), floor: 0, alone: false,
    }),
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
      pages' = pages.set(p, {
        ...pg,
        frame: pg.frame + 1,
        made: pg.made.union(Set(pg.frame)),
        kept: if (pg.alone and pg.capped and not(KEEP_OWN_INPUT_WHEN_ALONE)) pg.kept else pg.kept.union(Set(pg.frame)),
      }),
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
      pages' = pages.set(p, { ...pg, alone: true, capped: waits(pg) }),
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
        "host" -> { ...h, floor: settled, alone: false, capped: false },
        "guest" -> {
          ...g, frame: f, floor: settled, alone: false, capped: false,
          made: g.made.union(skipped), kept: g.kept.union(skipped),
        },
      ) else Map(
        "host" -> { ...h, alone: false, capped: false },
        "guest" -> { ...g, frame: f, alone: false, capped: false },
      ),
      wire' = if (SETTLE_AT_RESYNC)
        wire
          .union((if (RESEND_OWN_AT_RESYNC) keysFrom(settled, f) else skipped).map(k => { dest: "host", key: k }))
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

  // A page applies for itself what it sent the other: every input of its own
  // that is still to be applied after the last resync is in its engine.
  // Violated while a page that ran alone did not keep its own inputs.
  val aPageAppliesWhatItSent =
    resyncDue or PAGES.forall(p => {
      val pg = pages.get(p)
      pg.made.forall(k => k >= pg.floor implies pg.kept.contains(k))
    })

  val allHold = and { noWaitForAnInputThatCannotArrive, neverBothWaitingOnNothing, aPageAppliesWhatItSent }

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

  // The host ran alone past its prediction limit, then the pages resync. Its
  // input for the frame just before the resync is applied after it.
  run hostRanAloneThenResyncsTest =
    init
      .then(3.reps(_ => tick("host")))
      .then(giveUp("host"))
      .expect(pages.get("host").capped)
      .then(4.reps(_ => tick("host")))
      .then(drain)
      .then(resync)
      .expect(SETTLE_AT_RESYNC implies (aPageAppliesWhatItSent == KEEP_OWN_INPUT_WHEN_ALONE))

  // The order that always worked: the guest is ahead and is taken back. It
  // made and sent every input up to where it was, so nothing is missing.
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
      .expect(noWaitForAnInputThatCannotArrive and neverBothWaitingOnNothing)
      .then(tick("host"))
      .then(drain)
      .expect(noWaitForAnInputThatCannotArrive and neverBothWaitingOnNothing)
  // The guest runs ahead alone, far enough for the host to drop its newest
  // inputs as out of range. It is taken back to the host, stands still while
  // the host runs on, and is then moved forward again, over frames whose
  // inputs it made the first time round. The host never got one of those.
  run guestMovedOverInputsItMadeBeforeTest =
    init
      .then(3.reps(_ => tick("guest")))
      .then(giveUp("guest"))
      .then(3.reps(_ => tick("guest")))
      .then(drain)
      // The host, still at frame 0, kept the guest's inputs 0..3 and dropped 4 and 5.
      .expect(pages.get("host").got == Set(0, 1, 2, 3))
      .then(resync)
      .expect(pages.get("guest").frame == 0)
      .then(6.reps(_ => tick("host")))
      .then(drain)
      .then(giveUp("host"))
      .then(resync)
      .expect(pages.get("guest").frame == 6)
      // (Before any settling the resync sent nothing, and the guest plays on alone.)
      .then(if (SETTLE_AT_RESYNC) drain else giveUp("guest"))
      .expect(pages.get("host").got.contains(5) == (SETTLE_AT_RESYNC and RESEND_OWN_AT_RESYNC))
      .then(tick("guest"))
      .then(tick("host"))
      .then(drain)
      // (Before any settling the host is already waiting here, on input 4.)
      .then(if (SETTLE_AT_RESYNC) tick("host") else giveUp("host"))
      // The host is at frame 8 and the guest's input 5 is the oldest it may
      // still roll back to.
      .expect(SETTLE_AT_RESYNC implies (waitsOnGap(pages.get("host")) == not(RESEND_OWN_AT_RESYNC)))
      .expect(SETTLE_AT_RESYNC implies (noWaitForAnInputThatCannotArrive == RESEND_OWN_AT_RESYNC))
}

// Before: a resync changed the guest's frame counter and nothing else.
module resync_inputs_before {
  import resync_inputs(
    SETTLE_AT_RESYNC = false, KEEP_OWN_INPUT_WHEN_ALONE = false, RESEND_OWN_AT_RESYNC = false
  ).*
}

// With the inputs before the resync frame settled, but a page that ran alone
// still not keeping its own inputs.
module resync_inputs_solo_holes {
  import resync_inputs(
    SETTLE_AT_RESYNC = true, KEEP_OWN_INPUT_WHEN_ALONE = false, RESEND_OWN_AT_RESYNC = true
  ).*
}

// The settle as first written: the guest sent only the inputs it had never made.
module resync_inputs_only_new {
  import resync_inputs(
    SETTLE_AT_RESYNC = true, KEEP_OWN_INPUT_WHEN_ALONE = true, RESEND_OWN_AT_RESYNC = false
  ).*
}

// Today.
module resync_inputs_current {
  import resync_inputs(
    SETTLE_AT_RESYNC = true, KEEP_OWN_INPUT_WHEN_ALONE = true, RESEND_OWN_AT_RESYNC = true
  ).*
}
