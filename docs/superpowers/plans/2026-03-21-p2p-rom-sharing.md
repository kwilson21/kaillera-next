# P2P ROM Sharing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the host share their ROM file with joiners via WebRTC DataChannel (P2P, server never touches ROM data), with legal consent from both sides.

**Architecture:** Server gains a `rom_sharing` flag on Room and a toggle event. Client-side play.js handles the checkbox UI, accept/decline prompt, and chunked ROM transfer over a dedicated `rom-transfer` DataChannel. The lockstep engine gains delegation hooks so play.js can receive extra DataChannels and unhandled messages on existing peer connections.

**Tech Stack:** Python (FastAPI + python-socketio), vanilla JS, WebRTC DataChannels

**Spec:** `docs/superpowers/specs/2026-03-21-p2p-rom-sharing-design.md`

---

## Chunk 1: Server-side signaling

### Task 1: Add `rom_sharing` field to Room and update REST endpoint

**Files:**
- Modify: `server/src/api/signaling.py:57-71` (Room dataclass)
- Modify: `server/src/api/app.py:69-75` (GET /room/:id response)

- [ ] **Step 1: Add `rom_sharing` field to the Room dataclass**

In `server/src/api/signaling.py`, add the field after `rom_hash`:

```python
rom_sharing: bool = False     # whether host is sharing ROM via P2P
```

- [ ] **Step 2: Include `romSharing` in `_players_payload` (users-updated broadcasts)**

In `server/src/api/signaling.py`, update `_players_payload()` (lines 90-103) to include
`romSharing` so existing members always have the current state:

```python
def _players_payload(room: Room) -> dict:
    """Return the payload emitted in users-updated."""
    pid_to_slot = {pid: slot for slot, pid in room.slots.items()}
    return {
        "players": {
            pid: {**info, "slot": pid_to_slot.get(pid)}
            for pid, info in room.players.items()
        },
        "spectators": {
            pid: info
            for pid, info in room.spectators.items()
        },
        "owner": room.owner,
        "romSharing": room.rom_sharing,
    }
```

- [ ] **Step 3: Include `rom_sharing` in GET /room/:id response**

In `server/src/api/app.py`, add `rom_sharing` to the return dict in `get_room()`:

```python
return {
    "status": room.status,
    "player_count": len(room.players),
    "max_players": room.max_players,
    "has_password": room.password is not None,
    "rom_hash": room.rom_hash,
    "rom_sharing": room.rom_sharing,
}
```

- [ ] **Step 4: Commit**

```bash
git add server/src/api/signaling.py server/src/api/app.py
git commit -m "feat: add rom_sharing field to Room and REST endpoint"
```

### Task 2: Add `rom-sharing-toggle` Socket.IO event

**Files:**
- Modify: `server/src/api/signaling.py` (new event handler, after `end_game`)

- [ ] **Step 1: Add the event handler**

Add after the `end_game` handler (after line 376 in signaling.py):

```python
@sio.on("rom-sharing-toggle")
async def rom_sharing_toggle(sid: str, data: dict) -> str | None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return "Not in a room"
    session_id = entry[0]
    room = rooms.get(session_id)
    if room is None:
        return "Room not found"
    if room.owner != sid:
        return "Only the host can toggle ROM sharing"

    enabled = bool(data.get("enabled", False))
    room.rom_sharing = enabled
    await sio.emit("rom-sharing-updated", {"romSharing": enabled}, room=session_id)
    log.info("ROM sharing %s in room %s", "enabled" if enabled else "disabled", session_id)
    return None
```

- [ ] **Step 2: Reset `rom_sharing` on ownership transfer**

In the `_leave()` function, after `room.owner = new_owner_sid` (line 159), add:

```python
        room.rom_sharing = False
```

This resets sharing when a new host takes over (lobby ownership transfer). The mid-game host-left case already closes the room entirely.

- [ ] **Step 3: Commit**

```bash
git add server/src/api/signaling.py
git commit -m "feat: add rom-sharing-toggle event and ownership-transfer reset"
```

---

## Chunk 2: Lockstep engine delegation hooks

### Task 3: Add DataChannel delegation to lockstep engine

**Files:**
- Modify: `web/static/netplay-lockstep.js:566-571` (`ondatachannel` handler in `createPeer`)
- Modify: `web/static/netplay-lockstep.js:2308-2313` (public API)

- [ ] **Step 1: Update the `ondatachannel` handler to delegate unknown labels**

In `createPeer()`, the current code (lines 566-571) is:

```javascript
    } else {
      peer.pc.ondatachannel = function (e) {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      };
    }
```

Replace with:

```javascript
    } else {
      peer.pc.ondatachannel = function (e) {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    }
```

