// -*- mode: Bluespec; -*-
//
// Streaming connection lifecycle: the WebRTC connections of a streaming
// match, as each page sees them (web/static/netplay-streaming.js:
// onUsersUpdated, createPeer, sendOffer, onWebRTCSignal, onDataMessage,
// setupDataChannel, onconnectionstatechange and handlePeerDisconnect).
//
// Streaming is a star. The host ("host", slot 0) runs the only emulator and
// is the only page that offers. A guest ("guest", a player) and a spectator
// ("spect") wait for its offer and answer it; the host's video comes to them
// over that connection, and the guest sends its input back on the channel.
// The host learns who to connect to from the roster; the others learn of the
// host only from its offer. Signals are relayed by the server and may arrive
// late or not at all.
//
// The model checks that a guest cannot be left with no connection for ever
// while both pages stay in the room, that a signal is applied only to the
// connection it was made for, that nothing replaces a connection that is
// up, and that a guest's or spectator's page connects to nobody but the
// host. Today's engine holds the last two. Violated today (the scenarios
// show how):
//   neverLeftWithNothingPending    a connection that drops is forgotten on
//                                  both pages and nothing offers again
//                                  (droppedGuestIsNeverReconnectedTest), also
//                                  when it drops while the host boots
//                                  (dropWhileBootingTest); nor after a lost
//                                  offer or ready
//   staleSignalsAreNotApplied      an offer for a new connection is applied
//                                  to the old one as a renegotiation
//                                  (newConnectionTakenAsRenegotiationTest)
//
// receiversConnectOnlyToTheHost was violated until #220: a page answered an
// offer from any member of the room (strayOfferTest), so any member, a
// spectator included, could open a connection to a player's page. The page
// showed that member's stream in place of the game, and its ICE candidates
// (its addresses) went to that member, which the star otherwise never lets
// a spectator see. The project owner decided that a guest or spectator
// accepts an offer only from the room's host (CHECKS_SENDER), and #220 made
// the engine do so. streaming_connection_before_220 is the engine before
// that; streaming_connection_fixed is today's with the reconnect fix.
//
// What is modelled, and where it comes from. web/src/streaming holds the
// engine's own rules as functions that observe it; each is named beside the
// action it stands for.
//   roster        onUsersUpdated on the host (roster.ts, hostRosterPlan): a
//                 member it holds no connection for gets one. Before the
//                 stream is up the host offers at once ('offer'); once it is
//                 up it waits for that page's ready ('awaitReady'). A
//                 connection it holds is kept. A roster comes on any change
//                 in the room, so this can happen again at any time
//   deliver       onWebRTCSignal (signal.ts, signalAction): an offer, which
//                 makes a connection on demand for a sender the page holds
//                 none for and is answered, or an answer. On the host,
//                 onDataMessage for a late joiner's
//                 `streaming-late-join-ready` (signal.ts, lateJoinReadyAction)
//   lose          a signal or a ready that never arrives: sent while a
//                 socket was down, before the page meant to hear it was
//                 listening, or dropped by the server's rate limit
//   channelOpens  the `inputs` DataChannel's onopen (signal.ts,
//                 channelOpenAction). The connection reaching `connected`
//                 and its channel opening are one step on each page here.
//                 The guest starts sending input; the host's first open
//                 channel starts its emulator (startHost: _gameRunning)
//   goLive        capture starts once the host's emulator has booted
//                 (_hostStream). Nothing stops the boot: it goes on whether
//                 or not the connection that started it is still there
//   blip          the network stops carrying a connection, open or still
//                 connecting. Both pages' connections go `disconnected`,
//                 which WebRTC means as transient
//   recovers      the network carries it again before either page has
//                 closed it
//   notice        a page finds out: `disconnected` or `failed`, or the
//                 channel's close. handlePeerDisconnect closes the
//                 connection and forgets the member (signal.ts,
//                 connectionLost). A connection one page has closed is gone
//                 for the other page too, which finds out the same way
//   strayOffer    a member who is not the host sends another member an offer
//                 of its own. The server relays a `webrtc-signal` between any
//                 two members of a room and says who sent it. Before #220
//                 nothing on the page checked who that was
//   reoffer       proposed (HOST_REOFFERS): the host's deadline. A member the
//                 roster lists that has no open channel to the host when it
//                 expires gets a new connection and a new offer
//
// Not modelled:
//   - ICE candidates one by one. A connection both pages have negotiated
//     either opens or fails (`blip`), which covers its candidates being lost.
//     A candidate gathered for a replaced connection reaching the new one is
//     peer_connection.qnt's staleSignalsAreNotApplied.
//   - Tracks. Every offer is taken to carry its sender's stream. The host's
//     first offers carry only the channel; when capture starts it adds its
//     tracks to every connection and renegotiates (startHost, renegotiate),
//     and a channel that opens later gets them the same way. That
//     renegotiation offer is left out.
//   - Input. The guest sends to the connection whose roster slot is 0 and the
//     host applies a packet to the slot its roster gives the connection
//     (input.ts), so a stray connection gets no input. Nor the zeroed input
//     of a player the host forgets.
//   - Members leaving the room, the host leaving (ownership moves and slot 0
//     stays empty in a match), a reload or a new socket id, and the end of
//     the match (stop() closes every connection).
//   - An offer sent to the host: it is applied to the connection the host
//     holds for its sender, so a member can only spoil its own connection.
//   - The stray sender's own page: what it does with the answer, and its side
//     of the connection. Nothing on the receiving page closes a stray
//     connection, and the model never does.
//   - More than one guest and one spectator. The spectator stands for any
//     member who is not the host; another player is the same.
//   - How a page knows who the host is, for CHECKS_SENDER: the roster's
//     slot 0 (offer-gate.ts, offerGate), which the page has before it
//     listens for signals (init runs onUsersUpdated(config.initialPlayers)
//     as it registers its listeners). An offer from a sender the page's
//     roster does not list yet is held until a roster says who that is
//     (_heldOffers), then applied if the sender is the host and refused
//     otherwise. The model takes the roster as known, so nothing is held.
//   - Which of a receiver's connections made for the same offer the host
//     took. A connection one page closed is gone for good on both, even when
//     the other page makes a new one for the same offer later (an offer the
//     host resends, taken again after the first was closed). The engine
//     might connect there; the model never claims it does.
//   - How long anything takes. A deadline may expire at any time, too early
//     included. A negotiated connection the network carries (`alive`) is
//     still `connecting` until its channel opens.
//   - A renderer that fails to start: startHost then stops with
//     _gameRunning set and no stream, for good.
//
// HOST_REOFFERS: who offers again.
//   false  today: the host offers once per connection: from the roster
//          before the stream is up, on a late joiner's ready once it is. A
//          connection that is lost is forgotten on both pages and nothing
//          offers again: not the guest, which never offers and sends its
//          ready once, and not a later roster, which once the stream is up
//          only makes a connection that waits for a ready
//   true   proposed: the host has a deadline for every member the roster
//          lists that has no open channel (an offer or ready that was lost,
//          a connection that dropped). When it expires it replaces the
//          connection and offers again
// SIGNALS_NAME_CONNECTION: what an offer or an answer is applied to.
//   false  today: whatever connection the page holds for the sender. An
//          answer goes to the one waiting for an answer; an offer for a
//          connection the page holds is a renegotiation of it (signal.ts:
//          "always applied to it as a renegotiation, never taken as a
//          replacement"), even when the host made it on a new one
//   true   proposed: each carries the attempt it belongs to, as the rollback
//          per-peer machine's do (the offering page and its count). An answer
//          is applied only to the connection that made the offer; an offer
//          naming the connection held is a renegotiation of it, a newer one
//          replaces it, an older one is dropped. With HOST_REOFFERS the host
//          replaces its connection while the guest may still hold the old
//          one, so the guest has to tell the two apart
// CHECKS_SENDER: whose offer a guest or spectator answers.
//   false  before #220: any member's
//   true   today: the host's only, the owner's decision (offer-gate.ts)
module streaming_connection {
  const HOST_REOFFERS: bool
  const SIGNALS_NAME_CONNECTION: bool
  const CHECKS_SENDER: bool

