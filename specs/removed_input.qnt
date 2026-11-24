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
// inputs with it. A reconnect or a mesh heal leaves the player's C slot as it
// is (resetPeerState, _resetCoreSlot; specs/reconnect_inputs.qnt
// reconnect_history), and a page that empties it for another reason puts back
// the inputs the frames still in its ring ran with, on the scheduled rule:
// either way a replay runs them again unchanged and a cut heard later reads
// them; not modelled apart (it is `replay` keeping its inputs).
//
// What is modelled: the host and one guest; the removed player's inputs
// (one session before the cut, one after the admission) reaching each page
// in any order, any time; predictions (the newest real input held before the
// frame, or neutral); a page runs again from a frame whose input it held
// differently when the real one arrives (a rollback, of any depth), and
// rollbacks of up to W frames started by other players' inputs; pacing of
// AHEAD frames between the pages; with HOST_MID_REPLAY, a page in the middle
// of a replay (below). Not modelled: three or more pages (each guest is this
// guest), the C engine's limit on a rollback's depth (a deeper misprediction
// is a failed rollback, as it is in every other case), the deadline on the
// host's state (specs/resync_reask.qnt).

// HOST_MID_REPLAY: a replay runs a few frames a tick (the amortized burst in
// tick(), _runCReplayFrame), so a roster can be broadcast between two of its
// ticks: the host's _frameNum is then the C engine's frame (kn_get_frame),
// below the frame the replay returns to. What happens then, on the host:
//   1. _broadcastRoster takes R = max(_frameNum, _lastBroadcastRosterFrame):
//      the replay's frame, or the last roster's frame when that is higher
//      (a roster broadcast before the rollback rewound the host);
//   2. _hostRosterCut reads the slot's ring below C = R - delay: tags the
//      replay has run again hold what it ran them with; tags of frames it
//      has yet to run hold what the first pass ran, or a real input taken
//      in since (the input that started the replay);
//   3. _cutRemovedInput resets the slot and feeds those values below C, and
//      neutral at C and C + 1, as real inputs (its late check reads tags
//      below kn_get_frame() - delay only, all of them the word it just read);
//   4. the replay goes on to its end reading the ring: every frame it still
//      runs applies the word below C and neutral from C (C predicts neutral
//      after the two neutral inputs), and no input of the player is taken
//      in any more (_admissionInputFloor).
// So the host runs exactly what it sent, and the frames from R the first
// pass ran with the player's inputs are run again neutral by the replay that
// was under way (not a replay changing a cut frame: they ran before the
// cut). A guest mid-replay when the roster comes is the same: its late
// check reads the frames below its replay's frame, and the replay runs the
// rest with the cut. Both pages' replays are a frame at a time here, a
// real input taken in during one restarts it from that frame (a cascade),
// and the host can broadcast another roster before the cut (`lastRoster`).

// DELAY, COLLIDE, JOINER_HOLDS: the tags around a quick rejoin, where the
// cut's neutral inputs and the rejoined player's first ones meet.
// _cutRemovedInput feeds neutral at the cut tag C = R - delay and at C + 1 as
// real inputs, so C predicts neutral after them. The admission at the host's
// roster frame A >= R takes the player's inputs from tag A on (record.first,
// _admissionInputFloor): a frame's own number as a tag, `delay` above the
// tag that frame applies. So the floor is at least C + delay, and with delay
// 1 and A == R (the host admits the player again at the frame it cut it) the
// floor is C + 1: the first tag the rejoined player sends is one the cut
// already holds a real neutral input for. A real input over a real input is
// stored with no check (kn_feed_input checks a recorded prediction only): a
// page that ran that frame on the cut's neutral is not run again when the
// player's input comes, and one that had the input first ran it with it.
//   DELAY: the delay, in the model's tags: the host's frame f runs tag f
//     and admits from tag f + DELAY (0: the earlier variants, which put
//     the admission's floor at the frame's own tag).
//   COLLIDE: the cut's two neutral inputs are real entries (C and C + 1):
//     a frame at a tag of them from the admission on runs neutral until the
//     player's input of that tag is taken in, and taking it in runs nothing
//     again. Without it (the earlier variants) every input of the rejoined
//     player is compared with what ran.
//   JOINER_HOLDS: on the scheduled rule the joiner holds its own input
//     neutral below its admission's roster frame + MASK_LEAD
//     (late-join-input-rule.ts joinerHoldsOwnInput; #330), here LEAD.
// removed_input_delay_one_unheld (violated: delayOneCollisionTest) is the
// collision with a joiner that sends what it makes from its floor on;
// removed_input_delay_one_fixed is today: the tags the cut's neutral inputs
// share with the admission (at most C + 1, below A + 1) are ones the joiner
// holds neutral, so the input stored with no check is the neutral that ran
// (joinerInputRuns). No code was needed for it.

