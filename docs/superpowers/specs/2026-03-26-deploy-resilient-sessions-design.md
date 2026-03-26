# Deploy-Resilient Sessions

## Problem

All room state lives in Python dicts (`rooms`, `_sid_to_room`) in `signaling.py`. Every server restart or deploy destroys all active rooms, disconnecting every player mid-game. This is unacceptable during active iteration where deploys happen frequently.

## Solution

Redis for room state persistence + blue-green Swarm deploys for zero-gap container replacement. Combined with the existing client-side auto-reconnect logic, running games survive deploys seamlessly.

## Architecture

```
Before deploy:
  [Browser A] ←P2P WebRTC→ [Browser B]
       ↕ Socket.IO              ↕
  [kaillera-next server v1] ←→ [Redis]
       room state cached         room state persisted

During deploy (start-first):
  [Browser A] ←P2P WebRTC→ [Browser B]     ← P2P unaffected
       ↕ (disconnecting)        ↕
  [server v1 draining]     [server v2 starting]
                                ↕
                           [Redis] ← rooms still here

After deploy:
  [Browser A] ←P2P WebRTC→ [Browser B]
       ↕ Socket.IO              ↕
  [kaillera-next server v2] ←→ [Redis]
       rooms hydrated            same state
```

## Components

### 1. Redis State Module — `server/src/state.py`

A thin async persistence layer using `redis[hiredis]`. The in-memory `rooms` dict remains the primary data structure for all signaling logic — Redis is the persistence backing store, not the hot path for reads.

**Connection:** Via `REDIS_URL` env var (default `redis://localhost:6379/0`).

**Data model:**
- Key: `kn:room:{sessionId}` — JSON-serialized Room dataclass
- TTL: 12 hours per room (refreshed on each write; long enough for extended lockstep sessions where the server is idle after WebRTC connects)
- No separate keys for players/spectators — the Room dataclass is small enough to serialize whole

**API:**
```python
async def init() -> None
    """Connect to Redis, called on startup."""

async def close() -> None
    """Close Redis connection, called on shutdown."""

async def save_room(session_id: str, room: Room) -> None
    """Serialize room to Redis with 12h TTL."""

async def delete_room(session_id: str) -> None
    """Remove room from Redis."""

async def load_all_rooms() -> dict[str, Room]
    """Load all kn:room:* keys, deserialize, return dict. Called once on startup."""
```

**Serialization:** `dataclasses.asdict()` → JSON for save. JSON → Room constructor for load. Sets (`rom_ready`, `rom_declared`) serialized as lists. `slots` dict has integer keys — `load_all_rooms` must convert JSON string keys back to `int`.

**`_sid_to_room` is NOT persisted.** It maps transient socket IDs that are invalid after restart. Rebuilt as clients reconnect and re-join rooms.

**All SID-keyed fields become stale after restart.** The Room dataclass stores socket IDs in: `owner`, `players` dict keys, `players[x]["socketId"]`, `slots` values (which are player_ids = SIDs), `rom_ready`, `rom_declared`, `input_types`, `device_types`. All of these are updated during the reconnect flow (Section 4).

### 2. Signaling.py Mutations — Persist on Write

Every handler that mutates room state gets an `await state.save_room()` or `await state.delete_room()` call after the mutation. These are the mutation points:

| Handler | Mutation | Persist call |
|---|---|---|
| `open_room` | Room created | `save_room` |
| `join_room` | Player/spectator added | `save_room` |
| `_leave` | Player removed | `save_room` or `delete_room` if empty |
| `start_game` | Status → playing, mode set | `save_room` |
| `end_game` | Status → lobby | `save_room` |
| `claim_slot` | Spectator → player, slot assigned | `save_room` |
| `set_mode` | Mode changed | `save_room` |
| `rom_sharing_toggle` | rom_sharing flag | `save_room` |
| `rom_ready` | rom_ready set updated | `save_room` |
| `rom_declare` | rom_declared set updated | `save_room` |
| `_cleanup_empty_rooms` | Empty/zombie room deleted | `delete_room` |

