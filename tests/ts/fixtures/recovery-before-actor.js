// Frozen lifecycle baseline from afa328705219cb52ff67e0b621068aae1a3f44c6.
// Test-only; do not import into production.
const _sendEscalationPush = (slot, push, targetSid) => {
  const attempt = { slot, push };
  push.attempt = attempt;
  push.at = null;
  push.failed = false;
  push.settled = false;
  push.deliveredBefore = null;
  push.enqueued = false;
  push.armedAt = performance.now();
  pushSyncState(targetSid, false, { escalation: [attempt] });
};
const _onEscalationTransfer = (attempts, sid, sent, frame = -1) => {
  if (!attempts?.length) return;
  const now = performance.now();
  for (const a of attempts) {
    const push = a.push;
    const applies = window.KNCore.resyncRequest.transferReportApplies(
      _overduePushes[a.slot] === push,
      push.attempt === a,
      sid === null || sid === push.sid,
      push.at !== null || push.failed,
    );
    if (!applies) continue;
    if (sent) {
      push.at = now;
      push.deliveredBefore = frame - DELAY_FRAMES;
    } else {
      push.failed = true;
      push.failedAt = now;
    }
  }
};
const _forgetHolePushes = (slot) => {
  delete _holePushCounts[slot];
};
const _escalateLostInput = (peer, step, now, hole) => {
  const slot = peer.slot;
  if (step === 'push') {
    const sid = Object.keys(_peers).find((key) => _peers[key] === peer);
    if (!sid) return;
    // Pushes are counted per hole, a push let go included: a hole is
    // pushed up to the limit, then left to the stall path (its deadline,
    // the phantom and its resync), never pushed for ever, and holes taking
    // turns keep their own counts (specs/escalation_push.qnt hole_counts;
    // escalationForHole).
    const counts = (_holePushCounts[slot] ??= {});
    const had = counts[hole] ?? 0;
    const decision = window.KNCore.resyncRequest.escalationForHole(
      Object.keys(_overduePushes).length > 0,
      had,
      OVERDUE_MAX_PUSHES,
    );
    // Held by the overdue step already (_escalationHeld); a page that
    // calls in anyway gets nothing.
    if (decision !== 'push') return;
    counts[hole] = had + 1;
    // One independently tracked recipient per active guest. The source's
    // acknowledgement must never abandon another guest's missed copy.
    // A group in flight coalesces further holes (recovery_delivery.qnt).
    const attempts = [];
    for (const { sid: recipientSid, peer: recipient } of _syncTargetsFor(null)) {
      const recipientSlot = recipient.slot;
      const push = {
        sid: recipientSid,
        hole,
        firstFrame: _frameNum,
        pushes: had + 1,
        armedAt: now,
        at: null,
        failed: false,
        settled: false,
        deliveredBefore: null,
        enqueued: false,
        attempt: null,
      };
      const attempt = { slot: recipientSlot, push };
      push.attempt = attempt;
      _overduePushes[recipientSlot] = push;
      attempts.push(attempt);
    }
    _syncLog(`INPUT-ASK-PUSH f=${_frameNum} slot=${slot} hole=${hole} push=${had + 1}/${OVERDUE_MAX_PUSHES}`);
    pushSyncState(null, false, { escalation: attempts });
    return;
  }
  const hostDc = Object.values(_peers).find((p) => p.slot === 0)?.dc;
  if (hostDc?.readyState !== 'open') return;
  _syncTargetFrame = -1;
  _syncTargetDeadlineAt = 0;
  const requestId = _beginResyncRequest();
  try {
    _sendResyncRequest(hostDc, requestId, 'sync-request-full');
  } catch (e) {
    _resyncRequestInFlight = false;
    _syncLog(`INPUT-ASK-OVERDUE resync request send failed: ${e}`);
  }
};
const _checkOverduePushes = () => {
  if (_playerSlot !== 0) return;
  const now = performance.now();
  for (const key of Object.keys(_overduePushes)) {
    const push = _overduePushes[key];
    const slot = Number(key);
    const target = _peers[push.sid];
    let step = window.KNCore.resyncRequest.pushDeadlineStep(
      true,
      !target || !!target.reconnecting || !!_peerPhantom[slot],
      push.settled,
      push.at !== null,
      push.failed,
      now - Math.max(push.armedAt, push.enqueued ? (_syncChainMovedAt[push.sid] ?? 0) : 0),
      OVERDUE_PUSH_QUIET_MS,
      push.at === null ? 0 : now - push.at,
      OVERDUE_PUSH_TIMEOUT_MS,
      push.pushes,
      OVERDUE_MAX_PUSHES,
    );
    // A missed recipient still needs the authoritative state. Retry a
    // failed hand-over after a bounded backoff instead of forgetting it.
    // Exhaustion uses the same explicit drop/rejoin recovery as a missing
    // acknowledgement; it never calls the room settled.
    if (step === 'letGo') {
      step = window.KNCore.resyncRequest.missedDeliveryStep(
        push.failed,
        now - (push.failedAt ?? now),
        OVERDUE_PUSH_TIMEOUT_MS,
        push.pushes,
        OVERDUE_MAX_PUSHES,
      );
      if (step !== 'wait')
        _syncLog(`INPUT-ASK-PUSH-NOT-SENT f=${_frameNum} slot=${slot}: retrying the missing recipient`);
    }
    if (step === 'sending' || step === 'wait' || step === 'noPush') continue;
    if (step === 'ended') {
      // A reconnect or a phantom: its own resync (or PEER-RECOVERED's)
      // supersedes the push (push_deadline, END_ON_RECONNECT). Counting on
      // would drop a guest mid-reconnect.
      _syncLog(
        `INPUT-ASK-PUSH-ENDED f=${_frameNum} slot=${slot}: ` +
          `${!target ? 'no entry' : target.reconnecting ? 'reconnecting' : 'phantom'}, its own resync supersedes the push`,
      );
      delete _overduePushes[key];
      _forgetHolePushes(slot);
    } else if (step === 'done') {
      _syncLog(`INPUT-ASK-PUSH-SETTLED f=${_frameNum} slot=${slot} frame=${push.firstFrame} pushes=${push.pushes}`);
      delete _overduePushes[key];
      _forgetHolePushes(slot);
    } else if (step === 'pushAgain') {
      // Only to this guest: the others took the first push, which was for
      // all (P2: a broadcast for each retry resyncs the whole room).
      push.pushes++;
      const counts = (_holePushCounts[slot] ??= {});
      counts[push.hole] = Math.max(counts[push.hole] ?? 0, push.pushes);
      _syncLog(`INPUT-ASK-PUSH-AGAIN f=${_frameNum} slot=${slot} push=${push.pushes}/${OVERDUE_MAX_PUSHES}`);
      _sendEscalationPush(slot, push, push.sid);
    } else {
      // The guest is still on a state that may differ from the host's,
      // and nothing else will correct it: it is dropped through the
      // normal path, so it rejoins (or late-joins) onto the host's state
      // rather than playing on split (I1: the deadline's recovery is the
      // drop, not the event).
      _syncLog(
        `INPUT-ASK-PUSH-GAVEUP f=${_frameNum} slot=${slot} pushes=${push.pushes}: no inputs-settled came — dropping the player`,
      );
      KNEvent('desync', 'A pushed state was never acknowledged: player dropped', {
        slot,
        pushes: push.pushes,
        kind: 'input-ask-push-giveup',
      });
      delete _overduePushes[key];
      const known = _knownPlayers[push.sid];
      const name = known ? known.playerName : `P${slot + 1}`;
      _config?.onToast?.(`${name} could not be brought back in sync and was dropped`);
      // hardDisconnectPeer tells the player first while the channel is
      // open: its page joins again late (specs/drop_is_final.qnt).
      hardDisconnectPeer(push.sid, { tell: 'desync' });
    }
  }
};
