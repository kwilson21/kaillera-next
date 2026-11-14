// -*- mode: Bluespec; -*-
//
// Desync screenshots: which frame each peer captures for a flagged frame
// (web/src/desync-capture.ts, called from kn-desync-detector.js; the images
// go to /api/desync-vision, which compares the two peers' pictures).
//
// A peer flags frame F when it holds both its own digest for F and the
// other peer's. That happens at a different tick on each peer: at least one
// rollback window after F, plus however long the other's digest took to
// arrive. The screenshot used to be taken at that moment, so the two
// pictures showed two different frames of a moving game, and a comparison
// of them says "different" whether or not the peers are.
//
// What is modelled, for two peers and one flagged frame F:
//   tick(p)   p simulates its next frame, and captures if this is the frame
//             it is waiting for
//   flag(p)   p learns F is suspect (enabled once it is a window past F)
//
// Not modelled: more than one flagged frame at a time, the picture itself
// (a frame still being predicted when it is drawn), a resync that jumps
// over the capture frame, the server's wait for the second picture.
//
// AT_AGREED_FRAME: a peer captures at frame F + LEAD, and not at all if it
//   learns of F after that. false = it captures when it learns of F.
module desync_capture {
  const AT_AGREED_FRAME: bool

  pure val F = 2       // the flagged frame
  pure val WINDOW = 2  // a peer can flag F from frame F + WINDOW
  pure val LEAD = 4    // frames after F at which both capture
  pure val LAST = 9

  pure val PEERS = Set("host", "guest")

  var frame: str -> int      // newest simulated frame
  var flagged: str -> bool   // has learnt that F is suspect
  var waiting: str -> int    // the frame it will capture at; 0 = none
  var captured: str -> int   // the frame its picture shows; 0 = none

  // captureFrame in web/src/desync-capture.ts; 0 = do not capture.
  pure def captureAt(now: int, agreed: bool): int =
    if (not(agreed)) now
    else if (now <= F + LEAD) F + LEAD
    else 0

  action init = all {
    frame' = PEERS.mapBy(p => 0),
    flagged' = PEERS.mapBy(p => false),
    waiting' = PEERS.mapBy(p => 0),
    captured' = PEERS.mapBy(p => 0),
  }

  action tick(p: str): bool = {
    val f = frame.get(p) + 1
    all {
      f <= LAST,
      frame' = frame.set(p, f),
      flagged' = flagged,
      waiting' = waiting,
      captured' = (if (waiting.get(p) == f) captured.set(p, f) else captured),
    }
  }

  action flag(p: str): bool = {
    val at = captureAt(frame.get(p), AT_AGREED_FRAME)
    all {
      not(flagged.get(p)),
      frame.get(p) >= F + WINDOW,
      flagged' = flagged.set(p, true),
      frame' = frame,
      // Capturing "now" is a capture of the frame it is on.
      waiting' = (if (at > frame.get(p)) waiting.set(p, at) else waiting),
      captured' = (if (at == frame.get(p)) captured.set(p, at) else captured),
    }
  }

  action step = {
    nondet p = oneOf(PEERS)
    any { tick(p), flag(p) }
  }

  // Two pictures that get compared show the same frame.
  val comparedPicturesShowOneFrame =
    captured.get("host") == 0 or captured.get("guest") == 0 or captured.get("host") == captured.get("guest")

  // The host hears of the flagged frame two frames before the guest does.
  run flaggedAtDifferentTicksTest =
    init
      .then(4.reps(_ => tick("host")))
      .then(flag("host"))
      .then(6.reps(_ => tick("guest")))
      .then(flag("guest"))
      .then(2.reps(_ => tick("host")))
      .expect((captured.get("host") == captured.get("guest")) == AT_AGREED_FRAME)

  // A peer that hears too late takes no picture, so nothing is compared.
  run flaggedTooLateTest =
    init
      .then(4.reps(_ => tick("host")))
      .then(flag("host"))
      .then(2.reps(_ => tick("host")))
      .then(8.reps(_ => tick("guest")))
      .then(flag("guest"))
      .expect(AT_AGREED_FRAME implies captured.get("guest") == 0)
}

// Before: each peer captured when it flagged. comparedPicturesShowOneFrame
// is violated.
module desync_capture_before {
  import desync_capture(AT_AGREED_FRAME = false).*
}

// Today.
module desync_capture_current {
  import desync_capture(AT_AGREED_FRAME = true).*
}