Also add the same delegation for the initiator side. After the `setupDataChannel` call on line 565, add an `ondatachannel` handler for future channels created by the remote side. Actually — the initiator creates `lockstep` but the *remote* creates `rom-transfer`. So the initiator (lower slot) also needs the delegation handler. Update the full block (lines 561-571):

```javascript
    if (isInitiator) {
      peer.dc = peer.pc.createDataChannel('lockstep', {
        ordered: true,
      });
      setupDataChannel(remoteSid, peer.dc);
      // Delegate non-lockstep channels created by remote
      peer.pc.ondatachannel = function (e) {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    } else {
      peer.pc.ondatachannel = function (e) {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    }
```

- [ ] **Step 2: Add the `_onExtraDataChannel` variable and setter**

Near the top of the IIFE (after the existing var declarations around line 144), add:

```javascript
  var _onExtraDataChannel = null;
  var _onUnhandledMessage = null;
```

In the public API object (line 2308), add:

```javascript
    onExtraDataChannel: function (cb) { _onExtraDataChannel = cb; },
    onUnhandledMessage: function (cb) { _onUnhandledMessage = cb; },
    getPeerConnection: function (sid) {
      var p = _peers[sid];
      return p ? p.pc : null;
    },
```

- [ ] **Step 3: Reset callbacks in `stop()`**

In the `stop()` function (around line 2305, before `_config = null;`), add:

```javascript
    _onExtraDataChannel = null;
    _onUnhandledMessage = null;
```

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add DataChannel and message delegation hooks to lockstep engine"
```

### Task 4: Add message delegation to lockstep engine

**Files:**
- Modify: `web/static/netplay-lockstep.js:670-738` (`ch.onmessage` in `setupDataChannel`)

- [ ] **Step 1: Forward unrecognized JSON messages to the delegation callback**

In `setupDataChannel`, the `onmessage` handler (line 670) processes string messages. The JSON parsing block (lines 720-737) handles known types. Add delegation for unrecognized types. Change the JSON block from:

```javascript
        if (e.data.charAt(0) === '{') {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === 'save-state')      handleSaveStateMsg(msg);
            if (msg.type === 'late-join-state')  handleLateJoinState(msg);
            if (msg.type === 'delay-ping') {
              peer.dc.send(JSON.stringify({ type: 'delay-pong', ts: msg.ts }));
            }
            if (msg.type === 'delay-pong') {
              handleDelayPong(msg.ts, peer.dc);
            }
            if (msg.type === 'lockstep-ready') {
              peer.delayValue = msg.delay || 2;
              _lockstepReadyPeers[remoteSid] = true;
              checkAllLockstepReady();
            }
          } catch (_) {}
        }
```

To:

```javascript
        if (e.data.charAt(0) === '{') {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === 'save-state')      handleSaveStateMsg(msg);
            else if (msg.type === 'late-join-state')  handleLateJoinState(msg);
            else if (msg.type === 'delay-ping') {
              peer.dc.send(JSON.stringify({ type: 'delay-pong', ts: msg.ts }));
            }
            else if (msg.type === 'delay-pong') {
              handleDelayPong(msg.ts, peer.dc);
            }
            else if (msg.type === 'lockstep-ready') {
              peer.delayValue = msg.delay || 2;
              _lockstepReadyPeers[remoteSid] = true;
              checkAllLockstepReady();
            }
            else if (_onUnhandledMessage) {
              _onUnhandledMessage(remoteSid, msg);
            }
          } catch (_) {}
        }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: delegate unrecognized DataChannel messages to play.js callback"
```

---

## Chunk 3: HTML markup and CSS

### Task 5: Add ROM sharing checkbox and disclaimer to host controls

**Files:**
- Modify: `web/play.html:74-93` (inside `#host-controls`, before `#start-btn`)
- Modify: `web/static/play.css` (new styles)

- [ ] **Step 1: Add the HTML markup**

In `web/play.html`, insert after the `#lockstep-options` div (after line 92, before the `<button id="start-btn">` line) inside `#host-controls`:

```html
        <div id="rom-sharing-options" class="host-options-row">
          <label><input type="checkbox" id="opt-rom-sharing" disabled> Share ROM with players</label>
        </div>
        <p id="rom-sharing-disclaimer" class="opt-hint rom-sharing-disclaimer" style="display:none">
          By sharing, you confirm you have the legal right to distribute this file. Recipients must own a legal copy of this game.
        </p>
```

The checkbox starts `disabled` — it's enabled by play.js once a ROM is loaded.

- [ ] **Step 2: Add the accept/decline prompt and progress bar markup**

In `web/play.html`, insert inside the ROM drop zone's parent `card-section` (after the `#rom-drop` div, around line 49), add a sibling:

