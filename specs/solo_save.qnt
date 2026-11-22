// The rollback engine's per-frame state save while a page plays alone
// (build/kn_rollback/kn_rollback.c: kn_pre_tick's save, kn_feed_input,
// rb_rollback_target, kn_rollback_slot_reset, kn_rollback_init).
//
// kn_pre_tick saves the state of the frame about to run into the ring on
// every frame. Only a rollback restores from the ring, and a rollback goes
// back to a frame only for an input the engine predicted:
// - kn_feed_input rolls back for a real input only when the engine predicted
//   that input (`predicted[slot][tag]`) and the prediction was wrong;
// - kn_pre_tick predicts a remote slot's input only once the slot is active,
//   that is, once kn_feed_input has had an input for it (`slot_active`);
//   kn_rollback_slot_reset (the player left) and kn_rollback_init (arming,
//   and the re-arm when a friend joins a solo match) make it inactive again;
// - the rollback's target is the first frame, from the input's tag on, that
//   applied that tag or a later one (rb_rollback_target). Every frame records
//   the tag it applied, so that is the frame whose kn_pre_tick predicted it.
//   A frame before the last kn_rollback_init has no record and stops the
//   search early; that frame is not in the ring either, today as with the
//   gate.
// So while no remote slot is active, no later input can roll back to the
// frame about to run, and its save is never read by a rollback. A page alone
// in a match (at a delay of 0 since PR A) pays for one every frame.
//
// The gate: kn_pre_tick skips the save while no slot but the page's own is
// active. The sparse save mode (knDiag.setDeltaSaveSparse, off by default)
// writes only the blocks that differ from a baseline, the last state saved;
// a restore takes every other block from the copies filed before it.
// specs/ring_after_resync.qnt's condition for such a copy (everyCopyIsWhole)
// is that the baseline is the copy of the frame before the one saved. After
// a skipped stretch it is older than that. The restore's walk back through
// the ring may well rebuild that copy right, since the diff is taken against
// the baseline's own contents, but nothing checks that it does. So a skipped
// save forgets the baseline and the first save after the stretch is whole,
// as after kn_set_frame. In the default (full) mode nothing reads it.
//
// What the ring holds is compared with what it holds today (`everyFrame`:
// every frame since the last kn_rollback_init). The gate must not lose a
// rollback target today's ring has.
//
// Rejected: a switch JS sets from the room's roster ("alone" while no other
// player is listed). The roster comes over Socket.IO and a player's first
// input over its data channel, in either order: a page that hears the input
// first predicts that player's inputs while the roster still says alone, and
// a misprediction there rolls back to a frame it did not save.
//
// Not modelled: what a state is beyond which frame it is of, more than one
// remote player (any one active keeps the saves), the ring's size and the
// rollback depth cap (both bound targets the same way with or without the
// gate), the input values (a fed input is right or wrong about its
// prediction), replays beyond their saves.
//
// SKIP: "never" (today), "roster" (the rejected JS switch), "slots" (the gate
// on the C engine's own slot_active).
// FORGET_BASELINE_ON_SKIP: a skipped save forgets the sparse baseline.
module solo_save {
  const SKIP: str
  const FORGET_BASELINE_ON_SKIP: bool

  pure val MAX_FRAME = 6
  pure val MAX_TAG = 6
  pure val NONE = -1
  pure val MATCH_DELAY = 1 // the delay a friend's join moves a solo match to

  var frame: int            // rb.frame: the frame about to run
  var delay: int            // rb.delay_frames
  var joined: bool          // another player is in the match
  var rosterAlone: bool     // what the room's roster last told JS
  var active: bool          // rb.slot_active of the other player's slot
  var fed: Set[int]         // the other player's tags with a real input
  var predicted: Set[int]   // tags predicted and not yet corrected
  var applied: int -> int   // frame -> the tag it applied, since the last init
  var ring: Set[int]        // frames saved since the last init
  var everyFrame: Set[int]  // the ring today: every frame since the last init
  var baseline: int         // the frame the sparse baseline is a copy of; NONE: forgotten
  var copiesWhole: bool     // every save so far was whole or diffed against the frame before
  var lost: bool            // a rollback's target was in today's ring and not in this one

