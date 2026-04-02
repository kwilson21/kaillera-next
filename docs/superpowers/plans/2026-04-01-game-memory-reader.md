# Game Memory Reader & Game Browser — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read live N64 game state from WASM RDRAM and expose it through a game browser page where anyone can browse, join, or spectate public matches.

**Architecture:** Host client reads specific RDRAM addresses via `Module.HEAPU8` at 250ms intervals, diffs the decoded state, and sends changes to the server via Socket.IO. A canvas thumbnail is captured every 5s. The server stores game state and thumbnails on the room object, exposes a `GET /api/matches` endpoint, and a new `matches.html` page polls it to render live match cards with Join/Spectate actions.

**Tech Stack:** Vanilla JS (standalone classes, no IIFE), Python FastAPI + python-socketio, Pydantic v2 payload models

**Spec:** `docs/superpowers/specs/2026-04-01-game-memory-reader-design.md`

---

## Chunk 1: Server Foundation

### Task 1: Add Pydantic payload models for new events

**Files:**
- Modify: `server/src/api/payloads.py` (append after line 171)

- [ ] **Step 1: Add the three new payload models**

Append to `server/src/api/payloads.py` after the existing `FeedbackPayload`:

```python
# ── game-state ──────────────────────────────────────────────────────────────


class GameStatePlayerPayload(BaseModel):
    character: str | None = None
    stocks: int | None = None
    damage: int | None = None


class GameStatePayload(BaseModel):
    matchState: str = ""
    stage: str | None = None
    stageId: int | None = None
    timer: int | None = None
    players: list[GameStatePlayerPayload | None] = Field(default_factory=list)
    winner: int | None = None


# ── match-thumbnail ─────────────────────────────────────────────────────────


class MatchThumbnailPayload(BaseModel):
    thumbnail: str = Field(max_length=150_000)  # ~100KB base64 + overhead


# ── set-visibility ──────────────────────────────────────────────────────────


class SetVisibilityPayload(BaseModel):
    public: bool | None = None
    allowJoin: bool | None = None
    allowSpectate: bool | None = None
```

- [ ] **Step 2: Verify server starts cleanly**

Run: `cd server && python -c "from src.api.payloads import GameStatePayload, MatchThumbnailPayload, SetVisibilityPayload; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add server/src/api/payloads.py
git commit -m "feat: add Pydantic payload models for game-state, match-thumbnail, set-visibility"
```

---

### Task 2: Extend Room dataclass with new fields

**Files:**
- Modify: `server/src/api/signaling.py:141-162` (Room dataclass)
- Modify: `server/src/state.py:41-73` (serialization)

- [ ] **Step 1: Add new fields to Room dataclass**

In `server/src/api/signaling.py`, add after `match_id` (line 162):

```python
    game_state: dict | None = None  # latest decoded game state from host
    thumbnail: str | None = None  # latest base64 JPEG from host canvas
    public: bool = False  # listed on match browser
    allow_join: bool = True  # allow players to join from match browser
    allow_spectate: bool = True  # allow spectators from match browser
```

- [ ] **Step 2: Update `_serialize_room` in `state.py`**

In `server/src/state.py`, in `_serialize_room`, add exclusion of ephemeral fields before the `return json.dumps(d)` line (currently around line 49). Add after the slots conversion:

```python
    # Ephemeral fields — not persisted (host re-sends on next poll cycle)
    d.pop("game_state", None)
    d.pop("thumbnail", None)
```

- [ ] **Step 3: Update `_deserialize_room` in `state.py`**

In `server/src/state.py`, in `_deserialize_room`, add the three persisted fields to the `Room(...)` constructor call:

```python
        public=d.get("public", False),
        allow_join=d.get("allow_join", True),
        allow_spectate=d.get("allow_spectate", True),
```

Add these after the existing `device_types=d.get("device_types", {})` line.

- [ ] **Step 4: Verify server starts with extended Room**

Run: `cd server && python -c "from src.api.signaling import Room; r = Room('x','y','z',None,4); print(r.public, r.game_state)"`
Expected: `False None`

- [ ] **Step 5: Commit**

```bash
git add server/src/api/signaling.py server/src/state.py
git commit -m "feat: extend Room dataclass with game_state, thumbnail, visibility fields"
```

---

### Task 3: Add rate limit entries for new events

**Files:**
- Modify: `server/src/ratelimit.py:17-43` (_LIMITS dict)

- [ ] **Step 1: Add rate limit entries**

In `server/src/ratelimit.py`, add to the `_LIMITS` dict (after the `"feedback"` entry at line 41):

```python
    "game-state": (5, 1),  # 5/sec — buffer above 250ms poll (~4/sec)
    "match-thumbnail": (1, 5),  # 1 per 5 seconds
    "set-visibility": (5, 10),  # 5 per 10 seconds
```

- [ ] **Step 2: Commit**

```bash
git add server/src/ratelimit.py
git commit -m "feat: add rate limits for game-state, match-thumbnail, set-visibility events"
```

---

### Task 4: Add Socket.IO event handlers

**Files:**
- Modify: `server/src/api/signaling.py` (append new event handlers)

- [ ] **Step 1: Add import for new payloads**

At the top of `server/src/api/signaling.py`, find the existing imports from payloads and add the new models. The import line currently includes models like `OpenRoomPayload`, etc. Add `GameStatePayload`, `MatchThumbnailPayload`, `SetVisibilityPayload` to that import.

