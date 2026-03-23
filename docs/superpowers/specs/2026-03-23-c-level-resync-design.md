# C-Level Resync for Lockstep Netplay

## Problem

Desync detection works — the host hashes RDRAM regions and guests compare. But resync is broken. `loadState()` blocks the main thread (3-10ms on mobile), triggers WASM memory growth which detaches `HEAPU8.buffer`, and cascades into false desync storms. JS-level mitigations (backoff, cooldowns, skip windows) have been tried extensively and don't work.

The root cause: `getState()`/`loadState()` go through RetroArch's `retro_serialize`/`retro_unserialize` API, which serializes the entire 16MB emulator state (including 8MB of TLB lookup tables that can be rebuilt from 1.5KB of entries), allocates temporary buffers, and crosses the JS/WASM boundary with large typed arrays that become invalid after memory growth.

## Solution

New C-level exports that read/write emulator state directly from `g_dev` struct fields — bypassing `retro_serialize`/`retro_unserialize` entirely. No allocation, no memory growth, no buffer detachment.

## C-Level Exports

Three new functions in `build/src/RetroArch/frontend/drivers/platform_emulatorjs.c`, following the existing `_kn_*` pattern:

### `_kn_sync_read(uint8_t* buf, uint32_t max_size)` → uint32_t (bytes written)

Copies gameplay-critical state into a caller-provided buffer:

| Section | Source | Size |
|---|---|---|
| RDRAM | `g_dev.rdram.dram` | 8MB |
| R4300 GPR | `r4300_regs()` | 256B (32 x int64) |
| CP0 regs | `r4300_cp0_regs()` | 128B (CP0_REGS_COUNT x uint32) |
| CP0 extras | `next_interrupt`, `cp0_cycle_count` | 8B |
| CP1 regs | `r4300_cp1_regs()` | 256B (32 x int64) |
| CP1 control | fcr0, fcr31 | 8B |
| llbit, hi, lo | `r4300_llbit()`, `_mult_hi()`, `_mult_lo()` | 20B |
| PC | `r4300_pc()` | 4B |
| VI timing | `vi.field`, `vi.delay` | 8B |
| TLB entries | `cp0.tlb.entries[32]` | ~1.5KB |
| Event queue | `save_eventqueue_infos()` | 1KB |
| SP memory | `g_dev.sp.mem` | 8KB |
| PIF RAM | `g_dev.pif.ram` | 64B |

Total: ~8,203KB. Header prefix with section sizes for forward compatibility.

