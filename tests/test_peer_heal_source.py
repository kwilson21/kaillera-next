"""The mesh health check: run on C-rollback ticks (specs/mesh_heal.qnt) and
decided by the per-peer machine (specs/peer_connection.qnt,
peer_connection_heal_one_side): the lower slot offers, the higher slot waits."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _src() -> str:
    return LOCKSTEP_JS.read_text()


def _health_check() -> str:
    src = _src()
    start = src.index("const _meshHealthCheck = () => {")
    return src[start : src.index("\n  };\n", start)]


def test_the_check_runs_on_c_rollback_ticks_and_on_the_lockstep_path():
    src = _src()
    calls = [i for i in range(len(src)) if src.startswith("_meshHealthCheck();", i)]
    assert len(calls) == 2, calls
    # The C branch: beside its TICK-PERF block, which a lockstep tick never reaches.
    c_call = src.index(
        "if (_frameNum > 0 && _frameNum % 300 === 0) _meshHealthCheck();"
    )
    assert src.rindex("TICK-PERF f=", 0, c_call) > src.rindex(
        "if (_useCRollback) {", 0, c_call
    )
    # The C branch returns before the lockstep one.
    lockstep_call = src.index("if (_frameNum % 300 === 0) _meshHealthCheck();")
    assert c_call < lockstep_call


def test_the_check_runs_once_per_frame():
    # A frozen sim ticks on the same frame: one check, not one per tick.
    check = _health_check()
    assert check.startswith(
        "const _meshHealthCheck = () => {\n"
        "    if (_lastMeshHealthFrame === _frameNum) return;\n"
        "    _lastMeshHealthFrame = _frameNum;"
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
        "if (decided === null || decided.some((command) => command.type === 'offer')) {"
        in check
    )
    assert check.index("decided === null") < check.index(
        "sendOffer(sid, { reconnect: true });"
    )
    # Otherwise it waits, logged, through the engine's own drop handling (the
    # 45 s give-up), not handlePeerDisconnect's second driver frame.
    assert "MESH-HEAL-WAIT f=" in check
    assert "if (!p.reconnecting) _handlePeerDisconnect(sid, p);" in check
    assert "handlePeerDisconnect(sid)" not in check
    # The old close() of the heal frame is gone: decideHeal closes it.
    assert "type: 'heal'" not in check


def test_the_offering_path_still_resets_the_entry_first():
    # I2: per-peer cleanup goes through resetPeerState before the new offer.
    check = _health_check()
    offering = check[
        check.index("if (decided === null") : check.index(
            "} else {", check.index("if (decided === null")
        )
    ]
    assert offering.index(
        "resetPeerState(p.slot, 'mesh-heal', { peer: p, sid });"
    ) < offering.index("createPeer(sid, info.slot, true);")


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
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "delete _peerLastAdvanceTime[slot];" in reset
    assert "delete _peerPhantom[slot];" in reset
