from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCKSTEP_JS = ROOT / "web/static/netplay-rollback.js"


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

    # A missing input is predicted on every screen: no menu waits for one
    # (the strict menu lockstep ran only without the C engine, and every
    # frame runs on it now, specs/engine_start.qnt).
    phase = src[src.index("const _readMenuPhase = () => {") :]
    phase = phase[: phase.index("\n  };\n")]
    assert "strictInputLockstep" not in phase
    assert "MENU-LOCKSTEP" not in src

    assert "remixMenuRollback: true," in src
    assert "if (_isSmashRemix() && !peerCaps.remixMenuRollback) {" in src
    # Still read (and ignored) from a page that sends it.
    assert "if (e.data.startsWith('phase:')) return;" in src
