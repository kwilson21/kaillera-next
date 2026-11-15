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
//                   the roster has not arrived yet), an answer or an ICE
//                   candidate
//   candidateSent   a page sends an ICE candidate of its connection
//   lose            a signal sent while a socket was down is never delivered
//   channelOpens    the lockstep DataChannel's onopen
//   startupTimeout  the startup connect watchdog: 8 s, 3 attempts
//   start           the match begins
//   netDrop         the connection dies under both pages
//   notice          one page finds out (channel close, pc failed, the 3 s
//                   grace after pc disconnected): handlePeerDisconnect
//   silentClose     a channel stops being open with no event at all, which
//                   is the case the mesh health check exists for
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
//   reload          a page is replaced by a new page of the same player (a
//                   reload, a second tab taking the seat). The new page has
//                   no entry and numbers its offers from 1 again. The other
//                   page keeps whatever it had: its entry, its connection,
//                   its timers, and the signals already on their way to and
//                   from the page that is gone
//   reloadOld       the same, by a page from before signals carried an
//                   attempt: what it sends carries no label (an offer, an
//                   answer to any offer, a candidate), and it applies what
//                   it receives as today's engine does, whatever the label.
//                   Only that is modelled of its age: it follows the same
//                   rules as the other page otherwise
//   thirdOpens      before the match, a page's channel with a third player
//                   opens. A page has started (_phase PHASE_GAME_STARTED,
//                   startGameSequence) once any of its lockstep channels has
//                   opened, so in a room of three one page of the pair can
//                   have started while the other is still connecting to it
//                   and retrying. Of the third player only that is modelled
//
// Not modelled: a third player beyond thirdOpens, spectators, a drop before
// the match starts, PEER-PHANTOM (which stops the health check for that
// slot), timers that outlive the entry they were armed for, and the tick
// loop. Of a
// replaced page: the server refusing a signal addressed to a socket that is
// gone (every signal in flight can still arrive, the worst case), the channel
// events of its connection on the page that stays (`opened`, `lost`: the
// machine checks them by the same identity as a candidate, which stands for
// them here), and telling its late offer from its replacement's (an offer is
// always answered).
//
// HEAL_ONE_SIDE: who the mesh health check runs for.
//   false  today: either page; both count the same frames, so both can heal
//          at once, and the higher slot can heal while the lower reconnects
//   true   proposed: only the page that initiates reconnects (the lower
//          slot) offers from it; on the other page the check treats a dead
//          channel as a drop it has just noticed. The per-peer machine
//          decides this alone first (peer_connection_heal_one_side).
//
// Mixed versions during a deploy: a page from before the machine decided
// `heal` meets one from after. The lower slot's health check is the same in
// both (it resets its entry and offers); only the higher slot's changes. So
// of the four pairs, the two with a new higher slot are
// peer_connection_heal_one_side and the two with an old one are
// peer_connection_current, exactly today. heal_one_side keeps every property
// current keeps (holdToday) and also oneInitiatorPerPair and
// neverLeftWithNothingPending: no pair is worse than today.
// ANSWERER_HAS_DEADLINE: a page that answers a reconnect offer.
//   false  today: marks the entry reconnecting; the 45 s give-up is armed
//          only if that page also noticed the drop itself
//   true   proposed: answering arms the give-up
// SIGNALS_CARRY_ATTEMPT: what an answer is applied to.
//   false  today: whatever connection the entry has now, if it is waiting
//          for an answer
//   true   proposed: only the connection that made the offer it answers
// ATTEMPT_NAMES_PAGE: how a signal says which attempt it belongs to. It only
//   matters with SIGNALS_CARRY_ATTEMPT.
//   false  a number the offering page counts up from 1. A page that replaces
//          another counts from 1 again, so two attempts can carry the same
//          number
//   true   that number beside an id of the page that made the offer, new
//          with every page: no two attempts are the same on the wire
// ROSTER_KEEPS_LIVE: false = before #119, a roster under a new id replaced a
//   connection that was up.
// STARTUP_FLAG_RELAYED: what a startup retry says of itself on arrival. The
//   retry goes out as a reconnect offer marked `startupReconnect`.
//   false  the server's relay drops `startupReconnect`: the page that
//          receives the retry tells a startup retry from a reconnect by its
//          own phase, and a page that has started takes it for a reconnect
//   true   the flag arrives, and a startup retry is one wherever it lands
module peer_connection {
  const HEAL_ONE_SIDE: bool
  const ANSWERER_HAS_DEADLINE: bool
  const SIGNALS_CARRY_ATTEMPT: bool
  const ATTEMPT_NAMES_PAGE: bool
  const ROSTER_KEEPS_LIVE: bool
  const STARTUP_FLAG_RELAYED: bool

