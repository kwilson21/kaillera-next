from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHARED_JS = ROOT / "web/static/shared.js"
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"
RETROARCH_PATCH = ROOT / "build/patches/retroarch-deterministic-timing.patch"
CORE_JS = ROOT / "web/static/ejs/cores/mupen64plus_next_libretro.js"


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
    assert "mod._platform_emscripten_update_window_hidden_cb?.(0)" in source
    assert "mod._toggleMainLoop?.(1)" in source
    assert "mod._cmd_unpause()" in source
    assert "RetroArch explicit unpause sent on" in source
    assert "_clearEjsPauseFlagWithRetries('tab visible')" in source
    assert "_clearEjsPauseFlagWithRetries('focus')" in source
    assert "_clearEjsPauseFlagWithRetries('pageshow')" in source
    assert "_clearEjsPauseFlag('tab hidden')" in source
    assert "_clearEjsPauseFlag('pagehide')" in source
    assert "_releaseLocalFocusInput()" in source


def test_lockstep_retries_mobile_pause_clear_after_focus_return():
    source = LOCKSTEP_JS.read_text()

    assert "const EJS_PAUSE_CLEAR_RETRY_DELAYS_MS = [75, 250, 750, 1500]" in source
    assert "const _clearEjsPauseFlagWithRetries = (reason) => {" in source
    assert "for (const delay of EJS_PAUSE_CLEAR_RETRY_DELAYS_MS)" in source
    assert "_clearEjsPauseFlag(`${reason}+${delay}ms`)" in source
    assert "if (typeof document !== 'undefined' && document.hidden) return" in source


def test_local_input_is_zeroed_while_emulator_resume_is_guarded():
    source = LOCKSTEP_JS.read_text()

    assert "let _resumeInputGuardUntil = 0" in source
    assert "const LIFECYCLE_RESYNC_INPUT_GUARD_MS = 5000" in source
    assert "let _lifecycleResyncPending = false" in source
    assert "const LIFECYCLE_RESYNC_PENDING_TIMEOUT_MS = 15000" in source
    assert "const suppressEjsPausedInput = !!window.EJS_emulator?.paused" in source
    assert "nowInput < _resumeInputGuardUntil || _lifecycleResyncPending" in source
    assert "suppressEjsPausedInput ||" in source
    assert "suppressResumeGuardInput" in source
    assert "? KNShared.ZERO_INPUT" in source


def test_background_return_requests_full_sync_and_guards_input_until_apply():
    source = LOCKSTEP_JS.read_text()

    assert "_lifecycleResyncStartedAt + LIFECYCLE_RESYNC_INPUT_GUARD_MS" in source
    assert "const _requestLifecycleFullResync = (reason) => {" in source
    assert "type: 'sync-request-full-socket'" in source
    assert "type: 'sync-state-socket'" in source
    assert "pushSyncState(requesterSid, false, { transport: 'socket'" in source
    assert "`${reason}: sent socket sync-request-full to host`" in source
    assert "hostPeer.dc.send('sync-request-full')" in source
    assert "sent sync-request-full to host over DC fallback" in source
    assert "_requestLifecycleFullResync('bg-return')" in source
    assert "_requestLifecycleFullResync('pageshow')" in source
    assert "_resumeInputGuardUntil = now + EJS_RESUME_INPUT_GUARD_MS" in source
    assert "_clearLifecycleResyncGuard('sync apply')" in source
    assert "resume input guard shortened after sync apply" in source


def test_sync_state_chunk_timeout_falls_back_to_socket_resync():
    source = LOCKSTEP_JS.read_text()

    assert "const SYNC_CHUNK_TIMEOUT_MS = 3000" in source
    assert "sync chunks timeout:" in source
    assert "_requestSocketFullResync('sync-chunk-timeout')" in source
    assert "sync chunks progress:" in source
    assert "socket sync sent to slot=" in source
    assert "source=${source}" in source


def test_retroarch_visibility_pause_is_prevented_during_netplay():
    lockstep = LOCKSTEP_JS.read_text()
    patch = RETROARCH_PATCH.read_text()

    assert "window._knPreventRetroArchVisibilityPause = true" in lockstep
    assert "window._knPreventRetroArchVisibilityPause = false" in lockstep
    assert "window._knPreventRetroArchVisibilityPause" in patch
    assert "_platform_emscripten_update_window_hidden_cb(hidden)" in patch


def test_core_exports_explicit_pause_controls_for_mobile_lifecycle_recovery():
    patch = RETROARCH_PATCH.read_text()
    core = CORE_JS.read_text()

    assert "void cmd_unpause(void)" in patch
    assert "command_event(CMD_EVENT_UNPAUSE, NULL)" in patch
    assert "_cmd_unpause" in patch
    assert "_cmd_unpause" in core
