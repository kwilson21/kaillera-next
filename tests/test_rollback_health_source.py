import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"
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


def test_rollback_stall_sites_have_wall_clock_recovery_markers():
    src = LOCKSTEP_JS.read_text()
    doc = INVARIANTS_DOC.read_text()

    for marker in ("PHASE-LOCK-TIMEOUT", "MENU-LOCKSTEP-TIMEOUT", "RB-INPUT-STALL-TIMEOUT"):
        assert marker in src
        assert marker in doc

    assert "stallMs >= MAX_STALL_MS + RESEND_TIMEOUT_MS" in src
    assert "stallDuration >= MAX_STALL_MS + RESEND_TIMEOUT_MS" in src
    assert "markPeerPhantomForStallTimeout" in src


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
    assert "detMod?._kn_rollback_init && !_isSmashRemix() && DELAY_FRAMES > 0" in src
    assert "C-ROLLBACK disabled for zero-delay solo play" in src


def test_phase_lock_deadline_tracks_intermittent_phase_mismatch():
    src = LOCKSTEP_JS.read_text()

    assert "const phaseMismatchSlots = [];" in src
    assert "notePhaseMismatch(p.slot);" in src
    assert "phaseMismatchSlots," in src
    assert "const phaseLockSlots = [...new Set(phaseMismatchSlots)].sort((a, b) => a - b);" in src
    assert "mismatchPeers=[${phaseLockSlots.join(',')}]" in src
    assert "else if (phaseWaitSlots.length) {" in src


def test_resync_state_load_clears_pending_c_inputs():
    src = LOCKSTEP_JS.read_text()

    assert "const _clearPendingCInputs = (reason) => {" in src
    assert "_clearPendingCInputs(`${reason}:pre-load`)" in src
    assert "_clearPendingCInputs(`${reason}:post-load`)" in src
    assert "_clearPendingCInputs(`${reason}:pre-kn-sync`)" in src
    assert "_clearPendingCInputs(`${reason}:post-kn-sync`)" in src


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
