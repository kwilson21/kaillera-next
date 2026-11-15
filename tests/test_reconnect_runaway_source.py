"""After a reconnect: the catch-up's wait does not spin, the reliable channel
carries each frame's input once (specs/catch_up_wait.qnt), the host resets the
peer's state too (I2), and a state header is taken only from the host."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _src() -> str:
    return LOCKSTEP_JS.read_text()


def test_a_frames_input_goes_out_once_on_the_reliable_channel():
    src = _src()
    send = src[src.index("const shouldSendRedundancy = _useCRollback") :]
    send = send[: send.index("_rbTransportPacketsSent++;")]
    # The skip is decided before the packet is built, and remembers the
    # channel: a new channel (a reconnect, a fallback) always gets the frame.
    assert "lastSend.dc === inputDc &&" in send
    assert "lastSend.frame === _frameNum &&" in send
    assert (
        "(inputDc === peer.dc || nowSend - lastSend.at < INPUT_RESEND_EVERY_MS)" in send
    )
    assert send.index("continue;") < send.index("KNShared.encodeInput(")
    assert "peer._knInputSend = { dc: inputDc, frame: _frameNum, at: nowSend };" in src
    assert "const INPUT_RESEND_EVERY_MS = 16;" in src
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
    assert "pushSyncState(sid, false);" in count
    assert "_sendResyncRequest(hostDc, requestId, 'sync-request-full');" in count
    assert "const INPUT_ASK_OVERDUE_ASKS = 3;" in src
    assert "const INPUT_ASK_OVERDUE_MS = 1500;" in src
    pushes = src[src.index("const _checkOverduePushes = () => {") :]
    pushes = pushes[: pushes.index("\n  };\n")]
    assert "window.KNCore.resyncRequest.pushDeadlineStep(" in pushes
    assert "(_inputSettledBefore[slot] ?? 0) >= push.frame - DELAY_FRAMES" in pushes
    assert "_checkResyncRequestDeadline();\n    _checkOverduePushes();" in src
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
