# C-Level Resync Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix delta sync so resyncs transfer ~200KB instead of 8.2MB, add mobile drift diagnostics, add a log export system for debugging on mobile, and clean up stale patches.

**Architecture:** All changes are in the browser-side JS lockstep engine (`netplay-lockstep.js`) plus minor HTML/JS additions for the log button. One C-level patch addition (`kn_sync_hash_regions`) for future WASM builds. No server changes.

**Tech Stack:** Vanilla JS (ES2022+), WebRTC DataChannels, WASM/Emscripten, C (mupen64plus patches)

---

## Chunk 1: Log System Foundation

The log system must be built first because all other tasks emit logs through it.

### Task 1: Add ring buffer and `_syncLog` to netplay-lockstep.js

**Files:**
- Modify: `web/static/netplay-lockstep.js:327-335` (replace `_streamSync` with ring buffer + `_syncLog`)

- [ ] **Step 1: Add ring buffer state variables**

In `web/static/netplay-lockstep.js`, after line 326 (`let _consecutiveResyncs = 0;`), add the ring buffer variables and the `_syncLog` function. Replace `_streamSync` with a redirect to `_syncLog`.

Find the block starting at line 327:
```javascript
  // Resync cooldown: C-level path is <2ms so we can resync frequently.
  // Fallback (loadState) blocks 3-10ms, needs longer cooldown to avoid freezes.
  const _resyncCooldownMs = () => _hasKnSync ? 2000 : 10000;
  const _streamSync = (msg) => {
    // Disabled for production — re-enable for diagnostics
    // if (socket && socket.connected) {
    //   socket.emit('debug-sync', { slot: _playerSlot, msg: msg });
    // }
  };
```

Replace with:
```javascript
  // Resync cooldown: C-level path is <2ms so we can resync frequently.
  // Fallback (loadState) blocks 3-10ms, needs longer cooldown to avoid freezes.
  const _resyncCooldownMs = () => _hasKnSync ? 2000 : 10000;

  // -- Sync log ring buffer (downloadable from toolbar) ----------------------
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

  const exportSyncLog = () => {
    const lines = [];
    const start = _syncLogCount < SYNC_LOG_MAX ? 0 : _syncLogHead;
    for (let i = 0; i < _syncLogCount; i++) {
      const e = _syncLogRing[(start + i) % SYNC_LOG_MAX];
      lines.push(`${e.seq}\t${e.t.toFixed(1)}\tf=${e.f}\t${e.msg}`);
    }
    return lines.join('\n');
  };

  // _streamSync redirects to _syncLog (re-enables the previously disabled stream)
  const _streamSync = (msg) => { _syncLog(msg); };
```

- [ ] **Step 2: Verify no syntax errors**

