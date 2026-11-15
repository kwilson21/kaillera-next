"""The mesh health check: run on C-rollback ticks (specs/mesh_heal.qnt) and
decided by the per-peer machine (specs/peer_connection.qnt,
peer_connection_heal_one_side): the lower slot offers, the higher slot waits."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _src() -> str:
    return LOCKSTEP_JS.read_text()


def _function(src: str, head: str) -> str:
    start = src.index(head)
    return src[start : src.index("\n  };\n", start)]


def _health_check() -> str:
    return _function(_src(), "const _meshHealthCheck = () => {")


def test_the_check_runs_on_c_rollback_ticks_and_on_the_lockstep_path():
    src = _src()
    calls = [i for i in range(len(src)) if src.startswith("_meshHealthTick();", i)]
    assert len(calls) == 2, calls
    # The C branch: beside its TICK-PERF block, which a lockstep tick never
    # reaches; the C branch returns before the lockstep one.
    c_call = calls[0]
    assert src.rindex("TICK-PERF f=", 0, c_call) > src.rindex(
        "if (_useCRollback) {", 0, c_call
    )
    # Only the tick entry point runs the check.
    assert src.count("_meshHealthCheck();") == 1


def test_the_check_runs_once_per_traversal_of_a_check_frame():
    # A frozen sim ticks on the same frame: one check, not one per tick. Any
    # other frame forgets it, so a new match or a resync going back past a
    # checked frame checks it again.
    tick = _function(_src(), "const _meshHealthTick = () => {")
    assert (
        "if (_frameNum <= 0 || _frameNum % 300 !== 0) {\n"
        "      _lastMeshHealthFrame = -1;\n"
        "      return;"
    ) in tick
    assert "if (_lastMeshHealthFrame === _frameNum) return;" in tick
    assert tick.index("_lastMeshHealthFrame = _frameNum;") < tick.index(
        "_meshHealthCheck();"
    )


def test_a_phantom_whose_channel_does_not_read_open_is_healed():
    # The check used to skip phantoms; on a C tick the player is nearly always
    # one by the first check after a silent death (mesh_heal_c_tick_only).
    check = _health_check()
    assert "_peerPhantom" not in check
    assert (
        "_needsMeshHeal(sid, p?.dc?.readyState === 'open', !!p?.reconnecting)" in check
    )


def test_the_check_carries_out_the_machines_decision():
    check = _health_check()
    assert "_peerDriver()?.decideHeal(healFrame, {" in check
    # It offers only when the machine says so, or does not drive the player.
    assert (
        "const offers = decided === null || decided.some((command) => command.type === 'offer');"
        in check
    )
    # Otherwise it waits, logged, through the engine's own drop handling (the
    # 45 s give-up), not handlePeerDisconnect's second driver frame.
    waits = check[check.index("MESH-HEAL-WAIT f=") :]
    assert "if (!p.reconnecting) _handlePeerDisconnect(sid, p);" in waits
    assert "sendOffer(" not in waits
    assert "handlePeerDisconnect(sid)" not in check
    # The old close() of the heal frame is gone: decideHeal closes it.
    assert "type: 'heal'" not in check


def test_the_lower_slot_heals_through_the_drop_path():
    # The lower slot with an entry: reset (I2), then the engine's drop
    # handling, which marks it reconnecting, arms the 45 s give-up and offers
    # (attemptReconnect). On open, a lower slot that is not the host resyncs
    # from the host like any guest whose drop reconnected.
    check = _health_check()
    lower = check[check.index("if (offers && p && _playerSlot < info.slot) {") :]
    lower = lower[: lower.index("} else if (offers || !p) {")]
    assert lower.index("resetPeerState(p.slot, 'mesh-heal', { peer: p, sid });") < (
        lower.index("_handlePeerDisconnect(sid, p);")
    )
    assert "createPeer(" not in lower


def test_the_old_path_still_resets_the_entry_first():
    # I2: an unwatched higher slot, or a page with no entry, offers as before,
    # through resetPeerState before the new offer.
    check = _health_check()
    old = check[check.index("} else if (offers || !p) {") :]
    old = old[: old.index("} else {")]
    assert old.index("resetPeerState(p.slot, 'mesh-heal', { peer: p, sid });") < (
        old.index("createPeer(sid, info.slot, true);")
    )
    # A page that would wait but has no entry has nothing to wait on.
    assert "no entry to wait on, offering" in old


def test_a_reconnect_resets_the_guest_before_its_first_input():
    # mesh_heal RESET_ON_OPEN: the guest's open handler for a reconnecting
    # entry resets it (the phantom flag and the staleness clock go) before it
    # asks for a resync, so PEER-RECOVERED cannot ask a second time.
    src = _src()
    handler = src[
        src.index("// If this is a reconnect, clear reconnecting state and resync") :
    ]
    handler = handler[
        : handler.index("const _reconnectRequestId = _beginResyncRequest();")
    ]
    assert (
        "resetPeerState(peer.slot, 'reconnect', { peer, sid: remoteSid });" in handler
    )
    reset = _function(src, "const resetPeerState = (slot, reason, opts = {}) => {")
    assert "delete _peerLastAdvanceTime[slot];" in reset
    assert "delete _peerPhantom[slot];" in reset
