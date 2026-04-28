import subprocess
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHARED_JS = ROOT / "web/static/shared.js"
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"
RETROARCH_PATCH = ROOT / "build/patches/retroarch-deterministic-timing.patch"
CORE_JS = ROOT / "web/static/ejs/cores/mupen64plus_next_libretro.js"


def test_key_tracking_releases_held_keys_on_focus_loss():
    source = SHARED_JS.read_text()

    assert "function clearHeldKeysOnFocusLoss()" in source
    assert "function ensureKeyTrackingListeners()" in source
    assert "window.addEventListener('blur', _blurHandler, true)" in source
    assert "document.addEventListener('visibilitychange', _visibilityHandler, true)" in source
    assert "if (document.hidden) clearHeldKeysOnFocusLoss()" in source
    assert "window.removeEventListener('blur', _blurHandler, true)" in source
    assert "document.removeEventListener('visibilitychange', _visibilityHandler, true)" in source


def test_key_tracking_reinstalls_listeners_when_reusing_cached_keymap():
    source = SHARED_JS.read_text()

    setup_idx = source.find("function setupKeyTracking(keymap, heldKeys) {")
    assert setup_idx != -1
    setup_window = source[setup_idx : setup_idx + 1800]

    cached_idx = setup_window.find("if (keymap) {")
    cached_ensure_idx = setup_window.find("ensureKeyTrackingListeners();", cached_idx)
    cached_return_idx = setup_window.find("return keymap;", cached_idx)
    resolved_ensure_idx = setup_window.rfind("ensureKeyTrackingListeners();")
    resolved_return_idx = setup_window.find("return resolved;")

    assert cached_idx != -1
    assert cached_idx < cached_ensure_idx < cached_return_idx
    assert resolved_ensure_idx != -1
    assert resolved_ensure_idx < resolved_return_idx


def test_key_tracking_cached_keymap_captures_after_teardown_behavior():
    script = textwrap.dedent(
        r"""
        const fs = require('fs');
        const listeners = new Map();
        const key = (scope, type) => `${scope}:${type}`;
        const add = (scope, type, fn) => {
          const k = key(scope, type);
          if (!listeners.has(k)) listeners.set(k, new Set());
          listeners.get(k).add(fn);
        };
        const remove = (scope, type, fn) => listeners.get(key(scope, type))?.delete(fn);
        const dispatch = (scope, evt) => {
          for (const fn of Array.from(listeners.get(key(scope, evt.type)) || [])) fn(evt);
        };
        global.document = {
          hidden: false,
          addEventListener: (type, fn) => add('document', type, fn),
          removeEventListener: (type, fn) => remove('document', type, fn),
          dispatchEvent: (evt) => dispatch('document', evt),
        };
        global.window = {
          document,
          KNState: { safeGet: () => null },
          addEventListener: (type, fn) => add('window', type, fn),
          removeEventListener: (type, fn) => remove('window', type, fn),
        };
        global.navigator = {};
        eval(fs.readFileSync('web/static/shared.js', 'utf8'));

        const firstHeld = new Set();
        const cachedKeymap = window.KNShared.setupKeyTracking({ 65: 0 }, firstHeld);
        document.dispatchEvent({ type: 'keydown', keyCode: 65 });
        if (!firstHeld.has(65)) throw new Error('initial keydown was not captured');

        window.KNShared.teardownKeyTracking();
        const secondHeld = new Set();
        const reusedKeymap = window.KNShared.setupKeyTracking(cachedKeymap, secondHeld);
        if (reusedKeymap !== cachedKeymap) throw new Error('cached keymap was not reused');

        document.dispatchEvent({ type: 'keydown', keyCode: 65 });
        if (!secondHeld.has(65)) throw new Error('reused keymap did not recapture keydown');
        document.dispatchEvent({ type: 'keyup', keyCode: 65 });
        if (secondHeld.has(65)) throw new Error('keyup did not release reused keymap input');
        """
    )

    result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr + result.stdout


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
    assert "if (emu) emu.paused = false;" in source
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


def test_lockstep_stop_pauses_main_loop_before_restoring_raf():
    source = LOCKSTEP_JS.read_text()

    stop_idx = source.find("const stopSync = () => {")
    assert stop_idx != -1
    stop_window = source[stop_idx : stop_idx + 4600]

    pause_idx = stop_window.find("paused EJS main loop before restoring native rAF")
    restore_idx = stop_window.find("APISandbox.restoreAll()")
    assert pause_idx != -1
    assert restore_idx > pause_idx
    assert "if (_manualMode && stopMod?.pauseMainLoop)" in stop_window


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
