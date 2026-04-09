# DataChannel Health Monitor + Rotation

**Date:** 2026-04-09
**Status:** Approved design, pending implementation

## Problem

iOS Safari's SCTP implementation silently stops delivering messages on
unordered DataChannels (`ordered: false, maxRetransmits: 0`) after ~14
packets on iPhone-to-iPhone connections. The DC stays "open",
`dc.send()` doesn't throw, but `onmessage` never fires on the remote
side. This causes permanent input starvation and game freezes.

The ordered primary DC on the same PeerConnection continues working,
confirming the issue is specific to unordered SCTP streams (likely
usrsctp congestion window behavior per
[usrsctp #584](https://github.com/sctplab/usrsctp/issues/584)).

## Solution

Monitor DC health via two complementary signals. When either detects a
stall, close the DC and create a fresh one on the same PeerConnection.
GGPO-style input redundancy (each packet carries all unACKed frames)
ensures zero input loss during rotation.

## Detection

Two checks run in the tick loop every frame:

### 1. Local: `bufferedAmount` growth

```
if rbDc.bufferedAmount > BUFFER_THRESHOLD for BUFFER_STALE_FRAMES consecutive frames:
    rotate("buffer")
```

- `BUFFER_THRESHOLD`: 2048 bytes (~100 input packets)
- `BUFFER_STALE_FRAMES`: 10 consecutive frames (~167ms)
- Catches: SCTP congestion window stuck, packets queueing locally
- Misses: silent drops where SCTP accepts and discards

### 2. Remote: ack staleness

```
if peer's ack frame hasn't advanced for ACK_STALE_MS:
    rotate("ack-stale")
```

- `ACK_STALE_MS`: 500ms
- Tracked via `peer.lastAckAdvanceTime` — updated whenever
  `peer.lastFrameFromPeer` increases (meaning peer received our packet
  and sent an ack back)
- **Initialization:** set `peer.lastAckAdvanceTime = Date.now()` when
  the first input packet is sent to that peer. This prevents a false
  positive during the initial RTT before any ack can arrive.
- Catches: silent drops, any failure mode where packets leave but
  never arrive
- Misses: nothing (if acks stop advancing, delivery has failed)

## Rotation

When either detection trigger fires:

1. `rbDc.close()` — triggers SCTP stream reset
2. `peer.rbDc = peer.pc.createDataChannel('rollback-input', { ordered: false, maxRetransmits: 0 })`
3. `setupRollbackInputDataChannel(remoteSid, peer.rbDc)`
4. Log `DC-ROTATE reason=buffer|ack-stale sid=<remoteSid> rotations=<count>`
5. Reset detection counters (bufferedAmount streak, ack timer)
6. Set cooldown: no rotation for 2000ms

The peer's `ondatachannel` handler picks up the new channel. The
handler must close the previous `peer.rbDc` before assigning the new
one to avoid leaking orphaned SCTP streams. Add
`if (peer.rbDc) peer.rbDc.close();` before `peer.rbDc = e.channel`
in the `ondatachannel` handler for the `rollback-input` label.

## Why rotation is safe

- **No input loss:** GGPO redundancy bundles up to 30 unACKed frames
  per packet. The first packet on the new DC carries all missed frames.
- **No renegotiation:** `createDataChannel()` on an existing
  PeerConnection is a lightweight SCTP stream allocation (RFC 8831).
- **No coordination:** each peer rotates independently. The peer's
  `ondatachannel` fires automatically.
- **Rollback absorbs the gap:** during the ~50-100ms rotation window,
  the rollback engine predicts (repeats last known input). When the new
  DC delivers, any misprediction triggers a rollback correction.

## Guards

- **Cooldown:** 2000ms minimum between rotations
- **Max rotations:** 10 per match. After 10, set
  `_rbTransport = 'reliable'` so inputs route through the primary DC.
  Log `DC-ROTATE-EXHAUSTED` so session logs capture the degradation.
  Packets in the old DC's send buffer are considered lost — the first
  packet on the new DC (or reliable DC after exhaustion) carries all
  unACKed frames via redundancy.
- **Only in unreliable mode:** rotation only applies when
  `_rbTransport === 'unreliable'` and `_useCRollback === true`

## Implementation scope

All changes in `web/static/netplay-lockstep.js`:

1. **State variables** (~5 lines): `_dcRotationCount`,
   `_dcRotationCooldownUntil`, `_bufferStaleStreak`,
   `_lastAckAdvanceTime` per peer
2. **Detection in tick** (~20 lines): two checks after input send,
   before `_skipFrameAdvance` gate
3. **`rotateDc(peer, reason)` function** (~15 lines): close, create,
   setup, log, reset counters
4. **Ack tracking** (~3 lines): update `peer.lastAckAdvanceTime` in
   the existing input packet handler when `lastFrameFromPeer` advances
5. **Fallback after exhaustion** (~5 lines): after 10 rotations, send
   on primary DC instead

Total: ~50 lines of new code. No server changes. No protocol changes.
No changes to the WASM core.

## Revert of dual-send

The current working tree has a dual-send approach (send on both DCs).
This should be reverted — DC rotation replaces it. With rotation, the
unreliable DC recovers automatically, maintaining low-latency
fire-and-forget semantics without reliable DC overhead.

## Testing

- **Playwright two-tab test:** verify both peers reach "Connected --
  game on!" on kn-test.thesuperhuman.us
- **iPhone-to-iPhone test:** verify DC-ROTATE fires in session logs
  and the game continues past the ~14-packet stall point
- **Laptop-to-iPhone test:** verify no spurious rotations (healthy DC
  should never trigger)
