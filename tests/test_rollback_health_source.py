import json
import re
import subprocess
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCKSTEP_JS = ROOT / "web/static/netplay-rollback.js"
ROLLBACK_C = ROOT / "build/kn_rollback/kn_rollback.c"
ROLLBACK_H = ROOT / "build/kn_rollback/kn_rollback.h"
INVARIANTS_DOC = ROOT / "docs/netplay-invariants.md"


def test_c_output_exports_validate_pointers_and_sizes():
    c_src = ROLLBACK_C.read_text()
    h_src = ROLLBACK_H.read_text()

    assert "uint32_t kn_get_taint_blocks(uint8_t *out, uint32_t out_size)" in c_src
    assert "uint32_t kn_get_taint_blocks(uint8_t *out, uint32_t out_size);" in h_src
    assert "if (!out || out_size < KN_TAINT_BLOCKS) return 0;" in c_src

    assert "int kn_get_mispred_breakdown(int *out, int out_count)" in c_src
    assert "int kn_get_mispred_breakdown(int *out, int out_count);" in h_src
    assert "if (!out || out_count < 3) return 0;" in c_src

    assert "if (!out_buttons || !out_lx || !out_ly || !out_cx || !out_cy) return 0;" in c_src


def test_js_calls_sized_c_exports_with_explicit_capacities():
    src = LOCKSTEP_JS.read_text()

    assert "const RDRAM_TAINT_BLOCKS = 128;" in src
    assert "_kn_get_mispred_breakdown(window._rbMispredBuf, 3)" in src
    assert "_kn_get_taint_blocks(_taintBuf, RDRAM_TAINT_BLOCKS)" in src
    assert "_kn_get_taint_blocks(_rbTaintBufPtr, RDRAM_TAINT_BLOCKS)" in src

    assert not re.search(r"_kn_get_taint_blocks\([^,\n)]*\)", src)
    assert not re.search(r"_kn_get_mispred_breakdown\([^,\n)]*\)", src)


def test_rollback_stall_sites_have_wall_clock_action_markers():
    src = LOCKSTEP_JS.read_text()
    doc = INVARIANTS_DOC.read_text()

    for marker in ("PHASE-LOCK-WAIT", "MENU-LOCKSTEP-WAIT", "RB-INPUT-STALL-TIMEOUT"):
        assert marker in src
        assert marker in doc

    assert "stalledMs >= MAX_STALL_MS + RESEND_TIMEOUT_MS" in src
    assert "stallDuration >= MAX_STALL_MS + RESEND_TIMEOUT_MS" in src
    assert "markPeerPhantomForStallTimeout" in src


def test_strict_menu_lockstep_never_fabricates_or_phantoms_inputs():
    src = LOCKSTEP_JS.read_text()

    assert "MENU-LOCKSTEP-TIMEOUT" not in src
    assert "phase-lock-timeout" not in src
    assert "menu-lockstep-timeout" not in src
    assert "MENU-LOCKSTEP-WAIT" in src
    assert "PHASE-LOCK-WAIT" in src
    assert "holding strict menu lockstep" in src


def test_strict_menu_resend_cadence_is_per_slot():
    src = LOCKSTEP_JS.read_text()

    assert "_bootStallLastResendAt" not in src
    assert "let _strictMenuResendState = {};" in src
    assert "const resendKey = `${source}:${slot}:${applyFrame}`;" in src
    assert "prev?.key === resendKey && nowMs - prev.lastAt < RESEND_TIMEOUT_MS" in src
    assert "_strictMenuResendState[slot] = { key: resendKey, lastAt: nowMs };" in src
    assert re.search(r"_requestStrictMenuResends\(\s*bootInputPeers,\s*missingSlots,", src)
    assert "_requestStrictMenuResends(inputPeers, _missingSlots, applyFrame, now, 'js-menu')" in src


def test_retroarch_deterministic_patch_is_enforced_by_build():
    build_src = (ROOT / "build/build.sh").read_text()
    patch_src = (ROOT / "build/patches/retroarch-deterministic-timing.patch").read_text()

    assert "FATAL: RetroArch deterministic timing patch failed" in build_src
    assert "_kn_rollback_init,_kn_feed_input,_kn_pre_tick,_kn_post_tick" in patch_src
    assert 'ASYNCIFY_REMOVE ?= ["retro_serialize","retro_unserialize","kn_pre_tick","kn_post_tick"' in patch_src
    assert "window._knPreventRetroArchVisibilityPause" in patch_src


