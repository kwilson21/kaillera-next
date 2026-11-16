from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCKSTEP_JS = ROOT / "web/static/netplay-rollback.js"
PLAY_JS = ROOT / "web/static/play.js"
PLAY_HTML = ROOT / "web/play.html"
PLAY_CSS = ROOT / "web/static/play.css"


def test_match_loading_transition_is_not_strict_menu_lockstep():
    """Regression: peers froze at scene=22/gameStatus=0 after stage select.

    That phase is the non-controllable battle-loading transition. It must
    not use the no-timeout menu stall path.
    """
    src = LOCKSTEP_JS.read_text()

    assert "const inBattleTransition = sceneCurr === 22 && gameStatus === 0;" in src
    assert "!_useCRollback &&\n        !inBattleTransition &&" in src
    assert "getInputPeers(menuLockstepPhase.strictInputLockstep)" in src
    assert "if (menuLockstepPhase.strictInputLockstep)" in src


def test_strict_menu_wait_has_visible_overlay():
    rollback_src = LOCKSTEP_JS.read_text()
    play_src = PLAY_JS.read_text()
    html_src = PLAY_HTML.read_text()
    css_src = PLAY_CSS.read_text()

    assert "const STRICT_MENU_OVERLAY_DELAY_MS = 5000;" in rollback_src
    assert "stalledMs < STRICT_MENU_OVERLAY_DELAY_MS" in rollback_src
    assert "kn-menu-lockstep-wait" in rollback_src
    assert "kn-menu-lockstep-clear" in rollback_src
    assert "showMenuLockstepWait" in play_src
    assert "hideMenuLockstepWait" in play_src
    assert 'id="menu-wait-overlay"' in html_src
    assert "#menu-wait-overlay" in css_src


def test_rollback_does_not_depend_on_the_games_scene():
    """Room 5AB4NK8U: strict Remix menu lockstep at a rollback-sized delay
    capped the menus at ~35fps over ~100ms RTT. Rollback has run through the
    Remix menus since, and the lockstep it replaced is gone: the C engine is
    never held back for, or shut down on, a scene the game is showing.
    A page from before that change is refused rather than paired.
    """
    src = LOCKSTEP_JS.read_text()

    for gone in (
        "remixMenuLockstep",
        "RB_REMIX_MENU",
        "_rbDeferredForGameplay",
        "_shutdownCRollbackForMenu",
        "_rbShutdownHold",
        "_peerPhases",
        "PHASE-LOCK",
        "_broadcastPhaseIfNeeded",
    ):
        assert gone not in src, gone

    # With the C engine running, a missing input is predicted on every screen.
    phase = src[src.index("const _readMenuPhase = () => {") :]
    phase = phase[: phase.index("\n  };\n")]
    assert "strictInputLockstep:\n        !_useCRollback &&" in phase

    assert "remixMenuRollback: true," in src
    assert "if (_isSmashRemix() && !peerCaps.remixMenuRollback) {" in src
    # Still read (and ignored) from a page that sends it.
    assert "if (e.data.startsWith('phase:')) return;" in src