```html
        <div id="rom-sharing-prompt" style="display:none">
          <p class="rom-sharing-prompt-text">The host is offering to share their ROM file with you.</p>
          <p class="rom-sharing-prompt-legal">By accepting, you confirm you own a legal copy of this game. The file is transferred directly from the host — not through any server.</p>
          <div class="rom-sharing-prompt-buttons">
            <button id="rom-accept-btn" class="small-btn">Accept</button>
            <button id="rom-decline-btn" class="small-btn">Decline — I'll load my own</button>
          </div>
        </div>
        <div id="rom-transfer-progress" style="display:none">
          <div class="rom-progress-bar-container">
            <div id="rom-progress-bar" class="rom-progress-bar"></div>
          </div>
          <p id="rom-progress-text" class="rom-status">Waiting for ROM from host...</p>
          <button id="rom-transfer-cancel" class="small-btn">Cancel</button>
        </div>
```

- [ ] **Step 3: Add CSS styles**

Append to `web/static/play.css`:

```css
/* ROM sharing */
.rom-sharing-disclaimer {
  font-size: 11px;
  color: #a88;
  margin: 2px 0 4px 0;
  line-height: 1.3;
}

#rom-sharing-prompt {
  text-align: center;
  padding: 1rem;
}

.rom-sharing-prompt-text {
  font-size: 14px;
  color: #ccc;
  margin-bottom: 8px;
}

.rom-sharing-prompt-legal {
  font-size: 11px;
  color: #a88;
  margin-bottom: 12px;
  line-height: 1.3;
}

.rom-sharing-prompt-buttons {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
}

.rom-progress-bar-container {
  background: #2a2a40;
  border-radius: 4px;
  height: 8px;
  overflow: hidden;
  margin-bottom: 8px;
}

.rom-progress-bar {
  background: #6af;
  height: 100%;
  width: 0%;
  transition: width 0.2s;
  border-radius: 4px;
}

#rom-transfer-progress {
  text-align: center;
  padding: 1rem;
}
```

- [ ] **Step 4: Commit**

```bash
git add web/play.html web/static/play.css
git commit -m "feat: add ROM sharing UI markup and styles"
```

---

## Chunk 4: play.js — state, toggle, and prompt logic

### Task 6: Add ROM sharing state variables and Socket.IO listener

**Files:**
- Modify: `web/static/play.js` (state vars section, lines 22-30)
- Modify: `web/static/play.js` (connect function, around line 63)

- [ ] **Step 1: Add state variables**

After the existing state vars (after `var _pendingLateJoin = false;` on line 30), add:

```javascript
  var _romSharingEnabled = false;   // room-level: host has sharing toggled on
  var _romSharingDecision = null;   // 'accepted', 'declined', or null (page-lifetime)
  var _romTransferInProgress = false;
  var _romTransferChunks = [];
  var _romTransferHeader = null;
  var _romTransferDC = null;        // active rom-transfer DataChannel (receiver side)
  var _romTransferDCs = {};         // active rom-transfer DataChannels (sender side, keyed by sid)
  var _romAcceptPollInterval = null; // polling interval for mid-game accept signaling
  var ROM_MAX_SIZE = 128 * 1024 * 1024;  // 128MB
  var ROM_CHUNK_SIZE = 64 * 1024;        // 64KB
```

- [ ] **Step 2: Add `rom-sharing-updated` Socket.IO listener**

In the `connect()` function, after `socket.on('room-closed', onRoomClosed);` (line 66), add:

```javascript
    socket.on('rom-sharing-updated', onRomSharingUpdated);
```

- [ ] **Step 3: Implement `onRomSharingUpdated`**

Add after the `onRoomClosed` function:

```javascript
  function onRomSharingUpdated(data) {
    _romSharingEnabled = !!data.romSharing;
    updateRomSharingUI();
  }
```

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "feat: add ROM sharing state variables and socket listener"
```

### Task 7: Host toggle logic

**Files:**
- Modify: `web/static/play.js` (new functions + event wiring in init)

- [ ] **Step 1: Add the toggle handler function**

Add after `onRomSharingUpdated`:

```javascript
  function toggleRomSharing() {
    var cb = document.getElementById('opt-rom-sharing');
    if (!cb) return;
    var enabled = cb.checked;
    if (enabled && !_romBlob) {
      cb.checked = false;
      showToast('Load a ROM file before sharing');
      return;
    }
    socket.emit('rom-sharing-toggle', { enabled: enabled });
    // If disabling, close any active rom-transfer DataChannels
    if (!enabled) {
      Object.keys(_romTransferDCs).forEach(function (sid) {
        try { _romTransferDCs[sid].close(); } catch (_) {}
      });
      _romTransferDCs = {};
    }
  }
```

- [ ] **Step 2: Enable/disable checkbox when ROM loads**

In the existing `loadRomData` function, after `if (statusEl) statusEl.textContent = 'Loaded: ' + displayName;` (line 431), add:

```javascript
    // Enable ROM sharing checkbox if host
    var romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb && isHost) romShareCb.disabled = false;
