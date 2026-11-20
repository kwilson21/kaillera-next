// The new guest has the host snapshot and is Ready. Original input H is
// absent; H+1 arriving neither confirms H nor permits advancing through H.
module late_join_input_bootstrap {
  const FIXED: bool
  var ready: bool
  var input: str
  var newest: int
  var advanced: bool
  var failed: bool

  action init = all { ready'=true, input'="missing", newest'=0, advanced'=false, failed'=false }
  action newer = all { ready'=ready, input'=input, newest'=1, advanced'=advanced, failed'=failed }
  action confirmReal = all { ready'=ready, input'="real", newest'=newest, advanced'=advanced, failed'=failed }
  action confirmNeutral = all { ready'=ready, input'="actual-neutral", newest'=newest, advanced'=advanced, failed'=failed }
  action tick = all {
    ready'=ready, input'=input, newest'=newest,
    advanced'=(advanced or (not(failed) and (not(FIXED) or input!="missing"))), failed'=failed
  }
  action deadline = all {
    ready'=ready, input'=input, newest'=newest,
    advanced'=advanced, failed'=(failed or (FIXED and not(advanced) and input=="missing"))
  }
  action step = any { newer, confirmReal, confirmNeutral, tick, deadline }
  val neverAdvanceOnMissing = not(advanced) or input!="missing"
  run laterInputDoesNotFillTheHoleTest = init.then(newer).then(tick).expect(ready and advanced!=FIXED)
  run aResentNonzeroUnblocksTest = init.then(newer).then(confirmReal).then(tick).expect(ready and advanced)
  run aRealNeutralUnblocksTest = init.then(confirmNeutral).then(tick).expect(ready and advanced)
  run expiresWithoutFabricatingTest = init.then(deadline).then(tick).expect(failed==FIXED and advanced!=FIXED)
}
module late_join_input_bootstrap_before { import late_join_input_bootstrap(FIXED=false).* }
module late_join_input_bootstrap_fixed { import late_join_input_bootstrap(FIXED=true).* }
