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

    for marker in ("MENU-LOCKSTEP-WAIT", "RB-INPUT-STALL-TIMEOUT"):
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
    assert "holding strict menu lockstep" in src


def test_strict_menu_resend_cadence_is_per_slot():
    src = LOCKSTEP_JS.read_text()

    assert "_bootStallLastResendAt" not in src
    assert "let _strictMenuResendState = {};" in src
    assert "const resendKey = `${source}:${slot}:${applyFrame}`;" in src
    assert "prev?.key === resendKey && nowMs - prev.lastAt < RESEND_TIMEOUT_MS" in src
    assert "_strictMenuResendState[slot] = { key: resendKey, lastAt: nowMs };" in src
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



def test_rollback_gap_check_ignores_frames_before_c_init():
    # Legacy lockstep deletes consumed remote inputs, so before a deferred
    # init the window edge would look like a lost packet.
    src = LOCKSTEP_JS.read_text()
    idx = src.index("const gapAtEdge =")
    gap_src = src[idx : src.index(";", idx)]
    assert "windowEdge >= _inputFloor(p.slot)" in gap_src
    floor_idx = src.index("const _inputFloor = (slot) =>")
    assert "_rbInitFrame - DELAY_FRAMES" in src[floor_idx : src.index(";", floor_idx)]


def test_resync_settles_the_inputs_before_its_frame():
    # specs/resync_inputs.qnt: after a resync that moves the guest forward,
    # neither page may wait for an input from the frames the guest skipped.
    src = LOCKSTEP_JS.read_text()

    floor_idx = src.index("const _inputFloor = (slot) =>")
    assert "_inputSettledBefore[slot] ?? 0" in src[floor_idx : src.index(";", floor_idx)]

    # Both gap checks use the same floor.
    missing_idx = src.index("const _missingConsumedInputs = () => {")
    missing_src = src[missing_idx : src.index("\n  };\n", missing_idx)]
    assert "Math.max(_inputFloor(p.slot), windowStart)" in missing_src

    # Guest: settles every peer's inputs, makes the ones it skipped that are
    # still to be applied, sends every one of its own for that range (one made
    # earlier may have been dropped by a peer as out of range:
    # specs/resync_inputs.qnt, resync_inputs_only_new), and asks for the
    # peers' it lacks.
    settle_idx = src.index("const _settleInputsAtResync = (mod, frame) => {")
    settle_src = src[settle_idx : src.index("\n  };\n", settle_idx)]
    for snippet in (
        "const from = Math.max(0, frame - DELAY_FRAMES);",
        "_localInputs[f] = KNShared.ZERO_INPUT;",
        "_feedCInput(mod, _playerSlot, f, _localInputs[f]);",
        "_settleInputsBefore(peer.slot, frame);",
        "if (own.length) peer.dc.send(`inputs-settled:${from}`);",
        "for (const f of own) peer.dc.send(KNShared.encodeInput(f, _localInputs[f]).buffer);",
        "peer.dc.send(`resend:${f}`);",
    ):
        assert snippet in settle_src

    # Every peer waits on the moved page's inputs, so each is told the floor;
    # a floor past what this page could be waiting on is refused.
    told_idx = src.index("if (e.data.startsWith('inputs-settled:')) {")
    told_src = src[told_idx : src.index("if (e.data === 'peer-resumed')", told_idx)]
    assert "settled <= _frameNum + INPUT_FUTURE_MARGIN_FRAMES" in told_src
    assert "_inputSettledBefore[peer.slot] = Math.max(_inputSettledBefore[peer.slot] ?? 0, settled);" in told_src

    # A new match starts a new input timeline.
    clear_idx = src.index("const _clearInputsForNewMatch = (reason) => {")
    assert "_inputSettledBefore = {};" in src[clear_idx : src.index("\n  };\n", clear_idx)]
    apply_idx = src.index("const applySyncState = (bytes, frame, fromProactive = false) => {")
    assert "if (timelineAligned) _settleInputsAtResync(gm.Module, frame);" in src[apply_idx:]

    # Host: settles the guest's inputs when the state goes out, on both routes.
    send_idx = src.index("const sendSyncChunks = async (")
    assert "_settleInputsBefore(target.slot, frame);" in src[send_idx:]
    assert "_settleInputsBefore(_peers[targetSid].slot, frame);" in src

    # I2: the floor is per-peer state.
    reset_idx = src.index("const resetPeerState = (slot, reason, opts = {}) => {")
    assert "delete _inputSettledBefore[slot];" in src[reset_idx : src.index("\n  };\n", reset_idx)]


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
    # Nonzero-frame rollback inits (RB-INIT-CATCHUP, RB-INIT-TIMEOUT
    # at f>0) left remote frames past the init
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


