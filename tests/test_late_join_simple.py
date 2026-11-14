"""Regression tests for the simplified player-first late-join path.

Run: cd server && uv run pytest ../tests/test_late_join_simple.py -v
"""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_late_join_state_is_targeted_before_large_payload():
    source = (REPO_ROOT / "web/static/netplay-rollback.js").read_text()

    emit_idx = source.find("type: 'late-join-state'")
    assert emit_idx != -1
    window = source[emit_idx : emit_idx + 400]

    assert "targetSid: remoteSid" in window
    assert window.find("targetSid: remoteSid") < window.find("data: encoded.data")


def test_late_join_receiver_filters_target_before_state_handling():
    source = (REPO_ROOT / "web/static/netplay-rollback.js").read_text()

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
    source = (REPO_ROOT / "web/static/netplay-rollback.js").read_text()

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
    source = (REPO_ROOT / "web/static/netplay-rollback.js").read_text()

    assert "let _lateJoinReadyRetryTimer = null" in source
    assert "const clearLateJoinReadyRetry = () => {" in source
    assert "late-join-ready retry" in source
    assert "if (_phase !== PHASE_RUNNING || readyAttempts >= 20)" in source
    assert "if (!_lateJoin || _phase !== PHASE_RUNNING || readyAttempts >= 20)" not in source

    resume_idx = source.find("if (e.data === 'late-join-resume' && peer.slot === 0) {")
    assert resume_idx != -1
    resume_window = source[resume_idx : resume_idx + 500]
    assert "_lateJoin = false" in resume_window
    assert "clearLateJoinReadyRetry()" in resume_window

    stop_idx = source.find("const stop = () => {")
    assert stop_idx != -1
    assert "clearLateJoinReadyRetry()" in source[stop_idx : stop_idx + 5000]


def test_late_join_pause_is_not_sent_to_joiner():
    source = (REPO_ROOT / "web/static/netplay-rollback.js").read_text()

    pause_idx = source.find("p.dc.send('late-join-pause')")
    assert pause_idx != -1
    pause_window = source[pause_idx - 500 : pause_idx + 120]

    assert "Object.entries(_peers)" in pause_window
    assert "if (sid === remoteSid) continue" in pause_window

    state_idx = source.find("const handleLateJoinState = async (msg) => {")
    assert state_idx != -1
    load_window = source[state_idx : state_idx + 10000]
    assert "late-join: clearing self pause after state load" in load_window
    assert "_runSubstate = RUN_NORMAL" in load_window


def test_late_join_toasts_are_present():
    source = (REPO_ROOT / "web/static/netplay-rollback.js").read_text()

    assert "is joining..." in source
    assert "joined" in source


def test_smash_controller_presence_uses_core_mask_not_rdram_poke():
    source = (REPO_ROOT / "web/static/netplay-rollback.js").read_text()

    assert "_forceSmashControllerRoster" not in source
    assert "_kn_set_controller_present_mask" in source
    assert "_applyControllerPresentMask('broadcast-roster')" in source
    assert "_applyControllerPresentMask('late-join-state')" in source
    assert "_resetControllerPresentMask()" in source


def test_the_pause_belongs_to_the_joiners_being_served():
    # specs/late_join_pause.qnt (holdToday): one joiner's "ready" or timer
    # must not end the pause for another joiner who has yet to load, a timer
    # must not disconnect a joiner who has since joined, and the pause must
    # have its deadline from the moment it begins.
    src = (Path(__file__).resolve().parent.parent / "web/static/netplay-rollback.js").read_text()

    serve = src[src.index("async function sendLateJoinState(remoteSid) {") :]
    serve = serve[: serve.index("const handleLateJoinState = async (msg) => {")]
    # The timer is armed at the pause, before the state is compressed.
    assert serve.index("_lateJoinServing.set(remoteSid, serveId);") < serve.index("await compressAndEncode(bytes)")
    assert serve.index("setTimeout(onServeDeadline, LATE_JOIN_TIMEOUT_MS);") < serve.index(
        "await compressAndEncode(bytes)"
    )
    # It acts only on its own serve, and ends the pause only if none is left.
    assert "if (_lateJoinServing.get(remoteSid) !== serveId) return;" in serve
    assert "_endLateJoinPauseIfNoneServed(`timeout for ${remoteSid}`);" in serve
    assert "if (_runSubstate === RUN_LATE_JOIN_PAUSE) {\n          const elapsed" not in serve
    # A serve ended while compressing sends nothing.
    assert serve.index("await compressAndEncode(bytes)") < serve.index(
        "if (_lateJoinServing.get(remoteSid) !== serveId) {"
    )

    ready = src[src.index("const finishLateJoinReady = (source, senderSid = null) => {") :]
    ready = ready[: ready.index("const _syntheticSidForSlot")]
    assert "_lateJoinServing.delete(senderSid);" in ready
    assert "_runSubstate === RUN_LATE_JOIN_PAUSE && _playerSlot === 0 && _lateJoinServing.size > 0" in ready

    helper = src[src.index("const _endLateJoinPauseIfNoneServed = (source) => {") :]
    helper = helper[: helper.index("\n  };\n")]
    assert "if (_lateJoinServing.size > 0) {" in helper
    assert "return resumeLateJoinPause(source, true);" in helper

    # I2: a joiner that is gone is no longer served, and the match stop clears the lot.
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "_lateJoinServing.delete(opts.sid)" in reset
    assert "_lateJoinServing.clear();" in src


