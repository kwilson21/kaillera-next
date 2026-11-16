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
// REFEED_OWN_AT_RESYNC: at a resync the guest hands its engine every input of
//   its own from F - DELAY up to F again. false = as first written: only the
//   ones it had never made. The engine keeps a page's inputs in a ring (256
//   frames; RING here). A guest that ran further ahead than that before it
//   was taken back has written over the slot of an input it made earlier.
//   Moved forward again over that frame, it sent the input to the host and
//   applied nothing for it itself (review finding on the resend, 2026-11;
//   the likely cause of a desync an earlier attempt at the resend saw in 2
//   of 8 freeze runs).
//
// KEEP_OWN_INPUT_WHEN_ALONE: a page that has given up on the other keeps its
//   own input for every frame it runs alone. false = before: it had run out
//   of prediction room when it gave up, the engine's pacing gate stayed shut,
//   and each frame was run past the gate without the page's own input being
//   stored. The page applied nothing for itself on those frames while it
//   sent the other page its real input. A resync hides that for the frames
//   before it, but the inputs from F - DELAY on are applied after it: the
//   two pages then differ for good (found in a two-player run, 2026-11).
//
// ASK_FOR_MISSING: a page waiting for an input the other page has made asks
//   for it (`resend:<frame>`), and the other sends it again. false = before:
//   nothing asked. The ordering that needed it (a two-player run, 2026-11):
//   the guest freezes, the host gives up on it and runs on alone, and the
//   host's inputs reach the guest while it is far behind, so it drops them
//   as out of range. The guest comes back; the host hears it again, stops
//   running alone, schedules the resync that ends the split and waits for
//   the guest's inputs, because a resync may only carry a state built on
//   real inputs. The guest catches up to the inputs it dropped and waits on
//   that hole. Each page now waits for the other and nothing is on its way:
//   the host's resync waits for inputs the guest cannot make until the hole
//   is filled. Only the resync's deadline (3 s) ends it, and if that runs
//   late the guest gives up on the host (5 s) and the pages split again.
module resync_inputs {
  const SETTLE_AT_RESYNC: bool
  const KEEP_OWN_INPUT_WHEN_ALONE: bool
  const RESEND_OWN_AT_RESYNC: bool
  const REFEED_OWN_AT_RESYNC: bool
  const ASK_FOR_MISSING: bool

  pure val DELAY = 1
  pure val CAP = 2
  // How far past its own frame a page accepts an input (the range check).
  // Wide enough that a page that has not been given up on never trips it.
  pure val MARGIN = 2
  pure val LAST_FRAME = 12
  // How many of its own inputs a page's engine holds: making the input for
  // frame f writes over the one for f - RING. Wide enough to hold every
  // input a page can still apply or roll back to (DELAY + CAP + 1).
  pure val RING = 4

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
    newestAtGiveUp: int, // the newest of the other's inputs it held when it gave up
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

  // The input a waiting page waits for.
  pure def missing(pg: Page): int = if (waitsOnGap(pg)) edge(pg) else pg.frame - DELAY

  // ── actions ────────────────────────────────────────────────────────────

