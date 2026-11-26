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

    for marker in ("RB-INPUT-STALL-TIMEOUT", "LOCKSTEP-WAIT-TIMEOUT"):
        assert marker in src
        assert marker in doc

    assert "stalledMs >= MAX_STALL_MS + RESEND_TIMEOUT_MS" in src
    assert "markPeerPhantomForStallTimeout" in src


def test_the_old_js_lockstep_path_is_gone():
    """Every frame runs on the C engine (specs/engine_start.qnt), so the JS
    path that stepped a frame without it is deleted: its menu lockstep, the
    inputs it made up, its fast-forward on a tab's return and its pacing."""
    src = LOCKSTEP_JS.read_text()
    play_src = (ROOT / "web/static/play.js").read_text()
    html_src = (ROOT / "web/play.html").read_text()

    for gone in (
        "MENU-LOCKSTEP",
        "strictInputLockstep",
        "kn-menu-lockstep",
        "INPUT-GAP-FILL",
        "INPUT-FABRICATE",
        "INPUT-STALL hard-timeout",
        "INPUT-STALL-RESYNC",
        "RAPID_FABRICATION_THRESHOLD",
        "_consecutiveFabrications",
        "skip:legacy-",
        "advance:legacy",
        "_runStepOneFrame('fallback')",
        "resync wait timeout",
        "fast-forward: ",
        "PACING-SAFETY-FREEZE",
        "fpu-trace",
    ):
        assert gone not in src, gone
    # Nothing after the C branch: it always returns.
    tick = src[src.index("  const tick = () => {") :]
    tick = tick[: tick.index("\n  };\n")]
    assert tick.rstrip().endswith("_handleCoreFatal('c-rollback', eCR);\n        return;\n      }\n    }")
    assert "showMenuLockstepWait" not in play_src
    assert "menu-wait-overlay" not in html_src


def test_strict_menu_resend_cadence_is_per_slot():
    src = LOCKSTEP_JS.read_text()

    assert "_bootStallLastResendAt" not in src
    assert "let _strictMenuResendState = {};" in src
    assert "const resendKey = `${source}:${slot}:${applyFrame}`;" in src
    assert "prev?.key === resendKey && nowMs - prev.lastAt < RESEND_TIMEOUT_MS" in src
    assert "_strictMenuResendState[slot] = { key: resendKey, lastAt: nowMs };" in src
    assert "_requestStrictMenuResends(lockstepPeers, resendSlots, applyFrame, nowLockstep, 'lockstep')" in src


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
    # The host's delay as it comes: 0 stays 0 (a solo match and a friend who
    # joins it), anything else is clamped as the host's own was.
    assert "return n === 0 ? 0 : clampRollbackDelay(n);" in src
    assert "const hostDelay = _hostDelayFrom(e.data.split(':')[1]);" in src
    assert "if (hasRollback && !soloMode) ownDelay = clampRollbackDelay(ownDelay);" in src
    assert "const lateJoinDelay = _hostDelayFrom(msg.effectiveDelay);" in src


def test_every_page_arms_the_c_engine_solo_included():
    """specs/engine_start.qnt everyFrameRunsOnTheCEngine: a delay of 0 arms too."""
    src = LOCKSTEP_JS.read_text()

    assert "const soloMode = playerPeerSids.length === 0;" in src
    assert "if (hasRollback && !soloMode) ownDelay = clampRollbackDelay(ownDelay);" in src
    assert "DELAY_FRAMES > 0" not in src[src.index("const tryInitRollback = () => {") :][:4000]
    assert "C-ROLLBACK disabled for zero-delay solo play" not in src
    # A core without the C engine stops at the start instead of running unarmed.
    assert "_stopAtStart('core', { missing: missingExports });" in src
    # A page that has not armed holds; it never steps on another path.
    hold_idx = src.index("_markTickReturn('skip:not-armed');")
    c_branch_idx = src.index("// ── C-level rollback path")
    assert hold_idx < c_branch_idx


def test_only_the_host_sets_the_start():
    """A waiting guest arms with `rb-delay:` and stops on an `rb-init-frame:`
    other than its own frame, so another player's would let it stop any
    guest's start: both are the host's word only, as rb-transport is."""
    src = LOCKSTEP_JS.read_text()

    for kind, sets in (("rb-delay", "window._rbHostDelay = hostDelay;"), ("rb-init-frame", "window._rbHostInitFrame = hostInitFrame;")):
        handler = src[src.index(f"if (e.data.startsWith('{kind}:')) {{") :]
        handler = handler[: handler.index("\n        }\n")]
        guard = handler.index("if (_peers[remoteSid]?.slot !== 0) {")
        assert guard < handler.index(sets), kind
        assert "return;" in handler[guard : handler.index(sets)], kind


def test_a_trap_while_arming_ends_the_match():
    """Arming clears the wait before kn_rollback_init runs; a trap there left
    the page neither armed nor waiting, held at skip:not-armed with no message
    and no deadline (I1). It ends the match as any core trap does."""
    src = LOCKSTEP_JS.read_text()

    guest = src[src.index("const _guestStart = (source) => {") :]
    guest = guest[: guest.index("\n  };\n")]
    arm = guest.index("window._rbDoInit(")
    assert guest.rindex("try {", 0, arm) < arm < guest.index("_handleCoreFatal('rollback-init', e);")
    host = src[src.index("const tryInitRollback = () => {") :]
    host = host[: host.index("\n      };\n")]
    init = host.index("doRollbackInit(DELAY_FRAMES);")
    assert host.rindex("try {", 0, init) < init < host.index("_handleCoreFatal('rollback-init', e);")
    # Not reached; if it were, it ends the match rather than holding.
    hold = src[src.index("_markTickReturn('skip:not-armed');") :][:200]
    assert "_handleCoreFatal('not-armed'" in hold


def test_session_log_interval_covers_failed_starts_and_is_released_on_stop():
    src = LOCKSTEP_JS.read_text()
    start = src.split("const startLockstep = () => {", 1)[1].split("\n  };\n", 1)[0]
    stop = src.split("const stop = () => {", 1)[1].split("\n  };\n", 1)[0]
    # A second registration overwrites the only handle stop can cancel.
    assert src.count("setInterval(_periodicSyncLog,") == 1
    assert "setInterval(_flushSyncLog," not in src
    assert start.index("_flushInterval = setInterval(_periodicSyncLog,") < start.index("_stopAtStart('core'")
    assert not re.search(r"setTimeout\(\s*(?:\(\)\s*=>\s*)?_(?:periodicSyncLog|flushSyncLog)\b", start)
    assert "clearInterval(_flushInterval);" in stop


