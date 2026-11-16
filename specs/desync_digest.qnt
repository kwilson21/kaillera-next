// -*- mode: Bluespec; -*-
//
// Desync digests: which frame a peer may report a field hash for
// (web/src/desync-confirm.ts, called from tick() in
// web/static/kn-desync-detector.js; the history is kn_hash_registry.c).
//
// A rollback peer simulates a frame before the other players' inputs for it
// have arrived, on a predicted input. When the real input differs it rolls
// back and replays. Until then the frame's state, and every later frame's,
// is not the state the match will keep. Two healthy peers mispredict
// different frames, so if either reports a hash for a frame it may still
// replay, the other can hold a different hash for it and the detector flags
// a desync that is not one. That happened on the first match the detector
// ran in: `rng` and `character_id` flagged on both peers at two frames while
// every finalized frame's state hash matched.
//
// What is modelled, for one peer (a healthy pair agrees exactly when each
// reports only true hashes):
//   advance(m)   simulate the next frame; m = its input was mispredicted
//   rollback     the real input arrived: replay from the first wrong frame
//   loadState    a late join or resync: the peer takes over the host's state
//                at the newest frame, having simulated none of the frames
//                before it, so its history has no entry for them
//   adopt        Mode 2 (worker replay): the corrected state is installed
//                without re-simulating the wrong frames here, so nothing
//                rewrites their history entries
// The engine stalls instead of letting a frame it may still replay fall more
// than MAX frames behind (RB-INPUT-STALL, rollback budget), so advance is
// not enabled then.
//
// Not modelled: failed rollbacks and real divergence (flagging those is the
// detector's job), the broadcast cadence, more than one peer.
//
// REPORT_CONFIRMED: at frame f the peer reports frame f - MAX, which the
//   engine can no longer replay. false = it reports frame f itself.
// REPLAY_REWRITES: a replay replaces the history entry of each frame it
//   re-simulates. false = the history keeps the forward pass's hash.
// SKIP_UNSIMULATED: no digest is reported for a frame with no history entry
//   (_hasHistory in kn-desync-detector.js). false = its zero hashes are
//   reported and compared with the other peer's real ones.
// WITH_WORKER_REPLAY: the detector runs while Mode 2 is on. false = it is
//   off there (netplay-rollback.js), so `adopt` never happens under it.
module desync_digest {
  const REPORT_CONFIRMED: bool
  const REPLAY_REWRITES: bool
  const SKIP_UNSIMULATED: bool
  const WITH_WORKER_REPLAY: bool

  pure val MAX = 3    // rollback window, frames
  pure val LAST = 9   // frames in a run

  var newest: int               // newest simulated frame
  var wrongFrom: int            // first frame simulated on a wrong input and not yet replayed; 0 = none
  var history: int -> bool      // frame -> the recorded hash is the true one
  var simulatedFrom: int        // first frame this emulator simulated itself; earlier ones have no history entry
  var reportedWrong: bool       // history: a digest carried a hash the match did not keep

  // The frame reported when the newest frame is f (digestFrame in web/src/desync-confirm.ts);
  // 0 = none yet.
  pure def reportFrame(f: int, confirmed: bool): int =
    if (not(confirmed)) f
    else if (f > MAX) f - MAX
    else 0

  action init = all {
    newest' = 0,
    wrongFrom' = 0,
    history' = 1.to(LAST).mapBy(f => true),
    simulatedFrom' = 1,
    reportedWrong' = false,
  }

  action advance(mispredicted: bool): bool = {
    val f = newest + 1
    val wrong = wrongFrom != 0 or mispredicted
    val nextHistory = history.set(f, not(wrong))
    val d = reportFrame(f, REPORT_CONFIRMED)
    // A frame with no history entry reads as zero hashes: wrong if reported.
    val reportsWrong =
      if (d == 0) false
      else if (d < simulatedFrom) not(SKIP_UNSIMULATED)
      else not(nextHistory.get(d))
    all {
      f <= LAST,
      // The engine can still replay from the first wrong frame: the frame
      // before it is at most MAX behind the new frame.
      wrongFrom == 0 or f - (wrongFrom - 1) <= MAX,
      newest' = f,
      wrongFrom' = (if (wrongFrom == 0 and mispredicted) f else wrongFrom),
      history' = nextHistory,
      simulatedFrom' = simulatedFrom,
      reportedWrong' = (reportedWrong or reportsWrong),
    }
  }

