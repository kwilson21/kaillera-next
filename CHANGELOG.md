# Changelog

> **Note:** As of v0.8.0, versioning is automated. The live changelog is at
> `/static/changelog.json` (click the version badge in the page footer).
> This file is a historical record of the pre-automation era (v0.1.0–v0.7.0).

## [Unreleased]

### Added
- **CSS/menu gameplay hash expansion**: 34 new RDRAM addresses tracked
  (CSS player struct state, frame counters) for menu desync detection
- **GP-CSS diagnostic log lines**: emitted on MISMATCH and STATE-DRIFT
  with full per-player CSS state for cross-peer comparison
- **analyze_match.py section 11c**: DESYNC SUMMARY with screen/stage/
  character/CSS progression, cross-peer divergence, and SSIM timeline
- **RSP HLE state save/restore**: `kn_hle_save`/`kn_hle_restore`
  exports for rollback-safe audio state management
- **Replay audio skip**: RSP audio skipped during rollback replay
  (mode 1) with hle_t state preserved — eliminates RB-LIVE-MISMATCH
- **CSS sync**: one-time host→guest state push at CSS menu entry
- **POST-SYNC-DIAG**: per-component hash burst after every boot sync
  for precise divergence identification
- **Event queue hash** (`eq=`) added to C-PERF periodic logging

### Fixed
- **Boot grace enforcement**: `_rbInitFrame=-1` when rollback init was
  deferred caused `_bootDone=true` immediately, skipping 120-frame
  lockstep window. Both emulators ran free during boot causing 65+
  frame drift in Global.frame_counter
- **Sync frame reset threshold**: lowered from 30 to 2 frames — guest
  stayed at divergent `_frameNum` after boot sync, causing fc low-6-bit
  RNG write to produce different values on each peer
- **RSP HLE determinism**: mode 2 now saves/restores hle_t persistent
  audio state (ADPCM tables, envelopes, alist_buffer) alongside DRAM.
  Prevents non-deterministic audio state cascading across tasks
- **Boot stall recovery runaway**: `_bootStallRecoveryFired` flag now
  resets periodically (5s) and when peer input arrives, preventing
  host from running free forever after a single 3s stall timeout
- **C-level pacing phantom override**: when `kn_pre_tick` returns 3
  (throttle) but all peers are phantom, ignore throttle to prevent
  permanent freeze on peer disconnect
- **Boot/intro lockstep stall eliminated**: runs free like prod during
  intro (no stall), boot sync at f=120 + CSS sync handle alignment
- **Menu detection**: `inMenu` only true after CSS sync fires, prevents
  false menu lockstep during N64 boot (VS settings byte uninitialized)
- **Log flooding**: TICK-PERF, BOOT-LOCKSTEP, PACING-THROTTLE phantom
  release rate-limited to once per frame (was every stalled tick)
- **GP-CSS rate limited**: once per 60 frames (was every tick during
  menu lockstep, flooding entire log buffer)
- **Build**: `#ifdef __EMSCRIPTEN__` guard for fingerprint function

### Changed
- **WiFi resilience**: server-side 30s disconnect grace period during
  gameplay; WebRTC reconnect retries (3 attempts with 3s backoff);
  ICE grace 1.5s→3s; overall reconnect timeout 15s→45s
- **Boot stall timeout**: RTT-adaptive (2×RTT, clamped 33-250ms)
  instead of fixed 500ms
- **frame_counter low-6-bit sync**: forces `fc & 0x3F` to match
  `_frameNum & 0x3F` so `get_random_int_safe_` extra advances are
  identical between peers regardless of boot-phase fc drift

### Fixed (prior — RF1-RF7)
- **Rollback state integrity (RF1-RF7)**: eliminated silent state
  corruption in the C rollback engine. Seven fixes enforcing six
  new invariants (R1-R6):
  - RF1 — re-capture Emscripten rAF runner after `retro_unserialize`
    so replay frames actually step the emulator (root-cause fix for
    room B190OHFY silent state corruption)
  - RF2 — `stepOneFrame` emits `REPLAY-NORUN` if called with a null
    runner during replay; dev builds throw
  - RF3 — `kn_pre_tick` return-value invariant: `replay_depth > 0`
    requires `catchingUp === 2` (`RB-INVARIANT-VIOLATION`)
  - RF4 — dirty-input serialize gate enforces ring coverage across
    the rollback window
  - RF5 — post-replay live-state hash verified against ring
    (`RB-LIVE-MISMATCH` on drift)
  - RF6 Part A — strengthened `AUDIO-DEATH` diagnostics with
    rollback-correlation metadata and AudioWorklet state
  - RF7 — `FAILED-ROLLBACK (stale)` promoted to loud
    `FATAL-RING-STALE` event; dev builds throw