def test_rollback_delay_inputs_are_clamped_to_engine_window():
    src = LOCKSTEP_JS.read_text()

    assert (
        "const clampRollbackDelay = (value, fallback = ROLLBACK_MIN_DELAY_FRAMES)"
        in src
    )
    assert (
        "return Math.min(_delayCeiling(), Math.max(ROLLBACK_MIN_DELAY_FRAMES, parsed));"
        in src
    )
    # Ceiling depends on mode: lockstep (predictions paused) vs true rollback.
    assert (
        "const _delayCeiling = () => (_predictionsPaused ? LOCKSTEP_MAX_DELAY_FRAMES : ROLLBACK_MAX_DELAY_FRAMES);"
        in src
    )
    assert "const hostDelay = clampRollbackDelay(e.data.split(':')[1], 0);" in src
    assert "if (hasRollback && !soloMode) ownDelay = clampRollbackDelay(ownDelay);" in src
    assert "window._rbHostDelay = clampRollbackDelay(msg.effectiveDelay);" in src
    assert (
        "const _rbFallbackDelay = clampRollbackDelay(DELAY_FRAMES, ROLLBACK_MIN_DELAY_FRAMES);"
        in src
    )


def test_solo_delay_does_not_initialize_rollback():
    src = LOCKSTEP_JS.read_text()

    assert "const soloMode = playerPeerSids.length === 0;" in src
    assert "ownDelay = 0;" in src
    assert "if (hasRollback && !soloMode) ownDelay = clampRollbackDelay(ownDelay);" in src
    assert "if (detMod?._kn_rollback_init && DELAY_FRAMES > 0)" in src
    assert "C-ROLLBACK disabled for zero-delay solo play" in src


def test_phase_lock_deadline_tracks_intermittent_phase_mismatch():
    src = LOCKSTEP_JS.read_text()

    assert "const phaseMismatchSlots = [];" in src
    assert "notePhaseMismatch(p.slot);" in src
    assert "phaseMismatchSlots," in src
    assert "const phaseLockSlots = [...new Set(phaseMismatchSlots)].sort((a, b) => a - b);" in src
    assert "mismatchPeers=[${phaseLockSlots.join(',')}]" in src
    assert "if (phaseWaitSlots.length && !holdReplayDue) {" in src


def test_resync_state_load_clears_pending_c_inputs():
    src = LOCKSTEP_JS.read_text()

    assert "const _clearPendingCInputs = (reason) => {" in src
    assert "_clearPendingCInputs(`${reason}:pre-load`)" in src
    assert "_clearPendingCInputs(`${reason}:post-load`)" in src
    assert "_clearPendingCInputs(`${reason}:pre-kn-sync`)" in src
    assert "_clearPendingCInputs(`${reason}:post-kn-sync`)" in src


def test_pre_tick_local_input_uses_c_frame_after_host_authoritative_init():
    src = LOCKSTEP_JS.read_text()

    assert "const cFrameBeforePreTick = tickMod._kn_get_frame?.() ?? _frameNum;" in src
    assert "const cFrameLocalInput = _localInputs[cFrameBeforePreTick];" in src
    assert "const preTickLocalInput = cFrameLocalInput || localInput;" in src
    assert "C-INPUT-ALIGN jsF=${_frameNum} cF=${cFrameBeforePreTick}" in src

    align_idx = src.index("const cFrameBeforePreTick = tickMod._kn_get_frame?.() ?? _frameNum;")
    pre_tick_idx = src.index("let catchingUp = tickMod._kn_pre_tick(", align_idx)
    pre_tick_call = src[pre_tick_idx : pre_tick_idx + 350]
    assert "preTickLocalInput.buttons" in pre_tick_call
    assert "preTickLocalInput.lx" in pre_tick_call
    assert "preTickLocalInput.ly" in pre_tick_call
    assert "localInput.buttons" not in pre_tick_call


