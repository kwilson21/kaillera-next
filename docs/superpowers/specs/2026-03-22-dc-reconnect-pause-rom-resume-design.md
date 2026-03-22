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
- Server-side reconnect support (preserve room slot during transient disconnects)
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
- If DC is dead, send via Socket.IO `data-message` with `{ type: 'peer-paused', sender: socket.id }` as fallback. The server's existing `data-message` relay broadcasts to all room members — no new server event needed.
- Record `_pausedAtFrame = _frameNum`

#### Remote peer handling

- On receiving `"peer-paused"` (via DC string message or `data-message` Socket.IO relay): set `peer.paused = true`, zero their input slot (same as disconnect behavior), show toast "Player X paused"
- Paused peers are excluded from `getInputPeers()` so the tick loop doesn't stall waiting for their frames — game continues for remaining players
- The `onDataMessage` handler in the lockstep engine must be extended to handle `peer-paused` and `peer-resumed` message types (currently only handles `save-state`, `late-join-state`, `request-late-join`)

#### Resuming (tab visible)

- `visibilitychange` detects `document.hidden === false`
- If DC is alive: set `_paused = false`, broadcast `"peer-resumed"`, send `"sync-request"` to host for state resync
- If DC is dead: trigger DC auto-reconnect first (section 2), resume after reconnect succeeds
- On receiving `"peer-resumed"`: set `peer.paused = false`, show toast "Player X returned", re-include in input peers once they send their first input post-resume

#### Frame catch-up on resume

- Host responds to `"sync-request"` with compressed state (existing resync mechanism)
- Returning player loads state, syncs `_frameNum` to host's current frame, pre-fills delay buffer with zero input (same logic as late-join catch-up in `handleLateJoinState`)
- After resync completes, purge stale `_remoteInputs[slot]` entries with frame numbers greater than the new synced `_frameNum` to prevent input misapplication

#### Host pause/resume

When the host (slot 0) is the one who pauses and returns:
- The host is the sync authority. When it returns, it cannot request state from itself.
- Instead, on resume the host captures its own state and broadcasts `sync-hash` immediately. If guests have drifted (they continued playing while host was paused), the guests detect the mismatch and send `sync-request`. The host responds with its state, re-syncing everyone to the host's timeline.
- This works because the host's state is "correct by definition" in the star sync topology — guests always defer to host state.

### 2. DC Auto-Reconnect

When a DataChannel dies, instead of permanently removing the peer, attempt automatic reconnection via the existing Socket.IO signaling path.

#### Socket.IO disconnect and SID change

When a mobile tab backgrounds or a network blip occurs, the Socket.IO WebSocket transport may die. This causes the server's `disconnect` handler to fire, which calls `_leave(sid)` and removes the player from the room entirely (frees their slot, emits `users-updated` without them). When Socket.IO auto-reconnects, the player gets a **new SID**.

This is the central challenge: DC-level reconnect alone is insufficient because the server-side room state is gone. The solution requires server-side support to preserve the player's slot during transient disconnects.

#### Server-side: rejoin with slot reservation

Add a new `rejoin-room` Socket.IO event that allows a player to reclaim their slot after a transient disconnect:

1. **On disconnect during `playing` status:** instead of immediately freeing the player's slot, mark it as `reserved` with a 30-second TTL. The player info stays in `room.players` but is flagged as `disconnected: true`. `users-updated` is emitted with the player marked as disconnected (not removed).
2. **`rejoin-room` event:** the reconnecting client sends `{ sessionid, player_name, slot }` (it remembers its slot from before disconnect). The server checks if that slot is reserved, assigns the new SID to the existing player entry, clears the `disconnected` flag, and emits `users-updated` with the player restored.
3. **Reservation expiry:** if the 30-second TTL expires without a rejoin, the slot is freed normally and `users-updated` is emitted with the player removed (hard disconnect).
4. **SID mapping on remaining clients:** when remaining clients receive `users-updated` with a player whose slot matches a reconnecting peer but has a new `socketId`, they update `_peers` to map the new SID to the existing peer object. This is the key bridge between the old DC-level peer tracking and the new server-side SID.

#### Intentional leave detection

- Before a player emits `leave-room` (deliberate action via `leaveGame()` in play.js), they broadcast a `"leaving"` DC string message to all peers
- Peers add the SID to `_intentionalLeaves` on receiving `"leaving"`
- `handlePeerDisconnect` checks: if SID is in `_intentionalLeaves`, do hard disconnect (current behavior). Otherwise, attempt reconnect.
- If DC is already dead when the player leaves (unusual edge case), the absence of the `"leaving"` message means it was unintentional — attempt reconnect (safe default)
- Clean up `_intentionalLeaves` on game end to prevent unbounded growth

