"""Regression checks for same-tab EmulatorJS restart boot flow."""

from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """This static test module does not need the Playwright browser fixture."""
    yield


def test_restarts_reuse_ejs_loader_instead_of_direct_constructor():
    play_source = (REPO_ROOT / "web/static/play.js").read_text()
    loader_source = (REPO_ROOT / "web/static/ejs-loader.js").read_text()

    assert "new EmulatorJS(window.EJS_player || '#game'" not in play_source
    assert "emulatorClassLoaded = typeof window.EmulatorJS === 'function'" in loader_source
    assert "if (!emulatorClassLoaded)" in loader_source
    assert "kn-ejs-loader-complete" in loader_source


def test_lockstep_guest_prewarms_without_starting_until_gesture():
    play_source = (REPO_ROOT / "web/static/play.js").read_text()
    lockstep_source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    assert "function warmGuestLockstepEmulator(reason = 'rom-ready')" in play_source
    assert "warmGuestLockstepEmulator('rom-ready')" in play_source
    assert "bootEmulator({ forceStartOnLoad: false })" in play_source
    assert "guest lockstep boot deferred until gesture" in play_source
    assert "window.KNStartEmulatorBoot = ensureEmulatorBooted" in play_source

    boot_idx = lockstep_source.find("window.KNStartEmulatorBoot?.({ forceStartOnLoad: true })")
    cheats_idx = lockstep_source.find("KNShared.bootWithCheats('lockstep')", boot_idx)
    assert boot_idx != -1
    assert cheats_idx > boot_idx


def test_rom_change_discards_prewarmed_guest_emulator():
    source = (REPO_ROOT / "web/static/play.js").read_text()
    discard_idx = source.find("const discardHibernatedEmulatorForRomChange =")
    assert discard_idx != -1
    window = source[discard_idx : discard_idx + 1400]

    assert "ROM changed while emulator prewarmed, destroying old core" in window
    assert "!gameRunning && window.EJS_emulator" in window
    assert "_prewarmedGuestRomHash = null" in source


def test_library_rom_updates_ejs_identity_for_next_boot():
    source = (REPO_ROOT / "web/static/play.js").read_text()
    load_idx = source.find("const loadRomFromLibrary =")
    assert load_idx != -1
    window = source[load_idx : load_idx + 1600]

    assert "window.EJS_gameID = hash" in window


def test_non_ssb64_boot_clears_stale_standard_cheats():
    source = (REPO_ROOT / "web/static/shared.js").read_text()
    boot_idx = source.find("function bootWithCheats(label)")
    assert boot_idx != -1
    window = source[boot_idx : boot_idx + 700]

    assert "window.KNState?.romHash === SSB64_HASH" in window
    assert "applyStandardCheats(SSB64_ONLINE_CHEATS)" in window
    assert "window.EJS_cheats = []" in window
    assert "clearCheats(false)" in window
    assert "gm.resetCheat()" in source or "gm.Module?._reset_cheat" in source
    assert "async function clearCheats(disableKnownCheats = true)" in source
    assert "if (disableKnownCheats)" in source
    assert "SSB64_HASH: SSB64_HASH" in source


def test_smash_remix_startup_uses_kn_sync_and_disables_c_rollback():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    assert "const REMIX_INITIAL_SYNC_USE_KN_SYNC = true" in source
    assert "REMIX_INITIAL_SYNC_USE_KN_SYNC && _isSmashRemix()" in source
    assert "Smash Remix initial sync: kn_sync_read" in source
    assert "kind: 'kn-sync'" in source
    assert "Smash Remix: bypassing cached pre-title state; using host title-screen capture" in source
    assert "const INITIAL_SMASH_FALLBACK_SCENES = new Set([55]);" in source
    assert "const INITIAL_SMASH_CONFIRM_SCENES = new Set([55]);" in source
    assert "const INITIAL_SMASH_CONFIRM_INPUT = Object.freeze({ buttons: (1 << 0) | (1 << 3)" in source
    assert "Smash Remix initial sync: confirm pulse scene=${scene} coreFrame=${frame}" in source
    assert "Smash Remix initial sync: capturing fallback scene=${scene}" in source
    assert "C-ROLLBACK disabled for Smash Remix title/menu startup" in source
    assert "detMod?._kn_rollback_init && !_isSmashRemix()" in source
    assert "KNShared.clearCheats(false)" in source


