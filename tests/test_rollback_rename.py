"""Static-source tests for the lockstep → rollback rename.

These tests guard against silent regressions in the deploy-safety shims. They
check the source files directly (no browser) so they're fast and run on every
push. Removable once the back-compat shims are deleted in a future deploy.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROLLBACK_JS = ROOT / "web/static/netplay-rollback.js"
LOCKSTEP_SHIM = ROOT / "web/static/netplay-lockstep.js"
PLAY_JS = ROOT / "web/static/play.js"
PLAY_HTML = ROOT / "web/play.html"
CORE_REDIRECTOR = ROOT / "web/static/core-redirector.js"


def test_engine_exposes_both_window_globals_during_compat_window():
    """netplay-rollback.js exposes both window.NetplayRollback (canonical)
    and window.NetplayLockstep (legacy alias) so cached client tabs and
    tests that haven't been updated still work."""
    src = ROLLBACK_JS.read_text()
    assert "window.NetplayRollback = NetplayRollbackApi;" in src
    assert "window.NetplayLockstep = NetplayRollbackApi;" in src


def test_legacy_lockstep_file_is_a_deprecation_shim_only():
    """Cached play.html may still request /static/netplay-lockstep.js. The
    shim file exists at that path with no behavior, just a console warning,
    to prevent 404s during the deploy churn window."""
    src = LOCKSTEP_SHIM.read_text()
    assert "DEPRECATED COMPAT SHIM" in src
    # The shim must NOT contain the engine — its job is just to load.
    assert "NetplayRollbackApi" not in src
    assert "kn_rollback_init" not in src


def test_play_html_loads_rollback_engine_first_then_shim():
    """Both files load (one for the new path, one for cached HTML), with
    the real engine before the shim so the alias is set when stale HTML
    requests the legacy path."""
    src = PLAY_HTML.read_text()
    rollback_idx = src.find("/static/netplay-rollback.js")
    shim_idx = src.find("/static/netplay-lockstep.js")
    assert rollback_idx != -1, "play.html must load netplay-rollback.js"
    assert shim_idx != -1, "play.html keeps loading netplay-lockstep.js as compat shim"
    assert rollback_idx < shim_idx, (
        "rollback engine must load before the lockstep shim so the alias is "
        "in place when stale HTML requests the legacy path"
    )


def test_mode_select_dropdown_offers_rollback_and_streaming_only():
    src = PLAY_HTML.read_text()
    assert '<option value="rollback">Rollback</option>' in src
    assert '<option value="streaming">Streaming</option>' in src
    # The legacy option must be gone from the dropdown.
    assert '<option value="lockstep">' not in src


def test_play_js_normalizes_legacy_mode_at_intake():
    """play.js has a single normalizeMode helper used at every mode-intake
    boundary (URL params, users-updated, data-message, dropdown). The
    helper coerces legacy 'lockstep' to 'rollback'."""
    src = PLAY_JS.read_text()
    assert "const normalizeMode = (raw) =>" in src
    assert "if (raw === 'lockstep') return 'rollback';" in src
    # Default mode literal flipped.
    assert "let mode = 'rollback';" in src
    # Engine dispatch uses the new global.
    assert "window.NetplayRollback" in src


def test_core_redirector_loads_patched_core_for_rollback_mode():
    """The patched WASM core is required for the rollback engine. Pre-rename
    code only enabled the redirector when mode === 'lockstep', which would
    silently degrade on ?mode=rollback. The new gate inverts the logic and
    only skips the redirector for streaming."""
    src = CORE_REDIRECTOR.read_text()
    assert "if (mode === 'streaming') {" in src
    assert "rawMode === 'lockstep' ? 'rollback' : rawMode" in src


def test_engine_getinfo_reports_rollback_mode():
    """window.NetplayRollback.getInfo().mode must report 'rollback' (the
    canonical wire value), not 'lockstep'. Verified by source pattern
    because the actual call requires a full browser stack."""
    src = ROLLBACK_JS.read_text()
    # The getInfo() return literal.
    assert "        mode: 'rollback'," in src
    # Session log payloads also use 'rollback'.
    assert "    mode: 'rollback'," in src
    # No leftover 'mode: lockstep' string-literal mode reports.
    assert "mode: 'lockstep'," not in src


def test_internal_lockstep_vocabulary_is_preserved():
    """The rename intentionally keeps 'lockstep' as implementation vocabulary
    for strict input stalls (boot convergence, menu phase-lock gate, the
    in-engine fallback) and as stable protocol/log labels. Guard against
    accidental over-renames that would break the analyzer or the cheat
    pipeline."""
    src = ROLLBACK_JS.read_text()
    # DC message type for the lockstep handshake.
    assert "type: 'lockstep-ready'" in src
    # Console-log prefix.
    assert "console.log(`[lockstep] " in src
    # Cheat-context name (internal contract with shared.js).
    assert "KNShared.bootWithCheats('lockstep')" in src
    # Window flag set during a lockstep stall window.
    assert "window._lockstepActive" in src