def test_gameplay_to_menu_schedules_per_match_input_reset():
    src = LOCKSTEP_JS.read_text()

    helper_idx = src.index("const _resetMatchInputState = (reason) => {")
    helper_src = src[helper_idx : src.index("const _scheduleMatchInputReset", helper_idx)]
    for snippet in (
        "_localInputs = {};",
        "_remoteInputs = {};",
        "_peerInputStarted = {};",
        "_lastRemoteFramePerSlot = {};",
        "_rbLocalHistory.length = 0;",
        "for (const k of Object.keys(_lastKnownInput)) delete _lastKnownInput[k];",
        "peer.lastAckFromPeer = -1;",
        "peer.lastFrameFromPeer = -1;",
        "peer.lastAckAdvanceTime = 0;",
        "MATCH-INPUT-RESET reason=${reason}",
    ):
        assert snippet in helper_src

    assert "let _pendingMatchInputResetReason = '';" in src
    assert (
        "_scheduleMatchInputReset(`gameplay-menu:f${_frameNum}:scene${sceneCurr}:status${gameStatus}`);"
        in src
    )
    assert "_flushPendingMatchInputReset('post-c-replay-tick')" in src
    assert "_flushPendingMatchInputReset('post-c-tick')" in src
    assert "if (_pendingMatchInputResetReason && _frameNum <= 0) _flushPendingMatchInputReset('tick-start');" in src

    transition_idx = src.index("GAMEPLAY→MENU transition")
    schedule_idx = src.index("_scheduleMatchInputReset(`gameplay-menu", transition_idx)
    shutdown_idx = src.index("_shutdownCRollbackForMenu(tickMod", transition_idx)
    assert transition_idx < schedule_idx < shutdown_idx


def test_gameplay_to_menu_c_shutdown_keeps_frame_timeline():
    # Smash Remix pause (scene 22, status 2) tears down the C engine. The
    # tick must stop right there: running on into _kn_post_tick resets
    # _frameNum to -1 on only the peer that got that far, and the other
    # peer's lockstep waits on frames that never come.
    src = LOCKSTEP_JS.read_text()
    transition_idx = src.index("GAMEPLAY→MENU transition")
    branch_src = src[transition_idx : src.index("MENU-LOCKSTEP armed at", transition_idx)]

    guard = "if (!_shutdownCRollback) {"
    assert guard in branch_src
    assert branch_src.index(guard) < branch_src.index("_scheduleMatchInputReset(`gameplay-menu")

    call_idx = branch_src.index("_shutdownCRollbackForMenu(tickMod")
    after_shutdown = branch_src[call_idx:]
    assert "_markTickReturn('skip:rb-shutdown');" in after_shutdown
    assert after_shutdown.index("_markTickReturn('skip:rb-shutdown');") < after_shutdown.index("return;")

    helper_idx = src.index("const _shutdownCRollbackForMenu = (tickMod")
    helper_src = src[helper_idx : src.index("\n  };\n", helper_idx)]
    assert "C-ROLLBACK shutdown on GAMEPLAY→MENU" in helper_src
    # Skipping the reset must not keep a whole match of input history alive.
    assert "const keepFrom = _frameNum - 600;" in helper_src


