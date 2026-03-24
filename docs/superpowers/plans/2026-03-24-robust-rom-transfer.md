# Robust ROM Transfer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ROM transfer's scattered boolean flags with a state machine, add in-memory chunk caching across host toggle cycles, and fix the stall retry loop.

**Architecture:** Single-file refactor of `web/static/play.js`. Replace `_romTransferInProgress` + `_romTransferWaitingResume` with a `_romTransferState` enum (`idle`/`receiving`/`paused`/`resuming`/`complete`). Replace the 3s `setInterval` watchdog with a one-shot `setTimeout` that resets per chunk. Preserve chunks across all interruptions except explicit user cancel or ROM hash change.

**Tech Stack:** Vanilla JavaScript, WebRTC DataChannel, Socket.IO

**Spec:** `docs/superpowers/specs/2026-03-24-robust-rom-transfer-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `web/static/play.js:34-50` | Modify | Replace state variables |
| `web/static/play.js:517-556` | Modify | `onRomSharingUpdated` — preserve chunks on host disable |
| `web/static/play.js:591-626` | Modify | `updateRomSharingUI` — map states to UI |
| `web/static/play.js:637-715` | Modify | `acceptRomSharing`, `cancelRomTransfer` — use state machine |
| `web/static/play.js:770-819` | Modify | `startPreGameRomTransfer` — add resume support |
| `web/static/play.js:984-1067` | Modify | `onExtraDataChannel` — state-driven receive logic |
| `web/static/play.js:1069-1088` | Modify | Replace watchdog with stall timer |
| `web/static/play.js:430-447` | Modify | `onGameStarted` ROM sharing path — use state |
| `web/static/play.js:462-501` | Modify | `onGameEnded` — consolidate into `resetRomTransfer()` |
| `web/static/play.js:1642-1650` | Modify | `onPeerReconnected` — check state instead of boolean |

---

## Chunk 1: State Variables and Cleanup Functions

### Task 1: Replace state variables

**Files:**
- Modify: `web/static/play.js:34-50`

- [ ] **Step 1: Replace the boolean flags and watchdog with state machine variables**

Find lines 34-50 (the ROM transfer state block) and replace:

```javascript
// Old:
//   let _romTransferInProgress = false;
//   let _romTransferWaitingResume = false;
//   let _romTransferResumeAttempts = 0;
//   let _romTransferWatchdog = null;

// New:
  let _romTransferState = 'idle';       // 'idle' | 'receiving' | 'paused' | 'resuming' | 'complete'
  let _romTransferStallTimer = null;    // setTimeout ID — resets on each chunk
  let _romTransferResumeTimer = null;   // setTimeout ID — 15s resume timeout
  let _romTransferRetries = 0;          // auto-retry count, capped at 3
```

Keep these unchanged: `_romTransferChunks`, `_romTransferHeader`, `_romTransferDC`,
`_romTransferDCs`, `_romTransferBytesReceived`, `_romTransferLastChunkAt`.

Remove: `_romTransferInProgress` (line 34), `_romTransferWaitingResume` (line 47),
`_romTransferResumeAttempts` (line 48), `_romTransferWatchdog` (line 50).

- [ ] **Step 2: Verify no syntax errors**

Open the page in a browser, check console for parse errors. The page will be functionally
broken (references to removed vars) — that's expected and fixed in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "refactor: replace ROM transfer booleans with state machine variables"
```

### Task 2: Add resetRomTransfer and update cancelRomTransfer

**Files:**
- Modify: `web/static/play.js:702-715` (cancelRomTransfer)
- Modify: `web/static/play.js:1069-1088` (watchdog functions)

- [ ] **Step 1: Rewrite cancelRomTransfer**

Replace the existing `cancelRomTransfer` function (lines 702-715) with:

```javascript
  function cancelRomTransfer() {
    _romTransferState = 'idle';
    if (_romTransferDC) {
      try { _romTransferDC.close(); } catch (_) {}
      _romTransferDC = null;
    }
    clearTimeout(_romTransferStallTimer);
    _romTransferStallTimer = null;
    clearTimeout(_romTransferResumeTimer);
    _romTransferResumeTimer = null;
    if (_romAcceptPollInterval) {
      clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = null;
    }
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferBytesReceived = 0;
    _romTransferRetries = 0;
    cleanupPreGameConnections();
    updateRomSharingUI();
    showToast('ROM transfer cancelled');
  }
```

