// -*- mode: Bluespec; -*-
//
// What every page applies, slot by slot and tag by tag, around a player's
// join into a running match (a new player or one the host removed coming
// back): handleLateJoinState on the joiner, _broadcastRoster on the host,
// the `roster:` handler on a guest, _startLateJoinInputBootstrap and
// _beginLateJoinOriginalWait in web/static/netplay-rollback.js;
// web/src/late-join-input-rule.ts.
//
// The engine applies a slot's input of tag t on frame t + delay. The joiner
// loads the host's state of frame H and applies tags from H - delay on. The
// host admits it at its roster frame R >= H (the roster that lists it);
// every page holds the joiner's tags below R as absent (neutral) and takes
// its inputs from R on (late_join_input_admission.qnt).
//
// Before (today on Smash Remix): every page that learns of the join (the
// joiner when it loads the state, the others when they hear the roster) runs
// a "bootstrap" from the frame IT is on then, `heard`:
//   - it holds its own input neutral for the tags it makes from `heard` up to
//     heard + RAMP (the tags it made before hearing were real and sent);
//   - it seeds a neutral placeholder for every other slot over
//     [heard - delay - 2, heard + RAMP], fed to the C engine as a real input,
//     wherever it holds no input yet. A real input arriving after the frame
//     that applied the placeholder ran does not roll back (kn_feed_input
//     compares only a prediction), so the page keeps the neutral one.
//   - the joiner receives no input of a player below that player's first live
//     packet to it (`firstLive`), and on Remix the host sends it none of its
//     own (the late-join input bridge is skipped there): those tags run as
//     placeholders (joinerMissesTheTagsBelowFirstLiveTest; the four-player
//     rejoin run, P4's frames 1118-1123).
// Pages hear at different frames, so the windows differ: a page whose window
// reaches past another's ran a placeholder where the other ran the real input
// (pagesHearAtDifferentFramesTest; the same run, tags 1142-1145).
//
// FIXED (the scheduled roster rule, a match every page of which runs this
// version, controller_mask.qnt's oneRulePerMatch):
//   - no page seeds a placeholder or holds its own input for a join: a page
//     predicts an input it does not hold, and the real one corrects the
//     prediction (a rollback);
//   - the joiner gets the inputs it cannot receive live from the host's state
//     message (the late-join input bridge, now on every ROM) and waits for,
//     and asks for, each original player's real input from H - delay up to
//     the end of the bridge window (late_join_input_bridge.qnt,
//     late_join_input_bootstrap.qnt): it applies the inputs the host applied;
//   - the joiner holds its own input neutral for every tag it makes before it
//     has heard the roster that admits it, and for every tag below
//     R + LEAD, the frame its controller is present from on every page
//     (controller_mask.qnt, MASK_LEAD): one window, derived from R, for every
//     page, which the joiner alone has to keep (it sends those inputs);
//   - a page that hears the roster after it has applied a joiner tag of
//     R + LEAD or later (it ran it as absent) asks the host for its state,
//     as it does for the controller mask heard late
//     (aPageThatHearsLateTakesTheHostsStateTest).
//
// What is modelled: the host, one other original player, the joiner; each
// original player's inputs real and moving on every tag it does not hold
// (the worst case for a placeholder); the joiner's moving once it no longer
// holds; the frame each page hears of the join; the first tag of each
// original player the joiner receives live; how long an input takes to
// arrive (in frames; one value for the match). Not modelled: the rollback
// engine's depth limit (a deeper misprediction is a failed rollback, as
// everywhere), a prediction other than "the real input arrives and corrects
// it", the host's state loaded by a late page (its applied inputs become the
// host's).
module late_join_input_agreement {
  const FIXED: bool

  pure val DELAY = 1
  // LATE_JOIN_INPUT_BOOTSTRAP_FRAMES, scaled down for the model.
  pure val RAMP = 3
  // MASK_LEAD, scaled down for the model.
  pure val LEAD = 5
  pure val R = 6
  pure val MAX_T = 20
  pure val TAGS = 0.to(MAX_T - 1)

  // Pages are slots: 0 the host, 1 another original player, 2 the joiner.
  pure val HOST = 0
  pure val JOINER = 2
  pure val SLOTS = Set(0, 1, 2)
  pure val ORIGINALS = Set(0, 1)
  pure val NEUTRAL = 0
  pure val MOVING = 1

  // The frame of the joiner's state (H <= R), the frame each page hears of
  // the join (the host at R; the joiner when it loads the state, at H, and
  // the roster at heardRoster), the first tag of each original player the
  // joiner receives live, and how many frames an input takes to arrive.
  var stateFrame: int
  var heard: int -> int
  var joinerHeardRoster: int
  var firstLive: int -> int
  var latency: int

  pure def inRange(t: int, lo: int, hi: int): bool = t >= lo and t <= hi
  pure def maxInt(a: int, b: int): int = if (a > b) a else b

  // ── What each player sends for tag t ──────────────────────────────────
  def sent(s: int, t: int): int =
    if (s == JOINER)
      if (FIXED)
        if (t < maxInt(joinerHeardRoster, R + LEAD)) NEUTRAL else MOVING
      else
        // The joiner's bootstrap from its state frame, and its preset
        // neutral tags [H - delay, H + delay].
        if (t <= stateFrame + maxInt(RAMP, DELAY)) NEUTRAL else MOVING
    else if (not(FIXED) and inRange(t, heard.get(s), heard.get(s) + RAMP)) NEUTRAL
    else MOVING