  action init = all {
    pages' = PAGES.mapBy(p => {
      frame: 0, made: Set(), kept: Set(), capped: false, got: Set(), floor: 0, alone: false,
      newestAtGiveUp: -1,
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
        kept: if (pg.alone and pg.capped and not(KEEP_OWN_INPUT_WHEN_ALONE)) pg.kept
          else pg.kept.union(Set(pg.frame)).exclude(Set(pg.frame - RING)),
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
      pages' = pages.set(p, { ...pg, alone: true, capped: waits(pg), newestAtGiveUp: newest(pg.got) }),
      wire' = wire,
      resyncDue' = true,
    }
  }

  // A page that gave up hears the other again (a newer input arrives,
  // PEER-RECOVERED): it stops running alone. The resync that ends the split
  // is still due; it goes once the host's state is built on real inputs
  // (`confirmed`) or at its deadline.
  action hearAgain(p: str): bool = {
    val pg = pages.get(p)
    all {
      pg.alone,
      newest(pg.got) > pg.newestAtGiveUp,
      pages' = pages.set(p, { ...pg, alone: false, capped: false }),
      wire' = wire,
      resyncDue' = resyncDue,
    }
  }

  // A waiting page asks the other for the input it waits for, which the
  // other has made and will send again.
  action ask(p: str): bool = {
    val pg = pages.get(p)
    val key = missing(pg)
    all {
      ASK_FOR_MISSING,
      waits(pg),
      pages.get(other(p)).made.contains(key),
      not(wire.contains({ dest: p, key: key })),
      wire' = wire.union(Set({ dest: p, key: key })),
      pages' = pages,
      resyncDue' = resyncDue,
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
          made: g.made.union(skipped),
          kept: g.kept.union(if (REFEED_OWN_AT_RESYNC) keysFrom(settled, f) else skipped),
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
    any { tick(p), giveUp(p), hearAgain(p), ask(p) },
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
  // that it can still apply or roll back to (not settled, keyed within
  // DELAY + CAP of its frame, and before the frame it will make next) is in
  // its engine.
  // Violated while a page that ran alone did not keep its own inputs, and
  // while a resync did not hand the engine the inputs the guest already had.
  //
  // Inputs keyed at or past the page's frame are left out: the page stores
  // one in its engine when it runs that frame. For a guest taken BACK that
  // covers inputs it has already made and sent. This model has keys, not
  // values, so it cannot show which value the guest then applies. The engine
  // uses the one it made the first time and sends it again on every tick of
  // that frame (the tick loop's `hadLocalInputForFrame`, in
  // web/static/netplay-rollback.js): it does not read the controller again,
  // so the host, which may hold the first copy, is never sent a different
  // value for the same key. A source test holds that
  // (test_a_guest_taken_back_reuses_the_inputs_it_already_sent).
  val aPageAppliesWhatItSent =
    resyncDue or PAGES.forall(p => {
      val pg = pages.get(p)
      pg.made.forall(k =>
        (k >= pg.floor and k >= pg.frame - DELAY - CAP and k < pg.frame) implies pg.kept.contains(k)
      )
    })

  // The host's state is built on real inputs: it holds every input of the
  // guest's it has applied since the last resync. Only then may it send its
  // state without waiting for the resync's deadline.
  pure def confirmed(h: Page): bool = keysFrom(h.floor, h.frame - DELAY).forall(k => h.got.contains(k))

  // The input is on its way to the page, or the page can ask for it.
  def onItsWay(p: str, key: int): bool =
    wire.contains({ dest: p, key: key }) or (ASK_FOR_MISSING and pages.get(other(p)).made.contains(key))

  // A due resync is never left to its deadline: when both pages wait, the
  // host may send its state now, or an input one of them waits for is on
  // its way.
  // Violated before ASK_FOR_MISSING: the guest waits on inputs it dropped
  // as out of range, and the host waits on inputs the guest cannot make
  // until it has them.
  val aDueResyncIsNotLeftToItsDeadline =
    not(resyncDue)
      or PAGES.exists(p => not(waits(pages.get(p))))
      or confirmed(pages.get("host"))
      or PAGES.exists(p => onItsWay(p, missing(pages.get(p))))

  val allHold = and {
    noWaitForAnInputThatCannotArrive,
    neverBothWaitingOnNothing,
    aPageAppliesWhatItSent,
    aDueResyncIsNotLeftToItsDeadline,
  }

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
  // The ring. The guest runs alone until its engine has written over its
  // input 2, is taken back to the host, and is then moved forward to frame
  // 3: input 2 is still to be applied, the guest made it long ago, and its
  // engine no longer holds it.
  run guestMovedOverAnInputItsEngineWroteOverTest =
    init
      .then(3.reps(_ => tick("guest")))
      .then(giveUp("guest"))
      .then(4.reps(_ => tick("guest")))
      // (A page that keeps nothing while alone has not written over it either.)
      .expect(KEEP_OWN_INPUT_WHEN_ALONE implies not(pages.get("guest").kept.contains(2)))
      .then(drain)
      .then(resync)
      .expect(pages.get("guest").frame == 0)
      .then(3.reps(_ => tick("host")))
      .then(giveUp("host"))
      .then(resync)
      .expect(pages.get("guest").frame == 3)
      .expect(
        (SETTLE_AT_RESYNC and KEEP_OWN_INPUT_WHEN_ALONE) implies (aPageAppliesWhatItSent == REFEED_OWN_AT_RESYNC)
      )

  // The run that found ASK_FOR_MISSING (2026-11). The guest freezes; the
  // host gives up on it and runs on alone; the host's inputs reach the guest
  // while it is far behind and are dropped. The guest comes back, the host
  // hears it again and waits for its inputs, the guest catches up to the
  // inputs it dropped.
  run guestWaitsOnInputsItDroppedTest =
    init
      .then(3.reps(_ => tick("host")))
      .then(giveUp("host"))
      .then(6.reps(_ => tick("host")))
      .then(drain)
      // The guest, still at frame 0, kept inputs 0..3 and dropped 4..8.
      .expect(pages.get("guest").got == Set(0, 1, 2, 3))
      .then(3.reps(_ => tick("guest")))
      .then(drain)
      .then(hearAgain("host"))
      // The host, at frame 9, waits for the guest's inputs.
      .expect(waits(pages.get("host")) and resyncDue)
      .then(4.reps(_ => tick("guest")))
      .then(drain)
      .then(tick("host"))
      .then(drain)
      // The guest, at frame 7, waits on input 4, which it dropped; the host,
      // at frame 10, waits on the guest's input 9, which the guest cannot
      // make before it has input 4. The host's state is not confirmed, so
      // its resync waits for its deadline.
      .expect(waitsOnGap(pages.get("guest")) and missing(pages.get("guest")) == 4)
      .expect(waits(pages.get("host")) and not(confirmed(pages.get("host"))))
      .expect(aDueResyncIsNotLeftToItsDeadline == ASK_FOR_MISSING)
      // Fixed: the guest asks for input 4, gets it and runs on.
      // Before: nothing comes, and the guest gives up on the host.
      .then(if (ASK_FOR_MISSING) ask("guest") else giveUp("guest"))
      .then(if (ASK_FOR_MISSING) drain else tick("guest"))
      .expect(pages.get("guest").alone == not(ASK_FOR_MISSING))
      .expect(ASK_FOR_MISSING implies not(waits(pages.get("guest"))))

  // With asking, the pages get from there to a resync the host can send
  // without its deadline: the guest fills its hole input by input, catches
  // up and its inputs confirm the host's state.
  run theGuestAsksItsWayToAConfirmedResyncTest =
    if (not(ASK_FOR_MISSING)) init else init
      .then(3.reps(_ => tick("host")))
      .then(giveUp("host"))
      .then(6.reps(_ => tick("host")))
      .then(drain)
      .then(3.reps(_ => tick("guest")))
      .then(drain)
      .then(hearAgain("host"))
      .then(4.reps(_ => tick("guest")))
      .then(drain)
      .then(tick("host"))
      .then(drain)
      // Each dropped input (4..8) is asked for as the guest reaches it.
      .then(5.reps(_ => ask("guest").then(drain).then(tick("guest"))))
      .then(drain)
      .expect(confirmed(pages.get("host")) and not(waits(pages.get("host"))))
}

// Before: a resync changed the guest's frame counter and nothing else.
module resync_inputs_before {
  import resync_inputs(
    SETTLE_AT_RESYNC = false, KEEP_OWN_INPUT_WHEN_ALONE = false,
    RESEND_OWN_AT_RESYNC = false, REFEED_OWN_AT_RESYNC = false, ASK_FOR_MISSING = false
  ).*
}

// With the inputs before the resync frame settled, but a page that ran alone
// still not keeping its own inputs.
module resync_inputs_solo_holes {
  import resync_inputs(
    SETTLE_AT_RESYNC = true, KEEP_OWN_INPUT_WHEN_ALONE = false,
    RESEND_OWN_AT_RESYNC = true, REFEED_OWN_AT_RESYNC = true, ASK_FOR_MISSING = false
  ).*
}

// The settle as first written: the guest sent only the inputs it had never made.
module resync_inputs_only_new {
  import resync_inputs(
    SETTLE_AT_RESYNC = true, KEEP_OWN_INPUT_WHEN_ALONE = true,
    RESEND_OWN_AT_RESYNC = false, REFEED_OWN_AT_RESYNC = true, ASK_FOR_MISSING = false
  ).*
}

// The resend without the refeed: the guest sent the host an input its own
// engine no longer held.
module resync_inputs_no_refeed {
  import resync_inputs(
    SETTLE_AT_RESYNC = true, KEEP_OWN_INPUT_WHEN_ALONE = true,
    RESEND_OWN_AT_RESYNC = true, REFEED_OWN_AT_RESYNC = false, ASK_FOR_MISSING = false
  ).*
}

// Every fix at a resync, but a waiting page did not ask for an input it
// had dropped.
module resync_inputs_no_ask {
  import resync_inputs(
    SETTLE_AT_RESYNC = true, KEEP_OWN_INPUT_WHEN_ALONE = true,
    RESEND_OWN_AT_RESYNC = true, REFEED_OWN_AT_RESYNC = true, ASK_FOR_MISSING = false
  ).*
}

// Today.
module resync_inputs_current {
  import resync_inputs(
    SETTLE_AT_RESYNC = true, KEEP_OWN_INPUT_WHEN_ALONE = true,
    RESEND_OWN_AT_RESYNC = true, REFEED_OWN_AT_RESYNC = true, ASK_FOR_MISSING = true
  ).*
}
