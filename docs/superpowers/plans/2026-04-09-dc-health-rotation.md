# DC Health Monitor + Rotation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when the unreliable rollback-input DataChannel silently stops delivering and rotate to a fresh DC on the same PeerConnection.

**Architecture:** Two detection signals (bufferedAmount growth + ack staleness) run in the tick loop. Either triggers `rotateDc()` which closes the old DC, creates a new one, and lets GGPO redundancy fill the gap. Guards prevent rotation storms and fall back to reliable after 10 rotations.

**Tech Stack:** Vanilla JS in `web/static/netplay-lockstep.js` (IIFE, no modules)

**Spec:** `docs/superpowers/specs/2026-04-09-dc-health-rotation-design.md`

---

## Task 1: Revert dual-send and add state variables

**Files:**
- Modify: `web/static/netplay-lockstep.js:444-446` (add state vars)
- Modify: `web/static/netplay-lockstep.js:5455-5479` (revert dual-send to single-DC send)

- [ ] **Step 1: Add DC rotation state variables after the existing transport vars (~line 446)**

```js
// DC health monitor: rotation state
let _dcRotationCount = 0;
let _dcRotationCooldownUntil = 0;
let _dcBufferStaleStreak = {}; // sid -> consecutive frames above threshold
const DC_BUFFER_THRESHOLD = 2048; // bytes — ~100 input packets
const DC_BUFFER_STALE_FRAMES = 10; // consecutive frames before rotation
const DC_ACK_STALE_MS = 500; // ms without ack advance before rotation
const DC_ROTATION_COOLDOWN_MS = 2000;
const DC_MAX_ROTATIONS = 10;
```

- [ ] **Step 2: Revert the dual-send input block back to single-DC send**

Replace the dual-send block (lines ~5455-5479) with the original single-DC send that uses `_pickInputDc` logic inline:

```js
let _sendFails = 0;
for (let i = 0; i < activePeers.length; i++) {
  try {
    const peer = activePeers[i];
    const ackFrame = peer.lastFrameFromPeer ?? -1;
    const peerBuf = KNShared.encodeInput(_frameNum, localInput, ackFrame, redundantTail).buffer;
    // Use unreliable rb-input DC when available, fall back to primary DC
    const inputDc =
      _rbTransport === 'unreliable' &&
      peer.rbDc?.readyState === 'open' &&
      peer.rbDc.ordered === false &&
      peer.rbDc.maxRetransmits === 0
        ? peer.rbDc
        : peer.dc;
    if (inputDc?.readyState === 'open') {
      inputDc.send(peerBuf);
      _rbTransportPacketsSent++;
    } else {
      _sendFails++;
    }
  } catch (_) {
    _sendFails++;
  }
}
```

- [ ] **Step 3: Verify syntax**

Run: `node -c web/static/netplay-lockstep.js`
Expected: no output (clean parse)

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "refactor: revert dual-send, add DC rotation state variables"
```

---

## Task 2: Add the `rotateDc` function

**Files:**
- Modify: `web/static/netplay-lockstep.js` — add function near the existing `setupRollbackInputDataChannel` (~line 2588)

- [ ] **Step 1: Add `rotateDc` function after `setupRollbackInputDataChannel`**

```js
// DC health rotation: close the stuck unreliable DC and create a fresh
// one on the same PeerConnection. GGPO redundancy (each packet carries
// all unACKed frames) ensures zero input loss during the ~50ms gap.
const rotateDc = (remoteSid, reason) => {
  const peer = _peers[remoteSid];
  if (!peer?.pc) return;
  if (_dcRotationCount >= DC_MAX_ROTATIONS) {
    _rbTransport = 'reliable';
    _syncLog(`DC-ROTATE-EXHAUSTED rotations=${_dcRotationCount} — falling back to reliable DC`);
    return;
  }
  const now = performance.now();
  if (now < _dcRotationCooldownUntil) return;

  _dcRotationCount++;
  _dcRotationCooldownUntil = now + DC_ROTATION_COOLDOWN_MS;
  _syncLog(`DC-ROTATE reason=${reason} sid=${remoteSid} rotations=${_dcRotationCount}`);

  // Close old DC
  try { peer.rbDc?.close(); } catch (_) {}

  // Create fresh DC on same PeerConnection
  peer.rbDc = peer.pc.createDataChannel('rollback-input', { ordered: false, maxRetransmits: 0 });
  setupRollbackInputDataChannel(remoteSid, peer.rbDc);

  // Reset detection counters
  _dcBufferStaleStreak[remoteSid] = 0;
  peer.lastAckAdvanceTime = now;
};
```

- [ ] **Step 2: Verify syntax**

Run: `node -c web/static/netplay-lockstep.js`
Expected: no output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add rotateDc function for DC health recovery"
```

---

## Task 3: Close old rbDc in ondatachannel handlers

**Files:**
- Modify: `web/static/netplay-lockstep.js` — 4 locations where `peer.rbDc = e.channel` is assigned in `ondatachannel` handlers

The 4 locations are:
- Line ~2348: first `ondatachannel` (initiator path)
- Line ~2363: second `ondatachannel` (receiver path)
- Line ~2443: existing peer reconnect path
- Line ~3286: WebRTC reconnect path

- [ ] **Step 1: Add close-before-assign at all 4 locations**

