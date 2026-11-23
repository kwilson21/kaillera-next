// -*- mode: Bluespec; -*-
//
// What a player the host removes from the match is fed with, frame by frame:
// the removed slot's input on every page (hardDisconnectPeer and
// _broadcastRoster on the host, the `roster-cut:` and `roster:` handlers on a
// guest, resetPeerState and _cutRemovedInput in
// web/static/netplay-rollback.js; web/src/removed-input.ts).
//
// The engine applies every slot's input of tag `frame - delay` on `frame`.
// Here the delay is left out: a frame stands for the tag it applies, and the
// cut at the host's roster frame R is the cut at tag R - delay on every page
// (the delay is one per match, the host's).
//
// Before ("wall clock"): each page stopped applying the removed player's
// inputs when it learned of the removal, at whatever frame it was on: the
// host when it dropped the player (resetPeerState: kn_rollback_slot_reset
// empties the slot's input ring and makes it inactive, and an inactive slot
// reads as neutral), a guest when the `roster:` message arrived. So
//   - a guest ahead of the host had run frames from R on with the player's
//     real inputs (it still held them) and nothing ran them again
//     (guestAheadTest; the four-player rejoin run's split at frame 1143);
//   - a guest behind the host went neutral before R, on frames the host ran
//     with the real inputs (guestBehindTest);
//   - a replay on any page after its reset ran frames from before its own
//     switch again with neutral input: the ring was emptied
//     (replayAfterTheCutTest).
//
// AT_FRAME ("by frame", the fix): the cut is at the host's roster frame R on
// every page:
//   - frames below R apply the input the host applied there, and only that:
//     at the cut the host freezes the slot (it takes no more input of the
//     player, so what its ring holds below R is final, a prediction
//     included) and sends those values just before the roster
//     (`roster-cut:`); every page writes them into its ring as real inputs,
//     so a replay runs them again unchanged;
//   - frames from R on apply neutral until the player is admitted again;
//   - a guest that heard of it behind R has run no frame it changes and runs
//     the real inputs up to R (from the host's values) and neutral from R;
//   - a guest that heard of it after running frames with other inputs (ahead
//     of R with the player's real inputs, or below R on its own prediction
//     or on a real input the host never had) runs them again from the first
//     such frame (`rerun`: a re-run from its own ring, or the host's state
//     when its ring no longer holds that frame);
//   - the host is never late: R is its own frame.
//
// The rule rides on the scheduled roster rule (controller_mask.qnt, VERSIONED):
// a match is on it only while every player page in it can be (the
// `scheduledControllerMask` capability), and the host sends `roster-cut:` only
// for a roster it schedules; a match with a page from before it runs the
// wall-clock rule for good, as it runs the immediate mask. That choice is
// controller_mask.qnt's and is not modelled again here.
//
// The player's admission again (a late join into the same slot) is at the
// host's frame A >= R, announced after the cut on the same ordered channel;
// from A every page applies the new session's inputs, predicted from their
// own newest real input or neutral (the late joiner's first inputs are a
// neutral ramp, so a guest that heard of A late ran those frames alike).
// Frames from A on are ordinary input agreement and are not this spec's
// property.
//
// A page's ring is the record of what it applied: the cut compares the host's
// inputs with it. A page that empties a player's slot for its own reasons
// (resetPeerState: a reconnect, a mesh heal) puts back the inputs the frames
// still in its ring ran with, on the scheduled rule, so a replay runs them
// again unchanged and a cut heard later reads them; not modelled apart (it is
// `replay` keeping its inputs).
//
// What is modelled: the host and one guest; the removed player's inputs
// (one session before the cut, one after the admission) reaching each page
// in any order, any time; predictions (the newest real input held before the
// frame, or neutral); a page runs again from a frame whose input it held
// differently when the real one arrives (a rollback, of any depth), and
// rollbacks of up to W frames started by other players' inputs; pacing of
// AHEAD frames between the pages. Not modelled: a host mid-replay at the
// cut (its replay then runs the frames from R with the cut, as the frames
// still ahead of it), three or more pages (each guest is this guest), the
// C engine's limit on a rollback's depth (a deeper misprediction is a
// failed rollback, as it is in every other case), the deadline on the host's
// state (specs/resync_reask.qnt).

