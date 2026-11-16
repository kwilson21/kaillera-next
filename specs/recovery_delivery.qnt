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
  // The finite race is over only after both original sends and the retry
  // admission settle. Preserve that terminal state under later bounded steps.
  action finished = all {
    aDone, bDone, retry,
    aDone' = aDone, bDone' = bDone, retry' = retry,
    reservation' = reservation, blocked' = blocked,
  }
  action step = any { aFails, retryA, bFinishes, finished }
  run terminalStateTest = init.then(aFails).then(retryA).then(bFinishes)
    .then(finished).then(finished).expect(aDone and bDone and retry)
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

// The typed actor replaces JS flag combinations, without changing the
// engine's freeze-credited logical clock. Delivered/failed outcomes have
// bounded retry deadlines; quiet in-flight work also ends logically, while
// its physical reservation remains until the operation actually settles.
// Disabled resync never creates a recovery obligation.
module recovery_actor {
  const ENABLED: bool
  var state: str
  var attempt: int
  var deliveredAttempt: int
  action init = all {
    state' = if (ENABLED) "sending" else "inactive", attempt' = 1, deliveredAttempt' = 0,
  }
  action deliver = all {
    state == "sending", state' = "awaitingAck", attempt' = attempt, deliveredAttempt' = attempt,
  }
  action transferFailed = all {
    state == "sending", state' = "backoff", attempt' = attempt, deliveredAttempt' = deliveredAttempt,
  }
  action ack = all {
    state' = if (state == "awaitingAck" and deliveredAttempt == attempt) "settled" else state,
    attempt' = attempt, deliveredAttempt' = deliveredAttempt,
  }
  action timeout = all {
    Set("sending", "awaitingAck", "backoff").contains(state),
    state' = if (attempt < 3) "sending" else "exhausted",
    attempt' = if (attempt < 3) attempt + 1 else attempt,
    deliveredAttempt' = 0,
  }
  action cancel = all { state != "inactive", state' = "ended", attempt' = attempt, deliveredAttempt' = deliveredAttempt }
  action step = any { deliver, transferFailed, ack, timeout, cancel }
  val noUndeliveredAcknowledgement = (state == "settled") implies deliveredAttempt == attempt
  val attemptsAreBounded = attempt <= 3
  val disabledNeverRecoversOrDrops = not(ENABLED) implies state == "inactive"
  val allHold = noUndeliveredAcknowledgement and attemptsAreBounded and disabledNeverRecoversOrDrops
  run ackBeforeDeliveryTest = init.then(ack).expect(state == (if (ENABLED) "sending" else "inactive"))
  run failuresEndTest = if (ENABLED)
    init.then(transferFailed).then(timeout).then(transferFailed).then(timeout).then(transferFailed).then(timeout).expect(state == "exhausted")
  else init.then(ack).expect(state == "inactive")
  run retryNeedsOwnDeliveryTest = if (ENABLED)
    init.then(deliver).then(timeout).then(ack).expect(state == "sending")
  else init.then(ack).expect(state == "inactive")
}
module recovery_actor_enabled { import recovery_actor(ENABLED = true).* }
module recovery_actor_disabled { import recovery_actor(ENABLED = false).* }

// A settled source can discover another hole while a different recipient
// still retries the first broadcast. Global coalescing starves that source;
// admitting only free recipient slots preserves outstanding obligations.
module recovery_followup {
  const PER_SOURCE: bool
  var aPending: bool
  var bPending: bool
  var bAttempt: int
  var followup: bool
  var blocked: bool
  action init = all {
    aPending' = true, bPending' = true, bAttempt' = 1,
    followup' = false, blocked' = false,
  }
  action settleA = all {
    aPending, aPending' = false, bPending' = bPending, bAttempt' = bAttempt,
    followup' = followup, blocked' = blocked,
  }
  action retryB = all {
    bPending, bAttempt < 3, bAttempt' = bAttempt + 1,
    aPending' = aPending, bPending' = bPending, followup' = followup, blocked' = blocked,
  }
  action newHoleA = all {
    not(aPending), not(followup), followup' = true,
    blocked' = (not(PER_SOURCE) and bPending),
    aPending' = (PER_SOURCE or not(bPending)),
    bPending' = bPending, bAttempt' = bAttempt,
  }
  // No more events are modeled after A settles its follow-up and B reaches
  // the retry bound. Idle here must not erase B's still-pending obligation.
  action finished = all {
    not(aPending), followup, bAttempt == 3,
    aPending' = aPending, bPending' = bPending, bAttempt' = bAttempt,
    followup' = followup, blocked' = blocked,
  }
  action step = any { settleA, retryB, newHoleA, finished }
  run terminalStateTest = init.then(settleA).then(newHoleA)
    .then(retryB).then(retryB)
    .then(if (PER_SOURCE) settleA else finished)
    .then(finished).expect(bPending and bAttempt == 3 and followup)
  val healthySourceIsNeverBlocked = not(blocked)
  val pendingRecipientIsPreserved = bPending and bAttempt >= 1 and bAttempt <= 3
  val allHold = healthySourceIsNeverBlocked and pendingRecipientIsPreserved
  run trailingHoleTest = init.then(settleA).then(newHoleA)
    .expect(healthySourceIsNeverBlocked == PER_SOURCE)
  run independentRetryTest = init.then(settleA).then(retryB).then(newHoleA)
    .expect(bPending and bAttempt == 2)
}
module recovery_followup_before { import recovery_followup(PER_SOURCE = false).* }
module recovery_followup_fixed { import recovery_followup(PER_SOURCE = true).* }

// Logical reset does not cancel the old physical B transfer. A new broadcast
// partitions permits instead of rejecting A merely because B remains busy.
module recovery_partial_admission {
  const PARTIAL: bool
  var aStarted: bool
  var bCopies: int
  var bOwed: bool
  var requested: bool
  action init = all { aStarted' = false, bCopies' = 1, bOwed' = false, requested' = false }
  action request = all {
    not(requested), requested' = true,
    aStarted' = PARTIAL, bCopies' = bCopies, bOwed' = true,
  }
  // This model covers one admission decision, not transfer completion.
  action finished = all {
    requested, aStarted' = aStarted, bCopies' = bCopies,
    bOwed' = bOwed, requested' = requested,
  }
  action step = any { request, finished }
  run terminalStateTest = init.then(request).then(finished).then(finished)
    .expect(requested and bCopies == 1 and bOwed)
  val freeRecipientProceeds = requested implies aStarted
  val blockedRecipientRemainsBoundedAndOwed = bCopies == 1 and (requested implies bOwed)
  val allHold = freeRecipientProceeds and blockedRecipientRemainsBoundedAndOwed
  run resetDuringPhysicalTransferTest = init.then(request)
    .expect(freeRecipientProceeds == PARTIAL and blockedRecipientRemainsBoundedAndOwed)
}
module recovery_partial_before { import recovery_partial_admission(PARTIAL = false).* }
module recovery_partial_fixed { import recovery_partial_admission(PARTIAL = true).* }

// Acknowledging one hole does not buy unlimited new full-state captures.
// Queue coalescing preserves one pending caller per admitted target, not one
// Promise/Effect waiter per wire request. Before variants reproduce floods.
module recovery_source_budget {
  const FIXED: bool
  var admitted: int
  var used: int
  var waiters: int
  var requests: int
  var sourceDropped: bool
  var healthyDropped: bool
  action init = all {
    admitted' = 0, used' = 0, waiters' = 0, requests' = 0,
    sourceDropped' = false, healthyDropped' = false,
  }
  action captureAndAck = all {
    not(sourceDropped),
    admitted' = if (FIXED and used >= 3) admitted else admitted + 1,
    used' = if (FIXED) (if (used < 3) used + 1 else used) else 0,
    sourceDropped' = (FIXED and used >= 3), healthyDropped' = healthyDropped,
    waiters' = waiters, requests' = requests,
  }
  action queueRequest = all {
    requests < 10, requests' = requests + 1,
    waiters' = if (FIXED) 1 else waiters + 1,
    used' = used, admitted' = admitted,
    sourceDropped' = sourceDropped, healthyDropped' = healthyDropped,
  }
  action idle = all {
    admitted' = admitted, used' = used, waiters' = waiters, requests' = requests,
    sourceDropped' = sourceDropped, healthyDropped' = healthyDropped,
  }
  action step = any { captureAndAck, queueRequest, idle }
  val capturesBoundedWithinWindow = admitted <= 3
  val pendingWaitersBounded = waiters <= 1
  val healthyRecipientNotDropped = not(healthyDropped)
  val allHold = capturesBoundedWithinWindow and pendingWaitersBounded and healthyRecipientNotDropped
  run ackDoesNotRenewBudgetTest = init.then(captureAndAck).then(captureAndAck).then(captureAndAck)
    .expect(used == (if (FIXED) 3 else 0))
  run exhaustedSourceDoesNotStallRoomTest = init.then(captureAndAck).then(captureAndAck)
    .then(captureAndAck).then(captureAndAck)
    .expect(sourceDropped == FIXED and not(healthyDropped))
  run duplicateQueueTest = init.then(queueRequest).then(queueRequest)
    .expect(pendingWaitersBounded == FIXED)
}
module recovery_source_budget_before { import recovery_source_budget(FIXED = false).* }
module recovery_source_budget_fixed { import recovery_source_budget(FIXED = true).* }