At each location, change:
```js
} else if (e.channel.label === 'rollback-input') {
  peer.rbDc = e.channel;
```
to:
```js
} else if (e.channel.label === 'rollback-input') {
  if (peer.rbDc) try { peer.rbDc.close(); } catch (_) {}
  peer.rbDc = e.channel;
```

Use `replace_all` for the exact pattern since all 4 are identical. The variable name differs at one location (`existingPeer.rbDc` vs `peer.rbDc`) — handle that one separately.

- [ ] **Step 2: Verify syntax**

Run: `node -c web/static/netplay-lockstep.js`
Expected: no output (clean parse)

- [ ] **Step 3: Verify all 4 locations were updated**

Run: `grep -n 'rbDc.close' web/static/netplay-lockstep.js`
Expected: 4 matches (the 4 ondatachannel handlers) + 1 in `rotateDc`

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "fix: close old rbDc before assigning new one in ondatachannel"
```

---

## Task 4: Add ack advance time tracking

**Files:**
- Modify: `web/static/netplay-lockstep.js:2483-2484` (in `_processInputPacket`)
- Modify: `web/static/netplay-lockstep.js:5461` (initialize on first send)

- [ ] **Step 1: Track ack advance time in `_processInputPacket`**

After line 2484 (`peer.lastFrameFromPeer = Math.max(prevHighest, recvFrame);`), add:

```js
// DC health: track when peer's ack last advanced (for rotation detection)
if (peer.lastFrameFromPeer > prevHighest) {
  peer.lastAckAdvanceTime = performance.now();
}
```

- [ ] **Step 2: Initialize `lastAckAdvanceTime` on first input send**

In the input send loop (Task 1's send block), after the `inputDc.send(peerBuf)` line, add:

```js
// Initialize ack tracking on first send to avoid false positive
if (!peer.lastAckAdvanceTime) peer.lastAckAdvanceTime = performance.now();
```

- [ ] **Step 3: Verify syntax**

Run: `node -c web/static/netplay-lockstep.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: track ack advance time for DC health detection"
```

---

## Task 5: Add detection checks in tick loop

**Files:**
- Modify: `web/static/netplay-lockstep.js` — insert between input send and `_skipFrameAdvance` gate (~line 5481)

- [ ] **Step 1: Add DC health detection between input send and pacing gate**

Replace the existing pacing gate comment and return:
```js
    // ── Pacing gate: skip frame advance but inputs were sent above ──────
    if (_skipFrameAdvance) return;
```

With:
```js
    // ── DC health monitor: detect stuck unreliable DC, rotate if needed ──
    if (_useCRollback && _rbTransport === 'unreliable') {
      const now = performance.now();
      for (const [sid, peer] of Object.entries(_peers)) {
        if (!peer.rbDc || peer.rbDc.readyState !== 'open') continue;

        // Signal 1: bufferedAmount growth (local congestion)
        if (peer.rbDc.bufferedAmount > DC_BUFFER_THRESHOLD) {
          _dcBufferStaleStreak[sid] = (_dcBufferStaleStreak[sid] || 0) + 1;
          if (_dcBufferStaleStreak[sid] >= DC_BUFFER_STALE_FRAMES) {
            rotateDc(sid, 'buffer');
          }
        } else {
          _dcBufferStaleStreak[sid] = 0;
        }

        // Signal 2: ack staleness (remote silent drop)
        if (
          peer.lastAckAdvanceTime &&
          now - peer.lastAckAdvanceTime > DC_ACK_STALE_MS &&
          _frameNum > 60 // skip during early convergence
        ) {
          rotateDc(sid, 'ack-stale');
        }
      }
    }

    // ── Pacing gate: skip frame advance but inputs were sent above ──────
    if (_skipFrameAdvance) return;
```

The `_frameNum > 60` guard prevents false positives during the first second when acks haven't had time to round-trip.

- [ ] **Step 2: Verify syntax**

Run: `node -c web/static/netplay-lockstep.js`
Expected: no output

- [ ] **Step 3: Verify structure — detection is between input send and pacing gate**

Run:
```bash
node -e "
const src = require('fs').readFileSync('web/static/netplay-lockstep.js', 'utf8');
const sendIdx = src.indexOf('encodeInput');
const detectIdx = src.indexOf('DC health monitor');
const gateIdx = src.indexOf('_skipFrameAdvance) return');
console.log('send < detect < gate:', sendIdx < detectIdx && detectIdx < gateIdx);
"
```
Expected: `send < detect < gate: true`

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: DC health detection — bufferedAmount + ack staleness"
```

---

## Task 6: Playwright validation

**Files:**
- Test via Playwright MCP against `https://kn-test.thesuperhuman.us`

- [ ] **Step 1: Verify code is being served**

Navigate to host URL, fetch lockstep JS source, check for:
- `DC-ROTATE` string present
- `rotateDc` function present
- `DC_BUFFER_THRESHOLD` constant present
- `lastAckAdvanceTime` present
- No dual-send (no `// Reliable DC (always-on backup` string)

- [ ] **Step 2: Two-tab boot test**

1. Open host tab with ROM
2. Open guest tab
3. Click Start Game on host
4. Click Tap to start on guest
5. Wait 30s
6. Verify both tabs show "Connected -- game on!"

- [ ] **Step 3: Commit test results**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: DC health monitor + rotation — validated via Playwright"
```