- [ ] **Step 2: Add `game-state` event handler**

Append to the events section of `server/src/api/signaling.py` (after the last existing event handler):

```python
@sio.on("game-state")
@validated(GameStatePayload)
async def on_game_state(sid: str, payload: GameStatePayload) -> str | None:
    if not check(sid, "game-state"):
        return "Rate limited"
    info = _sid_to_room.get(sid)
    if not info:
        return "Not in a room"
    session_id, _pid, _is_spec = info
    room = rooms.get(session_id)
    if not room or room.owner != sid:
        return "Not room owner"
    room.game_state = payload.model_dump()
    return None
```

- [ ] **Step 3: Add `match-thumbnail` event handler**

```python
@sio.on("match-thumbnail")
@validated(MatchThumbnailPayload)
async def on_match_thumbnail(sid: str, payload: MatchThumbnailPayload) -> str | None:
    if not check(sid, "match-thumbnail"):
        return "Rate limited"
    info = _sid_to_room.get(sid)
    if not info:
        return "Not in a room"
    session_id, _pid, _is_spec = info
    room = rooms.get(session_id)
    if not room or room.owner != sid:
        return "Not room owner"
    if len(payload.thumbnail) > 150_000:
        return "Thumbnail too large"
    room.thumbnail = payload.thumbnail
    return None
```

- [ ] **Step 4: Add `set-visibility` event handler**

```python
@sio.on("set-visibility")
@validated(SetVisibilityPayload)
async def on_set_visibility(sid: str, payload: SetVisibilityPayload) -> str | None:
    if not check(sid, "set-visibility"):
        return "Rate limited"
    info = _sid_to_room.get(sid)
    if not info:
        return "Not in a room"
    session_id, _pid, _is_spec = info
    room = rooms.get(session_id)
    if not room or room.owner != sid:
        return "Not room owner"
    if payload.public is not None:
        room.public = payload.public
    if payload.allowJoin is not None:
        room.allow_join = payload.allowJoin
    if payload.allowSpectate is not None:
        room.allow_spectate = payload.allowSpectate
    await state.save_room(session_id, room)
    await sio.emit("visibility-updated", {
        "public": room.public,
        "allowJoin": room.allow_join,
        "allowSpectate": room.allow_spectate,
    }, room=session_id)
    return None
```

- [ ] **Step 5: Verify server starts**

Run: `cd server && python -c "from src.api.signaling import sio; print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add server/src/api/signaling.py
git commit -m "feat: add game-state, match-thumbnail, set-visibility Socket.IO handlers"
```

---

### Task 5: Add GET /api/matches REST endpoint

**Files:**
- Modify: `server/src/api/app.py` (add endpoint inside `create_app`)

- [ ] **Step 1: Add the matches endpoint**

In `server/src/api/app.py`, add a new endpoint inside `create_app()`, after the existing `/list` endpoint (around line 456):

```python
    @app.get("/api/matches")
    def get_matches(request: Request) -> list:
        if not check_ip(_client_ip(request), "room-lookup"):
            raise HTTPException(status_code=429, detail="Rate limited")
        result = []
        for session_id, room in rooms.items():
            if not room.public:
                continue
            # Merge player names from room with character data from game_state
            gs = room.game_state or {}
            gs_players = gs.get("players", [])
            players_out = []
            for slot_idx, pid in sorted(room.slots.items()):
                pinfo = room.players.get(pid, {})
                gs_player = gs_players[slot_idx] if slot_idx < len(gs_players) and gs_players[slot_idx] else {}
                players_out.append({
                    "name": pinfo.get("playerName", ""),
                    "character": gs_player.get("character"),
                    "stocks": gs_player.get("stocks"),
                    "damage": gs_player.get("damage"),
                    "slot": slot_idx,
                })
            open_slots = room.max_players - len(room.slots)
            result.append({
                "sessionId": session_id,
                "roomName": room.room_name,
                "gameId": room.game_id,
                "status": room.status,
                "mode": room.mode,
                "players": players_out,
                "spectatorCount": len(room.spectators),
                "maxPlayers": room.max_players,
                "openSlots": open_slots,
                "gameState": {
                    "matchState": gs.get("matchState", ""),
                    "stage": gs.get("stage"),
                    "timer": gs.get("timer"),
                } if gs else None,
                "thumbnail": room.thumbnail,
                "hasPassword": room.password is not None,
                "allowJoin": room.allow_join,
                "allowSpectate": room.allow_spectate,
            })
        return result
```

- [ ] **Step 2: Update the docstring at top of app.py**

Add `GET  /api/matches             public match browser listing` to the V1 endpoints docstring.

- [ ] **Step 3: Verify server starts and endpoint responds**

Run: `cd server && python -c "from src.api.app import create_app; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add server/src/api/app.py
git commit -m "feat: add GET /api/matches endpoint for game browser"
```

---

## Chunk 2: Client-Side Memory Reader & Thumbnail Capture

### Task 6: Create GameMemoryReader module

**Files:**
- Create: `web/static/game-memory.js`

- [ ] **Step 1: Create the GameMemoryReader class with address maps and enums**

Create `web/static/game-memory.js`:

```js
/**
 * GameMemoryReader — reads live game state from N64 RDRAM via WASM HEAPU8.
 *
 * Standalone class (not IIFE — no EJS interop needed).
 * Instantiated by play.js on the host client after emulator boots.
 *
 * Usage:
 *   const reader = new GameMemoryReader(romHash, getModule);
 *   reader.onChange = (state) => socket.emit('game-state', state);
 *   reader.start();
 *   // later:
 *   reader.stop();
 */

// ── SSB64 Character / Stage Enums ────────────────────────────────────────────

const SSB64_CHARACTERS = {
  0x00: 'Mario',
  0x01: 'Fox',
  0x02: 'DK',
  0x03: 'Samus',
  0x04: 'Luigi',
  0x05: 'Link',
  0x06: 'Yoshi',
  0x07: 'Captain Falcon',
  0x08: 'Kirby',
  0x09: 'Pikachu',
  0x0A: 'Jigglypuff',
  0x0B: 'Ness',
};

const SSB64_STAGES = {
  0x00: 'Peach\'s Castle',
  0x01: 'Sector Z',
  0x02: 'Congo Jungle',
  0x03: 'Planet Zebes',
  0x04: 'Hyrule Castle',
  0x05: 'Yoshi\'s Island',
  0x06: 'Dream Land',
  0x07: 'Saffron City',
  0x08: 'Mushroom Kingdom',
};

// ── Smash Remix Extended Enums ────────────────────────────────────────────────
// Smash Remix adds characters/stages beyond the vanilla roster.
// Base IDs 0x00-0x0B are identical to SSB64; extended entries start at 0x0C.

const REMIX_CHARACTERS = {
  ...SSB64_CHARACTERS,
  // Extended Remix characters — IDs to be verified in Task 13
  0x0C: 'Young Link',
  0x0D: 'Dr. Mario',
  0x0E: 'Wario',
  0x0F: 'Dark Samus',
  0x10: 'Bowser',
  0x11: 'Ganondorf',
  0x12: 'Falco',
  0x13: 'Marth',
  0x14: 'Sonic',
  0x15: 'Sheik',
  0x16: 'Marina',
  0x17: 'Dedede',
  0x18: 'Goemon',
  0x19: 'Conker',
  0x1A: 'Mewtwo',
  0x1B: 'Lucas',
  0x1C: 'Wolf',
  0x1D: 'Mr Game & Watch',
  0x1E: 'Pichu',
};

const REMIX_STAGES = {
  ...SSB64_STAGES,
  // Extended Remix stages — IDs to be verified in Task 13
};

// ── RDRAM Address Maps ───────────────────────────────────────────────────────
// Addresses are virtual N64 addresses (0x80xxxxxx). To read from HEAPU8,
// subtract 0x80000000 to get the RDRAM offset.
//
// These addresses are placeholders from community documentation (GameShark
// codes, Smash Remix source). They are verified empirically in Task 13
// before the feature ships.

const ADDRESS_MAPS = {
  // SSB64 US v1.0 — addresses verified in Task 13
  _ssb64_us: {
    matchState: 0x80130D40,  // game state byte
    stageId: 0x8013201C,     // current stage ID
    timer: 0x80131D94,       // match timer (frames)
    playerBase: 0x80130D84,  // P1 struct start
    playerStride: 0x74,      // bytes between player structs
    offsets: {
      character: 0x0B,       // character ID byte within player struct
      stocks: 0x2C,          // stock count byte
      damage: 0x2A,          // damage % (2 bytes, big-endian)
    },
    matchStateValues: {
      menu: 0x00,
      css: 0x01,             // character select screen
      sss: 0x02,             // stage select screen
      inGame: 0x03,
      results: 0x04,
    },
    characters: SSB64_CHARACTERS,
    stages: SSB64_STAGES,
  },
  // Smash Remix — same base struct layout, extended enums
  _smash_remix: {
    matchState: 0x80130D40,  // same as vanilla (verify in Task 13)
    stageId: 0x8013201C,
    timer: 0x80131D94,
    playerBase: 0x80130D84,
    playerStride: 0x74,
    offsets: {
      character: 0x0B,
      stocks: 0x2C,
      damage: 0x2A,
    },
    matchStateValues: {
      menu: 0x00,
      css: 0x01,
      sss: 0x02,
      inGame: 0x03,
      results: 0x04,
    },
    characters: REMIX_CHARACTERS,
    stages: REMIX_STAGES,
  },
};

// Map ROM hashes to address maps.
// Keys are SHA-256 hex strings of the ROM file.
// Hashes are filled in during Task 13 (empirical verification).
const ROM_HASH_MAP = {
  // 'sha256-of-ssb64-us-v1.0': ADDRESS_MAPS._ssb64_us,
  // 'sha256-of-smash-remix-vX': ADDRESS_MAPS._smash_remix,
};

// ── RDRAM base offset ────────────────────────────────────────────────────────
// N64 virtual addresses start at 0x80000000. RDRAM offset = addr - 0x80000000.
const VIRT_BASE = 0x80000000;

// ── GameMemoryReader Class ───────────────────────────────────────────────────

class GameMemoryReader {
  /**
   * @param {string} romHash - SHA-256 hex of the loaded ROM
   * @param {() => object|null} getModule - function returning the WASM Module (or null)
   */
  constructor(romHash, getModule) {
    this._getModule = getModule;
    this._map = ROM_HASH_MAP[romHash] || null;
    this._interval = null;
    this._prev = null;
    this.supported = !!this._map;
    /** @type {((state: object) => void)|null} */
    this.onChange = null;
  }

  /** Begin polling RDRAM. No-op if ROM not supported. */
  start() {
    if (!this.supported || this._interval) return;
    this._interval = setInterval(() => this._poll(), 250);
  }

  /** Stop polling. */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._prev = null;
  }

  /** Single poll cycle — read, decode, diff, emit. */
  _poll() {
    const mod = this._getModule();
    if (!mod?.HEAPU8) return;

    const heap = mod.HEAPU8;
    const map = this._map;
    const state = this._decode(heap, map);
    if (!state) return;

    // Shallow diff — only emit on change
    const json = JSON.stringify(state);
    if (json === this._prev) return;
    this._prev = json;

    window.dispatchEvent(new CustomEvent('kn-game-state', { detail: state }));
    if (this.onChange) this.onChange(state);
  }

  /** Read specific RDRAM addresses and decode into structured state. */
  _decode(heap, map) {
    try {
      const rd = (addr) => heap[addr - VIRT_BASE];
      const rd16 = (addr) => (heap[addr - VIRT_BASE] << 8) | heap[addr - VIRT_BASE + 1];

      // Match state
      const rawState = rd(map.matchState);
      const matchState = this._resolveMatchState(rawState, map);

      // Stage
      const stageId = rd(map.stageId);
      const stage = map.stages[stageId] || `Stage ${stageId}`;

      // Timer (frames → seconds)
      const timerFrames = rd16(map.timer);
      const timer = timerFrames > 0 ? Math.floor(timerFrames / 60) : null;

      // Players
      const players = [];
      for (let i = 0; i < 4; i++) {
        const base = map.playerBase + i * map.playerStride;
        const charId = rd(base + map.offsets.character);
        const stocks = rd(base + map.offsets.stocks);
        const damage = rd16(base + map.offsets.damage);

        // Detect empty slot: character 0xFF or stocks 0xFF typically means unused
        if (charId === 0xFF || (matchState === 'menu' && stocks === 0)) {
          players.push(null);
        } else {
          players.push({
            character: map.characters[charId] || `Character ${charId}`,
            stocks,
            damage,
          });
        }
      }

      // Winner detection (only on results screen)
      let winner = null;
      if (matchState === 'results') {
        // Simple heuristic: player with stocks remaining on results screen
        for (let i = 0; i < players.length; i++) {
          if (players[i] && players[i].stocks > 0) {
            winner = i;
            break;
          }
        }
      }

      return { matchState, stage, stageId, timer, players, winner };
    } catch {
      // HEAPU8 may have detached — skip this cycle
      return null;
    }
  }

  _resolveMatchState(raw, map) {
    const v = map.matchStateValues;
    if (raw === v.menu) return 'menu';
    if (raw === v.css) return 'css';
    if (raw === v.sss) return 'sss';
    if (raw === v.inGame) return 'in-game';
    if (raw === v.results) return 'results';
    return 'unknown';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/static/game-memory.js
git commit -m "feat: add GameMemoryReader class with SSB64 address maps"
```

