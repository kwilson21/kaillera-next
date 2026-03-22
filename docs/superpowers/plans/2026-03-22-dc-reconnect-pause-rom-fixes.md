# DC Reconnect, Background Pause, ROM Transfer Fixes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix alt-tab desyncs (pause tick on background), add DC auto-reconnect when WebRTC dies but Socket.IO lives, and fix mobile ROM transfer stalls with resumable transfer.

**Architecture:** Three independent features in `netplay-lockstep.js` (pause/resume, DC reconnect) and `play.js` (ROM transfer fixes). The lockstep engine gains a `_paused` flag, a `peer.reconnecting` state, and an `onPeerReconnected` callback. The ROM transfer gains backpressure timeout fallback, adaptive chunk sizing, and resume-from-offset capability.

**Tech Stack:** Vanilla JS (existing IIFE modules), WebRTC, Socket.IO

**Spec:** `docs/superpowers/specs/2026-03-22-dc-reconnect-pause-rom-resume-design.md`

---

## Chunk 1: Background Pause/Resume

### Task 1: Add pause state and tick guard

**Files:**
- Modify: `web/static/netplay-lockstep.js:144-158` (add state vars after existing vars)
- Modify: `web/static/netplay-lockstep.js:1628-1629` (tick guard)

- [ ] **Step 1: Add pause state variables**

In `netplay-lockstep.js`, after the existing `_onUnhandledMessage` variable (line 155), add:

```javascript
var _paused = false;
var _pausedAtFrame = 0;
```

- [ ] **Step 2: Add tick() pause guard**

At the top of `tick()` (line 1628-1629), after `if (!_running) return;`, add:

```javascript
if (_paused) return;
```

- [ ] **Step 3: Commit**

```
git add web/static/netplay-lockstep.js
git commit -m "feat: add pause state and tick guard for background tabs"
```

### Task 2: Broadcast pause/resume on visibilitychange

**Files:**
- Modify: `web/static/netplay-lockstep.js:1576-1584` (replace existing visibilitychange listener)

- [ ] **Step 1: Replace visibilitychange listener**

Replace the existing listener at lines 1576-1584 with:

```javascript
document.addEventListener('visibilitychange', function () {
  if (!_running) return;
  if (document.hidden) {
    // Pause: stop ticking, notify peers
    _paused = true;
    _pausedAtFrame = _frameNum;
    console.log('[lockstep] tab hidden — paused at frame', _frameNum);
    var activePeers = getActivePeers();
    for (var i = 0; i < activePeers.length; i++) {
      try { activePeers[i].dc.send('peer-paused'); } catch (_) {}
    }
    // Socket.IO fallback if no DC peers
    if (activePeers.length === 0 && socket) {
      socket.emit('data-message', { type: 'peer-paused', sender: socket.id });
    }
  } else {
    // Resume: unpause, notify peers, request resync
    _paused = false;
    console.log('[lockstep] tab visible — resuming from frame', _pausedAtFrame);
    var activePeers2 = getActivePeers();
    for (var j = 0; j < activePeers2.length; j++) {
      try { activePeers2[j].dc.send('peer-resumed'); } catch (_) {}
    }
    if (activePeers2.length === 0 && socket) {
      socket.emit('data-message', { type: 'peer-resumed', sender: socket.id });
    }
    // Resync: if host, broadcast hash immediately. If guest, request state.
    if (_playerSlot === 0 && _syncEnabled) {
      _consecutiveResyncs = 0;
      _syncCheckInterval = _syncBaseInterval;
    } else {
      // Send sync-request to host
      var hostPeer = Object.values(_peers).find(function (p) { return p.slot === 0; });
      if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
        try { hostPeer.dc.send('sync-request'); } catch (_) {}
      }
    }
  }
});
```

- [ ] **Step 2: Commit**

```
git add web/static/netplay-lockstep.js
git commit -m "feat: broadcast pause/resume on visibilitychange"
```

### Task 3: Handle incoming pause/resume from peers

**Files:**
- Modify: `web/static/netplay-lockstep.js:745-844` (DC onmessage string handling)
- Modify: `web/static/netplay-lockstep.js:458-463` (onDataMessage for Socket.IO fallback)
- Modify: `web/static/netplay-lockstep.js:878-900` (getInputPeers)

- [ ] **Step 1: Handle peer-paused/peer-resumed in DC onmessage**

