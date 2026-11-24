// -*- mode: Bluespec; -*-
//
// RB-CHECK: the rollback engine's cross-peer gameplay-hash check
// (web/src/rb-check.ts, called from the tick loop in
// web/static/netplay-rollback.js).
//
// Every few hundred frames each page sends the other its gameplay hash of one
// frame; a page that holds both values for a frame compares them and logs
// `RB-CHECK f=.. MATCH` or `MISMATCH`. The server flags a match with a
// MISMATCH (server/src/retention.py), so a MISMATCH must mean the peers'
// final states differ, and a final difference must not go unlogged.
//
// The rule before: the sender took the hash of the frame it had just
// simulated, which may have run on a predicted input and may still be rolled
// back. The receiver kept it until it was a few frames old, then compared it
// with its own ring's hash of that frame read at that moment, and dropped it
// as STALE when it arrived after the frame had left the receiver's rollback
// window. A healthy match with one misprediction on the sender logged a
// MISMATCH; a real split whose message arrived late was dropped.
//
// The rule now (CONFIRMED): each page files, for the frame one rollback
// window behind the frame it has just simulated, the hash its ring holds then
// (that frame can no longer be replayed), and sends that. A page compares its
// filed value with the peer's whichever of the two arrives second.
//
// What is modelled, for two peers 0 and 1:
//   advance(p, m)  peer p simulates its next frame; m = on a mispredicted input
//   rollback(p)    the real input arrived: p replays from the first wrong frame
//   deliver(msg)   a message in flight reaches the other peer, at any later time
// A peer stalls instead of letting a frame it may still replay fall more than
// MAX frames behind (the rollback budget), and never runs more than MAX frames
// ahead of the other peer (whose inputs it needs). `splitFrom` is a real
// divergence: from that frame on, peer 1's final state differs from peer 0's.
//
// Not modelled: the send cadence (every frame here), Mode 2 worker replay,
// late join and resync (a frame not in the ring hashes to 0 and is never
// filed), the expiry of a value with no counterpart (web/src/rb-check.ts
// keeps a bounded history; the runs here end well inside it), more than two
// peers.
module rb_check {
  // true = the rule now; false = the rule before.
  const CONFIRMED: bool

  pure val MAX = 3      // rollback window, frames
  pure val MINAGE = 2   // before: a peer's value was compared once it was this old
  pure val LAST = 8     // frames in a run
  pure val PEERS = Set(0, 1)

  type Msg = { from: int, frame: int, value: int }

  var newest: int -> int                // peer -> newest simulated frame
  var wrongFrom: int -> int             // peer -> first frame run on a wrong input, not yet replayed; 0 = none
  var ring: int -> (int -> int)         // peer -> frame -> the hash its ring holds for it
  var splitFrom: int                    // first frame whose final state differs between the peers; 0 = none
  var inFlight: Set[Msg]
  var pending: int -> (int -> int)      // before: peer values waiting to be old enough
  var filed: int -> (int -> int)        // now: the value this peer filed for a frame
  var peerVal: int -> (int -> int)      // now: the other peer's value for a frame
  // History: what was logged about a frame, against the truth.
  var falseMismatch: bool               // MISMATCH logged for a frame whose final states agree
  var falseMatch: bool                  // MATCH logged for a frame whose final states differ
  var droppedSplit: bool                // a value for a frame whose final states differ dropped uncompared
  var mismatchAt: Set[int]              // frames logged MISMATCH

  pure def agreed(split: int, f: int): bool = split == 0 or f < split
  // The final hash of frame f on peer p, and the hash of a frame run on a wrong input.
  pure def finalVal(split: int, p: int, f: int): int = if (not(agreed(split, f)) and p == 1) 2 else 1
  pure def wrongVal(p: int): int = 10 + p
  pure def without(m: int -> int, ks: Set[int]): int -> int = m.keys().exclude(ks).mapBy(k => m.get(k))

  action initWith(split: int): bool = all {
    newest' = PEERS.mapBy(_ => 0),
    wrongFrom' = PEERS.mapBy(_ => 0),
    ring' = PEERS.mapBy(_ => Map()),
    splitFrom' = split,
    inFlight' = Set(),
    pending' = PEERS.mapBy(_ => Map()),
    filed' = PEERS.mapBy(_ => Map()),
    peerVal' = PEERS.mapBy(_ => Map()),
    falseMismatch' = false,
    falseMatch' = false,
    droppedSplit' = false,
    mismatchAt' = Set(),
  }

