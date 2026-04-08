# Host-Authoritative Prediction with Delta Correction

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smooth netplay where the guest predicts missing host input (no stalls) and the host pushes authoritative state corrections on misprediction — no restore+replay needed.

**Architecture:** Host runs pure lockstep (stalls if needed, always correct by construction). Guest predicts missing input and advances speculatively. When the host detects that the guest predicted wrong, the host sends its authoritative state as a delta (only changed RDRAM blocks). Guest applies the correction directly — no rollback, no replay, no determinism dependency. Menus stay pure lockstep on both sides (screen detection gates prediction to VS_BATTLE only).

**Tech Stack:** Vanilla JS (IIFE + window globals), WASM (mupen64plus-next), WebRTC DataChannels

---

## Context

Branch `feat/hybrid-lockstep-rollback` has working infrastructure:
- Screen detection (lockstep menus, rollback gameplay)
- v3 kn_sync_read/write (complete state capture)
- Delta sync protocol (128-block hash comparison + targeted RDRAM patches)
- Prediction tracking with 600-frame retention
- Batched misprediction detection
- Sync buffer pre-allocated at f=0

The key change: remove restore+replay entirely. Replace with host-authoritative state push on misprediction.

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `web/static/netplay-lockstep.js` | Modify | Change guest behavior: predict during VS_BATTLE but no rollback replay. On misprediction, request correction from host. Host pushes delta state. |

No new files needed. All changes are in the existing lockstep engine.

---

## Chunk 1: Remove replay, add host-authoritative correction

### Task 1: Change misprediction handling — request correction instead of replay

**Files:**
- Modify: `web/static/netplay-lockstep.js` — DC message handler (misprediction detection) and tick() rollback block

Currently when a misprediction is detected in the DC handler, `_pendingRollbackFrame` is set and the tick() loop performs restore+replay. Replace this with:

1. Guest detects misprediction → sends `correction-req:FRAME` to host
2. Host receives → captures its state at current frame → sends 128 block hashes
3. Guest compares hashes → host sends only divergent blocks (existing delta sync protocol)
4. Guest applies blocks atomically in tick()

- [ ] **Step 1: Replace misprediction handler — request correction instead of setting _pendingRollbackFrame**

In the DC handler where `_pendingRollbackFrame = recvFrame` is set (around line 2232), replace the rollback request with a correction request to the host:

```javascript
// Instead of: _pendingRollbackFrame = recvFrame;
// Send correction request to host
for (const p of Object.values(_peers)) {
  if (p.slot === 0 && p.dc?.readyState === 'open') {
    try { p.dc.send(`correction-req:${_frameNum}`); } catch (_) {}
  }
}
_syncLog(`CORRECTION-REQ f=${_frameNum} mispredicted=${recvFrame} depth=${_frameNum - recvFrame}`);
```

- [ ] **Step 2: Remove the batched rollback block from tick()**

Remove the entire `if (_hybridMode && _pendingRollbackFrame >= 0 && _deltaReady && !_inRollback)` block from tick(). This is the restore+replay code that we're replacing.

Also remove `_pendingRollbackFrame`, `_inRollback`, and related replay variables since they're no longer needed.

- [ ] **Step 3: Add correction-req handler on host**

In the DC string message handler, add handling for `correction-req:`:

```javascript
if (e.data.startsWith('correction-req:')) {
  if (_playerSlot !== 0) return; // host only
  const reqFrame = parseInt(e.data.split(':')[1], 10);
  // Host computes block hashes and sends them
  if (tickMod?._kn_rdram_block_hashes && _syncBufPtr) {
    const count = tickMod._kn_rdram_block_hashes(_syncBufPtr, 128);
    const hashes = [];
    for (let hi = 0; hi < count; hi++) {
      hashes.push(tickMod.HEAPU32[(_syncBufPtr >> 2) + hi] >>> 0);
    }
    peer.dc.send(`correction-hashes:${_frameNum}:${hashes.join(',')}`);
    _syncLog(`CORRECTION-SEND f=${_frameNum} reqFrame=${reqFrame}`);
  }
  return;
}
```

