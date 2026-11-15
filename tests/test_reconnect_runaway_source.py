"""After a reconnect: the catch-up's wait does not spin, the reliable channel
carries each frame's input once (specs/catch_up_wait.qnt), the host resets the
peer's state too (I2), and a state header is taken only from the host."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _src() -> str:
    return LOCKSTEP_JS.read_text()


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
    assert "if (_playerSlot !== 0 || !_syncEnabled) return;" in push[:600]
    assert src.count("`sync-start:${frame}:") == 1


def test_an_overdue_ask_is_decided_by_the_proved_rule_and_ends_in_a_resync():
    # specs/ask_escalation.qnt: overdueAskStep decides; the host pushes, a
    # guest asks; the push has its own deadline (pushDeadlineStep).
    src = _src()
    count = src[src.index("const _countOverdueAsk = (peer, oldest, now) => {") :]
    count = count[: count.index("\n  };\n")]
    assert "window.KNCore.resyncRequest.overdueAskStep(" in count
    assert "_escalateLostInput(peer, step, now);" in count
    escalate = src[src.index("const _escalateLostInput = (peer, step, now) => {") :]
    escalate = escalate[: escalate.index("\n  };\n")]
    assert "pushSyncState(sid, false);" in escalate
    assert "_sendResyncRequest(hostDc, requestId, 'sync-request-full');" in escalate
    assert "const INPUT_ASK_OVERDUE_ASKS = 3;" in src
    assert "const INPUT_ASK_OVERDUE_MS = 1500;" in src
    pushes = src[src.index("const _checkOverduePushes = () => {") :]
    pushes = pushes[: pushes.index("\n  };\n")]
    assert "window.KNCore.resyncRequest.pushDeadlineStep(" in pushes
    # Answered by the guest's inputs-settled alone, not the host's own
    # hand-over of the state (which raises _inputSettledBefore).
    assert "(_inputSettledAckBefore[slot] ?? -1) >= push.frame - DELAY_FRAMES" in pushes
    assert "_inputSettledBefore[slot]" not in pushes
    assert "_checkResyncRequestDeadline();\n    _checkOverduePushes();" in src
    # The last push unanswered: the player is dropped (I1's recovery), not
    # left playing on split; the event alone is not one.
    give_up = pushes[pushes.index("INPUT-ASK-PUSH-GAVEUP") :]
    assert "hardDisconnectPeer(push.sid);" in give_up
    assert "could not be brought back in sync and was dropped" in give_up
    # Every ask that goes out is counted.
    ask = src[
        src.index("const _askForMissingInputs = (peer, applyFrame, windowEdge) => {") :
    ]
    ask = ask[: ask.index("\n  };\n")]
    assert "if (sent.length) _countOverdueAsk(peer, frames[0], now);" in ask
    # I2: per-peer state, dropped with the peer.
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "delete _inputAskOverdue[slot];" in reset
    assert "delete _overduePushes[slot];" in reset


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
    assert "_escalateLostInput(peer, step, now);" in late


def test_after_a_reconnect_reset_a_frame_waits_for_the_peers_first_input():
    # specs/reconnect_inputs.qnt WAIT_FIRST_INPUT: the reset leaves the C slot
    # inactive, so a frame run on the peer's missing input would record no
    # prediction. It waits until one input at or above the floor is in.
    src = _src()
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "delete _awaitFirstInputAfterReset[slot];" in reset
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
    # Every reset of all peers' state clears it too (I2): three, besides
    # the declaration.
    assert src.count("let _awaitFirstInputAfterReset = {};") == 1
    assert src.count("_awaitFirstInputAfterReset = {};") == 4


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
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "delete _inputSettledAckBefore[slot];" in reset
    assert src.count("_inputSettledAckBefore = {};") == 4


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
