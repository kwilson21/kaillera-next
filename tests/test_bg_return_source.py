"""Issue #64: a backgrounded guest's tab throttles to ~1Hz (or freezes
outright), but the C rollback engine's own RB-INPUT-STALL stall holds the
other peer at most _rbInputStallThreshold() frames ahead — so the peers can
still be in step when the tab returns. _requestLifecycleFullResync used to
fast-forward _frameNum and wipe _localInputs/_remoteInputs unconditionally on
return, which drops inputs neither peer ever regenerates and desyncs the
match. When rollback kept the peers in step, the function must do nothing but
log — no fast-forward, no input wipe, no resync request, no lifecycle resync
guard — and only take that path when the peer data behind it is fresh.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROLLBACK_JS = ROOT / "web/static/netplay-rollback.js"


def test_stall_threshold_formula_is_not_duplicated():
    # The tick loop's RB-INPUT-STALL gameplay stall and
    # _requestLifecycleFullResync must agree on exactly how far ahead of a
    # peer the C rollback engine can run before its prediction budget is
    # exhausted. A second, independently-maintained copy of the formula is
    # how the two drift apart.
    src = ROLLBACK_JS.read_text()
    collapsed = re.sub(r"\s+", " ", src)

    formula = "RB_TRUE_ROLLBACK ? DELAY_FRAMES + KN_MAX_VISIBLE_ROLLBACK_DEPTH + 1 : DELAY_FRAMES + 4"
    assert collapsed.count(formula) == 1, "stall threshold formula must be defined exactly once"
    assert "const _rbInputStallThreshold = () =>" in src

    # The tick loop's gameplay stall must call the shared helper, not inline
    # its own copy of the formula.
    tick_idx = src.index("_rbBootConverged && rbApplyFrame >= 0")
    assert "const stallThreshold = _rbInputStallThreshold();" in src[tick_idx:]


def test_lifecycle_resync_skips_only_when_rollback_kept_peers_in_step():
    src = ROLLBACK_JS.read_text()
    fn_idx = src.index("const _requestLifecycleFullResync = (reason) => {")

    use_c_rollback_idx = src.index("_useCRollback", fn_idx)
    in_step_idx = src.index("_rbInputStallThreshold() * RB_LIFECYCLE_IN_STEP_SLACK", fn_idx)
    return_idx = src.index("return;", in_step_idx)
    fast_forward_idx = src.index("_frameNum = _lastRemoteFrame;", fn_idx)
    guard_idx = src.index("_beginLifecycleResyncGuard(reason);", fn_idx)

    # The rollback in-step check (and its early return) must come strictly
    # before any of the fast-forward / input-wipe / resync-guard side
    # effects, and only runs when _useCRollback is checked first.
    assert fn_idx < use_c_rollback_idx < in_step_idx < return_idx < fast_forward_idx < guard_idx

    # Skipping must not leave the guest's lifecycle resync guard armed —
    # that guard suppresses local input ("local input suppressed during
    # emulator resume ... lifecycle=true") until a resync it never requested
    # would have cleared it.
    assert "_beginLifecycleResyncGuard" not in src[in_step_idx:return_idx]

    # Behind-by amount is logged so a real desync is diagnosable.
    assert "behind=" in src[in_step_idx:return_idx]


def test_lifecycle_resync_in_step_check_has_slack_above_tick_loop_threshold():
    # A peer held right at the tick loop's own stall threshold has already
    # sent input up through guestLastSent + threshold, so a bare
    # `behind <= _rbInputStallThreshold()` comparison has zero headroom.
    src = ROLLBACK_JS.read_text()

    assert "const RB_LIFECYCLE_IN_STEP_SLACK = " in src
    fn_idx = src.index("const _requestLifecycleFullResync = (reason) => {")
    assert "_rbInputStallThreshold() * RB_LIFECYCLE_IN_STEP_SLACK" in src[fn_idx:]


def test_lifecycle_resync_requires_fresh_peer_advance_before_skipping():
    # A tab that was fully frozen (not merely throttled to ~1Hz — iOS/Chrome
    # intensive throttling, bfcache) can leave a stale _lastRemoteFrame
    # reading: visibilitychange may fire before the queued packets land, so
    # the old frame would misread as "in step" and skip a resync that's
    # actually needed. The skip must only fire when every live (non-phantom)
    # input peer has advanced within MAX_STALL_MS of now.
    src = ROLLBACK_JS.read_text()
    fn_idx = src.index("const _requestLifecycleFullResync = (reason) => {")
    in_step_idx = src.index("_rbInputStallThreshold() * RB_LIFECYCLE_IN_STEP_SLACK", fn_idx)

    input_peers_idx = src.index("getInputPeers()", fn_idx)
    phantom_filter_idx = src.index("_peerPhantom[p.slot]", fn_idx)
    advance_time_idx = src.index("_peerLastAdvanceTime[p.slot]", fn_idx)
    max_stall_idx = src.index("MAX_STALL_MS", fn_idx)
    stale_log_idx = src.index("staleMs=", fn_idx)

    assert fn_idx < input_peers_idx < in_step_idx
    assert fn_idx < phantom_filter_idx < in_step_idx
    assert fn_idx < advance_time_idx < in_step_idx
    assert fn_idx < max_stall_idx < in_step_idx
    assert in_step_idx < stale_log_idx

    # No live input peers at all means no fresh data to trust — fall
    # through to the old fast-forward/resync path rather than skip blind.
    length_check_idx = src.index("inputPeers.length", fn_idx)
    assert fn_idx < length_check_idx < in_step_idx