  pure val HOST = "host"
  pure val RECEIVERS = Set("guest", "spect")
  pure val PAGES = Set("host", "guest", "spect")
  // The roster lists players and spectators apart; a ready from a player it
  // does not list is ignored, a spectator's is let through.
  pure def isPlayer(r: str): bool = r == "guest"
  // Offers are numbered as they are made, by the host or by a stray sender.
  // The bound keeps the model finite. Once it is reached no page can offer
  // again, so the properties about what is still to come are only claimed
  // while an offer can still be made (canOffer).
  pure val MAX_OFFERS = 8

  // One page's connection to one other member (_peers[sid]). The offer that
  // started it names it: the host's own, or the one a receiver took; 0 while
  // the host has made none on it. `state` is one of
  //   none        the page holds no connection for that member
  //   new         the host made it and waits for a ready before offering
  //   offered     the host offered on it and waits for an answer
  //   negotiated  offer and answer are both applied (a receiver's starts
  //               here: it answered)
  //   open        ... and its `inputs` channel is open
  //   spoilt      a description made for another connection was applied to
  //               it after it had answered or been answered: it never comes up
  type Conn = { offer: int, state: str }
  type Page = {
    conns: str -> Conn,  // by every other member
    listed: Set[str],    // the host: the members its roster lists
    running: bool,       // the host: its emulator was started (_gameRunning)
    live: bool,          // the host: capture has started (_hostStream), so the stream is up
    shows: str,          // a guest or spectator: whose stream its <video> shows, "" none
  }
  // `kind` is "offer", "answer" or "ready". `id` is the offer an offer or an
  // answer is for, 0 for a ready. A page reads it only with
  // SIGNALS_NAME_CONNECTION; otherwise it is the model's own knowledge.
  type Msg = { src: str, dest: str, kind: str, id: int }