def test_a_stopped_start_keeps_its_message():
    """A later start on a page whose start stopped (a late join) showed "The
    emulator crashed" in place of why it stopped."""
    src = LOCKSTEP_JS.read_text()

    stop = src[src.index("const _stopAtStart = (reason, detail = {}) => {") :]
    stop = stop[: stop.index("\n  };\n")]
    assert "_coreFatalMessage = message;" in stop
    start = src[src.index("const startLockstep = () => {") :][:600]
    assert "_notifyCoreFatal(_coreFatalMessage);" in start


def test_a_joiner_stops_on_a_host_whose_delay_of_0_is_the_old_path():
    """A host from before every page armed (kept through a deploy, a solo match
    at delay 0 on the old JS path) does not say cEngine; a joiner armed on the
    C engine beside it would run another engine. It stops and says so."""
    src = LOCKSTEP_JS.read_text()

    send = src[src.index("async function sendLateJoinState(remoteSid) {") :]
    assert "cEngine: _useCRollback," in send[: send.index("inputBridge")]
    load = src[src.index("const lateJoinDelay = _hostDelayFrom(msg.effectiveDelay);") :][:900]
    gate = load.index("if (lateJoinDelay === 0 && msg.cEngine !== true) {")
    assert gate < load.index("_stopAtStart('old-host'") < load.index("window._rbHostDelay = lateJoinDelay;")
    assert "'old-host':" in src


def test_the_first_player_into_a_match_at_0_moves_it_to_a_match_delay():
    """specs/engine_start.qnt, REARM_AT_JOIN: the host arms again at the frame
    of the state it sends, with KNCore.delayAtJoin's delay, before the bridge
    is read, and its own inputs for H..H+delay-1 are neutral (fresh objects,
    so the bridge carries them to the joiner as made)."""
    src = LOCKSTEP_JS.read_text()

    send = src[src.index("async function sendLateJoinState(remoteSid) {") :]
    capture = send.index("const capturedFrame = _frameNum;")
    rearm = send.index("_rearmForFirstPlayer(remoteSid, capturedFrame);")
    bridge = send.index("_snapshotLateJoinBridgeSources(remoteSid)")
    assert capture < rearm < bridge
    assert "if (DELAY_FRAMES === 0 && _useCRollback) {" in send[capture:rearm]

    fn = src[src.index("const _rearmForFirstPlayer = (remoteSid, frame) => {") :]
    fn = fn[: fn.index("\n  };\n")]
    assert "window.KNCore.delayAtJoin(DELAY_FRAMES, own, offered, clampRollbackDelay(DEFAULT_DELAY_FRAMES))" in fn
    zeros = fn.index("_localInputs[f] = { ...KNShared.ZERO_INPUT };")
    assert zeros < fn.index("DELAY_FRAMES = delay;") < fn.index("window._rbDoInit(delay, frame, 'first player joined');")
    # Only alone and with no replay running.
    assert "if (others.length || replayDepth > 0 || !window._rbDoInit) {" in fn

    # The joiner offers the delay it measured to the host.
    request = src[src.index("const _sendLateJoinRequest = () => {") :][:700]
    assert "_delayFromRttSamples(samples, _delayIsLockstep())" in request
    assert "_lateJoinOfferedDelay.set(" in src
    # I2: the offer is per joiner and goes with the rest of its state.
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "_lateJoinOfferedDelay.delete(opts.sid);" in reset


def test_the_arm_log_says_where_the_frame_came_from():
    src = LOCKSTEP_JS.read_text()

    assert "(host-authoritative)" not in src
    assert "host start frame (${source})" in src
    assert "own frame at the deadline (${source})" in src


