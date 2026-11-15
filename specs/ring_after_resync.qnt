// The rollback engine's ring of saved states across a resync that loads the
// host's state (build/kn_rollback/kn_rollback.c: kn_pre_tick's save,
// kn_set_frame; web/static/netplay-rollback.js: applySyncState).
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
// The same happens with no rewind at all when kn_pre_tick has saved a frame
// that then did not run (a pacing hold that keeps the ring, or a step that
// emulated nothing) and the resync is for that frame: the page loaded the
// state without calling kn_set_frame, since the frame was unchanged.
//
// The sparse save mode (knDiag.setDeltaSaveSparse) writes only the blocks
// that differ from a baseline, the last state saved, and a restore takes
// every other block from the copies filed before it. That is right only
// while the baseline is the copy filed before the frame being saved. A
// resync that lands behind the last save breaks it, unless kn_set_frame
// forgets the baseline so that the next save is whole (as the worker's
// state apply, kn_apply_split_state_partial_with_aux, already does).
//
// Not modelled: what the state is beyond whose timeline and which frame,
// rollbacks themselves (a restore reads the ring copy checked here), more
// than one resync, the ring's size, how often the sparse mode saves whole
// (here: only when it has no baseline, the case that matters).
//
// FORGET_SAVE_ON_SET_FRAME: kn_set_frame forgets the last save.
// FORGET_BASELINE_ON_SET_FRAME: kn_set_frame forgets the sparse baseline.
// SET_FRAME_ON_EVERY_LOAD: the page calls kn_set_frame on every state it
// loads, not only when the frame changes.
module ring_after_resync {
  const FORGET_SAVE_ON_SET_FRAME: bool
  const FORGET_BASELINE_ON_SET_FRAME: bool
  const SET_FRAME_ON_EVERY_LOAD: bool

  pure val MAX_FRAME = 6
  pure val NONE = -1

  // A state: whose timeline it is on, and the frame it is the start of.
  type State = { origin: str, frame: int }
  pure val NO_STATE: State = { origin: "none", frame: NONE }

  // A ring copy, and whether a restore can rebuild all of it: it was saved
  // whole, or against a baseline that is the copy filed before it.
  type Copy = { state: State, whole: bool }

  var frame: int // rb.frame: the frame about to run
  var lastSave: int // rb.last_save_frame
  var baseline: State // the sparse mode's baseline; NO_STATE when forgotten
  var ring: int -> Copy // the ring copy of each saved frame
  var live: State // the emulator's state now
  var target: int // the frame the resync moved the page to; NONE before it

  action init = all {
    frame' = 0,
    lastSave' = NONE,
    baseline' = NO_STATE,
    ring' = Map(),
    live' = { origin: "own", frame: 0 },
    target' = NONE,
  }

  // The copy of the previous frame, the one a sparse save's other blocks are
  // taken from.
  def copyBefore(f: int): State =
    if (ring.keys().contains(f - 1)) ring.get(f - 1).state else NO_STATE

  // kn_pre_tick's save of the live state for the frame about to run.
  def savedCopy: Copy = { state: live, whole: baseline == NO_STATE or baseline == copyBefore(frame) }

  // One tick: kn_pre_tick saves the frame unless it counts it as saved, the
  // core runs it, kn_post_tick moves the counter on.
  action tick = {
    val saves = lastSave != frame
    all {
      frame < MAX_FRAME,
      ring' = if (saves) ring.put(frame, savedCopy) else ring,
      lastSave' = if (saves) frame else lastSave,
      baseline' = if (saves) live else baseline,
      live' = { origin: live.origin, frame: live.frame + 1 },
      frame' = frame + 1,
      target' = target,
    }
  }

  // kn_pre_tick saves the frame, and the frame does not run: a pacing hold
  // that keeps the ring, or a step that emulated nothing. The next tick runs
  // it.
  action saveOnly = all {
    lastSave != frame,
    ring' = ring.put(frame, savedCopy),
    lastSave' = frame,
    baseline' = live,
    live' = live,
    frame' = frame,
    target' = target,
  }

  // The host's state for frame `at` is loaded, and the counter moved there
  // (kn_set_frame) when the page calls it. The page is at `at` or past it: a
  // state for a frame ahead is held until the page reaches it.
  action resync(at: int): bool = {
    val setsFrame = SET_FRAME_ON_EVERY_LOAD or at != frame
    all {
      target == NONE,
      0 <= at,
      at <= frame,
      live' = { origin: "host", frame: at },
      frame' = at,
      lastSave' = if (setsFrame and FORGET_SAVE_ON_SET_FRAME) NONE else lastSave,
      baseline' = if (setsFrame and FORGET_BASELINE_ON_SET_FRAME) NO_STATE else baseline,
      ring' = ring,
      target' = at,
    }
  }