def test_local_freeze_is_credited_to_every_deadline_that_drops_a_peer():
    # specs/tick_deadlines.qnt: a page's own freeze must not count against a
    # peer. Three deadlines drop a peer; all three stamps move with the gap.
    src = LOCKSTEP_JS.read_text()
    idx = src.index("const _creditLocalFreeze = () => {")
    credit_src = src[idx : src.index("\n  };\n", idx)]
    for snippet in (
        "_peerLastAdvanceTime[s] = Math.min(now, _peerLastAdvanceTime[s] + gap);",
        "_rbInputStallStartTime = Math.min(now, _rbInputStallStartTime + gap);",
        "_pacingThrottleStartAt = Math.min(now, _pacingThrottleStartAt + gap);",
    ):
        assert snippet in credit_src
    # The credit runs before the pacing deadline is checked in the same tick.
    tick_idx = src.index("const tick = () => {")
    assert src.index("_creditLocalFreeze();", tick_idx) < src.index("PACING-THROTTLE-TIMEOUT f=", tick_idx)


def test_a_page_running_alone_keeps_its_own_input():
    # specs/resync_inputs.qnt (aPageAppliesWhatItSent). kn_pre_tick's pacing
    # gate returns 3 before it stores the page's own input, records what it
    # applied or saves the frame. A frame must not be run on that 3.
    src = LOCKSTEP_JS.read_text()
    c_src = (LOCKSTEP_JS.parents[2] / "build" / "kn_rollback" / "kn_rollback.c").read_text()
    pre_tick = c_src[c_src.index("int kn_pre_tick(") :]
    assert pre_tick.index("return 3; /* ring maintained, skip frame advance */") < pre_tick.index(
        "/* ── Store local input ── */"
    )

    # With nobody left to be ahead of, the advantage is 0, so the gate is open.
    pacing = src[src.index("// If no active pacing peers remain, release any active cap") :]
    pacing = pacing[: pacing.index("_frameAdvRaw = _frameNum - minRemoteFrame;")]
    assert "if (activePacingPeers === 0) _frameAdvRaw = 0;" in pacing

    # And a 3 with every peer a phantom is asked again with pacing off,
    # before anything acts on it.
    tick = src[src.index("let catchingUp = tickMod._kn_pre_tick(") :]
    solo = tick[: tick.index("_refreshRunnerAfterRollbackRestore(tickMod);")]
    assert "if (catchingUp === 3 && getInputPeers().every((p) => _peerPhantom[p.slot])) {" in solo
    rerun = solo[solo.index("if (catchingUp === 3 && getInputPeers()") :]
    rerun = rerun[rerun.index("catchingUp = tickMod._kn_pre_tick(") :]
    assert "-1,\n" in rerun[: rerun.index(");")]
    assert "// Fall through to normal tick instead of returning" not in src


