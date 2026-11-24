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


def test_current_play_page_loads_only_the_canonical_engine():
    src = PLAY_HTML.read_text()
    assert "/static/netplay-rollback.js" in src
    assert "/static/netplay-lockstep.js" not in src


def test_mode_select_dropdown_offers_the_three_modes():
    src = PLAY_HTML.read_text()
    assert '<option value="rollback">Rollback</option>' in src
    # Lockstep is its own mode now (no prediction), not the old name of rollback.
    assert '<option value="lockstep">Lockstep</option>' in src
    assert '<option value="streaming">Streaming</option>' in src


def test_play_js_reads_every_mode_through_one_rule():
    """play.js reads the mode at every intake (URL params, users-updated,
    data-message, dropdown) through KNCore.play.mode.normalizeMode."""
    src = PLAY_JS.read_text()
    assert "const normalizeMode = window.KNCore.play.mode.normalizeMode;" in src
    assert "let mode = 'rollback';" in src
    # Rollback and lockstep both use the rollback engine.
    assert "window.NetplayRollback" in src


def test_core_redirector_loads_patched_core_for_rollback_mode():
    """The patched WASM core is required for the rollback engine. Pre-rename
    code only enabled the redirector when mode === 'lockstep', which would
    silently degrade on ?mode=rollback. Streaming also uses the bundled
    archive, without announcing rollback or worker mode."""
    src = CORE_REDIRECTOR.read_text()
    assert "streaming = gameMode === 'streaming';" in src
    assert "window._kn_usePatchedCore = true;" in src


def test_engine_names_its_mode_in_one_place():
    """getInfo().mode and the session-log payloads say 'rollback', or
    'lockstep' when the host picked lockstep (predictions off for the match).
    Verified by source pattern because the actual call requires a full
    browser stack; tests/rb-two-player.mjs checks getInfo() in a real match."""
    src = ROLLBACK_JS.read_text()
    assert "const _modeName = () => (_predictionsPaused ? 'lockstep' : 'rollback');" in src
    # getInfo() and both session-log payloads (socket and HTTP fallback).
    assert src.count("mode: _modeName(),") == 3
    # No mode reported as a fixed literal.
    assert "mode: 'rollback'," not in src
    assert "mode: 'lockstep'," not in src


def test_internal_lockstep_vocabulary_is_preserved():
    """The rename intentionally keeps 'lockstep' as implementation vocabulary
    for strict input stalls (the in-engine fallback when the C engine
    is not running) and as stable protocol/log labels. Guard against
    accidental over-renames that would break the analyzer or the cheat
    pipeline."""
    src = ROLLBACK_JS.read_text()
    # DC message type for the lockstep handshake.
    assert "type: 'lockstep-ready'" in src
    # Console-log prefix.
    assert "console.log(`[lockstep] " in src
    # Cheat-context name (internal contract with web/src/page/shared.ts).
    assert "KNShared.bootWithCheats('lockstep')" in src
    # Window flag set during a lockstep stall window.
    assert "window._lockstepActive" in src