module removed_input {
  const AT_FRAME: bool

  // Bound on frames for the model.
  pure val MAX_F = 6
  // The rollback window of a rollback started by another player's input.
  pure val W = 2
  // Pacing: a page runs at most this many frames past the other.
  pure val AHEAD = 2
  // The neutral ramp a late joiner starts with (LATE_JOIN_INPUT_BOOTSTRAP_FRAMES).
  pure val RAMP = 2

  pure val FRAMES = 0.to(MAX_F - 1)
  pure val INPUTS = Set(0, 1)
  pure val PAGES = Set("host", "guest")
  pure def other(p: str): str = if (p == "host") "guest" else "host"

  // The removed player's inputs: before the cut, and after its admission.
  var first: int -> int
  var second: int -> int
  var alive: bool                   // the player still sends its first session's inputs
  var held1: str -> Set[int]        // frames of the first session's real inputs each page holds
  var held2: str -> Set[int]        // the same for the second session
  var frontier: str -> int          // the lowest frame the page has not run
  var applied: str -> (int -> int)  // the input each frame last ran with
  var cutR: int                     // the host's roster frame of the removal, or -1
  var word: int -> int              // the host's frozen inputs below cutR (AT_FRAME)
  var admitA: int                   // the host's roster frame of the admission, or -1
  var guestCut: bool                // the guest has heard the removal
  var guestAdmit: bool              // the guest has heard the admission
  var inflight: List[(str, int)]    // rosters on their way to the guest: ("cut" | "admit", frame)
  var rerunFrom: int                // the guest must run again from this frame, or -1
  var replayChanged: bool           // history: a replay ran a cut frame with another input

  pure def maxInt(a: int, b: int): int = if (a > b) a else b
  pure def minInt(a: int, b: int): int = if (a < b) a else b

  // The input a page applies at f from real inputs `held` of `inputs`: the
  // real one, or the newest real one before f, or neutral (C's prediction,
  // repeat-last here).
  pure def predict(held: Set[int], inputs: int -> int, f: int): int =
    if (held.contains(f)) inputs.get(f)
    else
      val earlier = held.filter(g => g < f)
      if (earlier.size() == 0) 0
      else inputs.get(earlier.fold(-1, (acc, g) => maxInt(acc, g)))

  def cutKnown(p: str): bool = if (p == "host") cutR >= 0 else guestCut
  def admitKnown(p: str): bool = if (p == "host") admitA >= 0 else guestAdmit

  // The input page p runs frame f with, as it knows things now.
  def inputAt(p: str, f: int): int =
    if (not(cutKnown(p))) predict(held1.get(p), first, f)
    else if (admitKnown(p) and f >= admitA) predict(held2.get(p), second, f)
    else if (AT_FRAME and f < cutR) word.get(f)
    else 0

  // Page p runs the frames from `from` to its frontier again with what it
  // knows now (inputAt).
  def rerunFromFrame(p: str, from: int): int -> int =
    applied.get(p).keys().mapBy(f => if (f >= from) inputAt(p, f) else applied.get(p).get(f))

  action initWith(s1: int -> int, s2: int -> int): bool = all {
    first' = s1,
    second' = s2,
    alive' = true,
    held1' = Map("host" -> Set(), "guest" -> Set()),
    held2' = Map("host" -> Set(), "guest" -> Set()),
    frontier' = Map("host" -> 0, "guest" -> 0),
    applied' = Map("host" -> Map(), "guest" -> Map()),
    cutR' = -1,
    word' = Map(),
    admitA' = -1,
    guestCut' = false,
    guestAdmit' = false,
    inflight' = List(),
    rerunFrom' = -1,
    replayChanged' = false,
  }

  // The late joiner's ramp is neutral.
  pure def ramped(s2: int -> int, from: int): int -> int =
    s2.keys().mapBy(f => if (f < from + RAMP) 0 else s2.get(f))