def test_smash_remix_startup_restores_full_hidden_state_sidecar():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()
    build_source = (REPO_ROOT / "build/build.sh").read_text()

    assert "const _restoreHiddenStateWords = (mod, words, reason) =>" in source
    assert "mod?._kn_restore_hidden_state_impl || mod?._kn_restore_hidden_state_boot" in source
    assert "const method = mod._kn_restore_hidden_state_impl ? 'full' : 'boot'" in source
    assert "restored Remix hidden state (${method}) words=${wordCount}" in source

    initial_idx = source.find("initial-sync-load", source.find("if (isKnSyncInitialState)"))
    assert initial_idx != -1
    initial_window = source[initial_idx : initial_idx + 1800]
    assert "_restoreHiddenStateWords(readyMod, _guestStateHiddenWords, 'initial-sync-load')" in initial_window

    late_join_idx = source.find("const handleLateJoinState = async (msg) =>")
    assert late_join_idx != -1
    late_join_window = source[late_join_idx : late_join_idx + 5200]
    hidden_idx = late_join_window.find("_restoreHiddenStateWords(")
    audio_idx = late_join_window.find("_restoreAudioFifoState(")
    assert hidden_idx != -1
    assert audio_idx > hidden_idx
    assert "Array.isArray(msg.hiddenWords) ? msg.hiddenWords.map((w) => w >>> 0) : null" in late_join_window

    assert "_kn_pack_hidden_state_impl,_kn_restore_hidden_state_impl,_kn_restore_hidden_state_boot" in build_source


def test_smash_remix_jsc_guest_skips_remote_title_kn_sync_restore():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    assert "let _guestStateUseLocalRemixTitle = false" in source
    assert "const _isWebKitJscRuntime = () => {" in source
    assert "Smash Remix initial sync: JSC guest aligning local title before lockstep" in source
    assert "await waitForSmashTitleState(gm)" in source
    assert "_guestStateUseLocalRemixTitle = true" in source
    assert "JSC guest kept local Remix title state; skipped remote kn-sync restore" in source

    load_idx = source.find("const useLocalRemixTitleState =")
    skip_idx = source.find("JSC guest kept local Remix title state", load_idx)
    remote_idx = source.find("loadKnSyncStateAtStartBoundary", load_idx)
    assert load_idx != -1
    assert skip_idx != -1
    assert remote_idx > skip_idx


def test_controller_mask_reapplies_when_emulator_module_changes():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()
    apply_idx = source.find("const _applyControllerPresentMask =")
    reset_idx = source.find("const _resetControllerPresentMask =", apply_idx)
    assert apply_idx != -1
    assert reset_idx != -1
    apply_window = source[apply_idx:reset_idx]

    assert "if (!_isSmashRemix()) return;" not in apply_window
    assert "let _lastControllerPresentMaskModule = null" in source
    assert "mod === _lastControllerPresentMaskModule" in apply_window
    assert "_lastControllerPresentMaskModule = mod" in apply_window
    assert "_lastControllerPresentMaskModule = null" in source[reset_idx : reset_idx + 400]


