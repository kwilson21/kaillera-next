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
