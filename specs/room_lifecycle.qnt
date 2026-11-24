// -*- mode: Bluespec; -*-
//
// Room lifecycle: the server's view of a room (server/src/api/signaling.py)
// against what each player's page is actually doing (web/static/play.js).
//
// The server only stores `status` ("lobby" | "playing") and a match id. Each
// page independently decides whether it shows the lobby or runs the emulator.
// The two are kept in step by broadcasts (game-started, game-ended) and by
// what a page does when it (re)joins. This model checks that they cannot
// drift apart.
//
// What is modelled, and where it comes from:
//   openRoom      _open_room_locked, new room
//   join          _join_room_locked, new player; a join into a playing room
//                 takes the late-join path (play.js "Mid-game join handling")
//   startGame     _start_game_locked, including a second delivery from the lobby.
//   endGame       _end_game_locked
//   leave         _leave (intentional), with ownership transfer
//   reload        page unload: the disconnected host or mid-game guest retains its seat
//   dropSocket    signaling socket drops mid-game, page keeps running
//   reopen        fresh page returns inside the grace window:
//                 open-room (host) or join-room (guest) reconnect path
//   resume        dropped socket reconnects, page never went away
//   graceExpire   _disconnect_grace_expiry
//
// A grace expiry represents the corresponding server deadline, independent of transport detection.
// Spectators, ROM readiness, passwords and WebRTC are outside this model.
//
// HOST_REOPEN_ENDS_MATCH selects the server behaviour for a host that
// re-opens a playing room from a fresh page:
//   false  today's code: swap the socket id, leave status "playing"
//   true   proposed fix: end the match and send everyone back to the lobby
module room {
  const HOST_REOPEN_ENDS_MATCH: bool
  // A fresh owner can open the public invite, which sends join-room.
  const INVITE_RECOGNIZES_OWNER: bool
  const HOST_TIMEOUT_CLOSES_ROOM: bool
  // What a page does when its socket reconnects under it:
  //   false  before: rejoin silently and keep whatever it was doing
  //   true   today (web/src/rejoin.ts): compare with the status and match
  //          id the rejoin returns, and follow the server when they differ
  const RESUME_RECONCILES: bool
  // What happens to a player who asks for the match state while the others
  // are still loading (nobody is running the match yet):
  //   false  before: the host only answered once it was running, and the
  //          others would not start without that player, so everyone waited
  //   true   today (web/src/late-join-wait.ts): the player is let into the
  //          start instead
  const START_ADMITS_JOINERS: bool
  // Who the players that are starting a match wait for before they run it:
  //   false  before: every player the room lists, including one who joined
  //          after the initial sync began and can never become ready
  //   true   today: only the players who were loaded when the sync began;
  //          anyone later is a late joiner and is served once they run
  const START_WAITS_ONLY_FOR_ITS_COHORT: bool
  // What happens when the socket of a page the server has dropped (its grace
  // window ran out) comes back and the page sends its mid-game rejoin. The
  // players' own connections are not the server's: a dropped player may well
  // still be playing, and the match is meant to survive that.
  //   false  before: a guest was let back in by join-room as if new, which
  //          worked when its match was still on; but a host's open-room made
  //          a second room or was refused, any refusal was only logged, and
  //          the page stayed in its game with no signaling
  //   true   today: the rejoin says it is a resume. The server takes the
  //          player back into the same match, refuses otherwise, and a
  //          refused page ends its game and joins again as a fresh page
  //          would (web/src/rejoin-attempt.ts)
  const RESUME_KNOWS_IT_WAS_DROPPED: bool
  // What the server does with a playing room once every player left in it
  // joined after the match began and is still waiting to get into it (at
  // the ROM prompt, starting its engine, or asking for state): nobody is
  // running the match, so nobody can ever serve them.
  //   false  before: nothing. The room stayed "playing", each joiner timed
  //          out, and a reload put it straight back on the late-join path
  //   true   today: the server ends the match (signaling.py,
  //          _end_match_if_abandoned) and everyone is back in the lobby
  const SERVER_ENDS_ABANDONED_MATCH: bool
  // The server keeps a dropped player's place while no player of the room is
  // connected at all, instead of dropping each after its own grace window.
  // Before, a signaling outage longer than the window that hit every player
  // (a server restart, a network drop) emptied the room, and the match the
  // players were still running over their own connections was ended when
  // they came back (seen in a two-player run with a 40 s outage, 2026-11-14).
  const GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED: bool
  // What a late joiner does when the host gives up serving it: the host's
  // serve deadline ran out (its state was lost, here with the joiner's
  // socket) and it drops the joiner (`dropped:` on their channel) so that it
  // asks again.
  //   false  before: the page restarted its engine as a player loading for
  //          the start (session.ts ignored `leftOutOfStart` while it was
  //          waiting for state, so the next start was not a late join). It
  //          waited for an offer and a start that never came, and the host
  //          held it as a pending late joiner for good (tests/lifecycle-e2e.mjs
  //          late-join-drop-during-serve, 2026-11-23)
  //   true   today: it starts its late join again and asks for the state
  const SERVE_TIMEOUT_RESTARTS_LATE_JOIN: bool