  pure val NONE: Conn = { offer: 0, state: "none" }
  pure def emptyPage(p: str): Page =
    { conns: PAGES.exclude(Set(p)).mapBy(x => NONE), listed: Set(), running: false, live: false, shows: "" }

  var page: str -> Page
  var wire: Set[Msg]       // signals and readies the server has yet to deliver
  var nextId: int
  var broken: Set[int]     // connections that carry nothing now
  var closed: Set[int]     // connections a page has closed: they never come back
  var misapplied: bool     // history: an offer or answer was applied to a connection it was not made for
  var replacedLive: bool   // history: a connection both pages had open was replaced

  // ── helpers ────────────────────────────────────────────────────────────

  def canOffer: bool = nextId <= MAX_OFFERS
  pure def offerFrom(x: str, r: str, id: int): Msg = { src: x, dest: r, kind: "offer", id: id }
  pure def offerTo(r: str, id: int): Msg = offerFrom(HOST, r, id)
  pure def answerFrom(r: str, id: int): Msg = { src: r, dest: HOST, kind: "answer", id: id }
  pure def readyFrom(r: str): Msg = { src: r, dest: HOST, kind: "ready", id: 0 }

  def connOf(p: str, x: str): Conn = page.get(p).conns.get(x)
  def holds(p: str, x: str): bool = connOf(p, x).state != "none"
  pure def isOpen(c: Conn): bool = c.state == "open"
  // Offer and answer are both applied (and nothing else since, or it is spoilt).
  pure def answered(c: Conn): bool = Set("negotiated", "open", "spoilt").contains(c.state)
  pure def sound(c: Conn): bool = c.state == "negotiated" or c.state == "open"
  // Page `p`'s connection to `x` becomes `c`.
  def withConn(p: str, x: str, c: Conn): str -> Page =
    page.set(p, { ...page.get(p), conns: page.get(p).conns.set(x, c) })
  // A connection between the host and a receiver, from either end.
  pure def isPair(p: str, x: str): bool =
    (p == HOST and RECEIVERS.contains(x)) or (RECEIVERS.contains(p) and x == HOST)
  pure def receiverOf(p: str, x: str): str = if (p == HOST) x else p

  // The host and `r` hold the same negotiated connection, neither has had
  // another's description applied to it, and the network carries it.
  def alive(r: str): bool = {
    val h = connOf(HOST, r)
    val g = connOf(r, HOST)
    and {
      h.offer > 0, h.offer == g.offer, sound(h), sound(g),
      not(broken.contains(h.offer)),
    }
  }
  def connected(r: str): bool = alive(r) and isOpen(connOf(HOST, r)) and isOpen(connOf(r, HOST))

  // A page's negotiated connection that is not alive: its state will go
  // `disconnected` or `failed`, or its channel will close. The host's
  // connection still waiting for an answer has no ICE peer and never
  // changes state.
  def failing(p: str, x: str): bool = {
    val e = connOf(p, x)
    and { e.offer > 0, answered(e), not(alive(receiverOf(p, x))) }
  }

  action noOffer = nextId' = nextId
  action unchangedNet = all { broken' = broken, closed' = closed }
  action unchangedHistory = all { misapplied' = misapplied, replacedLive' = replacedLive }

  // ── the roster ─────────────────────────────────────────────────────────

