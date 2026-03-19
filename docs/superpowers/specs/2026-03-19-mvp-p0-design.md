# MVP P0 Design Spec — Friend Test Ready

**Date:** 2026-03-19
**Goal:** Friend clicks a link, lands in lobby, game starts, they are playing SSB64 online.
**Scope:** All P0 items — Lobby, Host-Controlled Start, Netplay Refactor, Responsive Layout, Gamepad Support.

---

## System Architecture

The MVP is four independent systems connected by well-defined interfaces:

```
[1. Lobby System]  --URL params-->  [2. Play Page Controller]  --init(config)-->  [3. Netplay Engines]
                                            |
                                    Socket.IO events
                                            |
                                    [4. Server Additions]
```

Each system can be built, tested, and debugged independently. Integration happens through the interfaces between them.

---

## System 1: Lobby

**Files:** `web/index.html`, `web/static/lobby.js`, `web/static/lobby.css`

**Purpose:** Get the user into a room. No server connection — just a form that constructs the right URL and redirects.

### Behavior

- Centered card on dark background with "kaillera-next" title
- Player name input (persisted to localStorage)
- "Create Room" button:
  - Generates a 5-character room code client-side (same `randomCode()` logic)
  - Redirects to `/play.html?room=CODE&host=1&name=NAME&mode=lockstep-v4`
- Divider: "or join a game"
- Room code input + "Join" button + "Watch" button:
  - Join redirects to `/play.html?room=CODE&name=NAME`
  - Watch redirects to `/play.html?room=CODE&name=NAME&spectate=1`
- Paste-friendly: pasting a full invite URL into the code input extracts the room code automatically

### Interface Out

URL params passed to play.html:

| Param | Required | Values | Description |
|---|---|---|---|
| `room` | yes | 5-char code | Room identifier |
| `host` | no | `1` | Present = this user is creating the room |
| `name` | no | string | Player name (fallback: "Player") |
| `mode` | no | `lockstep-v4`, `streaming` | Netplay mode (default: `lockstep-v4`) |
| `spectate` | no | `1` | Present = join as spectator |

### localStorage

- `kaillera-name`: player name, read on page load, written on redirect

---

## System 2: Play Page Controller

**Files:** `web/play.html`, `web/static/play.js`, `web/static/play.css`

**Purpose:** Owns the Socket.IO connection, pre-game UI, notifications, in-game toolbar. Orchestrates the full lifecycle: lobby → playing → end/leave.

### play.html Structure

- Loads Socket.IO from CDN
- Loads the selected netplay engine script (based on `mode` URL param)
- Loads play.js
- Contains the EmulatorJS embed (same config as current index.html)
- Contains the pre-game overlay DOM (sits on top of emulator div)
- Contains the in-game toolbar DOM (hidden until game starts)
- Contains the toast notification container

### play.js Lifecycle

**Phase 1 — Connect & Join:**
1. Parse URL params (`room`, `host`, `name`, `mode`, `spectate`)
2. Fetch `GET /room/{room_id}` to check room status
3. Load Socket.IO, connect to server
4. If `host=1`: emit `open-room`, show pre-game overlay
5. If no `host`: emit `join-room` (with `spectate` flag if present)
6. If room status is `"playing"` and user is spectator: skip overlay, init engine immediately
7. If room status is `"playing"` and user is player: show overlay briefly, then init engine (late join)

**Phase 2 — Pre-Game Overlay:**
- Room code displayed prominently
- "Copy Link" button (copies invite URL to clipboard)
- Player list: slots 0-3 with names (empty slots shown as "Open"), spectators listed separately below
- Mode selector: host-only dropdown (Lockstep / Streaming), default Lockstep
- "Start Game" button: host-only, disabled until ≥2 players connected
- "Waiting for host to start..." text: guests and spectators
- Gamepad detection indicator: "Controller detected" or "No controller" per player
- Leave button: emits `leave-room`, redirects to `/`