  // kn_rollback_init at frame `f` with delay `d`: the ring, the tags and the
  // slots start over (memset of the engine's state).
  action armAt(f: int, d: int, isJoined: bool, alone: bool): bool = all {
    frame' = f, delay' = d, joined' = isJoined, rosterAlone' = alone,
    active' = false, fed' = Set(), predicted' = Set(), applied' = Map(),
    ring' = Set(), everyFrame' = Set(), baseline' = NONE,
    copiesWhole' = true, lost' = false,
  }

  // Alone in the room, at a delay of 0; or with another player from the
  // start, at the match delay.
  action init = any {
    armAt(0, 0, false, true),
    armAt(0, MATCH_DELAY, true, false),
  }

  def savesNow: bool =
    if (SKIP == "never") true
    else if (SKIP == "roster") not(rosterAlone)
    else active

  // kn_pre_tick, then the frame runs: record the tag this frame applies,
  // predict it for an active slot whose input is not here, save or skip.
  action tick = all {
    frame < MAX_FRAME,
    val tag = frame - delay
    val predicts = active and tag >= 0 and not(fed.contains(tag))
    val saves = savesNow
    all {
      applied' = applied.put(frame, tag),
      predicted' = if (predicts) predicted.union(Set(tag)) else predicted,
      ring' = if (saves) ring.union(Set(frame)) else ring,
      everyFrame' = everyFrame.union(Set(frame)),
      baseline' = if (saves) frame else if (FORGET_BASELINE_ON_SKIP) NONE else baseline,
      copiesWhole' = (copiesWhole and (not(saves) or baseline == NONE or baseline == frame - 1)),
      frame' = frame + 1,
      delay' = delay, joined' = joined, rosterAlone' = rosterAlone, active' = active,
      fed' = fed, lost' = lost,
    }
  }

  // rb_rollback_target: the first frame from the tag on, before the frame
  // about to run, that has no record or applied the tag or a later one.
  def rollbackTarget(tag: int): int =
    0.to(MAX_FRAME)
      .filter(f => f >= tag and f < frame and (not(applied.keys().contains(f)) or applied.get(f) >= tag))
      .fold(NONE, (best, f) => if (best == NONE or f < best) f else best)

  // kn_feed_input: the other player's real input for `tag` arrives, right or
  // wrong about the prediction if there was one. It makes the slot active. A
  // wrong prediction for a frame already run rolls back to the target, if
  // the ring has it, and the replay saves every frame from there again.
  action feed(tag: int, wrong: bool): bool = all {
    joined, not(fed.contains(tag)),
    val rollsBack = predicted.contains(tag) and wrong and tag < frame
    val target = if (rollsBack) rollbackTarget(tag) else NONE
    val restores = target != NONE and ring.contains(target)
    all {
      active' = true,
      fed' = fed.union(Set(tag)),
      predicted' = predicted.exclude(Set(tag)),
      lost' = (lost or (target != NONE and everyFrame.contains(target) and not(ring.contains(target)))),
      ring' = if (restores) ring.union(0.to(MAX_FRAME).filter(f => f >= target and f < frame)) else ring,
      baseline' = if (restores) frame - 1 else baseline,
      frame' = frame, delay' = delay, joined' = joined, rosterAlone' = rosterAlone,
      applied' = applied, everyFrame' = everyFrame, copiesWhole' = copiesWhole,
    }
  }

  // The other player leaves: kn_rollback_slot_reset forgets the slot.
  action leave = all {
    joined,
    joined' = false, active' = false, fed' = Set(), predicted' = Set(),
    frame' = frame, delay' = delay, rosterAlone' = rosterAlone, applied' = applied,
    ring' = ring, everyFrame' = everyFrame, baseline' = baseline,
    copiesWhole' = copiesWhole, lost' = lost,
  }

  // A player joins. Into a match at 0 (the page played alone), the host arms
  // again at the join frame with the match delay (PR A's re-arm); into a
  // match above 0 (the others left), nothing re-arms.
  action join = all {
    not(joined),
    if (delay == 0) armAt(frame, MATCH_DELAY, true, rosterAlone)
    else all {
      joined' = true,
      frame' = frame, delay' = delay, rosterAlone' = rosterAlone, active' = active,
      fed' = fed, predicted' = predicted, applied' = applied, ring' = ring,
      everyFrame' = everyFrame, baseline' = baseline, copiesWhole' = copiesWhole, lost' = lost,
    },
  }

  // The roster reaches JS (users-updated), in any order with the inputs.
  action rosterArrives = all {
    rosterAlone != not(joined),
    rosterAlone' = not(joined),
    frame' = frame, delay' = delay, joined' = joined, active' = active,
    fed' = fed, predicted' = predicted, applied' = applied, ring' = ring,
    everyFrame' = everyFrame, baseline' = baseline, copiesWhole' = copiesWhole, lost' = lost,
  }

