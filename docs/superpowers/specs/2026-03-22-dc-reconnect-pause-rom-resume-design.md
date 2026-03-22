# DC Auto-Reconnect, Background Pause, Resumable ROM Transfer

**Date:** 2026-03-22
**Status:** Draft

## Problem Statement

Three interrelated issues in lockstep netplay:

1. **Mobile late-join ROM transfer fails.** The rom-transfer DataChannel dies mid-transfer on mobile browsers (especially Safari iOS). The `onbufferedamountlow` backpressure event may never fire on Safari, causing the send loop to stall silently. When the DC dies, received chunks are abandoned and the mobile player can never boot the emulator.

2. **Alt-tab causes unrecoverable desync when DC dies.** Chrome throttles `setInterval` to ~1fps in background tabs. This causes frame drift. The existing `visibilitychange` listener resets the sync interval on tab focus, but if the WebRTC DC itself died during the background period, the resync mechanism can't work because it needs the DC to send sync-hash/sync-request messages.

3. **Alt-tab desyncs with mixed desktop/mobile players.** When a desktop player alt-tabs, their tick loop runs at ~1fps while mobile players continue at full speed. The backgrounded player accumulates stale input frames that cause all peers to stall, then desync.

## Scope

**In scope (v1):**
- Background tab pause/resume (casual mode: pause self, others continue)
- DC auto-reconnect for any DC death (background, network blip, mobile app switch)
- Resumable ROM transfer with chunk caching
- Robust ROM transfer send loop (mobile Safari fix)
- UX: toasts and overlays for disconnect/reconnect/transfer status

**Deferred (v2):**
- Competitive pause-all mode with countdown on resume
- Max away time / anti-grief protections

## Design

### 1. Background Tab Pause/Resume

When a player's tab goes hidden, their local tick loop pauses immediately. This prevents frame drift and stale input accumulation.

#### Pausing (tab hidden)

- `visibilitychange` listener detects `document.hidden === true`
- Set `_paused = true` — `tick()` returns early (no frame stepping, no input sending)
- Broadcast `"peer-paused"` string message to all peers via DC
- If DC is dead, send via Socket.IO `data-message` with `{ type: 'peer-paused', sender: socket.id }` as fallback
- Record `_pausedAtFrame = _frameNum`

#### Remote peer handling

- On receiving `"peer-paused"`: set `peer.paused = true`, zero their input slot (same as disconnect behavior), show toast "Player X paused"
- Paused peers are excluded from `getInputPeers()` so the tick loop doesn't stall waiting for their frames — game continues for remaining players

#### Resuming (tab visible)

- `visibilitychange` detects `document.hidden === false`
- If DC is alive: set `_paused = false`, broadcast `"peer-resumed"`, send `"sync-request"` to host for state resync
- If DC is dead: trigger DC auto-reconnect first (section 2), resume after reconnect succeeds
- On receiving `"peer-resumed"`: set `peer.paused = false`, show toast "Player X returned", re-include in input peers once they send their first input post-resume

#### Frame catch-up on resume

- Host responds to `"sync-request"` with compressed state (existing resync mechanism)
- Returning player loads state, syncs `_frameNum` to host's current frame, pre-fills delay buffer with zero input (same logic as late-join catch-up in `handleLateJoinState`)

### 2. DC Auto-Reconnect

When a DataChannel dies, instead of permanently removing the peer, attempt automatic reconnection via the existing Socket.IO signaling path.

#### Replacing hard disconnect

Current `handlePeerDisconnect()` behavior: zeros input, deletes peer from `_peers`, game continues solo. No reconnection path.

New behavior: if the game is running and the disconnect wasn't intentional (no `leave-room` received from server), enter reconnect state instead of deleting the peer.

#### Reconnect state

- Set `peer.reconnecting = true`, `peer.reconnectStart = Date.now()`
- Keep peer in `_peers` but it's naturally excluded from `getActivePeers()` (already filtered by `dc.readyState === 'open'`)
- Zero their input slot (game continues without them)
- Start 15-second reconnect timeout

#### Reconnect flow

The side that detected DC death initiates reconnect:

1. Close old `RTCPeerConnection`
2. Create new `RTCPeerConnection` + new lockstep DataChannel
3. Send fresh WebRTC offer via Socket.IO `webrtc-signal` with `reconnect: true` flag
4. Receiving side: if `reconnect: true`, close old PC for that peer, accept new offer, create answer
5. On DC open: send `"ready"` + `"emu-ready"`, clear `peer.reconnecting`, trigger immediate resync via `"sync-request"`
6. Skip RTT measurement on reconnect (reuse existing `DELAY_FRAMES`)

#### Who initiates

- Both sides detect DC death. To avoid duplicate offers: **lower slot initiates** (same convention as initial connection)
- Exception: if one side is paused (background tab), the visible side initiates regardless of slot order. The paused side accepts on tab return.

#### Intentional leave detection

- Server already emits `users-updated` when a player leaves via `leave-room`
- Track `_intentionalLeaves` set: when `users-updated` removes a player, add their SID
- `handlePeerDisconnect` checks: if SID is in `_intentionalLeaves`, do hard disconnect (current behavior). Otherwise, attempt reconnect.

