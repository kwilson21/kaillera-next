# Branch Prep: Pre-Merge Fixes & Cleanup

**Date:** 2026-03-20
**Branch:** mvp-p0-implementation

## 1. Canvas Clear on Game End

**Problem:** Old game frame stays frozen on canvas when game ends.

**Fix:** In `play.js` `onGameEnded()`, after `engine.stop()`, clear the `#game canvas` via WebGL `gl.clear()` with 2D `clearRect` fallback.

## 2. Room Auto-Close When Host Leaves Mid-Game

**Problem:** When host disconnects mid-game, ownership transfers to next player. Game breaks because host is the lockstep authority.

**Fix:**
- `signaling.py` `_leave()`: if `room.owner == sid` AND `room.status == "playing"` → emit `room-closed` (reason: `host-left`), clean up all `_sid_to_room` entries, delete room
- `signaling.py` `_leave()`: if `room.status == "lobby"` → keep existing ownership transfer
- `play.js`: listen for `room-closed`, toast + redirect to lobby

## 3. Fix Late-Join (Pull Instead of Push)

**Problem:** Host pushes save state 500ms after DC opens. Late-joiner's emulator isn't ready yet → `gameManager` is null → state silently dropped → stuck at 99%.

**Fix:**
- Remove host's `setTimeout(sendLateJoinState, 500)` from `ch.onopen`
- Late-joiner: when emulator ready in `startGameSequence()`, detect room is already playing → emit `request-late-join` via Socket.IO
- Host: listen for `request-late-join` → call `sendLateJoinState(requesterSid)`
- `sendLateJoinState`: send state targeted to requester only (not broadcast)
- Late-joiner: `handleLateJoinState()` now guaranteed to have `gameManager`

## 4. Cleanup + Rename + Changelog

**Delete:**
- `netplay-lockstep.js` (v1)
- `netplay-lockstep-v2.js`
- `netplay-lockstep-v3.js`
- `netplay-lockstep-v4.old.js`
- `netplay-dual.js`
- `netplay.js`
- `netplay-streaming.old.js`

**Rename:** `netplay-lockstep-v4.js` → `netplay-lockstep.js`

**Update references:**
- `play.html`: script loader path
- `play.js`: `NetplayLockstepV4` → `NetplayLockstep`, default mode `lockstep-v4` → `lockstep`
- `signaling.py`: mode string `lockstep-v4` → `lockstep`
- `netplay-lockstep.js`: window export name

**Create:** `CHANGELOG.md` with semver history of netplay evolution.