### Changed
- `tools/analyze_match.py` detects all new event types
  (`REPLAY-NORUN`, `RB-INVARIANT-VIOLATION`, `FATAL-RING-STALE`,
  `RB-LIVE-MISMATCH`) and enriches `AUDIO-DEATH` with rollback-
  correlation inference.

### Documentation
- `docs/netplay-invariants.md` §Rollback Integrity (R1-R6)
- `CLAUDE.md` rollback invariant bullet under Netplay invariants

## [0.7.0] - 2026-03-27

### Added
- Emulator hibernate: WASM module stays alive between games, eliminating Emscripten
  main loop corruption on 3rd+ instance and skipping 120-frame re-boot on restart
- Mode switching: lockstep ↔ streaming without page reload
- CSS-based EJS overlay suppression (`#game.kn-playing`) prevents built-in EJS menus
  from leaking through during gameplay
- Streaming guest video uses sibling `#stream-overlay` div instead of modifying `#game`
  children, preserving the hibernated EJS canvas

### Fixed
- Guest black screen after streaming → lockstep (EJS canvas destroyed by innerHTML clear)
- EJS netplay/cheats menus appearing during gameplay after hibernate/wake cycles

## [0.6.0] - 2026-03-25

### Added
- C-level resync: `_kn_sync_hash`, `_kn_sync_read`, `_kn_sync_write` WASM exports for
  fast in-core state hashing and transfer (replaces JS-level RDRAM reads)
- Per-region RDRAM hashing via `_kn_sync_hash_regions` for targeted desync diagnosis
- GGPO-inspired frame pacing: frame advantage cap prevents faster machine from outrunning
  slower peer's input stream (asymmetric EMA, skip tick when ahead by DELAY_FRAMES + 1)
- Two-stage input stall recovery: Stage 1 (0–3s) stalls waiting, Stage 2 (3–5s) sends
  "resend:<frame>" requesting retransmission, timeout (5s+) injects zero input
- Sync diagnostics: `_syncLogRing` circular buffer, per-frame `_diagEventLog`,
  exportable CSV logs, `debug-sync`/`debug-logs` Socket.IO events for remote upload
- `POST /api/sync-logs` endpoint for sync log collection
- Admin page (`/admin.html`) for sync log management with pin/cleanup controls
- Admin API endpoints: `GET /api/admin/logs`, `DELETE /api/admin/logs/{name}`,
  `POST /api/admin/logs/{name}/pin`
- Sync log recovery: pending logs captured via `sendBeacon` + `localStorage` on browser
  close, uploaded automatically on next page load
- Drift rate tracker with exponential summary logging and cycle time in sync-hash protocol
- Logs toolbar button for mobile sync log download
- Configurable server env vars: `PORT`, `MAX_ROOMS`, `MAX_SPECTATORS` with defaults
- python-dotenv for `.env` file support
- Kaillera Easter eggs across frontend
- iOS audio routing workaround and mobile touch guard
- ROM hash algorithm tagging for state cache compatibility

### Changed
- Default port changed to 27888 (Kaillera client port)
- Refactored all JS modules to ES2022+ (const/let, arrow functions, template literals,
  async/await, optional chaining): audio-worklet-processor.js, play.js,
  netplay-lockstep.js, netplay-streaming.js, virtual-gamepad.js, gamepad-manager.js
- Converted remaining `.then()` chains to async/await across frontend
- Dockerfile updated with configurable env vars and logs directory
- Minimum frame delay floor raised to 2 for frame pacing headroom
- Sync hash interval uses `_syncBaseInterval` (120 frames / ~2s) with C-level fast path
- Guest no longer freezes during resync — gameplay continues while state is buffered

### Fixed
- Virtual gamepad alignment: D-pad centered (was 3px off), A/B diagonal layout
  (Gameboy-style), C-buttons pushed right, landscape D-pad no longer overlaps L shoulder