  action init = {
    nondet split = oneOf(Set(0, 3, 5))
    initWith(split)
  }

  action advance(p: int, mispredicted: bool): bool = {
    val q = 1 - p
    val f = newest.get(p) + 1
    val wrong = wrongFrom.get(p) != 0 or mispredicted
    val r = ring.get(p).put(f, if (wrong) wrongVal(p) else finalVal(splitFrom, p, f))
    // Before: send the frame just simulated; compare the peer values that are
    // old enough against the ring now; drop those past the window.
    val pend = pending.get(p)
    val stale = pend.keys().filter(g => f - g > MAX)
    val due = pend.keys().filter(g => f - g <= MAX and f - g >= MINAGE)
    // Now: file and send the frame one window back; compare it if the peer's
    // value is already here.
    val d = f - MAX
    val files = CONFIRMED and d >= 1
    val peerHas = files and peerVal.get(p).keys().contains(d)
    all {
      f <= LAST,
      // The engine can still replay from the first wrong frame.
      wrongFrom.get(p) == 0 or f - (wrongFrom.get(p) - 1) <= MAX,
      // It waits for the other peer's inputs rather than run too far ahead.
      f - newest.get(q) <= MAX,
      newest' = newest.set(p, f),
      wrongFrom' = if (wrongFrom.get(p) == 0 and mispredicted) wrongFrom.set(p, f) else wrongFrom,
      ring' = ring.set(p, r),
      splitFrom' = splitFrom,
      if (CONFIRMED) all {
        inFlight' = if (files) inFlight.union(Set({ from: p, frame: d, value: r.get(d) })) else inFlight,
        filed' = if (files) filed.set(p, filed.get(p).put(d, r.get(d))) else filed,
        pending' = pending,
        peerVal' = peerVal,
        falseMismatch' = (falseMismatch or (peerHas and r.get(d) != peerVal.get(p).get(d) and agreed(splitFrom, d))),
        falseMatch' = (falseMatch or (peerHas and r.get(d) == peerVal.get(p).get(d) and not(agreed(splitFrom, d)))),
        droppedSplit' = droppedSplit,
        mismatchAt' = if (peerHas and r.get(d) != peerVal.get(p).get(d)) mismatchAt.union(Set(d)) else mismatchAt,
      } else all {
        inFlight' = inFlight.union(Set({ from: p, frame: f, value: r.get(f) })),
        filed' = filed,
        pending' = pending.set(p, without(pend, stale.union(due))),
        peerVal' = peerVal,
        falseMismatch' = (falseMismatch or due.exists(g => pend.get(g) != r.get(g) and agreed(splitFrom, g))),
        falseMatch' = (falseMatch or due.exists(g => pend.get(g) == r.get(g) and not(agreed(splitFrom, g)))),
        droppedSplit' = (droppedSplit or stale.exists(g => not(agreed(splitFrom, g)))),
        mismatchAt' = mismatchAt.union(due.filter(g => pend.get(g) != r.get(g))),
      },
    }
  }

