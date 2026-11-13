# kaillera-next — Feature Roadmap (EmuLinker-K Modernized)

> **Status: All V1 phases complete.** Current focus is V2: Mupen64Plus desktop client,
> Kaillera protocol compatibility, and KREC recording/playback.

## Context

V1 netplay shipped as a browser-based WebRTC platform with lockstep and streaming modes.
This roadmap captures the features inspired by EmuLinker-K / classic Kaillera, modernized
for P2P WebRTC + browser. All six phases are done.

---

## Phase 1: Cheat Sync -- Standard Online Config [done]

SSB64 RNG drives items, stage hazards, and physics. All players must start with identical game
config or the game diverges silently on frame 1. We apply a hardcoded standard online config
automatically on all clients when netplay starts -- no host configuration required.

**Cheats applied (N64 GameShark format, sourced from smashboards/smash64.net):**
- `810A4938 0FF0` -- Have All Characters (Captain Falcon, Ness, Jigglypuff, Luigi)
- `800A4937 00FF` -- Have Mushroom Kingdom + Item Switch menu access
- `800A4D0B 0002` -- Stock Mode
- `800A4D0F 0004` -- 5 Stocks
- `800A4D11 0001` -- Timer On
- `800A4D24 0000` -- Items Off
- `810BA9F1 0000+800BA9F3 0000` -- No Wind

**Files:** `web/static/netplay-rollback.js`. No server changes.

---

## Phase 2: Frame Delay / Lockstep [done]

Without delay, both players apply local input at frame T but remote input arrives at T+lag ->
both machines diverge. Solution: delay N frames, applying frame-T inputs at T+N so
both players have received each other's input before applying it.

**Protocol change:** `Int32Array([mask])` 4 bytes -> `Int32Array([frameNum, mask])` 8 bytes.

**Files:** `web/static/netplay-rollback.js`.

---

## Phase 3: 4-Player + Spectators [done]

Classic Kaillera supports up to 4 players. EJS supports ports 0-3.

**Architecture: Full mesh P2P** -- each of 4 players connects directly to the other 3 via
RTCDataChannel (6 connections total, 3 per client). No host bottleneck, no extra relay hop.
Host's only special role is orchestrating WebRTC offers/answers for newcomers via Socket.IO.

**Spectators:** slot = null, receive game feed, no input send. Can claim vacated player slots.

**Files:** `web/static/netplay-rollback.js` + `server/src/api/signaling.py`.

---

## Phase 4: Join / Leave Running Games [done]

Drop-in / drop-out quality of life inspired by EmuLinker-K.

**Late join:** Host sends save state blob via Socket.IO `data-message` -> new player loads it
via `gameManager.loadState()`, then syncs at next delay boundary.

**Player departure:** Vacated slot zeroed (buttons released), spectators can claim it via
`claim-slot` Socket.IO event.

**Files:** `web/static/netplay-rollback.js` + `server/src/api/signaling.py`.

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

**Files:** `web/static/netplay-rollback.js`, `server/src/api/signaling.py` (debug-sync,
debug-logs events), `server/src/api/app.py` (POST /api/session-log).

---

## Phase 6: C-level Rollback Netcode [done]

Lockstep + frame delay is responsive up to ~100 ms RTT; past that, input lag becomes
painful. Rollback adds speculative execution: the local client predicts remote inputs
(last-known value), steps forward, and if the real input arrives differently, rewinds
via state restore + replay. Built entirely in C for bit-exact replay semantics.

**C engine (`build/kn_rollback/`):** state ring buffer, frame-tagged input ring,
prediction tracking, amortized replay (1 frame per tick), taint bitmap for RDRAM
write tracking. Exposes `kn_pre_tick` / `kn_post_tick` / `kn_feed_input` /
`kn_game_state_hash` / `kn_taint_rdram`.

**Cross-device determinism fixes required to make mobile↔mobile work:**
- `invalidate_cached_code_hacktarux` after `retro_unserialize` (JIT cache stale)
- SoftFloat FPU for bit-exact cross-browser floating-point (separate shipped earlier)
- `platform_emscripten_should_drop_iter` forced false in deterministic mode (Safari
  was silently skipping frames on transient tab-hidden events)