---

### Task 7: Create ThumbnailCapture module

**Files:**
- Create: `web/static/thumbnail-capture.js`

- [ ] **Step 1: Create the ThumbnailCapture class**

Create `web/static/thumbnail-capture.js`:

```js
/**
 * ThumbnailCapture — periodic canvas screenshot for match browser thumbnails.
 *
 * Standalone class (not IIFE — no EJS interop needed).
 * Captures emulator canvas as low-res JPEG and sends via Socket.IO.
 *
 * Usage:
 *   const capture = new ThumbnailCapture(getCanvas, socket);
 *   capture.start();
 *   // later:
 *   capture.stop();
 */

class ThumbnailCapture {
  /**
   * @param {() => HTMLCanvasElement|null} getCanvas - function returning the emulator canvas
   * @param {object} socket - Socket.IO client instance
   * @param {number} intervalMs - capture interval in milliseconds (default 5000)
   */
  constructor(getCanvas, socket, intervalMs = 5000) {
    this._getCanvas = getCanvas;
    this._socket = socket;
    this._intervalMs = intervalMs;
    this._interval = null;
  }

  /** Begin periodic capture. */
  start() {
    if (this._interval) return;
    // Capture immediately, then on interval
    this._capture();
    this._interval = setInterval(() => this._capture(), this._intervalMs);
  }

  /** Stop capturing. */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /** Capture canvas and send to server. */
  _capture() {
    const canvas = this._getCanvas();
    if (!canvas || !this._socket?.connected) return;
    try {
      const thumbnail = canvas.toDataURL('image/jpeg', 0.4);
      this._socket.emit('match-thumbnail', { thumbnail });
    } catch {
      // Canvas may be tainted or unavailable — skip this cycle
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/static/thumbnail-capture.js
git commit -m "feat: add ThumbnailCapture class for match browser previews"
```

---

### Task 8: Integrate reader and thumbnail into play.js

**Files:**
- Modify: `web/play.html` (add script tags)
- Modify: `web/static/play.js:738-846` (game lifecycle hooks)

- [ ] **Step 1: Add script tags to play.html**

In `web/play.html`, find the existing `<script>` tags that load JS files. Add before the `play.js` script tag:

```html
<script src="/static/game-memory.js"></script>
<script src="/static/thumbnail-capture.js"></script>
```