def test_gameplay_to_menu_c_shutdown_waits_for_confirmed_state():
    # Shutting down with mispredicted frames still uncorrected leaves the
    # peers on different states that the lockstep path never repairs. Hold
    # the shutdown until the live state is final, with a deadline (I1).
    src = LOCKSTEP_JS.read_text()
    doc = INVARIANTS_DOC.read_text()
    transition_idx = src.index("GAMEPLAY→MENU transition")
    branch_src = src[transition_idx : src.index("MENU-LOCKSTEP armed at", transition_idx)]

    assert "const RB_SHUTDOWN_HOLD_MS = " in src
    assert "_rbShutdownHold = { since: performance.now(), frame: _frameNum };" in branch_src
    drain_idx = branch_src.index("_drainPendingCInputs(tickMod);")
    confirm_idx = branch_src.index("_liveStateConfirmed(tickMod)")
    deadline_idx = branch_src.index("RB_SHUTDOWN_HOLD_MS")
    call_idx = branch_src.index("_shutdownCRollbackForMenu(tickMod")
    # Arrived inputs are fed before judging, so a stalled tab can't time out
    # on inputs that are already here.
    assert drain_idx < confirm_idx < call_idx and deadline_idx < call_idx
    assert "RB-SHUTDOWN-HOLD-TIMEOUT" in branch_src
    assert "RB-SHUTDOWN-HOLD-TIMEOUT" in doc and "RB_SHUTDOWN_HOLD_MS" in doc

    # While held the frame doesn't advance unless a replay is due, and any
    # step it does take is strict lockstep (no prediction at match end).
    hold_wait = branch_src[call_idx:]
    assert "_kn_peek_pending_rollback" in hold_wait
    assert hold_wait.index("_markTickReturn('skip:rb-shutdown-hold');") > hold_wait.index("holdReplayDue =")
    assert "const _menuLockstepActive = strictInputLockstep || !!_rbShutdownHold;" in src
    # Missing inputs are requested, not just waited on until the deadline.
    resend = "_requestStrictMenuResends([m.peer], [m.peer.slot], m.frame, nowMs, 'rb-hold');"
    assert "for (const m of _missingConsumedInputs()) {" in hold_wait
    assert hold_wait.index(resend) < hold_wait.index("_markTickReturn('skip:rb-shutdown-hold');")
    # A due replay is never blocked by the strict phase/menu stalls.
    assert "if (phaseWaitSlots.length && !holdReplayDue) {" in src
    assert "if (_menuLockstepActive && !holdReplayDue) {" in src
    assert "return _missingConsumedInputs().length === 0;" in src

    # A hold never outlives the engine it was for.
    init_idx = src.index("const doRollbackInit = (effectiveDelay")
    assert "_rbShutdownHold = null;" in src[init_idx : src.index("if (!detMod?._kn_rollback_init)", init_idx)]
    fallback_idx = src.index("if (consecutiveThrows >= 3 && _useCRollback) {")
    assert "_rbShutdownHold = null;" in src[fallback_idx : src.index("C-ROLLBACK-FALLBACK", fallback_idx)]
    helper_idx = src.index("const _shutdownCRollbackForMenu = (tickMod")
    assert "_clearPendingCInputs('rb-shutdown');" in src[helper_idx : src.index("\n  };\n", helper_idx)]

    # Back in gameplay before the hold ends: the engine never stopped.
    menu_to_gameplay = src[src.index("MENU→GAMEPLAY transition at") : transition_idx]
    assert "_rbShutdownHold = null;" in menu_to_gameplay

    # The confirmation check is shared with the host's sync dispatch.
    assert "_hostStateConfirmed" not in src
    assert "_dispatchScheduledSyncs(() => _liveStateConfirmed(tickMod));" in src

    # Match stop clears a hold left over from the finished match.
    stop_idx = src.index("const stopSync = () => {")
    assert "_rbShutdownHold = null;" in src[stop_idx : src.index("\n  };\n", stop_idx)]


def test_rollback_gap_check_ignores_frames_before_c_init():
    # Legacy lockstep deletes consumed remote inputs, so before a deferred
    # init the window edge would look like a lost packet.
    src = LOCKSTEP_JS.read_text()
    idx = src.index("const gapAtEdge =")
    gap_src = src[idx : src.index(";", idx)]
    assert "windowEdge >= Math.max(0, _rbInitFrame - DELAY_FRAMES)" in gap_src


