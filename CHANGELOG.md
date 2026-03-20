# Changelog

All notable changes to kaillera-next netplay are documented here.

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
