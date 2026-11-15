// The rollback engine's ring of saved states across a resync that moves the
// page's frame counter back (build/kn_rollback/kn_rollback.c: kn_pre_tick's
// save, kn_set_frame).
//
// kn_pre_tick saves the live state of the frame about to run into the ring,
// once per frame: only `if (rb.last_save_frame != rb.frame)`. A resync loads
// the host's state for its target frame and moves the counter there
// (kn_set_frame). The page may have run past the target while the state
// arrived. If it ran exactly one frame past, its last save is the target
// itself, so the next kn_pre_tick counts the target as saved and the ring
// keeps the page's own copy of that frame, not the host's state the page now
// runs from. A rollback to that frame restores the old copy, and a two-player
// run's hash compare (which reads the ring) sees one frame differ and every
// later frame match. Found that way: a lockstep run with an 8 s guest freeze,
// frame 1021 after a resync from 1022 (#232).
//
// Not modelled: what the state is beyond whose timeline and which frame,
// rollbacks themselves (a restore reads the ring copy checked here), more
// than one resync, the ring's size.
//
// FORGET_SAVE_ON_SET_FRAME: kn_set_frame forgets the last save, so the
// frame it moves to is saved again before it runs. false = before.
module ring_after_resync {
  const FORGET_SAVE_ON_SET_FRAME: bool

  pure val MAX_FRAME = 6
  pure val NONE = -1

  // A state: whose timeline it is on, and the frame it is the start of.
  type State = { origin: str, frame: int }

  var frame: int // rb.frame: the frame about to run
  var lastSave: int // rb.last_save_frame
  var ring: int -> State // the ring copy of each saved frame
  var live: State // the emulator's state now
  var target: int // the frame the resync moved the page to; NONE before it

  action init = all {
    frame' = 0,
    lastSave' = NONE,
    ring' = Map(),
    live' = { origin: "own", frame: 0 },
    target' = NONE,
  }

  // One tick: kn_pre_tick saves the frame unless it counts it as saved, the
  // core runs it, kn_post_tick moves the counter on.
  action tick = {
    val saves = lastSave != frame
    all {
      frame < MAX_FRAME,
      ring' = if (saves) ring.put(frame, live) else ring,
      lastSave' = if (saves) frame else lastSave,
      live' = { origin: live.origin, frame: live.frame + 1 },
      frame' = frame + 1,
      target' = target,
    }
  }

  // The host's state for frame `at` is loaded and the counter moved there
  // (kn_set_frame). The page is at `at` or past it: a state for a frame
  // ahead is held until the page reaches it.
  action resync(at: int): bool = all {
    target == NONE,
    0 <= at,
    at <= frame,
    live' = { origin: "host", frame: at },
    frame' = at,
    lastSave' = if (FORGET_SAVE_ON_SET_FRAME) NONE else lastSave,
    ring' = ring,
    target' = at,
  }

  action step = any {
    tick,
    nondet at = 0.to(MAX_FRAME).oneOf()
    resync(at),
  }

  // Every frame the page has run again since the resync has the host's
  // state in the ring: a rollback to it restores the timeline the page is
  // on. Violated before kn_set_frame forgot the last save.
  val everyRerunFrameIsTheHosts =
    target == NONE or ring.keys().forall(f => (target <= f and f < frame) implies ring.get(f).origin == "host")

  // A ring copy is always of the frame it is filed under.
  val eachCopyIsItsFrame = ring.keys().forall(f => ring.get(f).frame == f)

  val allHold = everyRerunFrameIsTheHosts and eachCopyIsItsFrame

  // The ordering the run found: the page runs frames 0 and 1 (it saved 1 last),
  // the resync for frame 1 lands, and the page runs frame 1 again.
  run oneFrameBackTest =
    init
      .then(tick)
      .then(tick)
      .then(resync(1))
      .then(tick)
      .expect(everyRerunFrameIsTheHosts == FORGET_SAVE_ON_SET_FRAME)
      .expect(eachCopyIsItsFrame)

  // Two frames back: the page's last save (frame 2) is not the target, so
  // frame 1 is saved again either way.
  run twoFramesBackTest =
    init
      .then(tick)
      .then(tick)
      .then(tick)
      .then(resync(1))
      .then(tick)
      .then(tick)
      .expect(allHold)

  // The state lands on the frame the page is about to run (held until then):
  // nothing to save again.
  run onTheFrameTest =
    init
      .then(tick)
      .then(tick)
      .then(resync(2))
      .then(tick)
      .expect(allHold)
}

// Before: kn_set_frame kept the last save.
module ring_after_resync_before {
  import ring_after_resync(FORGET_SAVE_ON_SET_FRAME = false).*
}

// Today: kn_set_frame forgets it.
module ring_after_resync_current {
  import ring_after_resync(FORGET_SAVE_ON_SET_FRAME = true).*
}
