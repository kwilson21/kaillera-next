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
    src = ENGINE_JS.read_text()
    body = _function_body(src, "_switchInputsToReliable")

    # Capped from the newest input made, not from _frameNum: a switch between
    # ticks comes before the input for _frameNum exists.
    assert (
        "const newest = Object.prototype.hasOwnProperty.call(_localInputs, _frameNum) ? _frameNum : _frameNum - 1;"
        in body
    )
    assert "window.KNCore.framesToSendAgain(ack, newest, RB_RESEND_AT_SWITCH_MAX)" in body
    assert "const ack = peer.lastAckFromPeer ?? -1;" in body
    assert "_resendAtSwitch[peer.slot] = { from: frames[0], upTo: frames.at(-1), ack };" in body
    assert "_sendResendAtSwitch(peer);" in body

    send = _function_body(src, "_sendResendAtSwitch")
    # From the inputs the page keeps, not the redundancy history the cap cuts.
    assert "const input = _localInputs[kept.from];" in send
    assert "_rbLocalHistory" not in send
    # On the reliable channel, one packet per frame, and no wait (I1).
    assert "peer.dc.send(KNShared.encodeInput(kept.from, input" in send
    assert "rbDc" not in send
    assert "setTimeout" not in send and "await" not in send
    assert "_rbLocalHistory" not in body and "rbDc" not in body


def test_a_resend_a_send_cut_short_is_finished_on_the_next_ticks():
    # specs/input_transport.qnt, RETRY_UNSENT: a send can throw partway; the
    # frames from there on stay kept and each tick sends them first.
    src = ENGINE_JS.read_text()
    send = _function_body(src, "_sendResendAtSwitch")
    loop = send[send.index("while (kept.from <= kept.upTo) {") : send.index("} catch (err) {")]
    # The kept start moves past a frame only once its send returned.
    assert loop.index("peer.dc.send(") < loop.index("kept.from++;")
    # Done: forgotten. Cut short: kept.
    assert loop.rstrip().endswith("delete _resendAtSwitch[peer.slot];")
    catch = send[send.index("} catch (err) {") :]
    assert "delete _resendAtSwitch" not in catch
    # Every kept frame is sent, not only those after the ack: on the reliable
    # channel the ack can pass a frame the peer is missing.
    assert "lastAckFromPeer" not in send

    tick_send = src[src.index("let _sendFails = 0;") :]
    tick_send = tick_send[: tick_send.index("const peerBuf = KNShared.encodeInput(")]
    assert "if (_resendAtSwitch[peer.slot]) _sendResendAtSwitch(peer);" in tick_send


def test_the_kept_resend_is_per_peer_state_cleared_with_it():
    # I2: cleared in resetPeerState, with a late joiner's pending inputs, and
    # with every input timeline.
    src = ENGINE_JS.read_text()
    # One per-slot clear, which resetPeerState and _markPendingLateJoinPeer
    # both call; one map reset for every input timeline.
    table = src[src.index("const _slotInputMaps = () => [") :]
    table = table[: table.index("];")]
    assert "    _resendAtSwitch,\n" in table and "    _inputAskedAt,\n" in table
    slot_clear = src[src.index("const _clearSlotInputState = (slot) => {") :]
    slot_clear = slot_clear[: slot_clear.index("\n  };\n")]
    assert "for (const map of _slotInputMaps()) delete map[slot];" in slot_clear
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "_clearSlotInputState(slot);" in reset
    maps = src[src.index("const _resetInputMaps = () => {") :]
    maps = maps[: maps.index("\n  };\n")]
    assert "for (const map of _slotInputMaps()) for (const slot in map) delete map[slot];" in maps
    clear = src[src.index("const _clearInputsForNewMatch = (reason) => {") :]
    clear = clear[: clear.index("\n  };\n")]
    assert "_resetInputMaps();" in clear
    # Every place the tables are cleared (the declarations aside) is the one reset.
    assert src.count("_resendAtSwitch = {};") == src.count("let _resendAtSwitch = {};") == 1
    # A new match and stop() (the old path's fast-forward, the third, is gone).
    assert src.count("_resetInputMaps();") == 2


def test_the_comment_no_longer_promises_redundancy_carries_the_gap():
    src = ENGINE_JS.read_text()

    assert "first reliable packet carries" not in src
    assert "GGPO redundancy covers\n  // the brief gap" not in src


def test_only_the_host_sets_the_transport():
    # The message is host-authoritative; acted on from a guest, any player
    # could flip it, and each flip to reliable resends up to
    # RB_RESEND_AT_SWITCH_MAX inputs to every peer.
    src = ENGINE_JS.read_text()
    handler = src[src.index("if (e.data.startsWith('rb-transport:')) {") :]
    handler = handler[: handler.index("\n        }\n        // State sync: hash check from host")]
    guard = handler.index("if (_peers[remoteSid]?.slot !== 0) {")
    assert guard < handler.index("_switchInputsToReliable('rb-transport')")
    assert guard < handler.index("_rbTransport = mode")
    assert "return;" in handler[guard : handler.index("_switchInputsToReliable('rb-transport')")]
