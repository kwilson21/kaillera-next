# DC Reconnect, Background Pause, ROM Transfer Fixes

**Date:** 2026-03-22
**Status:** Draft

## Problem Statement

1. **Mobile ROM transfer fails.** The `onbufferedamountlow` backpressure event doesn't fire reliably on mobile Safari, silently stalling the send loop. When the DC dies, chunks are lost.

2. **Alt-tab causes desyncs.** Chrome throttles `setInterval` to ~1fps in background tabs. The backgrounded player drifts and accumulates stale input that stalls other players. If the DC dies while backgrounded, resync can't work.

3. **Mixed desktop/mobile desyncs.** Desktop player alt-tabs, mobile player keeps going at 60fps. Same root cause as #2.

## Design

### 1. Background Pause/Resume

- `visibilitychange` → hidden: set `_paused = true`, `tick()` returns early. Broadcast `"peer-paused"` string over DC.
- Remote peers: set `peer.paused = true`, zero their input, exclude from `getInputPeers()`. Show toast "Player X paused".
- `visibilitychange` → visible: set `_paused = false`, broadcast `"peer-resumed"`. If not host, send `"sync-request"` for state resync. If host, broadcast `sync-hash` immediately so guests can detect drift and request resync.
- Remote peers: set `peer.paused = false`, show toast "Player X returned". Re-include in input peers once they send input.
- After resync, purge `_remoteInputs[slot]` entries above the new `_frameNum`.

### 2. DC Reconnect

Only applies when Socket.IO is still connected but the WebRTC DC died (common alt-tab scenario on desktop).

- `handlePeerDisconnect` change: if game is running, instead of deleting the peer, set `peer.reconnecting = true` and keep them in `_peers`. Zero their input, exclude from `getInputPeers()`.
- Reconnect: close old PC (detach handlers first), create new PC + DC, send offer via existing `webrtc-signal`. Lower slot initiates.
- `onWebRTCSignal` change: when `reconnect: true` and peer already exists, replace the old PC with a new one instead of calling `setRemoteDescription` on the stale PC.
- On DC open + resync complete: clear `peer.reconnecting`.
- 15-second timeout. If it fails, hard disconnect — player can rejoin via existing late-join.
- If Socket.IO itself died (mobile background kills WebSocket), don't fight it. Player gets a new SID on reconnect and uses the existing late-join flow.

#### UX

- Disconnected player: overlay "Connection lost — reconnecting..."
- Other players: toast "Player X disconnected — reconnecting..."
- Success: clear overlay, toast "Player X reconnected"
- Timeout: overlay "Reconnection failed" with "Rejoin" button (triggers late-join). Others see "Player X dropped"

### 3. ROM Transfer Fixes

#### Backpressure timeout fallback

After setting `onbufferedamountlow`, start a 5-second `setTimeout`. If the event doesn't fire, manually check `bufferedAmount` and continue if drained. Retry up to 3 times before aborting.

#### Adaptive chunks

Mobile (UA check): 16KB chunks, 256KB buffer threshold. Desktop: 64KB/1MB (current).

#### Error handling

Wrap `dc.send()` in try/catch. Retry failed chunks 3 times with 500ms delay. Log failures with context. Abort with toast on persistent failure.

#### Receiver staleness watchdog

Track `_romTransferLastChunkAt`. If no chunk for 10 seconds, show toast "ROM transfer stalled" and trigger resume.

#### Resumable transfer

- On DC death mid-transfer: keep `_romTransferChunks` and promote `bytesReceived` to module-level `_romTransferBytesReceived`. Set `_romTransferWaitingResume = true`.
- After DC reconnects: joiner sends `{ type: 'rom-resume', offset }`, host resumes from that byte offset.
- `onExtraDataChannel`: if `_romTransferWaitingResume`, skip chunk reset and send resume message instead.
- Max 3 resume attempts. After that: "ROM transfer failed — load ROM manually".

## Files Modified

| File | Changes |
|------|---------|
| `web/static/netplay-lockstep.js` | Pause/resume, DC reconnect state machine, `onWebRTCSignal` reconnect path, `getInputPeers` exclusions |
| `web/static/play.js` | ROM transfer fixes (timeout fallback, adaptive chunks, error handling, staleness watchdog, resumable transfer) |
| `web/static/play.html` | Reconnect overlay markup |

## Testing

- Alt-tab during game → pause/resume/resync
- Alt-tab as host → host resync path
- Mobile Safari ROM transfer → completes or resumes after stall
- Network blip → DC reconnect + resync
- ROM transfer interruption → resume from offset
- Reconnect timeout → late-join fallback
