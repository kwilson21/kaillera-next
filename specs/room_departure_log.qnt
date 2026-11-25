// A host leaves a running match with another player still in the room. The
// server removes its socket mapping before the departure's two database writes.
module room_departure_log {
  const CONTINUE_ON_ERROR: bool
  const HISTORY_OUTSIDE_LOCK: bool
  var s: { departed: bool, hostInPlayers: bool, owner: str, historyPending: bool, otherRoom: str }
  action init = s' = { departed: false, hostInPlayers: true, owner: "host", historyPending: false, otherRoom: "reserved" }
  action leave(failure: str): bool = all {
    not(s.departed),
    val removed = CONTINUE_ON_ERROR or failure != "session"
    val handedOn = CONTINUE_ON_ERROR or failure == "none"
    s' = { departed: true, hostInPlayers: not(removed), owner: if (handedOn) "guest" else "host",
           historyPending: true, otherRoom: s.otherRoom },
  }
  action returnDuringHistory = all {
    s.historyPending, s.otherRoom == "reserved",
    s' = s.with("otherRoom", if (HISTORY_OUTSIDE_LOCK) "returned" else "timed-out"),
  }
  action step = any {
    nondet failure = oneOf(Set("session", "event", "none"))
    leave(failure), returnDuringHistory, s' = s,
  }
  val remainingPlayerOwnsRoom = not(s.departed) or (s.owner == "guest" and not(s.hostInPlayers))
  val timelyReturnSurvives = s.otherRoom != "timed-out"
  val allHold = remainingPlayerOwnsRoom and timelyReturnSurvives
  run returnWhileDepartureIsLoggedTest = init.then(leave("none")).then(returnDuringHistory)
    .expect(timelyReturnSurvives == HISTORY_OUTSIDE_LOCK)
  run sessionWriteFailsTest = init.then(leave("session")).expect(remainingPlayerOwnsRoom == CONTINUE_ON_ERROR)
  run eventWriteFailsTest = init.then(leave("event")).expect(remainingPlayerOwnsRoom == CONTINUE_ON_ERROR)
  run ordinaryLeaveTest = init.then(leave("none")).expect(remainingPlayerOwnsRoom)
}
module room_departure_log_before {
  import room_departure_log(CONTINUE_ON_ERROR = false, HISTORY_OUTSIDE_LOCK = false).*
}
module room_departure_log_fixed {
  import room_departure_log(CONTINUE_ON_ERROR = true, HISTORY_OUTSIDE_LOCK = true).*
}
