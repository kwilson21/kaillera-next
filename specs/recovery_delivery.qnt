// #286 review regressions: premature acknowledgements, a missed third guest,
// primary-channel state rejection and a rate-limited late rejoin.
module recovery_delivery {
  const FIXED: bool
  var delivered: Set[int]
  var settled: Set[int]
  var pending: Set[int]
  var queued: int
  var dropped: bool
  var held: bool
  var stray: bool
  action init = all {
    delivered' = Set(), settled' = Set(), pending' = Set(1, 2), queued' = 1,
    dropped' = true, held' = false, stray' = false,
  }
  action earlyAck = all {
    settled' = if (FIXED) settled else settled.union(Set(1)),
    pending' = if (FIXED) pending else pending.exclude(Set(1)),
    delivered' = delivered, queued' = queued, dropped' = dropped, held' = held, stray' = stray,
  }
  action sendOne = all {
    delivered' = delivered.union(Set(1)),
    settled' = settled, pending' = pending, queued' = 0,
    dropped' = dropped, held' = held, stray' = stray,
  }
  action ackOne = all {
    delivered.contains(1),
    settled' = settled.union(Set(1)), pending' = if (FIXED) pending.exclude(Set(1)) else Set(),
    delivered' = delivered, queued' = queued, dropped' = dropped, held' = held, stray' = stray,
  }
  action cooldown = all {
    dropped' = FIXED, held' = held, stray' = stray,
    delivered' = delivered, settled' = settled, pending' = pending, queued' = queued,
  }
  action heal = all {
    stray' = (stray or (not(dropped) and not(held))),
    dropped' = dropped, held' = held,
    delivered' = delivered, settled' = settled, pending' = pending, queued' = queued,
  }
  action serve = all {
    held' = true, dropped' = false, stray' = stray,
    delivered' = delivered, settled' = settled, pending' = pending, queued' = queued,
  }
  action primarySend = all {
    delivered' = if (FIXED) delivered else delivered.union(Set(2)),
    settled' = settled, pending' = pending, queued' = queued,
    dropped' = dropped, held' = held, stray' = stray,
  }
  val onlyDeliveredStatesAreAcknowledged = settled.subseteq(delivered)
  val everyUnsettledGuestRemainsPending = Set(1, 2).exclude(settled).subseteq(pending)
  val aRateLimitedJoinNeverHealsOutsideRoster = not(stray)
  run prematureAckTest = init.then(earlyAck).expect(onlyDeliveredStatesAreAcknowledged == FIXED)
  run missedThirdGuestTest = init.then(sendOne).then(ackOne).expect(everyUnsettledGuestRemainsPending == FIXED)
  run cooldownTest = init.then(cooldown).then(heal).expect(aRateLimitedJoinNeverHealsOutsideRoster == FIXED)
  run primaryChannelTest = init.then(primarySend).expect(delivered.contains(2) == not(FIXED))
  run acceptedJoinTest = init.then(serve).then(heal).expect(aRateLimitedJoinNeverHealsOutsideRoster)
  action step = any { earlyAck, sendOne, ackOne, cooldown, heal, serve }
  val allHold = onlyDeliveredStatesAreAcknowledged and everyUnsettledGuestRemainsPending and aRateLimitedJoinNeverHealsOutsideRoster
}
module recovery_delivery_before { import recovery_delivery(FIXED = false).* }
module recovery_delivery_fixed { import recovery_delivery(FIXED = true).* }

// Resource ownership is separate from recovery bookkeeping: a reconnect,
// forged ACK or timeout cannot release buffers that are still queued.
module recovery_capacity {
  const FIXED: bool
  var reserved: bool
  var copies: int
  action init = all { reserved' = false, copies' = 0 }
  action capture = all { not(reserved), reserved' = true, copies' = copies + 1 }
  action forgetRecovery = all { reserved' = if (FIXED) reserved else false, copies' = copies }
  action transferEnds = all { copies > 0, reserved' = false, copies' = copies - 1 }
  action step = any { capture, forgetRecovery, transferEnds }
  val atMostOneTransferPerSlot = copies <= 1
  run forgedAckTest = init.then(capture).then(forgetRecovery)
    .expect(reserved == FIXED)
  run repeatedCaptureTest = if (FIXED)
    init.then(capture).then(forgetRecovery).then(transferEnds).then(capture).expect(atMostOneTransferPerSlot)
  else
    init.then(capture).then(forgetRecovery).then(capture).expect(not(atMostOneTransferPerSlot))
}
module recovery_capacity_before { import recovery_capacity(FIXED = false).* }
module recovery_capacity_fixed { import recovery_capacity(FIXED = true).* }

// The first review of the fix found that Promise.all kept A's reservation
// while B was still sending. Releasing A independently must also stop the
// old broadcast's finally from releasing A's newer retry token.
module recovery_reservation {
  const RELEASE_EACH: bool
  const OWNED_RELEASE: bool
  var aDone: bool
  var bDone: bool
  var retry: bool
  var reservation: int
  var blocked: bool
  action init = all { aDone' = false, bDone' = false, retry' = false, reservation' = 1, blocked' = false }
  action aFails = all {
    not(aDone), aDone' = true, bDone' = bDone, retry' = retry, blocked' = blocked,
    reservation' = if (RELEASE_EACH) 0 else reservation,
  }
  action retryA = all {
    aDone, not(retry), retry' = true, aDone' = aDone, bDone' = bDone,
    blocked' = reservation != 0, reservation' = if (reservation == 0) 2 else reservation,
  }
  action bFinishes = all {
    not(bDone), bDone' = true, aDone' = aDone, retry' = retry, blocked' = blocked,
    reservation' = if (not(OWNED_RELEASE) or reservation == 1) 0 else reservation,
  }
  action step = any { aFails, retryA, bFinishes }
  val otherGuestsDoNotBlockRetry = not(blocked)
  val oldCleanupNeverReleasesRetry = (retry and not(blocked)) implies reservation == 2
  val allHold = otherGuestsDoNotBlockRetry and oldCleanupNeverReleasesRetry
  run independentRetryTest = init.then(aFails).then(retryA).expect(otherGuestsDoNotBlockRetry == RELEASE_EACH)
  run ownedCleanupTest = init.then(aFails).then(retryA).then(bFinishes)
    .expect(oldCleanupNeverReleasesRetry == (not(RELEASE_EACH) or OWNED_RELEASE))
}
module recovery_reservation_together { import recovery_reservation(RELEASE_EACH = false, OWNED_RELEASE = true).* }
module recovery_reservation_unowned { import recovery_reservation(RELEASE_EACH = true, OWNED_RELEASE = false).* }
module recovery_reservation_fixed { import recovery_reservation(RELEASE_EACH = true, OWNED_RELEASE = true).* }
