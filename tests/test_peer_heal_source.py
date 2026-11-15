"""The mesh health check is decided by the per-peer machine (specs/peer_connection.qnt,
peer_connection_heal_one_side): the lower slot offers, the higher slot waits."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _health_check() -> str:
    src = LOCKSTEP_JS.read_text()
    start = src.index("// Mesh health check (~5s): reconcile _knownPlayers")
    return src[start : src.index("_remoteApplied++;", start)]


def test_the_health_check_carries_out_the_machines_decision():
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