```

- [ ] **Step 3: Wire up the checkbox in the init block**

In the init block (around line 1406, near the mode-select change listener), add:

```javascript
    // ROM sharing toggle
    var romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb) romShareCb.addEventListener('change', toggleRomSharing);
```

- [ ] **Step 4: Hide sharing and auto-disable when switching to streaming mode**

In the existing mode-select change handler (lines 1407-1414), update `updateOpts`:

```javascript
      var updateOpts = function () {
        var isLockstep = modeSelect.value === 'lockstep';
        lockstepOpts.style.display = isLockstep ? '' : 'none';
        // Hide ROM sharing options in streaming mode
        var romSharingRow = document.getElementById('rom-sharing-options');
        var romSharingDisclaimer = document.getElementById('rom-sharing-disclaimer');
        if (romSharingRow) romSharingRow.style.display = isLockstep ? '' : 'none';
        if (romSharingDisclaimer) romSharingDisclaimer.style.display = (!isLockstep) ? 'none' : romSharingDisclaimer.style.display;
        // Auto-disable sharing when switching to streaming
        if (!isLockstep) {
          var cb = document.getElementById('opt-rom-sharing');
          if (cb && cb.checked) {
            cb.checked = false;
            socket.emit('rom-sharing-toggle', { enabled: false });
          }
        }
      };
```

- [ ] **Step 5: Show disclaimer when checkbox is checked**

Add to the init block, after the romShareCb listener:

```javascript
    // Show/hide disclaimer based on checkbox
    var romDisclaimer = document.getElementById('rom-sharing-disclaimer');
    if (romShareCb && romDisclaimer) {
      var updateDisclaimer = function () {
        romDisclaimer.style.display = romShareCb.checked ? '' : 'none';
      };
      romShareCb.addEventListener('change', updateDisclaimer);
      updateDisclaimer();
    }
```

- [ ] **Step 6: Commit**

```bash
git add web/static/play.js
git commit -m "feat: host ROM sharing toggle with streaming mode guard"
```

### Task 8: Joiner accept/decline prompt

**Files:**
- Modify: `web/static/play.js` (new functions)

- [ ] **Step 1: Implement `updateRomSharingUI`**

This is the central UI state machine. Add:

```javascript
  function updateRomSharingUI() {
    var romDrop = document.getElementById('rom-drop');
    var prompt = document.getElementById('rom-sharing-prompt');
    var progress = document.getElementById('rom-transfer-progress');

    // Host never sees the prompt/progress
    if (isHost) return;
    // Spectators don't need ROMs
    if (isSpectator) return;

    if (_romSharingEnabled && _romSharingDecision === null) {
      // Show accept/decline prompt, hide drop zone
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = '';
      if (progress) progress.style.display = 'none';
    } else if (_romSharingEnabled && _romSharingDecision === 'accepted' && _romTransferInProgress) {
      // Transfer in progress — show progress bar
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = '';
    } else if (_romSharingEnabled && _romSharingDecision === 'accepted' && !_romTransferInProgress && _romBlob) {
      // Transfer complete — show loaded state in drop zone
      if (romDrop) { romDrop.style.display = ''; romDrop.classList.add('loaded'); }
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = 'none';
    } else {
      // Default: show normal drop zone
      if (romDrop) romDrop.style.display = '';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = 'none';
    }
  }
```

- [ ] **Step 2: Wire up accept/decline buttons in init block**

Add to the init block:

```javascript
    var romAcceptBtn = document.getElementById('rom-accept-btn');
    if (romAcceptBtn) romAcceptBtn.addEventListener('click', acceptRomSharing);

    var romDeclineBtn = document.getElementById('rom-decline-btn');
    if (romDeclineBtn) romDeclineBtn.addEventListener('click', declineRomSharing);

    var romCancelBtn = document.getElementById('rom-transfer-cancel');
    if (romCancelBtn) romCancelBtn.addEventListener('click', cancelRomTransfer);