  action rollback = all {
    wrongFrom != 0,
    wrongFrom' = 0,
    history' = if (REPLAY_REWRITES) history.keys().mapBy(f => if (f >= wrongFrom and f <= newest) true else history.get(f))
               else history,
    newest' = newest,
    simulatedFrom' = simulatedFrom,
    reportedWrong' = reportedWrong,
  }

  // Mode 2: the worker's corrected state replaces the wrong frames' result.
  action adopt = all {
    WITH_WORKER_REPLAY,
    wrongFrom != 0,
    wrongFrom' = 0,
    history' = history,
    newest' = newest,
    simulatedFrom' = simulatedFrom,
    reportedWrong' = reportedWrong,
  }

  // Late join or resync: the host's state at the newest frame replaces ours.
  action loadState = all {
    newest > 0,
    wrongFrom' = 0,
    history' = history,
    newest' = newest,
    simulatedFrom' = newest + 1,
    reportedWrong' = reportedWrong,
  }

  action step = any {
    nondet m = oneOf(Set(true, false))
    advance(m),
    rollback,
    adopt,
    loadState,
  }

  // A healthy peer never reports a hash the match did not keep, so two
  // healthy peers never disagree about a frame.
  val neverReportsAnUnconfirmedHash = not(reportedWrong)

  // One misprediction, corrected a frame later, then play on past the window.
  run mispredictedFrameTest =
    init
      .then(advance(false))
      .then(advance(true))
      .then(advance(false))
      .then(rollback)
      .then(4.reps(_ => advance(false)))
      .expect(reportedWrong == not(REPORT_CONFIRMED and REPLAY_REWRITES))

  // A misprediction corrected the way the configuration corrects it: by the
  // worker's state under Mode 2, by a local replay otherwise. Under Mode 2
  // the wrong frame's history entry is still the mispredicted hash when the
  // window has passed and it is reported.
  run correctedByWorkerTest =
    init
      .then(advance(false))
      .then(advance(true))
      .then(if (WITH_WORKER_REPLAY) adopt else rollback)
      .then(4.reps(_ => advance(false)))
      .expect(reportedWrong == (WITH_WORKER_REPLAY or not(REPORT_CONFIRMED and REPLAY_REWRITES)))

  // A late joiner takes the host's state at frame 5 and plays on: its first
  // digests would be for frames 2..5, which it never simulated.
  run lateJoinTest =
    init
      .then(5.reps(_ => advance(false)))
      .then(loadState)
      .then(4.reps(_ => advance(false)))
      .expect(reportedWrong == not(SKIP_UNSIMULATED) or not(REPORT_CONFIRMED))
}

// Before: the digest for frame f was built at tick f, and replays left the
// history as the forward pass wrote it. neverReportsAnUnconfirmedHash is
// violated.
module desync_digest_before {
  import desync_digest(REPORT_CONFIRMED = false, REPLAY_REWRITES = false, SKIP_UNSIMULATED = false, WITH_WORKER_REPLAY = false).*
}

// Waiting for the window alone is not enough: the frame is final by then,
// but its history entry is still the mispredicted hash.
// neverReportsAnUnconfirmedHash is violated.
module desync_digest_lag_only {
  import desync_digest(REPORT_CONFIRMED = true, REPLAY_REWRITES = false, SKIP_UNSIMULATED = false, WITH_WORKER_REPLAY = false).*
}

// Wait and rewrite, as first written: a late joiner reports zero hashes for
// the frames before the state it loaded. neverReportsAnUnconfirmedHash is
// violated.
module desync_digest_unsimulated {
  import desync_digest(REPORT_CONFIRMED = true, REPLAY_REWRITES = true, SKIP_UNSIMULATED = false, WITH_WORKER_REPLAY = false).*
}

// The detector left on under Mode 2: adopting the worker's state rewrites
// nothing. neverReportsAnUnconfirmedHash is violated.
module desync_digest_worker_replay {
  import desync_digest(REPORT_CONFIRMED = true, REPLAY_REWRITES = true, SKIP_UNSIMULATED = true, WITH_WORKER_REPLAY = true).*
}

// Today.
module desync_digest_current {
  import desync_digest(REPORT_CONFIRMED = true, REPLAY_REWRITES = true, SKIP_UNSIMULATED = true, WITH_WORKER_REPLAY = false).*
}