def test_a_repeated_request_keeps_the_first_deadline():
    # specs/late_join_pause.qnt (aRepeatedRequestKeepsTheDeadline): the joiner
    # repeats its request every 5 s. Each one the host took used to be a new
    # serve with a new timer, and the old timer then did nothing.
    src = (Path(__file__).resolve().parent.parent / "web/static/netplay-rollback.js").read_text()
    serve = src[src.index("async function sendLateJoinState(remoteSid) {") :]
    serve = serve[: serve.index("const handleLateJoinState = async (msg) => {")]
    assert "const servedAs = _lateJoinServing.get(remoteSid);" in serve
    assert "const serveId = servedAs ?? ++_lateJoinServeSeq;" in serve
    assert "const armTimer = servedAs === undefined;" in serve
    assert "if (armTimer) setTimeout(onServeDeadline, LATE_JOIN_TIMEOUT_MS);" in serve


def test_only_the_host_pauses_and_resumes_a_page():
    # specs/late_join_pause.qnt (guestResumesOnTheHostsWord,
    # guestPauseHasADeadline): a page that is not the host stays paused until
    # the host says resume, or its own deadline. A joiner's "ready" used to
    # resume it while the host was still paused for another joiner.
    src = (Path(__file__).resolve().parent.parent / "web/static/netplay-rollback.js").read_text()
    assert "if (e.data === 'late-join-pause' && peer.slot === 0) {" in src
    assert "if (e.data === 'late-join-resume' && peer.slot === 0) {" in src

    ready = src[src.index("const finishLateJoinReady = (source, senderSid = null) => {") :]
    ready = ready[: ready.index("const _syntheticSidForSlot")]
    assert ready.index("if (_playerSlot !== 0) return;") < ready.index("let newlyHandled = false;")
    # The joiner that just became a player waits with everyone else.
    assert "readyDc.send('late-join-pause');" in ready

    # I1: the page's own deadline, longer than the host's per joiner.
    assert "const LATE_JOIN_GUEST_PAUSE_TIMEOUT_MS = 20000;" in src
    assert "const LATE_JOIN_TIMEOUT_MS = 15000;" in src
    tick = src[src.index("const tick = () => {") :]
    pause = tick[tick.index("if (_runSubstate === RUN_LATE_JOIN_PAUSE) {") :][:1200]
    assert "if (guestPausedMs <= LATE_JOIN_GUEST_PAUSE_TIMEOUT_MS) {" in pause
    assert "LATE-JOIN-GUEST-PAUSE-TIMEOUT f=${_frameNum}" in pause
    assert "_runSubstate = RUN_NORMAL;" in pause


def test_the_resume_for_a_joiner_that_left_waits_for_the_peer_to_be_dropped():
    # resetPeerState runs before its caller deletes the peer. A resume from
    # inside it broadcast a roster that listed the joiner as a player.
    src = (Path(__file__).resolve().parent.parent / "web/static/netplay-rollback.js").read_text()
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "queueMicrotask(() => _endLateJoinPauseIfNoneServed(`${reason} for ${leftSid}`));" in reset
    assert "      _endLateJoinPauseIfNoneServed(`${reason} for ${opts.sid}`);" not in reset
