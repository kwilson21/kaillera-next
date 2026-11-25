// A returning player in a fresh tab can reclaim a disconnected seat until
// the earlier of that player's deadline and the room's host deadline.
// Each tick represents a minute after the server notices a disconnect.
module room_member_return {
  const RESERVE_PLAYER: bool
  var s: { now: int, hostUntil: int, playerUntil: int, player: str, open: bool }
  action init = s' = { now: 0, hostUntil: 0, playerUntil: 0, player: "online", open: true }
  action hostDrops = all {
    s.open, s.hostUntil == 0,
    s' = s.with("hostUntil", s.now + 2),
  }
  action playerDrops = all {
    s.open, s.player == "online",
    s' = if (RESERVE_PLAYER) s.with("player", "reserved").with("playerUntil", s.now + 2)
         else s.with("player", "gone"),
  }
  action playerLeaves = all {
    s.open, s.player == "online", s' = s.with("player", "gone").with("playerUntil", 0),
  }
  action playerReturns(proof: bool): bool = all {
    if (s.open and proof and s.player == "reserved" and s.now < s.playerUntil
        and (s.hostUntil == 0 or s.now < s.hostUntil))
      s' = s.with("player", "online").with("playerUntil", 0)
    else s' = s,
  }
  action hostReturns = all {
    s.open, s.hostUntil > s.now, s' = s.with("hostUntil", 0),
  }
  action tick = all {
    s.open, s.now < 5,
    val t = s.now + 1
    s' = if (s.hostUntil > 0 and t >= s.hostUntil)
           s.with("now", t).with("open", false).with("hostUntil", 0).with("playerUntil", 0).with("player", "gone")
         else if (s.player == "reserved" and t >= s.playerUntil)
           s.with("now", t).with("playerUntil", 0).with("player", "gone")
         else s.with("now", t),
  }
  action step = any { hostDrops, playerDrops, playerLeaves, hostReturns,
    playerReturns(true), playerReturns(false), tick, s' = s }
  val allHold = (s.open or s.player == "gone") and
    ((s.player == "reserved") == (s.playerUntil > s.now)) and
    (s.hostUntil == 0 or s.hostUntil > s.now)

  run guestReturnsToEmptyRoomTest = init.then(hostDrops).then(tick).then(playerDrops)
    .then(playerReturns(false)).expect(s.player != "online")
    .then(playerReturns(true)).expect((s.player == "online") == RESERVE_PLAYER)
    .expect(s.hostUntil == 2).then(tick).expect(not(s.open)).then(playerReturns(true)).expect(s.player == "gone")
  run guestReturnsWhileHostIsPresentTest = init.then(playerDrops).then(tick)
    .then(playerReturns(true)).expect((s.player == "online") == RESERVE_PLAYER and s.hostUntil == 0)
  run explicitLeaveCannotReturnTest = init.then(playerLeaves).then(playerReturns(true)).expect(s.player == "gone")
  run expiredGuestCannotReturnTest = init.then(playerDrops).then(tick).then(tick)
    .then(playerReturns(true)).expect(s.open and s.player == "gone")
}

// Server admission after a match participant loses its page or connection.
// A held seat alone cannot stand in for a player still running this fight.
module room_return_match {
  const REQUIRE_ORIGINALS: bool
  pure val guests = Set("p2", "p3")
  var live: Set[str]
  var originalTabs: Set[str]
  var hostAway: bool
  var playing: bool
  action init = all { live' = guests, originalTabs' = guests, hostAway' = true, playing' = true }
  action disconnect(p: str): bool = all {
    live.contains(p), live' = live.exclude(Set(p)), originalTabs' = originalTabs, hostAway' = hostAway, playing' = playing,
  }
  action freshGuest(p: str): bool = all {
    not(live.contains(p)), live' = live.union(Set(p)), originalTabs' = originalTabs.exclude(Set(p)),
    hostAway' = hostAway, playing' = (playing and not(REQUIRE_ORIGINALS and hostAway)),
  }
  action hostReturns(sameEmulator: bool, recoverableState: bool): bool = all {
    hostAway, hostAway' = false, originalTabs' = originalTabs, live' = live,
    playing' = (playing and (if (REQUIRE_ORIGINALS) live == guests and originalTabs == guests
                                        and (sameEmulator or recoverableState)
                            else sameEmulator)),
  }
  run hostReturnsMissingPlayerTest = init.then(disconnect("p3")).then(hostReturns(true, false))
    .expect(playing == not(REQUIRE_ORIGINALS))
  run freshGuestBeforeHostTest = init.then(disconnect("p2")).then(freshGuest("p2"))
    .expect(hostAway and playing == not(REQUIRE_ORIGINALS)).then(hostReturns(true, false))
    .expect(playing == not(REQUIRE_ORIGINALS))
  run originalEmulatorCanContinueTest = init.then(hostReturns(true, false)).expect(playing)
  run noStateNeedsRematchTest = init.then(hostReturns(false, false)).expect(not(playing))
  run savedFightWithEveryoneTest = init.then(hostReturns(false, true)).expect(playing == REQUIRE_ORIGINALS)
  run savedFightWithMissingOriginalTest = init.then(disconnect("p2")).then(hostReturns(false, true)).expect(not(playing))
}
module room_return_match_before {
  import room_return_match(REQUIRE_ORIGINALS = false).*
}
module room_return_match_fixed {
  import room_return_match(REQUIRE_ORIGINALS = true).*
}
module room_member_return_before {
  import room_member_return(RESERVE_PLAYER = false).*
}
module room_member_return_fixed {
  import room_member_return(RESERVE_PLAYER = true).*
}