In `setupDataChannel`, inside the `ch.onmessage` handler's string section (after the `emu-ready` check around line 752), add:

```javascript
if (e.data === 'peer-paused') {
  peer.paused = true;
  if (peer.slot !== null && peer.slot !== undefined) {
    try { writeInputToMemory(peer.slot, 0); } catch (_) {}
  }
  var known = _knownPlayers[remoteSid];
  var name = known ? known.playerName : 'P' + ((peer.slot || 0) + 1);
  setStatus(name + ' paused');
  if (_config && _config.onToast) _config.onToast(name + ' paused');
  return;
}
if (e.data === 'peer-resumed') {
  peer.paused = false;
  var known2 = _knownPlayers[remoteSid];
  var name2 = known2 ? known2.playerName : 'P' + ((peer.slot || 0) + 1);
  setStatus(name2 + ' returned');
  if (_config && _config.onToast) _config.onToast(name2 + ' returned');
  return;
}
```

- [ ] **Step 2: Handle peer-paused/peer-resumed in onDataMessage (Socket.IO fallback)**

In `onDataMessage` (line 458-463), add:

```javascript
if (msg.type === 'peer-paused' && msg.sender) {
  var peer = Object.values(_peers).find(function (p) {
    return _knownPlayers[Object.keys(_peers).find(function (sid) { return _peers[sid] === p; })] !== undefined;
  });
  // Find peer by sender SID
  var senderPeer = _peers[msg.sender];
  if (senderPeer) {
    senderPeer.paused = true;
    if (senderPeer.slot !== null && senderPeer.slot !== undefined) {
      try { writeInputToMemory(senderPeer.slot, 0); } catch (_) {}
    }
    var known = _knownPlayers[msg.sender];
    var name = known ? known.playerName : 'Player';
    setStatus(name + ' paused');
    if (_config && _config.onToast) _config.onToast(name + ' paused');
  }
}
if (msg.type === 'peer-resumed' && msg.sender) {
  var senderPeer2 = _peers[msg.sender];
  if (senderPeer2) {
    senderPeer2.paused = false;
    var known2 = _knownPlayers[msg.sender];
    var name2 = known2 ? known2.playerName : 'Player';
    setStatus(name2 + ' returned');
    if (_config && _config.onToast) _config.onToast(name2 + ' returned');
  }
}
```

- [ ] **Step 3: Exclude paused peers from getInputPeers()**

In `getInputPeers()` (line 896-900), add a `.paused` check:

```javascript
function getInputPeers() {
  return getActivePeers().filter(function (p) {
    return _peerInputStarted[p.slot] && !p.paused;
  });
}
```

- [ ] **Step 4: Add onToast callback to init config and public API**

In the `init()` function config handling, ensure `_config.onToast` is accepted. In the public `NetplayLockstep` object (line 2557), no change needed — it's passed via config.

In `play.js`, where `initEngine()` calls the lockstep engine's `init()`, add `onToast: showToast` to the config object.

- [ ] **Step 5: Purge stale remote inputs after resync**

In the existing `applySyncState()` function (called when a resync state is loaded), after setting `_frameNum`, add:

```javascript
// Purge stale remote inputs above the new frame
Object.keys(_remoteInputs).forEach(function (slot) {
  var inputs = _remoteInputs[slot];
  if (!inputs) return;
  Object.keys(inputs).forEach(function (f) {
    if (parseInt(f, 10) > _frameNum + DELAY_FRAMES) delete inputs[f];
  });
});
```

- [ ] **Step 6: Commit**

```
git add web/static/netplay-lockstep.js web/static/play.js
git commit -m "feat: handle peer pause/resume messages, exclude paused peers from input"
```

---

## Chunk 2: DC Auto-Reconnect

### Task 4: Add reconnect state to handlePeerDisconnect

**Files:**
- Modify: `web/static/netplay-lockstep.js:849-876` (handlePeerDisconnect)

- [ ] **Step 1: Add reconnect path to handlePeerDisconnect**

Replace `handlePeerDisconnect` with:

```javascript
function handlePeerDisconnect(remoteSid) {
  var peer = _peers[remoteSid];
  if (!peer) return;
  if (peer._disconnectTimer) { clearTimeout(peer._disconnectTimer); peer._disconnectTimer = null; }

  // If game is running and not an intentional leave, attempt reconnect
  if (_running && !peer._intentionalLeave) {
    console.log('[lockstep] peer', remoteSid, 'DC died — attempting reconnect');

    // Zero their input but keep peer in _peers
    if (peer.slot !== null && peer.slot !== undefined) {
      try { writeInputToMemory(peer.slot, 0); } catch (_) {}
    }
    peer.reconnecting = true;
    peer.reconnectStart = Date.now();

    var known = _knownPlayers[remoteSid];
    var name = known ? known.playerName : 'P' + ((peer.slot || 0) + 1);
    setStatus(name + ' disconnected — reconnecting...');
    if (_config && _config.onToast) _config.onToast(name + ' disconnected — reconnecting...');
    if (_config && _config.onReconnecting) _config.onReconnecting(remoteSid, true);

    // Lower slot initiates reconnect (unless paused — visible side initiates)
    var shouldInitiate = (!peer.paused && _playerSlot < peer.slot) || (peer.paused);
    if (shouldInitiate) {
      attemptReconnect(remoteSid);
    }

    // 15-second timeout — give up and hard disconnect
    peer._reconnectTimeout = setTimeout(function () {
      if (!_peers[remoteSid] || !_peers[remoteSid].reconnecting) return;
      console.log('[lockstep] reconnect timeout for', remoteSid);
      hardDisconnectPeer(remoteSid);
    }, 15000);

    return;
  }

  hardDisconnectPeer(remoteSid);
}
```

- [ ] **Step 2: Add hardDisconnectPeer (extracted from old handlePeerDisconnect)**

Add after `handlePeerDisconnect`:

```javascript
function hardDisconnectPeer(remoteSid) {
  var peer = _peers[remoteSid];
  if (!peer) return;
  if (peer._reconnectTimeout) { clearTimeout(peer._reconnectTimeout); peer._reconnectTimeout = null; }

  if (peer.slot !== null && peer.slot !== undefined) {
    try { writeInputToMemory(peer.slot, 0); } catch (_) {}
    delete _remoteInputs[peer.slot];
    delete _peerInputStarted[peer.slot];
  }

  delete _peers[remoteSid];
  delete _lockstepReadyPeers[remoteSid];
  window._peers = _peers;
  console.log('[lockstep] peer hard-disconnected:', remoteSid, 'slot:', peer.slot);

  var known = _knownPlayers[remoteSid];
  var name = known ? known.playerName : 'P' + ((peer.slot || 0) + 1);

  var remaining = getActivePeers();
  if (remaining.length === 0 && _running) {
    setStatus('All peers disconnected -- running solo');
  } else if (_running) {
    var count = remaining.length + 1;
    setStatus(name + ' dropped -- ' + count + ' player' + (count > 1 ? 's' : '') + ' remaining');
  }
  if (_config && _config.onToast) _config.onToast(name + ' dropped');
  if (_config && _config.onReconnecting) _config.onReconnecting(remoteSid, false);
}
```

- [ ] **Step 3: Exclude reconnecting peers from getInputPeers**

Update `getInputPeers()` (already modified in Task 3) to also exclude reconnecting:

```javascript
function getInputPeers() {
  return getActivePeers().filter(function (p) {
    return _peerInputStarted[p.slot] && !p.paused && !p.reconnecting;
  });
}
```

- [ ] **Step 4: Commit**

```
git add web/static/netplay-lockstep.js
git commit -m "feat: reconnect state in handlePeerDisconnect with 15s timeout"
```

### Task 5: Implement attemptReconnect and handle reconnect offers

**Files:**
- Modify: `web/static/netplay-lockstep.js:548-695` (createPeer area, onWebRTCSignal)

- [ ] **Step 1: Add attemptReconnect function**

Add after `handlePeerDisconnect`/`hardDisconnectPeer`:

```javascript
function attemptReconnect(remoteSid) {
  var peer = _peers[remoteSid];
  if (!peer || !peer.reconnecting) return;

  console.log('[lockstep] initiating reconnect to', remoteSid);

  // Detach old PC handlers to prevent stale events
  if (peer.pc) {
    peer.pc.onconnectionstatechange = null;
    peer.pc.ondatachannel = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    try { peer.pc.close(); } catch (_) {}
  }

  // Create new PeerConnection
  peer.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peer.pendingCandidates = [];
  peer.remoteDescSet = false;
  peer.ready = false;

  peer.pc.onicecandidate = function (e) {
    if (e.candidate && _peers[remoteSid] === peer) {
      socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
    }
  };

  peer.pc.onconnectionstatechange = function () {
    var s = peer.pc.connectionState;
    console.log('[lockstep] reconnect peer', remoteSid, 'connection-state:', s);
    if (s === 'failed') {
      console.log('[lockstep] reconnect PC failed for', remoteSid);
      hardDisconnectPeer(remoteSid);
    }
  };

  peer.pc.ondatachannel = function (e) {
    if (e.channel.label === 'lockstep') {
      peer.dc = e.channel;
      setupDataChannel(remoteSid, peer.dc);
    } else if (_onExtraDataChannel) {
      _onExtraDataChannel(remoteSid, e.channel);
    }
  };

  // Create new DC and send offer
  peer.dc = peer.pc.createDataChannel('lockstep', { ordered: true });
  setupDataChannel(remoteSid, peer.dc);

  peer.pc.createOffer().then(function (offer) {
    return peer.pc.setLocalDescription(offer);
  }).then(function () {
    socket.emit('webrtc-signal', {
      target: remoteSid,
      offer: peer.pc.localDescription,
      reconnect: true,
    });
  }).catch(function (err) {
    console.log('[lockstep] reconnect offer failed:', err);
    hardDisconnectPeer(remoteSid);
  });
}
```

- [ ] **Step 2: Handle reconnect offers in onWebRTCSignal**

In `onWebRTCSignal` (line 658-695), add reconnect handling at the top of the offer branch. Replace the offer handling block:

```javascript
if (data.offer) {
  // Reconnect: if peer exists and reconnect flag set, replace old PC
  if (data.reconnect && _peers[senderSid]) {
    var existingPeer = _peers[senderSid];
    console.log('[lockstep] received reconnect offer from', senderSid);

    // Detach old PC
    if (existingPeer.pc) {
      existingPeer.pc.onconnectionstatechange = null;
      existingPeer.pc.ondatachannel = null;
      existingPeer.pc.onicecandidate = null;
      existingPeer.pc.ontrack = null;
      try { existingPeer.pc.close(); } catch (_) {}
    }

    // Create new PC on existing peer object (preserve slot, input state)
    existingPeer.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    existingPeer.pendingCandidates = [];
    existingPeer.remoteDescSet = false;
    existingPeer.ready = false;

    existingPeer.pc.onicecandidate = function (e) {
      if (e.candidate && _peers[senderSid] === existingPeer) {
        socket.emit('webrtc-signal', { target: senderSid, candidate: e.candidate });
      }
    };
    existingPeer.pc.onconnectionstatechange = function () {
      var s = existingPeer.pc.connectionState;
      console.log('[lockstep] reconnect peer', senderSid, 'connection-state:', s);
    };
    existingPeer.pc.ondatachannel = function (e) {
      if (e.channel.label === 'lockstep') {
        existingPeer.dc = e.channel;
        setupDataChannel(senderSid, existingPeer.dc);
      } else if (_onExtraDataChannel) {
        _onExtraDataChannel(senderSid, e.channel);
      }
    };

    peer = existingPeer;
  }

  await peer.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  await drainCandidates(peer);
  var answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  socket.emit('webrtc-signal', { target: senderSid, answer: answer });
```

- [ ] **Step 3: Clear reconnecting on DC open + resync**

In `setupDataChannel`, in the `ch.onopen` handler (line 710-731), add after the existing code:

```javascript
// If this is a reconnect, clear reconnecting state after resync
if (peer.reconnecting) {
  if (peer._reconnectTimeout) { clearTimeout(peer._reconnectTimeout); peer._reconnectTimeout = null; }
  peer.reconnecting = false;
  var known = _knownPlayers[remoteSid];
  var name = known ? known.playerName : 'P' + ((peer.slot || 0) + 1);
  setStatus(name + ' reconnected');
  if (_config && _config.onToast) _config.onToast(name + ' reconnected');
  if (_config && _config.onReconnecting) _config.onReconnecting(remoteSid, false);
  if (_config && _config.onPeerReconnected) _config.onPeerReconnected(remoteSid);
  // Request resync
  if (_playerSlot !== 0) {
    try { ch.send('sync-request'); } catch (_) {}
  } else {
    _consecutiveResyncs = 0;
    _syncCheckInterval = _syncBaseInterval;
  }
}
```

- [ ] **Step 4: Handle "leaving" DC message for intentional leave detection**

In `setupDataChannel` `onmessage` string handling, add:

```javascript
if (e.data === 'leaving') {
  peer._intentionalLeave = true;
  return;
}
```

- [ ] **Step 5: Add onReconnecting and onPeerReconnected to public API**

These are passed via the config to `init()` — no change to the public `NetplayLockstep` object needed. Just document in the init config.

- [ ] **Step 6: Commit**

```
git add web/static/netplay-lockstep.js
git commit -m "feat: DC auto-reconnect via new offer/answer exchange"
```

### Task 6: Add reconnect overlay and hook into play.js

**Files:**
- Modify: `web/play.html` (add overlay markup)
- Modify: `web/static/play.js` (hook callbacks, overlay logic, broadcast "leaving" on leave)

- [ ] **Step 1: Add reconnect overlay to play.html**

After the `game-loading` div (line 171), add:

```html
<!-- Reconnect overlay -->
<div id="reconnect-overlay" class="hidden">
  <div class="game-loading-content">
    <div class="game-loading-spinner"></div>
    <span id="reconnect-text">Connection lost — reconnecting...</span>
    <button id="reconnect-rejoin" class="hidden" style="margin-top:12px;padding:8px 16px;cursor:pointer;">Rejoin</button>
  </div>
</div>
```

- [ ] **Step 2: Wire up lockstep engine callbacks in play.js initEngine()**

In `initEngine()` where the lockstep config is constructed, add:

```javascript
onToast: showToast,
onReconnecting: function (sid, isReconnecting) {
  var overlay = document.getElementById('reconnect-overlay');
  var text = document.getElementById('reconnect-text');
  var rejoinBtn = document.getElementById('reconnect-rejoin');
  if (!overlay) return;
  if (isReconnecting) {
    overlay.classList.remove('hidden');
    if (text) text.textContent = 'Connection lost — reconnecting...';
    if (rejoinBtn) rejoinBtn.classList.add('hidden');
  } else {
    overlay.classList.add('hidden');
  }
},
onPeerReconnected: function (sid) {
  // Resume ROM transfer if waiting
  if (_romTransferWaitingResume && engine && engine.getPeerConnection) {
    startRomTransferTo(sid);
  }
},
```

- [ ] **Step 3: Handle reconnect timeout — show rejoin button**

After the `onReconnecting` callback setup, add a timeout handler. Actually, the timeout is handled in the lockstep engine which calls `hardDisconnectPeer` → `onReconnecting(sid, false)`. For the local player's own DC death, show the overlay with rejoin option.

Add a check: if the local player has no active peers and was reconnecting, show rejoin button:

```javascript
// In the onReconnecting callback, when isReconnecting is false and no active peers:
if (!isReconnecting) {
  overlay.classList.add('hidden');
  // Check if we need to show rejoin
  var info = engine && engine.getInfo ? engine.getInfo() : null;
  if (info && info.playerCount <= 1 && info.running) {
    // Show rejoin option
    overlay.classList.remove('hidden');
    if (text) text.textContent = 'Reconnection failed';
    if (rejoinBtn) {
      rejoinBtn.classList.remove('hidden');
      rejoinBtn.onclick = function () {
        overlay.classList.add('hidden');
        // Late-join rejoin
        window.location.reload();
      };
    }
  }
}
```

- [ ] **Step 4: Broadcast "leaving" before leave-room**

In `leaveGame()` in play.js, before `socket.emit('leave-room')`, add:

```javascript
// Notify peers this is intentional
if (engine && window._peers) {
  Object.values(window._peers).forEach(function (p) {
    if (p.dc && p.dc.readyState === 'open') {
      try { p.dc.send('leaving'); } catch (_) {}
    }
  });
}
```

- [ ] **Step 5: Commit**

```
git add web/play.html web/static/play.js
git commit -m "feat: reconnect overlay UI and intentional leave broadcast"
```

---

## Chunk 3: ROM Transfer Fixes

### Task 7: Robust send loop with backpressure timeout

**Files:**
- Modify: `web/static/play.js:617-650` (sendRomOverChannel)

- [ ] **Step 1: Add mobile detection and adaptive constants**

Near the top of the play.js IIFE (after the existing ROM constants around line 40), add:

```javascript
var _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
var ROM_CHUNK_SIZE = _isMobile ? 16 * 1024 : 64 * 1024;
var ROM_BUFFER_THRESHOLD = _isMobile ? 256 * 1024 : 1024 * 1024;
```

