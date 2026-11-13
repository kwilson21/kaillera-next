// -*- mode: Bluespec; -*-
//
// Peer connection lifecycle: the WebRTC connection between two players, as
// each of their pages sees it (web/static/netplay-rollback.js: onUsersUpdated,
// sendOffer, onWebRTCSignal, setupDataChannel, handlePeerDisconnect,
// attemptReconnect, hardDisconnectPeer and the mesh health check in tick()).
//
// Two pages, "lo" (the lower slot, the host) and "hi". Each keeps its own
// entry for the other and they only learn about each other through offers
// and answers relayed by the server, which may arrive late or not at all.
// The model checks that the two entries cannot be left waiting for ever,
// offering to each other at once, or wired to a connection that is gone.
// Today's engine can do all three; the properties at the end say how.
//
// What is modelled, and where it comes from:
//   roster          onUsersUpdated before the match: the lower slot offers
//   deliver         onWebRTCSignal: an offer (creating the entry on demand if
//                   the roster has not arrived yet) or an answer
//   lose            a signal sent while a socket was down is never delivered
//   channelOpens    the lockstep DataChannel's onopen
//   startupTimeout  the startup connect watchdog: 8 s, 3 attempts
//   start           the match begins
//   netDrop         the connection dies under both pages
//   notice          one page finds out (channel close, pc failed, the 3 s
//                   grace after pc disconnected): handlePeerDisconnect
//   oldChannelCloses  the close event of a channel whose connection was
//                   replaced by a reconnect offer. Chromium 153 fires it; the
//                   WebRTC spec says a local close skips the closing
//                   procedure, so it may also never come (closeNeverComes)
//   attemptTimeout  attemptReconnect's 10 s per attempt, 3 attempts
//   giveUpTimeout   handlePeerDisconnect's 45 s, then hardDisconnectPeer
//   answerTimeout   the 10 s timer of the page that answered a reconnect
//                   offer: it closes the connection and does nothing else
//   heal            the mesh health check (every 300 frames): no open channel
//                   to a player the roster lists and no reconnect in progress
//   rosterRenames   a roster listing the other player under a new socket id
//                   (#119; the rule itself is specs/peer_identity.qnt)
//
// Not modelled: more than two players, spectators, ICE candidates, a page
// reload (a fresh offer under a kept connection), a drop before the match
// starts, PEER-PHANTOM (which stops the health check for that slot), timers
// that outlive the entry they were armed for, and the tick loop.
//
// HEAL_ONE_SIDE: who the mesh health check runs for.
//   false  today: either page; both count the same frames, so both can heal
//          at once, and the higher slot can heal while the lower reconnects
//   true   proposed: only the page that initiates reconnects (the lower slot)
// ANSWERER_HAS_DEADLINE: a page that answers a reconnect offer.
//   false  today: marks the entry reconnecting; the 45 s give-up is armed
//          only if that page also noticed the drop itself
//   true   proposed: answering arms the give-up
// SIGNALS_CARRY_ATTEMPT: what an answer is applied to.
//   false  today: whatever connection the entry has now, if it is waiting
//          for an answer
//   true   proposed: only the connection that made the offer it answers
// ROSTER_KEEPS_LIVE: false = before #119, a roster under a new id replaced a
//   connection that was up.
module peer_connection {
  const HEAL_ONE_SIDE: bool
  const ANSWERER_HAS_DEADLINE: bool
  const SIGNALS_CARRY_ATTEMPT: bool
  const ROSTER_KEEPS_LIVE: bool

  pure val SIDES = Set("lo", "hi")
  pure def other(s: str): str = if (s == "lo") "hi" else "lo"
  pure val MAX_ATTEMPTS = 3
  // Offers are numbered; the bound keeps the model finite.
  pure val MAX_OFFERS = 7
  // `link` of a connection that took an answer meant for another one.
  pure val MISWIRED = -1

  // One page's entry for the other player (_peers[sid]).
  type Side = {
    has: bool,           // the entry exists
    made: int,           // the offer its connection made and awaits an answer to, 0 = none
    link: int,           // the offer its connection completed (offer and answer), 0 = none
    open: bool,          // the lockstep channel is open
    chan: bool,          // the entry holds a channel of its connection: one it
                         // created when it offered, or one that opened
    recon: bool,         // peer.reconnecting
    giveUp: bool,        // the 45 s give-up timer is armed
    attempt: int,        // the attempt whose timer is armed, 0 = none
    ansTimer: bool,      // the answerer's 10 s timer is armed
    closePending: bool,  // a replaced channel may still fire its close event
    dirty: bool,         // per-peer input state from before a drop
  }
  type Msg = { dest: str, kind: str, id: int }