- [ ] **Step 2: Add reader/thumbnail state variables to play.js**

In `web/static/play.js`, in the state section (around line 63-84), add:

```js
  let _memoryReader = null;
  let _thumbnailCapture = null;
```

- [ ] **Step 3: Initialize reader and thumbnail on game start**

In `web/static/play.js`, in `onGameStarted` (line 738), add initialization after the `initEngine()` call at line 802. Add just before the closing `};` of `onGameStarted`:

```js
    // Start live game memory reader (host only, supported ROMs)
    if (isHost && typeof GameMemoryReader !== 'undefined') {
      _memoryReader = new GameMemoryReader(
        _romHash,
        () => window.EJS_emulator?.gameManager?.Module,
      );
      _memoryReader.onChange = (state) => {
        if (socket?.connected) socket.emit('game-state', state);
      };
      _memoryReader.start();
    }
    // Start thumbnail capture (host only, public rooms only)
    const publicCheckbox = document.getElementById('opt-public');
    if (isHost && typeof ThumbnailCapture !== 'undefined' && publicCheckbox?.checked) {
      const getCanvas = () => document.querySelector('#game canvas');
      _thumbnailCapture = new ThumbnailCapture(getCanvas, socket);
      // Delay start to let canvas render first frame
      setTimeout(() => _thumbnailCapture?.start(), 2000);
    }
```

- [ ] **Step 4: Clean up on game end**

In `web/static/play.js`, in `onGameEnded` (line 805), add cleanup after `hibernateEmulator()` (line 822):

```js
    // Stop memory reader and thumbnail capture
    if (_memoryReader) { _memoryReader.stop(); _memoryReader = null; }
    if (_thumbnailCapture) { _thumbnailCapture.stop(); _thumbnailCapture = null; }
```

- [ ] **Step 5: Also clean up on room close**

In `web/static/play.js`, in `onRoomClosed` (find the handler), add the same cleanup:

```js
    if (_memoryReader) { _memoryReader.stop(); _memoryReader = null; }
    if (_thumbnailCapture) { _thumbnailCapture.stop(); _thumbnailCapture = null; }
```

- [ ] **Step 6: Commit**

```bash
git add web/play.html web/static/play.js
git commit -m "feat: integrate GameMemoryReader and ThumbnailCapture into play.js lifecycle"
```

---

## Chunk 3: Host Visibility Controls

### Task 9: Add visibility toggles to host controls UI

**Files:**
- Modify: `web/play.html:101-127` (host-controls section)
- Modify: `web/static/play.js` (visibility event emission)

- [ ] **Step 1: Add visibility toggles to play.html**

In `web/play.html`, inside the `host-controls` div (after the `rom-sharing-disclaimer` paragraph, before the start button at line 126), add:

```html
          <div class="host-options-row" id="visibility-options">
            <label><input type="checkbox" id="opt-public" /> List on game browser</label>
          </div>
          <div class="host-options-row" id="join-spectate-options" style="display: none">
            <label><input type="checkbox" id="opt-allow-join" checked /> Allow join</label>
            <label><input type="checkbox" id="opt-allow-spectate" checked /> Allow spectate</label>
          </div>
```

- [ ] **Step 2: Add visibility change handlers in play.js**

In `web/static/play.js`, find where host control event listeners are set up (look for `mode-select` or `opt-resync` listeners). Add nearby:

```js
    // Visibility controls
    const publicCheckbox = document.getElementById('opt-public');
    const joinSpectateOptions = document.getElementById('join-spectate-options');
    const allowJoinCheckbox = document.getElementById('opt-allow-join');
    const allowSpectateCheckbox = document.getElementById('opt-allow-spectate');

    if (publicCheckbox) {
      publicCheckbox.addEventListener('change', () => {
        const isPublic = publicCheckbox.checked;
        if (joinSpectateOptions) joinSpectateOptions.style.display = isPublic ? '' : 'none';
        socket.emit('set-visibility', {
          public: isPublic,
          allowJoin: allowJoinCheckbox?.checked ?? true,
          allowSpectate: allowSpectateCheckbox?.checked ?? true,
        });
      });
    }
    if (allowJoinCheckbox) {
      allowJoinCheckbox.addEventListener('change', () => {
        socket.emit('set-visibility', { allowJoin: allowJoinCheckbox.checked });
      });
    }
    if (allowSpectateCheckbox) {
      allowSpectateCheckbox.addEventListener('change', () => {
        socket.emit('set-visibility', { allowSpectate: allowSpectateCheckbox.checked });
      });
    }
```

- [ ] **Step 3: Start/stop thumbnail capture dynamically on visibility change**

The thumbnail initialization in Task 8 already checks `publicCheckbox?.checked`. Now add dynamic start/stop to the public checkbox handler (added in Step 2 above) so toggling visibility mid-game starts or stops capture:

```js
        // Start/stop thumbnail capture based on public visibility
        if (isPublic && gameRunning && !_thumbnailCapture) {
          const getCanvas = () => document.querySelector('#game canvas');
          _thumbnailCapture = new ThumbnailCapture(getCanvas, socket);
          _thumbnailCapture.start();
        } else if (!isPublic && _thumbnailCapture) {
          _thumbnailCapture.stop();
          _thumbnailCapture = null;
        }
```

- [ ] **Step 4: Commit**