def test_pending_rollback_init_keeps_reliable_input_stream_alive():
    src = LOCKSTEP_JS.read_text()

    helper_idx = src.index("const _sendPendingRollbackInitInput = () => {")
    helper_src = src[helper_idx : src.index("const startLockstep = () => {", helper_idx)]
    for snippet in (
        "const activePeers = getActivePeers();",
        "const hadLocalInputForFrame = Object.prototype.hasOwnProperty.call(_localInputs, _frameNum);",
        "_localInputs[_frameNum] = localInput;",
        "_auditRecordLocal(_frameNum, localInput);",
        "_rbLocalHistory.push({",
        "const ackFrame = peer.lastFrameFromPeer ?? -1;",
        "peer.dc.send(KNShared.encodeInput(_frameNum, localInput, ackFrame, null).buffer);",
        "RB-PENDING-INIT input f=${_frameNum}",
    ):
        assert snippet in helper_src

    pending_idx = src.index("if (window._rbPendingInit) {")
    pending_src = src[pending_idx : src.index("if (_syncTargetFrame > 0", pending_idx)]
    send_idx = pending_src.index("_sendPendingRollbackInitInput();")
    deadline_idx = pending_src.index("if (_rbPendingStart > 0 && performance.now() - _rbPendingStart > RB_INIT_TIMEOUT_MS)")
    assert send_idx < deadline_idx


def test_host_authoritative_rb_init_catches_guest_state_up_before_init():
    src = LOCKSTEP_JS.read_text()

    assert "let _rbPendingInitCatchup = null;" in src
    assert "const _requestRollbackInit = (delay, initFrame, source) => {" in src
    assert "targetFrame > _frameNum" in src
    assert "_rbPendingInitCatchup = { delay: effectiveDelay, initFrame: targetFrame, source };" in src
    assert "RB-INIT-CATCHUP armed source=${source}" in src
    assert "RB-INIT-CATCHUP complete source=${source}" in src

    request_idx = src.index("const _requestRollbackInit = (delay, initFrame, source) => {")
    request_src = src[request_idx : src.index("const startLockstep = () => {", request_idx)]
    arm_idx = request_src.index("targetFrame > _frameNum")
    direct_idx = request_src.index("window._rbDoInit(effectiveDelay, alignedFrame);")
    assert arm_idx < direct_idx

    pending_idx = src.index("if (window._rbPendingInit) {")
    pending_src = src[pending_idx : src.index("if (_syncTargetFrame > 0", pending_idx)]
    catchup_idx = pending_src.index("if (_rbPendingInitCatchup) {")
    timeout_idx = pending_src.index("if (_rbPendingStart > 0 && performance.now() - _rbPendingStart > RB_INIT_TIMEOUT_MS)")
    fallthrough_idx = pending_src.index("Fall through to the JS lockstep path")
    assert catchup_idx < timeout_idx
    assert catchup_idx < fallthrough_idx < timeout_idx

    assert "_requestRollbackInit(hostDelay, window._rbHostInitFrame, 'rb-delay');" in src
    assert "_requestRollbackInit(window._rbHostDelay, hostInitFrame, 'rb-init-frame');" in src
    assert "_requestRollbackInit(window._rbHostDelay, window._rbHostInitFrame, 'try-init');" in src


def test_failed_frame_step_does_not_advance_bookkeeping():
    src = LOCKSTEP_JS.read_text()

    assert "const _runStepOneFrame = (branch) => {" in src
    assert "const stepped = stepOneFrame();" in src
    assert "STEP-NORUN f=${_frameNum} branch=${branch}" in src
    assert "_syncLog(_formatStepThrew(branch, e));" in src

    # A step that did not run must never reach _kn_post_tick: each branch
    # bails out (replay helper returns false and the burst loop stops).
    assert "if (!_runStepOneFrame('replay')) return false;" in src
    assert "if (!_runCReplayFrame(tickMod)) break;" in src
    assert re.search(r"if \(!_runStepOneFrame\('normal'\)\) \{\s*_markTickReturn\('skip:step-norun'\);\s*return;", src)
    assert "if (!_runStepOneFrame('fallback')) return;" in src

    fallback_idx = src.index("if (!_runStepOneFrame('fallback')) return;")
    increment_idx = src.index("_frameNum++;", fallback_idx)
    assert fallback_idx < increment_idx

    assert "const consumedRemoteInputSlots = [];" in src
    assert "consumedRemoteInputSlots.push(peerSlot);" in src
    delete_idx = src.index("delete _remoteInputs[peerSlot][applyFrame];", fallback_idx)
    assert fallback_idx < delete_idx < increment_idx


