// -*- mode: Bluespec; -*-
//
// A channel that dies in a match with no event: the mesh health check in
// web/static/netplay-rollback.js, the staleness clocks (ROLLBACK-STALL,
// PEER-PHANTOM) and what a reconnect does on the guest (resetPeerState,
// the immediate resync request, PEER-RECOVERED).
//
// The health check, every 300 frames, reconnects a player the server lists
// but whose channel does not read open: a close no handler heard. It sits in
// the JS lockstep part of tick(), which a C-rollback tick returns before
// (#232's lockstep mode runs through the C branch too). So in a match on the
// patched core it never runs: the channel goes stale, the sim freezes at
// ROLLBACK_STALL_MS (3 s), the player is a phantom at PEER_DEAD_MS (5 s),
// the match runs on predicting them, and nothing ever reconnects them. Only
// their inputs arriving again clear the phantom, and none can (C_TICK_CHECK
// false: aDeadChannelIsNeverForgotten VIOLATED, phantomForeverTest).
//
// Run on C ticks alone it is not enough: frames do not advance while the sim
// is frozen, so by the first check after the death the player is usually a
// phantom already, and the check skips phantoms (HEAL_PHANTOMS false: the
// same property VIOLATED, checkAfterThePhantomTest). The fix runs it on C
// ticks and heals a phantom whose channel does not read open.
//
// Who heals is the per-peer machine's decision (specs/peer_connection.qnt,
// peer_connection_heal_one_side): the lower slot resets the entry and offers;
// the higher slot takes the channel for a drop (_handlePeerDisconnect: the
// entry is reconnecting, the 45 s give-up armed) and waits for that offer.
//
// A reconnect after the player was a phantom must end in a resync: the guest
// ran on predicted inputs past the rollback window. And in one: a second
// request while the first answer is on its way races two states. The guest's
// channel-open handler for a reconnecting entry runs resetPeerState (the
// phantom flag and the staleness clock go) and asks for an immediate resync;
// a guest whose entry was not reconnecting asks through PEER-RECOVERED, on
// the first input from a phantom. The ordering checked: the channel opens,
// the open handler runs, then the first input arrives. Without the reset at
// open the first input finds the phantom flag and asks again
// (RESET_ON_OPEN false: atMostOneResyncPerReconnect VIOLATED,
// secondRequestTest).
//
// What is modelled: two players, the lower ("lo", the host) and the higher
// ("hi", a guest); the link dying once, each side's channel then reading
// closed or still open; each side's staleness, fresh -> stalled (frames
// frozen) -> phantom (frames advance without them); the health check where
// frames advance; the offer connecting or failing; the higher side's
// give-up; the guest's resync requests.
//
// Not modelled: the signaling of the offer itself, crossed offers, attempt
// ids and old pages (specs/peer_connection.qnt), the resync's own deadlines
// (specs/resync_flow.qnt, specs/resync_reask.qnt), more than two players,
// and a channel that still reads open on both sides while nothing arrives:
// no health check can see that one (theDeadChannelIsSeen below scopes the
// property to a channel one side reads as closed).
//
// Which way an edge errs: when only the higher side ever reads the channel
// closed, it waits for an offer the lower side never sends and gives the
// player up at 45 s (higherAloneSeesItTest), where both slots healing would
// have reconnected. Today, on C ticks, nothing happens at all.

module mesh_heal {
  const C_TICK_CHECK: bool
  const HEAL_PHANTOMS: bool
  const RESET_ON_OPEN: bool

  pure val SIDES = Set("lo", "hi")

  var linkUp: bool
  var reads: str -> str          // what each side's channel reads: "open" or "closed"
  var stale: str -> str          // each side's view of the other: "fresh", "stalled", "phantom", "reset"
  var pending: str -> str        // "none", "offering" (lo), "waiting" (hi)
  var dropped: bool              // the higher side gave the player up
  var died: bool                 // the link has died (once)
  var wasPhantom: bool           // the guest ran on as if the host were gone
  var reconnects: int
  var requests: int              // the guest's resync requests since the last reconnect
  var inputSeen: bool            // the guest has had an input since the reconnect

  action init = all {
    linkUp' = true,
    reads' = SIDES.mapBy(_ => "open"),
    stale' = SIDES.mapBy(_ => "fresh"),
    pending' = SIDES.mapBy(_ => "none"),
    dropped' = false, died' = false, wasPhantom' = false,
    reconnects' = 0, requests' = 0, inputSeen' = true,
  }

  action keepRest = all {
    dropped' = dropped, died' = died, wasPhantom' = wasPhantom,
    reconnects' = reconnects, requests' = requests, inputSeen' = inputSeen,
  }

