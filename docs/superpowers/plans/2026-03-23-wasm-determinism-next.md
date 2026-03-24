# WASM Determinism — Guest Boot + Visual Glitch Fix

## Status: Visual fix confirmed ✓ — iPhone input stall remains

We're on the `wasm-determinism` branch. Cross-engine WASM determinism is achieved using `wasm-opt --denan` + `build/fix-denan.py` (canonical NaN). Sync is perfect for 155+ seconds across Chrome (V8) and iPhone Safari (JSC/WebKit).

### 1. Guest visual glitches — FIXED ✓

**Fix:** Both host and guest boot 120+ frames before state exchange, warming GLideN64's texture cache.

**AudioContext / Asyncify boot problem (solved):**
- Emscripten uses ASYNC=1 (Asyncify). SDL2 audio init at ~frame 6 stalls permanently without user gesture
- `resumeMainLoop()` after stall: works on Chrome, NOT on iOS Safari (Asyncify state corrupted)
- Force-stepping via RAF interception: crashes with `memory access out of bounds`
- **Working fix:** Delay emulator start until user taps. "Tap anywhere to start" prompt shown for guests. Emulator starts within gesture context → audio works → boots to 120 frames.

**Tested and confirmed:** Game ran ~8800 frames (2.5 min) across 3 players (2x Chrome + iPhone). Visual glitches (washed-out portraits, flat stock icons) are gone on all guests.

### 2. iPhone input stalls during gameplay — NEEDS INVESTIGATION

After ~8800 frames, iPhone froze and fell behind:
- Host received burst of duplicate old frames (`recvF=8785` × 50+)
- Host stalls 500ms per missing frame, injects zero → game crawls at ~2fps
- `rBuf={"2":63-92}` shows iPhone sent future inputs but specific needed frames are missing (gap)
- Triggered when user shared a spectate link
- Check session `HHE79RUK` logs (slot 2) for iPhone perspective
- Likely iOS lifecycle event (app backgrounding, Safari suspension) caused the freeze

### 3. Occasional lag spikes

Remaining spikes from periodic sync checks (RDRAM hashing). Mitigate by increasing `_syncBaseInterval` or async hashing.

## Key files
- `web/static/netplay-lockstep.js` — lockstep engine, tick loop, state sync, boot sequence
- `web/play.html` — play page
- `build/fix-denan.py` — patches --denan helpers from NaN→0 to NaN→canonical

## Dead ends (do NOT retry)
- C-level LWC1/LDC1 canonicalization — corrupts integer data
- kn_canon_fpu_regs per-frame sweep — same corruption
- kn_reset_cycle_count — corrupts host interrupt queue
- wasm-opt -O3/-Os after --denan — breaks fix-denan.py patterns
- C-level fpu_check_output_* on all players — visual glitches everywhere
- Force-stepping stalled emulator via RAF interception — `memory access out of bounds`
- `Object.defineProperty(ctx, 'state')` AudioContext override — doesn't unblock Asyncify
- `resumeMainLoop()` after Asyncify stall on iOS — state permanently corrupted
- Pre-creating AudioContext without user gesture — doesn't unlock on iOS

## Next steps
1. Investigate iPhone input stalls (HHE79RUK slot 2 logs, iOS lifecycle)
2. ROM preloading — start transfer when host enables sharing (separate task)
