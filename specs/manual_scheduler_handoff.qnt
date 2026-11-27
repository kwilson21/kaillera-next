// Taking the manual scheduler prevents new automatic frame dispatches.
// An Asyncify continuation already in flight may still finish a frame.
// Load a startup or late-join snapshot only after that continuation has drained.
module manual_scheduler_handoff {
  const WAIT_FOR_IDLE: bool
  const WAIT_FOR_LATE_JOIN_IDLE: bool

  pure val FREE = 0
  pure val MANUAL = 1
  pure val LOADED = 2
  pure val STOPPED = 3
  pure val EXPIRED = 4

  var s: { phase: int, session: int, lateJoin: bool, pending: bool, waiter: int, wake: int,
           loadedFrom: int, oldWorkAfterLoad: bool }

  action init = s' = { phase: FREE, session: 0, lateJoin: false, pending: false, waiter: -1, wake: -1,
                       loadedFrom: -1, oldWorkAfterLoad: false }

  action admitLateJoin = all {
    s.phase == FREE, not(s.lateJoin), s' = s.with("lateJoin", true),
  }

  action suspendOldFrame = all {
    s.phase == FREE, not(s.pending), s' = s.with("pending", true),
  }

  action takeManualScheduler = all {
    s.phase == FREE, s' = s.with("phase", MANUAL),
  }

  action loadOrWait = all {
    s.phase == MANUAL, s.waiter == -1,
    s' = if ((if (s.lateJoin) WAIT_FOR_LATE_JOIN_IDLE else WAIT_FOR_IDLE) and s.pending)
      s.with("waiter", s.session)
      else { ...s, phase: LOADED, waiter: -1, loadedFrom: s.session },
  }

  action finishOldFrame = all {
    s.pending,
    s' = { ...s, pending: false, wake: if (s.waiter >= 0) s.waiter else s.wake,
           oldWorkAfterLoad: s.oldWorkAfterLoad or s.phase == LOADED },
  }

  action deliverWake = all {
    s.wake >= 0,
    s' = if (s.phase == MANUAL and s.waiter == s.wake and s.session == s.wake and not(s.pending))
      { ...s, phase: LOADED, wake: -1, waiter: -1, loadedFrom: s.wake }
      else s.with("wake", -1),
  }

  action stop = all {
    s.phase == MANUAL or s.phase == LOADED or s.phase == EXPIRED,
    s' = { ...s, phase: STOPPED, waiter: -1 },
  }

  action expire = all {
    s.phase == MANUAL, s.waiter == s.session,
    s' = { ...s, phase: EXPIRED, waiter: -1 },
  }

  action newSession = all {
    s.phase == STOPPED,
    s' = { ...s, phase: FREE, session: s.session + 1, lateJoin: false, pending: false,
           loadedFrom: -1, oldWorkAfterLoad: false },
  }

  action step = any {
    admitLateJoin, suspendOldFrame, takeManualScheduler, loadOrWait, finishOldFrame, deliverWake, expire, stop, newSession,
  }

  val noOldWorkAfterLoad = not(s.oldWorkAfterLoad)
  val currentSessionOnly = s.phase != LOADED or s.loadedFrom == s.session
  val safeHandoff = noOldWorkAfterLoad and currentSessionOnly

  run oldFrameAtHandoffTest = init.then(suspendOldFrame).then(takeManualScheduler)
    .then(loadOrWait).then(finishOldFrame).expect(noOldWorkAfterLoad == WAIT_FOR_IDLE)

  run oldFrameAtLateJoinTest = init.then(admitLateJoin).then(suspendOldFrame).then(takeManualScheduler)
    .then(loadOrWait).then(finishOldFrame).expect(noOldWorkAfterLoad == WAIT_FOR_LATE_JOIN_IDLE)
}

module manual_scheduler_handoff_before {
  import manual_scheduler_handoff(WAIT_FOR_IDLE = false, WAIT_FOR_LATE_JOIN_IDLE = false).*
}

module manual_scheduler_handoff_late_join_before {
  import manual_scheduler_handoff(WAIT_FOR_IDLE = true, WAIT_FOR_LATE_JOIN_IDLE = false).*
}

module manual_scheduler_handoff_fixed {
  import manual_scheduler_handoff(WAIT_FOR_IDLE = true, WAIT_FOR_LATE_JOIN_IDLE = true).*

  run loadAfterContinuationTest = init.then(suspendOldFrame).then(takeManualScheduler)
    .then(loadOrWait).expect(s.phase == MANUAL)
    .then(finishOldFrame).then(deliverWake).expect(s.phase == LOADED and safeHandoff)

  run staleWakeCannotLoadTest = init.then(suspendOldFrame).then(takeManualScheduler)
    .then(loadOrWait).then(finishOldFrame).then(stop).then(newSession).then(takeManualScheduler)
    .then(deliverWake).expect(s.phase == MANUAL and s.loadedFrom == -1)

  run lateJoinLoadsAfterContinuationTest = init.then(admitLateJoin).then(suspendOldFrame).then(takeManualScheduler)
    .then(loadOrWait).expect(s.phase == MANUAL)
    .then(finishOldFrame).then(deliverWake).expect(s.phase == LOADED and safeHandoff)

  run expiredLateJoinCannotLoadTest = init.then(admitLateJoin).then(suspendOldFrame).then(takeManualScheduler)
    .then(loadOrWait).then(finishOldFrame).then(expire).then(deliverWake)
    .expect(s.phase == EXPIRED and s.loadedFrom == -1)
}