- `dp.fb` framebuffer tracker serialized across save/load
- RSP HLE taint hooks for direct `memcpy(hle->dram + addr, ...)` writes that bypass
  `memory.h` store helpers (alist_save, envelope saves, cicx105, mp3 decoder)
- GLideN64 taint hooks for ColorBuffer/DepthBuffer → RDRAM copybacks
- Symmetric delay negotiation: guests defer `kn_rollback_init` until the host's
  authoritative `rb-delay:` broadcast arrives, preventing asymmetric rollback/lockstep
  protocol mismatch across peers

**Final mobile↔mobile test:** 80/80 RB-CHECK matches over 7m 53s with bit-identical
16 MB save buffers across iPhone and iPad. Match terminated by WebRTC DC drop, not
desync. Rollback activates automatically when the WASM core exports `kn_pre_tick`
(current patched core does); no UI mode selector needed.

**Files:** `build/kn_rollback/kn_rollback.{c,h}`, `build/patches/mupen64plus-rsp-taint.patch`,
`build/patches/gliden64-rdram-taint.patch`, `build/patches/mupen64plus-static-save-scratch.patch`,
`web/static/netplay-rollback.js` (deferred init, RB-CHECK, input audit, knDiag).

**Followup:** WebRTC DC reconnect when Socket.IO signaling survives — shipped: a 30s
server-side disconnect grace period plus client-side reconnect retries (see CHANGELOG.md).

---

## Phase 7: Frontend overhaul (TypeScript, Effect, XState, Quint, LemmaScript) [in progress]

The frontend moves from plain scripts to a typed core in `web/src/`, bundled
to `web/static/dist/kn-core.js` and exposed as `window.KNCore`. Each stage
ships on its own and leaves the site working; nothing is rewritten in place
without the old code running beside it first.

**Rules for every stage**

- A new module starts by observing: it runs next to the code it will replace
  and reports disagreement (`session-disagree`). It takes over only after
  production shows none.
- Anything touching the tick loop, sync, input or the core needs
  `tests/rb-two-player.mjs` with `JITTER=20` to pass before merge.
- State logic is modelled in Quint first; pure functions with a contract are
  proven with LemmaScript.

