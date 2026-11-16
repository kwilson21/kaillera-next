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
# The simulated network the two-player and mesh runs install in each page.
NETWORK = ROOT / "tests/rb-page-network.mjs"
INVARIANTS_DOC = ROOT / "docs/netplay-invariants.md"


def _send_body() -> str:
    """One guest's transfer (_sendSyncChunksTo)."""
    src = ENGINE.read_text()
    start = src.index("const _sendSyncChunksTo = async")
    return src[start : src.index("\n  };\n", start)]


def _block(src: str, start: str) -> str:
    i = src.index(start)
    return src[i : src.index("\n  };\n", i)]


def test_chunks_go_through_the_paced_sender():
    body = _send_body()
    assert "window.KNCore.syncSend.sendPaced(" in body
    assert "lowWaterBytes: SYNC_SEND_LOW_WATER" in body
    assert "buffered: () => dc.bufferedAmount" in body
    # No loop hands the chunks to the channel directly any more.
    assert not re.search(r"for \(let i = 0; i < numChunks; i\+\+\)", body)


def test_the_wait_for_room_has_a_deadline():
    src = ENGINE.read_text()
    assert re.search(r"const SYNC_SEND_STALL_MS = \d+;", src)
    assert "stallMs: SYNC_SEND_STALL_MS" in _send_body()
    assert "SYNC-SEND-STALLED" in _send_body()
    assert "SYNC_SEND_STALL_MS" in INVARIANTS_DOC.read_text()


def test_one_transfer_at_a_time_per_guest_and_guests_in_parallel():
    """#236 review, finding 1: a broadcast paced its targets one after another,
    so a guest on a congested link (up to SYNC_SEND_STALL_MS per chunk) held a
    healthy guest's transfer past that guest's 8 s request deadline. Each
    guest now has a chain of its own: one transfer at a time on its channels,
    the guests side by side."""
    src = ENGINE.read_text()
    wrapper = _block(src, "const sendSyncChunks = async (")
    assert "targets.map((t) => {" in wrapper
    assert "(_syncSendChains[t.sid] ?? Promise.resolve()).then(() =>" in wrapper
    assert "_syncSendChains[t.sid] = run.catch(() => {});" in wrapper
    # Every target's transfer is started before any is awaited.
    assert "await Promise.all(" in wrapper
    assert wrapper.count("await") == 1
    # The paced wait is inside one guest's transfer, with no loop over guests
    # around it.
    body = _send_body()
    assert "await window.KNCore.syncSend.sendPaced(" in body
    assert "for (const target of targets)" not in body
    assert "_syncSendChain " not in src and "_syncSendChain." not in src


def test_a_queued_transfer_never_reaches_a_new_connection():
    """#236 review, finding 2 (I2): a transfer queued before a reconnect looked
    its target up when it came up, and sent the old state and request id over
    the new connection (specs/tick_deadlines.qnt,
    aTransferQueuedBeforeAResetNeverReachesTheNewConnection)."""
    src = ENGINE.read_text()
    push = src[src.index("const pushSyncState = async (") :]
    # The targets and their connections are taken with the state, before any await.
    capture = push.index("const targets = _syncTargetsFor(targetSid);")
    assert push.index("const frame = _frameNum;") < capture < push.index("await ")
    assert "_syncQueueGen[targetSid] || 0" in push[capture : push.index("await ")]
    assert "sendSyncChunks(compressed, frame, isFull, targets, isProactive, requestIds, attempts)" in push
    assert "if (!_syncTargetCurrent(socketTarget)) {" in push
    targets_for = _block(src, "const _syncTargetsFor = (targetSid) => {")
    assert "epoch: _syncQueueEpoch, gen: _syncQueueGen[sid] || 0" in targets_for
    current = src[src.index("const _syncTargetCurrent = (t) =>") :]
    current = current[: current.index(";\n")]
    assert "_peers[t.sid] === t.peer" in current
    assert "window.KNCore.syncSend.transferStillFor(t.epoch, t.gen, _syncQueueEpoch, _syncQueueGen[t.sid] || 0)" in current
    body = _send_body()
    # Checked when the transfer comes up, and between chunks.
    assert body.index("if (!_syncTargetCurrent(t)) {") < body.index("dc.send(header);")
    assert "open: () => dc.readyState === 'open' && _syncTargetCurrent(t)," in body
    # resetPeerState bumps the generation and drops the chain; stop() bumps
    # the epoch and drops every chain.
    reset = _block(src, "const resetPeerState = (slot, reason, opts = {}) => {")
    assert "_syncQueueGen[opts.sid] = (_syncQueueGen[opts.sid] || 0) + 1;" in reset
    assert "delete _syncSendChains[opts.sid];" in reset
    stop = src[src.index("_syncQueueEpoch++;") :]
    assert stop.index("_syncSendChains = {};") < stop.index("\n  };\n")