  // web/src/session.ts is the page half of this model, state for state:
  //   Lobby = lobby, AwaitingRom = lateJoinAwaitingRom, Starting =
  //   lateJoinStarting, Syncing = lateJoinSyncing, Running = running.
  // play.js reads "is a game on" from it (anything but Lobby). A room closed
  // by the server (`roomClosed` there) is `closeTab` here: the page is no
  // longer in the room.
  type Page =
    | Closed            // no tab
    | Lobby             // tab open, lobby UI, no emulator
    | AwaitingRom(int)  // joined match n in play; no usable ROM yet
    | Starting(int)     // joined match n in play; the next engine start is the late join
    | Syncing(int)      // late-join engine up, asking for the state of match n
    | Loading(int)      // in match n from its start: emulator loaded, waiting for the others
    | StartSync(int)    // everyone was loaded; the initial state sync for match n is under way
    | Running(int)      // emulator running match n
    | Stranded(int)     // still showing match n after the server refused its rejoin: no signaling, for good

  pure val PLAYERS = Set("host", "guest1", "guest2")
  pure val NOBODY = ""

  var members: Set[str]     // room.players
  var owner: str            // room.owner
  var creator: str          // whose page loaded as host (sends open-room on rejoin)
  var status: str           // room.status
  var matchId: int          // room.match_id, 0 = none
  var nextMatch: int
  var online: Set[str]      // members whose signaling socket is connected
  var grace: Set[str]       // members inside the disconnect grace window
  var page: str -> Page
  // History: a grace window running out removed the last player of a
  // playing room while that player's page was still in the match.
  var lostToGrace: bool

  pure def isOpen(pg: Page): bool = pg != Closed

  pure def isLateJoining(pg: Page): bool = match pg {
    | AwaitingRom(_) => true
    | Starting(_) => true
    | Syncing(_) => true
    | _ => false
  }

  // Where a page lands when it joins a room: the lobby, or the late-join
  // path of the match in play (asking for a ROM first if it has none).
  pure def joinedPage(st: str, m: int, hasRom: bool): Page =
    if (st != "playing") Lobby else if (hasRom) Starting(m) else AwaitingRom(m)

  // A page told the room's status and match id on rejoin: keep going if it
  // is already in (or joining) that match, otherwise do what a fresh join
  // would. A page that missed game-ended lands in the lobby; one that missed
  // a whole new match starts its late join.
  pure def reconciled(pg: Page, st: str, m: int, hasRom: bool): Page =
    if (st == "playing" and (pg == Running(m) or pg == Loading(m) or pg == StartSync(m) or pg == AwaitingRom(m) or pg == Starting(m) or pg == Syncing(m))) pg
    else joinedPage(st, m, hasRom)

  // game-started moves a page into the match unless it is already on the
  // late-join path, which it finishes for the new match id.
  pure def onGameStarted(pg: Page, m: int): Page = match pg {
    | AwaitingRom(_) => AwaitingRom(m)
    | Starting(_) => Starting(m)
    | Syncing(_) => Syncing(m)
    | _ => Loading(m)
  }

  // The match a page is showing, 0 for none.
  pure def gameOf(pg: Page): int = match pg {
    | AwaitingRom(n) => n
    | Starting(n) => n
    | Syncing(n) => n
    | Loading(n) => n
    | StartSync(n) => n
    | Running(n) => n
    | _ => 0
  }

  // ── helpers ────────────────────────────────────────────────────────────

  // Pages that hear a room broadcast: connected members with a tab open.
  def listeners: Set[str] = online.filter(p => isOpen(page.get(p)))

  def broadcast(target: Page): str -> Page =
    page.keys().mapBy(p => if (listeners.contains(p)) target else page.get(p))

  def broadcastGameStarted(m: int): str -> Page =
    page.keys().mapBy(p => if (listeners.contains(p)) onGameStarted(page.get(p), m) else page.get(p))

