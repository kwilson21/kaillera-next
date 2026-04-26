from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"


def test_menu_phase_lock_allows_scene_transition_grace():
    """Prod regression: guest froze at title while host reached mode select.

    The menu phase lock should still freeze true stuck phase mismatches, but
    only after a short catch-up window. Remote inputs are still required by the
    existing menu lockstep path before a local frame can advance.
    """
    src = LOCKSTEP_JS.read_text()

    assert "PHASE_TRANSITION_GRACE_FRAMES = 12" in src
    assert "let _phaseMismatchGrace = {}" in src
    assert "_phaseMismatchGrace[p.slot] = { key: mismatchKey, frame: _frameNum }" in src
    assert "_frameNum - grace.frame < PHASE_TRANSITION_GRACE_FRAMES" in src

    grace_idx = src.index("_frameNum - grace.frame < PHASE_TRANSITION_GRACE_FRAMES")
    wait_idx = src.index("if (peerPhase.frame < _frameNum) waitingPeerSlots.push(p.slot);", grace_idx)
    assert wait_idx > grace_idx


def test_menu_phase_lock_grace_state_is_cleaned_up():
    src = LOCKSTEP_JS.read_text()

    assert "delete _phaseMismatchGrace[slot];" in src
    assert "_phaseMismatchGrace = {};" in src


def test_match_loading_transition_is_not_strict_menu_lockstep():
    """Regression: peers froze at scene=22/gameStatus=0 after stage select.

    That phase is the non-controllable battle-loading transition. It should
    still be phase-aware, but it must not use the no-timeout menu stall path.
    """
    src = LOCKSTEP_JS.read_text()

    assert "const inBattleTransition = sceneCurr === 22 && gameStatus === 0;" in src
    assert (
        "const strictInputLockstep = !inBattleTransition && "
        "(inControllableMenu || (sceneCurr === 22 && gameStatus === 2));"
    ) in src
    assert "const shouldAlignPhase = phase.gameplay || phase.strictInputLockstep;" in src
    assert "const _menuLockstepActive = strictInputLockstep;" in src
    assert "getInputPeers(menuLockstepPhase.strictInputLockstep)" in src
    assert "if (menuLockstepPhase.strictInputLockstep)" in src