**Zombie room cleanup:** Enhance `_cleanup_empty_rooms` to also detect rooms where no player has a live socket (i.e., no player's `socketId` appears in `_sid_to_room`). After a 5-minute grace period (to allow time for reconnection), delete these rooms from both memory and Redis. This handles the case where a server restarts and some players never reconnect.

### 3. Startup Hydration — `main.py` Lifespan

On server startup (lifespan context manager):
1. Call `await state.init()` to connect to Redis
2. Call `rooms.update(await state.load_all_rooms())` to hydrate in-memory state
3. Log how many rooms were restored

On shutdown:
1. Remove the current `room-closed` broadcast with reason "server-shutdown" — rooms survive now
2. Call `await state.close()` to cleanly disconnect from Redis
3. Log clean shutdown

### 4. Persistent Client ID + Reconnect-Aware Handlers

#### 4a. Client-generated persistent ID

The core problem: `player_id = sid` (socket ID), which changes on every reconnect. Name-based matching is fragile (name collisions). Instead, the client generates a persistent ID.

**Client side (play.js):** On page load, generate a UUID and store it in `sessionStorage` (survives reconnects within the same tab, but not new tabs — which is correct, a new tab is a new player):
```javascript
const persistentId = sessionStorage.getItem('kn-player-id') || crypto.randomUUID();
sessionStorage.setItem('kn-player-id', persistentId);
```

Send `persistentId` in both `open-room` and `join-room` payloads via `extra.persistentId`.

**Server side (signaling.py):** Change `player_id` from `sid` to `extra.persistentId` (falling back to `sid` if not provided, for backward compat). This means `room.players` dict keys and `room.slots` values are now stable persistent IDs, not transient SIDs. Only `room.owner`, `room.players[x]["socketId"]`, `rom_ready`, `rom_declared`, `input_types`, and `device_types` contain socket IDs.

#### 4b. Reconnect-aware `open-room` handler

After a restart, the host reconnects and the `onConnect` handler emits `open-room`. Currently this returns "Room already exists".

**Change:** Reconnect detection must happen BEFORE the `await _leave(sid)` call. If `session_id in rooms` AND the room has a player with the same `persistentId` as the caller, skip `_leave` and treat it as a host reconnect:
1. Call `_swap_sid(room, persistentId, old_sid, new_sid)` (Section 4d)
2. Set `_sid_to_room[new_sid]` and clean up stale entry
3. Enter the Socket.IO room, broadcast `users-updated`
4. Save to Redis
5. Return success (not "Room already exists")

If the room exists but `persistentId` doesn't match the owner, return "Room already exists" (normal path).

#### 4c. Reconnect-aware `join-room` handler

Non-host players reconnect via `join-room` (both the `reconnect` event handler and `onConnect` for non-hosts).

**Change:** Reconnect detection must happen BEFORE the `await _leave(sid)` call. If the room already has a player/spectator with the same `persistentId`, skip `_leave` and treat as reconnect:
1. Call `_swap_sid(room, persistentId, old_sid, new_sid)` (Section 4d)
2. Update `_sid_to_room` for new SID
3. Restore the player's original slot (already in `room.slots` by persistentId)
4. Skip "room is full" check
5. Broadcast `users-updated`
6. Save to Redis

**Ordering invariant:** In both handlers, the sequence is: detect reconnect → skip `_leave` → swap SIDs → broadcast. The `_leave` call only runs for genuinely new joins where the player is switching rooms.

#### 4d. Comprehensive SID swap helper

Extract a helper function `_swap_sid(room, persistent_id, old_sid, new_sid)` that updates all SID-keyed fields in one place:
- `room.owner`: if `old_sid`, set to `new_sid`
- `room.players[persistent_id]["socketId"]`: set to `new_sid`
- `room.rom_ready`: discard `old_sid`, add `new_sid` (if was present)
- `room.rom_declared`: discard `old_sid`, add `new_sid` (if was present)
- `room.input_types`: move `old_sid` entry to `new_sid`
- `room.device_types`: move `old_sid` entry to `new_sid`

This ensures no stale SID references remain after any reconnect.

### 5. Client-Side Silent Reconnect — `play.js`

Current behavior:
- On disconnect during lobby: shows "Connection lost — reconnecting..."
- On reconnect: shows "Reconnected — rejoining room..."
- On connect_error during game: shows error and redirects to lobby
- Host uses `onConnect` → `open-room`; non-host uses `reconnect` → `join-room`

**Changes:**

**Unified reconnect path:** Both the `reconnect` event handler AND the `onConnect` handler should use the same rejoin logic. On reconnect/connect, emit `open-room` (if host) or `join-room` (if non-host) with `persistentId`. The server handles recognizing returning players (Section 4b/4c). This means `onConnect` no longer fails for hosts when the room exists.

**Silent reconnection during games:**
- **During a game (`gameRunning === true`):** All reconnection is silent. No toasts, no messages. Socket.IO reconnects automatically, rejoin is re-emitted, game continues. Player never knows.
- **During lobby (`gameRunning === false`):** Show a subtle, non-alarming message only if reconnection takes more than ~5 seconds (e.g., "Reconnecting to server..."). No "connection lost" language.
- **Rejoin failure:** Only redirect to lobby if rejoin fails after reconnection, with a helpful message ("Room is no longer available").
- Remove "Reconnected — rejoining room..." toast entirely.

**`connect_error` during game:** Do NOT redirect to lobby. Socket.IO will keep retrying. Only redirect if the rejoin itself fails (room gone from Redis).

### 6. Graceful Shutdown — `main.py`

On SIGTERM:
- Do NOT broadcast `room-closed` (rooms survive in Redis)
- Log "Shutting down gracefully, N rooms preserved in Redis"
- Close Redis connection
- Exit

### 7. Blue-Green Deploy + Redis Service — Docker Compose

The existing `docker-compose.prod.yml` already has `order: start-first`. Add `stop_grace_period` and a Redis service:

```yaml
services:
  redis:
    image: redis:7-alpine     # or eqalpha/keydb:latest
    restart: always
    volumes:
      - redis-data:/data
    command: redis-server --save 60 1 --loglevel warning
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  kaillera-server:
    # ... existing config ...
    environment:
      REDIS_URL: redis://redis:6379/0
    depends_on:
      redis:
        condition: service_healthy
    deploy:
      update_config:
        order: start-first
        failure_action: rollback
      stop_grace_period: 30s

volumes:
  redis-data:
```

`start-first` ensures the new container is healthy (passes the existing healthcheck) before the old one receives SIGTERM. Combined with Redis state persistence, this means:
- New server is up and has hydrated rooms before old server dies
- Clients reconnect to new server, find their rooms waiting
- Zero gap in room availability

### 8. Dockerfile Change

Add `REDIS_URL` env var with empty default (requires explicit configuration):

```dockerfile
ENV REDIS_URL=""
```

## New Dependency

Add to `server/pyproject.toml`:
```toml
"redis[hiredis]>=5.0.0",
```

`hiredis` is a C-based Redis protocol parser — faster than pure Python, no additional system dependencies.

## Graceful Degradation

If `REDIS_URL` is not set or Redis is unreachable:
- Server operates exactly as it does today (in-memory only)
- Log a warning on startup: "REDIS_URL not configured — rooms will not survive restarts"
- All signaling logic works unchanged — `state.save_room()` becomes a no-op

This means the feature is opt-in and doesn't break existing dev/test workflows.

## Constraints

- **Shutdown must NOT call `_leave` for active players.** The current shutdown broadcasts `room-closed` but does not call `_leave`. This must remain true — calling `_leave` would remove players from Redis-persisted rooms before they can reconnect.
- **Room passwords are stored as plaintext in Redis.** Same as current in-memory behavior. Accepted trade-off for v1.
- **`_state_cache` (save state cache in app.py) is NOT persisted.** Save states are re-generated during late-join; no need to persist.

## What Does NOT Change

- Room dataclass structure (same fields, same semantics)
- Socket.IO server configuration (no Redis adapter — single replica is fine)
- WebRTC signaling flow
- Lockstep and streaming netplay engines
- ROM sharing, gamepad, spectator logic
- Rate limiting
- REST API endpoints (`/list` reads from in-memory `rooms`, which is hydrated from Redis on startup)

## Deploy Sequence (What Players Experience)

### Lockstep game in progress:
1. Swarm starts new container → connects to Redis → hydrates rooms
2. Old container receives SIGTERM → exits cleanly
3. WebRTC P2P DataChannels between players: **unaffected** (server not involved)
4. Game continues uninterrupted during the ~2s gap
5. Socket.IO auto-reconnects to new server
6. `join-room` re-emitted → server recognizes returning player → slot restored
7. Player never noticed anything happened

### Streaming game in progress:
1. Same as lockstep steps 1-2
2. WebRTC MediaStream between host and guests: **unaffected**
3. Server-relayed inputs (`input` event) pause during ~2s gap
4. Socket.IO auto-reconnects → `join-room` → player restored
5. Input relay resumes — brief stutter, then normal

### Players in lobby:
1. Same startup/shutdown sequence
2. Socket.IO reconnects, `join-room` re-emitted
3. Room state restored from Redis, lobby UI refreshes via `users-updated`
4. If reconnect takes >5s, subtle "Reconnecting to server..." shown

## Testing Strategy

- Unit test `state.py` serialization round-trip (Room → JSON → Room)
- Integration test: create room, kill server, restart, verify room exists
- Playwright E2E: two players in lobby, restart server container, verify both rejoin
- Manual test: lockstep game running, deploy new version, verify game continues