module removed_input {
  const AT_FRAME: bool
  const HOST_MID_REPLAY: bool
  const DELAY: int
  const COLLIDE: bool
  const JOINER_HOLDS: bool

  // Bound on frames for the model.
  pure val MAX_F = 6
  // The rollback window of a rollback started by another player's input.
  pure val W = 2
  // Pacing: a page runs at most this many frames past the other.
  pure val AHEAD = 2
  // The neutral ramp a late joiner starts with (LATE_JOIN_INPUT_BOOTSTRAP_FRAMES).
  pure val RAMP = 2
  // The joiner's hold past its admission's roster frame (MASK_LEAD, 60
  // frames; any value of at least 2 covers the cut's two neutral tags).
  pure val LEAD = 2

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
  var replayAt: str -> int          // the next frame a page's replay under way runs, or -1 (HOST_MID_REPLAY)
  var replayBeforeCut: str -> bool  // that replay started before the page knew of the cut
  var lastRoster: int               // the host's _lastBroadcastRosterFrame, or -1

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
  def replaying(p: str): bool = replayAt.get(p) >= 0
  // The frame the C engine is on: the replay's while one is under way.
  def cFrame(p: str): int = if (replaying(p)) replayAt.get(p) else frontier.get(p)
  def admitKnown(p: str): bool = if (p == "host") admitA >= 0 else guestAdmit

  // The rejoined player's input of each tag, as it sends it: neutral below
  // its admission + LEAD when it holds its own input (JOINER_HOLDS).
  def madeSecond: int -> int =
    second.keys().mapBy(f => if (JOINER_HOLDS and admitA >= 0 and f < admitA + LEAD) 0 else second.get(f))

  // A tag from the admission on that the cut fed a real neutral input for.
  def collides(f: int): bool = COLLIDE and cutR >= 0 and admitA >= 0 and f >= admitA and f <= cutR + 1

  // The input a page that knows of the cut (nowCut) and of the admission
  // (nowAdmit), holding these real inputs of each session, runs frame f with.
  def inputWith(nowCut: bool, nowAdmit: bool, h1: Set[int], h2: Set[int], f: int): int =
    if (not(nowCut)) predict(h1, first, f)
    else if (nowAdmit and f >= admitA) (if (collides(f) and not(h2.contains(f))) 0 else predict(h2, madeSecond, f))
    else if (AT_FRAME and f < cutR) word.get(f)
    else 0