And remove the existing `var ROM_CHUNK_SIZE = 64 * 1024;` on line 40.

- [ ] **Step 2: Rewrite sendRomOverChannel with timeout fallback and retries**

Replace `sendRomOverChannel` (lines 617-650) with:

```javascript
function sendRomOverChannel(dc, peerSid, startOffset) {
  var romName = localStorage.getItem('kaillera-rom-name') || 'rom.z64';

  if (!startOffset) {
    // Fresh transfer: send header first
    var header = { type: 'rom-header', name: romName, size: _romBlob.size };
    if (_romHash) header.hash = _romHash;
    dc.send(JSON.stringify(header));
  }

  var reader = new FileReader();
  reader.onload = function () {
    var buffer = reader.result;
    var offset = startOffset || 0;
    var chunkIndex = Math.floor(offset / ROM_CHUNK_SIZE);
    var backpressureRetries = 0;
    var MAX_BACKPRESSURE_RETRIES = 3;

    function sendNextChunk() {
      if (dc.readyState !== 'open') {
        console.log('[play] ROM send: DC closed at offset', offset);
        return;
      }
      while (offset < buffer.byteLength) {
        if (dc.bufferedAmount > ROM_BUFFER_THRESHOLD) {
          // Backpressure: try onbufferedamountlow first, with timeout fallback
          backpressureRetries = 0;
          waitForDrain();
          return;
        }
        var end = Math.min(offset + ROM_CHUNK_SIZE, buffer.byteLength);
        try {
          dc.send(buffer.slice(offset, end));
        } catch (err) {
          console.log('[play] ROM send error at chunk', chunkIndex,
            'offset', offset, 'buffered', dc.bufferedAmount,
            'state', dc.readyState, err);
          retryChunk(offset, end, 0);
          return;
        }
        offset = end;
        chunkIndex++;
      }
      // All chunks sent
      dc.send(JSON.stringify({ type: 'rom-complete' }));
      console.log('[play] ROM transfer complete to', peerSid);
    }

    function waitForDrain() {
      var drainTimeout = setTimeout(function () {
        dc.onbufferedamountlow = null;
        if (dc.readyState !== 'open') return;
        if (dc.bufferedAmount <= ROM_BUFFER_THRESHOLD) {
          sendNextChunk();
        } else {
          backpressureRetries++;
          if (backpressureRetries >= MAX_BACKPRESSURE_RETRIES) {
            console.log('[play] ROM send: backpressure timeout after',
              MAX_BACKPRESSURE_RETRIES, 'retries at offset', offset);
            showToast('ROM transfer failed — load ROM manually');
            return;
          }
          console.log('[play] ROM send: backpressure retry', backpressureRetries);
          waitForDrain();
        }
      }, 5000);

      dc.onbufferedamountlow = function () {
        clearTimeout(drainTimeout);
        dc.onbufferedamountlow = null;
        backpressureRetries = 0;
        sendNextChunk();
      };
    }

    function retryChunk(chunkStart, chunkEnd, attempt) {
      if (attempt >= 3) {
        console.log('[play] ROM send: chunk retry exhausted at offset', chunkStart);
        showToast('ROM transfer failed — load ROM manually');
        return;
      }
      setTimeout(function () {
        if (dc.readyState !== 'open') return;
        try {
          dc.send(buffer.slice(chunkStart, chunkEnd));
          offset = chunkEnd;
          chunkIndex++;
          sendNextChunk();
        } catch (err) {
          console.log('[play] ROM send: retry', attempt + 1, 'failed:', err);
          retryChunk(chunkStart, chunkEnd, attempt + 1);
        }
      }, 500);
    }

    sendNextChunk();
  };
  reader.readAsArrayBuffer(_romBlob);
}
```

- [ ] **Step 3: Commit**

```
git add web/static/play.js
git commit -m "feat: robust ROM send loop with backpressure timeout and retries"
```

### Task 8: Resumable ROM transfer (receiver side)

**Files:**
- Modify: `web/static/play.js:18-40` (add module-level state)
- Modify: `web/static/play.js:654-706` (onExtraDataChannel)
- Modify: `web/static/play.js:696-703` (channel.onclose)

- [ ] **Step 1: Add module-level resume state**

After the existing ROM state variables (around line 38), add:

```javascript
var _romTransferBytesReceived = 0;
var _romTransferWaitingResume = false;
var _romTransferResumeAttempts = 0;
var _romTransferLastChunkAt = 0;
var _romTransferWatchdog = null;
```