  // ── What page p applies for slot s on tag t ───────────────────────────
  def seededBefore(p: int, s: int, t: int): bool =
    not(FIXED) and s != p
      and inRange(t, heard.get(p) - DELAY - 2, heard.get(p) + RAMP)
      // An existing page already held the inputs that arrived before it
      // heard; the joiner held none.
      and (p == JOINER or t + latency > heard.get(p))

  // A late page: it ran a joiner tag at or past the joiner's hold as absent.
  def lateForTheJoin(p: int): bool =
    FIXED and p != JOINER and p != HOST and heard.get(p) - DELAY - 1 >= R + LEAD

  def ownApplied(p: int, s: int, t: int): int =
    if (p == s) sent(s, t)
    else if (s == JOINER and t < R) NEUTRAL          // absent below the admission
    else if (p == JOINER and not(FIXED) and t < firstLive.get(s)) NEUTRAL  // never arrives
    else if (seededBefore(p, s, t))
      // A placeholder fed as real: replaced only when the real input
      // arrives before the frame that applies the tag runs.
      if (latency <= DELAY) sent(s, t) else NEUTRAL
    else if (p != JOINER and s == JOINER and t <= heard.get(p) - DELAY - 1)
      // Run before the page heard of the join: as absent.
      NEUTRAL
    else sent(s, t)                                  // held, or predicted and corrected

  def applied(p: int, s: int, t: int): int =
    if (lateForTheJoin(p)) ownApplied(HOST, s, t) else ownApplied(p, s, t)

  // The tags the joining page applies from its state on.
  def joinTags: Set[int] = TAGS.filter(t => t >= stateFrame - DELAY)

  // ── Properties ───────────────────────────────────────────────────────
  // From the frame of its state, the joiner applies for every other player
  // exactly what the host applied.
  val joinerAppliesTheHostsInputs =
    ORIGINALS.forall(s => joinTags.forall(t => applied(JOINER, s, t) == applied(HOST, s, t)))
  // Every page applies what the host applied, for every slot.
  val pagesAgreeAroundTheJoin =
    SLOTS.forall(p => SLOTS.forall(s => joinTags.forall(t => applied(p, s, t) == applied(HOST, s, t))))
  // The joiner's own input is neutral below the admission on its own page
  // too (others hold it absent there).
  val joinerNeutralBelowAdmission = joinTags.forall(t => t >= R or applied(JOINER, JOINER, t) == NEUTRAL)
  val allHold = joinerAppliesTheHostsInputs and pagesAgreeAroundTheJoin and joinerNeutralBelowAdmission

  action initWith(h: int, heardOther: int, heardRoster: int, live: int -> int, lat: int): bool = all {
    stateFrame' = h,
    heard' = Map(HOST -> R, 1 -> heardOther, JOINER -> h),
    joinerHeardRoster' = heardRoster,
    firstLive' = live,
    latency' = lat,
  }

  action init = {
    nondet h = (R - 5).to(R).oneOf()
    nondet heardOther = (R - 2).to(R + LEAD + 4).oneOf()
    nondet heardRoster = R.to(R + 4).oneOf()
    nondet live0 = (h - DELAY).to(h + 3).oneOf()
    nondet live1 = (h - DELAY).to(h + 3).oneOf()
    nondet lat = 0.to(3).oneOf()
    initWith(h, heardOther, heardRoster, Map(0 -> live0, 1 -> live1), lat)
  }

  action step = all {
    stateFrame' = stateFrame,
    heard' = heard,
    joinerHeardRoster' = joinerHeardRoster,
    firstLive' = firstLive,
    latency' = latency,
  }

  // The four-player rejoin run (Smash Remix, delay 3, scaled): the state and
  // the roster at R; the host's first live input to the joiner at R, the
  // other player's at R + 3, which heard of the join at R + 3. The joiner
  // ran the tags below each first input as placeholders where the host ran
  // the real ones.
  run joinerMissesTheTagsBelowFirstLiveTest =
    initWith(R, R + 3, R, Map(0 -> R, 1 -> R + 3), 2).then(step).expect(joinerAppliesTheHostsInputs == FIXED)

  // Two pages hear of the join at different frames (the other player three
  // frames after the host): its window reaches three tags past the host's,
  // and it runs the joiner's first real inputs as placeholders the host ran
  // as they were.
  run pagesHearAtDifferentFramesTest =
    initWith(R, R + 3, R, Map(0 -> R - DELAY, 1 -> R - DELAY), 2).then(step).expect(pagesAgreeAroundTheJoin == FIXED)

  // The roster comes after the state (the host resumed on the joiner's
  // Socket.IO ready and broadcast the roster when its channel opened, here
  // after the joiner's bootstrap ended): the joiner's tags below R are absent
  // on the other pages; before, the joiner ran its own real input on some of
  // them, and now it holds them neutral until it hears the roster.
  run rosterAfterTheStateTest =
    initWith(R - 5, R, R + 2, Map(0 -> R - 6, 1 -> R - 6), 0).then(step).expect(allHold == FIXED)

  // A page that hears of the join after it has run joiner tags past the
  // joiner's hold takes the host's state, and agrees.
  run aPageThatHearsLateTakesTheHostsStateTest =
    initWith(R, R + LEAD + 4, R + 4, Map(0 -> R - DELAY, 1 -> R - DELAY), 1).then(step).expect(
      allHold == FIXED and lateForTheJoin(1) == FIXED
    )
}

module late_join_input_agreement_before { import late_join_input_agreement(FIXED=false).* }
module late_join_input_agreement_fixed { import late_join_input_agreement(FIXED=true).* }
