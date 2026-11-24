// A room code has accrued four offline sweeps. On the fifth, a returning
// member or a replacement room can acquire the room lock before the sweeper.
module room_expiry {
  const CHECK_UNDER_LOCK: bool
  var s: { room: str, live: bool, sweep: str, selected: bool, lostLive: bool, lostFresh: bool }
  action init = s' = { room: "old", live: false, sweep: "idle", selected: false, lostLive: false, lostFresh: false }
  action queueSweep = all {
    s.sweep == "idle",
    s' = s.with("sweep", "queued").with("selected", not(s.live)),
  }
  action reclaim = all {
    s.room != "gone", not(s.live), s' = s.with("live", true),
  }
  action replaceRoom = all {
    s.room == "old", s' = s.with("room", "fresh").with("live", false),
  }
  action acquireLock = all {
    s.sweep == "queued",
    val expired = if (CHECK_UNDER_LOCK) s.room == "old" and not(s.live) else s.selected
    s' = s.with("sweep", "done").with("lostLive", expired and s.live)
          .with("lostFresh", expired and s.room == "fresh").with("room", if (expired) "gone" else s.room),
  }
  action step = any { queueSweep, reclaim, replaceRoom, acquireLock, s' = s }
  val liveRoomSurvives = not(s.lostLive)
  val freshRoomHasGrace = not(s.lostFresh)
  val allHold = liveRoomSurvives and freshRoomHasGrace
  run expiredRoomTest = init.then(queueSweep).then(acquireLock).expect(s.room == "gone")
  run reclaimWhileQueuedTest = init.then(queueSweep).then(reclaim).then(acquireLock)
    .expect(liveRoomSurvives == CHECK_UNDER_LOCK)
  run reusedCodeTest = init.then(replaceRoom).then(queueSweep).then(acquireLock)
    .expect(freshRoomHasGrace == CHECK_UNDER_LOCK)
}
module room_expiry_before {
  import room_expiry(CHECK_UNDER_LOCK = false).*
}
module room_expiry_fixed {
  import room_expiry(CHECK_UNDER_LOCK = true).*
}
