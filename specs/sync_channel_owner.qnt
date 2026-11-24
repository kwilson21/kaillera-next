// State assembly belongs only to the current host channel. A third player's
// channel setup or bytes cannot reset or finish that assembly.
module sync_channel_owner {
  const FIXED: bool
  var pending: bool
  var corrupted: bool
  action init = all { pending' = true, corrupted' = false }
  action otherConnects = all { pending' = if (FIXED) pending else false, corrupted' = corrupted }
  action otherChunk = all { pending' = pending, corrupted' = (corrupted or (pending and not(FIXED))) }
  action oldHostChunk = all { pending' = pending, corrupted' = (corrupted or (pending and not(FIXED))) }
  // A decode begun on the old host channel may finish after replacement/stop.
  action oldDecode = all { pending'=pending, corrupted'=(corrupted or not(FIXED)) }
  action step = any { otherConnects, otherChunk, oldHostChunk, oldDecode }
  val allHold = pending and not(corrupted)
  run connectTest = init.then(otherConnects).expect(allHold == FIXED)
  run chunkTest = init.then(otherChunk).expect(allHold == FIXED)
  run deferredDecodeTest = init.then(oldDecode).expect(allHold == FIXED)
  run reconnectTest = init.then(oldHostChunk).expect(allHold == FIXED)
}
module sync_channel_owner_before { import sync_channel_owner(FIXED = false).* }
module sync_channel_owner_fixed { import sync_channel_owner(FIXED = true).* }