def test_a_settled_input_is_not_fed_to_the_engine():
    # A returning peer's backlog is from frames the resync's state already
    # covers. Fed to the C engine it is compared with what was predicted while
    # this page ran alone, too deep to roll back, and counted as failed
    # rollbacks.
    src = LOCKSTEP_JS.read_text()
    drain = src[src.index("const _drainPendingCInputs = (tickMod) => {") :]
    drain = drain[: drain.index("\n  };\n")]
    skip = drain.index("if (qi.frame < (_inputSettledBefore[qi.slot] ?? 0)) {")
    assert skip < drain.index("tickMod._kn_feed_input(qi.slot, qi.frame,")
    # The host settles the guest's backlog when it schedules the recovery
    # resync: that state is for this frame or a later one. A guest does not:
    # it may be taken back to an earlier frame.
    recovered = src[src.index("} else if (_playerSlot === 0 && peer.slot !== 0 && _syncEnabled) {") :]
    recovered = recovered[: recovered.index("peer-recovery resync: host scheduled full sync")]
    assert "_settleInputsBefore(peer.slot, _frameNum);" in recovered


def test_a_guest_taken_back_reuses_the_inputs_it_already_sent():
    # specs/resync_inputs.qnt (aPageAppliesWhatItSent, the keys it leaves
    # out): a resync that takes the guest back puts it on frames whose inputs
    # it has already made and sent. It must apply those, not read the
    # controller again: the host may hold the first copy, and a second value
    # for the same key replaces a real input in the engine without a rollback.
    src = LOCKSTEP_JS.read_text()
    idx = src.index("const hadLocalInputForFrame = Object.prototype.hasOwnProperty.call(_localInputs, _frameNum);")
    use = src[idx : idx + 1400]
    assert "const localInput = hadLocalInputForFrame\n      ? _localInputs[_frameNum]\n      : _applyExtraInputDelay(" in use
    # A new input is stored once; the cached one is never overwritten.
    assert use.index("if (!hadLocalInputForFrame) {") < use.index("_localInputs[_frameNum] = localInput;")
    # It is sent on every tick of the frame, cached or new, so a host that
    # dropped the first copy as out of range gets it again.
    send = src[idx : src.index("DC health monitor", idx)]
    assert "const peerBuf = KNShared.encodeInput(\n          _frameNum,\n          localInput," in send
    assert send.index("if (!hadLocalInputForFrame) {") < send.index("const peerBuf = KNShared.encodeInput(")
    # No resync path drops the cached inputs: only a new match, a stop, and
    # the fast-forward at lockstep start do (and the declaration).
    assert src.count("_localInputs = {};") == 4
    settle = src[src.index("const _settleInputsAtResync = (mod, frame) => {") :]
    settle = settle[: settle.index("\n  };\n")]
    assert "delete _localInputs" not in settle and "_localInputs = {}" not in settle


def test_a_resync_request_that_is_out_has_a_deadline():
    # specs/resync_flow.qnt: the host drops a request inside its rate limit
    # without answering, so the guest's "a request is out" flag needs a
    # deadline of its own or the guest never asks again.
    src = LOCKSTEP_JS.read_text()
    idx = src.index("const _checkResyncRequestDeadline = () => {")
    check_src = src[idx : src.index("\n  };\n", idx)]
    for snippet in (
        "if (!_resyncRequestInFlight) return;",
        # An answer arriving, held, or waited for at a target has its own deadline.
        "if (_syncExpected > 0 || _pendingResyncState || _syncTargetFrame > 0) return;",
        "if (waitedMs < RESYNC_REQUEST_TIMEOUT_MS) return;",
        "_resyncRequestInFlight = false;",
        "RESYNC-REQUEST-TIMEOUT f=${_frameNum}",
    ):
        assert snippet in check_src
    # Every site that sends a request stamps it: they all go through the one
    # function that sets the flag.
    begin = src[src.index("const _beginResyncRequest = (at = -1) => {") :]
    begin = begin[: begin.index("\n  };\n")]
    assert "_resyncRequestInFlight = true;\n    _resyncRequestSentAt = performance.now();" in begin
    assert src.count("_resyncRequestInFlight = true;") == 1
    # Longer than the host's rate limit plus its capture deadline.
    assert "const RESYNC_REQUEST_TIMEOUT_MS = 8000;" in src
    assert "const _SYNC_REQUEST_COOLDOWN_MS = 5000;" in src
    assert "const SYNC_COORD_TIMEOUT_MS = 3000;" in src
    tick_idx = src.index("const tick = () => {")
    assert "_checkResyncRequestDeadline();" in src[tick_idx : tick_idx + 1200]
    # The page's own freeze does not count against a request that is out.
    credit = src[src.index("const _creditLocalFreeze = () => {") :]
    credit = credit[: credit.index("\n  };\n")]
    assert "if (_resyncRequestInFlight) _resyncRequestSentAt = Math.min(now, _resyncRequestSentAt + gap);" in credit
    assert src.index("_creditLocalFreeze();", tick_idx) < src.index("_checkResyncRequestDeadline();", tick_idx)


