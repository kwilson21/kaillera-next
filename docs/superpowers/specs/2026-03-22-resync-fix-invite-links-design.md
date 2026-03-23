# Resync Fix + In-Game Invite Links — Design Spec

## Overview

Three changes:
1. Fix resync failure after a player disconnects mid-game
2. Add in-game share button with play vs spectate link options
3. Show "room full" screen when joining a full game via play link

## 1. Resync Bug Fix

### Root cause

When a player disconnects mid-game, `handlePeerDisconnect` zeroes their input
slot once via `writeInputToMemory(slot, 0)`. But the tick loop (line 1639) only
writes input for `inputPeers` — peers that are still connected and sending
input. The disconnected player's slot is never written to again.

After a resync `loadState()`, the core's internal memory for the disconnected
player's slot gets restored from the save state snapshot. Since nobody re-zeroes
it, the core reads stale input values on the next frame step. Both sides
accumulate different drift in the unwritten slot → permanent divergence that no
resync can fix.

### Fix

In the tick loop, after writing inputs for self and all inputPeers, explicitly
zero all player slots that have no active peer. This ensures disconnected
players' slots stay zeroed every frame, including after a `loadState()`.

In `tick()`, after the inputPeers write loop (~line 1644):

```javascript
// Zero disconnected player slots so loadState() can't restore stale input
for (var slot = 0; slot < 4; slot++) {
  if (slot === _playerSlot) continue;  // self — already written
  var hasPeer = false;
  for (var m = 0; m < inputPeers.length; m++) {
    if (inputPeers[m].slot === slot) { hasPeer = true; break; }
  }
  if (!hasPeer) writeInputToMemory(slot, 0);
}
```

This is ~7 lines, runs only when `applyFrame >= 0` (same guard as existing
input writes), and has negligible cost (4 slot checks per frame).

## 2. In-Game Share Button

### Toolbar change

Add a "Share" button to the in-game toolbar, visible to all players and
spectators. Positioned after `.toolbar-spacer`, before `#toolbar-info`
(right-aligned with the other action buttons).

Element: `<button id="toolbar-share">Share</button>`

### Dropdown UI

Clicking the button toggles a small dropdown anchored below it:

```
┌─────────────────────────┐
│  Copy Play Link    [📋] │
│  Copy Watch Link   [📋] │
└─────────────────────────┘
```

- **Copy Play Link** → copies `/play.html?room=CODE`
- **Copy Watch Link** → copies `/play.html?room=CODE&spectate=1`
- Each row: click copies to clipboard, shows "Copied!" for ~1.5s, then reverts
- Dropdown dismisses on outside click or Escape key
- Uses `navigator.clipboard.writeText` with `execCommand('copy')` fallback
  (same pattern as existing `copyLink()` in lobby)

### Styling

Match existing toolbar button style. Dropdown positioned absolutely below the
button, simple dark background consistent with the toolbar aesthetic. No new
CSS framework or library needed.

## 3. Room Full Screen

### When it triggers

Non-host joins via a play link (no `&spectate=1`). The client already calls
`GET /room/{room_id}` before joining (play.js line 102). If
`roomData.player_count >= roomData.max_players`, show the room-full screen
instead of emitting `join-room`.

### Behavior

Auto-join as spectator and show a dismissible banner at the top of the screen:

```
┌──────────────────────────────────────────────────┐
│  Game is full — you've joined as a spectator  ✕  │
└──────────────────────────────────────────────────┘
```

- Banner auto-dismisses after ~5s or on click of the ✕
- Player lands directly into spectator mode — no blocking screen
- If a slot opens up later, the existing "Claim Slot" flow lets them
  become a player

### Race condition handling

The REST check is best-effort — the room can fill between the REST call and
the Socket.IO `join-room` emit. The server already returns `"Room is full"`
from `join-room` when `next_slot()` returns `None`. Both paths (REST check
and `join-room` error) should trigger the same behavior: auto-join as
spectator with the banner. For the `join-room` error case, re-emit
`join-room` with `spectate: true` and show the banner.

### No server changes needed

The REST API already returns `player_count` and `max_players`. The `join-room`
event already supports `spectate: true`. No new endpoints or events required.

## Files changed

| File | Change |
|---|---|
| `web/static/netplay-lockstep.js` | Zero disconnected slots in tick loop (~7 lines) |
| `web/static/play.js` | Share button logic, dropdown, room-full screen |
| `web/play.html` | Add `#toolbar-share` button, dropdown container |
| `web/static/play.css` | Dropdown + room-full screen styles |

## Not in scope

- Lobby copy-link button (stays as-is)
- Server-side changes (none needed)
- Password-protected room handling
- Deep link with player name pre-filled
