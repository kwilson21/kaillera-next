module late_join_drop_ready {
  const FIXED: bool
  var dropped: bool
  var sent: bool
  var ready: bool
  var pending: bool
  action init = all { dropped'=true, sent'=false, ready'=false, pending'=true }
  action emit = all { dropped'=if(FIXED) dropped else false, sent'=true, ready'=ready, pending'=pending }
  action timeout = all { dropped'=dropped, sent'=false, ready'=ready, pending'=false }
  action acknowledge = all { dropped'=if(sent) false else dropped, sent'=sent, ready'=(ready or sent), pending'=if(sent) false else pending }
  action step = any { emit, timeout, acknowledge }
  val noUnreadyMeshAdmission = ready or dropped or pending
  run silentRelayLossTest = init.then(emit).then(timeout).expect(noUnreadyMeshAdmission==FIXED)
  // Once admitted, duplicate readiness does not undo the loaded-state fact.
  run duplicateReadyTest = init.then(emit).then(acknowledge).then(timeout).then(acknowledge).expect(noUnreadyMeshAdmission)
  run readyAdmitsTest = init.then(emit).then(acknowledge).expect(ready and not(dropped))
}
module late_join_drop_ready_before { import late_join_drop_ready(FIXED=false).* }
module late_join_drop_ready_fixed { import late_join_drop_ready(FIXED=true).* }