  pure val SIDES = Set("lo", "hi")
  pure def other(s: str): str = if (s == "lo") "hi" else "lo"
  pure val MAX_ATTEMPTS = 3
  // Offers are numbered; the bound keeps the model finite. Once it is
  // reached no page can offer again, so the properties about what is still
  // to come are only claimed while an offer can still be made (canOffer).
  pure val MAX_OFFERS = 7
  // Pages are numbered as they load: "lo" is page 1 and "hi" page 2, and each
  // reload makes the next. The bound allows two reloads.
  pure val MAX_PAGES = 4
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
    retry: bool,         // its connection was answered to a startup retry
  }
  // `id` says which connection a signal belongs to. It is the model's own
  // knowledge: no page can read it. What a page can read is the id's label.
  // `mode` is what an offer says about itself: "first" (the roster's), or a
  // replacement, "startup" before the match and "reconnect" in it
  // (reconnect and startupReconnect in the engine). Empty for an answer.
  // `bare`: the signal carries no label at all, because the page that sent
  // it is old (reloadOld) or it answers or belongs to an offer that had none.
  type Msg = { dest: str, kind: str, id: int, mode: str, bare: bool }
  // What a signal carries to say which attempt it is for: the offering
  // page's own count, and with ATTEMPT_NAMES_PAGE that page's id (else 0).
  // An old page's offer goes under none: n = 0.
  type Label = { page: int, n: int }
  // One loaded page: its id, how many offers it has made, and whether it is
  // an old page that sends no labels and checks none.
  type Page = { id: int, offers: int, old: bool }

  pure val ABSENT: Side = {
    has: false, made: 0, link: 0, open: false, chan: false, recon: false, giveUp: false,
    attempt: 0, ansTimer: false, closePending: false, dirty: false, retry: false,
  }

  var side: str -> Side
  var wire: Set[Msg]       // signals the server has yet to deliver
  var nextId: int
  var labels: int -> Label // the label each offer went out under
  var pages: str -> Page   // the page each player has loaded now
  var nextPage: int
  var dead: Set[int]       // connections the network has killed
  var running: bool        // the match is under way
  var started: Set[str]    // pages past startGameSequence: one of their channels opened
  var stalled: bool        // the startup watchdog gave up and told the player
  var staleApplied: bool   // history: an answer or a candidate was applied to a connection it was not for
  var evictedLive: bool    // history: a roster update replaced a connection that was up
  var retryAsReconnect: bool // history: a startup retry was handled as a gameplay reconnect

  // ── helpers ────────────────────────────────────────────────────────────

  def canOffer: bool = nextId <= MAX_OFFERS
  def offer(dest: str, mode: str): Msg =
    { dest: dest, kind: "offer", id: nextId, mode: mode, bare: pages.get(other(dest)).old }
  // The page `s` has now goes by labels: the rules carry them and it is not old.
  def checksLabels(s: str): bool = SIGNALS_CARRY_ATTEMPT and not(pages.get(s).old)
  // An offer that went out under no label.
  def bareOffer(id: int): bool = labels.get(id).n == 0

  // No offer is made in this step.
  action noOffer = all { nextId' = nextId, labels' = labels, pages' = pages, nextPage' = nextPage }
  // Page `s` makes offer `nextId`, under its next number.
  action offered(s: str): bool = {
    val mine = pages.get(s)
    all {
      nextId' = nextId + 1,
      labels' = labels.put(nextId,
        if (mine.old) { page: 0, n: 0 }
        else { page: if (ATTEMPT_NAMES_PAGE) mine.id else 0, n: mine.offers + 1 }),
      pages' = pages.set(s, { ...mine, offers: mine.offers + 1 }),
      nextPage' = nextPage,
    }
  }
  // All a page can tell: the two attempts go under the same label. A
  // connection that took the wrong answer (MISWIRED) is under none, and so is
  // an old page's offer.
  def sameLabel(a: int, b: int): bool =
    if (a > 0 and b > 0) labels.get(a) == labels.get(b) and not(bareOffer(a)) else false
  // The attempt of the entry's connection: the offer it made or took.
  pure def connectionOf(e: Side): int = if (e.made != 0) e.made else e.link

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

  action unchangedHistory = all {
    staleApplied' = staleApplied, evictedLive' = evictedLive, retryAsReconnect' = retryAsReconnect,
  }
  action unchangedPhase = all { running' = running, stalled' = stalled, dead' = dead, started' = started }

  // ── before the match ───────────────────────────────────────────────────

  // The roster reaches a page. The lower slot creates its entry and offers;
  // the higher slot creates its entry and waits. An entry made on demand by
  // an offer that arrived first is left as it is.
  action roster(s: str): bool = all {
    not(running),
    if (side.get(s).has) all { side' = side, wire' = wire, noOffer }
    else if (s == "lo") all {
      canOffer,
      side' = side.set(s, { ...ABSENT, has: true, made: nextId, chan: true, attempt: 1 }),
      wire' = wire.union(Set(offer(other(s), "first"))),
      offered(s),
    } else all {
      side' = side.set(s, { ...ABSENT, has: true }),
      wire' = wire, noOffer,
    },
    unchangedPhase, unchangedHistory,
  }

  // The startup watchdog: no open channel 8 s after the offer. Replace the
  // connection and offer again, three times, then tell the player. A page
  // that has started (a channel with a third player opened) retries no more.
  action startupTimeout = {
    val s = side.get("lo")
    all {
      not(running), not(started.contains("lo")), s.has, not(s.open), s.attempt > 0,
      if (s.attempt < MAX_ATTEMPTS) all {
        canOffer,
        side' = side.set("lo", { ...s, made: nextId, link: 0, chan: true, attempt: s.attempt + 1 }),
        wire' = wire.union(Set(offer("hi", "startup"))),
        offered("lo"),
        stalled' = stalled,
      } else all {
        side' = side.set("lo", { ...s, attempt: 0 }),
        wire' = wire, noOffer,
        stalled' = true,
      },
      running' = running, dead' = dead, started' = started, unchangedHistory,
    }
  }

  action start = all {
    not(running), side.get("lo").open, side.get("hi").open,
    running' = true,
    side' = side, wire' = wire, noOffer, stalled' = stalled, dead' = dead, started' = started,
    unchangedHistory,
  }

  // A page's channel with a third player opens before the match.
  action thirdOpens(s: str): bool = all {
    not(running), not(started.contains(s)),
    started' = started.union(Set(s)),
    side' = side, wire' = wire, noOffer,
    running' = running, stalled' = stalled, dead' = dead, unchangedHistory,
  }

  // ── signals ────────────────────────────────────────────────────────────

  // An offer arrives. With no entry, one is made on demand. Before the match
  // the page just answers, unless it takes the offer for a reconnect (below).
  // In a match, what happens depends on what the offer says it is:
  //   reconnect  the page replaces its connection (dropping an offer of its
  //              own), marks the entry reconnecting, arms a timer that only
  //              closes the connection, and answers
  //   startup    a startup retry delivered late: the same, but the entry is
  //              not marked reconnecting
  //   first      a roster offer delivered late: applied to the connection
  //              the entry already has, which keeps its channels but is now
  //              described by an offer from a connection that is gone
  // Replacing the connection closes the channels the entry held.
  // What the page takes the offer for (`seen`): a startup retry whose flag
  // the server dropped is a reconnect offer to a page that has started. Such
  // a page takes it for a reconnect even before the match.
  action receiveOffer(m: Msg): bool = {
    val s = side.get(m.dest)
    val seen = if (m.mode == "startup" and not(STARTUP_FLAG_RELAYED) and started.contains(m.dest)) "reconnect"
      else m.mode
    val replaced = { ...s, has: true, made: 0, link: m.id, open: false, chan: false, retry: m.mode == "startup" }
    all {
      side' = side.set(m.dest,
        if (not(running) and seen != "reconnect") replaced
        else if (seen == "reconnect") {
          ...replaced,
          recon: true, ansTimer: true,
          giveUp: s.giveUp or ANSWERER_HAS_DEADLINE,
          closePending: s.closePending or s.chan,
        } else if (seen == "startup") {
          ...replaced,
          ansTimer: true,
          closePending: s.closePending or s.chan,
        } else { ...s, has: true, made: 0, link: m.id, retry: false }),
      wire' = wire.exclude(Set(m)).union(Set({
        dest: other(m.dest), kind: "answer", id: m.id, mode: "", bare: m.bare or pages.get(m.dest).old,
      })),
      noOffer,
      unchangedPhase, unchangedHistory,
    }
  }

  // An answer arrives. A page that is not waiting for one drops it (the
  // browser refuses it). One that is waiting takes it, today whichever offer
  // it was made for. With SIGNALS_CARRY_ATTEMPT it takes only one under the
  // label of its own offer, and that is the answer to another offer when a
  // replaced page made an offer under the same label. An answer with no
  // label (from an old page) is under none: a page that checks labels drops
  // it, even when it is the answer to its offer.
  action receiveAnswer(m: Msg): bool = {
    val s = side.get(m.dest)
    val checks = checksLabels(m.dest)
    val waiting = s.has and s.made != 0
    val mine = waiting and s.made == m.id and not(checks and m.bare)
    val takenAnyway = waiting and s.made != m.id
      and (not(checks) or (not(m.bare) and sameLabel(s.made, m.id)))
    all {
      side' = side.set(m.dest,
        if (mine) { ...s, made: 0, link: m.id }
        else if (takenAnyway) { ...s, made: 0, link: MISWIRED }
        else s),
      wire' = wire.exclude(Set(m)),
      // An old page applies what it receives as today; what that costs is
      // not something the rules can prevent, so only a page that checks
      // labels is held to them.
      staleApplied' = (staleApplied or (takenAnyway and not(pages.get(m.dest).old))),
      evictedLive' = evictedLive, retryAsReconnect' = retryAsReconnect,
      noOffer, unchangedPhase,
    }
  }

  // A page sends an ICE candidate of the connection its entry has.
  action candidateSent(s: str): bool = {
    val id = connectionOf(side.get(s))
    val m = { dest: other(s), kind: "candidate", id: id, mode: "", bare: pages.get(s).old or (id > 0 and bareOffer(id)) }
    all {
      side.get(s).has, m.id > 0, not(wire.contains(m)),
      wire' = wire.union(Set(m)),
      side' = side, noOffer, unchangedPhase, unchangedHistory,
    }
  }

  // A candidate arrives. Today it is added to whatever connection the entry
  // has. With SIGNALS_CARRY_ATTEMPT, only to one under the candidate's label.
  // The entry does not change; a candidate from another connection is one
  // the browser was never meant to be given.
  action receiveCandidate(m: Msg): bool = {
    val mine = connectionOf(side.get(m.dest))
    val applied = side.get(m.dest).has and mine != 0
      and (not(checksLabels(m.dest)) or (not(m.bare) and sameLabel(mine, m.id)))
    all {
      wire' = wire.exclude(Set(m)),
      staleApplied' = (staleApplied or (applied and mine != m.id and not(pages.get(m.dest).old))),
      evictedLive' = evictedLive, retryAsReconnect' = retryAsReconnect,
      side' = side, noOffer, unchangedPhase,
    }
  }

  action deliver(m: Msg): bool = all {
    wire.contains(m),
    if (m.kind == "offer") receiveOffer(m)
    else if (m.kind == "answer") receiveAnswer(m)
    else receiveCandidate(m),
  }

  action lose(m: Msg): bool = all {
    wire.contains(m),
    wire' = wire.exclude(Set(m)),
    side' = side, noOffer, unchangedPhase, unchangedHistory,
  }

  // The channel opens on one page. After a drop the guest clears its
  // per-peer input state (resetPeerState, 'reconnect'); the host keeps its
  // own and pushes the match state. Everything an open does for a page
  // marked reconnecting (the resync request, resetPeerState, the
  // "reconnected" status and toast, peer_reconnected) is the one step
  // `retryAsReconnect` records when the connection was a startup retry's.
  // The first channel to open starts the page's game (startGameSequence).
  action channelOpens(s: str): bool = {
    val e = side.get(s)
    all {
      e.has, not(e.open), alive(s),
      side' = side.set(s, {
        ...e,
        open: true, chan: true, recon: false, giveUp: false, attempt: 0, ansTimer: false,
        dirty: e.dirty and not(e.recon and s == "hi"),
      }),
      wire' = wire, noOffer,
      running' = running, stalled' = stalled, dead' = dead,
      started' = if (running) started else started.union(Set(s)),
      staleApplied' = staleApplied, evictedLive' = evictedLive,
      retryAsReconnect' = (retryAsReconnect or (e.recon and e.retry)),
    }
  }

  // ── the match ──────────────────────────────────────────────────────────

  action netDrop = all {
    running, side.get("lo").open, alive("lo"), alive("hi"),
    dead' = dead.union(Set(side.get("lo").link)),
    side' = side, wire' = wire, noOffer,
    running' = running, stalled' = stalled, started' = started, unchangedHistory,
  }

  // handlePeerDisconnect, entered with the entry `e`.
  action disconnect(s: str, e: Side): bool = all {
    s == "lo" implies canOffer,
    side' = side.set(s, disconnected(s, e, nextId)),
    wire' = if (s == "lo") wire.union(Set(offer("hi", "reconnect"))) else wire,
    if (s == "lo") offered(s) else noOffer,
    unchangedPhase, unchangedHistory,
  }

  // A page finds out its open channel is gone.
  action notice(s: str): bool = all {
    running, side.get(s).has, side.get(s).open, not(alive(s)),
    disconnect(s, side.get(s)),
  }

  // A channel is no longer open and no event said so. Nothing runs; the
  // entry just has no open channel until the health check looks.
  action silentClose(s: str): bool = all {
    running, side.get(s).has, side.get(s).open, not(alive(s)),
    side' = side.set(s, { ...side.get(s), open: false, chan: false }),
    wire' = wire, noOffer, unchangedPhase, unchangedHistory,
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
    wire' = wire, noOffer, unchangedPhase, unchangedHistory,
  }

  action hardDisconnect(s: str): bool = all {
    side' = side.set(s, ABSENT),
    wire' = wire, noOffer, unchangedPhase, unchangedHistory,
  }

  action attemptTimeout = {
    val s = side.get("lo")
    all {
      running, s.has, not(s.open), s.recon, s.attempt > 0,
      if (s.attempt < MAX_ATTEMPTS) all {
        canOffer,
        side' = side.set("lo", { ...s, made: nextId, link: 0, chan: true, attempt: s.attempt + 1 }),
        wire' = wire.union(Set(offer("hi", "reconnect"))),
        offered("lo"),
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
    wire' = wire, noOffer, unchangedPhase, unchangedHistory,
  }

  // The mesh health check: the roster lists the other player, there is no
  // open channel and no reconnect in progress. On a page that offers from
  // it, whatever entry exists is reset and dropped and a new one offers. On
  // a page that does not (the higher slot, in the proposed rules), an entry
  // with a dead channel is treated as a drop noticed now.
  action heal(s: str): bool = all {
    running, not(side.get(s).open), not(side.get(s).recon),
    if (healRunsFor(s)) all {
      canOffer,
      side' = side.set(s, { ...ABSENT, has: true, made: nextId, chan: true }),
      wire' = wire.union(Set(offer(other(s), "reconnect"))),
      offered(s),
      unchangedPhase, unchangedHistory,
    } else all {
      side.get(s).has,
      disconnect(s, side.get(s)),
    },
  }

  // A roster lists the other player under a new socket id while the
  // connection to them is up. Before #119 the page took them for a new
  // player: it dropped the connection and waited for an offer.
  action rosterRenames(s: str): bool = all {
    running, side.get(s).has, side.get(s).open,
    side' = if (ROSTER_KEEPS_LIVE) side else side.set(s, { ...ABSENT, has: true }),
    evictedLive' = (evictedLive or not(ROSTER_KEEPS_LIVE)),
    staleApplied' = staleApplied, retryAsReconnect' = retryAsReconnect,
    wire' = wire, noOffer, unchangedPhase,
  }

  // A new page of player `s` takes the place of the one that was there. It
  // knows nothing of the other player yet and has made no offers. Nothing
  // else changes: not the other page's entry, and not the signals in flight,
  // which the server may still deliver to either of them. `old`: the new
  // page is from before signals carried an attempt (reloadOld).
  action replacePage(s: str, old: bool): bool = all {
    nextPage <= MAX_PAGES,
    side' = side.set(s, ABSENT),
    pages' = pages.set(s, { id: nextPage, offers: 0, old: old }),
    nextPage' = nextPage + 1,
    nextId' = nextId, labels' = labels,
    // The new page has not run startGameSequence. In a match the phase is
    // left to the match's own actions, as before.
    started' = if (running) started else started.exclude(Set(s)),
    running' = running, stalled' = stalled, dead' = dead,
    wire' = wire, unchangedHistory,
  }
  action reload(s: str): bool = replacePage(s, false)
  action reloadOld(s: str): bool = replacePage(s, true)

  action stutter = all {
    side' = side, wire' = wire, noOffer, unchangedPhase, unchangedHistory,
  }

  // ── initial states and steps ───────────────────────────────────────────

  // The match is under way on connection 1, the first offer of "lo".
  action init = all {
    side' = SIDES.mapBy(s => { ...ABSENT, has: true, link: 1, open: true, chan: true }),
    wire' = Set(), nextId' = 2, dead' = Set(),
    labels' = Map(1 -> { page: if (ATTEMPT_NAMES_PAGE) 1 else 0, n: 1 }),
    pages' = Map("lo" -> { id: 1, offers: 1, old: false }, "hi" -> { id: 2, offers: 0, old: false }), nextPage' = 3,
    running' = true, stalled' = false, started' = SIDES,
    staleApplied' = false, evictedLive' = false, retryAsReconnect' = false,
  }

  // Two players in the lobby, before either page has heard of the other.
  action initLobby = all {
    side' = SIDES.mapBy(s => ABSENT),
    wire' = Set(), nextId' = 1, dead' = Set(),
    labels' = Map(),
    pages' = Map("lo" -> { id: 1, offers: 0, old: false }, "hi" -> { id: 2, offers: 0, old: false }), nextPage' = 3,
    running' = false, stalled' = false, started' = Set(),
    staleApplied' = false, evictedLive' = false, retryAsReconnect' = false,
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
        roster(s), channelOpens(s), notice(s), silentClose(s), oldChannelCloses(s), closeNeverComes(s),
        giveUpTimeout(s), answerTimeout(s), heal(s), rosterRenames(s),
        candidateSent(s), reload(s), reloadOld(s), thirdOpens(s),
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
  // The health check will act on this page's entry: it is not reconnecting,
  // and the page either offers from the check or has an entry to notice on.
  def healWillAct(s: str): bool =
    not(side.get(s).open) and not(side.get(s).recon) and (healRunsFor(s) or side.get(s).has)
  def hasDeadline(s: str): bool = or {
    side.get(s).giveUp,
    side.get(s).attempt > 0,
    healWillAct(s),
  }
  val everyWaitHasADeadline = canOffer implies SIDES.forall(s =>
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
    not(healWillAct(s)),
    not(side.get(s).open and not(alive(s))),
    not(side.get(s).has and not(side.get(s).open) and alive(s)),
  }
  val connected = side.get("lo").open and side.get("hi").open and alive("lo")
  val neverLeftWithNothingPending =
    (canOffer and running and not(connected) and wire == Set())
      implies not(SIDES.forall(s => nothingPendingFor(s)))

  // An answer is applied only to the connection that made the offer it
  // answers, and a candidate only to the connection it was gathered for.
  // Violated today: a retry replaces the connection, and the answer to the
  // earlier offer is then applied to the new one.
  // Violated with a counter alone (peer_connection_counter_only): a page
  // that replaces another numbers its offers from 1 again, so what was sent
  // for the old page's attempt passes for the new page's.
  val staleSignalsAreNotApplied = not(staleApplied)

  // I2 for a connection: the guest never has an open channel beside input
  // state from before a drop.
  val reconnectStartsClean = side.get("hi").open implies not(side.get("hi").dirty)

  // A roster update never replaces a connection that is up (#119).
  val neverEvictsLiveConnection = not(evictedLive)

  // A startup retry is never handled as a gameplay reconnect: when its
  // channel opens, the page does not ask the host for a resync, run
  // resetPeerState, show "reconnected" or report peer_reconnected.
  // Violated while the server dropped the startupReconnect flag
  // (peer_connection_before_startup_flag): in a room of three the page the
  // retry reaches may have started already (startupRetryToAStartedPageTest).
  val startupRetryIsNotAReconnect = not(retryAsReconnect)

  // The three that hold on today's engine.
  val holdToday = and { reconnectStartsClean, neverEvictsLiveConnection, startupRetryIsNotAReconnect }

  // With the health check run by the lower slot only and nothing else
  // changed (peer_connection_heal_one_side): what holds today, and the pair
  // no longer offers to each other at once or is left with nothing pending.
  // everyWaitHasADeadline is still violated there, as today: a page that
  // answers a reconnect offer it did not notice the need for waits with only
  // its answer timer (ANSWERER_HAS_DEADLINE, the next rule to wire).
  val holdWithHealOneSide = and { holdToday, oneInitiatorPerPair, neverLeftWithNothingPending }

  // What still holds when attempts go by a counter alone: all but
  // staleSignalsAreNotApplied.
  val holdWithACounterAlone = and {
    oneInitiatorPerPair, everyWaitHasADeadline, neverLeftWithNothingPending,
    reconnectStartsClean, neverEvictsLiveConnection, startupRetryIsNotAReconnect,
  }

  // Every property at once.
  val allHold = and {
    oneInitiatorPerPair, everyWaitHasADeadline, neverLeftWithNothingPending,
    staleSignalsAreNotApplied, reconnectStartsClean, neverEvictsLiveConnection,
    startupRetryIsNotAReconnect,
  }

  // ── scenarios ──────────────────────────────────────────────────────────

  def answerTo(dest: str, id: int): Msg = { dest: dest, kind: "answer", id: id, mode: "", bare: false }
  def bareAnswerTo(dest: str, id: int): Msg = { dest: dest, kind: "answer", id: id, mode: "", bare: true }
  def offerTo(dest: str, id: int): Msg = { dest: dest, kind: "offer", id: id, mode: "reconnect", bare: false }
  def firstOfferTo(dest: str, id: int): Msg = { dest: dest, kind: "offer", id: id, mode: "first", bare: false }
  def startupOfferTo(dest: str, id: int): Msg = { dest: dest, kind: "offer", id: id, mode: "startup", bare: false }
  def candidateTo(dest: str, id: int): Msg = { dest: dest, kind: "candidate", id: id, mode: "", bare: false }
  // A signal sent for a replaced page's attempt passes for its replacement's.
  val replacedPageIsMistaken = not(SIGNALS_CARRY_ATTEMPT) or not(ATTEMPT_NAMES_PAGE)
  def bothOpenOn(id: int): bool = SIDES.forall(s => side.get(s).open and side.get(s).link == id)

  // The roster reaches both pages, then the offer.
  run rosterThenOfferTest =
    initLobby
      .then(roster("lo"))
      .then(roster("hi"))
      .then(deliver(firstOfferTo("hi", 1)))
      .then(deliver(answerTo("lo", 1)))
      .then(channelOpens("lo"))
      .then(channelOpens("hi"))
      .then(start)
      .expect(bothOpenOn(1) and oneInitiatorPerPair)

  // The offer reaches the higher slot before its roster does.
  run offerBeforeRosterTest =
    initLobby
      .then(roster("lo"))
      .then(deliver(firstOfferTo("hi", 1)))
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
      .then(lose(firstOfferTo("hi", 1)))
      .then(startupTimeout)
      .then(deliver(startupOfferTo("hi", 2)))
      .then(deliver(answerTo("lo", 2)))
      .then(channelOpens("lo"))
      .then(channelOpens("hi"))
      .expect(bothOpenOn(2))

  // Every offer is lost. After the third attempt the watchdog stops and the
  // player is told; no timer is left armed.
  run startupGivesUpTest =
    initLobby
      .then(roster("lo"))
      .then(roster("hi"))
      .then(lose(firstOfferTo("hi", 1)))
      .then(startupTimeout)
      .then(lose(startupOfferTo("hi", 2)))
      .then(startupTimeout)
      .then(lose(startupOfferTo("hi", 3)))
      .expect(not(stalled) and side.get("lo").attempt == MAX_ATTEMPTS)
      .then(startupTimeout)
      .expect(stalled and side.get("lo").attempt == 0 and nextId == 4 and wire == Set())

  // The roster's offer is slow, the watchdog's retry connects the pair and
  // the match starts; then the first offer arrives. It is not a reconnect
  // offer, so the guest applies it to the connection it is playing on: the
  // channel stays open on a connection that now matches nothing, until the
  // guest notices.
  run lateFirstOfferTest =
    initLobby
      .then(roster("lo"))
      .then(roster("hi"))
      .then(startupTimeout)
      .then(deliver(startupOfferTo("hi", 2)))
      .then(deliver(answerTo("lo", 2)))
      .then(channelOpens("lo"))
      .then(channelOpens("hi"))
      .then(start)
      .then(deliver(firstOfferTo("hi", 1)))
      .expect(side.get("hi").open and not(side.get("hi").recon) and not(alive("hi")))
      .then(notice("hi"))
      .expect(side.get("hi").recon and side.get("hi").giveUp)

  // The channel dies on both pages with no event. Only the health check can
  // find it. Today each page's check offers; with one side offering, the
  // guest's check treats it as a drop and waits for the lower slot.
  run silentCloseTest =
    init
      .then(netDrop)
      .then(silentClose("hi"))
      .then(silentClose("lo"))
      .expect(everyWaitHasADeadline and neverLeftWithNothingPending)
      .then(heal("hi"))
      .expect(side.get("hi").recon == HEAL_ONE_SIDE and (side.get("hi").made != 0) == not(HEAL_ONE_SIDE))
      .then(heal("lo"))
      .expect(oneInitiatorPerPair == HEAL_ONE_SIDE)

  // The higher slot's health check finds the channel dead and the lower slot
  // never offers (it crashed, or its page is gone). With the check run by the
  // lower slot only, the higher slot treats the dead channel as a drop it has
  // just noticed: reconnecting, with the 45 s give-up armed (I1). The give-up
  // fires and the entry is dropped (hardDisconnectPeer), the existing route.
  // Today the higher slot offers instead.
  run higherHealsThenGivesUpTest =
    init
      .then(netDrop)
      .then(silentClose("hi"))
      .then(heal("hi"))
      .expect(
        if (HEAL_ONE_SIDE) side.get("hi").recon and side.get("hi").giveUp and side.get("hi").made == 0
        else side.get("hi").made != 0
      )
      .expect(everyWaitHasADeadline)
      .then(if (HEAL_ONE_SIDE) giveUpTimeout("hi") else stutter)
      .expect(if (HEAL_ONE_SIDE) not(side.get("hi").has) else true)

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

  // The lower slot's page is replaced while the answer to its offer is on
  // its way. The new page's first offer is number 1 again, as the old page's
  // was. By the number alone the old answer is the one it is waiting for: it
  // is applied to a connection it was not made for, and the answer that was
  // made for it then finds a page no longer waiting. With the page named
  // beside the number the old answer is dropped and the pair connects.
  run oldAnswerTakenByReplacementPageTest =
    initLobby
      .then(roster("lo"))
      .then(roster("hi"))
      .then(deliver(firstOfferTo("hi", 1)))
      .then(reload("lo"))
      .expect(not(side.get("lo").has) and side.get("hi").link == 1 and wire == Set(answerTo("lo", 1)))
      .then(roster("lo"))
      .expect(side.get("lo").made == 2 and labels.get(2).n == labels.get(1).n)
      .expect((labels.get(2) == labels.get(1)) == not(ATTEMPT_NAMES_PAGE))
      .then(deliver(answerTo("lo", 1)))
      .expect(staleApplied == replacedPageIsMistaken)
      .then(deliver(firstOfferTo("hi", 2)))
      .then(deliver(answerTo("lo", 2)))
      .expect(alive("lo") == not(replacedPageIsMistaken))

  // The same from the page that stays. The host's page is replaced in a
  // match with a candidate of its connection still on its way. The new page
  // offers, number 1 again; the guest answers, and then the old page's
  // candidate arrives: by the number alone it is for the connection the
  // guest has now. A channel event of the old connection (`opened`, `lost`)
  // reaches the guest's entry the same way.
  run oldCandidateReachesReplacementConnectionTest =
    init
      .then(candidateSent("lo"))
      .then(reload("lo"))
      .then(heal("lo"))
      .then(deliver(offerTo("hi", 2)))
      .expect(side.get("hi").link == 2 and labels.get(2).n == labels.get(1).n)
      .then(deliver(candidateTo("hi", 1)))
      .expect(staleApplied == replacedPageIsMistaken)
      .then(candidateSent("lo"))
      .then(deliver(candidateTo("hi", 2)))
      .expect(staleApplied == replacedPageIsMistaken)

  // The higher slot's page is an old one: it answers with no label. Today
  // the lower slot takes the answer and the pair connects. A page that goes
  // by labels has no label to match and drops it, the answer to its own
  // offer included: the pair never connects, nothing is applied stale, and
  // the lower slot is left to its startup retries, each answered the same
  // way. So nothing may decide by the label while an old page can be on the
  // other side; the engine's observer (web/src/peer-observe.ts) only watches
  // a player whose page has sent a label, and stops at the first signal that
  // has none.
  run oldPageAnswersWithNoLabelTest =
    initLobby
      .then(reloadOld("hi"))
      .then(roster("lo"))
      .then(roster("hi"))
      .then(deliver(firstOfferTo("hi", 1)))
      .expect(wire == Set(bareAnswerTo("lo", 1)))
      .then(deliver(bareAnswerTo("lo", 1)))
      .expect(not(staleApplied))
      .expect((side.get("lo").link == 1) == not(SIGNALS_CARRY_ATTEMPT))
      .expect(alive("lo") == not(SIGNALS_CARRY_ATTEMPT))

  // A room of three. The higher slot's channel with the third player has
  // opened, so its game has started; the lower slot's first offer to it was
  // lost and the lower slot, still starting, retries. Without the
  // startupReconnect flag the retry reaches a page that has started and is
  // taken for a reconnect: when its channel opens the page asks the host for
  // a resync and clears its per-peer state, during boot. With the flag it is
  // a startup retry and the pair just connects.
  run startupRetryToAStartedPageTest =
    initLobby
      .then(roster("lo"))
      .then(roster("hi"))
      .then(lose(firstOfferTo("hi", 1)))
      .then(thirdOpens("hi"))
      .then(startupTimeout)
      .then(deliver(startupOfferTo("hi", 2)))
      .expect(STARTUP_FLAG_RELAYED implies not(side.get("hi").recon))
      .expect(not(STARTUP_FLAG_RELAYED) implies side.get("hi").recon)
      .then(deliver(answerTo("lo", 2)))
      .then(channelOpens("hi"))
      .expect(STARTUP_FLAG_RELAYED implies startupRetryIsNotAReconnect)
      .expect(not(STARTUP_FLAG_RELAYED) implies not(startupRetryIsNotAReconnect))
      .then(channelOpens("lo"))
      .then(start)
      .expect(bothOpenOn(2))
}

// Before #119.
module peer_connection_before_119 {
  import peer_connection(HEAL_ONE_SIDE = false, ANSWERER_HAS_DEADLINE = false,
         SIGNALS_CARRY_ATTEMPT = false, ATTEMPT_NAMES_PAGE = false, ROSTER_KEEPS_LIVE = false,
         STARTUP_FLAG_RELAYED = false).*
}

// Before the server relayed startupReconnect. startupRetryIsNotAReconnect
// is violated here, on top of what is violated today.
module peer_connection_before_startup_flag {
  import peer_connection(HEAL_ONE_SIDE = false, ANSWERER_HAS_DEADLINE = false,
         SIGNALS_CARRY_ATTEMPT = false, ATTEMPT_NAMES_PAGE = false, ROSTER_KEEPS_LIVE = true,
         STARTUP_FLAG_RELAYED = false).*
}

// The engine as it is today. oneInitiatorPerPair, everyWaitHasADeadline,
// neverLeftWithNothingPending and staleSignalsAreNotApplied are violated here.
module peer_connection_current {
  import peer_connection(HEAL_ONE_SIDE = false, ANSWERER_HAS_DEADLINE = false,
         SIGNALS_CARRY_ATTEMPT = false, ATTEMPT_NAMES_PAGE = false, ROSTER_KEEPS_LIVE = true,
         STARTUP_FLAG_RELAYED = true).*
}

// The three proposed changes with attempts told apart by the offering page's
// counter alone, as the per-peer machine was first written.
// staleSignalsAreNotApplied is violated here: a page that replaces another
// reuses its numbers.
module peer_connection_counter_only {
  import peer_connection(HEAL_ONE_SIDE = true, ANSWERER_HAS_DEADLINE = true,
         SIGNALS_CARRY_ATTEMPT = true, ATTEMPT_NAMES_PAGE = false, ROSTER_KEEPS_LIVE = true,
         STARTUP_FLAG_RELAYED = true).*
}

// With the three proposed changes, and each attempt named by the page that
// offered and that page's counter: the rules the per-peer machine is built to.
module peer_connection_fixed {
  import peer_connection(HEAL_ONE_SIDE = true, ANSWERER_HAS_DEADLINE = true,
         SIGNALS_CARRY_ATTEMPT = true, ATTEMPT_NAMES_PAGE = true, ROSTER_KEEPS_LIVE = true,
         STARTUP_FLAG_RELAYED = true).*
}
// Today's engine with the mesh health check run by the lower slot only: the
// per-peer machine deciding `heal` and nothing else yet. During a deploy a
// page of the old version meets one of the new: the lower slot heals the same
// way in both, so a new higher slot with either is this module, and an old
// higher slot with either is peer_connection_current.
module peer_connection_heal_one_side {
  import peer_connection(HEAL_ONE_SIDE = true, ANSWERER_HAS_DEADLINE = false,
         SIGNALS_CARRY_ATTEMPT = false, ATTEMPT_NAMES_PAGE = false, ROSTER_KEEPS_LIVE = true,
         STARTUP_FLAG_RELAYED = true).*
}