  // The input page p runs frame f with, as it knows things now.
  def inputAt(p: str, f: int): int = inputWith(cutKnown(p), admitKnown(p), held1.get(p), held2.get(p), f)

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
    replayAt' = Map("host" -> -1, "guest" -> -1),
    replayBeforeCut' = Map("host" -> false, "guest" -> false),
    lastRoster' = -1,
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
      not(replaying(p)),
      frontier' = frontier.set(p, f + 1),
      applied' = applied.set(p, applied.get(p).put(f, inputAt(p, f))),
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, cutR' = cutR,
      word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit, inflight' = inflight,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged, replayAt' = replayAt, replayBeforeCut' = replayBeforeCut, lastRoster' = lastRoster,
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
      if (HOST_MID_REPLAY) all {
        // The rollback is a replay from f, a frame at a time (a cascade when
        // one is under way); the ring takes the real input now.
        applied' = applied,
        replayAt' = if (f < cFrame(p)) replayAt.set(p, f) else replayAt,
        replayBeforeCut' = if (f < cFrame(p)) replayBeforeCut.set(p, true) else replayBeforeCut,
      } else all {
        // Taken in only before the cut is known: the prediction with it.
        applied' = applied.set(p, applied.get(p).keys().mapBy(g =>
          if (g >= f) predict(held, first, g) else applied.get(p).get(g))),
        replayAt' = replayAt, replayBeforeCut' = replayBeforeCut,
      },
      first' = first, second' = second, alive' = alive, held2' = held2, frontier' = frontier, cutR' = cutR,
      word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit, inflight' = inflight,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged, lastRoster' = lastRoster,
    }
  }

  // The rejoined player's input of frame f reaches page p, once p has heard
  // of the admission (the floor drops anything earlier). Over a real neutral
  // input of the cut (COLLIDE) it is stored with no check: nothing runs again.
  action deliverSecond(p: str, f: int): bool = {
    val held = held2.get(p).union(Set(f))
    all {
      admitKnown(p),
      f >= admitA,
      not(held2.get(p).contains(f)),
      held2' = held2.set(p, held),
      // f >= admitA: only the frames from f on change.
      applied' = if (collides(f)) applied else applied.set(p, applied.get(p).keys().mapBy(g =>
        if (g >= f) predict(held, madeSecond, g) else applied.get(p).get(g))),
      first' = first, second' = second, alive' = alive, held1' = held1, frontier' = frontier, cutR' = cutR,
      word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit, inflight' = inflight,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged, replayAt' = replayAt, replayBeforeCut' = replayBeforeCut, lastRoster' = lastRoster,
    }
  }

  // The player stops sending (its page is gone).
  action playerGone: bool = all {
    alive,
    alive' = false,
    first' = first, second' = second, held1' = held1, held2' = held2, frontier' = frontier, applied' = applied,
    cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
    inflight' = inflight, rerunFrom' = rerunFrom, replayChanged' = replayChanged, replayAt' = replayAt, replayBeforeCut' = replayBeforeCut, lastRoster' = lastRoster,
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
      not(replaying(p)),
      if (HOST_MID_REPLAY) all {
        // Started here, run a frame at a time (replayStep).
        applied' = applied,
        replayChanged' = replayChanged,
        replayAt' = replayAt.set(p, from),
        replayBeforeCut' = replayBeforeCut.set(p, not(cutKnown(p))),
      } else all {
        applied' = applied.set(p, again),
        replayChanged' = (replayChanged or changed),
        replayAt' = replayAt, replayBeforeCut' = replayBeforeCut,
      },
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
      cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
      inflight' = inflight, rerunFrom' = rerunFrom, lastRoster' = lastRoster,
    }
  }

  // The next frame of page p's replay under way, run with what p knows now
  // (the ring, after any cut written into it). A frame the removal governs
  // that ran with another input counts only for a replay that started once
  // p knew of the cut: one under way at the cut runs the frames it had not
  // reached yet with the cut, as the frames ahead of it.
  action replayStep(p: str): bool = {
    val f = replayAt.get(p)
    val v = inputAt(p, f)
    val changed =
      cutKnown(p) and (admitA < 0 or f < admitA) and v != applied.get(p).get(f)
      and not(replayBeforeCut.get(p)) and (p == "host" or rerunFrom < 0)
    all {
      replaying(p),
      applied' = applied.set(p, applied.get(p).put(f, v)),
      replayAt' = replayAt.set(p, if (f + 1 >= frontier.get(p)) -1 else f + 1),
      replayChanged' = (replayChanged or changed),
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
      cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
      inflight' = inflight, rerunFrom' = rerunFrom, replayBeforeCut' = replayBeforeCut, lastRoster' = lastRoster,
    }
  }

  // The host broadcasts a roster that changes nothing here (another
  // player's join, a resume): _lastBroadcastRosterFrame moves up to its
  // frame, the replay's while one is under way.
  action hostOtherRoster: bool = all {
    HOST_MID_REPLAY,
    cutR < 0,
    lastRoster' = maxInt(cFrame("host"), lastRoster),
    first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
    applied' = applied, cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut,
    guestAdmit' = guestAdmit, inflight' = inflight, rerunFrom' = rerunFrom, replayChanged' = replayChanged,
    replayAt' = replayAt, replayBeforeCut' = replayBeforeCut,
  }

  // What the host's ring holds for the player at f before the cut: a real
  // input taken in, else what the frame last ran with (a replay under way
  // has not run it again yet).
  def hostRingAt(f: int): int =
    if (held1.get("host").contains(f)) first.get(f) else applied.get("host").get(f)

  // The host drops the player at the frame it is on and sends the roster
  // (by frame: its inputs below R first).
  // R = max(_frameNum, _lastBroadcastRosterFrame); the word is read from
  // its ring.
  action hostCut: bool = {
    val r = maxInt(cFrame("host"), lastRoster)
    all {
      cutR < 0,
      cutR' = r,
      word' = 0.to(r - 1).mapBy(f => hostRingAt(f)),
      inflight' = inflight.append(("cut", r)),
      lastRoster' = r,
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
      applied' = applied, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged, replayAt' = replayAt,
      replayBeforeCut' = replayBeforeCut,
    }
  }

  // The player joins again, into the same slot, at the host's frame.
  action hostAdmit: bool = {
    val r = maxInt(cFrame("host"), lastRoster)
    // The admission's floor: the roster frame's own number, as a tag.
    val a = r + DELAY
    all {
      cutR >= 0,
      admitA < 0,
      admitA' = a,
      inflight' = inflight.append(("admit", a)),
      lastRoster' = r,
      first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
      applied' = applied, cutR' = cutR, word' = word, guestCut' = guestCut, guestAdmit' = guestAdmit,
      rerunFrom' = rerunFrom, replayChanged' = replayChanged, replayAt' = replayAt,
      replayBeforeCut' = replayBeforeCut,
    }
  }

  // The input the guest runs frame f with once it has heard (nowCut,
  // nowAdmit): inputAt with those flags.
  def guestKnows(nowCut: bool, nowAdmit: bool, f: int): int =
    inputWith(nowCut, nowAdmit, held1.get("guest"), held2.get("guest"), f)

  // The first frame the guest has run with another input than it knows now
  // it should have, or -1.
  // Only frames below the C engine's frame (_cutRemovedInput's ranThrough):
  // a replay under way runs the rest with the cut.
  def firstDiffering(nowCut: bool, nowAdmit: bool): int =
    val diff = applied.get("guest").keys().filter(f =>
      f < cFrame("guest") and applied.get("guest").get(f) != guestKnows(nowCut, nowAdmit, f))
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
      replayAt' = replayAt, replayBeforeCut' = replayBeforeCut, lastRoster' = lastRoster,
    }
  }

  // The guest runs again from the first frame that ran differently.
  // A replay under way is waited out first (_serviceCutRerun, busy).
  action rerun: bool = all {
    rerunFrom >= 0,
    not(replaying("guest")),
    applied' = applied.set("guest", rerunFromFrame("guest", rerunFrom)),
    rerunFrom' = -1,
    first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
    cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut, guestAdmit' = guestAdmit,
    inflight' = inflight, replayChanged' = replayChanged, replayAt' = replayAt, replayBeforeCut' = replayBeforeCut, lastRoster' = lastRoster,
  }

  action stutter = all {
    first' = first, second' = second, alive' = alive, held1' = held1, held2' = held2, frontier' = frontier,
    applied' = applied, cutR' = cutR, word' = word, admitA' = admitA, guestCut' = guestCut,
    guestAdmit' = guestAdmit, inflight' = inflight, rerunFrom' = rerunFrom, replayChanged' = replayChanged,
    replayAt' = replayAt, replayBeforeCut' = replayBeforeCut, lastRoster' = lastRoster,
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
      replayStep(p),
    },
    playerGone,
    hostOtherRoster,
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

  val settled = cutR >= 0 and guestCut and rerunFrom < 0 and not(replaying("host")) and not(replaying("guest"))
  val removedInputAgrees = settled implies ranAlike

  // A frame the removal governs runs again with the input it ran with.
  val aReplayKeepsTheCut = not(replayChanged)

  // Below its cut the host runs the inputs it froze, from its cut on neutral.
  val hostRunsItsWord =
    (AT_FRAME and cutR >= 0) implies
      applied.get("host").keys().filter(f => (admitA < 0 or f < admitA) and f < cFrame("host"))
        .forall(f => applied.get("host").get(f) == (if (f < cutR) word.get(f) else 0))

  // A frame from the admission on, of a tag whose input of the rejoined
  // player the page holds, ran with that input (once a guest has run again
  // what it had to and no replay is under way).
  val joinerInputRuns =
    PAGES.forall(p =>
      ((p == "host" or rerunFrom < 0) and not(replaying(p))) implies
        applied.get(p).keys().forall(f =>
          (admitA >= 0 and f >= admitA and held2.get(p).contains(f)) implies applied.get(p).get(f) == madeSecond.get(f)
        )
    )

  val allHold = removedInputAgrees and aReplayKeepsTheCut and hostRunsItsWord and joinerInputRuns

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

  // Both pages ran frames 0 to 3 with the player's inputs; the host is
  // replaying from frame 2 and has run frame 2 again when it drops the
  // player: R is the replay's frame, 3. The replay runs frame 3 neutral (it
  // ran before the cut: no replay changed a cut frame), the host runs its
  // word, and the guest, ahead of R, runs frame 3 again.
  run hostCutsMidReplayTest =
    if (HOST_MID_REPLAY)
      initWith(MOVING, STILL)
        .then(deliverFirst("host", 0)).then(deliverFirst("host", 1))
        .then(deliverFirst("host", 2)).then(deliverFirst("host", 3))
        .then(deliverFirst("guest", 0)).then(deliverFirst("guest", 1))
        .then(deliverFirst("guest", 2)).then(deliverFirst("guest", 3))
        .then(stepFrame("host")).then(stepFrame("guest")).then(stepFrame("host")).then(stepFrame("guest"))
        .then(stepFrame("host")).then(stepFrame("guest")).then(stepFrame("host")).then(stepFrame("guest"))
        .then(replay("host", 2))
        .then(replayStep("host"))
        .expect(replayAt.get("host") == 3)
        .then(hostCut)
        .expect(cutR == 3 and word == Map(0 -> 1, 1 -> 1, 2 -> 1))
        .then(replayStep("host"))
        .expect(not(replaying("host")) and applied.get("host").get(3) == 0 and hostRunsItsWord and aReplayKeepsTheCut)
        .then(deliver)
        .expect(rerunFrom == 3)
        .then(rerun)
        .expect(allHold and applied.get("guest").get(3) == 0)
    else
      initWith(MOVING, STILL)

  // A roster went out at frame 3; the host then ran frames 2 and 3 on a
  // prediction (0) of an input the player made as 1, and its real input of
  // frame 2 starts a replay from 2. The host drops the player before the
  // replay has run frame 2 again: R is the last roster's frame, 3, above the
  // replay's. Its word for frame 2 is what its ring holds there, the real
  // input taken in (not what the first pass ran), and the replay runs frame
  // 2 with it and frame 3 neutral: the host runs its word; the guest, which
  // ran frame 3 with the player's input, runs it again.
  run cutAboveTheReplayTest =
    if (HOST_MID_REPLAY)
      initWith(Map(0 -> 0, 1 -> 0, 2 -> 1, 3 -> 1, 4 -> 1, 5 -> 1), STILL)
        .then(deliverFirst("host", 0)).then(deliverFirst("host", 1))
        .then(deliverFirst("guest", 0)).then(deliverFirst("guest", 1))
        .then(deliverFirst("guest", 2)).then(deliverFirst("guest", 3))
        .then(stepFrame("host")).then(stepFrame("guest")).then(stepFrame("host")).then(stepFrame("guest"))
        .then(stepFrame("host")).then(stepFrame("guest"))
        .then(hostOtherRoster)
        .expect(lastRoster == 3)
        .then(stepFrame("host")).then(stepFrame("guest"))
        .expect(applied.get("host").get(2) == 0)
        .then(deliverFirst("host", 2))
        .expect(replayAt.get("host") == 2)
        .then(hostCut)
        .expect(cutR == 3 and word.get(2) == 1)
        .then(replayStep("host")).then(replayStep("host"))
        .expect(
          not(replaying("host")) and applied.get("host").get(2) == 1 and applied.get("host").get(3) == 0
          and hostRunsItsWord
        )
        .then(deliver)
        .expect(rerunFrom == 3)
        .then(rerun)
        .expect(allHold)
    else
      initWith(MOVING, STILL)

  // The guest is replaying from frame 1 when the roster cutting at frame 2
  // reaches it: its late check reads frame 0 only (below its replay's
  // frame) and finds nothing to run again; the replay runs frame 1 with the
  // host's input and frame 2 neutral.
  run guestHearsMidReplayTest =
    if (HOST_MID_REPLAY)
      initWith(MOVING, STILL)
        .then(deliverFirst("host", 0)).then(deliverFirst("host", 1))
        .then(deliverFirst("guest", 0)).then(deliverFirst("guest", 1)).then(deliverFirst("guest", 2))
        .then(stepFrame("host")).then(stepFrame("guest")).then(stepFrame("host")).then(stepFrame("guest"))
        .then(stepFrame("guest"))
        .then(hostCut)
        .expect(cutR == 2)
        .then(replay("guest", 2))
        .then(deliver)
        .expect(rerunFrom < 0 and replayAt.get("guest") == 1)
        .then(replayStep("guest")).then(replayStep("guest"))
        .expect(allHold and applied.get("guest").get(1) == 1 and applied.get("guest").get(2) == 0)
    else
      initWith(MOVING, STILL)

  // Delay 1: the host cuts the player at frame 1 (C = 1) and admits it again
  // at once, so the admission's floor is tag 2 = C + 1, a tag the cut fed
  // neutral for. The host runs frame 2 on that neutral input before the
  // player's input of tag 2 comes; taken in over a real input, it runs
  // nothing again. A joiner that sends its input (1) there leaves the host
  // with the neutral it ran; one that holds its own input neutral below its
  // roster frame + LEAD sends the neutral that ran.
  run delayOneCollisionTest =
    if (COLLIDE and DELAY == 1)
      initWith(MOVING, MOVING)
        .then(deliverFirst("host", 0))
        .then(stepFrame("host")).then(stepFrame("guest"))
        .then(hostCut)
        .then(hostAdmit)
        .expect(cutR == 1 and admitA == 2 and collides(2))
        .then(stepFrame("host")).then(stepFrame("guest"))
        .then(stepFrame("host"))
        .expect(applied.get("host").get(2) == 0)
        .then(deliverSecond("host", 2))
        .expect(
          applied.get("host").get(2) == 0 and
          (if (JOINER_HOLDS) joinerInputRuns and madeSecond.get(2) == 0 else not(joinerInputRuns))
        )
    else
      initWith(MOVING, STILL)
}