  action init = {
    nondet s1 = FRAMES.setOfMaps(INPUTS).oneOf()
    nondet s2 = FRAMES.setOfMaps(INPUTS).oneOf()
    initWith(s1, s2)
  }

  // Page p runs its next frame.
  action stepFrame(p: str): bool = {
    val f = frontier.get(p)
    all {
      f < MAX_F,
      f + 1 - frontier.get(other(p)) <= AHEAD,
      rerunFrom < 0 or p == "host",
      frontier' = frontier.set(p, f + 1),
      applied' = applied.set(p, applied.get(p).put(f, inputAt(p, f))),
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, cutR' = cutR,
      word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit, inflight' = inflight,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged,
    }
  }

  // The player's input of frame f (first session) reaches page p. Taken in
  // until p knows of the removal; a frame that ran with another input runs
  // again (a rollback).
  action deliverFirst(p: str, f: int): bool = {
    val held = held1.get(p).union(Set(f))
    all {
      alive,
      not(cutKnown(p)),
      not(held1.get(p).contains(f)),
      held1' = held1.set(p, held),
      // Taken in only before the cut is known: the prediction with it.
      applied' = applied.set(p, applied.get(p).keys().mapBy(g =>
        if (g >= f) predict(held, first, g) else applied.get(p).get(g))),
      first' = first, second' = second, alive' = alive, held2' = held2, frontier' = frontier, cutR' = cutR,
      word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit, inflight' = inflight,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged,
    }
  }

  // The rejoined player's input of frame f reaches page p, once p has heard
  // of the admission (the floor drops anything earlier).
  action deliverSecond(p: str, f: int): bool = {
    val held = held2.get(p).union(Set(f))
    all {
      admitKnown(p),
      f >= admitA,
      not(held2.get(p).contains(f)),
      held2' = held2.set(p, held),
      // f >= admitA: only the frames from f on change.
      applied' = applied.set(p, applied.get(p).keys().mapBy(g =>
        if (g >= f) predict(held, second, g) else applied.get(p).get(g))),
      first' = first, second' = second, alive' = alive, held1' = held1, frontier' = frontier, cutR' = cutR,
      word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit, inflight' = inflight,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged,
    }
  }

  // The player stops sending (its page is gone).
  action playerGone: bool = all {
    alive,
    alive' = false,
    first' = first, second' = second, held1' = held1, held2' = held2, frontier' = frontier, applied' = applied,
    cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
    inflight' = inflight, rerunFrom' = rerunFrom, replayChanged' = replayChanged,
  }

  // Another player's misprediction: page p runs its last d frames again.
  action replay(p: str, d: int): bool = {
    val from = frontier.get(p) - d
    val again = rerunFromFrame(p, from)
    // A frame the removal governs (below the admission) ran with another input.
    val changed = applied.get(p).keys().exists(f =>
      f >= from and cutKnown(p) and (admitA < 0 or f < admitA) and again.get(f) != applied.get(p).get(f)
      and (p == "host" or rerunFrom < 0)
    )
    all {
      from >= 0,
      rerunFrom < 0 or p == "host",
      applied' = applied.set(p, again),
      replayChanged' = (replayChanged or changed),
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
      cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
      inflight' = inflight, rerunFrom' = rerunFrom,
    }
  }

  // The host drops the player at the frame it is on and sends the roster
  // (by frame: its inputs below R first).
  action hostCut: bool = {
    val r = frontier.get("host")
    all {
      cutR < 0,
      cutR' = r,
      word' = 0.to(r - 1).mapBy(f => applied.get("host").get(f)),
      inflight' = inflight.append(("cut", r)),
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
      applied' = applied, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged,
    }
  }

  // The player joins again, into the same slot, at the host's frame.
  action hostAdmit: bool = {
    val a = frontier.get("host")
    all {
      cutR >= 0,
      admitA < 0,
      admitA' = a,
      inflight' = inflight.append(("admit", a)),
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
      applied' = applied, cutR' = cutR, word' = word, guestCut' = guestCut, guestAdmit' = guestAdmit,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged,
    }
  }

  // The input the guest runs frame f with once it has heard (nowCut,
  // nowAdmit): inputAt with those flags.
  def guestKnows(nowCut: bool, nowAdmit: bool, f: int): int =
    if (not(nowCut)) predict(held1.get("guest"), first, f)
    else if (nowAdmit and f >= admitA) predict(held2.get("guest"), second, f)
    else if (AT_FRAME and f < cutR) word.get(f)
    else 0

  // The first frame the guest has run with another input than it knows now
  // it should have, or -1.
  def firstDiffering(nowCut: bool, nowAdmit: bool): int =
    val diff = applied.get("guest").keys().filter(f => applied.get("guest").get(f) != guestKnows(nowCut, nowAdmit, f))
    if (diff.size() == 0) -1 else diff.fold(MAX_F, (acc, f) => minInt(acc, f))

  // The oldest roster on its way reaches the guest.
  action deliver: bool = {
    val msg = inflight.head()
    val isCut = msg._1 == "cut"
    val nowCut = guestCut or isCut
    val nowAdmit = guestAdmit or not(isCut)
    val late = if (AT_FRAME) firstDiffering(nowCut, nowAdmit) else -1
    all {
      inflight.length() > 0,
      inflight' = inflight.tail(),
      guestCut' = nowCut,
      guestAdmit' = nowAdmit,
      rerunFrom' = if (late < 0) rerunFrom else if (rerunFrom < 0) late else minInt(rerunFrom, late),
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
      applied' = applied, cutR' = cutR, word' = word, admitA' = admitA, replayChanged' = replayChanged,
    }
  }

  // The guest runs again from the first frame that ran differently.
  action rerun: bool = all {
    rerunFrom >= 0,
    applied' = applied.set("guest", rerunFromFrame("guest", rerunFrom)),
    rerunFrom' = -1,
    first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
    cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
    inflight' = inflight, replayChanged' = replayChanged,
  }

  action stutter = all {
    first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
    applied' = applied, cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut,
    guestAdmit' = guestAdmit, inflight' = inflight, rerunFrom' = rerunFrom, replayChanged' = replayChanged,
  }

  action step = any {
    nondet p = PAGES.oneOf()
    nondet f = FRAMES.oneOf()
    nondet d = 1.to(W).oneOf()
    any {
      stepFrame(p),
      deliverFirst(p, f),
      deliverSecond(p, f),
      replay(p, d),
    },
    playerGone,
    hostCut,
    hostAdmit,
    deliver,
    rerun,
    stutter,
  }

  // ── Properties ───────────────────────────────────────────────────────────

  // Once the guest has heard of the removal and run again what it had to,
  // every frame both pages have run below the admission ran with the same
  // input for the removed player on both.
  def ranAlike: bool =
    applied.get("host").keys().intersect(applied.get("guest").keys())
      .filter(f => admitA < 0 or f < admitA)
      .forall(f => applied.get("host").get(f) == applied.get("guest").get(f))

  val settled = cutR >= 0 and guestCut and rerunFrom < 0
  val removedInputAgrees = settled implies ranAlike

  // A frame the removal governs runs again with the input it ran with.
  val aReplayKeepsTheCut = not(replayChanged)

  // Below its cut the host runs the inputs it froze, from its cut on neutral.
  val hostRunsItsWord =
    (AT_FRAME and cutR >= 0) implies
      applied.get("host").keys().filter(f => admitA < 0 or f < admitA)
        .forall(f => applied.get("host").get(f) == (if (f < cutR) word.get(f) else 0))

  val allHold = removedInputAgrees and aReplayKeepsTheCut and hostRunsItsWord

  // ── Scenarios ────────────────────────────────────────────────────────────

  pure val MOVING = FRAMES.mapBy(f => 1)
  pure val STILL = FRAMES.mapBy(f => 0)

  // The guest is ahead of the host and holds the player's real inputs past
  // the host's frame when the host drops it at frame 2. Before: the guest
  // ran frame 2 with the real input, the host with neutral, and nothing ran
  // it again. By frame: the guest runs frame 2 again with neutral.
  run guestAheadTest =
    initWith(MOVING, STILL)
      .then(deliverFirst("host", 0)).then(deliverFirst("host", 1))
      .then(deliverFirst("guest", 0)).then(deliverFirst("guest", 1)).then(deliverFirst("guest", 2))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("guest"))
      .then(hostCut)
      .then(stepFrame("host"))
      .then(deliver)
      .expect(if (AT_FRAME) rerunFrom == 2 else settled and not(ranAlike))
      .then(if (AT_FRAME) rerun else stutter)
      .expect(if (AT_FRAME) allHold and applied.get("guest").get(2) == 0 else not(removedInputAgrees))

  // The guest is behind: it hears of the removal at frame 0, before the
  // host's frame 2. Before: it runs frames 0 and 1 neutral, the host ran
  // them with the real input. By frame: it runs them with the real inputs
  // (the host's) and frame 2 neutral, with nothing to run again.
  run guestBehindTest =
    initWith(MOVING, STILL)
      .then(deliverFirst("host", 0)).then(deliverFirst("host", 1))
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(hostCut)
      .then(deliver)
      .expect(if (AT_FRAME) rerunFrom < 0 else true)
      .then(stepFrame("guest")).then(stepFrame("guest")).then(stepFrame("guest"))
      .then(stepFrame("host"))
      .expect(
        if (AT_FRAME) allHold and applied.get("guest").get(0) == 1 and applied.get("guest").get(2) == 0
        else not(removedInputAgrees)
      )

  // The host never got the player's input of frame 1 (it ran it on a
  // prediction) and the guest did: the guest takes the host's input there,
  // running frame 1 again. Before: the pages keep the two inputs.
  run hostPredictedTest =
    initWith(Map(0 -> 1, 1 -> 0, 2 -> 0, 3 -> 0, 4 -> 0, 5 -> 0), STILL)
      .then(deliverFirst("host", 0)).then(deliverFirst("guest", 0)).then(deliverFirst("guest", 1))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(playerGone)
      .then(hostCut)
      .then(deliver)
      .expect(if (AT_FRAME) rerunFrom == 1 else not(removedInputAgrees))
      .then(if (AT_FRAME) rerun else stutter)
      .expect(if (AT_FRAME) allHold and applied.get("guest").get(1) == 1 else not(removedInputAgrees))

  // After the cut another player's input makes the host run its last two
  // frames again. Before: its ring was emptied at the cut, so frame 1 (from
  // before the cut) runs again neutral. By frame: with the input it froze.
  run replayAfterTheCutTest =
    initWith(MOVING, STILL)
      .then(deliverFirst("host", 0)).then(deliverFirst("host", 1))
      .then(stepFrame("host")).then(stepFrame("host"))
      .then(hostCut)
      .then(replay("host", 1))
      .expect(if (AT_FRAME) allHold and applied.get("host").get(1) == 1 else not(aReplayKeepsTheCut))

  // The player is dropped at frame 1 and admitted again at frame 2, and the
  // guest, ahead, hears of both after it ran frames 1 to 3 with the first
  // session's inputs: by frame it runs frame 1 again neutral, and frames 2
  // and 3 with the second session's (its neutral ramp).
  run quickRejoinTest =
    initWith(MOVING, STILL)
      .then(deliverFirst("host", 0)).then(deliverFirst("guest", 0)).then(deliverFirst("guest", 1))
      .then(deliverFirst("guest", 2)).then(deliverFirst("guest", 3))
      .then(stepFrame("host")).then(stepFrame("guest"))
      .then(hostCut)
      .then(stepFrame("guest")).then(stepFrame("host"))
      .then(hostAdmit)
      .then(stepFrame("guest")).then(stepFrame("guest"))
      .then(deliver).then(deliver)
      .then(if (AT_FRAME) rerun else stutter)
      .then(stepFrame("host")).then(stepFrame("host"))
      .expect(if (AT_FRAME) allHold and applied.get("guest").get(1) == 0 else not(removedInputAgrees))
}

// Before: each page cut the player when it learned of the removal.
module removed_input_before {
  import removed_input(AT_FRAME = false).*
}

// The fix: the cut at the host's roster frame, the host's inputs below it.
module removed_input_fixed {
  import removed_input(AT_FRAME = true).*
}
