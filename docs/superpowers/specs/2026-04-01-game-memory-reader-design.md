# Live Game Memory Reader & Game Browser

**Date:** 2026-04-01
**Status:** Draft

## Summary

Read live N64 game state from WASM RDRAM and surface it through a public game browser page where anyone can browse matches, see live thumbnails, and join or spectate — recreating the classic Kaillera server list experience with modern game-aware context.

## Goals

1. Decode live game data from SSB64 and Smash Remix (stage, characters, stocks, damage %, timer, match state, winner)
2. Provide a public game browser page with live thumbnails and game state
3. Allow players and spectators to join public matches directly from the browser
4. Enrich session logs and PostHog analytics with actual match data
5. Lay groundwork for future Discord presence integration

## Non-Goals

- Spectator overlay on the play page (deferred — match list is the priority consumer)
- Support for games beyond SSB64 / Smash Remix (extensible design, but only two address maps shipped)
- Writing to game memory (read-only)
- Full live video streaming on the match list (periodic thumbnails instead)

## Architecture

```
Host Client (play.html)
├── GameMemoryReader          ← HEAPU8 spot reads, 250ms poll
│   ├── Address map lookup (by ROM hash)
│   ├── Raw byte decoding → structured game state
│   └── Shallow diff → emit on change only
├── ThumbnailCapture          ← canvas.toDataURL, ~5s interval
│
│   game-state event (on change)     match-thumbnail event (~5s)
│           ↓                                ↓
│
Server (FastAPI + Socket.IO)
├── Room object enrichment
│   ├── game_state: dict | None
│   ├── thumbnail: str | None (base64 JPEG)
│   ├── public: bool (listed on match page)
│   ├── allow_join: bool (open slots fillable)
│   └── allow_spectate: bool (spectators from match list)
├── GET /api/matches endpoint
│   └── Returns public rooms with game state, thumbnail, players, slots
├── PostHog / session log enrichment
│
│   REST poll (~5s)
│       ↓
│
Game Browser Page (matches.html)
├── Match cards with live thumbnails
├── Game state overlay (stage, characters, stocks, timer)
├── Player names + open slot count
├── Join as Player / Spectate buttons
└── Password prompt for protected rooms
```

## Design

### 1. GameMemoryReader (`web/static/game-memory.js`)

A standalone class (no IIFE, no window globals — not EJS interop). Instantiated by the host client after the emulator boots.

**Constructor:** Takes ROM hash, looks up address map. If hash not recognized, `supported` is `false` and all reads are no-ops.

**Polling:** `setInterval` at 250ms. Each tick:
1. Grab fresh `Module.HEAPU8` reference (avoids detach issues)
2. Read ~50 bytes across known RDRAM addresses
3. Decode raw bytes into structured state object
4. Shallow-diff against previous state
5. If changed, dispatch `CustomEvent('kn-game-state', { detail: state })` on `window` and call the `onChange` callback

**Decoded state shape:**
```js
{
  matchState: "in-game",      // "menu" | "css" | "sss" | "in-game" | "results"
  stage: "Dream Land",        // human-readable stage name
  stageId: 0,                 // raw stage ID for filtering
  timer: 297,                 // seconds remaining (null if untimed)
  players: [
    { character: "Fox", stocks: 3, damage: 42 },
    { character: "Pikachu", stocks: 2, damage: 87 },
    null,                     // empty slot
    null
  ],
  winner: null                // player index on results screen, null otherwise
}
```

**Address maps:** Plain object keyed by ROM hash. Each map contains byte offsets for:
- Stage ID
- Match state (menu, CSS, SSS, in-game, results)
- Timer value
- Per-player struct base address + offsets for character ID, stock count, damage %
- Winner detection address

**Enum tables:** Character ID → name, stage ID → name. Separate tables for SSB64 and Smash Remix (Remix has additional characters and stages).

**Lifecycle:** `start()` begins polling, `stop()` clears interval. Called by play.js on game start/end. Only runs on the host client.

### 2. ThumbnailCapture

A small helper that captures the emulator canvas as a low-res JPEG on a ~5 second interval.

**Capture:** `canvas.toDataURL('image/jpeg', 0.4)` — produces ~10-30KB images at low quality. Good enough for thumbnail previews.

**Transport:** Sends base64 JPEG to server via `match-thumbnail` Socket.IO event. Server stores latest per room — no history.

**Lifecycle:** Only runs when the room is public (no point capturing for private rooms). Starts/stops with the game.

### 3. Server Changes

#### Room dataclass additions

New fields on the `Room` dataclass:
- `game_state: dict | None = None` — latest decoded game state from host
- `thumbnail: str | None = None` — latest base64 JPEG from host canvas
- `public: bool = False` — whether room appears on match list
- `allow_join: bool = True` — whether open slots are fillable from match list
- `allow_spectate: bool = True` — whether spectators can join from match list

These fields need to be added to `_serialize_room` / `_deserialize_room` in `state.py` for Redis persistence.

#### New Socket.IO events