def test_asyncify_remove_preserves_normal_frame_fiber_stack():
    build_src = (ROOT / "build/build.sh").read_text()
    match = re.search(r"KN_ASYNCIFY_REMOVE='\[(.*?)\]'", build_src)
    assert match, "KN_ASYNCIFY_REMOVE assignment not found"
    removed = set(re.findall(r'"([^"]+)"', match.group(1)))

    assert {"retro_serialize", "retro_unserialize", "kn_pre_tick", "kn_post_tick"} <= removed
    assert not {"retro_run", "runloop_iterate", "core_run", "emscripten_mainloop"} & removed
    assert "loading-frame fiber switch into a WASM" in build_src


def test_stall_and_input_logs_use_cheap_slot_formatting():
    src = LOCKSTEP_JS.read_text()

    assert "const _formatSlotMap = (obj) => {" in src
    assert "const _formatInputBrief = (input) =>" in src
    assert "rBuf=${_formatSlotMap(rBufSizes)}" in src
    assert "peerStarted=${_formatSlotMap(_peerInputStarted)}" in src
    assert "local=${_formatInputBrief(localInput)}" in src
    assert "rBuf=${_formatSlotMap(rBufDetail)} dc=${_formatSlotMap(dcStates)}" in src


def test_rb_input_dc_close_routes_through_cleanup_and_reliable_fallback():
    src = LOCKSTEP_JS.read_text()

    assert "peer.rbDcUnreliable = ordered === false && maxRetransmits === 0;" in src
    assert "const resetPeerRollbackTransport = (peer, sid, reason) => {" in src
    assert "resetPeerRollbackTransport(peer, remoteSid, 'rb-dc-close');" in src
    assert "peer.rbDc = null;" in src
    assert "_rbTransport = 'reliable';" in src
    assert "DC-FALLBACK reason=rb-dc-close" in src

    close_idx = src.find("resetPeerRollbackTransport(peer, remoteSid, 'rb-dc-close');")
    close_window = src[close_idx - 300 : close_idx + 500]
    assert "resetPeerState(" not in close_window


def test_start_wait_rtt_has_wall_clock_deadline():
    # I1: checkAllLockstepReady's START-WAIT-RTT branch waits on _rttComplete
    # with no deadline before #56 — a failed ping send or a DC closing
    # mid-measurement could leave that wait unbounded forever.
    src = LOCKSTEP_JS.read_text()
    doc = INVARIANTS_DOC.read_text()

    assert "const START_WAIT_RTT_MS = 5000;" in src
    assert "START-WAIT-RTT-TIMEOUT" in src

    doc_rows = [line for line in doc.splitlines() if "START_WAIT_RTT_MS" in line]
    assert doc_rows, "I1 table missing a START_WAIT_RTT_MS row"
    assert any("START-WAIT-RTT-TIMEOUT" in row for row in doc_rows)

    # The send-failure path must route through the same completion helper as
    # normal ("all peers done") completion, not just increment counters.
    ping_idx = src.index("const sendNextPing = (peer) => {")
    ping_src = src[ping_idx : src.index("const handleDelayPong", ping_idx)]
    catch_src = ping_src[ping_src.index("} catch (_) {") :]
    assert "_finishRttMeasurement(" in catch_src


def test_stop_resets_rtt_median_between_matches():
    # I1/#56: _rttMedian (set from the previous match's RTT samples) was
    # never reset anywhere, including stop(). In match 2+, a zero-sample RTT
    # measurement left the old median in place; checkAllLockstepReady's
    # `hasRollback && _rttMedian > 0` branch then ran _rttStats(_rttSamples)
    # on an empty sample array, and `s.median.toFixed` threw on the null
    # result inside the START-WAIT-RTT timer callback, so the match never
    # started.
    src = LOCKSTEP_JS.read_text()
    start_idx = src.index("const stop = () => {")
    end_idx = src.index("const _medianSample = (samples) => {", start_idx)
    stop_src = src[start_idx:end_idx]

    assert "_rttMedian = 0;" in stop_src


