from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHARED_JS = ROOT / "web/static/shared.js"
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"


def test_key_tracking_releases_held_keys_on_focus_loss():
    source = SHARED_JS.read_text()

    assert "function clearHeldKeysOnFocusLoss()" in source
    assert "window.addEventListener('blur', _blurHandler, true)" in source
    assert "document.addEventListener('visibilitychange', _visibilityHandler, true)" in source
    assert "if (document.hidden) clearHeldKeysOnFocusLoss()" in source
    assert "window.removeEventListener('blur', _blurHandler, true)" in source
    assert "document.removeEventListener('visibilitychange', _visibilityHandler, true)" in source


def test_unfocused_keyboard_input_is_suppressed_and_cleared():
    source = SHARED_JS.read_text()

    read_idx = source.find("const readLocalInput = (playerSlot, keyMap, heldKeys) => {")
    assert read_idx != -1
    read_window = source[read_idx : read_idx + 2200]

    assert "const pageFocused =" in read_window
    assert "if (pageFocused && window.GamepadManager)" in read_window
    assert "if (!pageFocused)" in read_window
    assert "heldKeys?.clear?.()" in read_window
    assert "readKeyboardAxes(keyMap, heldKeys)" in read_window


def test_lockstep_clears_ejs_pause_flag_on_focus_and_visibility_return():
    source = LOCKSTEP_JS.read_text()

    assert "const _releaseLocalFocusInput = () => {" in source
    assert "const _clearEjsPauseFlag = (reason) => {" in source
    assert "mod._toggleMainLoop(1)" in source
    assert "_clearEjsPauseFlag('tab visible')" in source
    assert "_clearEjsPauseFlag('focus')" in source
    assert "_releaseLocalFocusInput()" in source


def test_mobile_lifecycle_return_forces_full_resync():
    source = LOCKSTEP_JS.read_text()

    assert "const _requestImmediateFullResync = (reason) => {" in source
    assert "hostPeer.dc.send('sync-request-full')" in source
    assert "_requestImmediateFullResync('bg-return')" in source
    assert "_requestImmediateFullResync('mobile-focus-return')" in source

    helper_idx = source.index("const _requestImmediateFullResync = (reason) => {")
    helper_window = source[helper_idx : helper_idx + 1800]
    assert "_setLastSyncState(null, reason)" in helper_window
    assert "_pendingResyncState = null;" in helper_window
    assert "_syncTargetFrame = -1;" in helper_window


def test_failed_delta_retry_uses_primary_control_channel():
    source = LOCKSTEP_JS.read_text()

    retry_idx = source.index("delta base missing or size mismatch")
    retry_window = source[retry_idx : retry_idx + 900]
    assert "const hostDc = hostPeer?.dc;" in retry_window
    assert "hostDc.send('sync-request-full')" in retry_window
    assert "hostSyncDc" not in retry_window


def test_full_resync_requests_bypass_cooldown_and_sync_dc_is_tolerated():
    source = LOCKSTEP_JS.read_text()

    assert "if (!isFull && now - lastRequest < _SYNC_REQUEST_COOLDOWN_MS)" in source
    assert "if (_handleHostSyncRequest(_remoteSid, e.data))" in source
    assert "_drainScheduledSyncRequests('pre-stall')" in source
    assert "_drainScheduledSyncRequests('post-step')" in source

    pre_stall_idx = source.index("_drainScheduledSyncRequests('pre-stall')")
    phase_lock_idx = source.index("const menuPhase = _readStrictPhaseLock", pre_stall_idx)
    assert pre_stall_idx < phase_lock_idx