Open the browser, load play.html. Open DevTools console. Confirm no JS parse errors from netplay-lockstep.js.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add sync log ring buffer and _syncLog for mobile diagnostics"
```

### Task 2: Migrate console.log calls to _syncLog

**Files:**
- Modify: `web/static/netplay-lockstep.js` (many lines — search for `console.log('[lockstep]`)

- [ ] **Step 1: Migrate all `console.log('[lockstep] ...')` to `_syncLog(...)`**

Search for all `console.log('[lockstep]` calls and replace with `_syncLog(...)`, stripping the `[lockstep] ` prefix (since `_syncLog` already adds it via `console.log`).

Pattern: `console.log('[lockstep] ' + ...)` → `_syncLog(...)`
Pattern: `` console.log(`[lockstep] ${...}`) `` → `` _syncLog(`${...}`) ``
Pattern: `console.log('[lockstep] foo', bar)` → `` _syncLog(`foo ${bar}`) ``

**IMPORTANT:** Only migrate calls with the `[lockstep]` prefix. There are ~50 such calls in the file using a mix of template literals and string concatenation.

Where a call site has BOTH `console.log` AND `_streamSync` for the same message, collapse to a single `_syncLog(...)` call. Search for all adjacent `console.log('[lockstep]` + `_streamSync(` pairs — there are many throughout the file (lines ~1128-1130, 1143-1145, 1157-1159, 1167-1169, 2706-2708, 3208-3209, 3216-3217, 3222-3223, 3343-3344, and others). Remove the redundant `_streamSync` call in each case.

~25 standalone `_streamSync` calls (without a paired `console.log`) exist throughout the file — these will automatically route through `_syncLog` via the redirect defined in Task 1. Leave them as-is.

- [ ] **Step 2: Verify in browser**

Load play.html, start a game. Confirm `[lockstep]` messages appear in console. Open DevTools, run `window.NetplayLockstep.exportSyncLog()` — should return empty string or log entries if game is active.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "refactor: migrate console.log to _syncLog ring buffer"
```

### Task 3: Add exportSyncLog to public API

**Files:**
- Modify: `web/static/netplay-lockstep.js:3554-3566` (NetplayLockstep public API)

- [ ] **Step 1: Add exportSyncLog to the public API object**

At line 3554, the `window.NetplayLockstep` object is defined. Add `exportSyncLog` to it:

```javascript
  window.NetplayLockstep = {
    init,
    stop,
    exportSyncLog,
    _startSpectatorStream: startSpectatorStream,  // test hook
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: expose exportSyncLog on NetplayLockstep public API"
```

### Task 4: Add Logs button to toolbar

**Files:**
- Modify: `web/play.html:152-155` (toolbar buttons area)
- Modify: `web/static/play.js` (add click handler near other toolbar handlers)

- [ ] **Step 1: Add button to play.html**

In `web/play.html`, after the `toolbar-remap` button (line 153) and before `toolbar-leave` (line 154), add:

```html
    <button id="toolbar-logs" class="toolbar-toggle" title="Download sync logs">Logs</button>
```

- [ ] **Step 2: Add click handler in play.js**

In `web/static/play.js`, find the toolbar button wiring area. After line ~2987 (the `igCancelBtn` handler that closes the remap overlay), add the logs handler. Note: the Logs button only produces output in lockstep mode — streaming mode's engine has no `exportSyncLog`, so the optional chaining returns `undefined` and the handler is a no-op:

```javascript
    // Sync log download
    const toolbarLogs = document.getElementById('toolbar-logs');
    if (toolbarLogs) {
      toolbarLogs.addEventListener('click', () => {
        const logs = engine?.exportSyncLog?.();
        if (!logs) return;
        const blob = new Blob([logs], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kn-sync-p${window._playerSlot ?? 'x'}-${Date.now()}.log`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }
```

- [ ] **Step 3: Verify in browser**

Load play.html, join a room, start a game. Click the "Logs" button in the toolbar. Verify a `.log` file downloads with tab-separated log entries.

- [ ] **Step 4: Commit**

```bash
git add web/play.html web/static/play.js
git commit -m "feat: add Logs toolbar button for mobile sync log download"
```

### Task 5: Add auto-dump on resync timeout

**Files:**
- Modify: `web/static/netplay-lockstep.js:2607-2613` (resync wait timeout in `tick()`)

- [ ] **Step 1: Add console.warn dump**

Note: This intentionally dual-logs — `_syncLog` writes a normal entry to the ring buffer (and `console.log`), while `console.warn` dumps the ENTIRE ring buffer as a single string for cases where DevTools is attached but the user can't click the Logs button.

Replace the timeout block at line 2607-2613:

```javascript
    if (_awaitingResync) {
      if (performance.now() - _awaitingResyncAt > 3000) {
        console.log('[lockstep] resync wait timeout — resuming');
        _awaitingResync = false;
      } else {
        return;
      }
    }
```

With:

```javascript
    if (_awaitingResync) {
      if (performance.now() - _awaitingResyncAt > 3000) {
        _syncLog('resync wait timeout — resuming');
        console.warn('[lockstep] resync timeout — log dump:\n' + exportSyncLog());
        _awaitingResync = false;
      } else {
        return;
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: auto-dump sync log on resync wait timeout"
```

## Chunk 2: Delta Sync Fix

### Task 6: Add `_setLastSyncState` helper

**Files:**
- Modify: `web/static/netplay-lockstep.js:3183` (near `_lastSyncState` declaration)

- [ ] **Step 1: Add helper function after `_lastSyncState` declaration**

At line 3183, replace:

```javascript
  let _lastSyncState = null;  // host: previous state for delta computation
```

With:

```javascript
  let _lastSyncState = null;  // host/guest: previous state for delta computation
  let _lastSyncStateInfo = null;  // { frame, setBy, ts } for debugging

  const _setLastSyncState = (state, reason) => {
    _lastSyncState = state;
    _lastSyncStateInfo = state
      ? { frame: _frameNum, setBy: reason, ts: performance.now() }
      : null;
    _syncLog(`deltaBase ${state ? 'SET' : 'NULL'} reason=${reason} frame=${_frameNum} size=${state?.length ?? 0}`);
  };
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add _setLastSyncState helper with diagnostic logging"
```

### Task 7: Migrate all `_lastSyncState` mutations to use the helper

**Files:**
- Modify: `web/static/netplay-lockstep.js` (7 mutation sites)

- [ ] **Step 1: Fix reconnect handler (line ~1054) — THE BUG FIX**

Replace:
```javascript
        _lastSyncState = null;  // force full resync after reconnect
```

With:
```javascript
        // Only guests should null their delta base on reconnect.
        // Host needs its delta base to survive peer lifecycle events.
        if (_playerSlot !== 0) {
          _setLastSyncState(null, 'reconnect');
        }
```

- [ ] **Step 2: Fix background tab return (line ~2364)**

Replace:
```javascript
        if (_playerSlot !== 0) {
          _lastSyncState = null;
        }
```

With:
```javascript
        if (_playerSlot !== 0) {
          _setLastSyncState(null, 'bg-return');
        }
```

- [ ] **Step 3: Fix stopSync cleanup (line ~2448)**

Replace:
```javascript
    _lastSyncState = null;
```

With:
```javascript
    _setLastSyncState(null, 'stopSync');
```

- [ ] **Step 4: Fix pushSyncState delta base set (line ~3234)**

Replace:
```javascript
    // Update delta base (guest caches after applying)
    _lastSyncState = currentState;
```

With:
```javascript
    // Update delta base (guest caches after applying)
    _setLastSyncState(currentState, 'pushSync');
```

- [ ] **Step 5: Fix applySyncState C-level path (line ~3339)**

Replace:
```javascript
      // Cache applied state as delta base for next resync
      _lastSyncState = bytes.slice();
```

With:
```javascript
      // Cache applied state as delta base for next resync
      _setLastSyncState(bytes.slice(), 'applySyncC');
```

- [ ] **Step 6: Fix applySyncState fallback path (line ~3365)**

Replace:
```javascript
      // Cache applied state as delta base
      _lastSyncState = new Uint8Array(bytes);
```

With:
```javascript
      // Cache applied state as delta base
      _setLastSyncState(new Uint8Array(bytes), 'applySyncFallback');
```

- [ ] **Step 7: Remove redundant stop() cleanup (line ~3484)**

This line is redundant — `stop()` calls `stopSync()` which already nulls `_lastSyncState`. Remove:

```javascript
    _lastSyncState = null;
```

(Just delete the line entirely to avoid a double-null log entry.)

- [ ] **Step 8: Verify no direct `_lastSyncState =` assignments remain**

Search the file for `_lastSyncState =` (with space before `=`). The only hits should be inside `_setLastSyncState` itself (the `_lastSyncState = state;` line). All other assignments should now go through the helper.

- [ ] **Step 9: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "fix: guard _lastSyncState mutations — host delta base survives peer reconnects"
```

### Task 8: Add fallback `.slice()` in pushSyncState

**Files:**
- Modify: `web/static/netplay-lockstep.js:3215` (fallback getState path)

- [ ] **Step 1: Add `.slice()` to prevent buffer aliasing**

At line 3215, replace:

```javascript
      currentState = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
```

With:

```javascript
      currentState = raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw);
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "fix: slice fallback getState result to prevent buffer aliasing"
```

## Chunk 3: Mobile Drift Diagnostics

### Task 9: Add drift stats tracker

**Files:**
- Modify: `web/static/netplay-lockstep.js:548-549` (state variables area)

- [ ] **Step 1: Add drift tracking state**

After the `_awaitingResyncAt` variable (line 549), add:

```javascript
  // Drift diagnostics
  let _driftStats = { count: 0, firstAt: 0, lastAt: 0, regions: {} };
  const _driftSummaryAt = [1, 5, 10, 20, 50, 100, 200, 500];  // exponential log intervals
```

- [ ] **Step 2: Add drift recording helper**

Add these functions immediately after the `_driftSummaryAt` line from Step 1 (co-located with their state variables near line ~551):

```javascript
  const _recordDrift = (regionHashes) => {
    const now = performance.now();
    _driftStats.count++;
    if (_driftStats.count === 1) _driftStats.firstAt = now;
    _driftStats.lastAt = now;

    // Tally per-region drifts if available
    if (regionHashes) {
      for (const [name, drifted] of Object.entries(regionHashes)) {
        if (drifted) _driftStats.regions[name] = (_driftStats.regions[name] || 0) + 1;
      }
    }

    // Log summary at exponential intervals
    if (_driftSummaryAt.includes(_driftStats.count) || (_driftStats.count > 0 && _driftStats.count % 100 === 0)) {
      const elapsed = (now - _driftStats.firstAt) / 1000;
      const avgInterval = _driftStats.count > 1 ? Math.round(elapsed * 1000 / (_driftStats.count - 1)) : 0;
      const regionStr = Object.entries(_driftStats.regions)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      _syncLog(`DRIFT-SUMMARY count=${_driftStats.count} over=${elapsed.toFixed(1)}s avgInterval=${avgInterval}ms regions=[${regionStr}]`);
    }
  };

  const _resetDrift = () => {
    _driftStats = { count: 0, firstAt: 0, lastAt: 0, regions: {} };
  };
```

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add drift rate tracker with exponential summary logging"
```

### Task 10: Wire drift tracker into desync detection

**Files:**
- Modify: `web/static/netplay-lockstep.js` (desync detection paths + sync OK paths)

- [ ] **Step 1: Add `_recordDrift()` calls at every DESYNC detection site**

There are 4 desync detection sites. At each one, after the DESYNC log line, add `_recordDrift(null)` (per-region hashes will be added in Task 11 for the C-level path).

**Site 1: C-level sync check (line ~1128-1130)**
After `_syncLog(desyncMsg);` (or wherever the DESYNC message is logged), add:
```javascript
                _recordDrift(null);
```

**Site 2: Fallback sync check (line ~1157-1159)**
After the DESYNC log, add:
```javascript
                    _recordDrift(null);
```

**Site 3: Deferred C-level sync check (line ~2635)**
After the DESYNC deferred log (`console.log('[lockstep] DESYNC (deferred)...`), add:
```javascript
            _recordDrift(null);
```

**Site 4: Deferred fallback sync check (line ~2660)**
After the DESYNC deferred log, add:
```javascript
                  _recordDrift(null);
```

- [ ] **Step 2: Add `_resetDrift()` at every "sync OK" site**

At each place where the sync check succeeds (hash match), add `_resetDrift()`:

**Site 1: C-level OK (line ~1146-1147)**
After `_syncCheckInterval = _syncBaseInterval;`, add:
```javascript
                _resetDrift();
```

**Site 2: Fallback OK (line ~1170-1171)**
After `_syncCheckInterval = _syncBaseInterval;`, add:
```javascript
                    _resetDrift();
```

**Site 3: Deferred C-level OK (line ~2649)**
After `_syncCheckInterval = _syncBaseInterval;`, add:
```javascript
            _resetDrift();
```

**Site 4: Deferred fallback OK (line ~2668)**
After `_syncCheckInterval = _syncBaseInterval;`, add:
```javascript
                  _resetDrift();
```

- [ ] **Step 3: Add `_resetDrift()` in stop() cleanup**

In the stop function (around line 3474), after `_consecutiveResyncs = 0;`, add:
```javascript
    _resetDrift();
```

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: wire drift tracker into desync detection and sync-ok paths"
```

### Task 11: Add cycle time to sync-hash protocol

**Files:**
- Modify: `web/static/netplay-lockstep.js:2681-2710` (host sync-hash sending)
- Modify: `web/static/netplay-lockstep.js:1115-1175` (guest sync-hash receiving)

- [ ] **Step 1: Host sends cycle time in sync-hash message**

At line 2684-2685 (C-level hash sending), replace:

```javascript
        const hash = mod._kn_sync_hash();
        const syncMsg = `sync-hash:${_frameNum}:${hash}`;
```

With:

```javascript
        const hash = mod._kn_sync_hash();
        const cycleMs = mod._kn_get_cycle_time_ms ? mod._kn_get_cycle_time_ms() : 0;
        const syncMsg = `sync-hash:${_frameNum}:${hash}:${cycleMs.toFixed(1)}`;
```

At line 2700-2701 (fallback hash sending), replace:

```javascript
            const syncMsg = `sync-hash:${checkFrame}:${res.hash}`;
```

With:

```javascript
            const syncMsg = `sync-hash:${checkFrame}:${res.hash}:0`;
```

- [ ] **Step 2: Guest parses cycle time and logs divergence**

At line 1117-1119 (guest parsing), replace:

```javascript
          const parts = e.data.split(':');
          const syncFrame = parseInt(parts[1], 10);
          const hostHash = parseInt(parts[2], 10);
```

With:

```javascript
          const parts = e.data.split(':');
          const syncFrame = parseInt(parts[1], 10);
          const hostHash = parseInt(parts[2], 10);
          const hostCycleMs = parts[3] !== undefined ? parseFloat(parts[3]) : null;
```

Then, inside the desync detection block for the C-level path (after `_recordDrift(null);` from Task 10, around line ~1131), add cycle divergence logging:

```javascript
                if (hostCycleMs !== null && mod._kn_get_cycle_time_ms) {
                  const guestCycleMs = mod._kn_get_cycle_time_ms();
                  _syncLog(`CYCLE-DRIFT host=${hostCycleMs.toFixed(1)}ms guest=${guestCycleMs.toFixed(1)}ms diff=${(guestCycleMs - hostCycleMs).toFixed(1)}ms`);
                }
```

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add cycle time to sync-hash protocol for drift diagnosis"
```

### Task 12: Add per-region hash logging on desync (JS-side, graceful)

**Files:**
- Modify: `web/static/netplay-lockstep.js` (C-level desync paths)

- [ ] **Step 1: Add per-region hash call on C-level desync (immediate path)**

In the C-level desync block (line ~1128), after `_recordDrift(null)` (added in Task 10) and the CYCLE-DRIFT logging (added in Task 11), add:

```javascript
                // Per-region hash for drift diagnosis (requires rebuilt WASM)
                if (mod._kn_sync_hash_regions) {
                  const hashBuf = mod._malloc(48);
                  const regionCount = mod._kn_sync_hash_regions(hashBuf, 12);
                  const hashes = new Uint32Array(regionCount);
                  for (let ri = 0; ri < regionCount; ri++) {
                    hashes[ri] = mod.HEAPU32[(hashBuf >> 2) + ri];
                  }
                  mod._free(hashBuf);
                  _syncLog(`REGION-HASH ${[...hashes].map((h, ri) => `${_diagRegionNames[ri]}=${h >>> 0}`).join(' ')}`);
                }
```

- [ ] **Step 2: Add per-region hash call on C-level desync (deferred path)**

Same code block, added after `_recordDrift(null)` in the deferred C-level desync path (line ~2635). The `mod` variable is already in scope there:

```javascript
            // Per-region hash for drift diagnosis (requires rebuilt WASM)
            if (mod._kn_sync_hash_regions) {
              const hashBuf = mod._malloc(48);
              const regionCount = mod._kn_sync_hash_regions(hashBuf, 12);
              const hashes = new Uint32Array(regionCount);
              for (let ri = 0; ri < regionCount; ri++) {
                hashes[ri] = mod.HEAPU32[(hashBuf >> 2) + ri];
              }
              mod._free(hashBuf);
              _syncLog(`REGION-HASH deferred ${[...hashes].map((h, ri) => `${_diagRegionNames[ri]}=${h >>> 0}`).join(' ')}`);
            }
```

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: log per-region RDRAM hashes on desync (graceful if WASM export missing)"
```

### Task 13: Add `kn_sync_hash_regions` to C patch

**Files:**
- Modify: `build/patches/mupen64plus-kn-all.patch`

- [ ] **Step 1: Add the new function to the patch**

The patch file `build/patches/mupen64plus-kn-all.patch` uses dense one-liners for all C functions. The new function must match this style.

In the patch file, after line 27 (the `kn_sync_hash` one-liner ending with `return hash; }`), add this new line:

```
+EMSCRIPTEN_KEEPALIVE uint32_t kn_sync_hash_regions(uint32_t *out_hashes, uint32_t max_count) { const uint8_t *rdram = (const uint8_t *)g_dev.rdram.dram; uint32_t count = max_count < 12 ? max_count : 12; uint32_t r; static const uint32_t regions[] = { 0xA4000, 0xBA000, 0xBF000, 0xC4000, 0x262000, 0x266000, 0x26A000, 0x290000, 0x2F6000, 0x32B000, 0x330000, 0x335000 }; static const int SAMPLE = 256; for (r = 0; r < count; r++) { uint32_t hash = 2166136261u; const uint8_t *p = rdram + regions[r]; int i; for (i = 0; i < SAMPLE; i++) { hash ^= p[i]; hash *= 16777619u; } out_hashes[r] = hash; } return count; }
```

Then update the `@@` hunk header on line 5 from `@@ -129,6 +129,29 @@` to `@@ -129,6 +129,30 @@` (one more added line).

- [ ] **Step 2: Commit**

```bash
git add build/patches/mupen64plus-kn-all.patch
git commit -m "feat: add kn_sync_hash_regions WASM export to C patch"
```

## Chunk 4: Cleanup

### Task 14: Delete stale kn-sync.patch

**Files:**
- Delete: `build/patches/kn-sync.patch`

- [ ] **Step 1: Delete the file**

```bash
rm build/patches/kn-sync.patch
```

- [ ] **Step 2: Verify build.sh doesn't reference it**

Search `build/build.sh` for `kn-sync`. Should find zero matches (it only uses `mupen64plus-deterministic-timing.patch` and `mupen64plus-kn-all.patch`).

- [ ] **Step 3: Commit**

```bash
git add -u build/patches/kn-sync.patch
git commit -m "chore: remove stale kn-sync.patch (superseded by kn-all patch)"
```

### Task 15: Reset sync log buffer in stop()

**Files:**
- Modify: `web/static/netplay-lockstep.js` (stop cleanup area)

- [ ] **Step 1: Reset ring buffer state in stop()**

In the stop function, find `_syncWorkerCallbacks = {};` and add the ring buffer reset immediately after it (note: the `_lastSyncState = null` that used to follow was removed in Task 7 Step 7, so the next line will be a blank or the audio cleanup block):

```javascript
    _syncLogHead = 0;
    _syncLogCount = 0;
```

(Don't reset `_syncLogSeq` — keep it monotonically increasing across game sessions for easier log correlation.)

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "chore: reset sync log ring buffer on stop"
```
