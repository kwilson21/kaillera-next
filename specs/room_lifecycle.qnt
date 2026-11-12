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

  type Page =
    | Closed          // no tab
    | Lobby           // tab open, lobby UI, no emulator
    | Waiting(int)    // late joiner asking for the state of match n
    | Running(int)    // emulator running match n

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

  // ── helpers ────────────────────────────────────────────────────────────

  // Pages that hear a room broadcast: connected members with a tab open.
  def listeners: Set[str] = online.filter(p => isOpen(page.get(p)))

  def broadcast(target: Page): str -> Page =
    page.keys().mapBy(p => if (listeners.contains(p)) target else page.get(p))

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

  action join(p: str): bool = all {
    members != Set(), not(members.contains(p)), page.get(p) == Closed,
    // room_is_live, or a player in grace is on their way back
    online != Set() or grace != Set(),
    members' = members.union(Set(p)),
    online' = online.union(Set(p)),
    page' = page.set(p, if (status == "playing") Waiting(matchId) else Lobby),
    owner' = owner, creator' = creator, status' = status, matchId' = matchId,
    nextMatch' = nextMatch, grace' = grace,
  }

  // The Start button lives in the lobby UI; the server checks only ownership.
  action startGame = all {
    online.contains(owner), page.get(owner) == Lobby,
    status' = "playing", matchId' = nextMatch, nextMatch' = nextMatch + 1,
    page' = broadcast(Running(nextMatch)),
    members' = members, owner' = owner, creator' = creator,
    online' = online, grace' = grace,
  }

  // The End button lives in the game UI.
  action endGame = all {
    status == "playing", online.contains(owner), page.get(owner) == Running(matchId),
    status' = "lobby", matchId' = 0,
    page' = broadcast(Lobby),
    members' = members, owner' = owner, creator' = creator,
    online' = online, grace' = grace, nextMatch' = nextMatch,
  }

  // A late joiner gets the state from a connected peer that is running it.
  action serveLateJoin(p: str): bool = all {
    status == "playing", online.contains(p), page.get(p) == Waiting(matchId),
    online.exists(q => q != p and page.get(q) == Running(matchId)),
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
  action reopen(p: str): bool = all {
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
      page' = page.set(p, if (status == "playing") Waiting(matchId) else Lobby),
    },
  }

  // Socket reconnects under a page that kept running. The match must survive
  // this, so a fix for `reopen` has to tell a fresh page from a reconnect.
  action resume(p: str): bool = all {
    grace.contains(p), isOpen(page.get(p)),
    online' = online.union(Set(p)), grace' = grace.exclude(Set(p)),
    page' = page,
    members' = members, owner' = owner, creator' = creator, status' = status,
    matchId' = matchId, nextMatch' = nextMatch,
  }

  action graceExpire(p: str): bool = all {
    grace.contains(p),
    removeMember(p, page.get(p)),
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
    endGame,
    nondet p = oneOf(PLAYERS)
    any {
      openRoom(p), join(p), serveLateJoin(p), leave(p), reload(p), dropSocket(p),
      reopen(p), resume(p), graceExpire(p), closeTab(p),
    },
  }

  // ── properties ─────────────────────────────────────────────────────────

  // The host never sits in the lobby while the server says a game is on.
  // Violated today (production, 2026-11-09, room X8XXM872): joiners were sent
  // down the late-join path towards a host with no emulator running.
  val ownerSeesGame =
    (status == "playing" and listeners.contains(owner)) implies page.get(owner) != Lobby

  // Open questions the model raises. Neither is confirmed against the client
  // and neither is gated in CI.
  //
  // A playing room always has someone running the match, or someone on their
  // way back to it. Fails when the only player left is a late joiner still
  // waiting for state.
  val noGhostMatch =
    status == "playing" implies or {
      members.exists(p => page.get(p) == Running(matchId)),
      grace.exists(p => page.get(p) == Closed),
    }

  // Every connected page agrees with the server about lobby vs playing.
  // Fails when a page misses game-ended while its socket is down.
  val pagesAgreeWithServer =
    listeners.forall(p => (page.get(p) == Lobby) iff (status == "lobby"))

  // ── scenarios ──────────────────────────────────────────────────────────

  // The production sequence: host starts alone, reloads, a friend joins.
  run hostReloadTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(reload("host"))
      .then(reopen("host"))
      .then(join("guest1"))
      .expect(ownerSeesGame == HOST_REOPEN_ENDS_MATCH)
      .expect(page.get("guest1") == (if (HOST_REOPEN_ENDS_MATCH) Lobby else Waiting(1)))

  // A dropped socket under a running page must not end the match.
  run socketDropKeepsMatchTest =
    init
      .then(openRoom("host"))
      .then(join("guest1"))
      .then(startGame)
      .then(dropSocket("host"))
      .then(resume("host"))
      .expect(status == "playing" and page.get("host") == Running(1) and page.get("guest1") == Running(1))

  run lateJoinTest =
    init
      .then(openRoom("host"))
      .then(startGame)
      .then(join("guest1"))
      .then(serveLateJoin("guest1"))
      .then(endGame)
      .expect(status == "lobby" and page.get("guest1") == Lobby and ownerSeesGame)
}

module room_current {
  import room(HOST_REOPEN_ENDS_MATCH = false).*
}

module room_fixed {
  import room(HOST_REOPEN_ENDS_MATCH = true).*
}
