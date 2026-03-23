# WASM Determinism — Next Session Prompt

## Context
Copy this into the next session to continue the work.

---

We're on the `wasm-determinism` branch. Cross-engine WASM determinism is achieved using `wasm-opt --denan` + `build/fix-denan.py` (canonical NaN). Sync is perfect for 155+ seconds across Chrome (V8) and iPhone Safari (JSC/WebKit).

**Two remaining issues:**

### 1. Guest visual glitches (character portraits washed out, flat stock icons)
- Affects ALL guests (desktop P2 and mobile), NOT the host
- The host looks perfect because V8 already produces 0x7FC00000 as canonical NaN — the --denan check is a no-op on the host, so RDRAM stays unchanged
- Guests load the host's save state, which includes RDRAM but NOT GLideN64's GPU state (texture cache, framebuffers). GLideN64 on guests has to reconstruct textures from RDRAM, and during reconstruction the --denan canonicalization changes intermediate FPU results
- The fix: **have guests boot fully (120+ frames, same as host) before loading the host's save state**. This warms up GLideN64's texture cache so it doesn't need to rebuild from scratch after state load

**Implementation plan:**
- Currently in `netplay-lockstep.js`, the host boots 120+ frames (`MIN_BOOT_FRAMES`), captures state, sends to guests. Guests boot minimally (~10 frames), load state, start lockstep.
- Change: guests should ALSO boot 120+ frames before loading the host's state. This means the guest's emulator runs the same game to the same point, building up GLideN64's texture cache naturally.
- The save state (loadState) only overwrites CPU/RDRAM state, not GLideN64 internals. So the guest's warm texture cache should persist through the state load.
- Look at `waitForEmu()` in netplay-lockstep.js — it has different boot thresholds for host vs guest. Change the guest threshold to match the host.

### 2. Occasional lag spikes
- Consistent lag was from the diagnostic logger (now disabled)
- Remaining lag spikes are from periodic sync checks (RDRAM hashing via web worker every `_syncCheckInterval` frames). These are part of the lockstep protocol and needed for desync detection.
- Could be mitigated by increasing `_syncBaseInterval` or making the hash computation async without blocking the tick loop.

## Key files
- `web/static/netplay-lockstep.js` — lockstep engine, tick loop, state sync
- `build/fix-denan.py` — patches --denan helpers from NaN→0 to NaN→canonical
- `build/build.sh` — WASM core build pipeline (Docker)
- `build/patches/mupen64plus-wasm-determinism.patch` — compiler flags, srand(0), deterministic RTC

## What NOT to do (dead ends)
- C-level LWC1/LDC1 canonicalization — corrupts integer data moved through FPU registers
- C-level SWC1/SDC1/MFC1/DMFC1 without --denan — still desyncs at f=2800
- kn_canon_fpu_regs per-frame sweep — same corruption as LWC1
- kn_reset_cycle_count — corrupts host interrupt queue
- wasm-opt -O3/-Os after --denan — breaks fix-denan.py byte patterns
- C-level fpu_check_output_* on all players — visual glitches everywhere (game uses NaN legitimately)

## Build & deploy
```bash
# Build WASM core (Docker)
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh

# Apply --denan post-processing
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c '
  /opt/emsdk/upstream/bin/wasm-opt --all-features --denan -o /tmp/out.wasm /build/output/mupen64plus_next_libretro.wasm
  python3 /build/fix-denan.py /tmp/out.wasm
  cp /tmp/out.wasm /build/output/mupen64plus_next_libretro.wasm
'

# Repackage
cd build/output && 7z a mupen64plus_next-wasm.data *.js *.wasm core.json build.json license.txt

# Deploy
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

## Testing
- 3 players: 2x Chrome desktop + 1x iPhone (FxiOS = WebKit/JSC)
- Start game, verify sync via DIAG-HASH in logs/live.log (re-enable _streamSync to test)
- Check visual quality on all players
- Monitor FPS via debug overlay