#### Replacing hard disconnect

Current `handlePeerDisconnect()` behavior: zeros input, deletes peer from `_peers` (including `_remoteInputs[slot]` and `_peerInputStarted[slot]`), game continues solo. No reconnection path.

New behavior: if the game is running and the disconnect wasn't intentional (no `"leaving"` message received), enter reconnect state instead of deleting the peer.

#### Reconnect state

- Set `peer.reconnecting = true`, `peer.reconnectStart = Date.now()`
- Keep peer in `_peers` — it's naturally excluded from `getActivePeers()` (already filtered by `dc.readyState === 'open'`)
- Zero their input slot but **preserve `_peerInputStarted[slot]`** — this ensures the peer is immediately re-included in `getInputPeers()` once their DC reopens and they send input, rather than being treated as a fresh late-joiner
- Preserve `_remoteInputs[slot]` — stale entries above the synced frame will be purged after resync completes
- Additionally, add `peer.reconnecting` check to `getInputPeers()`: exclude peers with `reconnecting === true` even if `_peerInputStarted` is set. This prevents the tick loop from stalling on a reconnecting peer whose new DC has opened but who hasn't completed resync yet. Clear `peer.reconnecting` only after resync completes (not just DC open).
- Start 15-second reconnect timeout
- **Exception:** if the peer is in `paused` state (`peer.paused === true`), suspend the reconnect timeout. The peer may return from background well after 15 seconds. Timeout only starts when the peer sends `"peer-resumed"` or when the visible side gives up waiting.

#### Reconnect flow

1. Detach all event handlers from old `RTCPeerConnection` (set `onconnectionstatechange`, `ondatachannel`, `onicecandidate` to null) to prevent stale close/error events
2. Close old `RTCPeerConnection`
3. Create new `RTCPeerConnection` with fresh handlers, update `peer.pc` reference
4. Create new lockstep DataChannel on the new PC, update `peer.dc` reference, call `setupDataChannel()`
5. Send fresh WebRTC offer via Socket.IO `webrtc-signal` with `reconnect: true` flag
6. **Receiving side (`onWebRTCSignal` changes):** when `data.reconnect === true` and `_peers[senderSid]` already exists, do NOT call `peer.pc.setRemoteDescription` on the old PC. Instead: (a) detach old PC handlers, (b) close old PC, (c) create a new `RTCPeerConnection` with fresh handlers (similar to `createPeer` but reusing the peer object, preserving slot/input/reconnecting state), (d) set remote description on the new PC, (e) create answer and send back. If the sender has a new SID (due to Socket.IO reconnect), the receiving side maps the new SID to the existing peer using the slot number from `users-updated`.
7. On DC open: send `"ready"` + `"emu-ready"`, trigger immediate resync via `"sync-request"`. Do NOT clear `peer.reconnecting` yet — wait for resync to complete.
8. On resync complete: clear `peer.reconnecting`, re-include in `getInputPeers()`
9. Skip RTT measurement on reconnect (reuse existing `DELAY_FRAMES` — network conditions may have changed, but re-measuring adds latency to the reconnect; acceptable tradeoff for v1)

#### Who initiates

- Both sides detect DC death. To avoid duplicate offers: **lower slot initiates** (same convention as initial connection)
- Exception: if one side is paused (background tab), the **visible side always initiates** regardless of slot order
- To prevent a race when the paused player returns (they might also try to initiate): the returning player **defers for 2 seconds** after tab return. If an incoming offer arrives in that window, they accept it. If no offer arrives after 2 seconds, they initiate themselves. This avoids both sides sending offers simultaneously.

#### Reconnect completion callback

The lockstep engine exposes an `onPeerReconnected(sid)` callback to play.js. This fires after a successful reconnect (DC open + ready handshake + resync complete). Play.js uses this to:
- Resume ROM transfer if `_romTransferWaitingResume === true` (section 3)
- Clear any reconnect overlay UI

#### UX notifications

- **Disconnected player:** spinner overlay on game canvas — "Connection lost — reconnecting..."
- **Other players:** toast — "Player X disconnected — reconnecting..."
- **On reconnect success:** overlay clears, toast — "Player X reconnected"
- **On timeout (15s):** overlay changes to "Reconnection failed" with "Rejoin" button. Clicking it calls `stop()` on the lockstep engine, re-emits `join-room` with `lateJoin: true`, and re-initializes via the existing late-join flow. Other players see toast "Player X dropped"

