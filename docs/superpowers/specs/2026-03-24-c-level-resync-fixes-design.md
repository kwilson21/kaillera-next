# C-Level Resync Fixes — Design Spec

**Date:** 2026-03-24
**Branch:** `feat/c-level-resync` (rebased on `mvp-p0-implementation`)
**Status:** Design approved, pending implementation

## Problem Statement

The C-level resync feature (`kn_sync_hash`, `kn_sync_read`, `kn_sync_write`) is code-complete
and integrated into `netplay-lockstep.js`, but three issues prevent it from working optimally:

1. **Delta sync never fires.** Every resync sends the full 8.2MB state (~1.4MB compressed,
   24 WebRTC DataChannel chunks, ~1.5s transfer). Delta sync should reduce this to ~100-200KB
   (~200ms) by XOR-ing against the previous state.

2. **Mobile drift causes resyncs every ~2s.** Mobile browsers run the emulator at a slightly
   different rate, causing hash mismatches. We lack diagnostics to understand what's drifting
   (CPU timing vs game-state mutation, which RDRAM regions, drift rate).

3. **No way to capture logs on mobile.** All diagnostic output goes to `console.log`, which
   is inaccessible on iOS/Android without USB debugging.

4. **Stale patch file.** `build/patches/kn-sync.patch` has wrong context lines and is
   superseded by `mupen64plus-kn-all.patch`.

## Scope

This spec covers JS-side fixes and diagnostics only. No WASM rebuild is required for
issues #1, #3, #4. Issue #2 adds a new C-level export (`kn_sync_hash_regions`) that
requires a WASM rebuild to activate, but the JS side gracefully degrades if absent.

## Design

### 1. Delta Sync Fix (Defensive)

#### Root Cause

`_lastSyncState` is the delta base — both host and guest cache it after each resync so the
next state transfer can be a compact XOR delta instead of full 8.2MB.

The bug: line 1054 nulls `_lastSyncState` inside the DataChannel `onopen` handler for ANY
peer reconnect. When a guest reconnects, the **host** also runs this code path, destroying
its delta base. Since mobile drift causes frequent resyncs, any DC hiccup between resyncs
puts the host permanently back in full-state mode.

Secondary issue: the fallback `getState()` path doesn't `.slice()` the result. If the
emulator reuses an internal buffer, `_lastSyncState` could alias mutable memory.

#### Changes

**a) Guard reconnect handler (line ~1054):**

```javascript
// Only guests should null their delta base on reconnect.
// Host needs its delta base to survive peer lifecycle events.
if (_playerSlot !== 0) {
  _lastSyncState = null;
}
```

**b) Frame-stamped delta base tracking:**

Add `_lastSyncStateInfo` alongside `_lastSyncState`:

```javascript
let _lastSyncStateInfo = null;  // { frame, setBy, timestamp }
```

Every mutation of `_lastSyncState` logs the operation:

```javascript
const _setLastSyncState = (state, reason) => {
  _lastSyncState = state;
  _lastSyncStateInfo = state
    ? { frame: _frameNum, setBy: reason, ts: performance.now() }
    : null;
  _syncLog(`deltaBase ${state ? 'SET' : 'NULL'} reason=${reason} frame=${_frameNum} size=${state?.length ?? 0}`);
};
```

All direct assignments to `_lastSyncState` are replaced with calls to `_setLastSyncState()`.
The complete list of mutation sites (7 total):

| Line | Context | Host behavior | Guest behavior |
|---|---|---|---|
| ~1054 | Reconnect handler | **No-op** (preserve delta base) | Null (force full resync) |
| ~2364 | Background tab return | No-op (already guarded) | Null (delta base stale) |
| ~2448 | `stopSync()` cleanup | Null | Null |
| ~3234 | `pushSyncState()` | Set (new delta base) | N/A (host only) |
| ~3339 | `applySyncState()` C-level | N/A (guest only) | Set (cache applied state) |
| ~3365 | `applySyncState()` fallback | N/A (guest only) | Set (already copies via `new Uint8Array(bytes)`) |
| ~3484 | `stop()` cleanup | Null (redundant with stopSync) | Null (redundant with stopSync) |

