// The rollback engine's prediction flag across the input ring's wrap
// (build/kn_rollback/kn_rollback.c: kn_feed_input, kn_pre_tick's forward
// path and replay branch).
//
// The remote input ring is indexed by tag % KN_INPUT_RING_SIZE (256), so an
// entry is reused every 256 tags. `rb.predicted[slot][idx]` says the entry
// holds a prediction, and `rb.predicted_values[slot][idx].frame` which tag
// it was a prediction of. kn_feed_input checks both before treating the
// entry as a prediction: a flag left by a prediction of tag X whose real
// input never reached C (the page drops inputs older than a resync's settled
// point, C-INPUT-SETTLED-SKIP) is not cleared when the real input of tag
// X + 256 arrives on time and is stored in the same entry. The replay branch
// read the bare flag: when a later rollback's replay covered the frame that
// applied tag X + 256, it took the stored real input for an unconfirmed
// prediction, overwrote it with a new prediction and ran the frame with it.
// The page never feeds the real input again, so the peers stay apart and no
// counter shows it. Found by reading, reproduced with the native harness
// (tests/rollback-native/test_stale_prediction_flag.py).
//
// The fix: one predicate, "this entry is a prediction of tag t"
// (rb_is_prediction_of), that checks the stored tag, read at every site that
// decides from the flag.
//
// Not modelled: values beyond whether a prediction and the real input
// differ, the rollback a mismatch requests (a replay is any tag the forward
// path has applied within the rollback window), more than one remote player,
// the local input, delay changes. The ring holds RING tags here, not 256.
//
// CHECK_TAG: the replay reads the flag through the predicate that checks the
// stored tag.
module stale_prediction_flag {
  const CHECK_TAG: bool

  pure val RING = 2
  // How far back a replay reaches (the rollback window), and how far back a
  // real input is still taken; the ring is wider than that, as 256 is wider
  // than any rollback. One tag is enough for the ordering; it keeps the
  // exhaustive check (scripts/verify-specs.sh) cheap.
  pure val WINDOW = 1
  pure val MAX_TAG = 4
  pure val NONE = -1
  pure val VALUES = 0.to(1)

  // One input ring entry: the tag it holds (NONE when empty) and its value.
  type Entry = { tag: int, value: int }

  var entry: int -> Entry // rb.inputs[slot][idx]
  var flag: int -> bool // rb.predicted[slot][idx]
  var predictedTag: int -> int // rb.predicted_values[slot][idx].frame
  var real: int -> int // each tag whose real input reached kn_feed_input, and its value
  var nextTag: int // the next tag the forward path applies
  // A replay applied a value other than the real input already fed for its
  // tag.
  var replayAppliedWrong: bool

  action init = all {
    entry' = 0.to(RING - 1).mapBy(_ => { tag: NONE, value: 0 }),
    flag' = 0.to(RING - 1).mapBy(_ => false),
    predictedTag' = 0.to(RING - 1).mapBy(_ => NONE),
    real' = Map(),
    nextTag' = 0,
    replayAppliedWrong' = false,
  }

  pure def idx(t: int): int = t % RING

  // kn_feed_input's test, and the fixed rule everywhere.
  def isPredictionOf(t: int): bool = flag.get(idx(t)) and predictedTag.get(idx(t)) == t

  // What the replay branch reads as "this entry is still a prediction".
  def replaySeesPrediction(t: int): bool =
    if (CHECK_TAG) isPredictionOf(t) else flag.get(idx(t))

  def holds(t: int): bool = entry.get(idx(t)).tag == t

  // Tag t is one a replay can reach and a real input is still taken for.
  def inWindow(t: int): bool = t >= 0 and t >= nextTag - WINDOW and t <= MAX_TAG