  // _leave: drop the player, hand the room on, delete it when empty.
  action removeMember(p: str, pageAfter: Page, byGrace: bool): bool = {
    val rest = members.exclude(Set(p))
    all {
      lostToGrace' = (lostToGrace or (byGrace and rest == Set() and status == "playing" and gameOf(page.get(p)) == matchId)),
      members' = rest,
      online' = online.exclude(Set(p)),
      grace' = grace.exclude(Set(p)),
      page' = page.set(p, pageAfter),
      creator' = if (creator == p) NOBODY else creator,
      nextMatch' = nextMatch,
      if (rest == Set()) all {
        owner' = NOBODY, status' = "lobby", matchId' = 0,
      } else all {
        status' = status, matchId' = matchId,
        if (owner == p) { nondet o = oneOf(rest) owner' = o } else owner' = owner,
      },
    }
  }

  // ── actions ────────────────────────────────────────────────────────────

  action init = all {
    members' = Set(), owner' = NOBODY, creator' = NOBODY,
    status' = "lobby", matchId' = 0, nextMatch' = 1, lostToGrace' = false,
    online' = Set(), grace' = Set(),
    page' = PLAYERS.mapBy(_ => Closed),
  }

  action openRoom(p: str): bool = all {
    members == Set(), page.get(p) == Closed,
    members' = Set(p), owner' = p, creator' = p,
    status' = "lobby", matchId' = 0, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
    online' = Set(p), grace' = Set(),
    page' = page.set(p, Lobby),
  }

  action join(p: str, hasRom: bool): bool = all {
    members != Set(), not(members.contains(p)), page.get(p) == Closed,
    not(HOST_TIMEOUT_CLOSES_ROOM and grace.contains(owner)),
    // room_is_live, or a player in grace is on their way back
    online != Set() or grace != Set(),
    members' = members.union(Set(p)),
    online' = online.union(Set(p)),
    page' = page.set(p, joinedPage(status, matchId, hasRom)),
    owner' = owner, creator' = creator, status' = status, matchId' = matchId,
    nextMatch' = nextMatch, lostToGrace' = lostToGrace, grace' = grace,
  }

  // The joiner dropped a ROM, or finished receiving the host's.
  action romReady(p: str): bool = all {
    page.get(p) == AwaitingRom(matchId), status == "playing",
    page' = page.set(p, Starting(matchId)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace, online' = online, grace' = grace,
  }

  // The joiner's engine starts as a late join and asks for the match state.
  action startLateJoinEngine(p: str): bool = all {
    page.get(p) == Starting(matchId), status == "playing",
    page' = page.set(p, Syncing(matchId)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace, online' = online, grace' = grace,
  }

  // A host may send two Start requests before its page hears game-started.
  const START_ONLY_IN_LOBBY: bool
  def matchForStart = if (START_ONLY_IN_LOBBY and status == "playing") matchId else nextMatch

  action startGame = all {
    online.contains(owner), page.get(owner) == Lobby or status == "playing",
    status' = "playing", matchId' = matchForStart, lostToGrace' = lostToGrace,
    if (matchForStart == matchId) all {
      nextMatch' = nextMatch, page' = page,
    } else all {
      nextMatch' = nextMatch + 1, page' = broadcastGameStarted(nextMatch),
    },
    members' = members, owner' = owner, creator' = creator,
    online' = online, grace' = grace,
  }

  // Once every player in the room has loaded, they sync the initial state
  // (the engine's checkAllEmuReady). From here no more players are admitted
  // to the start.
  action beginSync = all {
    status == "playing", members != Set(),
    members.forall(p => page.get(p) == Loading(matchId)),
    // The sync is among the players' own connections, not the server's list:
    // a player the server dropped while it was loading (its grace ran out)
    // is still connected to the others and syncs with them. Leaving it
    // behind in Loading made a start no late joiner could be let into
    // (joinersAreNotLeftWaitingAtTheStart, found by simulation 2026-11-14).
    page' = page.keys().mapBy(p =>
      if (members.contains(p) or page.get(p) == Loading(matchId)) StartSync(matchId) else page.get(p)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace, online' = online, grace' = grace,
  }

  // The players who synced are ready to run (checkAllLockstepReady).
  def startCanRun: bool = and {
    members.exists(p => page.get(p) == StartSync(matchId)),
    or {
      START_WAITS_ONLY_FOR_ITS_COHORT,
      members.forall(p => page.get(p) == StartSync(matchId)),
    },
  }

  action startRunning = all {
    status == "playing", startCanRun,
    page' = page.keys().mapBy(p => if (page.get(p) == StartSync(matchId)) Running(matchId) else page.get(p)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace, online' = online, grace' = grace,
  }

  // Can a player who is asking for the match state get it? Only from a
  // connected player who is running the match.
  def canBeServed(p: str): bool =
    online.exists(q => q != p and page.get(q) == Running(matchId))

  // Nobody is running the match yet and the others are loading: with the
  // fix, the player joins the start instead of waiting for state.
  def canBeAdmitted(p: str): bool = and {
    START_ADMITS_JOINERS,
    not(members.exists(q => page.get(q) == Running(matchId) or page.get(q) == StartSync(matchId))),
    online.exists(q => q != p and page.get(q) == Loading(matchId)),
  }

  action admitToStart(p: str): bool = all {
    status == "playing", online.contains(p), page.get(p) == Syncing(matchId),
    canBeAdmitted(p),
    page' = page.set(p, Loading(matchId)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace, online' = online, grace' = grace,
  }

  // The End button lives in the game UI.
  action endGame = all {
    status == "playing", online.contains(owner),
    page.get(owner) == Running(matchId) or page.get(owner) == Loading(matchId)
      or page.get(owner) == StartSync(matchId),
    status' = "lobby", matchId' = 0,
    page' = broadcast(Lobby),
    members' = members, owner' = owner, creator' = creator,
    online' = online, grace' = grace, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
  }

  // A late joiner gets the state from a connected peer that is running it.
  action serveLateJoin(p: str): bool = all {
    status == "playing", online.contains(p), page.get(p) == Syncing(matchId),
    canBeServed(p),
    page' = page.set(p, Running(matchId)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace, online' = online, grace' = grace,
  }

  action leave(p: str): bool = all {
    online.contains(p),
    removeMember(p, Closed, false),
  }

  action reload(p: str): bool = all {
    status == "playing" or p == owner, online.contains(p),
    online' = online.exclude(Set(p)), grace' = grace.union(Set(p)),
    page' = page.set(p, Closed),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
  }

  action dropSocket(p: str): bool = all {
    status == "playing" or p == owner, online.contains(p),
    online' = online.exclude(Set(p)), grace' = grace.union(Set(p)),
    page' = page,
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
  }

  action keepRoom = all {
    page' = page, status' = status, matchId' = matchId,
    online' = online, grace' = grace, members' = members, owner' = owner,
    creator' = creator, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
  }

  // A fresh page can also be a duplicated host tab, with copied session
  // storage. It cannot replace the owner while that socket is connected.
  action reopen(p: str, hasRom: bool, publicInvite: bool): bool = all {
    (grace.contains(p) and page.get(p) == Closed) or (p == owner and online.contains(p)),
    if (INVITE_RECOGNIZES_OWNER and p == owner and online.contains(p)) keepRoom
    else all {
      online' = online.union(Set(p)), grace' = grace.exclude(Set(p)),
      members' = members, owner' = owner, creator' = creator, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
      if (p == owner and HOST_REOPEN_ENDS_MATCH and ((p == creator and not(publicInvite)) or INVITE_RECOGNIZES_OWNER)) all {
        // The authenticated owner has lost its emulator, whichever link it used.
        status' = "lobby", matchId' = 0,
        page' = broadcast(Lobby).set(p, Lobby),
      } else if (p == creator and not(publicInvite)) all {
        // Before #104, open-room's reconnect path returns no status; the page shows the lobby.
        status' = status, matchId' = matchId,
        page' = page.set(p, Lobby),
      } else all {
        // join-room's reconnect path returns status; a playing room means late join.
        status' = status, matchId' = matchId,
        page' = page.set(p, joinedPage(status, matchId, hasRom)),
      },
    },
  }

  // A different tab may claim only the offline owner's retained seat using
  // that room's proof. A refusal leaves both the room and the old page alone.
  action recoverHostTab(p: str, proofForRoom: bool): bool =
    if (INVITE_RECOGNIZES_OWNER and p == owner and proofForRoom and not(online.contains(p)))
      reopen(p, true, true)
    else keepRoom

  // Socket reconnects under a page that kept running. The match must survive
  // this, so a fix for `reopen` has to tell a fresh page from a reconnect.
  action resume(p: str, hasRom: bool): bool = all {
    grace.contains(p), isOpen(page.get(p)),
    online' = online.union(Set(p)), grace' = grace.exclude(Set(p)),
    page' = if (RESUME_RECONCILES) page.set(p, reconciled(page.get(p), status, matchId, hasRom)) else page,
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
  }

  // The host gave up serving a late joiner (no word that it loaded within
  // the host's serve deadline) and drops it so that it asks again.
  action serveTimesOut(p: str): bool = all {
    status == "playing", page.get(p) == Syncing(matchId), canBeServed(p),
    page' = page.set(p, if (SERVE_TIMEOUT_RESTARTS_LATE_JOIN) Starting(matchId) else Loading(matchId)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace, online' = online, grace' = grace,
  }

  action graceExpire(p: str): bool = all {
    grace.contains(p),
    if (HOST_TIMEOUT_CLOSES_ROOM and p == owner) all {
      members' = Set(), online' = Set(), grace' = Set(), creator' = NOBODY, owner' = NOBODY,
      status' = "lobby", matchId' = 0, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
      page' = broadcast(Closed),
    } else all {
      not(GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED) or status != "playing" or online != Set(),
      removeMember(p, page.get(p), true),
    },
  }

  // Nobody has come back to a playing room for far longer than the grace
  // window (minutes, not seconds): the server gives the room up. The players
  // may still be in their match; this is the bound on how long an outage the
  // room survives, not a state the server can tell apart from closed tabs.
  action giveUpOnSilentRoom = all {
    not(HOST_TIMEOUT_CLOSES_ROOM), GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED,
    status == "playing", members != Set(), online == Set(),
    members' = Set(), online' = Set(), grace' = Set(),
    owner' = NOBODY, creator' = NOBODY, status' = "lobby", matchId' = 0,
    page' = page, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
  }

  // The socket of a page the server dropped comes back and it sends its
  // mid-game rejoin: open-room from a page that loaded as host, join-room
  // from any other. The page kept its game meanwhile (see `graceExpire`).
  action returnAfterExpiry(p: str, hasRom: bool, asHost: bool): bool = {
    val was = gameOf(page.get(p))
    val sameMatch = status == "playing" and was == matchId
    val roomTakesJoiners = members != Set() and (online != Set() or grace != Set())
                           and not(HOST_TIMEOUT_CLOSES_ROOM and grace.contains(owner))
    all {
      was != 0, not(members.contains(p)),
      nextMatch' = nextMatch, lostToGrace' = lostToGrace, grace' = grace,
      if (roomTakesJoiners and sameMatch and (RESUME_KNOWS_IT_WAS_DROPPED or not(asHost))) all {
        // Back into the match it never stopped playing. Before, only a guest
        // got this (by accident: join-room took it for a new player); a host
        // was told "Room already exists" and stayed out of the room for good.
        members' = members.union(Set(p)), online' = online.union(Set(p)),
        owner' = owner, creator' = creator, status' = status, matchId' = matchId,
        page' = page,
      } else if (roomTakesJoiners and (not(asHost) or RESUME_KNOWS_IT_WAS_DROPPED)) all {
        // The room has moved on to the lobby or another match. Before, a
        // guest was let in and reconciled; now it is refused and joins
        // afresh. Either way it lands where a fresh join would. A page that
        // loaded as host does the same now: its room has another owner, so
        // it comes in as a guest instead of failing to open the room.
        members' = members.union(Set(p)), online' = online.union(Set(p)),
        owner' = owner, creator' = creator, status' = status, matchId' = matchId,
        page' = page.set(p, joinedPage(status, matchId, hasRom)),
      } else if (asHost and members == Set() and not(HOST_TIMEOUT_CLOSES_ROOM)) all {
        // The room is gone and open-room makes a new one. Before, the page
        // kept showing its game on top of it.
        members' = Set(p), owner' = p, creator' = p, online' = Set(p),
        status' = "lobby", matchId' = 0,
        page' = page.set(p, if (RESUME_KNOWS_IT_WAS_DROPPED) Lobby else Stranded(was)),
      } else all {
        // Refused, and a fresh join would be too: the room is gone, closed
        // to joiners, or (for a host) has another owner. Before, that was
        // only logged; now the page shows it.
        members' = members, owner' = owner, creator' = creator, online' = online,
        status' = status, matchId' = matchId,
        page' = page.set(p, if (RESUME_KNOWS_IT_WAS_DROPPED) Closed else Stranded(was)),
      },
    }
  }

  // Every player in the room joined after the match began and has not got
  // into it yet. This is what the server can see: who joined mid-match, and
  // who has since said it is in (`match-joined`).
  def everyoneIsWaiting: bool =
    members != Set() and members.forall(p => isLateJoining(page.get(p)))

  action endAbandonedMatch = all {
    SERVER_ENDS_ABANDONED_MATCH, status == "playing", everyoneIsWaiting,
    status' = "lobby", matchId' = 0,
    page' = broadcast(Lobby),
    members' = members, owner' = owner, creator' = creator,
    online' = online, grace' = grace, nextMatch' = nextMatch, lostToGrace' = lostToGrace,
  }

  // A page that is no longer in the room is closed by its user.
  action closeTab(p: str): bool = all {
    not(members.contains(p)), isOpen(page.get(p)),
    page' = page.set(p, Closed),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, lostToGrace' = lostToGrace, online' = online, grace' = grace,
  }

  action step = any {
    startGame,
    beginSync,
    startRunning,
    endGame,
    endAbandonedMatch,
    giveUpOnSilentRoom,
    nondet p = oneOf(PLAYERS)
    nondet hasRom = oneOf(Set(true, false))
    nondet asHost = oneOf(Set(true, false))
    any {
      returnAfterExpiry(p, hasRom, asHost),
      openRoom(p), join(p, hasRom), romReady(p), startLateJoinEngine(p), serveLateJoin(p), admitToStart(p),
      serveTimesOut(p),
      leave(p), reload(p), dropSocket(p), reopen(p, hasRom, not(asHost)), resume(p, hasRom), graceExpire(p), closeTab(p),
    },
  }

  // ── properties ─────────────────────────────────────────────────────────

  val aLiveMatchCannotStartAgain = status == "playing" implies matchForStart == matchId

  // The host never sits in the lobby while the server says a game is on.
  // Violated today (production, 2026-11-09, room X8XXM872): joiners were sent
  // down the late-join path towards a host with no emulator running.
  val ownerSeesGame =
    (status == "playing" and listeners.contains(owner)) implies page.get(owner) != Lobby

  // The original owner, while it still owns the room, cannot late-join
  // the match it must serve. A successor can inherit ownership mid-join.
  val ownerDoesNotLateJoinItsOwnMatch =
    (status == "playing" and owner == creator and listeners.contains(owner)) implies
      not(isLateJoining(page.get(owner)))

  // The next two failed before RESUME_RECONCILES and hold with it. Both came
  // from a page whose socket was down while the room moved on: on reconnect
  // it rejoined silently and never compared itself with the server.
  //
  // A page on the late-join path is joining the match the server is running
  // now. Failed before: a joiner at the ROM prompt loses its socket, the host
  // ends that game and starts another, and the joiner carries on joining the
  // old one (found by the model, 2026-11-13; not seen in production).
  val lateJoinersChaseTheCurrentMatch =
    PLAYERS.forall(p =>
      (listeners.contains(p) and isLateJoining(page.get(p)) and status == "playing") implies or {
        page.get(p) == AwaitingRom(matchId),
        page.get(p) == Starting(matchId),
        page.get(p) == Syncing(matchId),
      })

  // Every connected page agrees with the server about lobby vs playing.
  // Failed before when a page missed game-ended while its socket was down.
  val pagesAgreeWithServer =
    listeners.forall(p => (page.get(p) == Lobby) iff (status == "lobby"))

  // A player asking for the match state while the others are still loading
  // always has a way forward. Failed before (found by tests/lifecycle-e2e.mjs,
  // 2026-11-13, then modelled): the host answered a state request only once
  // it was running, and it would not run until that player had loaded, so
  // both waited for ever. Typical cause: the player's socket was down when the
  // host pressed start, so the page missed game-started and came back down
  // the late-join path.
  val joinersAreNotLeftWaitingAtTheStart =
    PLAYERS.forall(p =>
      (and {
        status == "playing", online.contains(p), page.get(p) == Syncing(matchId),
        members.exists(q => q != p and online.contains(q) and page.get(q) == Loading(matchId)),
        not(members.exists(q => page.get(q) == Running(matchId))),
      }) implies (canBeServed(p) or canBeAdmitted(p)))

  // Players who have synced the start are never held up by someone who
  // joined after the sync began. Failed before (Codex review of #125, then
  // modelled): the ready barrier counted every player the room listed, the
  // newcomer could never be ready, so the match never ran and the newcomer
  // never got its state.
  val startIsNotHeldUpByALateJoiner =
    (status == "playing" and members.exists(p => page.get(p) == StartSync(matchId))) implies startCanRun

  // A page whose rejoin the server refused is never left showing its game
  // with no signaling. Failed before (read from the code, 2026-11-13, then
  // modelled and seen in a run): a host whose socket was down for longer
  // than the grace window came back, was refused or handed a new empty
  // room, and stayed in its game; any refusal was only logged.
  val nobodyIsStrandedInADroppedMatch =
    PLAYERS.forall(p => match page.get(p) {
      | Stranded(_) => false
      | _ => true
    })

  // Nobody loads for the start of a match someone is already running: that
  // start is over, and a page loading for it waits for good. Failed before
  // SERVE_TIMEOUT_RESTARTS_LATE_JOIN: a late joiner the host dropped after
  // its serve timed out restarted as a player loading for the start.
  val nobodyLoadsIntoARunningMatch =
    members.exists(p => page.get(p) == Running(matchId)) implies
      PLAYERS.forall(p => page.get(p) != Loading(matchId))

  // A playing room nobody is running is ended. "Nobody" leaves out players
  // inside their grace window, who may be on their way back. Failed before
  // (found by the model when the late-join states were added, listed as
  // open until now): the players running a match left, the one player
  // still in the room was a late joiner waiting for its state, and the room
  // stayed "playing" for good.
  val matchHasNobody = and {
    status == "playing", members != Set(), grace == Set(),
    not(members.exists(p => page.get(p) == Running(matchId) or page.get(p) == Loading(matchId)
      or page.get(p) == StartSync(matchId))),
  }
  val anAbandonedMatchIsEnded =
    matchHasNobody implies (SERVER_ENDS_ABANDONED_MATCH and everyoneIsWaiting)

  // A player-slot timer cannot tear down a match while everyone is offline.
  // A room can still close when the host reservation itself expires.
  val aMatchIsNotLostToTheGraceWindow = not(lostToGrace)

  // ── scenarios ──────────────────────────────────────────────────────────

  run lobbyHostReturnTest = init.then(openRoom("host")).then(join("guest1", true)).then(reload("host"))
    .expect(grace.contains(owner)).then(reopen("host", true, false))
    .expect(owner == "host" and online == Set("host", "guest1") and grace == Set())

  run deliberateLeaveHasNoReturnTest = init.then(openRoom("host")).then(join("guest1", true)).then(leave("host"))
    .then(recoverHostTab("host", true)).expect(owner == "guest1" and not(members.contains("host")))

  run expiredLobbyHostCannotReturnTest = init.then(openRoom("host")).then(join("guest1", true)).then(reload("host"))
    .then(graceExpire("host")).then(recoverHostTab("host", true))
    .expect(if (HOST_TIMEOUT_CLOSES_ROOM) members == Set() and owner == NOBODY and page.get("guest1") == Closed
            else members == Set("guest1") and owner == "guest1")

  // Two Start requests arrive for the same lobby. Even after the host starts running,
  // the delayed request leaves the match alone. End returns the host to the lobby for a rematch.
  run queuedStartsTest =
    init.then(openRoom("host")).then(startGame)
      .then(beginSync).then(startRunning)
      .then(startGame)
      .expect(if (START_ONLY_IN_LOBBY) matchId == 1 and page.get("host") == Running(1)
              else matchId == 2 and page.get("host") == Loading(2))
      .then(endGame).then(startGame)
      .expect(matchId == (if (START_ONLY_IN_LOBBY) 2 else 3))

  // The production sequence: host starts alone, reloads, a friend joins.
  run hostReloadTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(reload("host"))
      .then(reopen("host", true, false))
      .then(join("guest1", true))
      .expect(ownerSeesGame == HOST_REOPEN_ENDS_MATCH)
      .expect(page.get("guest1") == (if (HOST_REOPEN_ENDS_MATCH) Lobby else Starting(1)))

  // The owner returns through a public invite after losing its emulator.
  // join-room used to tell it to late-join the match it was hosting.
  run ownerReopensInviteTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(beginSync).then(startRunning)
      .then(reload("host"))
      .then(reopen("host", true, true))
      .expect(owner == "host")
      .expect(page.get("host") == (if (INVITE_RECOGNIZES_OWNER) Lobby else Starting(1)))
      .expect(page.get("guest1") == (if (INVITE_RECOGNIZES_OWNER) Lobby else Running(1)))
      .expect((status == "lobby") == INVITE_RECOGNIZES_OWNER)

  run copiedHostTabTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(beginSync).then(startRunning)
      .then(reopen("host", true, false))
      .expect((page.get("host") == Running(1)) == INVITE_RECOGNIZES_OWNER)
      .expect((status == "playing" and page.get("guest1") == Running(1)) ==
              (INVITE_RECOGNIZES_OWNER or not(HOST_REOPEN_ENDS_MATCH)))

  run hostRecoveryInAnotherTabTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(beginSync).then(startRunning)
      .then(recoverHostTab("host", true))
      .expect(status == "playing" and page.get("host") == Running(1))
      .then(reload("host"))
      .then(recoverHostTab("host", false))
      .expect(page.get("host") == Closed and owner == "host")
      .then(recoverHostTab("guest1", true))
      .expect(owner == "host" and page.get("guest1") == Running(1))
      .then(recoverHostTab("host", true))
      .expect((status == "lobby" and page.get("host") == Lobby) == INVITE_RECOGNIZES_OWNER)

  // A dropped socket under a running page must not end the match.
  run socketDropKeepsMatchTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .expect(page.get("host") == Loading(1) and page.get("guest1") == Loading(1))
      .then(beginSync).then(startRunning)
      .then(dropSocket("host"))
      .then(resume("host", true))
      .expect(status == "playing" and page.get("host") == Running(1) and page.get("guest1") == Running(1))

  // A guest's socket is down for longer than the grace window while the
  // match goes on, then comes back: it is taken back and keeps playing, in
  // every variant. The players' connections never depended on the server.
  run returnAfterGraceTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(beginSync)
      .then(startRunning)
      .then(dropSocket("guest1"))
      .then(graceExpire("guest1"))
      .expect(page.get("guest1") == Running(1) and not(members.contains("guest1")))
      .then(returnAfterExpiry("guest1", true, false))
      .expect(members.contains("guest1") and page.get("guest1") == Running(1))

  // Only an explicit departure can hand the room to the guest. When the
  // disconnected owner's deadline expires, a late return finds a closed room.
  run hostReturnsAfterGraceTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(beginSync)
      .then(startRunning)
      .then(dropSocket("host"))
      .then(graceExpire("host"))
      .expect(if (HOST_TIMEOUT_CLOSES_ROOM) members == Set() and page.get("guest1") == Closed
              else owner == "guest1" and status == "playing")
      .then(returnAfterExpiry("host", true, true))
      .expect(page.get("host") == (if (HOST_TIMEOUT_CLOSES_ROOM) Closed
                                  else if (RESUME_KNOWS_IT_WAS_DROPPED) Running(1) else Stranded(1)))
      .expect(members.contains("host") == (not(HOST_TIMEOUT_CLOSES_ROOM) and RESUME_KNOWS_IT_WAS_DROPPED))

  // Every player's signaling is down for longer than the grace window while
  // the match runs on over their own connections. Before, the room was
  // emptied and the returning host was handed a new, empty room and sent to
  // its lobby. Now their places are kept and both resume the match.
  run everyoneDropsTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(beginSync)
      .then(startRunning)
      .then(dropSocket("host"))
      .then(dropSocket("guest1"))
      .then(if (GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED) resume("host", true)
            else graceExpire("host").then(graceExpire("guest1")).then(returnAfterExpiry("host", true, true)))
      .expect(lostToGrace == not(GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED))
      .expect(page.get("host") == (if (GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED) Running(1)
                                   else if (RESUME_KNOWS_IT_WAS_DROPPED) Lobby else Stranded(1)))
      .expect((status == "playing") == GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED)

  // The host leaves for good while a joiner is still getting in. Before, the
  // room stayed "playing" with nobody running the match.
  run abandonedMatchTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(beginSync)
      .then(startRunning)
      .then(join("guest1", false))
      .expect(page.get("guest1") == AwaitingRom(1))
      .then(leave("host"))
      .expect(status == "playing" and owner == "guest1" and matchHasNobody)
      .then(if (SERVER_ENDS_ABANDONED_MATCH) endAbandonedMatch else romReady("guest1"))
      .expect(page.get("guest1") == (if (SERVER_ENDS_ABANDONED_MATCH) Lobby else Starting(1)))
      .expect((status == "lobby") == SERVER_ENDS_ABANDONED_MATCH)

  run lateJoinTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(beginSync).then(startRunning)
      .then(join("guest1", true))
      .expect(page.get("guest1") == Starting(1))
      .then(startLateJoinEngine("guest1"))
      .then(serveLateJoin("guest1"))
      .expect(page.get("guest1") == Running(1))
      .then(endGame)
      .expect(status == "lobby" and page.get("guest1") == Lobby and ownerSeesGame)

  // A late joiner's socket drops and comes back (a new socket id) before it
  // has the match state: once while its engine is starting, and once more
  // while it is asking for the state. Seen once in a real-ROM run of
  // tests/lifecycle-e2e.mjs late-join-cached on an older branch, where the
  // joiner logged "mid-game rejoin succeeded" and then went to the lobby.
  // Here, as on the server, the resume keeps the joiner on the late-join path
  // of the same match, and it is still served. What a new socket id does to
  // the engines' own state is below this model: the fault modes
  // late-join-drop-before-request and late-join-drop-during-serve in
  // tests/lifecycle-e2e.mjs take a real page through both windows.
  run lateJoinerSocketDropTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(beginSync).then(startRunning)
      .then(join("guest1", true))
      .expect(page.get("guest1") == Starting(1))
      .then(dropSocket("guest1"))
      .then(resume("guest1", true))
      .expect(page.get("guest1") == Starting(1) and members.contains("guest1") and status == "playing")
      .then(startLateJoinEngine("guest1"))
      .then(dropSocket("guest1"))
      .then(resume("guest1", true))
      .expect(page.get("guest1") == Syncing(1) and pagesAgreeWithServer and lateJoinersChaseTheCurrentMatch)
      .then(serveLateJoin("guest1"))
      .expect(page.get("guest1") == Running(1) and page.get("host") == Running(1))

  // The same, and the host's state for the joiner is lost with the socket:
  // the host's serve deadline runs out and it drops the joiner so that it
  // asks again (tests/lifecycle-e2e.mjs late-join-drop-during-serve). Before,
  // the joiner restarted as a player loading for the start and was stuck.
  run lateJoinServeTimeoutTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(beginSync).then(startRunning)
      .then(join("guest1", true))
      .then(startLateJoinEngine("guest1"))
      .then(dropSocket("guest1"))
      .then(resume("guest1", true))
      .then(serveTimesOut("guest1"))
      .expect(nobodyLoadsIntoARunningMatch == SERVE_TIMEOUT_RESTARTS_LATE_JOIN)
      .expect(page.get("guest1") == (if (SERVE_TIMEOUT_RESTARTS_LATE_JOIN) Starting(1) else Loading(1)))
      .then(if (SERVE_TIMEOUT_RESTARTS_LATE_JOIN) startLateJoinEngine("guest1").then(serveLateJoin("guest1")) else endGame)
      .expect(page.get("guest1") == (if (SERVE_TIMEOUT_RESTARTS_LATE_JOIN) Running(1) else Lobby))

  // A joiner with no ROM is asked for one before its engine starts.
  run lateJoinWithoutRomTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(beginSync).then(startRunning)
      .then(join("guest1", false))
      .expect(page.get("guest1") == AwaitingRom(1))
      .then(romReady("guest1"))
      .then(startLateJoinEngine("guest1"))
      .then(serveLateJoin("guest1"))
      .expect(page.get("guest1") == Running(1))

  // The host ends the game while a joiner is still choosing a ROM.
  run gameEndsWhileAwaitingRomTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(join("guest1", false))
      .then(endGame)
      .expect(page.get("guest1") == Lobby)

  // A third player arrives after the host pressed start but before the
  // first two have finished loading. (The same shape as a player whose
  // socket was down when the host pressed start: the page missed
  // game-started and comes back down the late-join path.)
  run joinWhileOthersLoadTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(join("guest2", true))
      .then(startLateJoinEngine("guest2"))
      .expect(page.get("host") == Loading(1) and page.get("guest2") == Syncing(1))
      .expect(joinersAreNotLeftWaitingAtTheStart == START_ADMITS_JOINERS)
      .then(if (START_ADMITS_JOINERS) admitToStart("guest2").then(beginSync).then(startRunning) else endGame)
      .expect(if (START_ADMITS_JOINERS) page.get("guest2") == Running(1) else page.get("guest2") == Lobby)

  // A third player arrives after the first two have begun their initial
  // sync. Nobody is admitted to the start any more: the two run without the
  // newcomer, who is then served as a late joiner.
  run joinDuringInitialSyncTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(beginSync)
      .then(join("guest2", true))
      .then(startLateJoinEngine("guest2"))
      .expect(page.get("host") == StartSync(1) and page.get("guest2") == Syncing(1))
      .expect(startIsNotHeldUpByALateJoiner == START_WAITS_ONLY_FOR_ITS_COHORT)
      .then(if (START_WAITS_ONLY_FOR_ITS_COHORT) startRunning.then(serveLateJoin("guest2")) else endGame)
      .expect(if (START_WAITS_ONLY_FOR_ITS_COHORT) page.get("guest2") == Running(1) else page.get("guest2") == Lobby)
}

// The server and client as they are today.
module room_current {
  import room(HOST_TIMEOUT_CLOSES_ROOM = true,
         START_ONLY_IN_LOBBY = true, INVITE_RECOGNIZES_OWNER = true, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = true,
         SERVER_ENDS_ABANDONED_MATCH = true, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = true,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = true).*
}

// The owner opening the public invite was treated as a late joiner.
module room_before_owner_invite_fix {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         START_ONLY_IN_LOBBY = true, INVITE_RECOGNIZES_OWNER = false, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = true,
         SERVER_ENDS_ABANDONED_MATCH = true, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = true,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = true).*
}