def test_every_resync_request_that_is_out_is_numbered():
    # specs/resync_flow.qnt, ANSWERS_CARRY_REQUEST: a request has a number.
    src = LOCKSTEP_JS.read_text()
    begin = src[src.index("const _beginResyncRequest = (at = -1) => {") :]
    begin = begin[: begin.index("\n  };\n")]
    for snippet in (
        "_resyncRequestInFlight = true;",
        "_resyncRequestId++;",
        "_resyncRequestAt = at;",
        "return _resyncRequestId;",
    ):
        assert snippet in begin
    # The flag is set nowhere else, so a request that is out always has one.
    assert src.count("_resyncRequestInFlight = true;") == 1
    assert "let _resyncRequestId = 0;" in src

    # Eight sites ask: one over Socket.IO, seven on a DataChannel (the
    # seventh is a late joiner that lost its channel to the host,
    # specs/late_join_pause.qnt). The two that name a target frame give it to
    # the request, which keeps it after the target's deadline
    # (specs/resync_flow.qnt, askedAt).
    assert src.count("_beginResyncRequest(") == 8
    assert src.count("_beginResyncRequest()") == 6
    assert "const _recoveryRequestId = _beginResyncRequest(_recoveryTarget);" in src
    assert "const _desyncRequestId = _beginResyncRequest(_coordTarget);" in src
    assert "let _resyncRequestAt = -1;" in src
    stop = src[src.index("const stopSync = () => {") :]
    assert "_resyncRequestAt = -1;" in stop[: stop.index("\n  };\n")]
    socket_req = src[src.index("function _requestSocketFullResync(reason) {") :]
    socket_req = socket_req[: socket_req.index("\n  }\n")]
    assert "const requestId = _beginResyncRequest();" in socket_req
    assert "frame: _frameNum,\n        requestId,\n      });" in socket_req

    # On a DataChannel the number goes ahead of the request, which keeps the
    # text a host on an older version matches exactly.
    send = src[src.index("const _sendResyncRequest = (dc, requestId, request) => {") :]
    send = send[: send.index("\n  };\n")]
    assert send.index("dc.send(`sync-request-id:${requestId}`);") < send.index("dc.send(request);")
    assert len(re.findall(r"(?<!const )_sendResyncRequest\(", src)) == 7
    assert len(re.findall(r"_sendResyncRequest\([^;]*'sync-request-full'\);", src)) == 5
    assert len(re.findall(r"_sendResyncRequest\([^;]*`sync-request-full-at:\$\{\w+\}`\);", src)) == 2
    # Sent bare only where no request is marked as out (BOOT-SYNC,
    # INPUT-STALL-RESYNC): those are not numbered.
    assert src.count(".send('sync-request-full');") == 2
    assert ".send(`sync-request-full-at:" not in src

    # A new match starts counting again.
    stop = src[src.index("const stopSync = () => {") :]
    stop = stop[: stop.index("\n  };\n")]
    assert "_resyncRequestId = 0;" in stop
    assert "_hostNumbersAnswers = false;" in stop