def test_the_c_engine_sends_the_funnel_milestone():
    """milestone_reached (the admin timeline's "actually played" mark) was sent
    only from the old path's tail of tick(); every frame now runs on the C
    engine, whose branch always returns, so it is sent there."""
    src = LOCKSTEP_JS.read_text()

    assert src.count("KNEvent('milestone_reached'") == 1
    milestone_idx = src.index("KNEvent('milestone_reached'")
    c_branch_idx = src.index("// ── C-level rollback path")
    c_end_idx = src.index("_markTickReturn('end:c-rollback');")
    assert c_branch_idx < milestone_idx < c_end_idx



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
    missing_idx = src.index("const _missingConsumedInputs = (peers = getInputPeers()) => {")
    missing_src = src[missing_idx : src.index("\n  };\n", missing_idx)]
    assert "Math.max(_inputFloor(p.slot), windowStart)" in missing_src

    # Guest: settles every peer's inputs, makes the ones it skipped that are
    # still to be applied, sends every one of its own for that range (one made
    # earlier may have been dropped by a peer as out of range:
    # specs/resync_inputs.qnt, resync_inputs_only_new), and asks for the
    # peers' it lacks.
    settle_idx = src.index(
        "const _settleInputsAtResync = (mod, frame, recoveryId = 0) => {"
    )
    settle_src = src[settle_idx : src.index("\n  };\n", settle_idx)]
    for snippet in (
        "const from = Math.max(0, frame - DELAY_FRAMES);",
        "_localInputs[f] = KNShared.ZERO_INPUT;",
        "_feedCInput(mod, _playerSlot, f, _localInputs[f]);",
        "_settleInputsBefore(peer.slot, frame);",
        "peer.dc.send(`inputs-settled:${from}`);",
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
    assert "_resetInputMaps();" in src[clear_idx : src.index("\n  };\n", clear_idx)]
    table_idx = src.index("const _slotInputMaps = () => [")
    assert "    _inputSettledBefore,\n" in src[table_idx : src.index("];", table_idx)]
    apply_idx = src.index(
        "const applySyncState = ("
    )
    assert re.search(
        r"if \(timelineAligned\) \{\s*_lastAppliedRecoveryId = Math.max\(_lastAppliedRecoveryId, recoveryId\);\s*_settleInputsAtResync\(gm.Module, frame, recoveryId\);",
        src[apply_idx:],
    )

    # Host: settles the guest's inputs when the state goes out, on both routes:
    # over a DataChannel once every chunk is handed over (the per-guest
    # transfer body, _sendSyncChunksTo), over Socket.IO once it is emitted.
    send_idx = src.index("const _sendSyncChunksTo = async (")
    assert "_settleInputsBefore(target.slot, frame);" in src[send_idx:]
    assert "_settleInputsBefore(_peers[targetSid].slot, frame);" in src

    # I2: the floor is per-peer state.
    reset_idx = src.index("const resetPeerState = (slot, reason, opts = {}) => {")
    assert "_clearSlotInputState(slot);" in src[reset_idx : src.index("\n  };\n", reset_idx)]
    table_idx = src.index("const _slotInputMaps = () => [")
    assert "    _inputSettledBefore,\n" in src[table_idx : src.index("];", table_idx)]


def test_a_stalled_page_asks_for_the_inputs_it_dropped():
    # specs/resync_inputs.qnt, ASK_FOR_MISSING: a page that dropped a peer's
    # inputs as too far ahead remembers that the peer made them, and while
    # the rollback input stall waits on them it asks for them again; the
    # frames are KNCore.framesToAskFor (web/src/input-ask.ts, proved).
    src = LOCKSTEP_JS.read_text()

    oor_idx = src.index("`INPUT-OOR slot=")
    oor_src = src[oor_idx : src.index("return false;", oor_idx)]
    assert "_inputDroppedAheadUpTo[peer.slot] = Math.max(" in oor_src

    ask_idx = src.index("const _askForMissingInputs = (peer, applyFrame, windowEdge) => {")
    ask_src = src[ask_idx : src.index("\n  };\n", ask_idx)]
    for snippet in (
        "const from = Math.max(0, windowEdge, _inputFloor(slot));",
        "_inputDroppedAheadUpTo[slot] ?? -1",
        "window.KNCore.framesToAskFor(have, from, applyFrame, peerHas, RB_INPUT_ASK_MAX)",
        "now - (askedAt[f] ?? -Infinity) < RB_INPUT_ASK_EVERY_MS",
        "peer.dc.send(`resend:${f}`);",
    ):
        assert snippet in ask_src

    # It asks from inside the stall, before the stall returns.
    stall_idx = src.index("// Too far ahead — stall to let peer catch up")
    stall_src = src[stall_idx : src.index("_markTickReturn('skip:rb-input-stall');", stall_idx)]
    assert "_askForMissingInputs(p, rbApplyFrame, windowEdge);" in stall_src

    # I2: both tables are per-peer state, and go with every input timeline.
    reset_idx = src.index("const resetPeerState = (slot, reason, opts = {}) => {")
    reset_src = src[reset_idx : src.index("\n  };\n", reset_idx)]
    assert "_clearSlotInputState(slot);" in reset_src
    table_idx = src.index("const _slotInputMaps = () => [")
    table_src = src[table_idx : src.index("];", table_idx)]
    assert "    _inputDroppedAheadUpTo,\n" in table_src
    assert "    _inputAskedAt,\n" in table_src
    clear_idx = src.index("const _clearInputsForNewMatch = (reason) => {")
    clear_src = src[clear_idx : src.index("\n  };\n", clear_idx)]
    assert "_resetInputMaps();" in clear_src
    maps_idx = src.index("const _resetInputMaps = () => {")
    maps_src = src[maps_idx : src.index("\n  };\n", maps_idx)]
    assert "for (const map of _slotInputMaps())" in maps_src


def test_pending_rollback_init_keeps_reliable_input_stream_alive():
    src = LOCKSTEP_JS.read_text()

    helper_idx = src.index("const _sendPendingRollbackInitInput = () => {")
    helper_src = src[helper_idx : src.index("const startLockstep = () => {", helper_idx)]
    for snippet in (
        "const activePeers = getActivePeers();",
        "const hadLocalInputForFrame = Object.prototype.hasOwnProperty.call(_localInputs, _frameNum);",
        "_localInputs[_frameNum] = localInput;",
        "_auditRecordLocal(_frameNum, localInput);",
        "const ackFrame = peer.lastFrameFromPeer ?? -1;",
        "peer.dc.send(KNShared.encodeInput(_frameNum, localInput, ackFrame, null).buffer);",
        "RB-PENDING-INIT input f=${_frameNum}",
    ):
        assert snippet in helper_src

    pending_idx = src.index("if (window._rbPendingInit) {")
    pending_src = src[pending_idx : src.index("if (_syncTargetFrame > 0", pending_idx)]
    send_idx = pending_src.index("_sendPendingRollbackInitInput();")
    decide_idx = pending_src.index("if (!_guestStart('tick')) {")
    assert send_idx < decide_idx


def test_a_guest_arms_on_the_rule_and_never_with_its_own_delay():
    """specs/engine_start.qnt: the guest arms with the host's delay at its own
    frame, or stops and says so; there is no catch-up and no own-delay fallback."""
    src = LOCKSTEP_JS.read_text()

    guest_idx = src.index("const _guestStart = (source) => {")
    guest_src = src[guest_idx : src.index("const startLockstep = () => {", guest_idx)]
    assert "window.KNCore.guestStartStep(heardDelay, heardStart, _frameNum, waitedMs, RB_INIT_TIMEOUT_MS)" in guest_src
    assert "window._rbDoInit(\n          heardDelay,\n          _frameNum," in guest_src
    assert "_stopAtStart('no-host'" in guest_src and "_stopAtStart('start-frame'" in guest_src
    for gone in ("_rbPendingInitCatchup", "RB-INIT-CATCHUP", "RB-INIT-TIMEOUT", "_rbFallbackDelay"):
        assert gone not in src

    # The host sends its delay and start frame together, when it arms and on
    # every channel to a guest that opens.
    send_idx = src.index("const _sendHostStart = (dc) => {")
    send_src = src[send_idx : src.index("};", send_idx)]
    assert send_src.index("rb-delay:") < send_src.index("rb-init-frame:")
    assert "_sendHostStart(p.dc);" in src  # when it arms
    assert "_sendHostStart(ch);" in src  # on every channel that opens


def test_a_rollback_never_reaches_back_before_a_players_first_input():
    """A late input rolls back only a frame its player's input was predicted
    for, and a slot is predicted only once its first input has been fed. So
    no rollback targets a frame from before a player joined, and a page that
    played alone needs its ring only from the join on (specs/engine_start.qnt:
    solo play runs on the C engine; skipping its saves is a follow-up that
    relies on this)."""
    c_src = ROLLBACK_C.read_text()
    feed = c_src[c_src.index("int kn_feed_input(") : c_src.index("int kn_pre_tick(")]
    assert "slot_active[slot] = 1;" in feed
    # The flag is read with the frame it was set for (specs/stale_prediction_flag.qnt).
    assert "if (rb_is_prediction_of(slot, idx, frame)) {" in feed
    pre_tick = c_src[c_src.index("int kn_pre_tick(") :]
    assert "if (!rb.slot_active[s]) continue;" in pre_tick


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
    # The old path's own frame step went with that path.
    assert "_runStepOneFrame('fallback')" not in src


def test_asyncify_remove_preserves_normal_frame_fiber_stack():
    build_src = (ROOT / "build/build.sh").read_text()
    match = re.search(r"KN_ASYNCIFY_REMOVE='\[(.*?)\]'", build_src)
    assert match, "KN_ASYNCIFY_REMOVE assignment not found"
    removed = set(re.findall(r'"([^"]+)"', match.group(1)))

    assert {"retro_serialize", "retro_unserialize", "kn_pre_tick", "kn_post_tick"} <= removed
    assert not {"retro_run", "runloop_iterate", "core_run", "emscripten_mainloop"} & removed
    assert "loading-frame fiber switch into a WASM" in build_src


def test_input_logs_use_cheap_input_formatting():
    src = LOCKSTEP_JS.read_text()

    assert "const _formatInputBrief = (input) =>" in src
    assert "`local=${_formatInputBrief(localInput)}`," in src
    assert "`input=${_formatInputBrief(preTickLocalInput)}`," in src


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
    roster_start = src.index("  let _lastInputRoster =")
    roster = src[roster_start : src.index("  // The oldest input", roster_start)]
    script = textwrap.dedent(
        f"""
        const calls = [];
        const _rbRollbackMax = 12;
        const DELAY_FRAMES = 3;
        const _frameNum = 900;
        const _playerSlot = 0;
        const RB_WORKER_COPROC = false;
        const _localInputs = {{}};
        const _remoteInputs = {{ 1: {{}} }};
        const _syncLog = () => {{}};
        const _awaitFirstInputAfterReset = {{}};
        const KNShared = {{ ZERO_INPUT: Object.freeze({{buttons:0,lx:0,ly:0,cx:0,cy:0}}) }};
        const mod = {{ _kn_feed_input: (...args) => calls.push(args) }};
        // The admission floor (web/src/removed-input.ts admissionFloor): no
        // slot here is cut, so a slot not admitted again takes any input.
        const window = {{ KNCore: {{ removedInput: {{
          admissionFloor: (first, cut) => (first >= 0 ? first : cut >= 0 ? Number.MAX_SAFE_INTEGER : 0),
        }} }} }};
        for (let frame = 890; frame <= 910; frame++) {{
          _remoteInputs[1][frame] = {{ buttons: frame, lx: 0, ly: 0, cx: 0, cy: 0 }};
        }}
        _remoteInputs[1][889] = KNShared.ZERO_INPUT;
        _remoteInputs[1][920] = KNShared.ZERO_INPUT;
        _remoteInputs[1][963] = {{ buttons: 963, lx: 0, ly: 0, cx: 0, cy: 0 }};
        _remoteInputs[1][964] = {{ buttons: 964, lx: 0, ly: 0, cx: 0, cy: 0 }};
        eval({json.dumps(helpers)} + {json.dumps(roster)} + `
          _backfillCInputsFromJs(mod, 'rollback-init');
          const ordinary = calls.splice(0);
          _recordHostInputRoster(894, [0, 2]);
          _recordHostInputRoster(900, [0, 1, 2]);
          _backfillCInputsFromJs(mod, 'rollback-init');
          process.stdout.write(JSON.stringify([ordinary, calls]));
        `);
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
    ordinary, admitted = json.loads(result.stdout)
    assert [call[:2] for call in ordinary] == [[1, frame] for frame in range(889, 911)] + [[1, 963]]
    assert admitted == (
        [[1, frame, 0, 0, 0, 0, 0] for frame in range(894, 900)]
        + [[1, frame, frame, 0, 0, 0, 0] for frame in range(900, 911)]
        + [[1, 963, 963, 0, 0, 0, 0]]
    )

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
    skip = drain.index("if (qi.frame < Math.max(_inputSettledBefore[qi.slot] ?? 0, _admissionInputFloor(qi.slot))) {")
    assert skip < drain.index("tickMod._kn_feed_input(qi.slot, qi.frame,")
    # The host settles the guest's backlog when it schedules the recovery
    # resync: that state is for this frame or a later one. A guest does not:
    # it may be taken back to an earlier frame.
    recovered = src[src.index("const _scheduleRecoveredHostGuest =") :]
    recovered = recovered[: recovered.index("peer-recovery resync: host scheduled full sync")]
    assert "_settleInputsBefore(peer.slot, _frameNum);" in recovered


def test_a_recovery_resyncs_every_guest():
    # specs/recovery_bystander.qnt, hostAndBystanderAgree (recovery_bystander_fixed):
    # what a page does on PEER-RECOVERED is the proved rule
    # (web/src/recovery-resync.ts). The host resyncs every guest, not only the
    # one it heard again (onlyTheHostDroppedItTest), with one frame and one
    # deadline so the requests fall due together; a guest that hears another
    # guest again asks the host (bystanderStillPhantomTest).
    src = LOCKSTEP_JS.read_text()
    recovered = src[src.index("_syncLog(`PEER-RECOVERED slot=${peer.slot}") :]
    recovered = recovered[: recovered.index("    return true;\n  };\n")]
    assert (
        "window.KNCore.recoveryResync.recoveryStep(\n"
        "          _playerSlot === 0,\n"
        "          peer.slot === 0,\n"
        "          _syncEnabled,\n"
        "          _resyncRequestInFlight,\n"
        "        );"
    ) in recovered
    for step in ("'ask-at'", "'resync-guests'", "'ask'"):
        assert f"recoveryStep === {step}" in recovered
    assert "_deferredPhantomRecovery.set(remoteSid," in recovered
    assert "_scheduleRecoveredHostGuest(remoteSid, peer)" in recovered
    host = src[src.index("const _scheduleRecoveredHostGuest =") :]
    host = host[: host.index("const _serviceReconnectHostAnswers =")]
    assert "[remoteSid, ..._syncTargetsFor(null).map((t) => t.sid)]" in host
    assert "_scheduledSyncRequests.push({ targetFrame: _frameNum, targetSid: sid, deadlineAt });" in host
    assert host.count("deadlineAt") == 2
    ask = recovered[recovered.index("} else if (recoveryStep === 'ask') {") :]
    assert "Object.values(_peers).find((p) => p.slot === 0)?.dc" in ask
    assert "_sendResyncRequest(hostDc, requestId, 'sync-request-full');" in ask
    # No channel to the host, or the send failed: over the socket, as an owed
    # resync asked again is (the phantom flag is cleared, nothing asks later).
    assert "if (!asked && _requestSocketFullResync('peer-recovery')) {" in ask


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
    assert "const sentPrimary = _sendFrameInput(\n        peer,\n        inputDc,\n        localInput," in send
    assert send.index("if (!hadLocalInputForFrame) {") < send.index("const sentPrimary = _sendFrameInput(")
    # No resync path drops the cached inputs: only a new match and a stop do
    # (and the declaration).
    assert src.count("_localInputs = {};") == 3
    settle = src[
        src.index("const _settleInputsAtResync = (mod, frame, recoveryId = 0) => {") :
    ]
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
        "const answerComing = _syncExpected > 0 || !!_pendingResyncState || _syncTargetFrame > 0;",
        # An answer being decoded holds it off, for a bounded time
        # (specs/resync_reask.qnt, theDecodedAnswerIsNotCut): the proved
        # resyncDeadlineStep waits on these (tests/ts/resync-request.test.ts).
        "const decoding = _syncDecodes > 0;",
        "SYNC_DECODE_GRACE_MS,",
        "RESYNC_REQUEST_TIMEOUT_MS,",
        "if (step === 'noRequest' || step === 'wait') return;",
        "_resyncRequestInFlight = false;",
        "RESYNC-REQUEST-TIMEOUT f=${_frameNum}",
    ):
        assert snippet in check_src
    # The waits come before the request is let go.
    assert check_src.index("if (step === 'noRequest' || step === 'wait') return;") < check_src.index(
        "_resyncRequestInFlight = false;"
    )
    # Every site that sends a request stamps it: they all go through the one
    # function that sets the flag.
    begin = src[src.index("const _beginResyncRequest = (at = -1, again = false) => {") :]
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


def test_a_state_behind_the_guest_is_caught_up_from_not_rewound_to():
    # specs/resync_flow.qnt CATCH_UP, theGuestIsNeverRewound: a host state from
    # before the guest's frame is applied and the frames up to the guest's run
    # again at once; one further back than MAX_CATCH_UP_FRAMES is not applied.
    src = LOCKSTEP_JS.read_text()
    assert re.search(r"const MAX_CATCH_UP_FRAMES = \d+;", src)

    # The decision is the proved one, in both places it is taken.
    assert src.count("window.KNCore.catchUp.catchUpStep(") == 2
    tick_refuse = src[src.index("SYNC-LATE-ANSWER-DROPPED f=${_frameNum}") :]
    tick_refuse = tick_refuse[: tick_refuse.index("const atSyncBoundary =")]
    assert (
        "window.KNCore.catchUp.catchUpStep(_pendingResyncState.frame, _frameNum, MAX_CATCH_UP_FRAMES) === 'refuse'"
        in tick_refuse
    )
    assert "SYNC-TOO-OLD-DROPPED" in tick_refuse
    assert "_pendingResyncState = null;" in tick_refuse
    # The request it answered has ended: an owed resync is asked for again, or
    # given up, as the proved tooOldStep says.
    assert "window.KNCore.catchUp.tooOldStep(" in tick_refuse
    assert "if (then === 'askAgain') _askAgainForOwedResync();" in tick_refuse
    assert "else if (then === 'stopAsking') _stopAskingForOwedResync(" in tick_refuse

    apply = src[
        src.index(
            "const applySyncState = ("
        ) :
    ]
    apply = apply[: apply.index("\n  };\n")]
    assert "const frameBeforeApply = _frameNum;" in apply
    catch = apply.index("window.KNCore.catchUp.catchUpStep(frame, frameBeforeApply, MAX_CATCH_UP_FRAMES) === 'catchUp'")
    # Inputs are settled at the state's frame first, and purged only after the
    # catch-up's first slice has run on them.
    assert apply.index("_settleInputsAtResync(gm.Module, frame, recoveryId);") < catch
    assert catch < apply.index("_startCatchUp(gm.Module, frame, frameBeforeApply);")
    assert apply.index("_startCatchUp(gm.Module, frame, frameBeforeApply);") < apply.index(
        "for (const [slot, inputs] of Object.entries(_remoteInputs)) {"
    )

    start = src[src.index("const _startCatchUp = (mod, fromFrame, toFrame) => {") :]
    start = start[: start.index("\n  };\n")]
    # Not over a rollback in flight; unseen and unheard; the first slice at once.
    assert "_kn_peek_pending_rollback" in start and "_kn_get_replay_depth" in start
    for flag in ("_setReplayFullHeadless", "_setReplayRdpSkip", "_setReplayAudioOutputSkip"):
        assert f"{flag}(mod, true, 'catch-up');" in start
    assert start.rstrip().endswith("_catchUpSlice(mod);")
    # The detector's own digests for the frames run again are dropped.
    assert "window.KNDesync?.forgetFrom(fromFrame);" in start
    end = src[src.index("const _endCatchUp = (mod, stoppedAt = '') => {") :]
    end = end[: end.index("\n  };\n")]
    for flag in ("_setReplayFullHeadless", "_setReplayRdpSkip", "_setReplayAudioOutputSkip"):
        assert f"{flag}(mod, false, 'catch-up');" in end
    assert "SYNC-CATCH-UP from=" in end and "_catchUpTo = -1;" in end

    sl = src[src.index("const _catchUpSlice = (mod) => {") :]
    sl = sl[: sl.index("\n  };\n")]
    loop = sl[sl.index("while (_frameNum < _catchUpTo) {") :]
    # Each frame: every peer's input fed again from this page's record, then a
    # forward step as in tick(), pacing bypassed.
    assert loop.index("_feedCInput(mod, p.slot, key, input)") < loop.index("mod._kn_pre_tick(")
    assert "mod._kn_pre_tick(own.buttons, own.lx, own.ly, own.cx, own.cy, -1)" in loop
    order = [
        "mod._kn_pre_tick(",
        "_writeRingInputs(mod, _frameNum - DELAY_FRAMES);",
        "_syncRNGSeed(mod, _frameNum);",
        "_runStepOneFrame('catch-up')",
        "_frameNum = mod._kn_post_tick();",
        "if (performance.now() - t0 >= CATCH_UP_SLICE_MS) break;",
    ]
    positions = [loop.index(x) for x in order]
    assert positions == sorted(positions)
    # An input not here is predicted where tick() would predict it: within the
    # rollback window of the frame it goes back to, a phantom peer's, or one
    # from before the settled point. A deeper hole is asked for and waited on,
    # to a deadline (I1); the timer goes when it is filled or the catch-up ends.
    assert "const nearTheEnd = f >= _catchUpTo - KN_MAX_VISIBLE_ROLLBACK_DEPTH;" in loop
    hole = loop[loop.index("const hole = remotePeers.find(") :]
    hole = hole[: hole.index(");")]
    for cond in (
        "_remoteInputs[p.slot]?.[key] === undefined",
        "key >= _inputFloor(p.slot)",
        "!_peerPhantom[p.slot]",
        "!nearTheEnd",
    ):
        assert cond in hole
    assert "now - _catchUpHoleSince >= CATCH_UP_HOLE_WAIT_MS" in loop
    # Each wait is counted, the first logged when it begins.
    wait = loop[loop.index("if (!_catchUpHoleSince) {") :]
    wait = wait[: wait.index("if (now - _catchUpHoleSince")]
    assert "_catchUpWaits++;" in wait
    assert "if (_catchUpWaits === 1) _syncLog(`SYNC-CATCH-UP-WAIT f=${f} slot=${hole.slot} input=${key}`);" in wait
    assert "_catchUpWaits = 0;" in start
    assert "waits=${_catchUpWaits}" in end
    assert "_askForMissingInputs(hole," in loop
    assert "_catchUpHoleSince = 0;" in loop and "_catchUpHoleSince = 0;" in end
    assert re.search(r"const CATCH_UP_HOLE_WAIT_MS = \d+;", src)
    assert "if (stoppedAt || _frameNum >= _catchUpTo) _endCatchUp(mod, stoppedAt);" in sl

    # Each tick runs the next slice, after the queued inputs are fed and
    # before anything else steps the emulator.
    tick_slice = src.index(
        "if (_catchUpTo >= 0) {\n          const catchUpFrom = _frameNum;\n          _catchUpSlice(tickMod);"
    )
    assert src.rindex("_drainPendingCInputs(tickMod);", 0, tick_slice) > src.rindex("RB-INPUT-STALL f=", 0, tick_slice)
    # A slice that ran frames spends no 60 Hz slot, as a rollback replay does
    # not. One that ran none, waiting for an input, spends it: marked
    # replay-only, the pump would call it again and again for its whole
    # budget every pump (a four-player run counted 102988 slices in a 3 s
    # wait).
    after_slice = src[tick_slice : src.index("return;", tick_slice)]
    assert "if (_frameNum > catchUpFrom) _tickReplayOnly = true;" in after_slice
    assert after_slice.count("_tickReplayOnly") == 1
    # Inputs it runs on stay until it reaches its target, and the peers'
    # inputs for the frame it goes back to are taken in meanwhile.
    assert "const keepThrough = Math.max(_frameNum, _catchUpTo) + DELAY_FRAMES;" in apply
    packet = src[src.index("const _processInputPacket = (") :]
    packet = packet[: packet.index("INPUT-OOR slot=")]
    assert "const recvBound = Math.max(_frameNum, _catchUpTo);" in packet
    assert "recvFrame > recvBound + DELAY_FRAMES + INPUT_FUTURE_MARGIN_FRAMES" in packet
    # A newer state waits for it; a stopped match ends it.
    blocks = src[src.index("const _replayBlocksSyncApply = () => {") :]
    assert blocks[: blocks.index("\n  };\n")].index("if (_catchUpTo >= 0) return true;") >= 0
    stop = src[src.index("const stopSync = () => {") :]
    assert "_endCatchUp(" in stop[: stop.index("\n  };\n")]

    # tick() writes a forward frame's inputs through the same helper.
    assert src.count("_writeRingInputs(") == 2  # tick() and the catch-up
    assert "const localApplied = _writeRingInputs(tickMod, applyFrame);" in src


def test_every_resync_request_that_is_out_is_numbered():
    # specs/resync_flow.qnt, ANSWERS_CARRY_REQUEST: a request has a number.
    src = LOCKSTEP_JS.read_text()
    begin = src[src.index("const _beginResyncRequest = (at = -1, again = false) => {") :]
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

    # Twelve sites ask: one over Socket.IO, eleven on a DataChannel (among them a
    # late joiner that lost its channel to the host,
    # specs/late_join_pause.qnt; the deadline asking again for an owed "now"
    # resync, specs/resync_reask.qnt; the boot sync, specs/resync_flow.qnt
    # EVERY_REQUEST_NUMBERED; a guest's ask for a missing input gone
    # overdue, specs/ask_escalation.qnt; a guest that hears another guest
    # again after holding it as a phantom, specs/recovery_bystander.qnt; and a
    # guest that heard a roster after running past its frame,
    # specs/controller_mask.qnt).
    # The two that name a target frame give it to the request, which keeps
    # it after the target's deadline (specs/resync_flow.qnt, askedAt).
    assert src.count("_beginResyncRequest(") == 13
    assert src.count("_beginResyncRequest()") == 8
    assert src.count("_beginResyncRequest(-1, true)") == 2
    assert "const _recoveryRequestId = _beginResyncRequest(_recoveryTarget);" in src
    assert "const _desyncRequestId = _beginResyncRequest(_coordTarget);" in src
    assert "let _resyncRequestAt = -1;" in src
    stop = src[src.index("const stopSync = () => {") :]
    assert "_resyncRequestAt = -1;" in stop[: stop.index("\n  };\n")]
    socket_req = src[src.index("function _requestSocketFullResync(reason, again = false) {") :]
    socket_req = socket_req[: socket_req.index("\n  }\n")]
    assert "const requestId = _beginResyncRequest(-1, again);" in socket_req
    assert "frame: _frameNum,\n        requestId,\n      });" in socket_req

    # On a DataChannel the number goes ahead of the request, which keeps the
    # text a host on an older version matches exactly.
    send = src[src.index("const _sendResyncRequest = (dc, requestId, request) => {") :]
    send = send[: send.index("\n  };\n")]
    assert send.index("dc.send(`sync-request-id:${requestId}`);") < send.index("dc.send(request);")
    assert len(re.findall(r"(?<!const )_sendResyncRequest\(", src)) == 11
    assert len(re.findall(r"_sendResyncRequest\([^;]*'sync-request-full'\);", src)) == 9
    assert len(re.findall(r"_sendResyncRequest\([^;]*`sync-request-full-at:\$\{\w+\}`\);", src)) == 2
    # Never sent bare. The boot sync's request was, and its unnumbered
    # answer was applied wherever it found the guest, even after a newer
    # request (specs/resync_flow.qnt, bootAnswerAfterANewerRequestTest).
    assert not re.search(r"""\.send\(['"`]sync-request(?!-id:)""", src)
    boot = src[src.index("if (_bootDoneForSync && !window._knBootSyncDone) {") :]
    boot = boot[: boot.index("BOOT-SYNC skipped: initial state")]
    assert "const bootRequestId = _beginResyncRequest();" in boot
    assert "_sendResyncRequest(hostPeer.dc, bootRequestId, 'sync-request-full');" in boot
    # It does not ask over a request that is out (its answer brings a host
    # state; asked over, that answer would be dropped as an older request's),
    # nor give up a target, which would apply a held state early
    # (specs/resync_flow.qnt, guestAsksOnItsOwn).
    assert boot.index("if (_resyncRequestInFlight) {") < boot.index("_beginResyncRequest()")
    assert "_syncTargetFrame" not in boot

    # A rematch gets no debt from the old match and never reuses its IDs.
    stop = src[src.index("const stopSync = () => {") :]
    stop = stop[: stop.index("\n  };\n")]
    assert "_reconnectAnswerDebt = null;" in stop
    assert "_resyncRequestId = 0;" not in stop
    assert "_hostNumbersAnswers = false;" in stop


def test_only_its_own_answer_ends_a_resync_request():
    # specs/resync_flow.qnt onlyItsAnswerEndsARequest: the answer to a request
    # the guest gave up on must not end the one that is out now.
    src = LOCKSTEP_JS.read_text()
    ends = src[src.index("const _endsResyncRequest = (answerFor) =>") :]
    ends = ends[: ends.index(";\n")]
    # The proved rule decides (web/src/resync-request.ts, test_the_resync_rules_decide).
    assert "window.KNCore.resyncRequest.endsRequest(answerFor, _resyncRequestId, _hostNumbersAnswers)" in ends

    handle = src[src.index("async function _handleDecodedSyncPayload({") :]
    handle = handle[: handle.index("\n  }\n")]
    assert "answerFor = 0," in handle
    assert "if (_endsResyncRequest(answerFor)) _resyncRequestInFlight = false;" in handle
    assert "const endsRequest = _endsResyncRequest(answerFor);\n      if (endsRequest) _resyncRequestInFlight = false;" in handle
    # The one unconditional clear left there is the delta-base override,
    # which asks again at once.
    assert handle.count("_resyncRequestInFlight = false;") == 4
    assert "_resyncRequestInFlight = false; // allow fresh request" in handle
    assert (
        "_pendingResyncState = { bytes: fullBytes, frame, answerFor, answerScope, proofFor, recoveryId, extras };"
        in handle
    )
    assert "_pendingResyncState = { bytes: decompressed, frame, isRegions: true, answerFor };" in handle

    # Host: the number comes just ahead of the request and is for that
    # request only, answered or rate limited.
    host = src[src.index("if (e.data.startsWith('sync-request-id:')) {") :]
    host = host[: host.index("// JSON messages")]
    assert "if (_playerSlot === 0) syncRequestIdNext = _requestIdFrom(Number(e.data.substring(16)));" in host
    assert host.index("syncRequestIdNext = 0;") < host.index("rate-limited sync-request from")
    assert "targetSid: remoteSid,\n              requestId," in host
    # Every answer is full: the host keeps no delta base (sync_base).
    assert "forceFull" not in src
    # A direct request is answered by the watched answer, which numbers each
    # state it sends with the request it answers (specs/sync_follow_up.qnt).
    assert "_answerDirectSyncRequest(remoteSid, requestId);" in host
    direct = src[src.index("const _answerDirectSyncRequest = (sid, requestId, via = {}) => {") :]
    direct = direct[: direct.index("\n  };\n")]
    assert "const requestIds = { [sid]: requestId };" in direct
    assert "requestIds, watchFor: via.reconnectDebt ? [] : [sid]," in " ".join(direct.split())
    assert "pushSyncState(sid, false, options)" in direct
    assert "_answerDirectSyncRequest(requesterSid, _requestIdFrom(msg.requestId), {" in src

    # A scheduled capture, its follow-ups and re-queues keep the number; a
    # sync the host schedules for its own reasons has none.
    dispatch = src[src.index("const _dispatchScheduledSyncs = (isConfirmed) => {") :]
    dispatch = dispatch[: dispatch.index("\n  };\n")]
    assert "requestId: r.requestId || 0," in dispatch
    assert "for (const r of group) if (r.requestId) ids[r.targetSid] = r.requestId;" in dispatch
    assert "pushSyncState(targetSid, false, { requestIds: requestIdsOf(group), watchFor, ...extra })" in dispatch
    recovery = src[src.index("state to every guest once it is final") :]
    recovery = recovery[: recovery.index("_settleInputsBefore(")]
    assert "requestId" not in recovery

    # The answer carries it: ahead of the header on a DataChannel, as a
    # field over Socket.IO. Never on a proactive push.
    push = src[src.index("const pushSyncState = async (") :]
    push = push[: push.index("const sendSyncChunks = async (")]
    assert "const requestIds = (!isProactive && options.requestIds) || {};" in push
    assert "...(requestIds[targetSid] ? { requestId: requestIds[targetSid] } : {})," in push
    # sendSyncChunks queues each guest's transfer behind that guest's one
    # before; the body is _sendSyncChunksTo, which reads the request id by sid.
    wrapper = src[src.index("const sendSyncChunks = async (") :]
    wrapper = wrapper[: wrapper.index("\n  };\n")]
    assert re.search(
        r"_sendSyncChunksTo\(\s*t,\s*compressed,\s*frame,\s*isProactive,\s*requestIds,\s*attempts.find\(\(a\) => a.sid === t.sid\)\?\.wireId \?\? 0,\s*extras,\s*reconnectFenceCurrent,\s*proofFor,\s*\)",
        wrapper,
    )
    chunks = src[src.index("const _sendSyncChunksTo = async (") :]
    chunks = chunks[: chunks.index("\n  };\n")]
    assert chunks.index("if (answerFor && !proofFor) dc.send(`sync-answer-id:${answerFor}`);") < chunks.index("dc.send(header);")
    # The header an older guest parses is unchanged.
    assert "`sync-start:${frame}:${numChunks}:1:${isProactive ? '1' : '0'}${proofSuffix}`" in chunks

    # Guest: the number is for the next state on that channel only.
    sync_dc = src[src.index("const setupSyncDataChannel = (_remoteSid, ch) => {") :]
    sync_dc = sync_dc[: sync_dc.index("// -- Per-peer state cleanup")]
    assert "syncAnswerIdNext = _requestIdFrom(Number(e.data.substring(15)));" in sync_dc
    assert sync_dc.count("_syncAnswerFor = syncAnswerIdNext;\n          syncAnswerIdNext = 0;") == 1
    assert "_syncAnswerFor = proofForAssembly || syncAnswerIdNext;" in sync_dc
    assert sync_dc.count("syncAnswerIdNext = 0;") == 3
    # A host that has never numbered an answer is on a version that does not:
    # its states end a request as before. Learned from the host only, and
    # forgotten when the host's peer state is reset (I2).
    assert "if (syncAnswerIdNext > 0 && _peers[_remoteSid]?.slot === 0) _hostNumbersAnswers = true;" in sync_dc
    assert "if (answerFor > 0) _hostNumbersAnswers = true;" in src
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "if (slot === 0) _hostNumbersAnswers = false;" in reset


def test_a_late_answer_that_would_take_the_guest_back_is_dropped():
    # specs/resync_flow.qnt aLateAnswerDoesNotTakeTheGuestBack (dropLate,
    # lateAndBehind), with lateAnswerAfterTheTargetDeadlineTest: the frame
    # named is the request's, not the live target, so the drop holds after
    # the target's deadline too; and immediateLateAnswerTest: a late answer
    # from before the guest's own frame is dropped when the newest request
    # named no frame.
    src = LOCKSTEP_JS.read_text()
    older = src[src.index("const _answersAnOlderRequest = (answerFor) =>") :]
    older = older[: older.index(";\n")]
    assert "window.KNCore.resyncRequest.answersAnOlderRequest(answerFor, _resyncRequestId)" in older
    late = src[src.index("const _isLateAnswerBehind = (state) =>") :]
    late = late[: late.index(";\n")]
    assert (
        "!!state &&\n    window.KNCore.resyncRequest.isLateAnswerBehind(\n      state.answerFor || 0,\n"
        "      state.frame,\n      _resyncRequestId,\n      _resyncRequestAt,\n      _frameNum,\n    )"
    ) in late
    assert "_syncTargetFrame" not in late
    tick = src[src.index("const tick = () => {") :]
    drop_at = tick.index("if (_isLateAnswerBehind(_pendingResyncState)) {")
    dropped = tick[drop_at : tick.index("\n    }\n", drop_at)]
    assert "SYNC-LATE-ANSWER-DROPPED f=${_frameNum}" in dropped
    assert "_pendingResyncState = null;" in dropped
    # The wait goes on: the target and its deadline are left as they are.
    assert "_syncTargetFrame = " not in dropped and "_syncTargetDeadlineAt" not in dropped
    # After the target's deadline gives the target up, before either branch
    # holds or applies anything.
    assert tick.index("COORD-SYNC-TIMEOUT target=") < drop_at
    hold_at = tick.index("if (pending && atSyncBoundary) {")
    replay_at = tick.index("else if (!_replayBlocksSyncApply()) {")
    assert drop_at < hold_at < replay_at
    # The stale-state check stays.
    assert "explicit sync discarded: stale frame=${frame} <= lastApplied=${_lastAppliedSyncHostFrame}" in src


def test_a_late_answer_does_not_replace_the_awaited_one():
    # specs/resync_flow.qnt theAwaitedAnswerIsNotLost.
    src = LOCKSTEP_JS.read_text()
    keep = src[src.index("const _keepsAwaitedAnswer = (answerFor, frame) => {") :]
    keep = keep[: keep.index("\n  };\n")]
    assert (
        "const keeps = window.KNCore.resyncRequest.keepsAwaitedAnswer(\n      answerFor,\n"
        "      _resyncRequestId,\n      _pendingResyncState?.answerFor ?? -1,\n    );"
    ) in keep
    assert keep.index("const keeps = ") < keep.index("if (!keeps) return false;") < keep.index("SYNC-LATE-ANSWER-IGNORED")
    assert "SYNC-LATE-ANSWER-IGNORED" in keep
    payload = src[src.index("async function _handleDecodedSyncPayload({") :]
    payload = payload[
        : payload.index(
            "const handleSyncChunksComplete = async ("
        )
    ]
    for pending in (
        "_pendingResyncState = { bytes: decompressed, frame, isRegions: true, answerFor };",
        "_pendingResyncState = { bytes: fullBytes, frame, answerFor, answerScope, proofFor, recoveryId, extras };",
    ):
        at = payload.index(pending)
        assert payload.rindex("if (_keepsAwaitedAnswer(answerFor, frame)) return;", 0, at) > at - 400


def test_a_stale_late_answer_keeps_the_lifecycle_guard():
    # The guard belongs to the request that is out; the answer to an older
    # request does not end it. The guard keeps its own 15 s timeout (I1).
    src = LOCKSTEP_JS.read_text()
    payload = src[src.index("async function _handleDecodedSyncPayload({") :]
    payload = payload[
        : payload.index(
            "const handleSyncChunksComplete = async ("
        )
    ]
    assert "if (!_answersAnOlderRequest(answerFor)) _clearLifecycleResyncGuard('regions sync stale');" in payload
    assert "if (!_answersAnOlderRequest(answerFor)) _clearLifecycleResyncGuard('explicit sync stale');" in payload
    assert payload.count("_clearLifecycleResyncGuard(") == 2
    assert "_clearLifecycleResyncGuard('lifecycle resync guard timeout');" in src


def test_the_resync_rules_decide():
    # The proved functions of web/src/resync-request.ts decide; the engine's
    # own copies and the observer that compared them are gone (CLAUDE.md:
    # new logic decides, nothing observes). tests/ts/resync-request.test.ts
    # keeps the deleted copies and checks them against the proved functions
    # over a grid of inputs.
    src = LOCKSTEP_JS.read_text()
    assert "_resyncObserve" not in src
    assert "resync-disagree" not in src and "RESYNC-DISAGREE" not in src
    for name in (
        "endsRequest",
        "answersAnOlderRequest",
        "isLateAnswerBehind",
        "keepsAwaitedAnswer",
        "lateJoinLostHostStep",
        "resyncDeadlineStep",
    ):
        assert src.count(f"window.KNCore.resyncRequest.{name}(") == 1, name


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