- [ ] **Step 2: Update onExtraDataChannel for resume support**

Replace `onExtraDataChannel` (lines 654-706) with:

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

  // Resume: keep existing chunks, send resume offset
  if (_romTransferWaitingResume) {
    _romTransferWaitingResume = false;
    _romTransferInProgress = true;
    console.log('[play] resuming ROM transfer from offset', _romTransferBytesReceived);
    channel.onopen = function () {
      channel.send(JSON.stringify({ type: 'rom-resume', offset: _romTransferBytesReceived }));
    };
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'rom-resume', offset: _romTransferBytesReceived }));
    }
  } else {
    // Fresh transfer
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferBytesReceived = 0;
    _romTransferResumeAttempts = 0;
  }

  _romTransferInProgress = true;
  _romTransferLastChunkAt = Date.now();
  startRomTransferWatchdog();

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
          _romTransferBytesReceived = 0;
          updateRomProgress(0, msg.size);
        } else if (msg.type === 'rom-complete') {
          stopRomTransferWatchdog();
          finishRomTransfer();
        }
      } catch (_) {}
    } else if (e.data instanceof ArrayBuffer) {
      _romTransferChunks.push(new Uint8Array(e.data));
      _romTransferBytesReceived += e.data.byteLength;
      _romTransferLastChunkAt = Date.now();
      if (_romTransferHeader) {
        updateRomProgress(_romTransferBytesReceived, _romTransferHeader.size);
      }
    }
  };

  channel.onclose = function () {
    if (_romTransferInProgress && !_romBlob) {
      _romTransferInProgress = false;
      _romTransferDC = null;
      stopRomTransferWatchdog();

      if (_romTransferResumeAttempts < 3 && _romTransferBytesReceived > 0) {
        _romTransferResumeAttempts++;
        _romTransferWaitingResume = true;
        showToast('ROM transfer interrupted — retry ' + _romTransferResumeAttempts + '/3');
      } else {
        showToast('ROM transfer failed — load ROM manually');
        _romTransferChunks = [];
        _romTransferWaitingResume = false;
        updateRomSharingUI();
      }
    }
  };

  updateRomSharingUI();
}
```

- [ ] **Step 3: Add staleness watchdog**

Add after `onExtraDataChannel`:

```javascript
function startRomTransferWatchdog() {
  stopRomTransferWatchdog();
  _romTransferWatchdog = setInterval(function () {
    if (!_romTransferInProgress || _romTransferWaitingResume) return;
    if (Date.now() - _romTransferLastChunkAt > 10000) {
      console.log('[play] ROM transfer stalled — triggering resume');
      showToast('ROM transfer stalled — retrying...');
      if (_romTransferDC) {
        try { _romTransferDC.close(); } catch (_) {}
      }
      // onclose handler will set _romTransferWaitingResume
    }
  }, 3000);
}

function stopRomTransferWatchdog() {
  if (_romTransferWatchdog) {
    clearInterval(_romTransferWatchdog);
    _romTransferWatchdog = null;
  }
}
```

- [ ] **Step 4: Handle rom-resume on host side**

In `startRomTransferTo`, update the DC `onmessage` to handle resume requests. Add after `dc.onopen`:

```javascript
dc.onmessage = function (e) {
  if (typeof e.data === 'string') {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'rom-resume' && msg.offset >= 0) {
        console.log('[play] ROM resume requested from offset', msg.offset);
        sendRomOverChannel(dc, peerSid, msg.offset);
      }
    } catch (_) {}
  }
};
```

- [ ] **Step 5: Commit**

```
git add web/static/play.js
git commit -m "feat: resumable ROM transfer with staleness watchdog"
```

### Task 9: Manual test

- [ ] **Step 1: Test alt-tab pause/resume**

1. Open two browser windows in lockstep
2. Alt-tab away from one — verify game pauses for that player, toast shows on other
3. Alt-tab back — verify resync and game continues

- [ ] **Step 2: Test ROM transfer on mobile (or mobile emulation)**

1. Enable ROM sharing on host
2. Join from mobile browser (or Chrome DevTools mobile emulation)
3. Verify ROM transfer completes with smaller chunks
4. If transfer stalls, verify watchdog triggers retry

- [ ] **Step 3: Final commit**

```
git add -A
git commit -m "feat: DC reconnect, background pause, ROM transfer fixes"
```