- Late-join bugs: cheat application timing, shared engine code DRY-up
- Frame cap threshold: use `>=` instead of `>` to actually trigger at boundary
- Use raw frame advantage (not smoothed EMA) for cap decision
- Delta base buffer detached by Web Worker transfer
- Guard `_lastSyncState` mutations — host delta base survives peer reconnects
- Slice fallback `getState()` result to prevent buffer aliasing
- Streaming mode bugs + defer gesture prompt during ROM download
- `--denan` build pipeline: strict IEEE 754 + kn_sync exports
- Consolidate mupen64plus patches for reliable build
- Defer 8MB WASM buffer allocation until sync is enabled
- Reduce resync cooldown for C-level path
- TDZ error in admin.js from function ordering
- Kaillera credit footer pinned to bottom of lobby page

## [0.5.0] - 2026-03-20

### Changed
- Renamed `netplay-lockstep-v4.js` to `netplay-lockstep.js` (single canonical version)
- Mode identifier changed from `lockstep-v4` to `lockstep` across client and server
- Late-join now uses pull model: joiner requests state when emulator is ready
- Late-joiner always initiates WebRTC connection (fixes offer-before-listener race)
- Input peers exclude players who haven't started sending (fixes host stall on late-join)
- Pre-fill delay gap frames on late-join so tick loop doesn't stall on historical input
- Sync late-joiner frame counter to host's current frame via `_lastRemoteFrame`
- Key tracking deferred until emulator is fully loaded (fixes remapped controls on late-join)
- Room auto-closes when host leaves mid-game (lobby phase still transfers ownership)
- EmulatorJS destroyed from DOM on game end, recreated fresh on restart
- IDB cache clearing skipped when already done (fixes multi-tab deadlock at "Decompress Game Core 99%")

### Fixed
- Frozen frame ghosting on game end (emulator removed from DOM instead of canvas clear)
- `stop()` now restores `requestAnimationFrame` and resets manual mode state
- Late-joiner `lastUsersData` race: use `joinData` from ack instead of socket event

### Removed
- `netplay-lockstep.js` (v1 — rAF hook prototype)
- `netplay-lockstep-v2.js` (pauseMainLoop/resumeMainLoop prototype)
- `netplay-lockstep-v3.js` (free-running input sync experiment)
- `netplay-lockstep-v4.old.js` (backup)
- `netplay-dual.js` (dual-engine prototype)
- `netplay.js` (legacy namespace)
- `netplay-streaming.old.js` (backup)

## [0.4.0] - 2026-03-19

### Added
- 4-player mesh networking (up to 6 bidirectional WebRTC connections)
- Spectator support via host canvas MediaStream
- Graceful drop handling: remaining players continue with disconnected peer's input zeroed
- Late-join infrastructure: host sends compressed save state to new peers
- Audio bypass: AudioWorklet with AudioBufferSourceNode fallback for non-secure contexts
- C-level deterministic timing via forked mupen64plus-next core (`kn_set_deterministic`, `kn_set_frame_time`)
- Frame-locked audio fed from same tick that steps the emulator
- Optional rollback resync via Worker-based compression/decompression
- Desync detection with deferred hash checks

### Changed
- Input delivery via direct Wasm memory writes (DataView to HEAPU8) instead of `simulateInput()`
- INPUT_BASE auto-discovered at startup by monitoring `_simulate_input` side effects
- Save states sent via Socket.IO (not WebRTC DC) to avoid SCTP size limits

## [0.3.0] - 2026-03-15

### Added
- Free-running input sync: both emulators run at 60fps independently
- Input exchanged each frame with configurable DELAY_FRAMES buffer
- Last-known-input prediction when remote input hasn't arrived

### Known Issues
- State resync disabled (caused freezes)
- 2-player only

## [0.2.0] - 2026-03-12

### Added
- Emscripten `pauseMainLoop`/`resumeMainLoop` approach for frame stepping
- Each tick: apply inputs, resume for one frame, pause again
- Keeps Emscripten runner in native rAF context (avoids Wasm audio OOB crashes)

### Verified
- 300/300 frames with zero crashes via Playwright

### Known Issues
- 2-player only

## [0.1.0] - 2026-03-08

### Added
- Initial lockstep prototype using `retro_run` hook
- rAF interception to own the frame loop
- `simulateInput()` calls before stepping each frame
- Streaming mode: host runs emulator, streams canvas video to guests via WebRTC MediaStream

### Known Issues
- rAF interception fragile across browser tabs
- 2-player only