```

- [ ] **Step 3: Implement accept/decline/cancel handlers**

```javascript
  function acceptRomSharing() {
    _romSharingDecision = 'accepted';
    _romTransferInProgress = true;
    _romTransferChunks = [];
    _romTransferHeader = null;
    updateRomSharingUI();
    // Signal host: send over DataChannel if engine is connected, else Socket.IO
    if (engine && engine.getPeerConnection) {
      // Find the host's sid — slot 0 in lastUsersData
      var hostSid = findHostSid();
      if (hostSid) {
        var pc = engine.getPeerConnection(hostSid);
        if (pc) {
          // Try to send over lockstep DC via the peers map
          var peers = window._peers || {};
          var hostPeer = peers[hostSid];
          if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
            hostPeer.dc.send(JSON.stringify({ type: 'rom-accepted' }));
            return;
          }
        }
      }
    }
    // Fallback: Socket.IO data-message
    socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
  }

  function declineRomSharing() {
    _romSharingDecision = 'declined';
    updateRomSharingUI();
  }

  function cancelRomTransfer() {
    _romTransferInProgress = false;
    _romTransferChunks = [];
    _romTransferHeader = null;
    if (_romTransferDC) {
      try { _romTransferDC.close(); } catch (_) {}
      _romTransferDC = null;
    }
    if (_romAcceptPollInterval) {
      clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = null;
    }
    updateRomSharingUI();
    showToast('ROM transfer cancelled');
  }

  function findHostSid() {
    if (!lastUsersData || !lastUsersData.players) return null;
    var players = lastUsersData.players;
    for (var pid in players) {
      if (players[pid].slot === 0) return players[pid].socketId;
    }
    return null;
  }
```

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "feat: joiner accept/decline/cancel ROM sharing prompt"
```

---

## Chunk 5: ROM transfer over WebRTC

### Task 9: Host-side ROM sending logic

**Files:**
- Modify: `web/static/play.js` (new functions)

- [ ] **Step 1: Implement `startRomTransferTo` — host sends ROM to a specific peer**

```javascript
  function startRomTransferTo(peerSid) {
    if (!_romBlob || !isHost) return;
    if (_romBlob.size > ROM_MAX_SIZE) {
      console.log('[play] ROM too large to share:', _romBlob.size);
      return;
    }
    var pc = engine && engine.getPeerConnection ? engine.getPeerConnection(peerSid) : null;
    if (!pc) {
      console.log('[play] no peer connection for', peerSid);
      return;
    }

    var dc = pc.createDataChannel('rom-transfer', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    _romTransferDCs[peerSid] = dc;

    dc.onopen = function () {
      console.log('[play] rom-transfer DC open to', peerSid);
      sendRomOverChannel(dc, peerSid);
    };
    dc.onclose = function () {
      delete _romTransferDCs[peerSid];
    };
    dc.onerror = function (e) {
      console.log('[play] rom-transfer DC error:', peerSid, e);
      delete _romTransferDCs[peerSid];
    };
  }

  function sendRomOverChannel(dc, peerSid) {
    var romName = localStorage.getItem('kaillera-rom-name') || 'rom.z64';
    var header = { type: 'rom-header', name: romName, size: _romBlob.size };
    if (_romHash) header.hash = _romHash;
    dc.send(JSON.stringify(header));

    var reader = new FileReader();
    reader.onload = function () {
      var buffer = reader.result;
      var offset = 0;

      function sendNextChunk() {
        if (dc.readyState !== 'open') return;
        while (offset < buffer.byteLength) {
          if (dc.bufferedAmount > 1024 * 1024) {
            dc.onbufferedamountlow = function () {
              dc.onbufferedamountlow = null;
              sendNextChunk();
            };
            return;
          }
          var end = Math.min(offset + ROM_CHUNK_SIZE, buffer.byteLength);
          dc.send(buffer.slice(offset, end));
          offset = end;
        }
        // All chunks sent
        dc.send(JSON.stringify({ type: 'rom-complete' }));
        console.log('[play] ROM transfer complete to', peerSid);
      }

      sendNextChunk();
    };
    reader.readAsArrayBuffer(_romBlob);
  }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "feat: host-side ROM sending with chunked DataChannel transfer"
```

### Task 10: Hook up delegation callbacks to trigger ROM sending

**Files:**
- Modify: `web/static/play.js` (in `initEngine` and new handler)

- [ ] **Step 1: Register delegation callbacks after engine init**

In `initEngine()`, after `engine.init({...});` (after line 638), add:

```javascript
    // Register ROM sharing delegation hooks
    if (engine.onExtraDataChannel) {
      engine.onExtraDataChannel(function (remoteSid, channel) {
        onExtraDataChannel(remoteSid, channel);
      });
    }
    if (engine.onUnhandledMessage) {
      engine.onUnhandledMessage(function (remoteSid, msg) {
        onUnhandledEngineMessage(remoteSid, msg);
      });
    }
```

- [ ] **Step 2: Implement the handler for `rom-accepted` messages (host side)**

```javascript
  function onUnhandledEngineMessage(remoteSid, msg) {
    if (msg.type === 'rom-accepted' && isHost && _romSharingEnabled) {
      console.log('[play] peer', remoteSid, 'accepted ROM sharing');
      startRomTransferTo(remoteSid);
    }
  }
```

- [ ] **Step 3: Handle `rom-accepted` via Socket.IO data-message fallback**

The existing `data-message` handler in the lockstep engine forwards known types. For the
Socket.IO fallback path (used when WebRTC is not yet connected for mid-game joiners), add
a listener in `connect()` after the `rom-sharing-updated` listener:

```javascript
    socket.on('data-message', onDataMessageForRomSharing);
```

And the handler. Note: `data-message` is broadcast to ALL room members (signaling.py
broadcasts with `skip_sid=sid`). Only the host should act on `rom-accepted`. Other peers
receive it but the `isHost` guard ensures they ignore it:

```javascript
  function onDataMessageForRomSharing(data) {
    if (data.type === 'rom-accepted' && isHost && _romSharingEnabled && data.sender) {
      console.log('[play] peer', data.sender, 'accepted ROM sharing (via socket)');
      startRomTransferTo(data.sender);
    }
  }
```

This listener is removed on room leave/close (page reload handles it). It fires for all
`data-message` events but the type+isHost guard makes the overhead negligible.

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "feat: wire up delegation hooks for ROM sharing initiation"
```

### Task 11: Joiner-side ROM receiving logic

**Files:**
- Modify: `web/static/play.js` (new functions)

- [ ] **Step 1: Implement `onExtraDataChannel` — receiver for `rom-transfer` channel**

```javascript
  function onExtraDataChannel(remoteSid, channel) {
    if (channel.label !== 'rom-transfer') return;
    if (_romSharingDecision !== 'accepted') {
      channel.close();
      return;
    }

    console.log('[play] received rom-transfer DataChannel from', remoteSid);
    _romTransferDC = channel;
    channel.binaryType = 'arraybuffer';
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferInProgress = true;
    var bytesReceived = 0;

    channel.onmessage = function (e) {
      if (typeof e.data === 'string') {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'rom-header') {
            if (msg.size > ROM_MAX_SIZE) {
              showToast('ROM too large — loading manually');
              channel.close();
              cancelRomTransfer();
              return;
            }
            _romTransferHeader = msg;
            bytesReceived = 0;
            updateRomProgress(0, msg.size);
          } else if (msg.type === 'rom-complete') {
            finishRomTransfer();
          }
        } catch (_) {}
      } else if (e.data instanceof ArrayBuffer) {
        _romTransferChunks.push(new Uint8Array(e.data));
        bytesReceived += e.data.byteLength;
        if (_romTransferHeader) {
          updateRomProgress(bytesReceived, _romTransferHeader.size);
        }
      }
    };

    channel.onclose = function () {
      if (_romTransferInProgress && !_romBlob) {
        showToast('ROM transfer interrupted');
        _romTransferInProgress = false;
        _romTransferDC = null;
        updateRomSharingUI();
      }
    };

    updateRomSharingUI();
  }
```

- [ ] **Step 2: Implement progress update**

```javascript
  function updateRomProgress(received, total) {
    var bar = document.getElementById('rom-progress-bar');
    var text = document.getElementById('rom-progress-text');
    var pct = total > 0 ? Math.round((received / total) * 100) : 0;
    if (bar) bar.style.width = pct + '%';
    if (text) {
      var recMB = (received / (1024 * 1024)).toFixed(1);
      var totMB = (total / (1024 * 1024)).toFixed(1);
      text.textContent = 'Receiving ROM... ' + pct + '% (' + recMB + ' / ' + totMB + ' MB)';
    }
  }
```

- [ ] **Step 3: Implement `finishRomTransfer` — reassemble, verify, load**

```javascript
  function finishRomTransfer() {
    var totalSize = 0;
    for (var i = 0; i < _romTransferChunks.length; i++) {
      totalSize += _romTransferChunks[i].byteLength;
    }

    if (_romTransferHeader && _romTransferHeader.size !== totalSize) {
      showToast('ROM transfer size mismatch — load manually');
      _romTransferInProgress = false;
      _romTransferChunks = [];
      updateRomSharingUI();
      return;
    }

    var blob = new Blob(_romTransferChunks);
    var displayName = (_romTransferHeader && _romTransferHeader.name) || 'rom.z64';
    var expectedHash = _romTransferHeader ? _romTransferHeader.hash : null;

    // Set ROM data (ephemeral — do NOT cache to IndexedDB)
    _romBlob = blob;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(blob);
    window.EJS_gameUrl = _romBlobUrl;

    _romTransferInProgress = false;
    _romTransferChunks = [];
    _romTransferDC = null;

    // Verify hash if provided
    var reader = new FileReader();
    reader.onload = function () {
      hashArrayBuffer(reader.result).then(function (hash) {
        _romHash = hash;
        if (expectedHash && hash !== expectedHash) {
          showToast('ROM hash mismatch — may cause desync');
        }
        afterRomTransferComplete(displayName);
      }).catch(function () {
        afterRomTransferComplete(displayName);
      });
    };
    reader.readAsArrayBuffer(blob);
  }

  function afterRomTransferComplete(displayName) {
    console.log('[play] ROM transfer complete:', displayName);

    // Update drop zone to show loaded state
    var romDrop = document.getElementById('rom-drop');
    var statusEl = document.getElementById('rom-status');
    if (romDrop) romDrop.classList.add('loaded');
    if (statusEl) statusEl.textContent = 'Loaded: ' + displayName + ' (from host)';

    updateRomSharingUI();

    // If we were waiting for ROM before booting (late join or connect-only mode),
    // boot the emulator now. The engine was already initialized in connect-only
    // mode (WebRTC connected, DataChannels open), but the emulator hasn't started.
    // After bootEmulator(), we need to wait for EJS_emulator to be available and
    // then the engine's normal emu-ready flow will proceed — the lockstep engine
    // polls for EJS_emulator in its checkAllEmuReady/startGameSequence flow, and
    // bootEmulator triggers EJS which eventually makes EJS_emulator available.
    if (gameRunning && !window.EJS_emulator) {
      bootEmulator();
    }
    // If we were in a pending late-join, dismiss the prompt
    if (_pendingLateJoin) {
      dismissLateJoinPrompt();
    }
  }
