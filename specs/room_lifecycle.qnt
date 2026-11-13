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
//   startGame     _start_game_locked. Note: no guard on room.status.
//   endGame       _end_game_locked
//   leave         _leave (intentional), with ownership transfer
//   reload        page unload mid-game: socket drops, 30 s grace keeps the slot
//   dropSocket    signaling socket drops mid-game, page keeps running
//   reopen        fresh page returns inside the grace window:
//                 open-room (host) or join-room (guest) reconnect path
//   resume        dropped socket reconnects, page never went away
//   graceExpire   _disconnect_grace_expiry
//
// Not modelled: spectators, ROM readiness, passwords, the 5 s lobby-owner
// grace (a lobby reload is treated as leave + join), WebRTC itself.
//
// HOST_REOPEN_ENDS_MATCH selects the server behaviour for a host that
// re-opens a playing room from a fresh page:
//   false  today's code: swap the socket id, leave status "playing"
//   true   proposed fix: end the match and send everyone back to the lobby
module room {
  const HOST_REOPEN_ENDS_MATCH: bool
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
  // What a rejoin does for a page whose grace window ran out, so the server
  // has already dropped it from the room:
  //   false  before: the guest's join-room took it for a new player and let
  //          it in, and the page (same match id) carried on with a game the
  //          others had dropped it from; any refusal was only logged
  //   true   today: the rejoin says it is a resume, the server refuses a
  //          resume from a non-member, and the page ends its game and joins
  //          again as a fresh page would (web/src/rejoin-attempt.ts)
  const RESUME_KNOWS_IT_WAS_DROPPED: bool

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
    | Orphaned(int)     // still showing match n, socket down, dropped by the room when its grace ran out
    | Stranded(int)     // socket back and the server has answered, yet still showing match n it was dropped from

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

  // A page the room drops while its tab is still showing a game does not
  // know it yet: its socket is down.
  pure def droppedPage(pg: Page): Page = match pg {
    | AwaitingRom(n) => Orphaned(n)
    | Starting(n) => Orphaned(n)
    | Syncing(n) => Orphaned(n)
    | Loading(n) => Orphaned(n)
    | StartSync(n) => Orphaned(n)
    | Running(n) => Orphaned(n)
    | _ => pg
  }

