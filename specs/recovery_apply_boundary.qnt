module recovery_apply_boundary {
  const FIXED: bool
  var pendingFrame: int
  var pendingToken: int
  var acked: bool
  var running: bool
  var aligned: bool
  action init = all { pendingFrame'=101, pendingToken'=8, acked'=false, running'=true, aligned'=true }
  action oldOrdinary = all {
    pendingFrame'=if(FIXED) pendingFrame else 100,
    pendingToken'=if(FIXED) pendingToken else 0,
    acked'=acked, running'=running, aligned'=aligned
  }
  action refuseFrame = all {
    pendingFrame'=pendingFrame, pendingToken'=pendingToken,
    aligned'=false, acked'=not(FIXED), running'=not(FIXED)
  }
  action step = any { oldOrdinary, refuseFrame }
  val allHold = pendingFrame>=101 and ((acked or running) implies aligned)
  run staleDecoderTest = init.then(oldOrdinary).expect(allHold==FIXED)
  run refusedFrameTest = init.then(refuseFrame).expect(allHold==FIXED)
}
module recovery_apply_boundary_before { import recovery_apply_boundary(FIXED=false).* }
module recovery_apply_boundary_fixed { import recovery_apply_boundary(FIXED=true).* }