Note: Line 3484 is redundant with line 2448 (`stop()` calls `stopSync()`). Consider
removing one to avoid double-null log entries. Line 3365 already creates an independent
copy via the `Uint8Array` constructor — no `.slice()` needed there.

**c) Fallback path `.slice()`:**

In `pushSyncState`, the fallback path:

```javascript
// Before (aliases internal buffer):
currentState = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

// After (independent copy):
currentState = raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw);
```

### 2. Mobile Drift Diagnostics

#### Per-Region Hash (C-Level)

Add a new WASM export `kn_sync_hash_regions` that returns 12 individual 32-bit hashes,
one per RDRAM region. The JS side reads these from the WASM heap after calling the function.

**C-level signature:**

```c
EMSCRIPTEN_KEEPALIVE uint32_t kn_sync_hash_regions(uint32_t *out_hashes, uint32_t max_count)
```

Writes up to `max_count` FNV-1a hashes into `out_hashes`, returns number written.
Uses the same 12 regions as `kn_sync_hash`.

**JS-side usage (on desync only):**

```javascript
if (_hasKnSync && mod._kn_sync_hash_regions) {
  // Allocate 48 bytes (12 × uint32) on WASM heap
  const hashBuf = mod._malloc(48);
  const count = mod._kn_sync_hash_regions(hashBuf, 12);
  // Read via HEAPU32 to avoid alignment issues and buffer detachment risk
  const hashes = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    hashes[i] = mod.HEAPU32[(hashBuf >> 2) + i];
  }
  mod._free(hashBuf);
  // Log per-region hashes for comparison with host
  _syncLog(`REGION-HASH ${[...hashes].map((h, i) => `${_diagRegionNames[i]}=${h >>> 0}`).join(' ')}`);
}
```

If `_kn_sync_hash_regions` doesn't exist (stock core), this block is skipped.

#### Cycle Time in Sync Protocol

Extend the `sync-hash` DataChannel message to include the host's cycle time:

```
// Before:
sync-hash:<frame>:<hash>

// After:
sync-hash:<frame>:<hash>:<cycleTimeMs>
```

The guest parses the optional fourth field. If present, compares against its own
`kn_get_cycle_time_ms()` and logs the divergence.

Backward-compatible in both directions:
- **New host → old guest:** Guest only reads `parts[1]` and `parts[2]`; extra field ignored.
- **Old host → new guest:** `parts[3]` is `undefined`; guest skips cycle comparison.

#### Drift Rate Tracker

Track consecutive desyncs and timing in the JS engine:

```javascript
let _driftStats = { count: 0, firstAt: 0, lastAt: 0, regions: {} };
```

On each desync:
- Increment `_driftStats.count`
- Record timestamp
- If per-region hashes available, tally which regions diverged

Log a summary at exponential intervals (count = 1, 5, 10, 20, 50, ...) so the first
summary comes quickly for debugging:

```
DRIFT-SUMMARY count=47 over=94.2s avgInterval=2004ms regions=[ps0:47 ps1:43 misc:12] cycleDrift=+3.2ms
```

Reset on successful sync (hash match) and in `stop()` cleanup.

### 3. Log Export System

#### Ring Buffer

Uses a fixed-size ring buffer with O(1) insert (no `.shift()` copies on mobile):

```javascript
const SYNC_LOG_MAX = 5000;
const _syncLogRing = new Array(SYNC_LOG_MAX);
let _syncLogHead = 0;
let _syncLogCount = 0;
let _syncLogSeq = 0;

const _syncLog = (msg) => {
  _syncLogRing[_syncLogHead] = { seq: _syncLogSeq++, t: performance.now(), f: _frameNum, msg };
  _syncLogHead = (_syncLogHead + 1) % SYNC_LOG_MAX;
  if (_syncLogCount < SYNC_LOG_MAX) _syncLogCount++;
  console.log(`[lockstep] ${msg}`);
};
```

All existing `console.log('[lockstep] ...')` calls are migrated to `_syncLog(...)`.
All `_streamSync(...)` calls are redirected to `_syncLog(...)` (re-enabling the
currently-disabled diagnostic stream).

