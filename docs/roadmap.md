# kaillera-next — Feature Roadmap (EmuLinker-K Modernized)

## Context

V1 netplay (2-player WebRTC input sync) is working. This roadmap captures the full feature set
inspired by EmuLinker-K / classic Kaillera, modernized for P2P WebRTC + browser. Ship in phases —
earliest features block the most desyncs; later features add the social/lobby polish that made
Kaillera compelling.

---

## Phase 1: Cheat Sync — Standard Online Config ✅ in progress

SSB64 RNG drives items, stage hazards, and physics. All players must start with identical game
config or the game diverges silently on frame 1. We apply a hardcoded standard online config
automatically on all clients when netplay starts — no host configuration required.

**Cheats applied (N64 GameShark format, sourced from smashboards/smash64.net):**
- `810A4938 0FF0` — Have All Characters (Captain Falcon, Ness, Jigglypuff, Luigi)
- `800A4937 00FF` — Have Mushroom Kingdom + Item Switch menu access
- `800A4B25 0000` — Items off group 1 (Bumper, Shell, Poké Ball)
- `800A4B26 0000` — Items off group 2 (Hammer, Motion-Sensor Bomb, Bob-omb, Fire Flower)
- `800A4B27 0000` — Items off group 3 (Bat, Fan, Ray Gun, Star Rod)

**Files:** `web/static/netplay.js` only. No server changes.

---

## Phase 2: Frame Delay / Lockstep

Without delay, both players apply local input at frame T but remote input arrives at T+lag →
both machines diverge. Kaillera's solution: delay N frames, applying frame-T inputs at T+N so
both players have received each other's input before applying it.

**Protocol change:** `Int32Array([mask])` 4 bytes → `Int32Array([frameNum, mask])` 8 bytes.

**Files:** `web/static/netplay.js` only.

---

## Phase 3: 4-Player + Spectators

Classic Kaillera supports up to 4 players. EJS supports ports 0–3.

**Architecture: Full mesh P2P** — each of 4 players connects directly to the other 3 via
RTCDataChannel (6 connections total, 3 per client). No host bottleneck, no extra relay hop.
Host's only special role is orchestrating WebRTC offers/answers for newcomers via Socket.IO.

**Spectators:** slot = null, receive game feed, no input send. Can claim vacated player slots.

**Files:** `web/static/netplay.js` + `server/src/api/signaling.py`.

---

## Phase 4: Join / Leave Running Games

Drop-in / drop-out quality of life inspired by EmuLinker-K.

**Late join:** Host sends save state blob via Socket.IO `data-message` → new player loads it
via `gameManager.loadState()`, then syncs at next delay boundary.

**Player departure:** Vacated slot zeroed (buttons released), spectators can claim it via
`claim-slot` Socket.IO event.

**Files:** `web/static/netplay.js` + `server/src/api/signaling.py`.

---

## Phase 5: Desync Detection + Auto-Resync

**Detection:** Hash 4KB slice of Wasm RDRAM every 60 frames; exchange hashes on data channel.
Mismatch → trigger resync.

**Resync (host-authoritative):** Desynced client sends `resync-request` → host saves state →
sends `resync-state` to all peers → all clients load it at frame F+N simultaneously. Input queues
reset. Transparent to players (brief 1-frame glitch, then play continues).

**Files:** `web/static/netplay.js` only.

---

## Verification

Every phase has mandatory Playwright verification using `mcp__playwright__*` tools. Each feature
must be verified via `browser_evaluate` (JS state inspection), `browser_console_messages` (log
output), and `browser_take_screenshot` before being considered done. See plan file for detailed
assertion scripts per phase.
