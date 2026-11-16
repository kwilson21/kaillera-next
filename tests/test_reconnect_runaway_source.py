"""After a reconnect: the catch-up's wait does not spin, the reliable channel
carries each frame's input once (specs/catch_up_wait.qnt), the host resets the
peer's state too (I2), and a state header is taken only from the host."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _src() -> str:
    return LOCKSTEP_JS.read_text()


def _slot_clear(src):
    # The table _clearSlotInputState and _resetInputMaps both walk (I2).
    table = src[src.index("const _slotInputMaps = () => [") :]
    return table[: table.index("];")]


def test_the_same_frames_input_goes_out_again_at_most_every_100_ms():
    src = _src()
    send = src[src.index("const shouldSendRedundancy = _useCRollback") :]
    send = send[: send.index("_rbTransportPacketsSent++;")]
    # The skip is decided before the packet is built, and remembers the
    # channel: a new channel (a reconnect, a fallback) always gets the frame.
    assert "lastSend.dc === inputDc &&" in send
    assert "lastSend.frame === _frameNum &&" in send
    assert (
        "nowSend - lastSend.at < (inputDc === peer.dc ? INPUT_RESEND_RELIABLE_MS : INPUT_RESEND_EVERY_MS)"
        in send
    )
    assert send.index("continue;") < send.index("KNShared.encodeInput(")
    assert "peer._knInputSend = { dc: inputDc, frame: _frameNum, at: nowSend };" in src
    assert "const INPUT_RESEND_EVERY_MS = 16;" in src
    assert "const INPUT_RESEND_RELIABLE_MS = 100;" in src
    # Each change of a peer's input channel is logged.
    assert "`INPUT-CHANNEL f=${_frameNum} slot=${peer.slot} label=" in send


def test_the_host_resets_the_peer_when_a_reconnect_opens():
    # I2: the reset is no longer only a guest's.
    src = _src()
    block = src[
        src.index("// If this is a reconnect, clear reconnecting state and resync") :
    ]
    block = block[: block.index("const _reconnectRequestId = _beginResyncRequest();")]
    reset = block.index(
        "resetPeerState(peer.slot, 'reconnect', { peer, sid: remoteSid });"
    )
    guest_only = block.index("if (_playerSlot !== 0) {\n          _lastResyncTime = 0;")
    assert reset < guest_only


def test_a_state_header_is_taken_only_from_the_host():
    src = _src()
    sync = src[src.index("const setupSyncDataChannel = (_remoteSid, ch) => {") :]
    guard = sync.index("_peers[_remoteSid]?.slot !== 0")
    assert guard < sync.index("if (e.data.startsWith('sync-start:')) {")
    assert "e.data.startsWith('sync-regions-start:')" in sync[guard - 200 : guard]
    assert "state header refused" in sync[guard : guard + 400]
    # The only sender is pushSyncState, which sends nothing off slot 0.
    push = src[src.index("const pushSyncState = async (") :]
    assert "if (_playerSlot !== 0 || !_syncEnabled) return notSent(" in push[:1000]
    assert src.count("`sync-start:${frame}:") == 1


def test_an_overdue_ask_is_decided_by_the_proved_rule_and_ends_in_a_resync():
    # specs/ask_escalation.qnt: overdueAskStep decides; the host pushes, a
    # guest asks; the push has its own deadline (pushDeadlineStep).
    src = _src()
    count = src[src.index("const _countOverdueAsk = (peer, oldest, now) => {") :]
    count = count[: count.index("\n  };\n")]
    assert "window.KNCore.resyncRequest.overdueAskStep(" in count
    assert "_escalateLostInput(peer, step, now, oldest);" in count
    # A push out, or a hole whose pushes ran out, holds the step (it says
    # wait, not push to nothing).
    assert "isHost ? _escalationHeld(slot, oldest) : _resyncRequestInFlight" in count
    assert "isHost ? _escalationHeld(slot, frame) : _resyncRequestInFlight" in src
    escalate = src[
        src.index("const _escalateLostInput = (peer, step, now, hole) => {") :
    ]
    escalate = escalate[: escalate.index("\n  };\n")]
    # The first push goes to every guest (escalation_peers); the hole keeps
    # its count across a let-go (escalation_push COUNT_SURVIVES).
    assert "_sendEscalationPush(slot, push, null);" in escalate
    # Counted per hole (hole_counts), the decision proved.
    assert "window.KNCore.resyncRequest.escalationForHole(" in escalate
    assert "const counts = (_holePushCounts[slot] ??= {});" in escalate
    # Logged once, where a let-go leaves the hole at its limit.
    assert (
        "INPUT-ASK-PUSH-EXHAUSTED"
        in src[src.index("const _checkOverduePushes = () => {") :][:6000]
    )
    assert "_sendResyncRequest(hostDc, requestId, 'sync-request-full');" in escalate
    assert "const INPUT_ASK_OVERDUE_ASKS = 3;" in src
    assert "const INPUT_ASK_OVERDUE_MS = 1500;" in src
    pushes = src[src.index("const _checkOverduePushes = () => {") :]
    pushes = pushes[: pushes.index("\n  };\n")]
    assert "window.KNCore.resyncRequest.pushDeadlineStep(" in pushes
    # Answered by the guest's inputs-settled alone, not the host's own
    # hand-over of the state (which raises _inputSettledBefore).
    assert (
        "(_inputSettledAckBefore[slot] ?? -1) >= push.firstFrame - DELAY_FRAMES"
        in pushes
    )
    assert "_inputSettledBefore[slot]" not in pushes
    assert "_checkResyncRequestDeadline();\n    _checkOverduePushes();" in src
    # The last push unanswered: the player is dropped (I1's recovery), not
    # left playing on split; the event alone is not one.
    give_up = pushes[pushes.index("INPUT-ASK-PUSH-GAVEUP") :]
    assert "hardDisconnectPeer(push.sid, { tell: 'desync' });" in give_up
    assert "could not be brought back in sync and was dropped" in give_up
    # Every ask that goes out is counted.
    ask = src[
        src.index("const _askForMissingInputs = (peer, applyFrame, windowEdge) => {") :
    ]
    ask = ask[: ask.index("\n  };\n")]
    assert (
        "if (sent.includes(frames[0])) _countOverdueAsk(peer, frames[0], now);" in ask
    )
    # I2: per-peer state, dropped with the peer.
    clear = _slot_clear(src)
    assert "    _inputAskOverdue,\n" in clear
    assert "    _overduePushes,\n" in clear


def test_an_input_past_the_window_that_differs_escalates_like_an_overdue_ask():
    # specs/ask_escalation.qnt, lateMismatch: C counts a failed rollback for a
    # misprediction too deep to roll back (DEEP-MISPREDICT-SKIP); every feed
    # is wrapped, and a count that moved escalates at once.
    src = _src()
    feed = src[src.index("const _feedWatched = (mod, slot, frame, feed) => {") :]
    feed = feed[: feed.index("\n  };\n")]
    assert "mod?._kn_get_failed_rollbacks?.()" in feed
    assert "_onPastWindowMismatch(slot, frame);" in feed
    late = src[src.index("const _onPastWindowMismatch = (slot, frame) => {") :]
    late = late[: late.index("\n  };\n")]
    assert "window.KNCore.resyncRequest.overdueAskStep(" in late
    assert "INPUT-PAST-WINDOW-MISMATCH" in late
    assert "_escalateLostInput(peer, step, now, frame);" in late


def test_after_a_reconnect_reset_a_frame_waits_for_the_peers_first_input():
    # specs/reconnect_inputs.qnt WAIT_FIRST_INPUT: the reset leaves the C slot
    # inactive, so a frame run on the peer's missing input would record no
    # prediction. It waits until one input at or above the floor is in.
    src = _src()
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "    _awaitFirstInputAfterReset,\n" in _slot_clear(src)
    assert reset.index("mod._kn_rollback_slot_reset(slot)") < reset.index(
        "if (reason === 'reconnect') _awaitFirstInputAfterReset[slot] = true;"
    )
    feed = src[src.index("const _feedWatched = (mod, slot, frame, feed) => {") :]
    feed = feed[: feed.index("\n  };\n")]
    assert "delete _awaitFirstInputAfterReset[slot];" in feed
    stall = src[src.index("const stallThreshold = _rbInputStallThreshold();") :]
    stall = stall[: stall.index("_checkPredictedKnown(rbInputPeers, rbApplyFrame);")]
    assert "_awaitingFirstInput(p.slot);" in stall
    assert "if (gapAtEdge || firstWait || adv >= stallThreshold) {" in stall
    # Every reset of all peers' state clears it too (I2): it is in the table
    # _resetInputMaps walks.
    assert src.count("let _awaitFirstInputAfterReset = {};") == 1
    assert "    _awaitFirstInputAfterReset,\n" in _slot_clear(src)


def test_every_frame_that_runs_is_checked_for_a_prediction_nothing_corrects():
    src = _src()
    check = src[src.index("const _checkPredictedKnown = (peers, applyFrame) => {") :]
    check = check[: check.index("\n  };\n")]
    assert "why = 'first-input';" in check
    assert "why = 'edge';" in check
    assert "PREDICTED-KNOWN f=" in check
    assert src.count("_checkPredictedKnown(rbInputPeers, rbApplyFrame);") == 1
    assert "predictedKnown: _predictedKnownCount," in src


def test_the_forced_past_window_switch_is_test_only_and_narrow():
    # PAST_WINDOW_FORCED: the harness lets one frame past the edge stall so
    # INPUT-PAST-WINDOW-MISMATCH is reached; the stall guards it otherwise.
    src = _src()
    assert src.count("window.__test_runPastEdgeFor") == 1
    assert (
        "const _testRunPastEdgeFrame = () => window.__test_runPastEdgeFor ?? -1;" in src
    )
    # Read in exactly two places: the edge stall and the PREDICTED-KNOWN check.
    assert src.count("_testRunPastEdgeFrame()") == 2
    assert "windowEdge !== _testRunPastEdgeFrame() &&" in src
    assert "if (windowEdge === _testRunPastEdgeFrame()) return;" in src


def test_the_guest_always_acknowledges_a_state_and_the_host_records_it_apart():
    src = _src()
    assert "peer.dc.send(`inputs-settled:${from}`);" in src
    assert "if (own.length) peer.dc.send(`inputs-settled:" not in src
    handler = src[src.index("if (e.data.startsWith('inputs-settled:')) {") :]
    handler = handler[: handler.index("return;")]
    assert "_inputSettledAckBefore[peer.slot] = Math.max(" in handler
    assert "    _inputSettledAckBefore,\n" in _slot_clear(src)
    maps = src[src.index("const _resetInputMaps = () => {") :]
    maps = maps[: maps.index("\n  };\n")]
    assert "    _inputSettledAckBefore,\n" in _slot_clear(src)


def test_an_input_the_page_lacked_keeps_the_peer_live_a_repeat_does_not():
    # specs/tick_deadlines.qnt peer_staleness: a peer catching up is not
    # stale; one that only repeats itself still goes stale.
    src = _src()
    store = src.index("    _remoteInputs[peer.slot][recvFrame] = recvInput;\n")
    before = src[
        src.rindex(
            "const existingHeaderInput = _remoteInputs[peer.slot][recvFrame];", 0, store
        ) : store
    ]
    assert "existingHeaderInput" in before
    after = src[store : store + 800]
    assert (
        "if (existingHeaderInput === undefined && _peerLastAdvanceTime[peer.slot] !== undefined) {"
        in after
    )


def test_a_player_dropped_in_the_match_comes_back_only_as_a_late_joiner():
    # specs/drop_is_final.qnt: the mesh check does not add back a player this
    # page dropped in the running match; the desync give-up tells it first,
    # and a guest takes `dropped:` only from the host.
    src = _src()
    check = src[src.index("const _meshHealthCheck = () => {") :]
    check = check[: check.index("const p = _peers[sid];")]
    # Host only, keyed by _peerKey everywhere (HOST_ONLY).
    assert (
        "if (_playerSlot === 0 && _droppedThisMatch.has(_peerKey(sid))) continue;"
        in check
    )
    hard = src[
        src.index(
            "const hardDisconnectPeer = (remoteSid, { quiet = false, tell = 'host' } = {}) => {"
        ) :
    ]
    hard = hard[: hard.index("\n  };\n")]
    assert (
        "if (_playerSlot === 0 && running) _droppedThisMatch.add(_peerKey(remoteSid));"
        in hard
    )
    # The host tells the player while its channel is open (TELL); a guest
    # that gave up on its host joins again late (GUEST_LATE_JOIN).
    assert "peer.dc.send(`dropped:${tell}`);" in hard
    assert hard.index("peer.dc.send(`dropped:${tell}`);") < hard.index(
        "delete _peers[remoteSid];"
    )
    assert "_endMatchDropped('lost-host');" in hard
    late = src[src.index("const handleLateJoinRequest = (msg) => {") :][:400]
    assert "_droppedThisMatch.delete(_peerKey(msg.requesterSid));" in late
    # Cleared on a new match and on stop, besides the declaration.
    assert src.count("let _droppedThisMatch = new Set();") == 1
    assert src.count("_droppedThisMatch = new Set();") == 3
    handler = src[src.index("if (e.data.startsWith('dropped:')) {") :][:400]
    assert "if (peer.slot !== 0) {" in handler
    assert "_endMatchDropped(" in handler
    # The page joins again late, through the start group's transition.
    end = src[src.index("const _endMatchDropped = (reason) => {") :]
    end = end[: end.index("\n  };\n")]
    assert "queueMicrotask(() => _config?.onLeftOutOfStart?.());" in end


def test_the_push_deadline_runs_only_on_the_pushs_own_hand_over():
    # specs/escalation_push.qnt: MARK_BY_FRAME, LET_GO_ON_OUTCOME,
    # CREDIT_FREEZE; specs/ask_escalation.qnt push_deadline: END_ON_RECONNECT,
    # SETTLE_ON_FIRST. The decision is the proved pushDeadlineStep.
    src = _src()
    pushes = src[src.index("const _checkOverduePushes = () => {") :]
    pushes = pushes[: pushes.index("\n  };\n")]
    assert "!target || !!target.reconnecting || !!_peerPhantom[slot]," in pushes
    assert "push.at !== null," in pushes
    # Let go on no progress, never a clock from the push's start (LET_GO
    # "progress"); a push let go leaves only its hole's count behind.
    # The push's own guest's chain (CLOCK "chain"), from when it reached it.
    assert (
        "now - Math.max(push.armedAt, push.enqueued ? (_syncChainMovedAt[push.sid] ?? 0) : 0),"
        in pushes
    )
    assert "_syncProgressAt" not in src
    assert "OVERDUE_PUSH_QUIET_MS," in pushes
    assert "OVERDUE_PUSH_BACKSTOP_MS" not in src
    assert "letGo: " not in src
    assert "INPUT-ASK-PUSH-ENDED" in pushes
    assert "INPUT-ASK-PUSH-NOT-SENT" in pushes
    # The retry goes to the guest that did not answer only.
    assert "_sendEscalationPush(slot, push, push.sid);" in pushes
    assert "_canPushSyncState" not in src
    assert "_markOverduePushSent" not in src
    # Only the push's own transfer starts its deadline, reported by
    # pushSyncState for each attempt it carries, on both paths.
    report = src[
        src.index("const _onEscalationTransfer = (attempts, sid, sent) => {") :
    ]
    report = report[: report.index("\n  };\n")]
    assert "window.KNCore.resyncRequest.transferReportApplies(" in report
    assert "_onEscalationTransfer(attempts, targetSid, true);" in src
    # Each guest's outcome as its own chain ends (PER_TARGET).
    # Each target settles alone, a rejection included (allSettled per target).
    send = src[src.index("const sendSyncChunks = async (") :]
    send = send[: send.index("\n  };\n")]
    assert (
        "_syncLog(`sync send to ${t.sid} failed: ${err}`);\n              return 'failed';"
        in send
    )
    assert "_onEscalationTransfer(attempts, t.sid, outcome === 'sent');" in send
    # The chain moves when a transfer starts, has a chunk accepted, or ends.
    assert src.count("_syncChainMovedAt[t.sid] = performance.now();") == 3
    assert "else if (a.push.attempt === a) a.push.enqueued = true;" in send
    # A freeze of the host's page is credited to the push's clocks.
    credit = src[src.index("const _creditLocalFreeze = () => {") :]
    credit = credit[: credit.index("\n  };\n")]
    assert "push.armedAt = Math.min(now, push.armedAt + gap);" in credit
    assert "if (push.at !== null) push.at = Math.min(now, push.at + gap);" in credit
    assert (
        "for (const sid in _syncChainMovedAt) _syncChainMovedAt[sid] = Math.min(now, _syncChainMovedAt[sid] + gap);"
        in credit
    )
    # Recovered, a peer's holes start their count again.
    assert src.count("_forgetHolePushes(") == 3
    # P2: one per-slot clear for both callers (I2), one map reset for three.
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "_clearSlotInputState(slot);" in reset
    pending = src[src.index("const _markPendingLateJoinPeer = ") :]
    pending = pending[: pending.index("\n  };\n")]
    assert "_clearSlotInputState(slot);" in pending
    assert src.count("_resetInputMaps();") == 3
    clear = _slot_clear(src)
    assert "    _inputOorLog,\n" in clear
    assert "    _resendLog,\n" in clear
    resend = src[src.index("if (e.data.startsWith('resend:')) {") :][:1400]
    assert "if (resendNow - resendLog.at >= INPUT_OOR_LOG_EVERY_MS) {" in resend
    assert "resendLog.lastAt = resendNow;" in resend
    flush = src[src.index("const _flushResendLogs = () => {") :]
    flush = flush[: flush.index("\n  };\n")]
    assert "if (now - log.lastAt < INPUT_OOR_LOG_EVERY_MS) continue;" in flush
    assert "Object.entries" not in flush
    assert "_checkOverduePushes();\n    _flushResendLogs();" in src


def test_an_escalation_push_is_a_full_state_and_the_counter_is_per_match():
    src = _src()
    assert "pushSyncState(targetSid, false, { escalation: [attempt] });" in src
    push = src[
        src.index(
            "const pushSyncState = async (targetSid, isProactive = false, options = {}) => {"
        ) :
    ]
    # The host sends no deltas (sync_base): every state is full and no base
    # is kept for it.
    assert "const toCompress = currentState;" in push[:12000]
    assert "`sync-start:${frame}:${numChunks}:1:${isProactive ? '1' : '0'}`" in src
    assert "_setLastSyncState(currentState.slice(), 'pushSync')" not in src
    assert "toCompress[i] = currentState[i] ^ _lastSyncState[i];" not in src
    stop = src[src.index("  const stop = () => {") :]
    stop = stop[: stop.index("\n  };\n")]
    assert "_predictedKnownCount = 0;" in stop


def test_the_per_slot_only_maps_are_reset_where_their_timeline_starts_over():
    # Not in _slotInputMaps: a new match (startLockstep, frames from 0) and
    # stop() reset them; a fast-forward keeps them, since it moves only this
    # page's frame.
    src = _src()
    start = src[src.index("const startLockstep = ") :]
    start = start[: start.index("_peerLastAdvanceTime = {};")]
    fresh = start[start.index("if (_frameNum === 0) {") :]
    assert "_lateJoinActivatedAtFrame = {};" in fresh
    assert "_lateJoinSeededInputFrames = {};" in fresh
    assert (
        "_lastRemoteFramePerSlot = {};"
        in start[start.index("_fpsLastTime = performance.now();") :]
    )
    stop = src[src.index("  const stop = () => {") :]
    stop = stop[: stop.index("\n  };\n")]
    for name in (
        "_lastRemoteFramePerSlot",
        "_lateJoinActivatedAtFrame",
        "_lateJoinSeededInputFrames",
    ):
        assert f"{name} = {{}};" in stop
    ff = src[
        src.index("_syncLog(`fast-forward: ${_frameNum} -> ${_lastRemoteFrame}`);") :
    ]
    ff = ff[: ff.index("_resetInputMaps();") + 20]
    assert "_lastRemoteFramePerSlot = {};" not in ff