Many call sites currently use both `console.log` AND `_streamSync` for the same message
(e.g., lines 3208-3209, 3222-3223). After migration, collapse these to a single
`_syncLog()` call to avoid duplicate entries in the ring buffer.

#### Toolbar Download Button

Add a "Logs" button to the in-game toolbar in `play.html`:

```html
<button id="toolbar-logs" class="toolbar-toggle" title="Download sync logs">Logs</button>
```

Click handler in `play.js`. Uses the existing `engine` variable (set to
`window.NetplayLockstep` or `window.NetplayStreaming` by `initEngine()`):

```javascript
document.getElementById('toolbar-logs').addEventListener('click', () => {
  const logs = engine?.exportSyncLog?.();
  if (!logs) return;
  const blob = new Blob([logs], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kn-sync-p${window._playerSlot}-${Date.now()}.log`;
  a.click();
  URL.revokeObjectURL(url);
});
```

The `exportSyncLog()` function in `netplay-lockstep.js` formats the ring buffer:

```javascript
const exportSyncLog = () => {
  const lines = [];
  const start = _syncLogCount < SYNC_LOG_MAX ? 0 : _syncLogHead;
  for (let i = 0; i < _syncLogCount; i++) {
    const e = _syncLogRing[(start + i) % SYNC_LOG_MAX];
    lines.push(`${e.seq}\t${e.t.toFixed(1)}\tf=${e.f}\t${e.msg}`);
  }
  return lines.join('\n');
};
```

Exposed on the `NetplayLockstep` public API alongside `init`, `stop`, etc.

#### Auto-Dump on Error

When the resync wait timeout fires (3s), dump the buffer to `console.warn` as a
single string — captures it if DevTools happens to be attached:

```javascript
if (performance.now() - _awaitingResyncAt > 3000) {
  console.warn('[lockstep] resync timeout — log dump:\n' + exportSyncLog());
  _awaitingResync = false;
}
```

#### Mobile Compatibility

- iOS Safari: `Blob` download triggers "Open in Files" prompt. Works without DevTools.
- Android Chrome: Standard file download.
- No server involvement, no network, purely client-side.
- Ring buffer caps at ~2-3MB worst case (5000 entries × ~500 bytes average).

### 4. Stale Patch Cleanup

- Delete `build/patches/kn-sync.patch`
- No references in `build.sh` (already confirmed — it only references
  `mupen64plus-deterministic-timing.patch` and `mupen64plus-kn-all.patch`)
- No other files reference `kn-sync.patch`

## Files Modified

| File | Changes |
|---|---|
| `web/static/netplay-lockstep.js` | Delta fix, log system, drift diagnostics, `_syncLog` migration |
| `web/play.html` | Logs button in toolbar |
| `web/static/play.js` | Logs button click handler |
| `build/patches/mupen64plus-kn-all.patch` | Add `kn_sync_hash_regions` export |
| `build/patches/kn-sync.patch` | DELETE |

## Testing Strategy

1. **Delta fix verification:** Start a 2-player lockstep game with desync detection enabled.
   Trigger a resync. Check logs for `deltaBase SET` on first resync, then `pushSync: isFull=false`
   on second resync. The compressed size should drop from ~1.4MB to <200KB.

2. **Drift diagnostics:** Run host on desktop, guest on iPhone. Let it play for 30s.
   Download logs from both. Compare `DRIFT-SUMMARY` entries and `REGION-HASH` data.

3. **Log export:** Test on iOS Safari — tap Logs button, verify file downloads to Files app
   with readable content.

4. **Backward compatibility:** Test with stock CDN core (no kn_sync exports). Verify
   fallback path works, `_hasKnSync = false`, no errors from missing `_kn_sync_hash_regions`.

## Non-Goals

- Fixing mobile drift (this spec diagnoses it only)
- WASM rebuild (needed for `kn_sync_hash_regions` but not for the other fixes)
- Desync tolerance / hash region tuning (follow-up after diagnostics reveal patterns)
- Server-side log collection
