// Same-frame retries and match reset must not accept an earlier delivery ACK.
module recovery_ack {
  const FIXED: bool
  var current: int
  var ack: int
  var settled: bool
  action init = all { current'=1, ack'=0, settled'=false }
  action restart = all { current'=current+1, ack'=ack, settled'=false }
  action staleAck = all { current'=current, ack'=current-1, settled'=not(FIXED) }
  action matchingAck = all { current'=current, ack'=current, settled'=true }
  action step = any { restart, staleAck, matchingAck }
  val exactAttemptOnly = not(settled) or ack == current
  run sameFrameRetryTest = init.then(restart).then(staleAck).expect(exactAttemptOnly == FIXED)
  run currentAckTest = init.then(matchingAck).expect(exactAttemptOnly)
}
module recovery_ack_before { import recovery_ack(FIXED=false).* }
module recovery_ack_fixed { import recovery_ack(FIXED=true).* }
