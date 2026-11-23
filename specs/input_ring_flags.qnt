// One remote player's slot in the rollback engine's input ring
// (build/kn_rollback/kn_rollback.c: kn_feed_input, kn_pre_tick's forward
// pass and its replay).
//
// The ring holds one entry per frame modulo its size (KN_INPUT_RING_SIZE,
// 256). An entry has the frame it is for, its value, and two marks of a
// prediction: predicted[] (a flag) and predicted_values[].frame (the frame
// the prediction was for).
//
// - The forward pass predicts a frame whose real input has not arrived: it
//   writes the prediction and sets the flag.
// - kn_feed_input stores a real input. It checks a prediction, and clears the
//   flag, only when the flag is set and the prediction is for this frame; a
//   prediction it differs from on a frame already run schedules a rollback.
// - A replay (a rollback re-running frames, for this player's input or any
//   other's) predicts again a frame whose entry is missing, or present with
//   the flag set ("still unconfirmed").
//
// A prediction whose real input never reaches kn_feed_input leaves its flag
// set. A resync makes them: the page settles every input before the frame it
// applies (_settleInputsAtResync) and never feeds one below that floor
// (_drainPendingCInputs' C-INPUT-SETTLED-SKIP). An input that is lost does
// the same. One lap later the real
// input for the frame at the same index arrives before the forward pass
// reaches it: it is stored, and the stale flag is left set, since the
// prediction is for another frame. The forward pass runs the frame on the
// real input: it predicts only an entry missing or not for this frame, and
// for one that is takes the value as it is. So the live run is right, and
// only a replay diverges. A replay that covers the frame then reads the flag as an
// unconfirmed prediction, predicts again over the real input, and runs the
// frame on the prediction. The real input has been fed and is not fed again,
// so nothing checks that prediction and nothing rolls back: the page keeps a
// different input for that frame from every other page. Found in a
// three-player run (rb3a, RECOVERY_BYSTANDER): the host replayed apply frame
// 2704 with P3's slot predicted over the real input it had run, and split
// from both guests to the end; the same ring index had done it 7 laps before,
// at 912.
//
// Not modelled: input values (every prediction differs from the real input,
// the case that matters), dead reckoning, more than one remote player, the
// rollback depth cap, the saved states a replay restores.
//
// CLEAR_ON_REAL: kn_feed_input clears the flag whenever it stores a real
// input.
// REPLAY_CHECKS_FRAME: the replay (and the forward pass's accounting) count an
// entry as unconfirmed only when its prediction is for that frame.
module input_ring_flags {
  const CLEAR_ON_REAL: bool
  const REPLAY_CHECKS_FRAME: bool

  pure val RING = 3
  pure val MAX_FRAME = 7
  pure val NONE = -1

  // frame: the frame the entry is for (NONE: never written). real: it holds
  // the real input. flag: predicted[]. predFrame: predicted_values[].frame.
  type Entry = { frame: int, real: bool, flag: bool, predFrame: int }
  pure val EMPTY: Entry = { frame: NONE, real: false, flag: false, predFrame: NONE }

  var ring: int -> Entry // by frame % RING
  var now: int // the frame the forward pass runs next
  var fed: Set[int] // frames whose real input kn_feed_input stored
  var ranReal: int -> bool // whether a frame's last run used the real input
  var pending: int // the rollback target; NONE when none is pending
  var settled: int // inputs for frames below this are never fed (a resync)

  action init = all {
    ring' = 0.to(RING - 1).mapBy(_ => EMPTY),
    now' = 0,
    fed' = Set(),
    ranReal' = Map(),
    pending' = NONE,
    settled' = 0,
  }

  pure def predictionFor(f: int): Entry = { frame: f, real: false, flag: true, predFrame: f }

  // The forward pass runs `now`: on the entry if it holds this frame,
  // otherwise on a prediction it writes.
  action tick = {
    val e = ring.get(now % RING)
    val present = e.frame == now
    all {
      pending == NONE,
      now <= MAX_FRAME,
      ring' = if (present) ring else ring.set(now % RING, predictionFor(now)),
      ranReal' = ranReal.put(now, present and e.real),
      now' = now + 1,
      fed' = fed,
      pending' = pending,
      settled' = settled,
    }
  }

