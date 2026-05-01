from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCKSTEP_JS = ROOT / "web/static/netplay-rollback.js"
PLAY_JS = ROOT / "web/static/play.js"
PLAY_HTML = ROOT / "web/play.html"
PLAY_CSS = ROOT / "web/static/play.css"


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


def test_phase_lock_resolution_clears_strict_menu_wait():
    """Regression guard for Greptile P1 (commit after 582a479): the
    phase-lock-wait branch emits _emitStrictMenuWait, so the symmetric
    resolution branch (the `else` next to `if (phaseLockSlots.length)`)
    must call _clearStrictMenuWait — otherwise the overlay sticks for
    the rest of the session once the phase mismatch resolves.
    """
    src = LOCKSTEP_JS.read_text()

    # The resolution branch resets these three pieces of state in order.
    # Locate it and require _clearStrictMenuWait inside the same block.
    needle = (
        "        _phaseLockStallKey = '';\n"
        "        _phaseLockStallStartTime = 0;\n"
        "        _phaseLockLastWaitLogAt = 0;\n"
    )
    idx = src.find(needle)
    assert idx >= 0, "phase-lock resolution branch not found in expected shape"
    block = src[idx : idx + 600]
    assert "_clearStrictMenuWait()" in block, (
        "phase-lock resolution must clear the strict-menu overlay "
        "(mirror the boot-sync/JS-menu paths)"
    )


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
