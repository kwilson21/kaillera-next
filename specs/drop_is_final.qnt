// -*- mode: Bluespec; -*-
//
// A player the host dropped in a running match, and how it may come back:
// hardDisconnectPeer, the mesh health check and late join in
// web/static/netplay-rollback.js.
//
// The host drops a player (hardDisconnectPeer) when it gives up on it: its
// escalation pushes went unanswered (specs/ask_escalation.qnt, the desync
// give-up), or a reconnect did not come back in 45 s. The drop takes the
// player's slot out of the host's game roster. The player's page is still in
// the room, though, and the mesh health check walks the room's list: finding
// no entry for it, it offered again ("no entry to wait on, offering") and
// added a peer back, outside the roster. The host then fed that player's
// inputs but never waited for them (getInputPeers follows the roster), ran
// ahead, and took every late input as a misprediction past its window: 157
// failed rollbacks and about 40 escalation pushes in one ASK_UNANSWERED_ACKS
// run, the pages apart the whole time.
//
// SKIP_DROPPED: the health check does not re-add a player this page dropped
//   in this match. It comes back only as a late joiner, whose activation
//   puts its slot back in the roster.
// TELL: the desync give-up tells the player first (`dropped:desync`, taken
//   only from the host), and its page stops its match and joins again late
//   by itself, onto the host's state (the session's leftOutOfStart:
//   running -> lateJoinStarting). A drop after a dead channel cannot tell
//   it: that page plays on alone until its player reloads (pre-existing; the
//   guest's side is the follow-up).
//
// What is modelled: the host's entry for one player, the roster slot, the
// player's page playing or ended, the two ways in, the health check, and a
// late join. Not modelled: the late join itself (specs/late_join_pause.qnt),
// the player's own health check (it is not lower than the host, so it waits
// for the host's offer; with SKIP_DROPPED none comes).

module drop_is_final {
  const SKIP_DROPPED: bool
  const TELL: bool

  var entry: bool        // the host has a peer entry for the player
  var inRoster: bool     // the player's slot is in the host's game roster
  var playing: bool      // the player's page plays its match
  var dropped: bool      // the host dropped this player in this match
  var told: bool         // the player's page was told it was dropped
  var stray: bool        // history: an entry outside the roster while it played

  action init = all {
    entry' = true, inRoster' = true, playing' = true, dropped' = false, told' = false, stray' = false,
  }

  // The desync give-up: the channel is open, so the host can say why.
  action desyncGiveUp = all {
    entry, not(dropped),
    entry' = false, inRoster' = false, dropped' = true,
    told' = TELL,
    playing' = if (TELL) false else playing,
    stray' = stray,
  }

  // The 45 s reconnect give-up: the channel is dead.
  action reconnectGiveUp = all {
    entry, not(dropped),
    entry' = false, inRoster' = false, dropped' = true,
    told' = told, playing' = playing, stray' = stray,
  }

  // The host's health check: the room still lists the player.
  action heal = all {
    dropped, not(entry), not(SKIP_DROPPED),
    entry' = true,
    stray' = (stray or (playing and not(inRoster))),
    inRoster' = inRoster, playing' = playing, dropped' = dropped, told' = told,
  }

  // The player joins late (by itself when told, else by reloading): its slot
  // back in the roster.
  action lateJoin = all {
    dropped, not(playing), not(entry),
    entry' = true, inRoster' = true, playing' = true, dropped' = false, told' = false,
    stray' = stray,
  }

  // The player sees its page has ended, or stops on its own, and reloads.
  action playerStops = all {
    playing, dropped,
    playing' = false,
    entry' = entry, inRoster' = inRoster, dropped' = dropped, told' = told, stray' = stray,
  }

  action stutter = all {
    entry' = entry, inRoster' = inRoster, playing' = playing, dropped' = dropped, told' = told, stray' = stray,
  }

  action step = any { desyncGiveUp, reconnectGiveUp, heal, lateJoin, playerStops, stutter }

  // A player the host dropped comes back only as a late joiner: never as an
  // entry outside the roster that the host feeds but does not wait for.
  val aDroppedPlayerComesBackOnlyAsALateJoiner = not(stray)
  // A player told it was dropped is not left playing.
  val aToldPlayerStops = told implies not(playing)
  val allHold = aDroppedPlayerComesBackOnlyAsALateJoiner and aToldPlayerStops

  // The ASK_UNANSWERED_ACKS run: the desync give-up, then the health check.
  run desyncThenHealTest =
    if (SKIP_DROPPED)
      // Told, the page ends its match at once; the player joins late.
      init.then(desyncGiveUp).expect(not(entry) and not(playing) and allHold)
        .then(lateJoin)
        .expect(entry and inRoster and allHold)
    else
      init.then(desyncGiveUp).then(heal)
        .expect(not(aDroppedPlayerComesBackOnlyAsALateJoiner))

  // The 45 s give-up: the channel is dead, nobody is told.
  run reconnectGiveUpTest =
    if (SKIP_DROPPED)
      init.then(reconnectGiveUp).then(playerStops).then(lateJoin)
        .expect(entry and inRoster and allHold)
    else
      init.then(reconnectGiveUp).then(heal)
        .expect(not(aDroppedPlayerComesBackOnlyAsALateJoiner))
}

// Today: the health check re-adds the player outside the roster.
module drop_is_final_current {
  import drop_is_final(SKIP_DROPPED = false, TELL = false).*
}

// The fix.
module drop_is_final_fixed {
  import drop_is_final(SKIP_DROPPED = true, TELL = true).*
}
