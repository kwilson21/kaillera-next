# kaillera-next — Feature Roadmap (EmuLinker-K Modernized)

> **Status: All V1 phases complete.** Current focus is V2: Mupen64Plus desktop client,
> Kaillera protocol compatibility, and KREC recording/playback.

## Context

V1 netplay shipped as a browser-based WebRTC platform with lockstep and streaming modes.
This roadmap captures the features inspired by EmuLinker-K / classic Kaillera, modernized
for P2P WebRTC + browser. All five phases are done.

---

## Phase 1: Cheat Sync -- Standard Online Config [done]

SSB64 RNG drives items, stage hazards, and physics. All players must start with identical game
config or the game diverges silently on frame 1. We apply a hardcoded standard online config
automatically on all clients when netplay starts -- no host configuration required.

**Cheats applied (N64 GameShark format, sourced from smashboards/smash64.net):**
- `810A4938 0FF0` -- Have All Characters (Captain Falcon, Ness, Jigglypuff, Luigi)
- `800A4937 00FF` -- Have Mushroom Kingdom + Item Switch menu access
- `800A4B25 0000` -- Items off group 1 (Bumper, Shell, Poke Ball)
- `800A4B26 0000` -- Items off group 2 (Hammer, Motion-Sensor Bomb, Bob-omb, Fire Flower)
- `800A4B27 0000` -- Items off group 3 (Bat, Fan, Ray Gun, Star Rod)

**Files:** `web/static/netplay-lockstep.js`. No server changes.

---

## Phase 2: Frame Delay / Lockstep [done]

Without delay, both players apply local input at frame T but remote input arrives at T+lag ->
both machines diverge. Solution: delay N frames, applying frame-T inputs at T+N so
both players have received each other's input before applying it.

**Protocol change:** `Int32Array([mask])` 4 bytes -> `Int32Array([frameNum, mask])` 8 bytes.

**Files:** `web/static/netplay-lockstep.js`.

---

## Phase 3: 4-Player + Spectators [done]

Classic Kaillera supports up to 4 players. EJS supports ports 0-3.

**Architecture: Full mesh P2P** -- each of 4 players connects directly to the other 3 via
RTCDataChannel (6 connections total, 3 per client). No host bottleneck, no extra relay hop.
Host's only special role is orchestrating WebRTC offers/answers for newcomers via Socket.IO.

**Spectators:** slot = null, receive game feed, no input send. Can claim vacated player slots.

**Files:** `web/static/netplay-lockstep.js` + `server/src/api/signaling.py`.

---

## Phase 4: Join / Leave Running Games [done]

Drop-in / drop-out quality of life inspired by EmuLinker-K.

**Late join:** Host sends save state blob via Socket.IO `data-message` -> new player loads it
via `gameManager.loadState()`, then syncs at next delay boundary.

**Player departure:** Vacated slot zeroed (buttons released), spectators can claim it via
`claim-slot` Socket.IO event.

**Files:** `web/static/netplay-lockstep.js` + `server/src/api/signaling.py`.

---

## Phase 5: Desync Detection + Auto-Resync [done]

**Detection (star topology, host-authoritative):** Two hashing paths:
1. C-level (patched core): `_kn_sync_hash()` hashes game-specific RDRAM regions directly
   in C. Per-region checksums via `_kn_sync_hash_regions` for targeted desync diagnosis.
2. JS fallback: FNV-1a hash of RDRAM via direct HEAPU8 access, falling back to
   `getState()` serialization.

Host broadcasts `sync-hash:frame:hash:cycleMs` every ~120 frames (~2s). Guests compare
their own hash — mismatch triggers resync.

**Resync (host-authoritative):** Desynced client sends `sync-request` -> host exports state
via `_kn_sync_read()` (C-level) or `getState()` (JS fallback), compresses and sends via
DataChannel in 64KB chunks -> guest buffers state for async application at next clean frame
boundary via `_kn_sync_write()`. No mid-frame stall — gameplay continues during transfer.

**Diagnostics:** Sync log ring buffer, per-region hash logging on mismatch, drift rate
tracking, exportable CSV logs via `debug-sync` Socket.IO event.

**Files:** `web/static/netplay-lockstep.js`, `server/src/api/signaling.py` (debug-sync,
debug-logs events), `server/src/api/app.py` (POST /api/sync-logs).