// A saved fight uses a new network match ID. The emulators must not advance
// until all of that fight's seats have installed the saved state in that epoch.
module room_saved_fight {
  pure val participants = Set("host", "guest1", "guest2")
  var s: { phase: str, epoch: int, seats: Set[str], ready: Set[str] }
  action init = s' = { phase: "restoring", epoch: 2, seats: participants, ready: Set() }
  action installed(p: str, epoch: int): bool = {
    val receipts = s.ready.union(Set(p))
    if (s.phase == "restoring" and s.epoch == epoch and s.seats.contains(p))
      s' = s.with("ready", receipts).with("phase", if (receipts == participants) "playing" else "restoring")
    else s' = s
  }
  action missing(p: str): bool = all {
    s.phase == "restoring", s.seats.contains(p),
    s' = s.with("phase", "lobby").with("seats", s.seats.exclude(Set(p))).with("ready", Set()),
  }
  action timeout = all { s.phase == "restoring", s' = s.with("phase", "lobby").with("ready", Set()) }
  action step = any {
    nondet p = oneOf(participants.union(Set("spectator")))
    nondet epoch = oneOf(Set(1, 2))
    installed(p, epoch),
    nondet p = oneOf(participants)
    missing(p), timeout, s' = s,
  }
  val everyoneInstalled = s.phase != "playing" or (s.ready == participants and s.seats == participants)
  run unanimousRestoreTest = init.then(installed("host", 2)).then(installed("guest2", 2))
    .then(installed("guest1", 1)).then(installed("spectator", 2)).expect(s.phase == "restoring")
    .then(installed("guest1", 2)).expect(s.phase == "playing")
  run lossDuringRestoreTest = init.then(installed("guest1", 2)).then(missing("guest1"))
    .then(installed("host", 2)).then(installed("guest2", 2)).expect(s.phase == "lobby")
}

// The room grant and the local emulator install can arrive in either order.
// The page keeps the source save until both have arrived or the return is cancelled.
module room_saved_seat {
  const REQUIRE_LOCAL_INSTALL: bool
  var s: { installed: bool, granted: bool, cancelled: bool, released: bool }
  action init = s' = { installed: false, granted: false, cancelled: false, released: false }
  action install = if (s.cancelled) s' = s
    else s' = s.with("installed", true).with("released", s.granted)
  action grant(current: bool): bool = if (not(current) or s.cancelled) s' = s
    else s' = s.with("granted", true).with("released", s.installed or not(REQUIRE_LOCAL_INSTALL))
  action restart = if (s.released or s.cancelled) s' = s else s' = s.with("installed", false)
  action cancel = if (s.released) s' = s else s' = s.with("cancelled", true)
  action step = any { install, grant(true), grant(false), restart, cancel }
  val releaseNeedsBoth = not(s.released) or (s.installed and s.granted and not(s.cancelled))
  run earlyGrantTest = init.then(grant(true)).expect(s.released == not(REQUIRE_LOCAL_INSTALL))
    .then(install).expect(s.released)
  run installBeforeGrantTest = init.then(install).then(grant(false)).expect(not(s.released))
    .then(grant(true)).expect(s.released)
  run restartedEngineTest = init.then(install).then(restart).then(grant(true))
    .expect(s.released == not(REQUIRE_LOCAL_INSTALL)).then(install).expect(s.released)
  run cancelledInstallTest = init.then(install).then(cancel).then(grant(true)).expect(not(s.released))
}
module room_saved_seat_before {
  import room_saved_seat(REQUIRE_LOCAL_INSTALL = false).*
}
module room_saved_seat_fixed {
  import room_saved_seat(REQUIRE_LOCAL_INSTALL = true).*
}

// WebRTC can keep a data channel "open" after its transport failed. During
// the room's host hold, only recent direct traffic can keep the guest playing.
module room_host_traffic {
  const REQUIRE_TRAFFIC: bool
  var hostHeld: bool
  var channelOpen: bool
  var transportLive: bool
  var age: int
  action init = all { hostHeld' = false, channelOpen' = true, transportLive' = true, age' = 0 }
  action serverHold = all { hostHeld' = true, channelOpen' = channelOpen, transportLive' = transportLive, age' = age }
  action rtcFailure = all { hostHeld' = hostHeld, channelOpen' = channelOpen, transportLive' = false, age' = age }
  action rtcClose = all { hostHeld' = hostHeld, channelOpen' = false, transportLive' = false, age' = age }
  action silence = all {
    hostHeld' = hostHeld, channelOpen' = channelOpen, transportLive' = transportLive, age' = if (age < 2) age + 1 else age,
  }
  action confirmedHostTraffic = all {
    transportLive, channelOpen, age' = 0, transportLive' = transportLive, hostHeld' = hostHeld, channelOpen' = channelOpen,
  }
  action step = any { serverHold, rtcFailure, rtcClose, silence, confirmedHostTraffic }
  val advancing = not(hostHeld) or (channelOpen and (not(REQUIRE_TRAFFIC) or (transportLive and age < 2)))
  val staleHostCannotAdvance = not(hostHeld) or (transportLive and age < 2) or not(advancing)
  run failedTransportStillOpenTest = init.then(serverHold).then(rtcFailure).expect(advancing == not(REQUIRE_TRAFFIC))
  run silentOpenTransportTest = init.then(silence).then(serverHold).then(silence).expect(advancing == not(REQUIRE_TRAFFIC))
  run directTrafficSurvivesSignalingLossTest = init.then(serverHold).then(silence).then(confirmedHostTraffic).expect(advancing)
  run rtcClosesBeforeSignalingTest = init.then(rtcClose).then(serverHold).expect(not(advancing))
}
module room_host_traffic_before {
  import room_host_traffic(REQUIRE_TRAFFIC = false).*
}
module room_host_traffic_fixed {
  import room_host_traffic(REQUIRE_TRAFFIC = true).*
}

// A guest already syncing its match loses the host peer during a host hold.
// A roster for an older match cannot consume its chance to restart.
module room_late_join_host {
  const MODEL_WAIT: bool
  var page: { phase: str, awaitingHost: bool, restarts: int }
  action init = page' = { phase: "syncing", awaitingHost: false, restarts: 0 }
  action losePeer = all {
    page.phase == "syncing", page.restarts == 0,
    page' = page.with("phase", if (MODEL_WAIT) "waiting" else "syncing").with("awaitingHost", true),
  }
  action roster(sameMatch: bool): bool =
    if (page.awaitingHost and sameMatch)
      page' = { phase: "starting", awaitingHost: false, restarts: page.restarts + 1 }
    else if (page.awaitingHost and not(MODEL_WAIT)) page' = page.with("awaitingHost", false)
    else page' = page
  action endRoom = page' = page.with("phase", "lobby").with("awaitingHost", false)
  action step = any { losePeer, roster(false), roster(true), endRoom }
  val hostWaitStopsSyncWatchdog = not(page.awaitingHost) or page.phase != "syncing"
  val allHold = hostWaitStopsSyncWatchdog and page.restarts <= 1
  run lateGuestWaitsForMatchingRosterTest = init.then(losePeer)
    .expect(hostWaitStopsSyncWatchdog == MODEL_WAIT).then(roster(false)).then(roster(true)).then(roster(true))
    .expect(page.restarts == (if (MODEL_WAIT) 1 else 0))
  run lateGuestCannotRestartClosedRoomTest = init.then(losePeer).then(endRoom).then(roster(true))
    .expect(page.phase == "lobby" and page.restarts == 0)
}
module room_late_join_host_before {
  import room_late_join_host(MODEL_WAIT = false).*
}
module room_late_join_host_fixed {
  import room_late_join_host(MODEL_WAIT = true).*
}

// A room may broadcast its roster before acknowledging the returning tab's
// join. A visible seat and its persisted identity must agree in both orders.
module room_return_identity {
  const BIND_BEFORE_PUBLISH: bool
  var page: { identity: str, visible: bool, ack: bool }
  action init = page' = { identity: "temporary", visible: false, ack: false }
  action roster(matchesSeat: bool): bool =
    if (matchesSeat)
      page' = page.with("visible", true).with("identity", if (BIND_BEFORE_PUBLISH) "member" else page.identity)
    else page' = page
  action acknowledged = page' = { identity: "member", visible: true, ack: true }
  action step = any { roster(true), roster(false), acknowledged }
  val visibleSeatHasItsIdentity = not(page.visible) or page.identity == "member"
  run rosterBeforeReturnAcknowledgementTest = init.then(roster(false)).expect(not(page.visible))
    .then(roster(true)).expect(visibleSeatHasItsIdentity == BIND_BEFORE_PUBLISH).then(acknowledged).expect(page.ack)
  run returnAcknowledgementBeforeRosterTest = init.then(acknowledged).then(roster(true)).expect(visibleSeatHasItsIdentity)
}
module room_return_identity_before {
  import room_return_identity(BIND_BEFORE_PUBLISH = false).*
}
module room_return_identity_fixed {
  import room_return_identity(BIND_BEFORE_PUBLISH = true).*
}

// The delay in a verified save is part of its owner-input history. A new
// connection can negotiate a different delay from the one that made it.
module room_saved_delay {
  const USE_SAVED_DELAY: bool
  var saved: int
  var measured: int
  var host: int
  var guest: int

  action init = all { saved' = -1, measured' = 1, host' = -1, guest' = -1 }
  action start(s: int, m: int): bool = all {
    host == -1, saved' = s, measured' = m,
    host' = if (USE_SAVED_DELAY and s >= 0) s else m, guest' = -1,
  }
  action hearHost = all { host >= 0, guest' = host, host' = host, saved' = saved, measured' = measured }
  action step = any { start(-1, 1), start(-1, 4), start(1, 4), start(4, 1), start(4, 4), hearHost, init }
  val startMatchesInputHistory = host == -1 or
    (host == (if (saved >= 0) saved else measured) and (guest == -1 or guest == host))
  run changedReturnDelayTest = init.then(start(1, 4)).then(hearHost).expect(startMatchesInputHistory == USE_SAVED_DELAY)
  run freshDelayTest = init.then(start(-1, 4)).then(hearHost).expect(guest == 4 and startMatchesInputHistory)
  run sameReturnDelayTest = init.then(start(4, 4)).then(hearHost).expect(guest == 4 and startMatchesInputHistory)
}
module room_saved_delay_before {
  import room_saved_delay(USE_SAVED_DELAY = false).*
}
module room_saved_delay_fixed {
  import room_saved_delay(USE_SAVED_DELAY = true).*
}