def test_only_its_own_answer_ends_a_resync_request():
    # specs/resync_flow.qnt onlyItsAnswerEndsARequest: the answer to a request
    # the guest gave up on must not end the one that is out now.
    src = LOCKSTEP_JS.read_text()
    ends = src[src.index("const _endsResyncRequest = (answerFor) =>") :]
    ends = ends[: ends.index(";\n")]
    # The engine's own rule decides; the proved one (web/src/resync-request.ts)
    # runs beside it on the same inputs (test_the_resync_rules_are_observed).
    assert (
        "_resyncObserve('ends-request', answerFor > 0 ? answerFor === _resyncRequestId : !_hostNumbersAnswers,"
    ) in ends
    assert "rules.endsRequest(answerFor, _resyncRequestId, _hostNumbersAnswers)" in ends

    handle = src[src.index("async function _handleDecodedSyncPayload({") :]
    handle = handle[: handle.index("\n  }\n")]
    assert "answerFor = 0," in handle
    assert "if (_endsResyncRequest(answerFor)) _resyncRequestInFlight = false;" in handle
    assert "const endsRequest = _endsResyncRequest(answerFor);\n      if (endsRequest) _resyncRequestInFlight = false;" in handle
    # The one unconditional clear left there is the delta-base override,
    # which asks again at once.
    assert handle.count("_resyncRequestInFlight = false;") == 4
    assert "_resyncRequestInFlight = false; // allow fresh request" in handle
    assert "_pendingResyncState = { bytes: fullBytes, frame, answerFor };" in handle
    assert "_pendingResyncState = { bytes: decompressed, frame, isRegions: true, answerFor };" in handle

    # Host: the number comes just ahead of the request and is for that
    # request only, answered or rate limited.
    host = src[src.index("if (e.data.startsWith('sync-request-id:')) {") :]
    host = host[: host.index("// JSON messages")]
    assert "if (_playerSlot === 0) syncRequestIdNext = _requestIdFrom(Number(e.data.substring(16)));" in host
    assert host.index("syncRequestIdNext = 0;") < host.index("rate-limited sync-request from")
    assert "forceFull: isFull,\n              requestId," in host
    assert "pushSyncState(remoteSid, false, { requestIds: { [remoteSid]: requestId } });" in host
    assert "requestIds: { [requesterSid]: _requestIdFrom(msg.requestId) }," in src

    # A scheduled capture, its follow-ups and re-queues keep the number; a
    # sync the host schedules for its own reasons has none.
    dispatch = src[src.index("const _dispatchScheduledSyncs = (isConfirmed) => {") :]
    dispatch = dispatch[: dispatch.index("\n  };\n")]
    assert "requestId: r.requestId || 0," in dispatch
    assert "for (const r of due) if (r.requestId) requestIds[r.targetSid] = r.requestId;" in dispatch
    assert "pushSyncState(targetSid, false, { requestIds })" in dispatch
    recovery = src[src.index("push its state to the guest once it is final") :]
    recovery = recovery[: recovery.index("_settleInputsBefore(")]
    assert "requestId" not in recovery

    # The answer carries it: ahead of the header on a DataChannel, as a
    # field over Socket.IO. Never on a proactive push.
    push = src[src.index("const pushSyncState = async (") :]
    push = push[: push.index("const sendSyncChunks = async (")]
    assert "const requestIds = (!isProactive && options.requestIds) || {};" in push
    assert "...(requestIds[targetSid] ? { requestId: requestIds[targetSid] } : {})," in push
    chunks = src[src.index("const sendSyncChunks = async (") :]
    chunks = chunks[: chunks.index("\n  };\n")]
    assert chunks.index("if (answerFor) dc.send(`sync-answer-id:${answerFor}`);") < chunks.index("dc.send(header);")
    # The header an older guest parses is unchanged.
    assert "`sync-start:${frame}:${numChunks}:${isFull ? '1' : '0'}:${isProactive ? '1' : '0'}`" in chunks

    # Guest: the number is for the next state on that channel only.
    sync_dc = src[src.index("const setupSyncDataChannel = (_remoteSid, ch) => {") :]
    sync_dc = sync_dc[: sync_dc.index("// -- Per-peer state cleanup")]
    assert "syncAnswerIdNext = _requestIdFrom(Number(e.data.substring(15)));" in sync_dc
    assert sync_dc.count("_syncAnswerFor = syncAnswerIdNext;\n          syncAnswerIdNext = 0;") == 2
    # A host that has never numbered an answer is on a version that does not:
    # its states end a request as before. Learned from the host only, and
    # forgotten when the host's peer state is reset (I2).
    assert "if (syncAnswerIdNext > 0 && _peers[_remoteSid]?.slot === 0) _hostNumbersAnswers = true;" in sync_dc
    assert "if (answerFor > 0) _hostNumbersAnswers = true;" in src
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "if (slot === 0) _hostNumbersAnswers = false;" in reset