  pure val ABSENT: Side = {
    has: false, made: 0, link: 0, open: false, chan: false, recon: false, giveUp: false,
    attempt: 0, ansTimer: false, closePending: false, dirty: false,
  }

  var side: str -> Side
  var wire: Set[Msg]       // signals the server has yet to deliver
  var nextId: int
  var dead: Set[int]       // connections the network has killed
  var running: bool        // the match is under way
  var stalled: bool        // the startup watchdog gave up and told the player
  var staleApplied: bool   // history: an answer was applied to a connection it was not made for
  var evictedLive: bool    // history: a roster update replaced a connection that was up

  // ── helpers ────────────────────────────────────────────────────────────

  def canOffer: bool = nextId <= MAX_OFFERS
  def offer(dest: str): Msg = { dest: dest, kind: "offer", id: nextId }

  // The connection `s` completed is the one the other page completed too,
  // and the network has not killed it.
  def alive(s: str): bool = and {
    side.get(s).link > 0,
    side.get(other(s)).link == side.get(s).link,
    not(dead.contains(side.get(s).link)),
  }

  // handlePeerDisconnect in a running match: mark the entry reconnecting, arm
  // the give-up; the lower slot replaces its connection and offers.
  pure def disconnected(who: str, s: Side, id: int): Side = {
    val marked = { ...s, open: false, chan: false, recon: true, giveUp: true, dirty: true, closePending: false }
    if (who == "lo") { ...marked, made: id, link: 0, chan: true, attempt: 1 } else marked
  }

  def healRunsFor(s: str): bool = not(HEAL_ONE_SIDE) or s == "lo"

  action unchangedHistory = all { staleApplied' = staleApplied, evictedLive' = evictedLive }
  action unchangedPhase = all { running' = running, stalled' = stalled, dead' = dead }

  // ── before the match ───────────────────────────────────────────────────

  // The roster reaches a page. The lower slot creates its entry and offers;
  // the higher slot creates its entry and waits. An entry made on demand by
  // an offer that arrived first is left as it is.
  action roster(s: str): bool = all {
    not(running),
    if (side.get(s).has) all { side' = side, wire' = wire, nextId' = nextId }
    else if (s == "lo") all {
      canOffer,
      side' = side.set(s, { ...ABSENT, has: true, made: nextId, chan: true, attempt: 1 }),
      wire' = wire.union(Set(offer(other(s)))),
      nextId' = nextId + 1,
    } else all {
      side' = side.set(s, { ...ABSENT, has: true }),
      wire' = wire, nextId' = nextId,
    },
    unchangedPhase, unchangedHistory,
  }

  // The startup watchdog: no open channel 8 s after the offer. Replace the
  // connection and offer again, three times, then tell the player.
  action startupTimeout = {
    val s = side.get("lo")
    all {
      not(running), s.has, not(s.open), s.attempt > 0,
      if (s.attempt < MAX_ATTEMPTS) all {
        canOffer,
        side' = side.set("lo", { ...s, made: nextId, link: 0, chan: true, attempt: s.attempt + 1 }),
        wire' = wire.union(Set(offer("hi"))),
        nextId' = nextId + 1,
        stalled' = stalled,
      } else all {
        side' = side.set("lo", { ...s, attempt: 0 }),
        wire' = wire, nextId' = nextId,
        stalled' = true,
      },
      running' = running, dead' = dead, unchangedHistory,
    }
  }

  action start = all {
    not(running), side.get("lo").open, side.get("hi").open,
    running' = true,
    side' = side, wire' = wire, nextId' = nextId, stalled' = stalled, dead' = dead,
    unchangedHistory,
  }

  // ── signals ────────────────────────────────────────────────────────────

  // An offer arrives. With no entry, one is made on demand. Before the match
  // the page just answers. In a match every offer is a reconnect offer: the
  // page replaces its connection (dropping an offer of its own), marks the
  // entry reconnecting, arms a timer that only closes the connection, and
  // answers. Replacing the connection closes the channels the entry held.
  action receiveOffer(m: Msg): bool = {
    val s = side.get(m.dest)
    val answered = { ...s, has: true, made: 0, link: m.id, open: false, chan: false }
    all {
      side' = side.set(m.dest,
        if (running) {
          ...answered,
          recon: true, ansTimer: true,
          giveUp: s.giveUp or ANSWERER_HAS_DEADLINE,
          closePending: s.closePending or s.chan,
        } else answered),
      wire' = wire.exclude(Set(m)).union(Set({ dest: other(m.dest), kind: "answer", id: m.id })),
      nextId' = nextId,
      unchangedPhase, unchangedHistory,
    }
  }

  // An answer arrives. A page that is not waiting for one drops it (the
  // browser refuses it). One that is waiting takes it, today whichever offer
  // it was made for.
  action receiveAnswer(m: Msg): bool = {
    val s = side.get(m.dest)
    val waiting = s.has and s.made != 0
    val mine = waiting and s.made == m.id
    val takenAnyway = waiting and not(mine) and not(SIGNALS_CARRY_ATTEMPT)
    all {
      side' = side.set(m.dest,
        if (mine) { ...s, made: 0, link: m.id }
        else if (takenAnyway) { ...s, made: 0, link: MISWIRED }
        else s),
      wire' = wire.exclude(Set(m)),
      staleApplied' = (staleApplied or takenAnyway),
      evictedLive' = evictedLive,
      nextId' = nextId, unchangedPhase,
    }
  }