  action step = any {
    tick,
    nondet tag = 0.to(MAX_TAG).oneOf()
    nondet wrong = Set(true, false).oneOf()
    feed(tag, wrong),
    leave,
    join,
    rosterArrives,
  }

  // ── Properties ────────────────────────────────────────────────────────

  // A rollback finds every frame today's ring would have given it. Violated
  // with the roster switch: the input comes before the roster.
  val noTargetLostToTheGate = not(lost)

  // Every save is whole or diffed against the copy of the frame before it.
  // Violated when a skipped save keeps the baseline.
  val everyCopyIsWhole = copiesWhole

  val allHold = noTargetLostToTheGate and everyCopyIsWhole

  // ── Scenarios ─────────────────────────────────────────────────────────

  // Alone: no frame is saved with the gate. A friend joins (the re-arm moves
  // the match to delay 1), the friend's first input comes, the page predicts
  // the next one, and it turns out wrong: the rollback finds its frame.
  run soloThenFriendTest =
    armAt(0, 0, false, true).then(tick).then(tick).then(tick)
      .expect(ring == (if (SKIP == "never") Set(0, 1, 2) else Set()))
      .then(join).then(rosterArrives).then(feed(2, false))
      .then(tick).then(tick)
      .expect(predicted == Set(3))
      .then(feed(3, true))
      .expect(not(lost) and ring.contains(4))

  // The friend's first input comes before the roster says they are in.
  // With the roster switch, the frame that predicted their next input was not
  // saved, and the rollback for it has nothing to go back to.
  run inputBeforeRosterTest =
    armAt(0, 0, false, true).then(join).then(feed(5, false))
      .then(tick).then(tick)
      .expect(predicted == Set(0))
      .then(feed(0, true))
      .expect(lost == (SKIP == "roster"))

  // A match of two; the other player leaves and the page plays alone; they
  // come back (no re-arm above 0). Saves stop while they are gone and start
  // again with their first input; a rollback after that finds its frame.
  run leaveAndReturnTest =
    armAt(0, MATCH_DELAY, true, false).then(feed(0, false)).then(tick).then(tick)
      .then(leave).then(rosterArrives).then(tick)
      .expect(ring == Set(0, 1, 2) or SKIP != "never")
      .expect(SKIP == "never" or not(ring.contains(2)))
      .then(join).then(rosterArrives).then(feed(2, false)).then(tick).then(tick)
      .expect(predicted == Set(3))
      .then(feed(3, true))
      .expect(not(lost) and ring.contains(4))

  // The first save after a skipped stretch. Keeping the baseline, it is
  // diffed against a copy older than the frame before it.
  run firstSaveAfterAStretchTest =
    armAt(0, MATCH_DELAY, true, false).then(feed(0, false)).then(tick)
      .then(leave).then(tick)
      .then(join).then(feed(1, false)).then(tick)
      .expect(copiesWhole == (SKIP == "never" or FORGET_BASELINE_ON_SKIP))

  // An input for a frame the page ran while the slot was inactive (the
  // late join primes such inputs with zeros): nothing was predicted for it,
  // so nothing rolls back.
  run inputForAnUnpredictedFrameTest =
    armAt(0, 0, false, true).then(tick).then(tick).then(join).then(tick).then(tick)
      .then(feed(1, true))
      .expect(not(lost) and predicted == Set())
}

// Today: kn_pre_tick saves every frame.
module solo_save_before {
  import solo_save(SKIP = "never", FORGET_BASELINE_ON_SKIP = false).*
}

// Rejected: JS switches the saves off while the roster says the page is
// alone. A player's first input can come before the roster that lists them.
module solo_save_roster {
  import solo_save(SKIP = "roster", FORGET_BASELINE_ON_SKIP = true).*
}

// The gate without forgetting the baseline: the first save after a skipped
// stretch is diffed against a copy older than the frame before it.
module solo_save_keep_baseline {
  import solo_save(SKIP = "slots", FORGET_BASELINE_ON_SKIP = false).*
}

// The gate: kn_pre_tick skips the save while no other slot is active, and a
// skipped save forgets the sparse baseline.
module solo_save_current {
  import solo_save(SKIP = "slots", FORGET_BASELINE_ON_SKIP = true).*
}