  // kn_feed_input stores the real input for `f`. Inputs come in any order,
  // for frames within the ring's lap around `now`: none older than the ring
  // still holds (the page drops those), none so far ahead that it overwrites
  // a frame not yet run (an input is sent a few frames ahead, never a lap).
  action feed(f: int): bool = {
    val e = ring.get(f % RING)
    val checks = e.flag and e.predFrame == f
    // Every prediction differs from the real input: on a frame already run,
    // a checked prediction rolls back.
    val rollsBack = checks and f < now
    all {
      not(fed.contains(f)),
      f >= settled,
      f <= MAX_FRAME,
      f > now - RING,
      f <= now,
      ring' = ring.set(f % RING, {
        frame: f,
        real: true,
        flag: if (CLEAR_ON_REAL or checks) false else e.flag,
        predFrame: e.predFrame,
      }),
      fed' = fed.union(Set(f)),
      pending' = if (rollsBack and (pending == NONE or f < pending)) f else pending,
      now' = now,
      ranReal' = ranReal,
      settled' = settled,
    }
  }

  // Another player's input rolls back to `t`: a replay covers it as well.
  action otherRollback(t: int): bool = all {
    t < now,
    t > now - RING,
    pending' = if (pending == NONE or t < pending) t else pending,
    ring' = ring,
    now' = now,
    fed' = fed,
    ranReal' = ranReal,
    settled' = settled,
  }

  // The replay re-runs every frame from the target up to `now`. The target is
  // within one lap of `now`, so each frame is at its own index and the order
  // they are folded in does not matter.
  pure def replayFrame(st: { ring: int -> Entry, ran: int -> bool }, g: int): { ring: int -> Entry, ran: int -> bool } = {
    val e = st.ring.get(g % RING)
    val missing = e.frame != g
    val unconfirmed = e.frame == g and e.flag and (not(REPLAY_CHECKS_FRAME) or e.predFrame == g)
    val after = if (missing or unconfirmed) predictionFor(g) else e
    { ring: st.ring.set(g % RING, after), ran: st.ran.put(g, after.real) }
  }

  action replay = {
    val out = 0.to(MAX_FRAME).filter(g => g >= pending and g < now).fold({ ring: ring, ran: ranReal }, replayFrame)
    all {
      pending != NONE,
      ring' = out.ring,
      ranReal' = out.ran,
      pending' = NONE,
      now' = now,
      fed' = fed,
      settled' = settled,
    }
  }

  // A resync at `now` settles every input before it: the page never feeds
  // the real input of a frame below it, so a prediction there stays
  // unconfirmed.
  action settle = all {
    pending == NONE,
    settled < now,
    settled' = now,
    ring' = ring,
    now' = now,
    fed' = fed,
    ranReal' = ranReal,
    pending' = pending,
  }

  action step = any {
    tick,
    nondet f = 0.to(MAX_FRAME).oneOf()
    feed(f),
    nondet t = 0.to(MAX_FRAME).oneOf()
    otherRollback(t),
    replay,
    settle,
  }

  // ── Properties ──────────────────────────────────────────────────────────

  // An entry holding a frame whose real input was stored holds the real input.
  val aRealInputIsNeverReplacedByAPrediction =
    ring.keys().forall(i => {
      val e = ring.get(i)
      fed.contains(e.frame) implies e.real
    })

  // With no rollback pending, every frame run whose real input was stored ran
  // on it: nothing is left for a later correction.
  val everyFedFrameRanOnItsRealInput =
    pending == NONE implies fed.forall(f => not(ranReal.keys().contains(f)) or ranReal.get(f))

  val allHold = aRealInputIsNeverReplacedByAPrediction and everyFedFrameRanOnItsRealInput

  // ── Scenarios ───────────────────────────────────────────────────────────

  // Frame 0 is predicted and its real input never arrives. A lap later the
  // real input for frame 3 (the same index) arrives first, and frame 3 runs
  // on it. Another player's rollback replays frame 3.
  run staleFlagTest =
    init
      .then(tick)
      .then(tick)
      .then(tick)
      .then(feed(3))
      .then(tick)
      .expect(ranReal.get(3))
      .then(otherRollback(3))
      .then(replay)
      .expect(allHold == (CLEAR_ON_REAL or REPLAY_CHECKS_FRAME))

  // The usual case: a frame predicted, its real input arriving after it ran,
  // a rollback, the replay running it on the real input.
  run lateRealInputTest =
    init
      .then(tick)
      .then(feed(0))
      .expect(pending == 0)
      .then(replay)
      .expect(allHold)
      .expect(ranReal.get(0))

  // The producer in a match: frames 0..2 run on predictions, a resync at 3
  // settles them, and their real inputs are never fed. A lap later the real
  // input for frame 3 comes before its frame runs; the live run takes it,
  // and only another player's replay predicts over it.
  run settledThenALapTest =
    init
      .then(tick)
      .then(tick)
      .then(tick)
      .then(settle)
      .then(feed(3))
      .then(tick)
      .expect(ranReal.get(3) and aRealInputIsNeverReplacedByAPrediction)
      .then(otherRollback(3))
      .then(replay)
      .expect(allHold == (CLEAR_ON_REAL or REPLAY_CHECKS_FRAME))

  // A replay re-predicts a frame whose real input has not arrived: the
  // arrival is still checked against the new prediction and rolls back.
  run rePredictedThenFedTest =
    init
      .then(tick)
      .then(tick)
      .then(otherRollback(0))
      .then(replay)
      .then(feed(1))
      .expect(pending == 1)
      .then(replay)
      .expect(allHold)
}

// Today: kn_feed_input clears the flag only when it checks the prediction,
// and the replay trusts the flag.
module input_ring_flags_current {
  import input_ring_flags(CLEAR_ON_REAL = false, REPLAY_CHECKS_FRAME = false).*
}

// The fix: kn_feed_input clears the flag whenever it stores a real input,
// and the replay re-predicts only a prediction for that frame.
module input_ring_flags_fixed {
  import input_ring_flags(CLEAR_ON_REAL = true, REPLAY_CHECKS_FRAME = true).*
}