Does NOT include: TLB LUT tables (8MB, rebuilt from entries via PJ64-style restore), plugin state, audio state, video state, HW register state (MI, PI, SI, VI, AI, DP, RI — these are tiny but don't drift between players), flashram state (SSB64 uses EEPROM).

### `_kn_sync_write(const uint8_t* buf, uint32_t size)` → int (0 = success)

Reverse of `_kn_sync_read`: copies data back into `g_dev` fields. Post-restore steps:

1. **TLB rebuild:** Clear `LUT_r`/`LUT_w` (8MB memset), then iterate 32 TLB entries calling existing TLB mapping functions — same approach as the PJ64 load path in `savestates.c` (lines 1281-1318). The 8MB memset costs ~0.5-1ms in WASM; this is the dominant cost of `_kn_sync_write`.
2. **FPR pointer setup:** Call `set_fpr_pointers(&dev->r4300.cp1, cp0_regs[CP0_STATUS_REG])` to reconfigure FPR aliasing based on the FR bit. Without this, floating-point results are silently wrong.
3. **PC restoration:** Use `savestates_load_set_pc()` (or equivalent) to properly update the instruction pointer pipeline, not just write to `*r4300_pc()`.
4. **Event queue:** Call `load_eventqueue_infos()` which internally sets `next_interrupt` via `cp0_cycle_count`.
5. **PIF channels:** Call `setup_channels_format(&dev->pif)` after restoring PIF RAM to reconfigure controller channel routing.

### `_kn_sync_hash()` → uint32_t

FNV-1a hash of the SSB64 VS mode RDRAM regions, computed entirely in C from `g_dev.rdram.dram`. Same regions currently hashed from JS:

- `0xA4000` (256B) — player/match config
- `0xBA000-0xC7000` (sampled) — player state
- `0x262000-0x26C000` (sampled) — physics/animation
- `0x32B000-0x335000` (sampled) — physics/animation

Returns a uint32_t hash value directly — no typed arrays, no async, no worker.

## Build Integration

Direct edits to source files (no patch files):

- `build/src/RetroArch/frontend/drivers/platform_emulatorjs.c` — add the three functions with `EMSCRIPTEN_KEEPALIVE`
- `build/src/RetroArch/Makefile.emulatorjs` — add `_kn_sync_read,_kn_sync_write,_kn_sync_hash` to `EXPORTED_FUNCTIONS`
- `build/build.sh` — remove `git checkout -- .` lines so edits persist across builds

## JS Changes (netplay-lockstep.js)

### Init

```
_hasKnSync = !!(mod._kn_sync_read)
_syncBufPtr = mod._malloc(8 * 1024 * 1024 + 16384)  // ~8.2MB + headroom
```

Feature detection allows fallback to existing `getState()`/`loadState()` path on stock CDN core.

### Hash Check (replaces getHashBytes + worker hash)

Current: `getHashBytes()` reads HEAPU8 at RDRAM pointer, sends to worker for FNV hash.

New: `mod._kn_sync_hash()` — single synchronous C call, returns uint32_t. No typed array, no worker, no async. Broadcast: `'sync-hash:' + frame + ':' + hash`.

### Resync (replaces pushSyncState / applySyncState)

**Host (on sync-request):**
1. `mod._kn_sync_read(_syncBufPtr, maxSize)` — C copies state into WASM buffer
2. JS reads bytes: `new Uint8Array(mod.HEAPU8.buffer, _syncBufPtr, bytesWritten)`
3. XOR delta against `_lastSyncState` (full if no base yet)
4. Compress in worker (off main thread)
5. Send via DC in 64KB chunks

**Guest (on receiving chunks):**
1. Reassemble chunks, decompress in worker (off main thread)
2. Reconstruct from delta if needed (XOR with guest's cached `_lastSyncState` from its own previous `_kn_sync_read`)
3. `mod.HEAPU8.set(data, _syncBufPtr)` — copy into WASM buffer
4. `mod._kn_sync_write(_syncBufPtr, size)` — C writes state back into emulator

**Delta bookkeeping:** Both host and guest maintain `_lastSyncState` — the bytes from their own last `_kn_sync_read`. Host uses it to compute the XOR delta to send. Guest uses it to reconstruct full state from the received delta. Reset to null on reconnect/background return (forces full send).

**Main thread cost: <2ms** (C-side memcpy only). No `loadState()`, no memory growth, no cascade.

### Reconnect / Background Return

- Reset `_lastSyncState = null` (forces full send on next resync)
- Trigger immediate sync check
- Same resync path handles it — no special case

### Removed Code (resync path only)

- `getHashBytes()` HEAPU8 reading logic (kept as fallback behind `_hasKnSync`)
- Worker-based FNV hash for sync checks
- `applySyncState()`'s `loadState()` call and post-loadState recovery code
- `_hashRegion` tracking and invalidation

### Kept As-Is

- Initial game start sync (still `getState()`/`loadState()` — happens once, pre-gameplay)
- `updateMemoryViews` / `_emscripten_notify_memory_growth` hacks (still needed for initial `getState()`/`loadState()` path)
- Delta compression/decompression in worker (same XOR + gzip pattern)
- DC chunk sending (`sendSyncChunks`)
- `_pushingSyncState` debounce flag (prevents concurrent resync operations)

## Deliverables

**What "done" looks like:**

1. **Seamless resync** — when a desync is detected, the guest's state is corrected with zero visible hitch. No frame stutter, no audio pop, no frozen screen. The player should not be able to tell a resync happened.
2. **Cross-platform** — works on desktop Chrome/Firefox/Safari, mobile Safari (iPhone), mobile Chrome/Firefox (Android). Mobile is the hardest case (the current loadState path freezes mobile) and is the primary validation target.
3. **Reconnect works** — a player whose WebRTC DataChannel drops and reconnects gets resynced via the same path. No special handling, no degraded experience.
4. **Background tab return works** — a player who tabs away and comes back gets resynced smoothly. No freeze, no cascade.
5. **Stock core fallback** — players using the CDN core (no patches) fall back to the existing getState/loadState path. It won't be seamless, but it won't crash.

**What we're NOT delivering:**
- Game state machine (hash different regions per game screen) — future work
- Support for games other than SSB64 — hash regions are hardcoded
- Core-level determinism fixes (RNG/counter alignment) — separate effort
- Elimination of drift itself — mobile will still drift, but resyncs are now invisible

## Risks

**TLB rebuild correctness:** The most complex part. Uses the PJ64-style restore path (memset LUTs + remap from entries). The PJ64 load path in `savestates.c` proves this works. The 8MB memset adds ~0.5-1ms to write cost. Mitigation: follow the PJ64 path exactly.

**Post-restore side effects:** Several core functions must be called after restoring state — `set_fpr_pointers`, `savestates_load_set_pc`, `setup_channels_format`, `load_eventqueue_infos`. Missing any of these causes silent corruption or crashes. Mitigation: model `_kn_sync_write` directly on the `savestates_load_m64p` restore sequence.

**Missing state sections:** We intentionally skip HW registers (MI, PI, SI, VI, AI, DP, RI) and plugin state. If any of these drift between players and affect gameplay, resyncs won't fix them. Mitigation: these registers are set by the game code which runs from RDRAM — with RDRAM + CPU synced, the registers should converge within a few frames.

**SSB64-specific hash regions:** `_kn_sync_hash()` hardcodes SSB64 VS mode RDRAM regions. Other games would need different regions. Acceptable for v1 (SSB64 only). Can be parameterized later via a `_kn_sync_set_hash_regions()` setup call.

**Endianness:** Both host and guest are WASM (little-endian). RDRAM is stored in N64-native big-endian in `g_dev.rdram.dram`. Since both sides are identical architecture, raw memcpy is correct — no byte-swapping needed.

**Stock core fallback:** The `_hasKnSync` feature detection means stock CDN core users get the old `getState()`/`loadState()` path. This is acceptable — the old path works for desktop browsers where the cascade is less severe.

## Performance Expectations

| Operation | Cost | Where |
|---|---|---|
| `_kn_sync_hash()` | <0.1ms | Main thread (C memcpy + hash) |
| `_kn_sync_read()` | ~0.5ms | Main thread (C memcpy) |
| `_kn_sync_write()` | ~1-2ms | Main thread (C memcpy + 8MB TLB LUT memset + remap) |
| Delta XOR | ~2ms | Worker thread (off main) |
| Compress/decompress | ~5ms | Worker thread (off main) |
| DC transfer (delta) | 10-50ms | Network |
| DC transfer (full) | 50-200ms | Network |

Total main thread blocking per resync: **~2-3ms** (within a single 16ms frame).