  // The link dies with no event; each side's channel reads closed or still open.
  action die(lo: str, hi: str): bool = all {
    linkUp, not(died),
    linkUp' = false,
    reads' = Map("lo" -> lo, "hi" -> hi),
    stale' = stale, pending' = pending,
    dropped' = dropped, died' = true, wasPhantom' = wasPhantom,
    reconnects' = reconnects, requests' = requests, inputSeen' = inputSeen,
  }

  // A side's channel comes to read closed later (the transport's own timeout).
  action readsClosed(s: str): bool = all {
    not(linkUp), reads.get(s) == "open",
    reads' = reads.set(s, "closed"),
    linkUp' = linkUp, stale' = stale, pending' = pending, keepRest,
  }

  // Staleness: no input for 3 s freezes the sim; 5 s makes the player a
  // phantom and frames advance again. A reconnecting entry is not an input
  // peer, and a reset one is not until its first input: neither goes stale.
  def staleAfter(s: str): str = if (stale.get(s) == "fresh") "stalled" else "phantom"
  action staler(s: str): bool = all {
    not(linkUp), not(dropped), pending.get(s) != "waiting",
    or { stale.get(s) == "fresh", stale.get(s) == "stalled" },
    stale' = stale.set(s, staleAfter(s)),
    wasPhantom' = (wasPhantom or (s == "hi" and staleAfter(s) == "phantom")),
    linkUp' = linkUp, reads' = reads, pending' = pending,
    dropped' = dropped, died' = died, reconnects' = reconnects, requests' = requests, inputSeen' = inputSeen,
  }

  // The health check runs on this side: frames advance (not frozen), and on a
  // C tick only in the fix.
  def framesAdvance(s: str): bool = stale.get(s) != "stalled"
  def checkActs(s: str): bool = and {
    C_TICK_CHECK, not(dropped), framesAdvance(s),
    reads.get(s) != "open",
    pending.get(s) == "none",
    stale.get(s) != "phantom" or HEAL_PHANTOMS,
  }

  action check(s: str): bool = all {
    checkActs(s),
    if (s == "lo") all {
      // resetPeerState: the staleness clock goes; the new entry is not an
      // input peer until its first input.
      pending' = pending.set("lo", "offering"),
      stale' = stale.set("lo", "reset"),
    } else all {
      // _handlePeerDisconnect: reconnecting, the give-up armed.
      pending' = pending.set("hi", "waiting"),
      stale' = stale,
    },
    linkUp' = linkUp, reads' = reads, keepRest,
  }

  // The lower side's offer connects. The guest's open handler: a
  // reconnecting entry resets and asks for an immediate resync.
  def hiReconnecting: bool = pending.get("hi") == "waiting"
  action connect = all {
    pending.get("lo") == "offering", not(dropped),
    linkUp' = true,
    reads' = SIDES.mapBy(_ => "open"),
    pending' = SIDES.mapBy(_ => "none"),
    stale' = stale.set("lo", "reset")
                  .set("hi", if (hiReconnecting and RESET_ON_OPEN) "reset" else stale.get("hi")),
    requests' = if (hiReconnecting) 1 else 0,
    inputSeen' = false,
    reconnects' = reconnects + 1,
    dropped' = dropped, died' = died, wasPhantom' = wasPhantom,
  }

  // The offer gets no answer (the attempt's deadline): the lower side has no
  // channel, which reads as not open, and its check may offer again.
  action offerFails = all {
    pending.get("lo") == "offering", not(linkUp),
    pending' = pending.set("lo", "none"),
    reads' = reads.set("lo", "closed"),
    linkUp' = linkUp, stale' = stale, keepRest,
  }

  // The first input from the host after the reconnect. A phantom flag still
  // set is PEER-RECOVERED: a guest asks for a coordinated resync.
  action firstInput = all {
    linkUp, not(inputSeen),
    inputSeen' = true,
    requests' = if (stale.get("hi") == "phantom") requests + 1 else requests,
    stale' = SIDES.mapBy(_ => "fresh"),
    linkUp' = linkUp, reads' = reads, pending' = pending,
    dropped' = dropped, died' = died, wasPhantom' = wasPhantom, reconnects' = reconnects,
  }

  // The higher side's 45 s give-up: hardDisconnectPeer.
  action giveUp = all {
    pending.get("hi") == "waiting", not(linkUp), not(dropped),
    dropped' = true,
    pending' = pending.set("hi", "none"),
    linkUp' = linkUp, reads' = reads, stale' = stale,
    died' = died, wasPhantom' = wasPhantom, reconnects' = reconnects, requests' = requests, inputSeen' = inputSeen,
  }

  action step = any {
    nondet lo = Set("open", "closed").oneOf()
    nondet hi = Set("open", "closed").oneOf()
    die(lo, hi),
    nondet s = SIDES.oneOf()
    any { readsClosed(s), staler(s), check(s) },
    connect,
    offerFails,
    firstInput,
    giveUp,
  }

  // ── Properties ───────────────────────────────────────────────────────────