// A second Start delivery used to allocate another match and restart every listening page.
module room_before_duplicate_start_fix {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         INVITE_RECOGNIZES_OWNER = false, START_ONLY_IN_LOBBY = false, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = true,
         SERVER_ENDS_ABANDONED_MATCH = true, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = true,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = true).*
}

// Before a late joiner the host dropped after its serve timed out started its
// late join again. nobodyLoadsIntoARunningMatch is violated here.
module room_before_serve_timeout_fix {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         START_ONLY_IN_LOBBY = false, INVITE_RECOGNIZES_OWNER = false, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = true,
         SERVER_ENDS_ABANDONED_MATCH = true, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = true,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = false).*
}

// Before the server kept the places of a room nobody was connected to.
// aMatchIsNotLostToTheGraceWindow is violated here.
module room_before_grace_wait {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         START_ONLY_IN_LOBBY = false, INVITE_RECOGNIZES_OWNER = false, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = true,
         SERVER_ENDS_ABANDONED_MATCH = true, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = false,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = false).*
}

// Before the server ended a match nobody was running.
// anAbandonedMatchIsEnded is violated here.
module room_before_abandoned_end {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         START_ONLY_IN_LOBBY = false, INVITE_RECOGNIZES_OWNER = false, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = true,
         SERVER_ENDS_ABANDONED_MATCH = false, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = false,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = false).*
}