- [ ] **Step 4: Add correction-hashes handler on guest**

Reuse the existing `rb-hashes` / `_pendingRollbackHash` infrastructure but rename for clarity. When guest receives `correction-hashes:`, it compares block hashes and requests divergent blocks (existing `delta-req` protocol):

```javascript
if (e.data.startsWith('correction-hashes:')) {
  if (peer.slot !== 0 || _playerSlot === 0) return;
  const parts = e.data.split(':');
  const hostFrame = parseInt(parts[1], 10);
  const hostHashes = parts[2].split(',').map(Number);
  // Compare and request divergent blocks (reuse existing delta sync)
  _pendingRollbackHash = { frame: hostFrame, hashes: hostHashes };
  return;
}
```

The existing `_pendingRollbackHash` check in tick() already handles the comparison, `delta-req` sending, and `DELTA-APPLIED` block patching.

- [ ] **Step 5: Remove snapshot capture during VS_BATTLE**

Since we no longer restore+replay, we don't need per-frame snapshots. Remove `_captureSnapshot()` from the tick loop during VS_BATTLE. Keep `_initSnapshots()` for the initial delta sync buffer setup.

The snapshot ring (`_snapshotRing`), `_captureSnapshot`, `_restoreSnapshot`, and `_initSnapshots` can be simplified — we only need the sync buffer for delta hash comparison, not for full state capture/restore.

- [ ] **Step 6: Add host-side periodic hash broadcast**

Instead of only sending hashes after rollback, the host should periodically broadcast block hashes during VS_BATTLE so the guest can detect drift even without mispredictions:

```javascript
// In tick(), host-only, every 120 frames (~2s)
if (_hybridMode && _inRollbackScreen && _playerSlot === 0 && _frameNum % 120 === 0) {
  if (tickMod?._kn_rdram_block_hashes && _syncBufPtr) {
    const count = tickMod._kn_rdram_block_hashes(_syncBufPtr, 128);
    const hashes = [];
    for (let hi = 0; hi < count; hi++) {
      hashes.push(tickMod.HEAPU32[(_syncBufPtr >> 2) + hi] >>> 0);
    }
    const msg = `correction-hashes:${_frameNum}:${hashes.join(',')}`;
    for (const p of Object.values(_peers)) {
      if (p.dc?.readyState === 'open') {
        try { p.dc.send(msg); } catch (_) {}
      }
    }
  }
}
```

- [ ] **Step 7: Apply full host state (not just RDRAM blocks) on correction**

The current delta sync only patches RDRAM blocks. But the guest's CPU, I/O, and event queue state are also wrong. After applying RDRAM blocks, the guest needs a full state correction.

Change the `DELTA-APPLIED` path to also request a full `kn_sync_write` state from the host. The host sends its v3 state via the sync-state DC (existing resync infrastructure), and the guest applies it via `kn_sync_write`.

This is equivalent to a targeted resync — but triggered by misprediction, not periodic timer. And the delta hash comparison ensures it only fires when states actually differ.

- [ ] **Step 8: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: host-authoritative prediction — guest predicts, host corrects via delta state push"
```

---

## Testing

1. **Same laptop**: both tabs in hybrid mode. Guest should predict (predictions > 0), host should stay at 0 rollbacks. No corrections needed (predictions always correct locally).

2. **Desktop to mobile**: user controls host. Guest (mobile, idle) receives host inputs late → predictions fire → mispredictions detected → host sends correction → guest applies.

3. **Verify menus still sync**: CSS, stage select should be lockstep (no predictions).

4. **Verify no replay**: no REPLAY-DONE entries in logs. Only CORRECTION-REQ, CORRECTION-SEND, DELTA-SYNC, DELTA-APPLIED.

5. **Visual check**: screenshots at f=3000+ should show matching game state.