#### UX notifications

- **Disconnected player:** spinner overlay on game canvas — "Connection lost — reconnecting..."
- **Other players:** toast — "Player X disconnected — reconnecting..."
- **On reconnect success:** overlay clears, toast — "Player X reconnected"
- **On timeout (15s):** overlay changes to "Reconnection failed — rejoin as late-join?" with action button. Other players see toast "Player X dropped"

#### Server-side

No server changes needed. Reconnect reuses existing `webrtc-signal` event for offer/answer/ICE relay. The `reconnect: true` flag is client-side metadata only.

### 3. Resumable ROM Transfer

When the rom-transfer DataChannel dies mid-transfer, keep received chunks in memory and resume after DC reconnects.

#### Joiner side (receiver)

Current behavior on DC death: sets `_romTransferInProgress = false`, abandons chunks, shows "ROM transfer interrupted."

New behavior:
- Keep `_romTransferChunks`, `_romTransferHeader`, and `bytesReceived` intact
- Set `_romTransferWaitingResume = true`
- Show "ROM transfer interrupted — reconnecting..."

#### Resume after DC reconnect

1. After the lockstep DC reconnects (section 2), host opens a new `rom-transfer` DataChannel
2. Joiner receives channel in `onExtraDataChannel`, detects `_romTransferWaitingResume === true`
3. Joiner sends JSON `{ type: 'rom-resume', offset: bytesReceived }` over the new channel
4. Host receives `rom-resume`, seeks to that byte offset in the ROM `ArrayBuffer`, sends remaining chunks via `sendRomOverChannel` starting from offset
5. Progress bar continues from where it left off

#### Host side (sender)

- `sendRomOverChannel` gains an optional `startOffset` parameter
- On receiving `rom-resume`, host calls `sendRomOverChannel(dc, peerSid, msg.offset)` to resume from the specified byte
- On receiving `rom-header` (no resume), host sends from offset 0 as before

#### Retry policy for resume

- Each resume cycle (reconnect DC → resume transfer) counts as one attempt
- Max 3 resume attempts. After 3 failed cycles, clear chunks and show "ROM transfer failed — load ROM manually"
- Each retry shows toast: "ROM transfer retry (1/3)...", "ROM transfer retry (2/3)..."

#### If reconnect itself fails

- 15-second reconnect timeout (section 2) applies
- If reconnect fails, clear chunks, show "ROM transfer failed — load ROM manually"
- Fall back to existing manual ROM drop flow

### 4. Robust ROM Transfer Send Loop

Targeted fix for the silent stall on mobile Safari, independent of the resumable transfer mechanism.

#### Problem

The current send loop at `play.js:628-645` relies on `onbufferedamountlow` for backpressure. On mobile Safari, this event may not fire reliably, causing the transfer to stall silently with no error or timeout.

#### Backpressure with timeout fallback

- After setting `onbufferedamountlow`, start a 5-second `setTimeout` fallback
- If `onbufferedamountlow` fires first, clear the timeout (normal path)
- If the timeout fires first, manually check `dc.bufferedAmount`:
  - If below threshold: clear `onbufferedamountlow`, continue sending
  - If still above threshold: retry (up to 3 times with 5s each)
  - After 3 failed retries: abort transfer with error

#### Adaptive chunk size

- Detect mobile via simple UA check (rough but sufficient for v1)
- Mobile: 16KB chunks, 256KB buffer threshold
- Desktop: 64KB chunks, 1MB buffer threshold (current behavior)

#### Send-level error handling

- Wrap each `dc.send()` in try/catch
- On throw: retry the chunk 3 times with 500ms delay between attempts
- After 3 failed chunk sends: abort transfer with error toast "ROM transfer failed — load ROM manually"
- Log every failure with context: chunk index, bytes sent, `bufferedAmount`, DC `readyState`

#### Receiver-side staleness detection

- Joiner tracks `_lastChunkReceivedAt = Date.now()` on each received chunk
- A `setInterval(3000)` watchdog checks: if `_romTransferInProgress && Date.now() - _lastChunkReceivedAt > 10000`:
  - Show toast "ROM transfer stalled — retrying..."
  - Trigger resume flow: close current rom-transfer DC, reconnect, resume from byte offset
  - This counts toward the 3-attempt resume limit (section 3)

## Files Modified

| File | Changes |
|------|---------|
| `web/static/netplay-lockstep.js` | Pause/resume protocol, DC reconnect state machine, reconnect signaling, `getInputPeers` exclusion for paused peers, UX overlay/toast hooks |
| `web/static/play.js` | Resumable ROM transfer (chunk caching, resume handshake, retry logic), robust send loop (timeout fallback, adaptive chunks, error handling, staleness watchdog), reconnect overlay UI |
| `web/static/play.html` | Reconnect spinner overlay markup |

## Testing

- Desktop: alt-tab during game, verify pause → resume → resync
- Mobile Safari: late-join with ROM sharing, verify transfer completes (or resumes after stall)
- Network blip simulation: disconnect WiFi briefly, verify DC reconnect + resync
- ROM transfer interruption: kill DC mid-transfer, verify resume from offset
- Multi-player: verify other players see correct toasts for disconnect/reconnect/pause/resume