// Before a rejoin said it was a resume and a refusal was acted on.
// nobodyIsStrandedInADroppedMatch is violated here.
module room_before_resume_flag {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         START_ONLY_IN_LOBBY = false, INVITE_RECOGNIZES_OWNER = false, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = false,
         SERVER_ENDS_ABANDONED_MATCH = false, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = false,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = false).*
}

// Before a joiner who asks for state too early was admitted to the start
// (web/src/late-join-wait.ts). joinersAreNotLeftWaitingAtTheStart is
// violated here.
module room_before_start_fix {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         START_ONLY_IN_LOBBY = false, INVITE_RECOGNIZES_OWNER = false, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = false,
         START_WAITS_ONLY_FOR_ITS_COHORT = false, RESUME_KNOWS_IT_WAS_DROPPED = false,
         SERVER_ENDS_ABANDONED_MATCH = false, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = false,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = false).*
}

// Before the page reconciled with the server on reconnect
// (web/src/rejoin.ts). lateJoinersChaseTheCurrentMatch and
// pagesAgreeWithServer are violated here.
module room_before_reconcile {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         START_ONLY_IN_LOBBY = false, INVITE_RECOGNIZES_OWNER = false, HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = false, START_ADMITS_JOINERS = false,
         START_WAITS_ONLY_FOR_ITS_COHORT = false, RESUME_KNOWS_IT_WAS_DROPPED = false,
         SERVER_ENDS_ABANDONED_MATCH = false, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = false,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = false).*
}

// Before #104, kept so hostReloadTest still shows what that fix changed.
module room_before_104 {
  import room(HOST_TIMEOUT_CLOSES_ROOM = false,
         START_ONLY_IN_LOBBY = false, INVITE_RECOGNIZES_OWNER = false, HOST_REOPEN_ENDS_MATCH = false, RESUME_RECONCILES = false, START_ADMITS_JOINERS = false,
         START_WAITS_ONLY_FOR_ITS_COHORT = false, RESUME_KNOWS_IT_WAS_DROPPED = false,
         SERVER_ENDS_ABANDONED_MATCH = false, GRACE_WAITS_WHILE_NOBODY_IS_CONNECTED = false,
         SERVE_TIMEOUT_RESTARTS_LATE_JOIN = false).*
}