  action deliver(m: Msg): bool = all {
    wire.contains(m),
    if (m.kind == "offer") receiveOffer(m) else receiveAnswer(m),
  }

  action lose(m: Msg): bool = all {
    wire.contains(m),
    wire' = wire.exclude(Set(m)),
    side' = side, nextId' = nextId, unchangedPhase, unchangedHistory,
  }

  // The channel opens on one page. After a drop the guest clears its
  // per-peer input state (resetPeerState, 'reconnect'); the host keeps its
  // own and pushes the match state.
  action channelOpens(s: str): bool = {
    val e = side.get(s)
    all {
      e.has, not(e.open), alive(s),
      side' = side.set(s, {
        ...e,
        open: true, chan: true, recon: false, giveUp: false, attempt: 0, ansTimer: false,
        dirty: e.dirty and not(e.recon and s == "hi"),
      }),
      wire' = wire, nextId' = nextId, unchangedPhase, unchangedHistory,
    }
  }

  // ── the match ──────────────────────────────────────────────────────────

  action netDrop = all {
    running, side.get("lo").open, alive("lo"), alive("hi"),
    dead' = dead.union(Set(side.get("lo").link)),
    side' = side, wire' = wire, nextId' = nextId,
    running' = running, stalled' = stalled, unchangedHistory,
  }

  // handlePeerDisconnect, entered with the entry `e`.
  action disconnect(s: str, e: Side): bool = all {
    s == "lo" implies canOffer,
    side' = side.set(s, disconnected(s, e, nextId)),
    wire' = if (s == "lo") wire.union(Set(offer("hi"))) else wire,
    nextId' = if (s == "lo") nextId + 1 else nextId,
    unchangedPhase, unchangedHistory,
  }

  // A page finds out its open channel is gone.
  action notice(s: str): bool = all {
    running, side.get(s).has, side.get(s).open, not(alive(s)),
    disconnect(s, side.get(s)),
  }

  // The channel a reconnect offer replaced fires its close event: the page
  // runs handlePeerDisconnect on the entry it has just answered with.
  action oldChannelCloses(s: str): bool = all {
    running, side.get(s).has, side.get(s).closePending, not(side.get(s).open),
    disconnect(s, side.get(s)),
  }

  action closeNeverComes(s: str): bool = all {
    side.get(s).closePending,
    side' = side.set(s, { ...side.get(s), closePending: false }),
    wire' = wire, nextId' = nextId, unchangedPhase, unchangedHistory,
  }

  action hardDisconnect(s: str): bool = all {
    side' = side.set(s, ABSENT),
    wire' = wire, nextId' = nextId, unchangedPhase, unchangedHistory,
  }

  action attemptTimeout = {
    val s = side.get("lo")
    all {
      running, s.has, not(s.open), s.recon, s.attempt > 0,
      if (s.attempt < MAX_ATTEMPTS) all {
        canOffer,
        side' = side.set("lo", { ...s, made: nextId, link: 0, chan: true, attempt: s.attempt + 1 }),
        wire' = wire.union(Set(offer("hi"))),
        nextId' = nextId + 1,
        unchangedPhase, unchangedHistory,
      } else hardDisconnect("lo"),
    }
  }

  action giveUpTimeout(s: str): bool = all {
    running, side.get(s).has, side.get(s).giveUp, side.get(s).recon, not(side.get(s).open),
    hardDisconnect(s),
  }

  // The answerer's timer: close the connection. Nothing follows from it,
  // unless the entry has since offered on a new connection: the timer closes
  // that one, and its channels may fire their close event.
  action answerTimeout(s: str): bool = all {
    side.get(s).has, side.get(s).ansTimer, not(side.get(s).open),
    side' = side.set(s, {
      ...side.get(s),
      made: 0, link: 0, ansTimer: false, chan: false,
      closePending: side.get(s).closePending or side.get(s).chan,
    }),
    wire' = wire, nextId' = nextId, unchangedPhase, unchangedHistory,
  }

  // The mesh health check: the roster lists the other player, there is no
  // open channel and no reconnect in progress. Whatever entry exists is
  // reset and dropped; a new one offers.
  action heal(s: str): bool = all {
    running, healRunsFor(s), not(side.get(s).open), not(side.get(s).recon), canOffer,
    side' = side.set(s, { ...ABSENT, has: true, made: nextId, chan: true }),
    wire' = wire.union(Set(offer(other(s)))),
    nextId' = nextId + 1,
    unchangedPhase, unchangedHistory,
  }

  // A roster lists the other player under a new socket id while the
  // connection to them is up. Before #119 the page took them for a new
  // player: it dropped the connection and waited for an offer.
  action rosterRenames(s: str): bool = all {
    running, side.get(s).has, side.get(s).open,
    side' = if (ROSTER_KEEPS_LIVE) side else side.set(s, { ...ABSENT, has: true }),
    evictedLive' = (evictedLive or not(ROSTER_KEEPS_LIVE)),
    staleApplied' = staleApplied,
    wire' = wire, nextId' = nextId, unchangedPhase,
  }

  action stutter = all {
    side' = side, wire' = wire, nextId' = nextId, unchangedPhase, unchangedHistory,
  }

  // ── initial states and steps ───────────────────────────────────────────

  // The match is under way on connection 1.
  action init = all {
    side' = SIDES.mapBy(s => { ...ABSENT, has: true, link: 1, open: true, chan: true }),
    wire' = Set(), nextId' = 2, dead' = Set(),
    running' = true, stalled' = false,
    staleApplied' = false, evictedLive' = false,
  }

  // Two players in the lobby, before either page has heard of the other.
  action initLobby = all {
    side' = SIDES.mapBy(s => ABSENT),
    wire' = Set(), nextId' = 1, dead' = Set(),
    running' = false, stalled' = false,
    staleApplied' = false, evictedLive' = false,
  }

  action step = any {
    startupTimeout,
    start,
    netDrop,
    attemptTimeout,
    all { wire != Set(), { nondet m = oneOf(wire) any { deliver(m), lose(m) } } },
    {
      nondet s = oneOf(SIDES)
      any {
        roster(s), channelOpens(s), notice(s), oldChannelCloses(s), closeNeverComes(s),
        giveUpTimeout(s), answerTimeout(s), heal(s), rosterRenames(s),
      }
    },
  }

  // ── properties ─────────────────────────────────────────────────────────

  // The two pages never both hold an unanswered offer to each other. When
  // they do, each replaces its connection on the other's offer and both
  // answers arrive for a connection that is gone.
  // Violated today (peer_connection_current): the health check runs on both.
  val oneInitiatorPerPair = not(side.get("lo").made != 0 and side.get("hi").made != 0)

  // I1 for a connection: in a match, an entry with no open channel always
  // has something that will act on it by a deadline: the give-up, a
  // reconnect attempt's timer, or the health check. The answerer's timer
  // does not count, it only closes the connection.
  // Violated today: a page that answers a reconnect offer without having
  // noticed the drop itself is reconnecting with no deadline, and the health
  // check skips entries that are reconnecting.
  def hasDeadline(s: str): bool = or {
    side.get(s).giveUp,
    side.get(s).attempt > 0,
    healRunsFor(s) and not(side.get(s).recon),
  }
  val everyWaitHasADeadline = SIDES.forall(s =>
    (running and side.get(s).has and not(side.get(s).open)) implies hasDeadline(s))

  // The pair as a whole is never left with nothing to wait for: in a match,
  // either the two pages are connected, or a signal is on its way, or a
  // channel is about to open, or one of them has a timer, a close event or
  // the health check still to come. Otherwise nothing will ever happen again
  // and the match is frozen with both pages still in the room.
  // Violated today: two offers cross, each page answers the other's, and
  // both are left reconnecting on a connection the other has replaced.
  def nothingPendingFor(s: str): bool = and {
    not(side.get(s).giveUp), side.get(s).attempt == 0,
    not(side.get(s).ansTimer), not(side.get(s).closePending),
    not(healRunsFor(s) and not(side.get(s).open) and not(side.get(s).recon)),
    not(side.get(s).open and not(alive(s))),
    not(side.get(s).has and not(side.get(s).open) and alive(s)),
  }
  val connected = side.get("lo").open and side.get("hi").open and alive("lo")
  val neverLeftWithNothingPending =
    (running and not(connected) and wire == Set()) implies not(SIDES.forall(s => nothingPendingFor(s)))

  // An answer is applied only to the connection that made the offer it
  // answers.
  // Violated today: a retry replaces the connection, and the answer to the
  // earlier offer is then applied to the new one.
  val staleSignalsAreNotApplied = not(staleApplied)

  // I2 for a connection: the guest never has an open channel beside input
  // state from before a drop.
  val reconnectStartsClean = side.get("hi").open implies not(side.get("hi").dirty)

  // A roster update never replaces a connection that is up (#119).
  val neverEvictsLiveConnection = not(evictedLive)

  // The two that hold on today's engine.
  val holdToday = reconnectStartsClean and neverEvictsLiveConnection

  // Every property at once.
  val allHold = and {
    oneInitiatorPerPair, everyWaitHasADeadline, neverLeftWithNothingPending,
    staleSignalsAreNotApplied, reconnectStartsClean, neverEvictsLiveConnection,
  }

  // ── scenarios ──────────────────────────────────────────────────────────

  def answerTo(dest: str, id: int): Msg = { dest: dest, kind: "answer", id: id }
  def offerTo(dest: str, id: int): Msg = { dest: dest, kind: "offer", id: id }
  def bothOpenOn(id: int): bool = SIDES.forall(s => side.get(s).open and side.get(s).link == id)

  // The roster reaches both pages, then the offer.
  run rosterThenOfferTest =
    initLobby
      .then(roster("lo"))
      .then(roster("hi"))
      .then(deliver(offerTo("hi", 1)))
      .then(deliver(answerTo("lo", 1)))
      .then(channelOpens("lo"))
      .then(channelOpens("hi"))
      .then(start)
      .expect(bothOpenOn(1) and oneInitiatorPerPair)

  // The offer reaches the higher slot before its roster does.
  run offerBeforeRosterTest =
    initLobby
      .then(roster("lo"))
      .then(deliver(offerTo("hi", 1)))
      .then(roster("hi"))
      .then(deliver(answerTo("lo", 1)))
      .then(channelOpens("hi"))
      .then(channelOpens("lo"))
      .expect(bothOpenOn(1) and wire == Set())

  // The first offer is lost; the startup watchdog sends another.
  run startupRetryTest =
    initLobby
      .then(roster("lo"))
      .then(roster("hi"))
      .then(lose(offerTo("hi", 1)))
      .then(startupTimeout)
      .then(deliver(offerTo("hi", 2)))
      .then(deliver(answerTo("lo", 2)))
      .then(channelOpens("lo"))
      .then(channelOpens("hi"))
      .expect(bothOpenOn(2))

  // A drop both pages notice: the lower slot offers, the guest answers and
  // comes back with its input state cleared.
  run reconnectTest =
    init
      .then(netDrop)
      .then(notice("hi"))
      .then(notice("lo"))
      .then(deliver(offerTo("hi", 2)))
      .then(deliver(answerTo("lo", 2)))
      .then(channelOpens("hi"))
      .then(channelOpens("lo"))
      .expect(bothOpenOn(2) and not(side.get("hi").dirty) and not(side.get("hi").recon))

  // The guest gave up on the player and dropped its entry; the lower slot's
  // reconnect offer then makes a new one on demand. It is reconnecting with
  // nothing armed, and no replaced channel whose close event could arm it.
  run guestGaveUpThenAnswersTest =
    init
      .then(netDrop)
      .then(notice("hi"))
      .then(giveUpTimeout("hi"))
      .then(notice("lo"))
      .then(deliver(offerTo("hi", 2)))
      .expect(everyWaitHasADeadline == ANSWERER_HAS_DEADLINE)

  // Only the lower slot notices the drop. The guest learns of it from the
  // reconnect offer; where the browser fires no close event for the channel
  // that offer replaced, it too is left reconnecting with nothing armed.
  run dropNoticedByOneSideTest =
    init
      .then(netDrop)
      .then(notice("lo"))
      .then(deliver(offerTo("hi", 2)))
      .then(closeNeverComes("hi"))
      .expect(everyWaitHasADeadline == ANSWERER_HAS_DEADLINE)

  // The guest gives up first and the health check on its page offers while
  // the lower slot is still reconnecting: two offers cross.
  run bothOfferAtOnceTest =
    init
      .then(netDrop)
      .then(notice("hi"))
      .then(giveUpTimeout("hi"))
      .then(if (HEAL_ONE_SIDE) stutter else heal("hi"))
      .then(notice("lo"))
      .expect(oneInitiatorPerPair == HEAL_ONE_SIDE)

  // Both pages have given up and dropped their entries. The health check
  // counts the same frames on both, so both offer at once. Each replaces its
  // connection to answer the other's offer, each answer finds a page that is
  // no longer waiting for one, and where the browser fires no close event
  // for the replaced channels, both are left reconnecting with nothing
  // armed. (Chromium does fire it, and there the same end needs two offers
  // that arrive after both entries were dropped.) With one side healing the
  // pair simply reconnects.
  run crossedHealOffersTest =
    init
      .then(netDrop)
      .then(notice("hi"))
      .then(notice("lo"))
      .then(lose(offerTo("hi", 2)))
      .then(giveUpTimeout("hi"))
      .then(giveUpTimeout("lo"))
      .then(heal("lo"))
      .then(
        if (HEAL_ONE_SIDE)
          deliver(offerTo("hi", 3))
            .then(deliver(answerTo("lo", 3)))
            .then(channelOpens("lo"))
            .then(channelOpens("hi"))
        else
          heal("hi")
            .then(deliver(offerTo("lo", 4)))
            .then(deliver(offerTo("hi", 3)))
            .then(closeNeverComes("lo"))
            .then(closeNeverComes("hi"))
            .then(deliver(answerTo("hi", 4)))
            .then(deliver(answerTo("lo", 3)))
            .then(answerTimeout("lo"))
            .then(answerTimeout("hi"))
      )
      .expect(connected == HEAL_ONE_SIDE)
      .expect(neverLeftWithNothingPending == HEAL_ONE_SIDE)

  // An answer to the first attempt arrives after the second has replaced the
  // connection.
  run lateAnswerTest =
    init
      .then(netDrop)
      .then(notice("lo"))
      .then(deliver(offerTo("hi", 2)))
      .then(attemptTimeout)
      .then(deliver(answerTo("lo", 2)))
      .expect(staleApplied == not(SIGNALS_CARRY_ATTEMPT))

  // #119 from the pair's side: the host's signaling returned first, so the
  // roster that lists the guest again does so under a new id.
  run hostRejoinsFirstTest =
    init
      .then(rosterRenames("lo"))
      .expect(evictedLive == not(ROSTER_KEEPS_LIVE) and side.get("lo").open == ROSTER_KEEPS_LIVE)
}

// Before #119.
module peer_connection_before_119 {
  import peer_connection(HEAL_ONE_SIDE = false, ANSWERER_HAS_DEADLINE = false,
         SIGNALS_CARRY_ATTEMPT = false, ROSTER_KEEPS_LIVE = false).*
}

// The engine as it is today. oneInitiatorPerPair, everyWaitHasADeadline,
// neverLeftWithNothingPending and staleSignalsAreNotApplied are violated here.
module peer_connection_current {
  import peer_connection(HEAL_ONE_SIDE = false, ANSWERER_HAS_DEADLINE = false,
         SIGNALS_CARRY_ATTEMPT = false, ROSTER_KEEPS_LIVE = true).*
}

// With the three proposed changes: the rules the per-peer machine is built to.
module peer_connection_fixed {
  import peer_connection(HEAL_ONE_SIDE = true, ANSWERER_HAS_DEADLINE = true,
         SIGNALS_CARRY_ATTEMPT = true, ROSTER_KEEPS_LIVE = true).*
}