  // A roster listing `r` reaches the host. A connection it holds is kept.
  // Otherwise it makes one and, before the stream is up, offers at once;
  // once it is up the offer waits for r's ready, because an offer a page
  // joining late is not yet listening for is lost.
  action roster(r: str): bool = {
    val h = page.get(HOST)
    val listedNow = { ...h, listed: h.listed.union(Set(r)) }
    val makes = not(holds(HOST, r))
    val offers = makes and not(h.live)
    all {
      not(h.listed.contains(r)) or makes,
      offers implies canOffer,
      page' = page.set(HOST,
        if (not(makes)) listedNow
        else if (offers) { ...listedNow, conns: h.conns.set(r, { offer: nextId, state: "offered" }) }
        else { ...listedNow, conns: h.conns.set(r, { offer: 0, state: "new" }) }),
      wire' = if (offers) wire.union(Set(offerTo(r, nextId))) else wire,
      nextId' = if (offers) nextId + 1 else nextId,
      unchangedNet, unchangedHistory,
    }
  }

  // ── signals ────────────────────────────────────────────────────────────

  // An offer reaches a guest or spectator. With CHECKS_SENDER one that is
  // not from the host is dropped. With no connection for the sender the page
  // makes one and answers. With one, today the offer is a renegotiation of
  // it, whichever connection the sender made the offer on; named, the same
  // connection's offer is a renegotiation, a newer one replaces it and an
  // older one is dropped. Applying an offer points the page's video at the
  // sender's stream (ontrack). The answer to a stray offer goes to a page
  // the model does not follow.
  action receiveOffer(m: Msg): bool = {
    val r = m.dest
    val x = m.src
    val p = page.get(r)
    val held = connOf(r, x)
    val taken = { offer: m.id, state: "negotiated" }
    val answers = if (x == HOST) Set(answerFrom(r, m.id)) else Set()
    val rest = wire.exclude(Set(m))
    val refused = CHECKS_SENDER and x != HOST
    val other = not(refused) and holds(r, x) and held.offer != m.id
    val older = other and SIGNALS_NAME_CONNECTION and m.id < held.offer
    val replaces = other and SIGNALS_NAME_CONNECTION and m.id > held.offer
    val misread = other and not(SIGNALS_NAME_CONNECTION)
    val renegotiates = not(refused) and holds(r, x) and held.offer == m.id
    all {
      page' =
        if (refused or older) page
        else if (renegotiates) page.set(r, { ...p, shows: x })
        else if (misread) page.set(r, { ...p, conns: p.conns.set(x, { ...held, state: "spoilt" }), shows: x })
        else page.set(r, { ...p, conns: p.conns.set(x, taken), shows: x }),
      wire' = if (refused or older) rest else rest.union(answers),
      broken' = if (replaces) broken.union(Set(held.offer)) else broken,
      closed' = if (replaces) closed.union(Set(held.offer)) else closed,
      misapplied' = (misapplied or misread),
      replacedLive' = (replacedLive or (replaces and x == HOST and connected(r))),
      noOffer,
    }
  }

  // An answer reaches the host. A connection not waiting for one drops it
  // (the browser refuses an answer in `stable`). One that is waiting takes
  // it: today whichever offer it answers; named, only the answer to its own.
  action receiveAnswer(m: Msg): bool = {
    val r = m.src
    val e = connOf(HOST, r)
    val waiting = e.state == "offered"
    val mine = waiting and e.offer == m.id
    val takenAnyway = waiting and not(mine) and not(SIGNALS_NAME_CONNECTION)
    all {
      page' =
        if (mine) withConn(HOST, r, { ...e, state: "negotiated" })
        else if (takenAnyway) withConn(HOST, r, { ...e, state: "spoilt" })
        else page,
      wire' = wire.exclude(Set(m)),
      misapplied' = (misapplied or takenAnyway),
      replacedLive' = replacedLive,
      unchangedNet, noOffer,
    }
  }

  // A page joining the stream in play says it is listening. The host ignores
  // a player its roster does not list yet, and a page its connection is open
  // to (dc open or pc `connected`). If its connection has made an offer it
  // sends that offer again, also when that offer was answered and the
  // connection is still `connecting`; otherwise it makes the connection if it
  // holds none, and offers.
  action receiveReady(m: Msg): bool = {
    val r = m.src
    val e = connOf(HOST, r)
    val ignored = (isPlayer(r) and not(page.get(HOST).listed.contains(r))) or isOpen(e)
    val resends = not(ignored) and holds(HOST, r) and e.offer != 0
    val offers = not(ignored) and not(resends)
    all {
      offers implies canOffer,
      page' = if (offers) withConn(HOST, r, { offer: nextId, state: "offered" }) else page,
      wire' = wire.exclude(Set(m)).union(
        if (offers) Set(offerTo(r, nextId)) else if (resends) Set(offerTo(r, e.offer)) else Set()),
      nextId' = if (offers) nextId + 1 else nextId,
      unchangedNet, unchangedHistory,
    }
  }

  action deliver(m: Msg): bool = all {
    wire.contains(m),
    if (m.kind == "offer") receiveOffer(m)
    else if (m.kind == "answer") receiveAnswer(m)
    else receiveReady(m),
  }

  action lose(m: Msg): bool = all {
    wire.contains(m),
    wire' = wire.exclude(Set(m)),
    page' = page, noOffer, unchangedNet, unchangedHistory,
  }

  // A member who is not the host sends another an offer of its own.
  action strayOffer(x: str, r: str): bool = all {
    RECEIVERS.contains(x), RECEIVERS.contains(r), x != r, canOffer,
    wire' = wire.union(Set(offerFrom(x, r, nextId))),
    nextId' = nextId + 1,
    page' = page, unchangedNet, unchangedHistory,
  }

  // ── channels and the stream ────────────────────────────────────────────

  // On the host, the first channel to open starts the emulator.
  action channelOpens(p: str, x: str): bool = {
    val opened = { ...page.get(p), conns: page.get(p).conns.set(x, { ...connOf(p, x), state: "open" }) }
    all {
      isPair(p, x), alive(receiverOf(p, x)), not(isOpen(connOf(p, x))),
      page' = page.set(p, if (p == HOST) { ...opened, running: true } else opened),
      wire' = wire, noOffer, unchangedNet, unchangedHistory,
    }
  }

  // Capture starts once the emulator has booted, whatever has become of the
  // connection whose channel started it.
  action goLive = all {
    page.get(HOST).running, not(page.get(HOST).live),
    page' = page.set(HOST, { ...page.get(HOST), live: true }),
    wire' = wire, noOffer, unchangedNet, unchangedHistory,
  }

  // ── the network and what the pages make of it ──────────────────────────

  action blip(r: str): bool = all {
    alive(r),
    broken' = broken.union(Set(connOf(HOST, r).offer)),
    closed' = closed,
    page' = page, wire' = wire, noOffer, unchangedHistory,
  }

  action recovers(r: str): bool = {
    val c = connOf(HOST, r).offer
    all {
      holds(HOST, r), broken.contains(c), not(closed.contains(c)),
      broken' = broken.exclude(Set(c)),
      closed' = closed,
      page' = page, wire' = wire, noOffer, unchangedHistory,
    }
  }

  // handlePeerDisconnect: close the connection and forget the member.
  action notice(p: str, x: str): bool = {
    val c = connOf(p, x).offer
    all {
      isPair(p, x), failing(p, x),
      page' = withConn(p, x, NONE),
      broken' = broken.union(Set(c)), closed' = closed.union(Set(c)),
      wire' = wire, noOffer, unchangedHistory,
    }
  }

  // The host's deadline (proposed): a listed member with no open channel
  // gets a new connection and a new offer. The old connection is closed.
  action reoffer(r: str): bool = {
    val old = connOf(HOST, r).offer
    all {
      HOST_REOFFERS, canOffer,
      page.get(HOST).listed.contains(r), not(isOpen(connOf(HOST, r))),
      page' = withConn(HOST, r, { offer: nextId, state: "offered" }),
      wire' = wire.union(Set(offerTo(r, nextId))),
      nextId' = nextId + 1,
      broken' = if (old > 0) broken.union(Set(old)) else broken,
      closed' = if (old > 0) closed.union(Set(old)) else closed,
      misapplied' = misapplied,
      replacedLive' = (replacedLive or connected(r)),
    }
  }

  action stutter = all {
    page' = page, wire' = wire, noOffer, unchangedNet, unchangedHistory,
  }

  // ── initial states and steps ───────────────────────────────────────────

  // The match starts: every page has started its engine, and the host's
  // roster, which lists the guest and the spectator, is on its way to it.
  action init = all {
    page' = PAGES.mapBy(p => emptyPage(p)),
    wire' = Set(), nextId' = 1, broken' = Set(), closed' = Set(),
    misapplied' = false, replacedLive' = false,
  }

  // The match is under way (whoever the host started it with is left out):
  // the host's emulator is running and capture starts at its own pace
  // (goLive), so the stream may or may not be up yet. The guest and the
  // spectator join late: each page has started its engine and sent its
  // ready, and the roster that lists them is on its way to the host.
  action initLate = all {
    page' = PAGES.mapBy(p => if (p == HOST) { ...emptyPage(p), running: true } else emptyPage(p)),
    wire' = RECEIVERS.map(r => readyFrom(r)), nextId' = 1, broken' = Set(), closed' = Set(),
    misapplied' = false, replacedLive' = false,
  }

  action step = any {
    goLive,
    all { wire != Set(), { nondet m = oneOf(wire) any { deliver(m), lose(m) } } },
    {
      nondet r = oneOf(RECEIVERS)
      nondet x = oneOf(RECEIVERS)
      any {
        roster(r), blip(r), recovers(r), reoffer(r),
        channelOpens(HOST, r), channelOpens(r, HOST),
        notice(HOST, r), notice(r, HOST),
        strayOffer(x, r),
      }
    },
  }

  // ── properties ─────────────────────────────────────────────────────────

  // Something is still to come for the host and `r`: the roster that lists
  // r, a signal or ready between them, a channel about to open, a failing
  // connection one of them is yet to notice (or one that may recover), or
  // the host's deadline. A later roster does not count: nothing says one
  // will come.
  def pendingFor(r: str): bool = or {
    not(page.get(HOST).listed.contains(r)),
    wire.exists(m => (m.src == HOST and m.dest == r) or (m.src == r and m.dest == HOST)),
    alive(r),
    failing(HOST, r),
    failing(r, HOST),
    HOST_REOFFERS and page.get(HOST).listed.contains(r) and not(isOpen(connOf(HOST, r))),
  }

  // I1 for the streaming connection: a member in the room is either
  // connected to the host or has something still to come. Otherwise nothing
  // will ever happen again: the guest sits on the last frame of the video
  // and its input goes nowhere, with both pages still in the room.
  // Violated today: a connection that drops is forgotten on both pages
  // (droppedGuestIsNeverReconnectedTest), and a later roster only makes a
  // connection that waits for a ready (rosterAfterADropWaitsForAReadyTest),
  // also when the drop came before the stream was up (dropWhileBootingTest);
  // the same after a lost offer (lostOfferTest) or a lost or early ready
  // (lostReadyTest, readyBeforeRosterTest).
  val neverLeftWithNothingPending = canOffer implies RECEIVERS.forall(r => connected(r) or pendingFor(r))

  // An answer is applied only to the connection that made the offer it
  // answers, and an offer only to a connection it was made for (or one the
  // page makes for it).
  // Violated today: the host replaces its connection while the guest still
  // holds the old one, and the guest applies the new offer to it
  // (newConnectionTakenAsRenegotiationTest).
  val staleSignalsAreNotApplied = not(misapplied)

  // A guest's or spectator's page holds a connection only to the host and
  // shows only the host's stream. Holds today. Violated before #220: a
  // member who is not the host offered, and the page answered it
  // (strayOfferTest).
  val receiversConnectOnlyToTheHost = RECEIVERS.forall(r => and {
    PAGES.exclude(Set(r, HOST)).forall(x => not(holds(r, x))),
    page.get(r).shows == "" or page.get(r).shows == HOST,
  })

  // Nothing replaces a connection both pages have open: not the host's
  // deadline, and not an offer on the guest's page. Holds today (nothing
  // replaces anything). An offer that replaced whatever connection it does
  // not name would break it: an older offer arriving late would replace the
  // connection a newer one made (olderOfferIsDroppedTest).
  val neverReplacesALiveConnection = not(replacedLive)

  // The ones that hold on today's engine.
  val holdToday = and { neverReplacesALiveConnection, receiversConnectOnlyToTheHost }

  // Every property at once.
  val allHold = and {
    neverLeftWithNothingPending, staleSignalsAreNotApplied, receiversConnectOnlyToTheHost,
    neverReplacesALiveConnection,
  }

  // ── scenarios ──────────────────────────────────────────────────────────

  // The roster reaches the host, which offers; the guest answers, the
  // channel opens on both pages and the host's stream starts.
  run connectTest =
    init
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .then(channelOpens("host", "guest"))
      .then(channelOpens("guest", "host"))
      .then(goLive)
      .expect(connected("guest") and page.get("guest").shows == HOST and page.get(HOST).live)
      .expect(allHold)

  // The network drops the connection for a moment and carries it again
  // before either page has looked: nothing changes.
  run blipThatPassesTest =
    init
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .then(channelOpens("host", "guest"))
      .then(channelOpens("guest", "host"))
      .then(goLive)
      .then(blip("guest"))
      .expect(not(connected("guest")) and neverLeftWithNothingPending)
      .then(recovers("guest"))
      .expect(connected("guest"))

  // The guest and the host are connected and the stream is up. The network
  // drops the connection for a moment. The guest's connection reports
  // `disconnected`, a state WebRTC means as transient; the guest closes it
  // and forgets the host. That closes it for the host too, whose channel
  // closes, and the host forgets the guest. Both pages are still in the room
  // and the roster has not changed. Today nothing offers again: the guest is
  // left on the last frame of the video for good.
  run droppedGuestIsNeverReconnectedTest =
    init
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .then(channelOpens("host", "guest"))
      .then(channelOpens("guest", "host"))
      .then(goLive)
      .then(blip("guest"))
      .then(notice("guest", "host"))
      .then(notice("host", "guest"))
      .expect(wire == Set() and not(holds("host", "guest")) and not(holds("guest", "host")))
      .expect(page.get(HOST).listed.contains("guest") and page.get("guest").shows == HOST)
      .expect(neverLeftWithNothingPending == HOST_REOFFERS)

  // The same drop, then the roster changes (someone else joins, or renames
  // themselves). With the stream up the host makes a connection for the
  // guest and waits for a ready, which only a page joining late sends: still
  // nothing offers. With the host's deadline the guest is offered a new
  // connection and the pair connects.
  run rosterAfterADropWaitsForAReadyTest =
    init
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .then(channelOpens("host", "guest"))
      .then(channelOpens("guest", "host"))
      .then(goLive)
      .then(blip("guest"))
      .then(notice("guest", "host"))
      .then(notice("host", "guest"))
      .then(roster("guest"))
      .expect(holds("host", "guest") and connOf("host", "guest").offer == 0 and wire == Set())
      .expect(neverLeftWithNothingPending == HOST_REOFFERS)
      .then(
        if (HOST_REOFFERS)
          reoffer("guest")
            .then(deliver(offerTo("guest", 2)))
            .then(deliver(answerFrom("guest", 2)))
            .then(channelOpens("guest", "host"))
            .then(channelOpens("host", "guest"))
        else
          stutter
      )
      .expect(connected("guest") == HOST_REOFFERS)

  // The drop comes while the host's emulator is still booting: the channel
  // that started it closes before capture starts. The boot goes on and the
  // stream comes up with nobody connected, so the roster that comes next
  // (the only thing that would offer again today) finds the stream up and
  // only makes a connection that waits for a ready. Had the roster come
  // before capture started, it would have offered at once.
  run dropWhileBootingTest =
    init
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .then(channelOpens("host", "guest"))
      .then(channelOpens("guest", "host"))
      .expect(page.get(HOST).running and not(page.get(HOST).live))
      .then(blip("guest"))
      .then(notice("guest", "host"))
      .then(notice("host", "guest"))
      .then(goLive)
      .expect(page.get(HOST).live and RECEIVERS.forall(r => not(holds(HOST, r))))
      .then(roster("guest"))
      .expect(holds("host", "guest") and connOf("host", "guest").offer == 0 and wire == Set())
      .expect(neverLeftWithNothingPending == HOST_REOFFERS)
      .then(
        if (HOST_REOFFERS)
          reoffer("guest")
            .then(deliver(offerTo("guest", 2)))
            .then(deliver(answerFrom("guest", 2)))
            .then(channelOpens("guest", "host"))
            .then(channelOpens("host", "guest"))
        else
          stutter
      )
      .expect(connected("guest") == HOST_REOFFERS)

  // The roster's offer is lost. The host's connection waits for an answer,
  // which no event ends, and its emulator never starts. Today nothing else
  // happens; with the deadline the host offers again.
  run lostOfferTest =
    init
      .then(roster("guest"))
      .then(lose(offerTo("guest", 1)))
      .expect(neverLeftWithNothingPending == HOST_REOFFERS)
      .then(
        if (HOST_REOFFERS)
          reoffer("guest")
            .then(deliver(offerTo("guest", 2)))
            .then(deliver(answerFrom("guest", 2)))
            .then(channelOpens("host", "guest"))
            .then(channelOpens("guest", "host"))
        else
          stutter
      )
      .expect(connected("guest") == HOST_REOFFERS)

  // A player joins the stream in play. The roster makes a connection that
  // waits; the guest's ready makes the host offer on it.
  run lateJoinTest =
    initLate
      .then(goLive)
      .then(roster("guest"))
      .expect(holds("host", "guest") and connOf("host", "guest").offer == 0)
      .then(deliver(readyFrom("guest")))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .then(channelOpens("guest", "host"))
      .then(channelOpens("host", "guest"))
      .expect(connected("guest"))

  // The joining player's ready is lost (its page sends it once, when its
  // engine starts). The host's connection waits for it for ever today.
  run lostReadyTest =
    initLate
      .then(goLive)
      .then(roster("guest"))
      .then(lose(readyFrom("guest")))
      .expect(holds("host", "guest") and connOf("host", "guest").offer == 0)
      .expect(neverLeftWithNothingPending == HOST_REOFFERS)

  // The joining player's ready reaches the host before the roster that lists
  // it (that roster was lost while the host's socket was down, and the next
  // came after the ready). The host ignores a ready from a player it does
  // not know; the roster then makes a connection that waits for the ready
  // already spent. A spectator's ready is let through in the same order.
  run readyBeforeRosterTest =
    initLate
      .then(goLive)
      .then(deliver(readyFrom("guest")))
      .expect(not(holds("host", "guest")) and nextId == 1)
      .then(roster("guest"))
      .expect(holds("host", "guest") and connOf("host", "guest").offer == 0)
      .expect(neverLeftWithNothingPending == HOST_REOFFERS)
      .then(deliver(readyFrom("spect")))
      .expect(connOf("host", "spect").offer == 1 and wire.contains(offerTo("spect", 1)))

  // A player joins while the host's emulator is still booting, so the roster
  // offers at once. Offer and answer are both applied, and the connection is
  // still `connecting` when the player's ready arrives: the host's
  // connection is neither open nor `connected`, so it sends its offer again.
  // The guest takes it as a renegotiation of its connection and answers; the
  // host, no longer waiting for an answer, drops that one. The pair then
  // connects as before.
  run readyWhileConnectingTest =
    initLate
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .expect(alive("guest") and not(isOpen(connOf("host", "guest"))))
      .then(deliver(readyFrom("guest")))
      .expect(wire.contains(offerTo("guest", 1)) and nextId == 2)
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .expect(connOf("host", "guest") == { offer: 1, state: "negotiated" })
      .then(channelOpens("host", "guest"))
      .then(channelOpens("guest", "host"))
      .expect(connected("guest") and not(misapplied) and wire.contains(readyFrom("spect")))

  // Before capture starts a roster is the one thing that offers again
  // today. The connection drops; the host notices first and forgets the
  // guest, which has not noticed yet. A roster comes and the host offers on
  // a new connection. The guest applies that offer to the connection it
  // still holds, as a renegotiation of it, and answers from it: neither
  // page's connection can come up. With named signals the guest replaces
  // its connection and the pair connects.
  run newConnectionTakenAsRenegotiationTest =
    init
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .then(channelOpens("host", "guest"))
      .then(channelOpens("guest", "host"))
      .then(blip("guest"))
      .then(notice("host", "guest"))
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 2)))
      .expect(misapplied == not(SIGNALS_NAME_CONNECTION))
      .then(deliver(answerFrom("guest", 2)))
      .expect(alive("guest") == SIGNALS_NAME_CONNECTION)
      .expect(failing("host", "guest") == not(SIGNALS_NAME_CONNECTION))

  // The host's deadline expires before the guest's answer arrives: it
  // replaces its connection and offers again, and then the answer to the
  // first offer arrives. Named, it is dropped, and the second offer
  // replaces the guest's connection. (Today the host never offers again, and
  // the pair simply connects on the first offer.)
  run lateAnswerTest =
    init
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(
        if (HOST_REOFFERS)
          reoffer("guest")
            .then(deliver(answerFrom("guest", 1)))
            .then(deliver(offerTo("guest", 2)))
            .then(deliver(answerFrom("guest", 2)))
            .then(channelOpens("host", "guest"))
            .then(channelOpens("guest", "host"))
        else
          deliver(answerFrom("guest", 1))
            .then(channelOpens("host", "guest"))
            .then(channelOpens("guest", "host"))
      )
      .expect(connected("guest") and not(misapplied))

  // The host's first offer is slow, its deadline offers again and the pair
  // connects on the second; then the first arrives. It names an older
  // connection than the one the guest holds and is dropped. Replacing
  // whatever connection an offer does not name would break the live one.
  // (Today the pair connects on the first offer.)
  run olderOfferIsDroppedTest =
    init
      .then(roster("guest"))
      .then(
        if (HOST_REOFFERS)
          reoffer("guest")
            .then(deliver(offerTo("guest", 2)))
            .then(deliver(answerFrom("guest", 2)))
            .then(channelOpens("host", "guest"))
            .then(channelOpens("guest", "host"))
            .then(deliver(offerTo("guest", 1)))
        else
          deliver(offerTo("guest", 1))
            .then(deliver(answerFrom("guest", 1)))
            .then(channelOpens("host", "guest"))
            .then(channelOpens("guest", "host"))
      )
      .expect(connected("guest") and neverReplacesALiveConnection and wire == Set())

  // The guest is connected to the host. The spectator's page sends the guest
  // an offer of its own.
  //   before_220      the guest accepts it as it would the host's: it
  //                   makes a connection for the spectator and answers from
  //                   it (`negotiated`; the answer goes to the spectator's
  //                   page, which the model does not follow), and its video
  //                   shows the spectator's stream in place of the game
  //   current, fixed  the guest refuses it: no connection, no answer, and
  //                   its video still shows the host's stream
  // Either way its connection to the host stays up.
  run strayOfferTest =
    init
      .then(roster("guest"))
      .then(deliver(offerTo("guest", 1)))
      .then(deliver(answerFrom("guest", 1)))
      .then(channelOpens("host", "guest"))
      .then(channelOpens("guest", "host"))
      .then(strayOffer("spect", "guest"))
      .expect(wire == Set(offerFrom("spect", "guest", 2)))
      .then(deliver(offerFrom("spect", "guest", 2)))
      .expect(
        if (CHECKS_SENDER)
          not(holds("guest", "spect")) and page.get("guest").shows == HOST and receiversConnectOnlyToTheHost
        else
          connOf("guest", "spect") == { offer: 2, state: "negotiated" } and page.get("guest").shows == "spect"
            and not(receiversConnectOnlyToTheHost)
      )
      .expect(wire == Set() and connected("guest"))
}

// The engine before #220: a guest or spectator answered an offer from any
// member. neverLeftWithNothingPending, staleSignalsAreNotApplied and
// receiversConnectOnlyToTheHost are violated here.
module streaming_connection_before_220 {
  import streaming_connection(HOST_REOFFERS = false, SIGNALS_NAME_CONNECTION = false,
         CHECKS_SENDER = false).*
}

// The engine as it is today: a guest or spectator answers only the host.
// neverLeftWithNothingPending and staleSignalsAreNotApplied are violated
// here.
module streaming_connection_current {
  import streaming_connection(HOST_REOFFERS = false, SIGNALS_NAME_CONNECTION = false,
         CHECKS_SENDER = true).*
}

// Today's engine with the reconnect fix: the host's deadline, and signals
// that name their connection. Every property holds.
module streaming_connection_fixed {
  import streaming_connection(HOST_REOFFERS = true, SIGNALS_NAME_CONNECTION = true,
         CHECKS_SENDER = true).*
}
