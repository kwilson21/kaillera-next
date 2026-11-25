// The room can retain its own confirmations across a match boundary.
module play_notices {
  const FIXED: bool
  var matchId: int
  var warnings: Set[int]
  var roomNotice: bool
  action init = all { matchId' = 0, warnings' = Set(), roomNotice' = true }
  action start = all { matchId' = 1, warnings' = if (FIXED and matchId != 1) Set() else warnings, roomNotice' = roomNotice }
  action rematch = all {
    matchId' = 2, warnings' = if (FIXED) Set() else warnings, roomNotice' = roomNotice
  }
  action end = all {
    matchId' = 0, warnings' = if (FIXED) Set() else warnings, roomNotice' = roomNotice
  }
  action warn(id) = all {
    matchId' = matchId,
    warnings' = if (not(FIXED) or (id == matchId and id != 0)) warnings.union(Set(id)) else warnings,
    roomNotice' = roomNotice
  }
  action expire = all {
    matchId' = matchId, warnings' = if (FIXED) Set() else warnings, roomNotice' = roomNotice
  }
  action recover = all { matchId' = matchId, warnings' = Set(), roomNotice' = roomNotice }
  action step = any { start, rematch, end, warn(1), warn(2), expire, recover }
  val currentMatchOnly = warnings.forall(id => id == matchId and id != 0)
  run endClearsTest = init.then(start).then(warn(1)).then(end).expect((warnings == Set()) == FIXED and roomNotice)
  run staleWarningIgnoredTest = init.then(start).then(rematch).then(warn(1)).expect((warnings == Set()) == FIXED)
  run expiryClearsTest = init.then(start).then(warn(1)).then(expire).expect((warnings == Set()) == FIXED)
  run recoverClearsTest = init.then(start).then(warn(1)).then(recover).expect((warnings == Set()))
}
module play_notices_before { import play_notices(FIXED = false).* }
module play_notices_fixed { import play_notices(FIXED = true).* }