```bash
git add web/play.html web/static/play.js
git commit -m "feat: add host visibility toggles (public, allow join, allow spectate)"
```

---

## Chunk 4: Game Browser Page

### Task 10: Create matches.html page

**Files:**
- Create: `web/matches.html`
- Create: `web/static/matches.js`
- Create: `web/static/matches.css`

- [ ] **Step 1: Create matches.html**

Create `web/matches.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>kaillera-next — Game Browser</title>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
    <link rel="stylesheet" href="/static/lobby.css" />
    <link rel="stylesheet" href="/static/matches.css" />
  </head>
  <body>
    <main class="matches-page">
      <div class="matches-header">
        <h1><a href="/" class="home-link">kaillera-next</a></h1>
        <p class="matches-subtitle">Game Browser</p>
      </div>
      <div id="matches-list" class="matches-grid"></div>
      <div id="matches-empty" class="matches-empty" style="display: none">
        <p>No public matches right now.</p>
        <a href="/" class="create-link">Create a room to get started</a>
      </div>
    </main>
    <script src="/static/storage.js"></script>
    <script src="/static/matches.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create matches.css**

Create `web/static/matches.css`:

```css
.matches-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 16px;
}
.matches-header {
  text-align: center;
  margin-bottom: 24px;
}
.matches-header h1 {
  margin: 0;
}
.home-link {
  color: inherit;
  text-decoration: none;
}
.home-link:hover {
  text-decoration: underline;
}
.matches-subtitle {
  color: #888;
  margin: 4px 0 0;
  font-size: 14px;
}
.matches-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.match-card {
  background: #1a1a2e;
  border: 1px solid #333;
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}
.match-card:hover {
  border-color: #555;
}
.match-thumb {
  width: 100%;
  aspect-ratio: 4 / 3;
  background: #111;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #444;
  font-size: 13px;
  overflow: hidden;
}
.match-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.match-info {
  padding: 12px;
}
.match-stage {
  font-weight: bold;
  font-size: 15px;
  margin-bottom: 4px;
}
.match-players {
  color: #ccc;
  font-size: 13px;
  margin-bottom: 4px;
}
.match-details {
  color: #888;
  font-size: 12px;
  margin-bottom: 8px;
}
.match-actions {
  display: flex;
  gap: 8px;
}
.match-actions button {
  flex: 1;
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: bold;
  cursor: pointer;
  transition: opacity 0.2s;
}
.match-actions button:hover {
  opacity: 0.85;
}
.match-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn-join {
  background: #0f8;
  color: #000;
}
.btn-spectate {
  background: #4a9eff;
  color: #000;
}
.btn-locked {
  background: #ffcc4a;
  color: #000;
}
.btn-full {
  background: #666;
  color: #000;
}
.match-lock {
  font-size: 11px;
  color: #ffcc4a;
  margin-bottom: 4px;
}
.matches-empty {
  text-align: center;
  padding: 60px 20px;
  color: #888;
}
.create-link {
  color: #0f8;
  text-decoration: none;
}
.create-link:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Create matches.js controller**

Create `web/static/matches.js`:

```js
/**
 * matches.js — Game Browser page controller.
 * Polls GET /api/matches and renders match cards with join/spectate actions.
 */
(function () {
  'use strict';

  const listEl = document.getElementById('matches-list');
  const emptyEl = document.getElementById('matches-empty');
  const POLL_INTERVAL = 5000;
  let _pollTimer = null;

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const formatPlayers = (players) => {
    const named = players.filter((p) => p.name);
    if (!named.length) return 'Waiting for players...';
    return named
      .map((p) => {
        const char = p.character ? ` (${escapeHtml(p.character)})` : '';
        return `${escapeHtml(p.name)}${char}`;
      })
      .join(' vs ');
  };

  const formatDetails = (match) => {
    const parts = [];
    parts.push(`${match.players.length}/${match.maxPlayers} players`);
    if (match.openSlots > 0) parts.push(`${match.openSlots} open`);
    else parts.push('full');
    if (match.spectatorCount > 0) parts.push(`${match.spectatorCount} watching`);
    if (match.mode) parts.push(match.mode);
    return parts.join(' · ');
  };

  const formatGameState = (gs) => {
    if (!gs?.matchState) return '';
    const parts = [];
    if (gs.stage) parts.push(gs.stage);
    if (gs.timer != null) {
      const min = Math.floor(gs.timer / 60);
      const sec = gs.timer % 60;
      parts.push(`${min}:${String(sec).padStart(2, '0')}`);
    }
    return parts.join(' — ');
  };

  const navigateToRoom = (sessionId, spectate, hasPassword) => {
    let pw = '';
    if (hasPassword) {
      pw = prompt('This room requires a password:');
      if (pw === null) return; // cancelled
    }
    const savedName = KNStorage.get('localStorage', 'kaillera-name') || 'Player';
    let url = `/play.html?room=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(savedName)}`;
    if (spectate) url += '&spectate=1';
    if (pw) url += `&password=${encodeURIComponent(pw)}`;
    window.location.href = url;
  };

  const renderCard = (match) => {
    const gs = match.gameState;
    const gsText = formatGameState(gs);

    const thumbHtml = match.thumbnail
      ? `<img src="${escapeHtml(match.thumbnail)}" alt="Game preview" loading="lazy">`
      : 'No preview';

    const lockHtml = match.hasPassword ? '<div class="match-lock">🔒 Password protected</div>' : '';

    let actionsHtml = '';
    if (match.allowJoin && match.openSlots > 0) {
      actionsHtml += `<button class="btn-join" data-action="join" data-id="${escapeHtml(match.sessionId)}" data-pw="${match.hasPassword}">Join</button>`;
    } else if (match.openSlots <= 0) {
      actionsHtml += '<button class="btn-full" disabled>Full</button>';
    }
    if (match.allowSpectate) {
      actionsHtml += `<button class="btn-spectate" data-action="spectate" data-id="${escapeHtml(match.sessionId)}" data-pw="${match.hasPassword}">Spectate</button>`;
    }

    return `
      <div class="match-card" data-session="${escapeHtml(match.sessionId)}">
        <div class="match-thumb">${thumbHtml}</div>
        <div class="match-info">
          <div class="match-stage">${gsText || escapeHtml(match.roomName)}</div>
          <div class="match-players">${formatPlayers(match.players)}</div>
          <div class="match-details">${formatDetails(match)}</div>
          ${lockHtml}
          <div class="match-actions">${actionsHtml}</div>
        </div>
      </div>
    `;
  };

  const render = (matches) => {
    if (!matches.length) {
      listEl.innerHTML = '';
      listEl.style.display = 'none';
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.style.display = '';

    // Diff-and-patch: update existing cards, add new, remove stale
    const activeIds = new Set(matches.map((m) => m.sessionId));
    // Remove stale cards
    for (const card of [...listEl.querySelectorAll('.match-card')]) {
      if (!activeIds.has(card.dataset.session)) card.remove();
    }
    // Update or insert each match
    for (const match of matches) {
      const existing = listEl.querySelector(`[data-session="${CSS.escape(match.sessionId)}"]`);
      const html = renderCard(match);
      if (existing) {
        // Replace inner content without destroying the element (preserves scroll)
        const temp = document.createElement('div');
        temp.innerHTML = html;
        existing.replaceWith(temp.firstElementChild);
      } else {
        listEl.insertAdjacentHTML('beforeend', html);
      }
    }
  };

  const poll = async () => {
    try {
      const res = await fetch('/api/matches');
      if (!res.ok) return;
      const matches = await res.json();
      render(matches);
    } catch {
      // Network error — keep showing last state
    }
  };

  // Delegate click handlers
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const hasPw = btn.dataset.pw === 'true';
    navigateToRoom(id, action === 'spectate', hasPw);
  });

  // Start polling
  poll();
  _pollTimer = setInterval(poll, POLL_INTERVAL);
})();
```

- [ ] **Step 4: Commit**

```bash
git add web/matches.html web/static/matches.css web/static/matches.js
git commit -m "feat: add game browser page (matches.html) with live match cards"
```

---

### Task 11: Add navigation link from lobby to game browser

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add "Browse Games" link to lobby**

In `web/index.html`, after the `join-row` div (line 29), add:

```html
      <div class="divider">or browse public games</div>
      <a href="/matches.html" class="browse-link" style="display:block;text-align:center;color:#4a9eff;text-decoration:none;font-size:14px;padding:4px 0">Game Browser →</a>
```

- [ ] **Step 2: Commit**

```bash
git add web/index.html
git commit -m "feat: add game browser link to lobby page"
```

---

### Task 12: Handle password parameter on play.html join

**Files:**
- Modify: `web/static/play.js` (password from URL params)

- [ ] **Step 1: Pass password from URL to join-room payload**

In `web/static/play.js`, around line 421-432, the guest emits `join-room` with a payload object containing `extra: { ... }`. The `JoinRoomPayload` already has a `password` field at the top level. Add the password from URL params.

Find the `socket.emit('join-room', {` call at line 421 and add `password` to the payload object (sibling of `extra`):

```js
        socket.emit(
          'join-room',
          {
            extra: {
              sessionid: roomCode,
              userid: socket.id,
              player_name: playerName,
              spectate: isSpectator,
              persistentId: _persistentId,
              reconnectToken: _reconnectToken,
            },
            password: params.get('password') || undefined,
          },
```