def test_finish_rtt_measurement_resets_median_when_no_samples():
    # I1/#56 (paired with the stop() reset above): a match that finishes RTT
    # measurement with zero samples (every ping send failed before the first
    # ping ever landed) must not inherit a stale median from an earlier
    # match either.
    src = LOCKSTEP_JS.read_text()
    start_idx = src.index("const _finishRttMeasurement = (reason) => {")
    end_idx = src.index("const sendNextPing = (peer) => {", start_idx)
    finish_src = src[start_idx:end_idx]

    assert "RTT measurement complete with no samples" in finish_src
    else_idx = finish_src.index("} else {")
    assert "_rttMedian = 0;" in finish_src[else_idx:]


def test_start_wait_rtt_timer_does_not_gate_on_phase_floor():
    # I1/#56: the timer previously early-returned when `_phase` had dropped
    # below PHASE_LOCKSTEP_READY (e.g. the sync-retry timeout at
    # checkAllEmuReady resets `_phase = PHASE_EMU_READY`). That left
    # `_startWaitRttLogged` permanently true with no timer re-armed once
    # LOCKSTEP_READY was re-entered, so the wait became unbounded again.
    # The timer must finish RTT regardless of the current phase floor —
    # only the session, completion, and already-running guards remain.
    src = LOCKSTEP_JS.read_text()
    start_idx = src.index("_startWaitRttTimer = setTimeout(() => {")
    end_idx = src.index("}, START_WAIT_RTT_MS);", start_idx) + len("}, START_WAIT_RTT_MS);")
    timer_src = src[start_idx:end_idx]

    assert "_phase < PHASE_LOCKSTEP_READY" not in timer_src
    assert "sid !== _sessionId" in timer_src
    assert "_rttComplete" in timer_src
    assert "_phase >= PHASE_RUNNING" in timer_src
    assert "_finishRttMeasurement(" in timer_src


def test_rollback_init_backfills_remote_inputs_past_the_init_frame():
    # Nonzero-frame rollback inits (RB-INIT-CATCHUP, the remixMenuLockstep
    # deferred init, RB-INIT-TIMEOUT at f>0) left remote frames past the init
    # frame that arrived before init JS-only: the receive path dedups later
    # copies against _remoteInputs, so C predicted them and never verified.
    # Past _frameNum a ZERO_INPUT placeholder (late join) must stay unfed.
    src = LOCKSTEP_JS.read_text()
    helper_start = src.index("const INPUT_PAST_WINDOW_FRAMES =")
    helper_end = src.index("// -- Audio (delegated", helper_start)
    helpers = src[helper_start:helper_end]
    script = textwrap.dedent(
        f"""
        const calls = [];
        const _rbRollbackMax = 12;
        const DELAY_FRAMES = 3;
        const _frameNum = 900;
        const _playerSlot = 0;
        const _localInputs = {{}};
        const _remoteInputs = {{ 1: {{}} }};
        const _syncLog = () => {{}};
        const KNShared = {{ ZERO_INPUT: Object.freeze({{buttons:0,lx:0,ly:0,cx:0,cy:0}}) }};
        const mod = {{ _kn_feed_input: (...args) => calls.push(args) }};
        for (let frame = 890; frame <= 910; frame++) {{
          _remoteInputs[1][frame] = {{ buttons: frame, lx: 0, ly: 0, cx: 0, cy: 0 }};
        }}
        _remoteInputs[1][889] = KNShared.ZERO_INPUT;
        _remoteInputs[1][920] = KNShared.ZERO_INPUT;
        _remoteInputs[1][963] = {{ buttons: 963, lx: 0, ly: 0, cx: 0, cy: 0 }};
        _remoteInputs[1][964] = {{ buttons: 964, lx: 0, ly: 0, cx: 0, cy: 0 }};
        eval({json.dumps(helpers)} + "\\n_backfillCInputsFromJs(mod, 'rollback-init');");
        process.stdout.write(JSON.stringify(calls.map((call) => [call[0], call[1]])));
        """
    )
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    fed = json.loads(result.stdout)
    assert fed == [[1, frame] for frame in range(889, 911)] + [[1, 963]]

    assert "_backfillCInputsFromJs(detMod, 'rollback-init');" in src
    input_guard_start = src.index("const _processInputPacket =")
    input_guard_end = src.index("const recvInput =", input_guard_start)
    input_guard = src[input_guard_start:input_guard_end]
    assert "INPUT_FUTURE_MARGIN_FRAMES" in input_guard