def test_inputs_are_settled_only_for_a_state_that_was_sent():
    """#236 review, finding 3: the host settled the guest's inputs before the
    first chunk, and left them settled when the transfer was given up: the
    guest's late inputs from before that frame were then skipped at the host,
    which had predicted them (specs/tick_deadlines.qnt,
    inputsAreSettledOnlyForADeliveredState)."""
    body = _send_body()
    settle = body.index("_settleInputsBefore(target.slot, frame);")
    assert body.count("_settleInputsBefore(") == 1
    assert body.index("await window.KNCore.syncSend.sendPaced(") < settle
    assert "if (outcome === 'sent' && _syncTargetCurrent(t)) {" in body[:settle]
    assert "SYNC-SEND-STALLED" in body[settle:]


def test_harness_counts_queued_state_in_buffered_amount():
    src = NETWORK.read_text()
    assert "Object.defineProperty(RTCDataChannel.prototype, 'bufferedAmount'" in src
    # sync-state: everything the simulated network still holds for it; the
    # other channels: their own bytes the capped link has not carried.
    assert "this.label === 'sync-state' ? net.queued(ch) : net.unsent(ch, performance.now())" in src


def test_harness_link_is_shared_by_a_connections_channels():
    src = NETWORK.read_text()
    # LINK_KBPS: one link per RTCPeerConnection, found from the channels it
    # creates and the ones it receives.
    assert "RealPC.prototype.createDataChannel = function" in src
    assert "pc.addEventListener('datachannel', (e) => pcOf.set(e.channel, pc));" in src
    assert "addNetworkInitScript(ctx, { lat: LAT, jitter: JITTER, kbps: LINK_KBPS })" in HARNESS.read_text()


def test_a_request_during_a_transfer_is_queued_not_dropped():
    src = ENGINE.read_text()
    start = src.index("const pushSyncState = async")
    head = src[start : src.index("const gm = window.EJS_emulator?.gameManager;", start)]
    # Newest options kept; what the requests queued before carry goes with
    # them: request numbers, guests to watch, escalation attempts.
    assert "_queuedSyncPushes.set(" in head
    assert "requestIds: { ...(prev.requestIds || {}), ...(options.requestIds || {}) }," in head
    assert "watchFor: [...new Set([...(prev.watchFor || []), ...(options.watchFor || [])])]," in head
    assert "_runQueuedSyncPush();" in src[start:]
    # Per-peer state: resetPeerState drops the peer's queued push (I2), and
    # stop() all of them.
    reset = src[src.index("const resetPeerState") :]
    assert "_queuedSyncPushes.delete(opts.sid);" in reset[: reset.index("\n  };\n")]
    assert "_queuedSyncPushes.clear();" in src


def test_the_guests_chunk_deadline_is_on_progress():
    """A deadline on the whole state gave up paced transfers still arriving on
    any link below about 3.9 Mbit/s: the guest asked over Socket.IO and the host
    went on pacing the transfer it had dropped, its inputs queued behind it
    (specs/tick_deadlines.qnt, aTransferMakingProgressIsNotAbandoned,
    noChunkForATransferTheGuestDropped). Each chunk restarts it; I1 holds: no
    chunk for SYNC_CHUNK_TIMEOUT_MS still gives the transfer up."""
    src = ENGINE.read_text()
    header = src[src.index("if (e.data.startsWith('sync-start:')) {") :]
    header = header[: header.index("if (e.data.startsWith('sync-regions-start:')) {")]
    assert "_rearmSyncChunkDeadline = () => {" in header
    assert "_syncChunkTimeoutTimer = setTimeout(onChunkDeadline, SYNC_CHUNK_TIMEOUT_MS);" in header
    assert "if (sessionId !== _syncChunkSessionId) return;" in header
    assert header.count("_rearmSyncChunkDeadline();") == 1
    assert "_requestSocketFullResync('sync-chunk-timeout');" in header
    chunks = src[src.index("// Binary: sync state chunks") :]
    chunks = chunks[: chunks.index("sync-state DC but _syncExpected=0")]
    assert chunks.index("if (_syncChunks.length < _syncExpected) {") < chunks.index("_rearmSyncChunkDeadline?.();")
    assert "_rearmSyncChunkDeadline = null;" in chunks
    # A regions patch has no deadline of its own; a chunk of it must not
    # restart the last state transfer's.
    regions = src[src.index("if (e.data.startsWith('sync-regions-start:')) {") :]
    assert "_rearmSyncChunkDeadline = null;" in regions[: regions.index("return;")]