- [ ] **Step 2: Add resetRomTransfer right after cancelRomTransfer**

```javascript
  function resetRomTransfer() {
    // Game-end cleanup — same as cancel but no toast, also closes sender DCs
    _romTransferState = 'idle';
    if (_romTransferDC) {
      try { _romTransferDC.close(); } catch (_) {}
      _romTransferDC = null;
    }
    Object.keys(_romTransferDCs).forEach((sid) => {
      try { _romTransferDCs[sid].close(); } catch (_) {}
    });
    _romTransferDCs = {};
    clearTimeout(_romTransferStallTimer);
    _romTransferStallTimer = null;
    clearTimeout(_romTransferResumeTimer);
    _romTransferResumeTimer = null;
    if (_romAcceptPollInterval) {
      clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = null;
    }
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferBytesReceived = 0;
    _romTransferRetries = 0;
  }
```

- [ ] **Step 3: Replace watchdog functions with stall timer functions**

Replace `startRomTransferWatchdog` and `stopRomTransferWatchdog` (lines 1069-1088) with:

```javascript
  function resetStallTimer() {
    clearTimeout(_romTransferStallTimer);
    _romTransferStallTimer = setTimeout(onStallTimeout, 10000);
  }

  function stopStallTimer() {
    clearTimeout(_romTransferStallTimer);
    _romTransferStallTimer = null;
  }

  function onStallTimeout() {
    if (_romTransferState !== 'receiving') return;
    console.log('[play] ROM transfer stalled — no chunks for 10s');
    // Close DC — onclose will transition to paused
    if (_romTransferDC) {
      try { _romTransferDC.close(); } catch (_) {}
    }
  }
```

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "refactor: add resetRomTransfer and stall timer replacing watchdog"
```

---

## Chunk 2: Guest-Side State Machine (Receiving)

### Task 3: Update onExtraDataChannel to use state machine

**Files:**
- Modify: `web/static/play.js:984-1067`

- [ ] **Step 1: Rewrite onExtraDataChannel**

Replace the function (lines 984-1067) with:

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

    if (_romTransferState === 'resuming' || _romTransferState === 'paused') {
      // Resume: keep cached chunks, send resume offset
      clearTimeout(_romTransferResumeTimer);
      _romTransferResumeTimer = null;
      _romTransferState = 'receiving';
      console.log('[play] resuming ROM transfer from offset', _romTransferBytesReceived);
      channel.onopen = () => {
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
      _romTransferRetries = 0;
      _romTransferState = 'receiving';
    }

    _romTransferLastChunkAt = Date.now();
    resetStallTimer();

    channel.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'rom-header') {
            if (msg.size > ROM_MAX_SIZE) {
              showToast('ROM too large — loading manually');
              channel.close();
              cancelRomTransfer();
              return;
            }
            // If header differs from cached (host changed ROM), clear chunks
            if (_romTransferHeader &&
                (msg.hash !== _romTransferHeader.hash || msg.size !== _romTransferHeader.size)) {
              console.log('[play] ROM changed — clearing cached chunks');
              _romTransferChunks = [];
              _romTransferBytesReceived = 0;
            }
            _romTransferHeader = msg;
            if (_romTransferBytesReceived === 0) {
              updateRomProgress(0, msg.size);
            }
          } else if (msg.type === 'rom-complete') {
            stopStallTimer();
            _romTransferState = 'complete';
            finishRomTransfer();
          }
        } catch (_) {}
      } else if (e.data instanceof ArrayBuffer) {
        _romTransferChunks.push(new Uint8Array(e.data));
        _romTransferBytesReceived += e.data.byteLength;
        _romTransferLastChunkAt = Date.now();
        resetStallTimer();
        if (_romTransferHeader) {
          updateRomProgress(_romTransferBytesReceived, _romTransferHeader.size);
        }
      }
    };

    channel.onclose = () => {
      if (_romTransferState === 'receiving') {
        _romTransferDC = null;
        stopStallTimer();
        _romTransferRetries++;
        _romTransferState = 'paused';
        console.log('[play] ROM transfer DC closed, retry', _romTransferRetries, '/ 3');

        if (_romTransferRetries <= 3 && _romTransferBytesReceived > 0) {
          showToast(`ROM transfer interrupted — retry ${_romTransferRetries}/3`);
          // Auto-retry after backoff
          _romTransferResumeTimer = setTimeout(() => {
            if (_romTransferState !== 'paused') return;
            _romTransferState = 'resuming';
            updateRomSharingUI();
            requestResumeTransfer();
          }, 2000);
        } else if (_romTransferRetries > 3) {
          showToast('ROM transfer stalled — cancel or wait for host');
        }
        updateRomSharingUI();
      }
    };

    updateRomSharingUI();
  }
```

