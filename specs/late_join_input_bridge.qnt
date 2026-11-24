// The host snapshots H=1046 before an original guest pauses at H+6.
// Its first live packet to the joiner is H+6; the joiner's initial delay
// expects H..H+5 sooner. Captured, confirmed input can cross that gap.
// This bridge does not change Ready or the host's serve deadline.
module late_join_input_bridge {
  const FIXED: bool
  var generation: int
  var capturedGeneration: int
  var kind: str
  var installedReal: bool
  var ready: bool
  action init = all {
    generation'=0, capturedGeneration'=0, kind'="real", installedReal'=false, ready'=false
  }
  action replace = all {
    generation'=1, capturedGeneration'=capturedGeneration, kind'=kind, installedReal'=false, ready'=ready
  }
  action placeholder = all {
    generation'=generation, capturedGeneration'=capturedGeneration,
    kind'="placeholder", installedReal'=false, ready'=ready
  }
  action apply = all {
    generation'=generation, capturedGeneration'=capturedGeneration, kind'=kind, ready'=true,
    installedReal'=(FIXED and kind=="real" and generation==capturedGeneration)
  }
  action step = any { replace, placeholder, apply }
  val separateReadyFromBridge = not(installedReal) or ready
  val snapshotGenerationOnly = not(installedReal) or generation==capturedGeneration
  val noConfirmedPlaceholder = not(installedReal) or kind!="placeholder"
  // In the old path no authenticated H..H+5 inputs are installed at join,
  // so applying frames with non-neutral original input differs from the host.
  run appliesOriginalPostSnapshotInputsTest = init.then(apply).expect(installedReal==FIXED and ready)
  run replacedPeerCannotSeedTest = init.then(replace).then(apply).expect(not(installedReal) and ready)
  run placeholderIsNotAReceiptTest = init.then(placeholder).then(apply).expect(not(installedReal) and ready)
}
module late_join_input_bridge_before { import late_join_input_bridge(FIXED=false).* }
module late_join_input_bridge_fixed { import late_join_input_bridge(FIXED=true).* }
