"""The host's resync state goes to its channel a chunk at a time.

specs/tick_deadlines.qnt (`input_link`): handed a whole state at once, the
connection left the host's inputs unsent behind it for seconds, the guest
gave up on the host and ran past its prediction window, and the inputs then
arrived up to 83 frames deep (DEEP-MISPREDICT-SKIP).
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "web/static/netplay-rollback.js"
HARNESS = ROOT / "tests/rb-two-player.mjs"
INVARIANTS_DOC = ROOT / "docs/netplay-invariants.md"


def _send_body() -> str:
    src = ENGINE.read_text()
    start = src.index("const _sendSyncChunksNow = async")
    end = src.index("pushed ${isFull ? 'full' : 'delta'} state frame", start)
    return src[start:end]


def test_chunks_go_through_the_paced_sender():
    body = _send_body()
    assert "window.KNCore.syncSend.sendPaced(" in body
    assert "lowWaterBytes: CHUNK_SIZE" in body
    assert "buffered: () => dc.bufferedAmount" in body
    # No loop hands the chunks to the channel directly any more.
    assert not re.search(r"for \(let i = 0; i < numChunks; i\+\+\)", body)


def test_the_wait_for_room_has_a_deadline():
    src = ENGINE.read_text()
    assert re.search(r"const SYNC_SEND_STALL_MS = \d+;", src)
    assert "stallMs: SYNC_SEND_STALL_MS" in _send_body()
    assert "SYNC-SEND-STALLED" in _send_body()
    assert "SYNC_SEND_STALL_MS" in INVARIANTS_DOC.read_text()


def test_one_transfer_at_a_time():
    src = ENGINE.read_text()
    assert "_syncSendChain.then(() => _sendSyncChunksNow(...args))" in src


def test_harness_counts_queued_state_in_buffered_amount():
    src = HARNESS.read_text()
    assert "Object.defineProperty(RTCDataChannel.prototype, 'bufferedAmount'" in src
    assert "if (this.label !== 'sync-state') return real;" in src


def test_a_request_during_a_transfer_is_queued_not_dropped():
    src = ENGINE.read_text()
    start = src.index("const pushSyncState = async")
    head = src[start : src.index("const gm = window.EJS_emulator?.gameManager;", start)]
    assert "_queuedSyncPushes.set(targetSid || '', options);" in head
    assert "_runQueuedSyncPush();" in src[start:]
    # Per-peer state: resetPeerState drops the peer's queued push (I2), and
    # stop() all of them.
    reset = src[src.index("const resetPeerState") :]
    assert "_queuedSyncPushes.delete(opts.sid);" in reset[: reset.index("\n  };\n")]
    assert "_queuedSyncPushes.clear();" in src
