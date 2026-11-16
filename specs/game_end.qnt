// End requests are match-scoped. A dropped event is repaired by the next
// authoritative lobby roster; a timeout must never end only the host.
module game_end {
  const FIXED: bool
  var serverMatch: int
  var hostMatch: int
  var guestMatch: int
  var requestMatch: int
  action init = all { serverMatch' = 1, hostMatch' = 1, guestMatch' = 1, requestMatch' = 1 }
  action timeout = all {
    hostMatch' = if (FIXED) hostMatch else 0,
    serverMatch' = serverMatch, guestMatch' = guestMatch, requestMatch' = requestMatch,
  }
  action receiveEnd = all {
    serverMatch' = if (not(FIXED) or requestMatch == serverMatch) 0 else serverMatch,
    hostMatch' = hostMatch, guestMatch' = guestMatch, requestMatch' = requestMatch,
  }
  action roster = all {
    hostMatch' = if (FIXED and serverMatch == 0) 0 else hostMatch,
    guestMatch' = if (FIXED and serverMatch == 0) 0 else guestMatch,
    serverMatch' = serverMatch, requestMatch' = requestMatch,
  }
  action rematch = all { serverMatch' = 2, hostMatch' = 2, guestMatch' = 2, requestMatch' = requestMatch }
  run timeoutDoesNotEndOnlyHostTest = init.then(timeout).expect((hostMatch == serverMatch) == FIXED)
  run rosterRepairsLostEndTest = init.then(receiveEnd).then(roster).expect((guestMatch == 0 and hostMatch == 0) == FIXED)
  run staleRetryDoesNotEndRematchTest = init.then(rematch).then(receiveEnd).expect((serverMatch == 2) == FIXED)
}
module game_end_before { import game_end(FIXED = false).* }
module game_end_fixed { import game_end(FIXED = true).* }
