"""The switch from the unreliable input channel to the reliable one sends
the inputs the peer had not acked again (specs/input_transport.qnt,
unackedInputsAreSentAgainAtTheSwitch; tests/rb-two-player.mjs with
LOSE_INPUTS_BEFORE_FALLBACK=1 drives it in a two-player run).
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE_JS = ROOT / "web/static/netplay-rollback.js"


def _function_body(src: str, name: str) -> str:
    start = src.index(f"const {name} = (")
    end = src.index("\n  };\n", start)
    return src[start:end]


def test_both_triggers_go_through_the_one_switch():
    src = ENGINE_JS.read_text()

    # Only the switch itself and the match start (host broadcast, guest
    # adopting it, a late joiner told it) set the transport.
    assigns = re.findall(r"^\s+_rbTransport = ([^;]+);", src, re.M)
    assert "'reliable'" in assigns, "the switch sets the reliable transport"
    assert assigns.count("'reliable'") == 1, f"another place switches to reliable on its own: {assigns}"

    close_handler = src[src.index("ch.onclose = () => {", src.index("const setupRollbackInputDataChannel")) :]
    close_handler = close_handler[: close_handler.index("ch.onerror")]
    assert "_switchInputsToReliable('rb-dc-close')" in close_handler

    monitor = src[src.index("// ── DC health monitor") :]
    monitor = monitor[: monitor.index("_chk('post-input-send')")]
    assert "_switchInputsToReliable('health')" in monitor
    assert "reason=buffer" in monitor and "reason=ack-stale" in monitor


def test_the_switch_sends_every_unacked_input_from_the_kept_inputs():
    body = _function_body(ENGINE_JS.read_text(), "_switchInputsToReliable")

    assert "window.KNCore.framesToSendAgain(ack, _frameNum, RB_RESEND_AT_SWITCH_MAX)" in body
    assert "const ack = peer.lastAckFromPeer ?? -1;" in body
    # From the inputs the page keeps, not the redundancy history the cap cuts.
    assert "_localInputs[f]" in body
    assert "_rbLocalHistory" not in body
    # On the reliable channel, one packet per frame, and no wait (I1).
    assert "peer.dc.send(KNShared.encodeInput(f, input" in body
    assert "rbDc" not in body
    assert "setTimeout" not in body and "await" not in body


def test_the_switch_keeps_no_per_peer_state():
    # I2: per-peer state is cleared in resetPeerState; the switch adds none.
    body = _function_body(ENGINE_JS.read_text(), "_switchInputsToReliable")

    assert not re.search(r"\bpeer\.\w+\s*=[^=]", body)
    assert not re.search(r"\[peer\.slot\]\s*=[^=]", body)


def test_the_comment_no_longer_promises_redundancy_carries_the_gap():
    src = ENGINE_JS.read_text()

    assert "first reliable packet carries" not in src
    assert "GGPO redundancy covers\n  // the brief gap" not in src
