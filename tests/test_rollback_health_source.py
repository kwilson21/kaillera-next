import re
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
    assert "_requestStrictMenuResends(\n                  bootInputPeers,\n                  missingSlots," in src
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
        "return Math.min(ROLLBACK_MAX_DELAY_FRAMES, Math.max(ROLLBACK_MIN_DELAY_FRAMES, parsed));"
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
    assert "if (phaseWaitSlots.length) {" in src


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
    shutdown_idx = src.index("C-ROLLBACK shutdown on GAMEPLAY→MENU", transition_idx)
    assert transition_idx < schedule_idx < shutdown_idx


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

    assert "if (!_runStepOneFrame('replay')) return;" in src
    assert "if (!_runStepOneFrame('normal')) return;" in src
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