def test_same_rom_resumes_hibernated_core_and_rom_switch_discards_old_core():
    source = (REPO_ROOT / "web/static/play.js").read_text()
    helper_idx = source.find("const discardHibernatedEmulatorForRomChange = (nextHash) =>")
    assert helper_idx != -1
    helper_window = source[helper_idx : helper_idx + 1500]

    assert "if (_hibernated)" in helper_window
    assert "if (nextHash && _hibernatedRomHash === nextHash) return" in helper_window
    assert "destroyEmulator()" in helper_window
    assert "discardHibernatedEmulatorForRomChange(expectedHash)" in source
    assert "discardHibernatedEmulatorForRomChange(hash)" in source
    assert "discardHibernatedEmulatorForRomChange(null)" in source

    assert "const markSameRomEmulatorResume = (reason) => {" in source
    assert "window.KNEmulatorResumeContext = {" in source
    assert "sameRom: true" in source
    assert "window.KNEmulatorResumeContext = null" in source
    assert "const resumeStreamingMainLoop = (reason) => {" in source
    resume_idx = source.find("const resumeStreamingMainLoop = (reason) => {")
    resume_window = source[resume_idx : resume_idx + 1300]
    assert "mod.pauseMainLoop?.()" in resume_window
    assert "window.APISandbox?.nativeRAF" in resume_window
    assert "mod.resumeMainLoop()" in resume_window

    ensure_idx = source.find("const ensureEmulatorBooted = ({ forceStartOnLoad = false } = {}) =>")
    assert ensure_idx != -1
    ensure_window = source[ensure_idx : ensure_idx + 1200]
    assert "if (_hibernated && _hibernatedRomHash === _romHash)" in ensure_window
    assert "markSameRomEmulatorResume('same-rom-wake')" in ensure_window
    assert "wakeEmulator()" in ensure_window
    assert "if (mode === 'streaming') resumeStreamingMainLoop('same-rom-wake')" in ensure_window
    assert "if (_hibernated)" in ensure_window
    assert "destroyEmulator()" in ensure_window
    assert "bootEmulator({ forceStartOnLoad })" in ensure_window
    assert "window._knHibernatedWakePending" not in source
    assert "KNForceEmulatorReboot" not in source

    wake_idx = source.find("const wakeEmulator = () => {")
    assert wake_idx != -1
    wake_window = source[wake_idx : wake_idx + 1800]
    assert "emu.paused = false;" in wake_window
    assert "mod._platform_emscripten_update_window_hidden_cb?.(0)" in wake_window
    assert "mod._toggleMainLoop?.(1)" in wake_window
    assert "mod._cmd_unpause?.()" in wake_window


def test_same_rom_remix_resume_skips_title_wait_and_syncs_current_state():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    assert "const _isSameRomEmulatorResume = () => {" in source
    assert "window.KNEmulatorResumeContext" in source
    assert "ctx.romHash === _config.romHash" in source

    wait_idx = source.find("const waitForSmashTitleState = async (gm) => {")
    assert wait_idx != -1
    wait_window = source[wait_idx : wait_idx + 900]
    resume_idx = wait_window.find("if (_isSameRomEmulatorResume())")
    title_wait_idx = wait_window.find("Smash Remix initial sync: waiting for title-screen state")
    assert resume_idx != -1
    assert title_wait_idx > resume_idx
    assert "same-ROM resume, capturing current state" in wait_window
    assert "mod.pauseMainLoop?.()" in wait_window


def test_host_local_kn_sync_initial_capture_is_not_reloaded():
    source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    start_idx = source.find("const hasLocalKnSyncCapture =")
    assert start_idx != -1
    window = source[start_idx : start_idx + 1800]

    local_idx = window.find("if (hasLocalKnSyncCapture)")
    load_idx = window.find("loadKnSyncStateAtStartBoundary")
    assert local_idx != -1
    assert load_idx > local_idx
    assert "recaptureManualRunner(readyMod, 'initial-sync-local-capture')" in window
    assert "initial-sync-load: host kept locally captured kn-sync state" in window
    assert "initial-sync-load: host reloaded captured kn-sync state" not in source


def test_kn_sync_v4_preserves_r4300_delay_slot_and_skip_jump():
    source = (REPO_ROOT / "build/patch-sync-v3.py").read_text()
    build_source = (REPO_ROOT / "build/build.sh").read_text()

    assert "header[0] = 0x4B4E5334; header[1] = 4" in source
    assert "header[0] == 0x4B4E5334 && header[1] == 4" in source
    assert "else if (header[0] == 0x4B4E5333 && header[1] == 3) version = 3" in source
    assert "delay_slot=dev->r4300.delay_slot" in source
    assert "skip_jump=dev->r4300.skip_jump" in source
    assert "if (version >= 4)" in source
    assert "dev->r4300.delay_slot = delay_slot" in source
    assert "dev->r4300.skip_jump = skip_jump" in source
    assert "Upgrading kn_sync_read/write to v4" in build_source


def test_connected_peers_timeout_is_reported_as_boot_failure_not_webrtc():
    source = (REPO_ROOT / "web/static/play.js").read_text()
    timeout_idx = source.find("let eventType = 'webrtc-fail'")
    assert timeout_idx != -1
    timeout_window = source[timeout_idx : timeout_idx + 1400]

    assert "states.every((s) => s === 'connected' || s === 'completed')" in timeout_window
    assert "reason = 'Game boot timed out'" in timeout_window
    assert "eventType = 'wasm-fail'" in timeout_window
    assert "KNEvent(eventType" in timeout_window