### 3. Resumable ROM Transfer

When the rom-transfer DataChannel dies mid-transfer, keep received chunks in memory and resume after DC reconnects.

#### Joiner side (receiver)

Current behavior on DC death: sets `_romTransferInProgress = false`, abandons chunks, shows "ROM transfer interrupted."

New behavior:
- Keep `_romTransferChunks` and `_romTransferHeader` intact
- Promote `bytesReceived` from a closure variable to module-level state: `_romTransferBytesReceived`. This must persist across DC deaths since the closure in `onExtraDataChannel` is destroyed when the old DC closes.
- Set `_romTransferWaitingResume = true`
- Show "ROM transfer interrupted — reconnecting..."

#### Resume after DC reconnect

1. Lockstep engine's `onPeerReconnected(sid)` callback fires (section 2)
2. Play.js checks `_romTransferWaitingResume === true` — if so, host opens a new `rom-transfer` DataChannel via `engine.getPeerConnection(sid)`
3. Joiner receives channel in `onExtraDataChannel`. When `_romTransferWaitingResume === true`, skip the normal reset (`_romTransferChunks = []`, etc.) and instead send JSON `{ type: 'rom-resume', offset: _romTransferBytesReceived }` over the new channel
4. Host receives `rom-resume`, seeks to that byte offset in the ROM `ArrayBuffer`, sends remaining chunks via `sendRomOverChannel` starting from offset
5. Progress bar continues from where it left off

#### Host side (sender)

- `sendRomOverChannel` gains an optional `startOffset` parameter
- On receiving `rom-resume` on a rom-transfer DC, host calls `sendRomOverChannel(dc, peerSid, msg.offset)` to resume from the specified byte
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

- Joiner tracks `_lastChunkReceivedAt = Date.now()` on each received chunk (stored in module-level `_romTransferLastChunkAt`)
- A `setInterval(3000)` watchdog checks: if `_romTransferInProgress && !_romTransferWaitingResume && Date.now() - _romTransferLastChunkAt > 10000`:
  - Show toast "ROM transfer stalled — retrying..."
  - Trigger resume flow: close current rom-transfer DC, reconnect, resume from byte offset
  - This counts toward the 3-attempt resume limit (section 3)
- The `!_romTransferWaitingResume` guard prevents re-triggering the resume flow while a reconnect is already in progress
- Watchdog is cleared when transfer completes or is cancelled

## Files Modified

| File | Changes |
|------|---------|
| `server/src/api/signaling.py` | `rejoin-room` event, slot reservation with 30s TTL on disconnect during `playing` status, `users-updated` with `disconnected` flag |
| `web/static/netplay-lockstep.js` | Pause/resume protocol, DC reconnect state machine (with PC handler lifecycle, `reconnecting` flag in `getInputPeers`, stale input purge after resync), reconnect signaling (`onWebRTCSignal` new-PC-on-existing-peer path), SID remapping on `users-updated`, `onPeerReconnected` callback, `onDataMessage` extension for pause/resume/leaving types, host-pause resync path |
| `web/static/play.js` | Resumable ROM transfer (module-level `_romTransferBytesReceived`, resume handshake, retry logic), robust send loop (timeout fallback, adaptive chunks, error handling, staleness watchdog with re-trigger guard), reconnect overlay UI, `onPeerReconnected` handler for ROM resume, `rejoin-room` emit on Socket.IO reconnect |
| `web/static/play.html` | Reconnect spinner overlay markup |

## Testing

- Desktop: alt-tab during game, verify pause → resume → resync
- Desktop: alt-tab as host (slot 0), verify host-side resume + guest resync
- Mobile Safari: late-join with ROM sharing, verify transfer completes (or resumes after stall)
- Mobile Safari: background app during game, verify Socket.IO reconnect → rejoin-room → DC reconnect → resync
- Network blip simulation: disconnect WiFi briefly, verify DC reconnect + resync
- ROM transfer interruption: kill DC mid-transfer, verify resume from offset with progress continuity
- Reconnect race: both sides alt-tab and return, verify 2-second defer window prevents duplicate offers
- Multi-player: verify other players see correct toasts for disconnect/reconnect/pause/resume
- Reconnect timeout: verify 15s timeout → "Reconnection failed" overlay → rejoin-as-late-join button works
- SID change: verify that after Socket.IO reconnect with new SID, remaining clients correctly map new SID to existing peer slot
- Slot reservation expiry: verify that 30s TTL on server frees slot if player never rejoins
