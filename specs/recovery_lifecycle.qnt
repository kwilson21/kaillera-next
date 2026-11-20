// State-transfer lifecycle failures found by #286 review.
module recovery_lifecycle {
  const FIXED: bool
  var stopped: bool
  var pending: bool
  var reservation: bool
  var dropped: bool
  var joining: bool
  var failed: bool
  var captures: int
  action init = all { stopped'=false, pending'=true, reservation'=true,
    dropped'=true, joining'=false, failed'=false, captures'=0 }
  action stop = all { stopped'=true, pending'=not(FIXED), reservation'=not(FIXED),
    dropped'=dropped, joining'=joining, failed'=failed, captures'=captures }
  action failedServe = all { stopped'=stopped, pending'=pending, reservation'=reservation,
    dropped'=FIXED, joining'=false, failed'=true, captures'=captures }
  action onlyPrimaryOpen = all { stopped'=stopped, pending'=pending, reservation'=reservation,
    dropped'=dropped, joining'=joining, failed'=failed, captures'=if(FIXED) captures else captures+1 }
  val stoppedWorkSettles = not(stopped) or (not(pending) and not(reservation))
  val failedJoinStaysGated = not(failed) or dropped or joining
  val unusableChannelDoesNotCapture = captures == 0
  action step = any { stop, failedServe, onlyPrimaryOpen }
  val allHold = stoppedWorkSettles and failedJoinStaysGated and unusableChannelDoesNotCapture
  run stopTest = init.then(stop).expect(stoppedWorkSettles == FIXED)
  run failedServeTest = init.then(failedServe).expect(failedJoinStaysGated == FIXED)
  run unavailableTransportTest = init.then(onlyPrimaryOpen).expect(unusableChannelDoesNotCapture == FIXED)
}
module recovery_lifecycle_before { import recovery_lifecycle(FIXED=false).* }
module recovery_lifecycle_fixed { import recovery_lifecycle(FIXED=true).* }