def test_a_late_answer_from_before_the_frame_asked_is_dropped():
    # specs/resync_flow.qnt aLateAnswerDoesNotTakeTheGuestBack (dropLate),
    # with lateAnswerAfterTheTargetDeadlineTest: the frame is the request's,
    # not the live target, so the drop holds after the target's deadline too.
    src = LOCKSTEP_JS.read_text()
    older = src[src.index("const _answersAnOlderRequest = (answerFor) =>") :]
    older = older[: older.index(";\n")]
    assert "_resyncObserve('answers-an-older-request', answerFor > 0 && answerFor !== _resyncRequestId," in older
    assert "rules.answersAnOlderRequest(answerFor, _resyncRequestId)" in older
    late = src[src.index("const _isLateAnswerBeforeFrameAsked = (state) =>") :]
    late = late[: late.index(";\n")]
    assert "_answersAnOlderRequest(state.answerFor || 0)" in late
    assert "_resyncRequestAt > 0 && state.frame < _resyncRequestAt" in late
    assert "!!state &&\n    _resyncObserve(\n      'late-answer-before-frame-asked'," in late
    assert (
        "rules.isLateAnswerBeforeFrameAsked(state.answerFor || 0, state.frame, _resyncRequestId, _resyncRequestAt)"
    ) in late
    assert "_syncTargetFrame" not in late
    tick = src[src.index("const tick = () => {") :]
    drop_at = tick.index("if (_isLateAnswerBeforeFrameAsked(_pendingResyncState)) {")
    dropped = tick[drop_at : tick.index("\n    }\n", drop_at)]
    assert "SYNC-LATE-ANSWER-DROPPED f=${_frameNum}" in dropped
    assert "_pendingResyncState = null;" in dropped
    # The wait goes on: the target and its deadline are left as they are.
    assert "_syncTargetFrame = " not in dropped and "_syncTargetDeadlineAt" not in dropped
    # After the target's deadline gives the target up, before either branch
    # holds or applies anything.
    assert tick.index("COORD-SYNC-TIMEOUT target=") < drop_at
    assert drop_at < tick.index("const syncApplyBlocked = _pendingResyncState ? _replayBlocksSyncApply() : false;")
    assert drop_at < tick.index("if (_frameNum >= _syncTargetFrame) {")
    assert drop_at < tick.index("} else if (_pendingResyncState && !syncApplyBlocked) {")
    # The stale-state check stays.
    assert "explicit sync discarded: stale frame=${frame} <= lastApplied=${_lastAppliedSyncHostFrame}" in src


