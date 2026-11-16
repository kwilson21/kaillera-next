// -*- mode: Bluespec; -*-
//
// A player dropped in a running match, and how it may come back:
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
// SKIP_DROPPED: the host's health check does not re-add a player it dropped
//   in this match. It comes back only as a late joiner, whose activation
//   puts its slot back in the roster.
// TELL: a drop with the channel still open tells the player first
//   (`dropped:<reason>`, taken only from the host), and its page stops its
//   match and joins again late by itself, onto the host's state (the
//   session's leftOutOfStart: running -> lateJoinStarting).
// GUEST_LATE_JOIN: with the channel dead nobody can tell it; a guest whose
//   own give-up drops the host (the 45 s reconnect give-up, or its attempts
//   run out) joins again late the same way instead of playing on alone.
// HOST_ONLY: only the host records whom it dropped (it owns the roster).
//   Kept on every page, a guest that dropped another guest in a three- or
//   four-player match refused to heal that link for the rest of the match,
//   though the host still played both.
//
// What is modelled: the host's entry for one player, its roster slot, the
// player's page playing or not, the ways in, the host's health check, the
// guest's own give-up, a late join, and a guest-guest link in three players.
// Not modelled: the late join itself (specs/late_join_pause.qnt).

module drop_is_final {
  const SKIP_DROPPED: bool
  const TELL: bool
  const GUEST_LATE_JOIN: bool
  const HOST_ONLY: bool

  var entry: bool        // the host has a peer entry for the player
  var inRoster: bool     // the player's slot is in the host's game roster
  var playing: bool      // the player's page plays its match
  var dropped: bool      // the host dropped this player in this match
  var told: bool         // the player's page was told it was dropped
  var gaveUp: bool       // the player's page gave up on the host (dead channel)
  var stray: bool        // history: an entry outside the roster while it played
  var guestBlocks: bool  // three players: a guest refuses to heal its link to another guest

  action init = all {
    entry' = true, inRoster' = true, playing' = true, dropped' = false, told' = false,
    gaveUp' = false, stray' = false, guestBlocks' = false,
  }

  // The desync give-up: the channel is open, so the host can say why.
  action desyncGiveUp = all {
    entry, not(dropped),
    entry' = false, inRoster' = false, dropped' = true,
    told' = TELL,
    playing' = if (TELL) false else playing,
    gaveUp' = gaveUp, stray' = stray, guestBlocks' = guestBlocks,
  }

  // The host's 45 s reconnect give-up: the channel is dead.
  action reconnectGiveUp = all {
    entry, not(dropped),
    entry' = false, inRoster' = false, dropped' = true,
    told' = told, playing' = playing, gaveUp' = gaveUp, stray' = stray, guestBlocks' = guestBlocks,
  }

  // The player's page gives up on the host (its own 45 s, or its reconnect
  // attempts run out): with GUEST_LATE_JOIN it stops and joins again late.
  action guestGivesUp = all {
    playing, not(gaveUp), not(told),
    gaveUp' = true,
    playing' = if (GUEST_LATE_JOIN) false else playing,
    entry' = entry, inRoster' = inRoster, dropped' = dropped, told' = told,
    stray' = stray, guestBlocks' = guestBlocks,
  }

  // The host's health check: the room still lists the player.
  action heal = all {
    dropped, not(entry), not(SKIP_DROPPED),
    entry' = true,
    stray' = (stray or (playing and not(inRoster))),
    inRoster' = inRoster, playing' = playing, dropped' = dropped, told' = told,
    gaveUp' = gaveUp, guestBlocks' = guestBlocks,
  }

  // The player joins late (by itself when told or when it gave up, else by
  // reloading): its slot back in the roster.
  action lateJoin = all {
    not(playing), (not(entry) or not(inRoster)),
    entry' = true, inRoster' = true, playing' = true, dropped' = false, told' = false, gaveUp' = false,
    stray' = stray, guestBlocks' = guestBlocks,
  }

  // The player sees its page has ended, or stops on its own, and reloads.
  action playerStops = all {
    playing, dropped,
    playing' = false,
    entry' = entry, inRoster' = inRoster, dropped' = dropped, told' = told, gaveUp' = gaveUp,
    stray' = stray, guestBlocks' = guestBlocks,
  }

  // Three players: one guest drops its link to another (the host plays both).
  action guestDropsGuest = all {
    not(guestBlocks),
    guestBlocks' = not(HOST_ONLY),
    entry' = entry, inRoster' = inRoster, playing' = playing, dropped' = dropped, told' = told,
    gaveUp' = gaveUp, stray' = stray,
  }

  action stutter = all {
    entry' = entry, inRoster' = inRoster, playing' = playing, dropped' = dropped, told' = told,
    gaveUp' = gaveUp, stray' = stray, guestBlocks' = guestBlocks,
  }

  action step = any {
    desyncGiveUp, reconnectGiveUp, guestGivesUp, heal, lateJoin, playerStops, guestDropsGuest, stutter
  }

  // A player the host dropped comes back only as a late joiner: never as an
  // entry outside the roster that the host feeds but does not wait for.
  val aDroppedPlayerComesBackOnlyAsALateJoiner = not(stray)
  // A player told it was dropped is not left playing.
  val aToldPlayerStops = told implies not(playing)
  // A page that gave up on its host does not play on alone.
  val aPageThatLostTheHostDoesNotPlayAlone = gaveUp implies not(playing)
  // A guest never refuses to heal its link to another guest the host plays.
  val guestLinksCanHeal = not(guestBlocks)
  val allHold = and {
    aDroppedPlayerComesBackOnlyAsALateJoiner, aToldPlayerStops, aPageThatLostTheHostDoesNotPlayAlone, guestLinksCanHeal
  }

  // The ASK_UNANSWERED_ACKS run: the desync give-up, then the health check.
  run desyncThenHealTest =
    if (SKIP_DROPPED and TELL)
      // Told, the page ends its match at once; the player joins late.
      init.then(desyncGiveUp).expect(not(entry) and not(playing) and aToldPlayerStops)
        .then(lateJoin)
        .expect(entry and inRoster and aDroppedPlayerComesBackOnlyAsALateJoiner)
    else
      init.then(desyncGiveUp).then(heal)
        .expect(not(aDroppedPlayerComesBackOnlyAsALateJoiner))

  // The 45 s give-up on both sides: the channel is dead, nobody is told.
  run reconnectGiveUpTest =
    init.then(reconnectGiveUp).then(guestGivesUp)
      .expect(aPageThatLostTheHostDoesNotPlayAlone == GUEST_LATE_JOIN)

  // Three players: a guest drops its link to another.
  run guestGuestTest =
    init.then(guestDropsGuest).expect(guestLinksCanHeal == HOST_ONLY)
}

// Before #286: the health check adds a dropped player back outside the roster.
module drop_is_final_before {
  import drop_is_final(SKIP_DROPPED = false, TELL = false, GUEST_LATE_JOIN = false, HOST_ONLY = false).*
}

// #286 as first written: every page skips whom it dropped, the desync give-up
// tells the player, a guest that gives up on its host plays on alone.
module drop_is_final_skip_everywhere {
  import drop_is_final(SKIP_DROPPED = true, TELL = true, GUEST_LATE_JOIN = false, HOST_ONLY = false).*
}

// The fix.
module drop_is_final_fixed {
  import drop_is_final(SKIP_DROPPED = true, TELL = true, GUEST_LATE_JOIN = true, HOST_ONLY = true).*
}
