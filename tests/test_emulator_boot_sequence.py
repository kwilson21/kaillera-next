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


def test_lockstep_guest_boot_is_deferred_until_gesture():
    play_source = (REPO_ROOT / "web/static/play.js").read_text()
    lockstep_source = (REPO_ROOT / "web/static/netplay-lockstep.js").read_text()

    assert "guest lockstep boot deferred until gesture" in play_source
    assert "window.KNStartEmulatorBoot = ensureEmulatorBooted" in play_source

    boot_idx = lockstep_source.find("window.KNStartEmulatorBoot?.({ forceStartOnLoad: true })")
    cheats_idx = lockstep_source.find("KNShared.bootWithCheats('lockstep')", boot_idx)
    assert boot_idx != -1
    assert cheats_idx > boot_idx


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
    assert "clearCheats()" in window
    assert "SSB64_HASH: SSB64_HASH" in source


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