- [ ] **Step 2: Add requestResumeTransfer helper**

Add after `onExtraDataChannel`:

```javascript
  function requestResumeTransfer() {
    // Re-request transfer from host via Socket.IO
    socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
    // Timeout: if no DC arrives in 15s, fall back to paused
    _romTransferResumeTimer = setTimeout(() => {
      if (_romTransferState !== 'resuming') return;
      _romTransferState = 'paused';
      _romTransferRetries++;
      console.log('[play] ROM resume timed out, retry', _romTransferRetries);
      if (_romTransferRetries <= 3) {
        showToast('ROM transfer resume timed out — will retry');
        // Schedule another attempt
        _romTransferResumeTimer = setTimeout(() => {
          if (_romTransferState !== 'paused') return;
          _romTransferState = 'resuming';
          updateRomSharingUI();
          requestResumeTransfer();
        }, 2000);
      } else {
        showToast('ROM transfer stalled — cancel or wait for host');
      }
      updateRomSharingUI();
    }, 15000);
  }
```

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "refactor: rewrite onExtraDataChannel with state machine and auto-retry"
```

---

## Chunk 3: ROM Sharing Toggle and Accept/Decline

### Task 4: Update onRomSharingUpdated to preserve chunks

**Files:**
- Modify: `web/static/play.js:517-556`

- [ ] **Step 1: Rewrite the disable and re-enable paths**

Replace `onRomSharingUpdated` (lines 517-556) with:

```javascript
  function onRomSharingUpdated(data) {
    const wasEnabled = _romSharingEnabled;
    _romSharingEnabled = !!data.romSharing;
    console.log('[play] rom-sharing-updated:', _romSharingEnabled);

    if (!isHost) {
      if (_romSharingEnabled && !wasEnabled) showToast('Host is sharing their ROM');
      if (!_romSharingEnabled && wasEnabled) showToast('Host stopped sharing their ROM');
    }

    // Host disabled sharing — pause transfer but KEEP chunks
    if (wasEnabled && !_romSharingEnabled) {
      if (_romTransferState === 'receiving' || _romTransferState === 'resuming') {
        if (_romTransferDC) {
          try { _romTransferDC.close(); } catch (_) {}
          _romTransferDC = null;
        }
        stopStallTimer();
        clearTimeout(_romTransferResumeTimer);
        _romTransferResumeTimer = null;
        _romTransferState = 'paused';
      }
      cleanupPreGameConnections();
    }

    // Host re-enabled sharing — resume if we have cached progress
    if (!isHost && _romSharingEnabled && !wasEnabled &&
        _romSharingDecision === 'accepted' && !_romBlob) {
      if (_romTransferState === 'paused' && _romTransferBytesReceived > 0) {
        console.log('[play] ROM sharing re-enabled — resuming from offset', _romTransferBytesReceived);
        _romTransferState = 'resuming';
        requestResumeTransfer();
      } else if (_romTransferState === 'idle') {
        console.log('[play] ROM sharing re-enabled — starting fresh transfer');
        _romTransferState = 'resuming';
        requestResumeTransfer();
      }
    }

    updateRomSharingUI();

    if (isHost && lastUsersData) {
      updateStartButton(lastUsersData.players || {});
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "fix: preserve ROM chunks when host toggles sharing off"
```

### Task 5: Update acceptRomSharing to use state

**Files:**
- Modify: `web/static/play.js:637-673`

- [ ] **Step 1: Update acceptRomSharing**

Replace `acceptRomSharing` (lines 637-673). The logic stays the same, but replace
`_romTransferInProgress = true` and `_romTransferChunks = []` / `_romTransferHeader = null`
with state transitions:

```javascript
  function acceptRomSharing() {
    _romSharingDecision = 'accepted';
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferBytesReceived = 0;
    _romTransferRetries = 0;
    _romTransferState = 'resuming';
    updateRomSharingUI();

    // Pre-game: initiate early ROM transfer via standalone WebRTC connection
    if (!gameRunning) {
      console.log('[play] ROM sharing accepted pre-game — requesting early transfer');
      registerRomSignalHandler();
      socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
      return;
    }

    // Mid-game join: start engine in connect-only mode to get WebRTC
    if (!engine && gameRunning) {
      initEngine();
      waitForDCAndSendRomAccepted();
      return;
    }

    // Engine exists with open DataChannel: signal immediately
    if (engine && engine.getPeerConnection) {
      const hostSid = findHostSid();
      if (hostSid) {
        const peers = window._peers || {};
        const hostPeer = peers[hostSid];
        if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
          hostPeer.dc.send(JSON.stringify({ type: 'rom-accepted' }));
          return;
        }
      }
    }
    // Fallback: Socket.IO data-message
    socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
  }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "refactor: acceptRomSharing uses state machine"
```

---

## Chunk 4: UI, Game Lifecycle, and Integration Points

### Task 6: Update updateRomSharingUI for new states

**Files:**
- Modify: `web/static/play.js:591-626`

- [ ] **Step 1: Rewrite updateRomSharingUI**

Replace lines 591-626 with:

```javascript
  function updateRomSharingUI() {
    const romDrop = document.getElementById('rom-drop');
    const prompt = document.getElementById('rom-sharing-prompt');
    const progress = document.getElementById('rom-transfer-progress');

    if (isHost) return;
    if (isSpectator) return;

    console.log(`[play] updateRomSharingUI: enabled=${_romSharingEnabled}` +
      ` decision=${_romSharingDecision} state=${_romTransferState}` +
      ` hasRom=${!!_romBlob}`);

    if (_romSharingEnabled && _romSharingDecision === null && !_romBlob) {
      // Show accept/decline prompt
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = '';
      if (progress) progress.style.display = 'none';
    } else if (_romTransferState === 'receiving') {
      // Transfer in progress — show progress bar
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = '';
    } else if (_romTransferState === 'paused') {
      // Paused — show progress bar with paused state
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = '';
      const text = document.getElementById('rom-progress-text');
      if (text && _romTransferHeader) {
        const pct = Math.round((_romTransferBytesReceived / _romTransferHeader.size) * 100);
        text.textContent = `ROM transfer paused — ${pct}% received`;
      }
    } else if (_romTransferState === 'resuming') {
      // Resuming — show progress bar with reconnecting text
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = '';
      const text = document.getElementById('rom-progress-text');
      if (text) text.textContent = 'ROM transfer reconnecting...';
    } else if (_romTransferState === 'complete' || (_romSharingDecision === 'accepted' && _romBlob)) {
      // Transfer complete
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

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "refactor: updateRomSharingUI maps state machine to display"
```

### Task 7: Update onGameStarted ROM sharing path

**Files:**
- Modify: `web/static/play.js:430-447`

- [ ] **Step 1: Replace _romTransferInProgress references**

In the `onGameStarted` handler, replace lines 430-447:

```javascript
    if (_romSharingEnabled && !_romBlob && !_romBlobUrl) {
      initEngine();
      if (_romSharingDecision === 'accepted') {
        if (_romTransferState === 'idle') {
          _romTransferState = 'resuming';
        }
        updateRomSharingUI();
        if (_preGamePC) {
          console.log('[play] game started — pre-game ROM transfer in progress');
        } else {
          console.log('[play] game started — waiting for ROM transfer');
          waitForDCAndSendRomAccepted();
        }
      } else {
        console.log('[play] game started — waiting for guest to accept ROM sharing');
        updateRomSharingUI();
      }
      return;
    }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "refactor: onGameStarted uses ROM transfer state"
```

### Task 8: Consolidate onGameEnded cleanup

**Files:**
- Modify: `web/static/play.js:462-501`

- [ ] **Step 1: Replace inline cleanup with resetRomTransfer**

Replace lines 484-500 in `onGameEnded` with:

```javascript
    // Clean up ROM transfer state (decision persists for page lifetime)
    resetRomTransfer();
    cleanupPreGameConnections();
```

This replaces the 17 lines of inline cleanup.

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "refactor: onGameEnded uses resetRomTransfer for cleanup"
```

### Task 9: Update onPeerReconnected

**Files:**
- Modify: `web/static/play.js:1642-1650`

- [ ] **Step 1: Replace boolean check with state check**

Replace lines 1642-1650:

```javascript
      onPeerReconnected: (sid) => {
        // Resume ROM transfer if paused — mark DC to wait for receiver's rom-resume
        if (_romTransferState === 'paused' && engine && engine.getPeerConnection) {
          startRomTransferTo(sid);
          if (_romTransferDCs[sid]) {
            _romTransferDCs[sid]._waitForResume = true;
          }
        }
      },
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "refactor: onPeerReconnected checks ROM transfer state"
```

### Task 10: Add resume support to startPreGameRomTransfer

**Files:**
- Modify: `web/static/play.js:770-819`

- [ ] **Step 1: Add onmessage handler and _waitForResume to pre-game DC**

In `startPreGameRomTransfer`, after `dc.binaryType = 'arraybuffer';` (line 791),
add a `dc.onmessage` handler and modify `dc.onopen` to support `_waitForResume`:

Replace the `dc.onopen` at line 795 with:

```javascript
    dc.onopen = function () {
      console.log('[play] pre-game rom-transfer DC open to', peerSid);
      if (!dc._waitForResume) {
        sendRomOverChannel(dc, peerSid);
      }
    };
    dc.onmessage = function (e) {
      if (typeof e.data === 'string') {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'rom-resume' && msg.offset >= 0) {
            console.log('[play] pre-game ROM resume from offset', msg.offset);
            sendRomOverChannel(dc, peerSid, msg.offset);
          }
        } catch (_) {}
      }
    };
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "feat: add resume support to pre-game ROM transfer"
```

---

## Chunk 5: Final Sweep

### Task 11: Search and replace remaining boolean references

**Files:**
- Modify: `web/static/play.js` (multiple locations)

- [ ] **Step 1: Grep for any remaining references to removed variables**

```bash
grep -n '_romTransferInProgress\|_romTransferWaitingResume\|_romTransferResumeAttempts\|_romTransferWatchdog\|startRomTransferWatchdog\|stopRomTransferWatchdog' web/static/play.js
```

Expected: no matches. If any remain, update them:
- `_romTransferInProgress` → `_romTransferState === 'receiving' || _romTransferState === 'resuming'`
- `_romTransferWaitingResume` → `_romTransferState === 'paused'` or `'resuming'`
- `_romTransferResumeAttempts` → `_romTransferRetries`
- `startRomTransferWatchdog()` → `resetStallTimer()`
- `stopRomTransferWatchdog()` → `stopStallTimer()`

- [ ] **Step 2: Verify finishRomTransfer sets state correctly**

Check `finishRomTransfer` (~line 1103). It has two `_romTransferInProgress = false` lines:
- **Line ~1111 (size mismatch error path):** Replace with `_romTransferState = 'idle'` —
  the transfer failed, so go back to idle (not complete).
- **Line ~1127 (success path):** Replace with `_romTransferState = 'complete'`.
  (Note: `onExtraDataChannel` already sets state to `complete` before calling
  `finishRomTransfer`, but the function should also set it as a safety net.)

- [ ] **Step 3: Manual smoke test**

Test these scenarios in the browser:
1. Host enables sharing → guest accepts → transfer completes
2. Host disables sharing mid-transfer → re-enables → transfer resumes from cached offset
3. Guest clicks cancel → chunks cleared, back to idle
4. Network stall (simulate by throttling) → auto-retry → recovers or caps at 3 retries
5. Game ends during transfer → clean state reset

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "fix: replace all remaining boolean ROM transfer refs with state machine"
```