**Phase 3 — Game Running:**
- Overlay hides, emulator revealed
- In-game toolbar (compact bar at top):
  - Room code (small)
  - "Leave Game" button (all users)
  - "End Game" button (host only)
- Toast notifications for player events (see Notifications below)
- Engine is running via `init(config)`

**Phase 4 — Game Ended:**
- On `game-ended` event: engine stops, overlay reappears
- Players are still in the room — can start another game or leave
- Host can change mode between games

### Notifications

play.js diffs each `users-updated` payload against the previous one to detect:

- Player joined → toast "PlayerName joined"
- Player left/disconnected → toast "PlayerName left"
- Spectator joined/left → toast "PlayerName is watching" / "PlayerName left"
- Host transferred → toast "PlayerName is now host"

**Toast style:** Semi-transparent banner at top-center, auto-dismisses after 3 seconds, stacks if multiple events fire close together. Unobtrusive — doesn't block gameplay.

### Interface to Engines

play.js calls the engine's `init(config)` with:

```js
{
  socket: socket,              // Connected Socket.IO instance
  sessionId: roomCode,         // Room identifier
  playerSlot: 0-3 | null,     // Assigned slot (null for spectators)
  isSpectator: boolean,
  playerName: string,
  gameElement: HTMLElement,     // The #game div for EmulatorJS
  onStatus: function(msg),     // Callback: engine reports status text
  onPlayersChanged: function(data)  // Callback: engine forwards users-updated data
}
```

### Interface from Server

Listens for these Socket.IO events:

| Event | Payload | Action |
|---|---|---|
| `users-updated` | `{players, spectators}` | Update player list, diff for notifications, forward to engine via `onPlayersChanged` |
| `game-started` | `{mode}` | Hide overlay, init engine |
| `game-ended` | `{}` | Stop engine, show overlay |

Emits these Socket.IO events:

| Event | Payload | When |
|---|---|---|
| `open-room` | (existing format) | Host creates room |
| `join-room` | (existing format) | Player/spectator joins |
| `leave-room` | `{}` | User clicks Leave |
| `start-game` | `{mode}` | Host clicks Start |
| `end-game` | `{}` | Host clicks End Game |

---

## System 3: Netplay Engines

**Files:** `web/static/netplay-lockstep-v4.js`, `web/static/netplay-streaming.js`

**Purpose:** Run the game. Receive config, manage WebRTC peers, execute lockstep/streaming logic, report back via callbacks. No DOM access, no room management.

### Refactor: What Gets Removed (~170 lines each)

- `buildUI()` — the #np panel, all CSS injection
- `setCode()`, `disableButtons()` — UI helpers
- `loadSocketIO()`, `connectSocket()` — socket creation (play.js owns this)
- `createRoom()`, `joinRoom()`, `spectateRoom()`, `_joinOrSpectate()` — room management
- `randomCode()` — code generation (lobby.js owns this)
- The `DOMContentLoaded` event listener entry point

### Refactor: What Gets Rewired

- `setStatus(msg)` → calls `config.onStatus(msg)` (currently 17 call sites in v4)
- `onUsersUpdated(data)` → still processes peer/slot state internally, also calls `config.onPlayersChanged(data)`
- Internal state variables (`socket`, `sessionId`, `_playerSlot`, `_isSpectator`) → initialized from `config` in `init()` instead of from DOM/room-management code

### Refactor: What Stays Untouched

All core netplay logic, specifically:

- rAF interception (`_origRAF`, `_pendingRunner` capture) — line ~956 in v4
- Lockstep tick loop (`startLockstep()`, `tick()`) — the core game loop
- Direct HEAPU8 memory writes (`INPUT_BASE = 715364`) — line ~930 in v4
- Per-slot frame tracking and caught-up check — line ~578 in v4
- WebRTC peer connection management (`createPeer()`, `sendOffer()`, `onWebRTCSignal()`)
- Data channel setup and binary input protocol
- Save state relay (send/receive via Socket.IO `data-message`)
- Late join state transfer
- Cheat application
- Keyboard/gamepad input reading (`readLocalInput()`, `setupKeyTracking()`)
- Canvas stream capture for spectators
- Compression utilities

