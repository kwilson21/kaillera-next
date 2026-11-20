// The roster's host frame is the first input ID a new generation owns.
// A running peer may already be several simulation frames behind that roster.
module late_join_input_admission {
  const FIXED: bool
  var absentSince: int
  var roomActive: bool
  var first: int
  var socketOpen: bool

  action init = all { absentSince' = -1, roomActive' = true, first' = 0, socketOpen' = true }
  action remove = all { absentSince' = 1344, roomActive' = false, first' = 0, socketOpen' = false }
  action open = all { absentSince' = absentSince, roomActive' = roomActive, first' = first, socketOpen' = true }
  action admit = all {
    absentSince' = absentSince,
    roomActive' = true,
    first' = if(FIXED and not(roomActive)) 1363 else first,
    socketOpen' = socketOpen,
  }
  action duplicateRoster = all {
    absentSince' = absentSince, roomActive' = roomActive, first' = first, socketOpen' = socketOpen,
  }
  def owesInput(id: int): bool = roomActive and socketOpen and id >= first
  def knownAbsent(id: int): bool = roomActive and absentSince >= 0 and id >= absentSince and id < first

  run dcThenRosterTest = init.then(remove).then(open).then(admit).expect(
    owesInput(1359) == not(FIXED) and owesInput(1363) and not(knownAbsent(1343))
  )
  run rosterThenDcTest = init.then(remove).then(admit).then(open).then(duplicateRoster).expect(
    owesInput(1359) == not(FIXED) and owesInput(1363) and knownAbsent(1359) == FIXED
  )
  run activeReconnectDoesNotRewriteHistoryTest = init.then(open).then(duplicateRoster).expect(
    owesInput(1359) and not(knownAbsent(1359))
  )
  run nativePredictorDoesNotReadNewInputInKnownAbsentFramesTest = init.then(remove).then(open).then(admit).expect(
    // A present neutral at 1359 wins over prediction from the received
    // non-neutral input at 1363, with no write to the old generation.
    (if(knownAbsent(1359)) 0 else 70) == (if(FIXED) 0 else 70)
  )
}
module late_join_input_admission_before { import late_join_input_admission(FIXED=false).* }
module late_join_input_admission_fixed { import late_join_input_admission(FIXED=true).* }