  action step = any {
    tick,
    saveOnly,
    nondet at = 0.to(MAX_FRAME).oneOf()
    resync(at),
  }

  // Every frame the page has run again since the resync has the host's
  // state in the ring: a rollback to it restores the timeline the page is
  // on. Violated before kn_set_frame forgot the last save, and while the
  // page skipped kn_set_frame for a state of the frame it was on.
  val everyRerunFrameIsTheHosts =
    target == NONE or ring.keys().forall(f => (target <= f and f < frame) implies ring.get(f).state.origin == "host")

  // A ring copy is always of the frame it is filed under.
  val eachCopyIsItsFrame = ring.keys().forall(f => ring.get(f).state.frame == f)

  // A restore can rebuild every copy in the sparse save mode. Violated
  // before kn_set_frame forgot the baseline.
  val everyCopyIsWhole = ring.keys().forall(f => ring.get(f).whole)

  val allHold = everyRerunFrameIsTheHosts and eachCopyIsItsFrame and everyCopyIsWhole

  // The ordering the run found: the page runs frames 0 and 1 (it saved 1 last),
  // the resync for frame 1 lands, and the page runs frame 1 again. Saved
  // again against the page's own copy of frame 1 as the baseline, the new
  // copy cannot be rebuilt unless the baseline is forgotten too (before, it
  // was not saved again at all).
  run oneFrameBackTest =
    init
      .then(tick)
      .then(tick)
      .then(resync(1))
      .then(tick)
      .expect(everyRerunFrameIsTheHosts == FORGET_SAVE_ON_SET_FRAME)
      .expect(everyCopyIsWhole == (FORGET_BASELINE_ON_SET_FRAME or not(FORGET_SAVE_ON_SET_FRAME)))
      .expect(eachCopyIsItsFrame)

  // Two frames back: the page's last save (frame 2) is not the target, so
  // frame 1 is saved again either way; in the sparse mode it is saved
  // against frame 2's state.
  run twoFramesBackTest =
    init
      .then(tick)
      .then(tick)
      .then(tick)
      .then(resync(1))
      .then(tick)
      .then(tick)
      .expect(everyRerunFrameIsTheHosts)
      .expect(everyCopyIsWhole == FORGET_BASELINE_ON_SET_FRAME)
      .expect(eachCopyIsItsFrame)

  // The state lands on the frame the page is about to run (held until then),
  // before kn_pre_tick saved it: nothing to save again.
  run onTheFrameTest =
    init
      .then(tick)
      .then(tick)
      .then(resync(2))
      .then(tick)
      .expect(allHold)

  // kn_pre_tick saved frame 1 and frame 1 did not run; the resync for frame 1
  // lands with the counter unchanged.
  run savedFrameDidNotRunTest =
    init
      .then(tick)
      .then(saveOnly)
      .then(resync(1))
      .then(tick)
      .expect(everyRerunFrameIsTheHosts == (FORGET_SAVE_ON_SET_FRAME and SET_FRAME_ON_EVERY_LOAD))
      .expect(eachCopyIsItsFrame)
}

// Before: kn_set_frame kept the last save and the baseline, and the page
// called it only when the frame changed.
module ring_after_resync_before {
  import ring_after_resync(
    FORGET_SAVE_ON_SET_FRAME = false,
    FORGET_BASELINE_ON_SET_FRAME = false,
    SET_FRAME_ON_EVERY_LOAD = false
  ).*
}

// #254 as first written: kn_set_frame forgot the last save only.
module ring_after_resync_save_only {
  import ring_after_resync(
    FORGET_SAVE_ON_SET_FRAME = true,
    FORGET_BASELINE_ON_SET_FRAME = false,
    SET_FRAME_ON_EVERY_LOAD = false
  ).*
}

// Today: kn_set_frame forgets the last save and the baseline, and the page
// calls it on every state it loads.
module ring_after_resync_current {
  import ring_after_resync(
    FORGET_SAVE_ON_SET_FRAME = true,
    FORGET_BASELINE_ON_SET_FRAME = true,
    SET_FRAME_ON_EVERY_LOAD = true
  ).*
}