### New Entry Point

```js
window.NetplayLockstepV4 = {
  init: function(config) { ... },
  stop: function() { ... }   // Called by play.js on game-ended / leave
};
```

`stop()` cleans up: clears the tick interval, closes peer connections, resets state. Enables the lobby → play → end → play again cycle without page reload.

### Playwright Globals Preserved

`window._playerSlot`, `window._isSpectator`, `window._peers`, `window._frameNum` — all still set from within the engine.

---

## System 4: Server Additions

**Files:** `server/src/api/signaling.py`, `server/src/api/app.py`

### Room Dataclass Changes

Add to `Room`:

```python
status: str = "lobby"   # "lobby" or "playing"
mode: str | None = None  # "lockstep-v4" or "streaming", set on start-game
```

### New Socket.IO Events

**`start-game`** (client → server):
```python
@sio.on("start-game")
async def start_game(sid, data):
    # Validate: sid must be room.owner
    # Set room.status = "playing", room.mode = data["mode"]
    # Broadcast "game-started" {mode} to room
```

**`end-game`** (client → server):
```python
@sio.on("end-game")
async def end_game(sid, data):
    # Validate: sid must be room.owner
    # Set room.status = "lobby", room.mode = None
    # Broadcast "game-ended" {} to room
```

**`chat-message`** (client → server):
```python
@sio.on("chat-message")
async def chat_message(sid, data):
    # Look up sender name from room
    # Broadcast {sender, message} to room (skip_sid=sid)
```

### New REST Endpoint

**`GET /room/{room_id}`** in app.py:

```python
@app.get("/room/{room_id}")
def get_room(room_id: str):
    room = rooms.get(room_id)
    if not room:
        raise HTTPException(404, "Room not found")
    return {
        "status": room.status,
        "mode": room.mode,
        "players": {pid: {"playerName": info["playerName"], "slot": slot}
                    for pid, info in room.players.items()
                    for s, p in room.slots.items() if p == pid
                    for slot in [s]},
        "spectators": {pid: {"playerName": info["playerName"]}
                       for pid, info in room.spectators.items()},
    }
```

### Ownership Validation

Both `start-game` and `end-game` verify `room.owner == sid`. If not, return an error string. Existing ownership transfer on host disconnect means the new host inherits control.

---

## Responsive Layout (P0.4)

Applies to both lobby and play pages via their respective CSS files.

**Approach:** Mobile-first CSS. No media queries needed for the lobby (it's a centered card). Play page overlay and in-game toolbar use flexbox that naturally stacks on narrow screens.

**Key rules:**
- Game canvas: `max-width: 100%; height: auto`
- All buttons: `min-height: 44px` (touch target)
- Overlay: `max-width: 500px; width: 90vw; margin: 0 auto`
- In-game toolbar: `display: flex; flex-wrap: wrap; gap: 8px`
- No horizontal scrolling at 320px width
- Meta viewport tag on both pages

---

## Gamepad Support (P0.5)

**Pre-game:** play.js polls `navigator.getGamepads()` on an interval during the overlay phase. Shows "Controller detected: [gamepad.id]" or "No controller" next to the player's name in the player list.

**During gameplay:** The engines already handle gamepad input in `readLocalInput()`. No changes needed to the engine gamepad code.

**Default mapping:** Xbox/PS standard → N64 is already implemented in the engines. No remapping UI in P0.

**EmulatorJS:** Engine already disables EJS keyboard handling (`disableEJSKeyboard()`). Same approach for gamepads — engine reads Gamepad API directly.

---

## What Is NOT In This Spec

- Touch controls (P1.1)
- Controller mapping UI (P1.2)
- Chat UI (P1.3 — server event is wired, UI is not)
- Connection status indicators beyond toasts (P1.4)
- End game / rematch polish (P1.5)
- Any P2 items
