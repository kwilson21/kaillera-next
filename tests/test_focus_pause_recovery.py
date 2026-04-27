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