**`game-state`** (client → server)
- Payload: decoded game state dict
- Only accepted from room owner
- Rate-limited: max 4/sec per room
- Stores on `room.game_state`
- Not broadcast to room (room members don't need it — they have their own emulator)

**`match-thumbnail`** (client → server)
- Payload: `{ thumbnail: "<base64 JPEG>" }`
- Only accepted from room owner
- Rate-limited: max 1/5sec per room
- Stores on `room.thumbnail`
- Size-limited: reject if > 100KB
- Not broadcast to room

**`set-visibility`** (client → server)
- Payload: `{ public?: bool, allowJoin?: bool, allowSpectate?: bool }`
- Only accepted from room owner
- Updates room fields
- Broadcasts visibility change to room (so lobby UI can reflect it)

#### REST endpoint

**`GET /api/matches`**
- Returns JSON array of public rooms
- Each entry includes: room name, game ID, status, mode, player names + characters, spectator count, open slots, game state, thumbnail URL/data, password-protected flag
- Excludes: password value, socket IDs, internal state
- No auth required (public endpoint)
- Response shape:
```json
[
  {
    "sessionId": "abc123",
    "roomName": "SSB64 Friendlies",
    "gameId": "ssb64",
    "status": "playing",
    "mode": "lockstep",
    "players": [
      { "name": "Kazon", "character": "Fox", "stocks": 3, "damage": 42, "slot": 0 },
      { "name": "Agent21", "character": "Pikachu", "stocks": 2, "damage": 87, "slot": 1 }
    ],
    "spectatorCount": 1,
    "maxPlayers": 4,
    "openSlots": 2,
    "gameState": {
      "matchState": "in-game",
      "stage": "Dream Land",
      "timer": 297
    },
    "thumbnail": "data:image/jpeg;base64,...",
    "hasPassword": true,
    "allowJoin": true,
    "allowSpectate": true
  }
]
```

### 4. Game Browser Page (`web/matches.html`)

New page accessible from the lobby (tab or link). Polls `GET /api/matches` every ~5 seconds.

**Match cards display:**
- Live thumbnail image (from host canvas capture)
- Stage name and game mode
- Player names with character names (e.g. "Kazon (Fox) vs Agent21 (Pikachu)")
- Stocks and damage % per player
- Timer remaining
- Slot availability ("2/4 players · 2 slots open")
- Lock icon for password-protected rooms

**Actions per card:**
- **Join** button — visible when `allowJoin` is true and slots are open. Navigates to play.html with the room session ID. Prompts for password if protected.
- **Spectate** button — visible when `allowSpectate` is true. Navigates to play.html in spectator mode. Prompts for password if protected.
- Both buttons disabled with explanation when the respective permission is off.

**Empty state:** "No public matches right now. Create a room to get started!"

**Auto-refresh:** Page polls every 5 seconds. Match cards update in-place (no full re-render flicker). New rooms appear, finished rooms disappear.

### 5. Host Controls (Lobby UI additions)

The room creation flow and in-room lobby need UI for the new visibility settings:

- **Public toggle** — "List this room on the game browser" (default off for backwards compat)
- **Allow join toggle** — "Allow players to join from browser" (default on when public)
- **Allow spectate toggle** — "Allow spectators from browser" (default on when public)
- **Password field** — already exists in backend, needs frontend UI

These are shown to the host in the room lobby before and during a game.

### 6. Integration Points

**Session logs:** When `game-state` arrives, the server can log match events (game started with characters X on stage Y, player lost a stock, match ended with winner Z) to the session log system.

**PostHog:** Enrich existing game-started / game-ended events with character picks, stage, winner, match duration.

**Future Discord presence:** The `game_state` on the room object is exactly what a Discord bot would read to set Rich Presence ("Playing SSB64 — Dream Land — Fox vs Pikachu").

## RDRAM Address Research

SSB64 memory addresses are well-documented by the modding community (GameShark codes, Smash Remix source, Project64 cheat databases). The specific addresses needed:

- **Stage ID:** Known static address, 1 byte
- **Match state:** Derived from game mode byte at known address
- **Timer:** 2-4 bytes at known address (frames, divide by 60 for seconds)
- **Player structs:** 4 player struct base addresses, each containing character ID (1 byte), stock count (1 byte), damage % (2 bytes, big-endian)
- **Winner:** Derived from results screen state

Smash Remix uses the same base addresses for vanilla characters/stages and adds new entries at extended offsets. The ROM hash distinguishes which enum table to use.

**Address verification approach:** Before hardcoding addresses, verify them empirically by reading RDRAM during known game states (main menu, CSS with known character highlighted, in-game with known stocks/damage) and confirming the values match.

## File Changes

| File | Change |
|---|---|
| `web/static/game-memory.js` | **New** — GameMemoryReader class, address maps, enum tables |
| `web/static/thumbnail-capture.js` | **New** — Canvas snapshot helper |
| `web/matches.html` | **New** — Game browser page |
| `web/static/matches.js` | **New** — Match list page controller |
| `server/src/api/signaling.py` | **Modify** — Room dataclass + 3 new Socket.IO events |
| `server/src/state.py` | **Modify** — Serialize/deserialize new Room fields |
| `server/src/api/app.py` | **Modify** — Add GET /api/matches endpoint |
| `web/static/play.js` | **Modify** — Instantiate GameMemoryReader + ThumbnailCapture on game start |
| `web/index.html` | **Modify** — Link to matches page |
| `web/static/lobby.js` | **Modify** — Host visibility controls UI |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| HEAPU8 buffer detaches mid-read | Grab fresh reference each poll cycle; read-only spot reads (not bulk copies) are safe |
| Wrong RDRAM addresses | Verify empirically before hardcoding; address maps are swappable per ROM hash |
| Thumbnail bandwidth | Low quality JPEG (~20KB) at 5s interval = ~4KB/s per public room; negligible |
| Match list polling overhead | 5s interval, lightweight JSON response, only public rooms included |
| Smash Remix address differences | Separate enum tables keyed by ROM hash; base struct layout is shared with vanilla SSB64 |
