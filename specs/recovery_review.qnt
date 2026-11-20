// #286: readiness belongs to a serve, deadlines survive DC-open deferral,
// and neither roster gaps nor client-selected identity churn renew captures.
module recovery_review {
  const FIXED: bool
  var s: { handled: bool, pending: bool, serving: bool, open: bool, dropped: bool,
           missedReady: bool, used: int, identityCaptures: int, total: int }
  action init = s' = { handled: false, pending: true, serving: true, open: false,
                       dropped: true, missedReady: false, used: 0, identityCaptures: 0, total: 0 }
  action ready = s' = if (s.handled) s.with("missedReady", s.pending and s.open)
    else if (s.open) s.with("handled", true).with("pending", false).with("serving", false).with("dropped", false)
    else s.with("serving", FIXED)
  action open = s' = s.with("open", true)
  action resetAndServe = s' = s.with("handled", if (FIXED) false else s.handled)
    .with("pending", true).with("serving", true).with("open", false).with("dropped", true)
  action timeout = s' = if (s.serving) s.with("pending", false).with("serving", false) else s
  action capture = s' = if (s.used < 3 and (not(FIXED) or s.total < 9))
    s.with("used", s.used + 1).with("identityCaptures", s.identityCaptures + 1).with("total", s.total + 1) else s
  action rosterGap = s' = if (FIXED) s else s.with("used", 0)
  action newIdentity = s' = s.with("used", 0).with("identityCaptures", 0)
  action idle = s' = s
  action step = any { ready, open, resetAndServe, timeout, capture, rosterGap, newIdentity, idle }
  val readinessHasDeadline = s.pending implies s.serving
  val repeatedReadyWorks = not(s.missedReady)
  val roomCapturesBounded = s.total <= 9
  val rosterGapCannotRenew = s.identityCaptures <= 3
  val allHold = readinessHasDeadline and repeatedReadyWorks and roomCapturesBounded and rosterGapCannotRenew
  run secondJoinTest = init.then(open).then(ready).then(resetAndServe).then(open).then(ready)
    .expect(repeatedReadyWorks == FIXED)
  run deferredDeadlineTest = init.then(ready).then(timeout).expect(not(s.pending) == FIXED)
  run rosterGapTest = init.then(capture).then(capture).then(capture).then(rosterGap).then(capture)
    .expect((s.total == 3) == FIXED)
  run identityChurnTest = init.then(capture).then(capture).then(capture).then(newIdentity)
    .then(capture).then(capture).then(capture).then(newIdentity)
    .then(capture).then(capture).then(capture).then(newIdentity).then(capture)
    .expect(roomCapturesBounded == FIXED)
}
module recovery_review_before { import recovery_review(FIXED = false).* }
module recovery_review_fixed { import recovery_review(FIXED = true).* }
