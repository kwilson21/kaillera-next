"""Regression tests for the simplified player-first late-join path.

Run: cd server && uv run pytest ../tests/test_late_join_simple.py -v
"""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_late_join_state_is_targeted_before_large_payload():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    emit_idx = source.find("type: 'late-join-state'")
    assert emit_idx != -1
    window = source[emit_idx : emit_idx + 400]

    assert "targetSid: remoteSid" in window
    assert window.find("targetSid: remoteSid") < window.find("data: encoded.data")


def test_late_join_receiver_filters_target_before_state_handling():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    handler_idx = source.find("const handleLateJoinState = async (msg) => {")
    assert handler_idx != -1
    handler_window = source[handler_idx : handler_idx + 500]

    target_idx = handler_window.find("msg.targetSid")
    spectator_idx = handler_window.find("_isSpectator")
    decode_idx = source.find("decodeAndDecompress", handler_idx)

    assert target_idx != -1
    assert spectator_idx != -1
    assert decode_idx != -1
    assert target_idx < spectator_idx
    assert handler_idx + target_idx < decode_idx


def test_late_join_ready_waits_for_open_dc_before_roster_activation():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    ready_emit_idx = source.find("type: 'late-join-ready'")
    assert ready_emit_idx != -1
    assert "senderSid: socket.id" in source[ready_emit_idx : ready_emit_idx + 160]

    finish_idx = source.find("const finishLateJoinReady")
    assert finish_idx != -1
    end_idx = source.find("\n\n  // -- users-updated", finish_idx)
    assert end_idx != -1
    window = source[finish_idx:end_idx]
    assert "peer?.dc?.readyState !== 'open'" in window
    assert "_pendingLateJoinReadySids.add(senderSid)" in window
    assert "_broadcastRoster()" in window

    open_idx = source.find("_pendingLateJoinReadySids.has(remoteSid)")
    assert open_idx != -1
    assert "finishLateJoinReady('deferred DC open', remoteSid)" in source[open_idx : open_idx + 180]


def test_late_join_ready_retries_until_resume():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    assert "let _lateJoinReadyRetryTimer = null" in source
    assert "const clearLateJoinReadyRetry = () => {" in source
    assert "late-join-ready retry" in source
    assert "if (_phase !== PHASE_RUNNING || readyAttempts >= 20)" in source
    assert "if (!_lateJoin || _phase !== PHASE_RUNNING || readyAttempts >= 20)" not in source

    resume_idx = source.find("if (e.data === 'late-join-resume')")
    assert resume_idx != -1
    resume_window = source[resume_idx : resume_idx + 500]
    assert "_lateJoin = false" in resume_window
    assert "clearLateJoinReadyRetry()" in resume_window

    stop_idx = source.find("const stop = () => {")
    assert stop_idx != -1
    assert "clearLateJoinReadyRetry()" in source[stop_idx : stop_idx + 5000]


def test_late_join_pause_is_not_sent_to_joiner():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    pause_idx = source.find("p.dc.send('late-join-pause')")
    assert pause_idx != -1
    pause_window = source[pause_idx - 500 : pause_idx + 120]

    assert "Object.entries(_peers)" in pause_window
    assert "if (sid === remoteSid) continue" in pause_window

    state_idx = source.find("const handleLateJoinState = async (msg) => {")
    assert state_idx != -1
    load_window = source[state_idx : state_idx + 7000]
    assert "late-join: clearing self pause after state load" in load_window
    assert "_runSubstate = RUN_NORMAL" in load_window


def test_late_join_toasts_are_present():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    assert "is joining..." in source
    assert "joined" in source


def test_smash_controller_presence_uses_core_mask_not_rdram_poke():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    assert "_forceSmashControllerRoster" not in source
    assert "_kn_set_controller_present_mask" in source
    assert "_applyControllerPresentMask('broadcast-roster')" in source
    assert "_applyControllerPresentMask('late-join-state')" in source
    assert "_resetControllerPresentMask()" in source