  // The real input for tag t reaches kn_feed_input. It clears the flag only
  // when the flag is for t; the input is stored either way. A tag can also
  // never be fed (dropped as settled). An input ahead of the forward path
  // never reuses an entry a replay can still reach.
  action feed(t: int, v: int): bool = all {
    not(real.keys().contains(t)),
    inWindow(t),
    t - RING < nextTag - WINDOW,
    entry' = entry.put(idx(t), { tag: t, value: v }),
    flag' = if (isPredictionOf(t)) flag.put(idx(t), false) else flag,
    predictedTag' = predictedTag,
    real' = real.put(t, v),
    nextTag' = nextTag,
    replayAppliedWrong' = replayAppliedWrong,
  }

  // kn_pre_tick's forward path applies the next tag, predicting `p` when its
  // entry does not hold it.
  action forward(p: int): bool = {
    val t = nextTag
    all {
      t <= MAX_TAG,
      entry' = if (holds(t)) entry else entry.put(idx(t), { tag: t, value: p }),
      flag' = if (holds(t)) flag else flag.put(idx(t), true),
      predictedTag' = if (holds(t)) predictedTag else predictedTag.put(idx(t), t),
      real' = real,
      nextTag' = t + 1,
      replayAppliedWrong' = replayAppliedWrong,
    }
  }

  // A rollback's replay runs the frame that applied tag t again. An entry
  // that is missing or still a prediction is predicted again (`p`) and
  // stored as the prediction; otherwise the stored real input runs.
  action replay(t: int, p: int): bool = {
    val repredict = not(holds(t)) or replaySeesPrediction(t)
    val applied = if (repredict) p else entry.get(idx(t)).value
    val wrong = real.keys().contains(t) and holds(t) and applied != real.get(t)
    all {
      t < nextTag,
      inWindow(t),
      entry' = if (repredict) entry.put(idx(t), { tag: t, value: p }) else entry,
      flag' = if (repredict) flag.put(idx(t), true) else flag,
      predictedTag' = if (repredict) predictedTag.put(idx(t), t) else predictedTag,
      real' = real,
      nextTag' = nextTag,
      replayAppliedWrong' = (replayAppliedWrong or wrong),
    }
  }

  action step = any {
    nondet t = 0.to(MAX_TAG).oneOf()
    nondet v = VALUES.oneOf()
    any { feed(t, v), replay(t, v) },
    nondet p = VALUES.oneOf()
    forward(p),
  }

  // A replay applies the real value of every input it holds confirmed.
  // Violated while the replay read the bare flag.
  val replayAppliesConfirmedInput = not(replayAppliedWrong)

  val allHold = replayAppliesConfirmedInput

  // The ordering the native harness reproduces, with RING = 2 in place of
  // 256: tag 0 is predicted and its real input never arrives; tag 2 (same
  // entry) arrives on time as 1, before it is predicted, and runs; a
  // rollback's replay runs the frame that applied tag 2 again, predicting 0.
  run staleFlagTest =
    init
      .then(forward(0))
      .then(feed(1, 0)).then(forward(0))
      .then(feed(2, 1)).then(forward(0))
      .then(replay(2, 0))
      .expect(replayAppliesConfirmedInput == CHECK_TAG)

  // Control: tag 0's real input arrives and clears the flag; the replay
  // runs tag 2's real value under either rule.
  run everyPredictionVerifiedTest =
    init
      .then(forward(0))
      .then(feed(0, 0))
      .then(feed(1, 0)).then(forward(0))
      .then(feed(2, 1)).then(forward(0))
      .then(replay(2, 0))
      .expect(allHold)

  // A replay of a tag still predicted re-predicts it under either rule.
  run unconfirmedRepredictedTest =
    init
      .then(forward(0))
      .then(replay(0, 1))
      .expect(entry.get(0) == { tag: 0, value: 1 } and isPredictionOf(0))
}

// Before: the replay branch read the bare flag.
module stale_prediction_flag_before {
  import stale_prediction_flag(CHECK_TAG = false).*
}

// Fixed: every site reads the flag through the predicate that checks the
// stored tag.
module stale_prediction_flag_fixed {
  import stale_prediction_flag(CHECK_TAG = true).*
}