// Before: each page cut the player when it learned of the removal.
module removed_input_before {
  import removed_input(AT_FRAME = false, HOST_MID_REPLAY = false, DELAY = 0, COLLIDE = false, JOINER_HOLDS = false).*
}

// The fix: the cut at the host's roster frame, the host's inputs below it.
module removed_input_fixed {
  import removed_input(AT_FRAME = true, HOST_MID_REPLAY = false, DELAY = 0, COLLIDE = false, JOINER_HOLDS = false).*
}

// The fix with replays run a frame at a time: a host (or guest) can be in
// the middle of one when the cut is made (or heard).
module removed_input_mid_replay {
  import removed_input(AT_FRAME = true, HOST_MID_REPLAY = true, DELAY = 0, COLLIDE = false, JOINER_HOLDS = false).*
}

// Delay 1, the cut's neutral inputs as real entries, and a joiner that sends
// what it makes from its floor on: the admission's first tag is the cut's
// C + 1 (violated: delayOneCollisionTest).
module removed_input_delay_one_unheld {
  import removed_input(AT_FRAME = true, HOST_MID_REPLAY = false, DELAY = 1, COLLIDE = true, JOINER_HOLDS = false).*
}

// Today, on the scheduled rule: the same, with the joiner's hold (#330).
module removed_input_delay_one_fixed {
  import removed_input(AT_FRAME = true, HOST_MID_REPLAY = false, DELAY = 1, COLLIDE = true, JOINER_HOLDS = true).*
}