Also add the same `password` field to the retry emit at line 439 (the "Room is full" auto-spectate fallback) and to the reconnect payloads at lines 235 and 346.

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "feat: pass password URL param to join-room payload for match browser joins"
```

---

## Chunk 5: RDRAM Address Verification

### Task 13: Empirically verify SSB64 RDRAM addresses

**Files:**
- Modify: `web/static/game-memory.js` (finalize address map + ROM hash)

This task requires manual testing with a running SSB64 ROM. The approach:

- [ ] **Step 1: Add a temporary debug reader to the browser console**

Temporarily add a global debug function to `game-memory.js` for interactive verification:

```js
// Temporary — remove after address verification
window._knDebugRDRAM = (addr) => {
  const mod = window.EJS_emulator?.gameManager?.Module;
  if (!mod?.HEAPU8) return 'Module not ready';
  const offset = addr - 0x80000000;
  return {
    byte: mod.HEAPU8[offset],
    hex: mod.HEAPU8[offset].toString(16),
    word: new DataView(mod.HEAPU8.buffer, offset, 4).getUint32(0),
  };
};
```

- [ ] **Step 2: Verification procedure**

1. Load SSB64 ROM and start a game
2. Note the ROM's SHA-256 hash (logged in console during load)
3. At character select: read character ID addresses, confirm they match the selected character
4. At stage select: read stage ID, confirm it matches
5. In-game: read stocks, damage %, timer and confirm against on-screen values
6. On results screen: confirm match state and winner detection

- [ ] **Step 3: Update address map with verified values**

Replace placeholder addresses and ROM hash in `game-memory.js` with the verified values.

- [ ] **Step 4: Remove debug helper**

Remove `window._knDebugRDRAM` from `game-memory.js`.

- [ ] **Step 5: Commit**

```bash
git add web/static/game-memory.js
git commit -m "feat: verified SSB64 US RDRAM addresses for game memory reader"
```

---

## Chunk 6: Integration & Polish

### Task 14: Add session log and PostHog enrichment

**Files:**
- Modify: `server/src/api/signaling.py` (game-state handler — detect transitions, write to session log and PostHog)

- [ ] **Step 1: Update game-state handler to detect transitions and write to session log**

In `signaling.py`, update the `on_game_state` handler to detect key transitions before overwriting `room.game_state`. Replace the simple `room.game_state = payload.model_dump()` with:

```python
    # Detect key state transitions
    prev_state = room.game_state
    new_state = payload.model_dump()
    room.game_state = new_state

    # Log match start (first in-game state)
    if payload.matchState == "in-game" and (not prev_state or prev_state.get("matchState") != "in-game"):
        characters = [p.get("character") if isinstance(p, dict) else None for p in (new_state.get("players") or [])]
        log.info("Match started in room %s: stage=%s players=%s", session_id, payload.stage, characters)
        # Enrich session log
        if room.match_id:
            try:
                await db.upsert_session_log(
                    match_id=room.match_id,
                    session_id=session_id,
                    context={"matchStart": {"stage": payload.stage, "characters": characters}},
                )
            except Exception:
                pass  # best-effort

    # Log match end (results screen)
    if payload.matchState == "results" and (not prev_state or prev_state.get("matchState") != "results"):
        log.info("Match ended in room %s: winner=%s", session_id, payload.winner)
        if room.match_id:
            try:
                await db.upsert_session_log(
                    match_id=room.match_id,
                    session_id=session_id,
                    context={"matchEnd": {"winner": payload.winner, "stage": payload.stage}},
                )
            except Exception:
                pass  # best-effort
```

- [ ] **Step 2: Enrich PostHog events in start-game and end-game handlers**

Find the existing `start-game` handler where PostHog events are emitted. After the game starts, if `room.game_state` is available, include it in PostHog properties. Similarly in the `end-game` handler, capture final game state before clearing it.

In `start-game` handler, where PostHog `game_started` event is emitted, add to properties:
```python
    if room.game_state:
        props["stage"] = room.game_state.get("stage")
        props["characters"] = [
            p.get("character") if isinstance(p, dict) else None
            for p in (room.game_state.get("players") or [])
        ]
```

In `end-game` handler, before clearing game_state, capture final state for PostHog:
```python
    final_state = room.game_state or {}
    # ... existing end-game logic ...
    # In PostHog game_ended event properties:
    if final_state:
        props["stage"] = final_state.get("stage")
        props["winner"] = final_state.get("winner")
```

- [ ] **Step 3: Commit**

```bash
git add server/src/api/signaling.py
git commit -m "feat: enrich session logs and PostHog with game state transitions"
```

---

### Task 15: Clean up room game state on game end

**Files:**
- Modify: `server/src/api/signaling.py` (end-game handler)

- [ ] **Step 1: Clear ephemeral fields on game end**

In the existing `end-game` event handler in `signaling.py`, add cleanup of game-specific ephemeral state:

```python
    room.game_state = None
    room.thumbnail = None
```

Add these alongside the existing cleanup (where `room.status` is set back to `"lobby"`).

- [ ] **Step 2: Commit**

```bash
git add server/src/api/signaling.py
git commit -m "fix: clear game_state and thumbnail on game end"
```

---

### Task 16: Serve matches.html with OG tags

**Files:**
- Modify: `server/src/api/app.py` (add route for matches.html)

- [ ] **Step 1: Add matches.html route**

In `server/src/api/app.py`, add a route for the matches page. Find where `/play.html` is served and add nearby:

```python
    @app.get("/matches.html")
    async def matches_page():
        path = _WEB_DIR / "matches.html"
        if not path.exists():
            raise HTTPException(status_code=404)
        return Response(content=path.read_text(), media_type="text/html")
```

If the existing play.html route uses `_inject_kn_config` or similar, follow the same pattern.

- [ ] **Step 2: Commit**

```bash
git add server/src/api/app.py
git commit -m "feat: serve matches.html page"
```

---

### Task 17: End-to-end manual testing

- [ ] **Step 1: Test the full flow**

1. Start the dev server
2. Create a room as host, check "List on game browser"
3. Open `/matches.html` in another tab — verify the room appears
4. Start a game with SSB64 — verify thumbnail appears on match card
5. Verify game state (stage, characters) appears on the card
6. Click Join/Spectate buttons — verify navigation to play.html works
7. Test password flow: create a password-protected public room, verify prompt appears

- [ ] **Step 2: Test edge cases**

1. Verify private rooms don't appear on match list
2. Verify game state clears when game ends
3. Verify match card disappears when room closes
4. Verify rate limiting works (check server logs for no warnings under normal use)

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during e2e testing"
```