  // One side reads the dead channel as closed: a health check can see it.
  val theDeadChannelIsSeen = not(linkUp) and SIDES.exists(s => reads.get(s) != "open")
  // Nothing on its own will change this any more: both sides are done going
  // stale (phantom, or reset with no input to come).
  val settled = SIDES.forall(s => stale.get(s) == "phantom" or stale.get(s) == "reset")
  def recoveryUnderWay: bool = or {
    pending.get("lo") == "offering",
    pending.get("hi") == "waiting",
    SIDES.exists(s => checkActs(s)),
  }
  // A dead channel a side can see is reconnected, or the player is dropped
  // under a deadline: it never settles into a phantom kept for the match.
  val aDeadChannelIsNeverForgotten =
    (theDeadChannelIsSeen and settled and not(dropped)) implies recoveryUnderWay

  // A reconnect after the guest ran on as if the host were gone ends in a resync.
  val aPhantomReconnectEndsInAResync =
    (linkUp and reconnects > 0 and wasPhantom and inputSeen) implies requests >= 1
  // And in one: a second request races two states.
  val atMostOneResyncPerReconnect = requests <= 1

  val allHold = and {
    aDeadChannelIsNeverForgotten, aPhantomReconnectEndsInAResync, atMostOneResyncPerReconnect,
  }

  // ── Scenarios ────────────────────────────────────────────────────────────

  // Both channels read closed (as HEAL_BOTH_SIDES makes them); both sides
  // go stale to phantoms.
  run bothPhantomsTest =
    init
      .then(die("closed", "closed"))
      .then(staler("lo")).then(staler("lo"))
      .then(staler("hi")).then(staler("hi"))

  // Today: nothing ever reconnects them.
  run phantomForeverTest =
    bothPhantomsTest
      .expect(aDeadChannelIsNeverForgotten == (C_TICK_CHECK and HEAL_PHANTOMS))

  // The fix: the lower side offers, the higher side waits, the reconnect ends
  // in one resync. Without HEAL_PHANTOMS neither check can act on a phantom.
  run checkAfterThePhantomTest =
    if (C_TICK_CHECK and HEAL_PHANTOMS)
      bothPhantomsTest
        .then(check("lo")).then(check("hi")).then(connect).then(firstInput)
        .expect(reconnects == 1 and requests == (if (RESET_ON_OPEN) 1 else 2))
        .expect(aPhantomReconnectEndsInAResync and aDeadChannelIsNeverForgotten)
    else
      bothPhantomsTest
        .expect(not(checkActs("lo")) and not(checkActs("hi")))

  // The ordering for the second-request race: the guest waits as a phantom,
  // the channel opens, its open handler runs, then the first input.
  run secondRequestTest =
    if (C_TICK_CHECK and HEAL_PHANTOMS)
      bothPhantomsTest
        .then(check("hi")).then(check("lo")).then(connect).then(firstInput)
        .expect(atMostOneResyncPerReconnect == RESET_ON_OPEN)
        .expect(aPhantomReconnectEndsInAResync)
    else
      bothPhantomsTest

  // A heal before the stall: the lower side's check lands before it froze.
  // Today's check never runs on a C tick.
  run healBeforeTheStallTest =
    if (C_TICK_CHECK)
      init
        .then(die("closed", "open"))
        .then(check("lo")).then(connect).then(firstInput)
        .expect(reconnects == 1 and requests == 0 and not(wasPhantom) and allHold)
    else
      init
        .then(die("closed", "open"))
        .expect(not(checkActs("lo")))

  // Only the higher side reads it closed: it waits and gives the player up.
  run higherAloneSeesItTest =
    if (C_TICK_CHECK and HEAL_PHANTOMS)
      init
        .then(die("open", "closed"))
        .then(staler("hi")).then(staler("hi"))
        .then(check("hi")).then(giveUp)
        .expect(dropped and reconnects == 0 and aDeadChannelIsNeverForgotten)
    else
      init
        .then(die("open", "closed"))
        .then(staler("hi")).then(staler("hi"))
        .expect(not(checkActs("hi")))
}

// Today: the check never runs on a C tick.
module mesh_heal_current {
  import mesh_heal(C_TICK_CHECK = false, HEAL_PHANTOMS = false, RESET_ON_OPEN = true).*
}

// The check moved onto C ticks but still skipping phantoms.
module mesh_heal_c_tick_only {
  import mesh_heal(C_TICK_CHECK = true, HEAL_PHANTOMS = false, RESET_ON_OPEN = true).*
}

// Without the guest's reset when the reconnected channel opens.
module mesh_heal_no_reset_on_open {
  import mesh_heal(C_TICK_CHECK = true, HEAL_PHANTOMS = true, RESET_ON_OPEN = false).*
}

// The fix.
module mesh_heal_fixed {
  import mesh_heal(C_TICK_CHECK = true, HEAL_PHANTOMS = true, RESET_ON_OPEN = true).*
}