  pure def orphanedMatch(pg: Page): int = match pg {
    | Orphaned(n) => n
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
  action removeMember(p: str, pageAfter: Page): bool = {
    val rest = members.exclude(Set(p))
    all {
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
    status' = "lobby", matchId' = 0, nextMatch' = 1,
    online' = Set(), grace' = Set(),
    page' = PLAYERS.mapBy(_ => Closed),
  }

  action openRoom(p: str): bool = all {
    members == Set(), page.get(p) == Closed,
    members' = Set(p), owner' = p, creator' = p,
    status' = "lobby", matchId' = 0, nextMatch' = nextMatch,
    online' = Set(p), grace' = Set(),
    page' = page.set(p, Lobby),
  }

  action join(p: str, hasRom: bool): bool = all {
    members != Set(), not(members.contains(p)), page.get(p) == Closed,
    // room_is_live, or a player in grace is on their way back
    online != Set() or grace != Set(),
    members' = members.union(Set(p)),
    online' = online.union(Set(p)),
    page' = page.set(p, joinedPage(status, matchId, hasRom)),
    owner' = owner, creator' = creator, status' = status, matchId' = matchId,
    nextMatch' = nextMatch, grace' = grace,
  }

  // The joiner dropped a ROM, or finished receiving the host's.
  action romReady(p: str): bool = all {
    page.get(p) == AwaitingRom(matchId), status == "playing",
    page' = page.set(p, Starting(matchId)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, online' = online, grace' = grace,
  }

  // The joiner's engine starts as a late join and asks for the match state.
  action startLateJoinEngine(p: str): bool = all {
    page.get(p) == Starting(matchId), status == "playing",
    page' = page.set(p, Syncing(matchId)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, online' = online, grace' = grace,
  }

  // The Start button lives in the lobby UI; the server checks only ownership.
  action startGame = all {
    online.contains(owner), page.get(owner) == Lobby,
    status' = "playing", matchId' = nextMatch, nextMatch' = nextMatch + 1,
    page' = broadcastGameStarted(nextMatch),
    members' = members, owner' = owner, creator' = creator,
    online' = online, grace' = grace,
  }

  // Once every player in the room has loaded, they sync the initial state
  // (the engine's checkAllEmuReady). From here no more players are admitted
  // to the start.
  action beginSync = all {
    status == "playing", members != Set(),
    members.forall(p => page.get(p) == Loading(matchId)),
    page' = page.keys().mapBy(p => if (members.contains(p)) StartSync(matchId) else page.get(p)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, online' = online, grace' = grace,
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
    matchId' = matchId, nextMatch' = nextMatch, online' = online, grace' = grace,
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
    matchId' = matchId, nextMatch' = nextMatch, online' = online, grace' = grace,
  }

  // The End button lives in the game UI.
  action endGame = all {
    status == "playing", online.contains(owner),
    page.get(owner) == Running(matchId) or page.get(owner) == Loading(matchId)
      or page.get(owner) == StartSync(matchId),
    status' = "lobby", matchId' = 0,
    page' = broadcast(Lobby),
    members' = members, owner' = owner, creator' = creator,
    online' = online, grace' = grace, nextMatch' = nextMatch,
  }

  // A late joiner gets the state from a connected peer that is running it.
  action serveLateJoin(p: str): bool = all {
    status == "playing", online.contains(p), page.get(p) == Syncing(matchId),
    canBeServed(p),
    page' = page.set(p, Running(matchId)),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, online' = online, grace' = grace,
  }

  action leave(p: str): bool = all {
    online.contains(p),
    removeMember(p, Closed),
  }

  action reload(p: str): bool = all {
    status == "playing", online.contains(p),
    online' = online.exclude(Set(p)), grace' = grace.union(Set(p)),
    page' = page.set(p, Closed),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch,
  }

  action dropSocket(p: str): bool = all {
    status == "playing", online.contains(p),
    online' = online.exclude(Set(p)), grace' = grace.union(Set(p)),
    page' = page,
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch,
  }

  // Fresh page, back inside the grace window.
  action reopen(p: str, hasRom: bool): bool = all {
    grace.contains(p), page.get(p) == Closed,
    online' = online.union(Set(p)), grace' = grace.exclude(Set(p)),
    members' = members, owner' = owner, creator' = creator, nextMatch' = nextMatch,
    if (p == creator and HOST_REOPEN_ENDS_MATCH) all {
      // Proposed: the host's emulator is gone, so the match is over.
      status' = "lobby", matchId' = 0,
      page' = broadcast(Lobby).set(p, Lobby),
    } else if (p == creator) all {
      // Today: open-room's reconnect path returns no status; the page shows the lobby.
      status' = status, matchId' = matchId,
      page' = page.set(p, Lobby),
    } else all {
      // join-room's reconnect path returns status; a playing room means late join.
      status' = status, matchId' = matchId,
      page' = page.set(p, joinedPage(status, matchId, hasRom)),
    },
  }

  // Socket reconnects under a page that kept running. The match must survive
  // this, so a fix for `reopen` has to tell a fresh page from a reconnect.
  action resume(p: str, hasRom: bool): bool = all {
    grace.contains(p), isOpen(page.get(p)),
    online' = online.union(Set(p)), grace' = grace.exclude(Set(p)),
    page' = if (RESUME_RECONCILES) page.set(p, reconciled(page.get(p), status, matchId, hasRom)) else page,
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch,
  }

  action graceExpire(p: str): bool = all {
    grace.contains(p),
    removeMember(p, droppedPage(page.get(p))),
  }

  // The socket of a dropped page comes back and it sends its mid-game rejoin:
  // open-room from a page that loaded as host, join-room from any other.
  action returnAfterExpiry(p: str, hasRom: bool, asHost: bool): bool = {
    val was = orphanedMatch(page.get(p))
    val roomTakesJoiners = members != Set() and (online != Set() or grace != Set())
    all {
      was != 0, not(members.contains(p)),
      nextMatch' = nextMatch, grace' = grace,
      if (asHost and members == Set()) all {
        // open-room finds no room and creates one. Before, the page kept its
        // game; now it is told its resume failed and opens the room afresh.
        members' = Set(p), owner' = p, creator' = p, online' = Set(p),
        status' = "lobby", matchId' = 0,
        page' = page.set(p, if (RESUME_KNOWS_IT_WAS_DROPPED) Lobby else Stranded(was)),
      } else if (asHost or not(roomTakesJoiners)) all {
        // Refused: the room has another owner now, or is gone, or is closed
        // to joiners. Before, that was only logged; now the page shows it.
        members' = members, owner' = owner, creator' = creator, online' = online,
        status' = status, matchId' = matchId,
        page' = page.set(p, if (RESUME_KNOWS_IT_WAS_DROPPED) Closed else Stranded(was)),
      } else all {
        // join-room lets the player in as a new member. Before, a page still
        // showing the room's current match saw nothing to reconcile.
        members' = members.union(Set(p)), online' = online.union(Set(p)),
        owner' = owner, creator' = creator, status' = status, matchId' = matchId,
        page' = page.set(p,
          if (not(RESUME_KNOWS_IT_WAS_DROPPED) and status == "playing" and was == matchId) Stranded(was)
          else joinedPage(status, matchId, hasRom)),
      },
    }
  }

  // A page that is no longer in the room is closed by its user.
  action closeTab(p: str): bool = all {
    not(members.contains(p)), isOpen(page.get(p)),
    page' = page.set(p, Closed),
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch, online' = online, grace' = grace,
  }

  action step = any {
    startGame,
    beginSync,
    startRunning,
    endGame,
    nondet p = oneOf(PLAYERS)
    nondet hasRom = oneOf(Set(true, false))
    nondet asHost = oneOf(Set(true, false))
    any {
      returnAfterExpiry(p, hasRom, asHost),
      openRoom(p), join(p, hasRom), romReady(p), startLateJoinEngine(p), serveLateJoin(p), admitToStart(p),
      leave(p), reload(p), dropSocket(p), reopen(p, hasRom), resume(p, hasRom), graceExpire(p), closeTab(p),
    },
  }

  // ── properties ─────────────────────────────────────────────────────────

  // The host never sits in the lobby while the server says a game is on.
  // Violated today (production, 2026-11-09, room X8XXM872): joiners were sent
  // down the late-join path towards a host with no emulator running.
  val ownerSeesGame =
    (status == "playing" and listeners.contains(owner)) implies page.get(owner) != Lobby

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

  // A page whose rejoin the server has answered is never left showing a
  // match the room dropped it from. Failed before (read from the code,
  // 2026-11-13, then modelled): a socket that was down for longer than the
  // grace window came back, join-room let the player in as a new member, and
  // the page carried on with its old game; a refused rejoin was only logged.
  val nobodyIsStrandedInADroppedMatch =
    PLAYERS.forall(p => match page.get(p) {
      | Stranded(_) => false
      | _ => true
    })

  // An open question, not gated in CI and not fixed by RESUME_RECONCILES.
  //
  // A playing room always has someone running the match, or someone on their
  // way back to it. Fails when the only player left is a late joiner still
  // waiting for state.
  val noGhostMatch =
    status == "playing" implies or {
      members.exists(p => page.get(p) == Running(matchId) or page.get(p) == Loading(matchId)
        or page.get(p) == StartSync(matchId)),
      grace.exists(p => page.get(p) == Closed),
    }

  // ── scenarios ──────────────────────────────────────────────────────────

  // The production sequence: host starts alone, reloads, a friend joins.
  run hostReloadTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(reload("host"))
      .then(reopen("host", true))
      .then(join("guest1", true))
      .expect(ownerSeesGame == HOST_REOPEN_ENDS_MATCH)
      .expect(page.get("guest1") == (if (HOST_REOPEN_ENDS_MATCH) Lobby else Starting(1)))

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
  // match goes on, then comes back. Before, join-room took it for a new
  // player and the page carried on with the game it had been dropped from.
  run returnAfterGraceTest =
    init
      .then(openRoom("host"))
      .then(join("guest1", true))
      .then(startGame)
      .then(beginSync)
      .then(startRunning)
      .then(dropSocket("guest1"))
      .then(graceExpire("guest1"))
      .expect(page.get("guest1") == Orphaned(1) and not(members.contains("guest1")))
      .then(returnAfterExpiry("guest1", true, false))
      .expect(members.contains("guest1"))
      .expect(page.get("guest1") == (if (RESUME_KNOWS_IT_WAS_DROPPED) Starting(1) else Stranded(1)))

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
  import room(HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = true).*
}

// Before a rejoin said it was a resume. nobodyIsStrandedInADroppedMatch is
// violated here.
module room_before_resume_flag {
  import room(HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = true,
         START_WAITS_ONLY_FOR_ITS_COHORT = true, RESUME_KNOWS_IT_WAS_DROPPED = false).*
}

// Before a joiner who asks for state too early was admitted to the start
// (web/src/late-join-wait.ts). joinersAreNotLeftWaitingAtTheStart is
// violated here.
module room_before_start_fix {
  import room(HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = true, START_ADMITS_JOINERS = false,
         START_WAITS_ONLY_FOR_ITS_COHORT = false, RESUME_KNOWS_IT_WAS_DROPPED = false).*
}

// Before the page reconciled with the server on reconnect
// (web/src/rejoin.ts). lateJoinersChaseTheCurrentMatch and
// pagesAgreeWithServer are violated here.
module room_before_reconcile {
  import room(HOST_REOPEN_ENDS_MATCH = true, RESUME_RECONCILES = false, START_ADMITS_JOINERS = false,
         START_WAITS_ONLY_FOR_ITS_COHORT = false, RESUME_KNOWS_IT_WAS_DROPPED = false).*
}

// Before #104, kept so hostReloadTest still shows what that fix changed.
module room_before_104 {
  import room(HOST_REOPEN_ENDS_MATCH = false, RESUME_RECONCILES = false, START_ADMITS_JOINERS = false,
         START_WAITS_ONLY_FOR_ITS_COHORT = false, RESUME_KNOWS_IT_WAS_DROPPED = false).*
}