```

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "feat: joiner-side ROM receiving, progress, verification, and loading"
```

---

## Chunk 6: Mid-game joiner integration and edge cases

### Task 12: Mid-game joiner connect-only mode

**Files:**
- Modify: `web/static/play.js` (initEngine, mid-game join path)

- [ ] **Step 1: Update `initEngine` to support connect-only mode (no ROM)**

Change the top of `initEngine()` from:

```javascript
  function initEngine() {
    // Re-create EmulatorJS if it was destroyed (restart after end-game)
    bootEmulator();
```

To:

```javascript
  function initEngine() {
    // Re-create EmulatorJS if it was destroyed (restart after end-game)
    // Skip boot if no ROM loaded (connect-only mode for ROM sharing)
    if (_romBlob || _romBlobUrl) {
      bootEmulator();
    } else {
      console.log('[play] initEngine: connect-only mode (no ROM yet)');
    }
```

- [ ] **Step 2: Update mid-game join path to use accept/decline instead of ROM prompt**

In the `join-room` callback (around line 119-144), the code checks for mid-game join and shows `showLateJoinRomPrompt()` when no ROM is cached. Update this block. Change:

```javascript
            // If no ROM cached, show overlay with ROM drop zone so user can load one
            if (!_romBlob && !_romBlobUrl) {
              _pendingLateJoin = true;
              showLateJoinRomPrompt();
              return;
            }
```

To:

```javascript
            // If no ROM cached, check if host is sharing
            if (!_romBlob && !_romBlobUrl) {
              if (roomData.rom_sharing) {
                // Show accept/decline prompt instead of ROM drop
                _romSharingEnabled = true;
                _pendingLateJoin = true;
                showLateJoinRomPrompt();
                updateRomSharingUI();
                return;
              }
              _pendingLateJoin = true;
              showLateJoinRomPrompt();
              return;
            }
```

- [ ] **Step 3: Update `acceptRomSharing` to handle mid-game join (connect-only)**

In the `acceptRomSharing` function, after `updateRomSharingUI();`, before the DataChannel send attempt, add a path for when the engine isn't initialized yet:

```javascript
    // Mid-game join: start engine in connect-only mode to get WebRTC
    if (!engine && gameRunning) {
      initEngine();
      // The rom-accepted signal will be sent once DC opens — use a short poll.
      // Store interval ID so cancelRomTransfer/leaveGame can clean it up.
      if (_romAcceptPollInterval) clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = setInterval(function () {
        var hostSid = findHostSid();
        if (!hostSid) return;
        var peers = window._peers || {};
        var hostPeer = peers[hostSid];
        if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
          clearInterval(_romAcceptPollInterval);
          _romAcceptPollInterval = null;
          hostPeer.dc.send(JSON.stringify({ type: 'rom-accepted' }));
        }
      }, 200);
      // Timeout after 15s
      setTimeout(function () {
        if (_romAcceptPollInterval) {
          clearInterval(_romAcceptPollInterval);
          _romAcceptPollInterval = null;
        }
      }, 15000);
      return;
    }
```

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "feat: mid-game joiner connect-only mode and ROM sharing integration"
```

### Task 13: Spectator-to-player slot claim prompt

**Files:**
- Modify: `web/static/play.js` (claim-slot handling)

- [ ] **Step 1: Prompt on spectator claiming a slot when sharing is active**

Find the `claim-slot` handling in play.js. When a spectator successfully claims a slot, check if ROM sharing is active and they need a prompt. Add in `onUsersUpdated`, after detecting `isSpectator` changed to player:

In `onUsersUpdated()`, after `mySlot = entries[i].slot;` (around line 169-172), add:

```javascript
    // If we just transitioned from spectator to player, check ROM sharing
    var wasSpectator = isSpectator;
    // (isSpectator is updated elsewhere based on slot presence)
