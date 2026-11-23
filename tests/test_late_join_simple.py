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
        "_lateJoinServing.get(remoteSid) !== serveId ||"
    )

    ready = src[src.index("const finishLateJoinReady = (source, senderSid = null) => {") :]
    ready = ready[: ready.index("const _syntheticSidForSlot")]
    assert "_lateJoinServing.delete(senderSid);" in ready
    # Deferred readiness retains a serve deadline, but only a joiner that has
    # not loaded yet holds the room pause (runtime tests cover both orderings).
    assert "_runSubstate === RUN_LATE_JOIN_PAUSE &&" in ready
    assert "[..._lateJoinServing.keys()].some((sid) => !_pendingLateJoinReadySids.has(sid))" in ready

    helper = src[src.index("const _endLateJoinPauseIfNoneServed = (source) => {") :]
    helper = helper[: helper.index("\n  };\n")]
    assert "[..._lateJoinServing.keys()].some((sid) => !_pendingLateJoinReadySids.has(sid))" in helper
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


def test_a_joiner_that_lost_the_host_resyncs_after_loading():
    # specs/late_join_pause.qnt (aJoinerIsNotMadeAPlayerBehindTheHost): the
    # host ends a serve when the joiner's channel goes (its own 15 s deadline
    # closes it too) and runs on, but a state already sent is still loaded.
    # Its "ready" then made the joiner a player frames behind the host.
    src = (Path(__file__).resolve().parent.parent / "web/static/netplay-rollback.js").read_text()

    disconnect = src[src.index("const handlePeerDisconnect = (remoteSid, lostAttempt") :]
    disconnect = disconnect[: disconnect.index("\n  };\n")]
    assert (
        "peer.slot === 0 && _playerSlot !== 0 && (_awaitingLateJoinState || _isApplyingLateJoinState)"
        in disconnect
    )
    assert "_lateJoinLostHost = true;" in disconnect

    helper = src[src.index("const _resyncAfterLostHost = (source) => {") :]
    helper = helper[: helper.index("\n  };\n")]
    # The step is the proved lateJoinLostHostStep (web/src/resync-request.ts):
    # idle unless marked, a guest, and running.
    assert (
        "const step = window.KNCore.resyncRequest.lateJoinLostHostStep(\n"
        "      _lateJoinLostHost,\n"
        "      _playerSlot === 0,\n"
        "      _phase === PHASE_RUNNING,\n"
        "      hostDc?.readyState === 'open',\n"
        "      _resyncRequestInFlight,\n"
        "      _lateJoinLostHostAsks,\n"
        "      LATE_JOIN_LOST_HOST_MAX_ASKS,\n"
        "    );"
    ) in helper
    assert "if (step === 'idle') return;" in helper
    assert "_sendResyncRequest(hostDc, requestId, 'sync-request-full');" in helper

    state = src[src.index("const handleLateJoinState = async (msg) => {") :]
    state = state[: state.index("// -- Guest audio muting")]
    assert "if (info.slot === 0) _lateJoinLostHost = true;" in state
    assert state.index("_lateJoinReadyRetryTimer = setInterval(") < state.index(
        "_resyncAfterLostHost('late-join state loaded');"
    )

    # Asked when the host's channel opens, if it was closed at the load. The
    # same opening ends a guest's wait for its host at the start (#274).
    assert (
        "      if (peer.slot === 0) {\n"
        "        _endHostAnswerDeadline(true);\n"
        "        _resyncAfterLostHost('host channel open');\n"
        "      }\n"
    ) in src

    # A fresh wait, joining the start, an applied host state, the give-up,
    # the end of the match (stopSync) and the page's stop clear it: it cannot
    # outlive a match. Each resets the ask count with it.
    assert src.count("_lateJoinLostHost = false;") - src.count("let _lateJoinLostHost = false;") == 6
    assert src.count("_lateJoinLostHostAsks = 0;") - src.count("let _lateJoinLostHostAsks = 0;") == 6
    stop_sync = src[src.index("const stopSync = () => {") :]
    stop_sync = stop_sync[: stop_sync.index("\n  };\n")]
    assert "_lateJoinLostHost = false;" in stop_sync

    # The resync it asks for is a numbered request (#213): a late answer to
    # it is handled by the resync request rules.
    assert "const requestId = _beginResyncRequest();" in helper
    assert "_sendResyncRequest(hostDc, requestId, 'sync-request-full');" in helper


def test_a_lost_host_resync_that_goes_unanswered_is_asked_again_up_to_a_bound():
    # specs/late_join_pause.qnt (KEEP_MARKER_UNTIL_APPLIED,
    # resyncRequestUnansweredTest): the marker used to be cleared when the
    # request was sent. A request the host refused, or whose answer was lost,
    # then left the joiner behind the host for good.
    src = (Path(__file__).resolve().parent.parent / "web/static/netplay-rollback.js").read_text()

    helper = src[src.index("const _resyncAfterLostHost = (source) => {") :]
    helper = helper[: helper.index("\n  };\n")]
    # Not cleared at send, nor while another request is out.
    send = helper.index("_sendResyncRequest(hostDc, requestId, 'sync-request-full');")
    in_flight = helper.index("if (step === 'inFlight') {")
    assert "_lateJoinLostHost = false;" not in helper[:in_flight]
    assert "_lateJoinLostHost = false;" not in helper[in_flight:send][: helper[in_flight:send].index("\n    }\n")]
    # The cap: checked before each ask, then a visible give-up.
    assert "const LATE_JOIN_LOST_HOST_MAX_ASKS = 3;" in src
    cap = helper.index("if (step === 'giveUp') {")
    assert in_flight < cap < helper.index("_lateJoinLostHostAsks++;") < send
    give_up = helper[cap : helper.index("_lateJoinLostHostAsks++;")]
    assert "_lateJoinLostHost = false;" in give_up
    assert "LATE-JOIN-LOST-HOST-GIVEUP" in give_up
    assert "KNEvent('late-join-lost-host-giveup'" in give_up
    # The step decides each branch; nothing compares it any more.
    assert "observe(" not in helper
    # A failed send asks again, still under the cap.
    catch = helper[helper.index("} catch (e) {") :]
    assert "_resyncRequestInFlight = false;" in catch
    assert "_resyncAfterLostHost(`${source}, send failed`);" in catch

    # The request's deadline asks again, with no timer of its own.
    deadline = src[src.index("const _checkResyncRequestDeadline = () => {") :]
    deadline = deadline[: deadline.index("\n  };\n")]
    assert deadline.index("_resyncRequestInFlight = false;") < deadline.index(
        "_resyncAfterLostHost('resync request timed out');"
    )

    # Cleared when a host state is applied.
    apply = src[
        src.index(
            "const applySyncState = (bytes, frame, fromProactive = false, recoveryId = 0, extras = null) => {"
        ) :
    ]
    apply = apply[: apply.index("\n  };\n")]
    assert apply.index("_lastAppliedSyncHostFrame = frame;") < apply.index("_lateJoinLostHost = false;")

    # Not by resetPeerState: the late-join load resets the host's peer state
    # right after setting the marker.
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "_lateJoinLostHost" not in reset

    # The give-up is a client event the server accepts.
    app = (Path(__file__).resolve().parent.parent / "server/src/api/app.py").read_text()
    assert '"late-join-lost-host-giveup",' in app
