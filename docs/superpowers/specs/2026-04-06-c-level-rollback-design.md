# C-Level Rollback Netplay Design

## Problem

JS-level rollback replay produces divergent state cross-device (desktop ↔ mobile Safari) despite identical inputs and complete state capture. The divergence comes from the JS/WASM boundary: browser callbacks between replay frames, TypedArray view detachment, audio worklet timing, rAF scheduling differences. Pure lockstep (no predictions) works for 30+ minutes with zero desync, proving the emulation itself is deterministic.

## Solution

Move all rollback logic (save state, prediction, replay) into C code inside the mupen64plus core. The replay loop calls `retro_run()` directly — the same function as normal execution, with no JS between frames. JS only feeds inputs and calls tick.

## Architecture

A new C module (`kn_rollback.c`) manages a ring buffer of save states and an input buffer. JS calls `kn_tick()` once per 16ms. C handles everything internally:

1. Save state via `retro_serialize()` into pre-allocated ring slot
2. Check remote inputs for apply frame — use real input if present, predict (last known) if missing
3. Write inputs to N64 controller registers
4. Call `retro_run()` to advance one frame
5. Check if any pending `kn_feed_input()` corrected a prediction
6. On misprediction: `retro_unserialize()` to saved frame, replay N × `retro_run()` with corrected inputs in a tight C loop

No JS callbacks, no browser scheduling, no TypedArray views between replay frames.

## Data Flow

```
JS side:                          C side (kn_rollback.c):

WebRTC receives input ──→ kn_feed_input(slot, frame, btns, lx, ly, cx, cy)
                                  │
                                  ▼
                          Internal input ring buffer
                          [slot][frame % RING_SIZE] = input

setInterval(16ms) ──────→ kn_tick(local_btns, local_lx, local_ly, local_cx, local_cy)
                                  │
                                  ├─ retro_serialize() → ring[frame % N]
                                  ├─ Check remote inputs for apply_frame
                                  │   ├─ Present → use real input
                                  │   └─ Missing → predict (last known)
                                  ├─ Write inputs to controller registers
                                  ├─ retro_run()
                                  ├─ Check: did kn_feed_input correct a prediction?
                                  │   └─ Yes: retro_unserialize() → replay N × retro_run()
                                  └─ Return frame number

JS reads return value ──→ feedAudio(), update UI
```

## WASM Exports

```c
// Initialize — call once after emulator boots
void kn_rollback_init(int max_frames, int delay_frames, int local_slot);

// Feed remote input — call when WebRTC delivers input
void kn_feed_input(int slot, int frame, int buttons, int lx, int ly, int cx, int cy);

// Tick — call once per 16ms. Returns frame number.
int kn_tick(int buttons, int lx, int ly, int cx, int cy);

// Stats — JS polls for UI
int kn_get_rollback_count(void);
int kn_get_prediction_count(void);
int kn_get_max_depth(void);

// Cleanup
void kn_rollback_shutdown(void);

// Diagnostics
int kn_rollback_self_test(void);  // 1 = deterministic, 0 = bug
const char* kn_get_debug_log(void);
```

## State Ring Buffer

Pre-allocated at init. Each slot holds a full `retro_serialize()` output (~16MB). Number of slots = `max_frames + 1`, set by JS based on RTT measurement. Typical: 8 slots = ~128MB.

Allocation happens once at `kn_rollback_init()` via `malloc`. No allocation during gameplay.

## Input Buffer

Fixed-size ring: `input_ring[MAX_PLAYERS][MAX_RING_FRAMES]`. Each entry: `{buttons, lx, ly, cx, cy, present}`. `MAX_RING_FRAMES` = 256 (covers ~4 seconds at 60fps).

`kn_feed_input()` writes to the ring. `kn_tick()` reads from it. No locking needed — JS is single-threaded and `kn_tick()` runs synchronously.

## Prediction

When remote input is missing for `apply_frame`:
- Use last known input for that slot
- Mark frame as predicted: `predicted[slot][frame] = true`

When `kn_feed_input()` arrives for a predicted frame:
- Compare with prediction
- If match: `correct_predictions++`
- If mismatch: set `pending_rollback = min(pending_rollback, frame)`

## Replay

At the start of `kn_tick()`, before the normal frame step:

```c
if (pending_rollback >= 0) {
    int depth = current_frame - pending_rollback;
    retro_unserialize(ring[pending_rollback % ring_size]);
    for (int i = 0; i < depth; i++) {
        write_controller_inputs(pending_rollback + i);
        retro_run();  // Same function as normal tick
        retro_serialize(ring[(pending_rollback + i) % ring_size]);  // Re-save
    }
    pending_rollback = -1;
}
```

Key: `retro_run()` during replay is the same function call as during normal execution. No headless mode, no special flags, no different code path.

## Mode

Always rollback. No screen detection, no lockstep/rollback mode switching. Menus have low input activity so predictions are almost always correct (no rollbacks needed). Gameplay gets full rollback benefit.

## Diagnostics

### Self-test

`kn_rollback_self_test()` runs on-device:
1. `retro_serialize(buf_a)`
2. `retro_run()` with zero input
3. Hash RDRAM → `hash_1`
4. `retro_unserialize(buf_a)`
5. `retro_run()` with zero input
6. Hash RDRAM → `hash_2`
7. `retro_unserialize(buf_a)` (restore original state)
8. Return `hash_1 == hash_2`

### Per-replay hash

After every replay, hash the state and compare with what normal execution would produce. Log mismatches with frame number and depth via internal ring buffer. JS reads via `kn_get_debug_log()`.

## JS Changes

Current lockstep engine (`netplay-lockstep.js`) changes:
- Remove all JS prediction, snapshot, replay, correction code
- Remove screen detection, delta sync, rollback stats from JS
- Replace `setInterval(tick, 16)` with `setInterval(() => { kn_tick(localInput); feedAudio(); }, 16)`
- `kn_feed_input()` called from WebRTC DataChannel `onmessage` handler
- `kn_rollback_init()` called after emulator boots and RTT is measured
- Stats read via `kn_get_*` exports for UI overlay

Existing lockstep infrastructure stays: WebRTC mesh, Socket.IO signaling, audio bypass, input encoding/decoding, late join, spectators, resync (as fallback).

## Files

| File | Action |
|------|--------|
| `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c` | Create — rollback engine |
| `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h` | Create — header |
| `build/src/mupen64plus-libretro-nx/libretro/libretro.c` | Modify — expose WASM exports |
| `build/src/RetroArch/Makefile.emulatorjs` | Modify — add exports to EXPORTED_FUNCTIONS |
| `build/build.sh` | Modify — compile new file |
| `web/static/netplay-lockstep.js` | Modify — use C-level tick instead of JS tick |

## Why This Fixes Desyncs

1. Pure lockstep = zero desync for 30+ minutes (proven)
2. Pure lockstep = identical inputs → identical state (proven)
3. Rollback replay calls the same `retro_run()` as normal play
4. No JS between replay frames — no browser callbacks, no TypedArray views, no timing differences
5. Therefore: replay produces the same state as normal play
6. Therefore: both players converge after rollback