```

Actually, the simpler approach: check `_romSharingDecision` in the existing `updateRomSharingUI` which is already called on `rom-sharing-updated`. When a spectator claims a slot, `isSpectator` becomes false, and the next `rom-sharing-updated` or `users-updated` triggers the prompt naturally since `updateRomSharingUI` skips when `isSpectator` is true.

We just need to call `updateRomSharingUI()` from `onUsersUpdated` when spectator status changes:

```javascript
    // After updating slot info in onUsersUpdated, if we transitioned from
    // spectator to player and ROM sharing is on, show the prompt
    if (wasSpectator && !isSpectator && _romSharingEnabled) {
      updateRomSharingUI();
    }
```

But `isSpectator` is only updated by query params currently. We need to detect the transition. In `onUsersUpdated`, after the slot lookup loop, add:

```javascript
    // Detect spectator → player transition (via claim-slot)
    var nowPlayer = mySlot !== null && mySlot !== undefined;
    if (isSpectator && nowPlayer) {
      isSpectator = false;
      if (_romSharingEnabled && _romSharingDecision === null) {
        updateRomSharingUI();
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "feat: prompt ROM sharing when spectator claims player slot"
```

### Task 14: Edge case — host toggles off mid-transfer and ownership transfer

**Files:**
- Modify: `web/static/play.js` (onRomSharingUpdated)

- [ ] **Step 1: Handle sharing disabled while transfer is in progress**

Update `onRomSharingUpdated` to handle the disable case:

```javascript
  function onRomSharingUpdated(data) {
    var wasEnabled = _romSharingEnabled;
    _romSharingEnabled = !!data.romSharing;

    // If sharing was just disabled and we're mid-transfer, cancel
    if (wasEnabled && !_romSharingEnabled && _romTransferInProgress) {
      _romTransferInProgress = false;
      _romTransferChunks = [];
      _romTransferHeader = null;
      if (_romTransferDC) {
        try { _romTransferDC.close(); } catch (_) {}
        _romTransferDC = null;
      }
      showToast('ROM sharing disabled by host');
    }

    updateRomSharingUI();
  }
```

- [ ] **Step 2: Clean up transfer state on game-end**

In the existing `onGameEnded()` function (around line 252), add cleanup of transfer-related
variables (but NOT `_romSharingDecision` — that persists across games in same page load):

```javascript
    // Clean up ROM transfer state (decision persists for page lifetime)
    _romTransferInProgress = false;
    _romTransferChunks = [];
    _romTransferHeader = null;
    if (_romTransferDC) {
      try { _romTransferDC.close(); } catch (_) {}
      _romTransferDC = null;
    }
    Object.keys(_romTransferDCs).forEach(function (sid) {
      try { _romTransferDCs[sid].close(); } catch (_) {}
    });
    _romTransferDCs = {};
    if (_romAcceptPollInterval) {
      clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = null;
    }
```

- [ ] **Step 3: Also read `romSharing` from `users-updated` data**

In `onUsersUpdated()`, after parsing `ownerSid` (around line 163), add:

```javascript
    // Update ROM sharing state from users-updated (supplementary to rom-sharing-updated)
    if (data.romSharing !== undefined) {
      _romSharingEnabled = !!data.romSharing;
    }
```

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "feat: handle ROM sharing disabled mid-transfer and ownership changes"
```

---

## Chunk 7: Manual testing and cleanup

### Task 15: Manual smoke test

- [ ] **Step 1: Start dev server and open two browser tabs**

```bash
cd /Users/kazon/kaillera-next && python -m src.main
```

Open two tabs: host creates room, loads ROM, checks "Share ROM" checkbox.

- [ ] **Step 2: Test pre-game flow**

1. Host: load ROM, check "Share ROM" → disclaimer appears
2. Joiner tab: join room → accept/decline prompt appears (NOT rom drop zone)
3. Click Accept → progress bar shows, ROM transfers, "Loaded: name (from host)" appears
4. Host clicks Start Game → both players enter lockstep

- [ ] **Step 3: Test decline flow**

1. Joiner clicks Decline → normal ROM drop zone appears
2. Joiner loads their own ROM manually

- [ ] **Step 4: Test mid-game join flow**

1. Host starts game with one player
2. New tab joins mid-game → sees accept/decline prompt
3. Accept → ROM transfers → emulator boots → late join proceeds

- [ ] **Step 5: Test cancel and toggle-off**

1. During transfer, joiner clicks Cancel → drops back to ROM drop zone
2. Host unchecks sharing while transfer active → joiner sees toast

- [ ] **Step 6: Commit any fixes found during testing**

```bash
git add server/ web/static/play.js web/static/play.css web/play.html && git commit -m "fix: address issues found during ROM sharing smoke test"
```