  action rollback(p: int): bool = all {
    wrongFrom.get(p) != 0,
    ring' = ring.set(p, ring.get(p).keys().mapBy(g =>
      if (g >= wrongFrom.get(p)) finalVal(splitFrom, p, g) else ring.get(p).get(g))),
    wrongFrom' = wrongFrom.set(p, 0),
    newest' = newest,
    splitFrom' = splitFrom,
    inFlight' = inFlight,
    pending' = pending,
    filed' = filed,
    peerVal' = peerVal,
    falseMismatch' = falseMismatch,
    falseMatch' = falseMatch,
    droppedSplit' = droppedSplit,
    mismatchAt' = mismatchAt,
  }

  action deliver(msg: Msg): bool = {
    val dest = 1 - msg.from
    val localHas = CONFIRMED and filed.get(dest).keys().contains(msg.frame)
    val local = if (localHas) filed.get(dest).get(msg.frame) else 0
    all {
      inFlight.contains(msg),
      inFlight' = inFlight.exclude(Set(msg)),
      newest' = newest,
      wrongFrom' = wrongFrom,
      ring' = ring,
      splitFrom' = splitFrom,
      filed' = filed,
      pending' = if (CONFIRMED) pending else pending.set(dest, pending.get(dest).put(msg.frame, msg.value)),
      peerVal' = if (CONFIRMED) peerVal.set(dest, peerVal.get(dest).put(msg.frame, msg.value)) else peerVal,
      falseMismatch' = (falseMismatch or (localHas and local != msg.value and agreed(splitFrom, msg.frame))),
      falseMatch' = (falseMatch or (localHas and local == msg.value and not(agreed(splitFrom, msg.frame)))),
      droppedSplit' = droppedSplit,
      mismatchAt' = if (localHas and local != msg.value) mismatchAt.union(Set(msg.frame)) else mismatchAt,
    }
  }

  // The one message from peer `from` about `frame` (none: not enabled).
  action deliverFrame(from: int, frame: int): bool = {
    val msgs = inFlight.filter(m => m.from == from and m.frame == frame)
    all {
      msgs.size() == 1,
      deliver(msgs.fold({ from: -1, frame: -1, value: -1 }, (_, m) => m)),
    }
  }

  action step = any {
    nondet p = oneOf(PEERS)
    nondet m = oneOf(Set(true, false))
    advance(p, m),
    nondet p = oneOf(PEERS)
    rollback(p),
    all {
      inFlight.size() > 0,
      { nondet msg = oneOf(inFlight) deliver(msg) },
    },
  }

  // A MISMATCH means the peers' final states differ.
  val neverFlagsAHealthyFrame = not(falseMismatch)
  // A frame whose final states differ is never logged as MATCH or dropped uncompared.
  val neverMissesARealSplit = not(falseMatch) and not(droppedSplit)
  val rbCheckIsSound = neverFlagsAHealthyFrame and neverMissesARealSplit

  // Both peers advance one frame each, peer 0 first.
  run bothAdvance(m0: bool, m1: bool): bool = advance(0, m0).then(advance(1, m1))

  // A healthy match: peer 0 mispredicts frame 3 and corrects it a frame
  // later. Before: its value for frame 3 (the mispredicted hash) reached
  // peer 1 at once, and peer 1 compared it with its own final one. Now: it
  // files frame 3 only once the window has passed, after the rollback.
  run healthyMispredictionTest =
    initWith(0)
      .then(2.reps(_ => bothAdvance(false, false)))
      .then(advance(0, true))
      .then(advance(1, false))
      .then(if (CONFIRMED) advance(0, false) else deliverFrame(0, 3))
      .then(rollback(0))
      .then(4.reps(_ => bothAdvance(false, false)))
      .then(if (CONFIRMED) deliverFrame(0, 3).then(deliverFrame(1, 3)) else deliverFrame(1, 3))
      .expect(falseMismatch == not(CONFIRMED) and mismatchAt.contains(3) == not(CONFIRMED)
              and not(falseMatch) and not(droppedSplit))

  // A real split from frame 3. Peer 1 holds its own value for frame 3 first;
  // peer 0's arrives after peer 1 has moved past the window. Before: dropped
  // as STALE. Now: compared when it arrives, and logged MISMATCH.
  run splitLocalFirstTest =
    initWith(3)
      .then(6.reps(_ => bothAdvance(false, false)))
      .then(if (CONFIRMED) bothAdvance(false, false).then(deliverFrame(0, 3))
            else deliverFrame(0, 3).then(bothAdvance(false, false)))
      .expect(droppedSplit == not(CONFIRMED) and mismatchAt.contains(3) == CONFIRMED
              and not(falseMatch) and not(falseMismatch))

  // A real split from frame 3; peer 0's value for frame 3 reaches peer 1
  // before peer 1 holds its own. It is compared when peer 1 does, under
  // either rule (before, it arrived inside the window).
  run splitPeerFirstTest =
    initWith(3)
      .then(5.reps(_ => bothAdvance(false, false)))
      .then(advance(0, false))
      .then(deliverFrame(0, 3))
      .then(advance(1, false))
      .expect(mismatchAt.contains(3) and not(falseMatch) and not(falseMismatch) and not(droppedSplit))
}

// Before: the hash of the frame just simulated, compared against the
// receiver's ring a few frames later, dropped past the window.
// rbCheckIsSound is violated (healthyMispredictionTest, splitLocalFirstTest).
module rb_check_before {
  import rb_check(CONFIRMED = false).*
}

// Today: confirmed frames, each side's filed value, compared on the second arrival.
module rb_check_current {
  import rb_check(CONFIRMED = true).*
}
