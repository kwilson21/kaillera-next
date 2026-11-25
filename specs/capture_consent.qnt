// The saved preference is shared by tabs. A production opt-out also belongs
// to the active match (page/capture.ts), whose identity comes from session.ts.
module capture_consent {
  const MATCH_LOCK: bool
  var s: { matchId: int, declined: int, saved: bool, optedOut: bool }
  action init = s' = { matchId: 0, declined: 0, saved: true, optedOut: false }
  def blocked = s.matchId != 0 and s.matchId == s.declined
  val allowed = s.saved and not(blocked)
  action enter(id: int): bool = all {
    id != s.matchId, id != 0,
    s' = s.with("matchId", id).with("optedOut", not(s.saved) or s.declined == id)
      .with("declined", if (MATCH_LOCK and not(s.saved)) id else s.declined),
  }
  action endMatch = s' = s.with("matchId", 0).with("optedOut", false)
  action optOut = s' = s.with("saved", false).with("optedOut", s.matchId != 0)
    .with("declined", if (MATCH_LOCK and s.matchId != 0) s.matchId else s.declined)
  // An opt-in heard from another lobby updates the saved preference.
  action otherLobbyOptsIn = s' = s.with("saved", true)
  // Off/on arrived in order while the latest value in storage was already on.
  action delayedOptOut = s' = s.with("saved", true).with("optedOut", s.matchId != 0)
    .with("declined", if (MATCH_LOCK and s.matchId != 0) s.matchId else s.declined)
  action step = any { enter(1), enter(2), endMatch, optOut, otherLobbyOptsIn, delayedOptOut }
  val allHold = (not(s.optedOut) or not(allowed)) and (s.matchId != 0 or allowed == s.saved)
  run crossTabTest = init.then(enter(1)).then(optOut).then(otherLobbyOptsIn)
    .expect(not(allowed) == MATCH_LOCK).then(endMatch).expect(allowed)
  run reloadTest = init.then(enter(1)).then(optOut).then(otherLobbyOptsIn)
    .then(endMatch).then(enter(1)).expect(not(allowed) == MATCH_LOCK)
  run delayedOffTest = init.then(enter(1)).then(delayedOptOut).expect(not(allowed) == MATCH_LOCK)
}
module capture_consent_current { import capture_consent(MATCH_LOCK = true).* }
module capture_consent_before { import capture_consent(MATCH_LOCK = false).* }
