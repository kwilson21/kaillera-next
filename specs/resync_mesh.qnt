// -*- mode: Bluespec; -*-
//
// Inputs around a resync, from a third page's side, and across matches.
// The companion of specs/resync_inputs.qnt, which has the host and the guest
// the resync moves. Two things that spec's two pages cannot show (both were
// review findings on the first version of the fix):
//
//   1. In a match of three or four, every page waits on the moved guest's
//      inputs, not only the host that sent the state. A page that is not told
//      where those inputs start again finds the hole the skipped frames left
//      and waits on it for the 5 s deadline.
//   2. The settled point is a frame number. A new match in the same session
//      starts again at frame 0, and a settled point kept from the last match
//      hides real gaps until the new match passes it.
//
// What is modelled: the moved guest ("mover") and one other page that holds
// its inputs ("bystander"); the mover's inputs and the `inputs-settled`
// message on the wire, delivered in any order; a resync that moves the mover
// forward; a new match.
//
// Not modelled: the host, the bystander's own inputs, giving up (the 5 s
// deadline), the range check.
//
// TELL_PEERS: the mover tells every peer where its inputs start again
//   (`inputs-settled`). false = only the host knew.
// CLEAR_ON_NEW_MATCH: a new match clears the settled point with the inputs.
module resync_mesh {
  const TELL_PEERS: bool
  const CLEAR_ON_NEW_MATCH: bool

  pure val DELAY = 1
  pure val CAP = 2
  pure val LAST_FRAME = 8

  type Packet = Input(int) | Settled(int)

  var moverFrame: int      // the mover's next frame
  var made: Set[int]       // keys of the inputs the mover has made
  var frame: int           // the bystander's next frame
  var got: Set[int]        // the mover's inputs the bystander holds
  var floor: int           // the bystander's settled point for the mover
  var wire: Set[Packet]    // on their way to the bystander

  pure def newest(s: Set[int]): int = s.fold(-1, (a, k) => if (k > a) k else a)

  def edge: int = frame - DELAY - CAP

  def waitsOnGap: bool = and {
    edge >= 0,
    edge >= floor,
    edge < newest(got),
    not(got.contains(edge)),
  }

  def waitsBehind: bool = and {
    frame - DELAY >= 0,
    not(got.contains(frame - DELAY)),
    frame - newest(got) >= DELAY + CAP + 1,
  }

  // ── actions ────────────────────────────────────────────────────────────

  action init = all {
    moverFrame' = 0, made' = Set(), frame' = 0, got' = Set(), floor' = 0, wire' = Set(),
  }

  action moverTick = all {
    moverFrame < LAST_FRAME,
    moverFrame' = moverFrame + 1,
    made' = made.union(Set(moverFrame)),
    wire' = wire.union(Set(Input(moverFrame))),
    frame' = frame, got' = got, floor' = floor,
  }

  action bystanderTick = all {
    not(waitsOnGap or waitsBehind),
    frame < LAST_FRAME,
    frame' = frame + 1,
    moverFrame' = moverFrame, made' = made, got' = got, floor' = floor, wire' = wire,
  }

  action deliver(m: Packet): bool = all {
    wire.contains(m),
    wire' = wire.exclude(Set(m)),
    match m {
      | Input(k) => all { got' = got.union(Set(k)), floor' = floor }
      | Settled(k) => all { got' = got, floor' = if (k > floor) k else floor }
    },
    moverFrame' = moverFrame, made' = made, frame' = frame,
  }

  action drain = all {
    wire != Set(),
    got' = got.union(0.to(LAST_FRAME).filter(k => wire.contains(Input(k)))),
    floor' = 0.to(LAST_FRAME).filter(k => wire.contains(Settled(k))).fold(floor, (a, k) => if (k > a) k else a),
    wire' = Set(),
    moverFrame' = moverFrame, made' = made, frame' = frame,
  }

  // A resync moves the mover forward to frame f. It makes and sends the
  // inputs from f - DELAY up to f that it skipped.
  action resyncForward(f: int): bool = {
    val settled = if (f - DELAY > 0) f - DELAY else 0
    val skipped = 0.to(LAST_FRAME).filter(k => k >= settled and k < f and not(made.contains(k)))
    all {
      f > moverFrame,
      f <= LAST_FRAME,
      moverFrame' = f,
      made' = made.union(skipped),
      wire' = wire
        .union(skipped.map(k => Input(k)))
        .union(if (TELL_PEERS) Set(Settled(settled)) else Set()),
      frame' = frame, got' = got, floor' = floor,
    }
  }

  // The match ends and another starts in the same session: frames and
  // inputs start again from 0. What was on the wire belonged to the old match.
  action newMatch = all {
    moverFrame' = 0, made' = Set(), frame' = 0, got' = Set(), wire' = Set(),
    floor' = if (CLEAR_ON_NEW_MATCH) 0 else floor,
  }

  action step = any {
    moverTick,
    bystanderTick,
    nondet m = oneOf(wire)
    deliver(m),
    nondet f = 1.to(LAST_FRAME).oneOf()
    resyncForward(f),
    newMatch,
  }

  // ── properties ─────────────────────────────────────────────────────────

  // A page waiting on a gap in the mover's inputs can still get the input,
  // or is about to be told the gap is settled.
  // Violated when only the host is told (TELL_PEERS = false).
  val noWaitForAnInputThatCannotArrive =
    waitsOnGap implies or {
      wire.contains(Input(edge)),
      edge >= moverFrame,
      wire.exists(m => match m { | Settled(k) => k > edge | Input(_) => false }),
    }

  // The settled point never runs ahead of the mover: an input the mover has
  // yet to make is always one a page would wait for.
  // Violated when a new match keeps the last one's (CLEAR_ON_NEW_MATCH = false).
  val settledPointIsNotAhead = floor <= moverFrame

  val allHold = noWaitForAnInputThatCannotArrive and settledPointIsNotAhead

  // ── scenarios ──────────────────────────────────────────────────────────

  // The mover freezes at frame 1 and is moved to frame 6. The bystander has
  // run on to frame 4 meanwhile. It gets inputs 5 and 6, and looks for 1.
  run bystanderFindsTheHoleTest =
    init
      .then(moverTick)
      .then(drain)
      .then(4.reps(_ => bystanderTick))
      .then(resyncForward(6))
      .then(moverTick)
      .then(drain)
      .expect(waitsOnGap == not(TELL_PEERS))

  // A resync in one match, then a new match: an input the mover has not
  // made yet must not already count as settled.
  run newMatchStartsCleanTest =
    init
      .then(moverTick)
      .then(drain)
      .then(resyncForward(6))
      .then(drain)
      .then(newMatch)
      .expect(settledPointIsNotAhead == (CLEAR_ON_NEW_MATCH or not(TELL_PEERS)))
}

// The fix as first written: only the host knew the settled point.
module resync_mesh_untold {
  import resync_mesh(TELL_PEERS = false, CLEAR_ON_NEW_MATCH = true).*
}

// The fix as first written: a new match kept the settled point.
module resync_mesh_kept {
  import resync_mesh(TELL_PEERS = true, CLEAR_ON_NEW_MATCH = false).*
}

// Today.
module resync_mesh_current {
  import resync_mesh(TELL_PEERS = true, CLEAR_ON_NEW_MATCH = true).*
}