def test_a_late_answer_does_not_replace_the_awaited_one():
    # specs/resync_flow.qnt theAwaitedAnswerIsNotLost.
    src = LOCKSTEP_JS.read_text()
    keep = src[src.index("const _keepsAwaitedAnswer = (answerFor, frame) => {") :]
    keep = keep[: keep.index("\n  };\n")]
    assert (
        "const keeps = _resyncObserve(\n      'keeps-awaited-answer',\n"
        "      _answersAnOlderRequest(answerFor) && _pendingResyncState?.answerFor === _resyncRequestId,"
    ) in keep
    assert "rules.keepsAwaitedAnswer(answerFor, _resyncRequestId, _pendingResyncState?.answerFor ?? -1)" in keep
    assert keep.index("const keeps = ") < keep.index("if (!keeps) return false;") < keep.index("SYNC-LATE-ANSWER-IGNORED")
    assert "SYNC-LATE-ANSWER-IGNORED" in keep
    payload = src[src.index("async function _handleDecodedSyncPayload({") :]
    payload = payload[: payload.index("const handleSyncChunksComplete = async () => {")]
    for pending in (
        "_pendingResyncState = { bytes: decompressed, frame, isRegions: true, answerFor };",
        "_pendingResyncState = { bytes: fullBytes, frame, answerFor };",
    ):
        at = payload.index(pending)
        assert payload.rindex("if (_keepsAwaitedAnswer(answerFor, frame)) return;", 0, at) > at - 200


def test_a_stale_late_answer_keeps_the_lifecycle_guard():
    # The guard belongs to the request that is out; the answer to an older
    # request does not end it. The guard keeps its own 15 s timeout (I1).
    src = LOCKSTEP_JS.read_text()
    payload = src[src.index("async function _handleDecodedSyncPayload({") :]
    payload = payload[: payload.index("const handleSyncChunksComplete = async () => {")]
    assert "if (!_answersAnOlderRequest(answerFor)) _clearLifecycleResyncGuard('regions sync stale');" in payload
    assert "if (!_answersAnOlderRequest(answerFor)) _clearLifecycleResyncGuard('explicit sync stale');" in payload
    assert payload.count("_clearLifecycleResyncGuard(") == 2
    assert "_clearLifecycleResyncGuard('lifecycle resync guard timeout');" in src


def test_the_resync_rules_are_observed():
    # Stage 5, observing: the proved functions of web/src/resync-request.ts
    # run beside the engine's rules and a difference is a resync-disagree
    # client event. The engine's value is always the one returned, and with
    # no KNCore nothing else runs.
    src = LOCKSTEP_JS.read_text()
    observe = src[src.index("const _resyncObserve = (what, engineValue, proved) => {") :]
    observe = observe[: observe.index("\n  };\n")]
    assert "const rules = window.KNCore?.resyncRequest;\n    if (!rules) return engineValue;" in observe
    assert "_resyncObserver?.compare(what, engineValue, proved(rules));" in observe
    assert observe.count("proved(") == 1
    assert observe.rstrip().endswith("return engineValue;")
    assert "window.KNEvent?.('resync-disagree', message, { old, next });" in observe
    assert "RESYNC-DISAGREE" in observe
    # Each rule is compared under its own name.
    for what, name in (
        ("ends-request", "endsRequest"),
        ("answers-an-older-request", "answersAnOlderRequest"),
        ("late-answer-before-frame-asked", "isLateAnswerBeforeFrameAsked"),
        ("keeps-awaited-answer", "keepsAwaitedAnswer"),
        ("late-join-lost-host", "lateJoinLostHostStep"),
    ):
        assert f"_resyncObserve('{what}'," in src or f"_resyncObserve(\n      '{what}'," in src, what
        assert f"rules.{name}(" in src, name


def test_a_chunk_timeout_is_scoped_to_the_request_its_transfer_answers():
    src = LOCKSTEP_JS.read_text()
    start = src.index("if (e.data.startsWith('sync-start:')) {")
    header = src[start : src.index("if (e.data.startsWith('sync-regions-start:')) {", start)]
    assert "const transferAnswers = _syncAnswerFor;" in header
    older = header.index("if (_answersAnOlderRequest(transferAnswers)) {")
    branch = header[older : header.index("\n            }\n", older)]
    assert "return;" in branch
    assert "_resyncRequestInFlight" not in branch and "_requestSocketFullResync" not in branch
    assert older < header.index("_resyncRequestInFlight = false;")
    assert older < header.index("_requestSocketFullResync('sync-chunk-timeout');")