**Stage 1: foundation [done]**
Toolchain (TypeScript 7, esbuild, oxfmt, oxlint + anti-slop, Biome, antislop,
Quint, LemmaScript) and CI. First modules: `protocol.ts` (Effect Schema for
server messages), `session.ts` (page lifecycle machine, observing), `roster.ts`
(mesh-heal target selection, proven never to return the player's own id).

**Stage 2: the page lifecycle decides [in progress]**
Production has had too little traffic to show that the machine agrees with
the page, so the evidence comes from end-to-end runs:
`tests/solo-signaling-drop.mjs`, `tests/rb-two-player.mjs` with
`DROP_SIGNALING_MS`, and `tests/lifecycle-e2e.mjs` (late join, spectating,
host reload) all show no `session-disagree`.

- Done: `play.js` reads "is a game on" from the machine (`isGameRunning`).
  The old `gameRunning` flag is still written beside it and compared on every
  signaling reconnect; delete it once production shows no `session-disagree`.
- Done (observing): the machine has the late-join states (`lateJoinAwaitingRom`,
  `lateJoinStarting`, `lateJoinSyncing`; diagram in `docs/session-machine.md`,
  same states in the Quint model). `play.js` still decides from `_lateJoin`
  and `_pendingLateJoin` and reports `session-disagree` at each place it
  reads one. `tests/lifecycle-e2e.mjs` covers late join with and without a
  ROM, a streamed game, spectating and host reload.
- Done: which connection a rejoining player keeps is `rosterKey` in
  `web/src/peer-identity.ts`, called by the engine. Its search is proved
  (LemmaScript) and the reconnect orderings are model-checked in
  `specs/peer_identity.qnt`, which reproduces #119 and its review finding on
  the older variants.
- Done: reconcile on reconnect. A guest whose socket comes back compares
  itself with the status and match id the rejoin returns
  (`reconcileRejoin` in `web/src/rejoin.ts`, proved; `rejoined` in the
  machine) and returns to the lobby, or rejoins the new match, when the room
  moved on without it. `pagesAgreeWithServer` and
  `lateJoinersChaseTheCurrentMatch` now hold on `room_current`.
- Next: the rejoin itself is still a bare callback with no timeout or retry,
  and a rejoin the server refuses (the grace window ran out) is only logged.
  It becomes Effect logic invoked by the machine.
- Then: `play.js` reads the late-join flags from the machine and the old
  flags are deleted, once the reports above stay empty.
- Still open in the model: `noGhostMatch` (a playing room whose only member
  is a late joiner waiting for state).

**Stage 3: the socket boundary**
Every Socket.IO and DataChannel message is decoded with Effect Schema on
arrival. Generate the client schemas from the server's Pydantic models so
there is one source of truth. `play.js` becomes `web/src/play/*.ts`.

Done so far: `scripts/gen_protocol.py` writes `web/src/protocol.gen.ts` from
`server/src/api/payloads.py` (`npm run protocol`; CI fails when it is stale).
The payloads the server sends have models there too, and `signaling.py` holds
every one to its model as it goes out (`_emit`, `checked`): a mismatch raises
under tests and logs `PAYLOAD-CONTRACT` in production. Not done: the page does
not decode with them yet, and DataChannel messages have no schemas.

**Stage 4: engine periphery [pure logic done]**
`shared.js` (input wire format; prove encode/decode round-trips with
LemmaScript), `kn-state.js`, `gamepad-manager.js`, `kn-diagnostics.js`,
`kn-desync-detector.js`. The engine calls `KNCore.meshHealTargets` instead of
its inline roster loops.

Done: the decisions and arithmetic of each script are typed functions in
`web/src`, called through `KNCore`, with the script's own code kept as the
fallback for a page without the bundle (the demo page). A test per script
runs the real script with and without the bundle against output captured
before the move.

- Proved (LemmaScript): the input packet round trip (`input-wire.ts`), the
  stick dead-band's per-axis rule (`stick-axis.ts`), `classifyRunnerStep`,
  `inputEqual`, and which fields the desync detector flags
  (`desync-fields.ts`).
- Typed and tested, not proved (floating point and typed arrays, which the
  verifier does not model): the sync log ring, the diagnostics' pixel hash,
  canvas health, screenshot crop and audio transition (`diagnostics.ts`),
  and the gamepad axis scaling and polarity (`gamepad-axes.ts`).
- `KNState` has a type (`kn-state.ts`); `kn-state.js` still builds it and
  still runs before the bundle, because `core-redirector.js` reads it from a
  fetch callback.
- Both engine roster loops ask `meshHealTargets`, one entry at a time.

Not done: the scripts themselves are still plain JavaScript. What is left in
them is the part bound to the browser (reading pads and the canvas, DOM
hooks, peer-connection helpers, cheats, storage) and their mutable state.
The fallbacks can be deleted, and `play.html` can stop loading the scripts
in favour of the bundle, once production shows no difference; the demo page
needs the bundle first.

**Stage 5: the engine**
`netplay-rollback.js` (18k lines) is split by concern into typed modules:
peer mesh, signaling, late join, resync, tick loop. The per-peer and boot
phase state become machines; the per-frame tick loop stays plain code. The
netplay invariants I1 (every wait has a deadline) and I2 (all peer cleanup
through one function) become Effect timeouts and scoped finalizers.

**Open decisions**

- `@xstate/effect` requires XState 6, which is in beta. Both are pinned to
  exact versions. Revisit when XState 6 is stable.
- The bundle is 493 KB minified (162 KB gzipped), mostly Effect. It is
  committed so that deploys need no Node step. Moving the build into the
  Docker image is the alternative once the bundle changes often.
- The database stays on Cloudflare D1 (SQLite locally). Queries are built with
  SQLAlchemy from the model classes in `server/src/schema.py` and compiled to
  SQL for the existing backends; SQLAlchemy never opens a connection.
  All application queries are built this way; `db.query` and
  `db.execute_write` remain only for tests and one-off tooling that
  arrange data with hand-written SQL.
