# Session Logging System — Design Spec

**Date:** 2026-04-01
**Scope:** Guaranteed session log capture via continuous Socket.IO streaming, client event migration to SQLite, PostHog integration, and removal of file-based logging.

---

## Overview

Replace the unreliable end-of-session log dump with continuous streaming. Every 30 seconds during gameplay, the client sends its full sync log ring buffer (structured JSON) to the server via Socket.IO. The server upserts into SQLite on each flush. When a player disconnects, leaves, or the game ends, the server already has logs up to the last flush — guaranteed capture regardless of how the user exits.

Client events (errors, desyncs, stalls) are migrated from file-based storage to a new `client_events` SQLite table. The file-based sync log system (`/api/sync-logs`, `sendBeacon`, localStorage recovery) is removed entirely.

## Goals

- Guarantee log capture for every player in every session regardless of exit method
- Store all data in SQLite — one queryable source of truth
- Structured JSON logs (not CSV text) for easy querying and triage
- PostHog session summary events for trend analysis
- Remove file-based logging entirely — simpler system, less maintenance

## Non-Goals

- Real-time log viewing during gameplay (admin sees logs after flush)
- Per-event PostHog tracking (summary only, detailed data in SQLite)
- Streaming mode logs (streaming netplay uses a different code path — can be added later)

---

## Architecture

```
Client (every 30s during lockstep gameplay)
  │
  │  socket.emit('session-log', {
  │    matchId, entries: [...], summary: {...}
  │  })
  │
  ▼
Server: session-log handler
  │  rate limit check (2 per 30s)
  │  validate match_id + room membership
  │
  ▼
db.upsert_session_log()
  │  INSERT OR UPDATE by (match_id, slot)
  │  Idempotent — any flush gives complete picture
  │
  ▼
On disconnect / leave / game-end:
  │  SET ended_by = 'disconnect' | 'leave' | 'game-end'
  │  PostHog: capture 'session_ended' event
  │
  ▼
Admin API → SQLite queries → admin.html
```

---

## Database

### Migration: `0002_session_logging.py`

Drops and recreates `session_logs` (no production data to preserve — the table was created in `0001` but has never been populated by the streaming system). Creates new `client_events` table.

```sql
DROP TABLE IF EXISTS session_logs;

CREATE TABLE session_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    room TEXT NOT NULL,
    slot INTEGER,
    player_name TEXT,
    mode TEXT,                       -- 'lockstep' | 'streaming'
    log_data JSON,                   -- structured entries [{seq, t, f, msg}, ...]
    summary JSON,                    -- {desyncs, stalls, reconnects, frames, duration_sec, peers}
    context JSON,                    -- {browser, device, coreVersion, ua, ...}
    ended_by TEXT,                   -- 'game-end' | 'disconnect' | 'leave' | null
    ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_session_logs_game_slot ON session_logs(match_id, slot);

CREATE TABLE client_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,              -- 'webrtc-fail' | 'desync' | 'stall' | etc.
    message TEXT,
    meta JSON,
    room TEXT,
    slot INTEGER,
    ip_hash TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
```

The unique index on `(match_id, slot)` enables the `INSERT OR REPLACE` upsert pattern — each flush overwrites the previous snapshot for that player in that game.

### `db.py` additions

```python
async def upsert_session_log(data: dict) -> int:
    """Insert or update a session log by (match_id, slot). Returns row ID."""
    cursor = await _db.execute(
        """INSERT INTO session_logs (match_id, room, slot, player_name, mode, log_data, summary, context, ip_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(match_id, slot) DO UPDATE SET
             log_data=excluded.log_data, summary=excluded.summary,
             context=excluded.context, updated_at=datetime('now')""",
        (data["match_id"], data["room"], data.get("slot"), data.get("player_name"),
         data.get("mode"), data.get("log_data"), data.get("summary"),
         data.get("context"), data.get("ip_hash")),
    )
    await _db.commit()
    return cursor.lastrowid

async def set_session_ended(match_id: str, slot: int | None, ended_by: str) -> None:
    """Mark how a session ended."""
    if slot is not None:
        await _db.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND slot=?",
            (ended_by, match_id, slot))
    else:
        await _db.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=?",
            (ended_by, match_id))
    await _db.commit()

async def insert_client_event(data: dict) -> int:
    """Insert a client event and return row ID."""
    cursor = await _db.execute(
        """INSERT INTO client_events (type, message, meta, room, slot, ip_hash, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (data["type"], data.get("message"), data.get("meta"),
         data.get("room"), data.get("slot"), data.get("ip_hash"),
         data.get("user_agent")),
    )
    await _db.commit()
    return cursor.lastrowid
```

Add a general-purpose write helper:

```python
async def execute_write(sql: str, params: tuple) -> None:
    """Run a write query (DELETE, UPDATE) and commit."""
    assert _db is not None, "Database not initialized"
    await _db.execute(sql, params)
    await _db.commit()
```

The existing `insert_session_log()` is removed — replaced by `upsert_session_log()`.

---

## Client Changes

### `netplay-lockstep.js`

- Increase `SYNC_LOG_MAX` from 5,000 to 10,000
- Add `_getStructuredEntries()` — reads `_syncLogRing` and returns ordered array of `{seq, t, f, msg}` objects (same traversal as `exportSyncLog()` but structured)
- Add `_flushSyncLog()`:

```javascript
const _flushSyncLog = () => {
  if (!KNState.matchId || !socket?.connected) return;
  socket.emit('session-log', {
    matchId: KNState.matchId,
    slot: window._playerSlot,
    playerName: localStorage.getItem('kaillera-name') || 'Player',
    mode: 'lockstep',
    entries: _getStructuredEntries(),
    summary: {
      desyncs: KNState.sessionStats.desyncs,
      stalls: KNState.sessionStats.stalls,
      reconnects: KNState.sessionStats.reconnects,
      frames: _frameNum,
      duration_sec: Math.round((performance.now() - _startTime) / 1000),
      peers: Object.keys(KNState.peers || {}).length,
    },
    context: {
      ua: navigator.userAgent,
      mobile: /Mobi|Android/i.test(navigator.userAgent),
      forkedCore: !!window.Module?._kn_set_deterministic,
    },
  });
};
```

- Start `_flushInterval = setInterval(_flushSyncLog, 30000)` when lockstep starts
- Call `_flushSyncLog()` one final time in `stop()` before cleanup
- Clear `_flushInterval` in `stop()`
- `exportSyncLog()` remains for the manual "Dump Logs" toolbar button (downloads CSV locally)

### `play.js`

- **Remove:** `uploadSyncLogs()` function
- **Remove:** `pagehide` sync log capture (sendBeacon to `/api/sync-logs` + localStorage backup)
- **Remove:** Pending log recovery on page load (the `kn-pending-log` localStorage check)
- **Keep:** `pagehide` handler that sends `'leaving'` to peers
- **Keep:** `KNEvent()` for client event reporting (it still calls `/api/client-event`)
- **Add:** Store `KNState.matchId` from `game-started` event payload

### `shared.js`

- `KNEvent()` unchanged — still sends to `/api/client-event` via sendBeacon. The server endpoint changes underneath (file → DB).

### `kn-state.js`

- Add `matchId: null` to the KNState initial state

### `lobby.js`

- **Remove:** Pending sync log recovery on page load (`kn-pending-log` localStorage check)

---

## Server Changes

### New Socket.IO event: `session-log`

**Location:** `server/src/api/signaling.py`

```python
@sio.on("session-log")
async def session_log(sid: str, data: dict) -> None:
    if not check(sid, "session-log"): return
    entry = _sid_to_room.get(sid)
    if not entry: return
    room_id = entry[0]
    room = rooms.get(room_id)
    if not room or not room.match_id: return

    match_id = data.get("matchId")
    if match_id != room.match_id: return  # reject stale flushes

    await db.upsert_session_log({
        "match_id": match_id,
        "room": room_id,
        "slot": data.get("slot"),
        "player_name": str(data.get("playerName", ""))[:32],
        "mode": data.get("mode"),
        "log_data": json.dumps(data.get("entries", []))[:_SESSION_LOG_MAX],
        "summary": json.dumps(data.get("summary", {})),
        "context": json.dumps(data.get("context", {})),
        "ip_hash": _ip_hash_for_sid(sid),
    })
```

`_SESSION_LOG_MAX` caps `log_data` at 2MB to prevent abuse and stay within the Socket.IO `max_http_buffer_size` (currently 4MB in `signaling.py`). A 10,000-entry structured log is typically ~500KB-1MB.

**IP hashing helper** — add to `signaling.py`:

```python
def _ip_hash_for_sid(sid: str) -> str:
    """Hash the IP address for a Socket.IO sid."""
    from src.ratelimit import _sid_ip
    ip = _sid_ip.get(sid, "unknown")
    return hashlib.sha256(f"{ip}{_IP_HASH_SALT}".encode()).hexdigest()[:16]
```

Move `_IP_HASH_SALT` and the `_ip_hash_for_sid()` helper to `ratelimit.py` (which already owns `_sid_ip`). Both `app.py` and `signaling.py` import from `ratelimit.py`, so no circular dependency risk. `app.py`'s feedback endpoint calls `ratelimit.ip_hash(ip_string)` instead of inlining the hash.

**Rate limit:** `"session-log": (2, 30)` — 2 per 30 seconds per socket.

### `start-game` handler modification

Generate and store a match ID:

```python
import uuid
room.match_id = str(uuid.uuid4())
```

Include `matchId` in the `game-started` broadcast payload so the client can key its flushes.

### Disconnect / leave / end-game handlers

The `_leave()` function in `signaling.py` handles both disconnects and explicit leaves. It resolves the player's slot from the Room object before deleting them. The `set_session_ended` call must happen **before** the player is removed from the room, while their slot is still known.

**In `_leave()`**, before the player removal logic:

```python
# Mark session log ended — must happen before slot is deleted
if room.match_id and slot is not None:
    ended_by = "disconnect"  # default; overridden below for explicit leave
    await db.set_session_ended(room.match_id, slot, ended_by)
```

The `ended_by` value is determined by the caller:
- `on_disconnect` calls `_leave()` → `ended_by = "disconnect"`
- `leave-room` handler calls `_leave()` → `ended_by = "leave"`

Add a parameter to `_leave()` (e.g., `reason: str = "disconnect"`) to pass this through.

**In `end-game` handler** (separate from `_leave`):

```python
if room.match_id:
    await db.set_session_ended(room.match_id, None, "game-end")  # marks all players
    room.match_id = None  # clear to prevent stale flushes
```

### `Room` dataclass addition

Add `match_id: str | None = None` to the `Room` dataclass. This is distinct from the existing `game_id` field (which stores the game identifier like `"ssb64"`). `match_id` is a per-match UUID generated on `start-game` and cleared on `end-game`.

Only call `set_session_ended` when `room.match_id` is set (a match is active).

### `/api/client-event` modification

Replace file write with `db.insert_client_event()`. Remove `_ERROR_LOG_DIR`, file creation logic, and related constants. Keep rate limiting, HMAC validation (`verify_upload_token`), type validation, and size limits. The upload token generation (`make_upload_token`) and emission on room join remain unchanged — they're still needed for `/api/client-event` authentication.

### Remove `/api/sync-logs` endpoint

Delete the entire sync log upload endpoint and related code (`_SYNC_LOG_DIR`, `_SYNC_LOG_MAX_SIZE`, HMAC verification for sync logs).

### Remove `cleanup_old_logs()` background task

Replace with DB retention cleanup:

```python
async def cleanup_old_data() -> None:
    """Delete session logs and client events older than retention period."""
    while True:
        await asyncio.sleep(86400)  # daily
        days = int(os.environ.get("LOG_RETENTION_DAYS", "14"))
        await db.execute_write(
            "DELETE FROM session_logs WHERE created_at < datetime('now', ?)",
            (f"-{days} days",))
        await db.execute_write(
            "DELETE FROM client_events WHERE created_at < datetime('now', ?)",
            (f"-{days} days",))
```

---

## Admin API Changes

### Remove file-based endpoints

Remove all of:
- `GET /admin/api/logs` (file listing)
- `GET /admin/api/logs/{filename}` (file content)
- `POST /admin/api/logs/{filename}/pin` (pin)
- `DELETE /admin/api/logs/{filename}/pin` (unpin)
- `DELETE /admin/api/logs/{filename}` (delete file)
- `GET /admin/api/errors` (file listing)
- `GET /admin/api/errors/{filename}` (file content)
- `DELETE /admin/api/errors/{filename}` (delete file)
- `POST /admin/api/cleanup` (file cleanup)

### New endpoints

**`GET /admin/api/session-logs`**

Query params: `room`, `match_id`, `mode`, `has_desyncs` (bool), `days` (default 30), `limit` (default 50, max 200), `offset`

Response:
```json
{
  "total": 42,
  "entries": [{
    "id": 1,
    "match_id": "uuid",
    "room": "ABC123",
    "slot": 0,
    "player_name": "Agent 21",
    "mode": "lockstep",
    "summary": {"desyncs": 2, "stalls": 0, ...},
    "ended_by": "game-end",
    "created_at": "2026-04-01 12:00:00",
    "updated_at": "2026-04-01 12:05:00"
  }]
}
```

Note: List endpoint returns `summary` but NOT `log_data` (which can be large). Use the detail endpoint for full logs.

**`GET /admin/api/session-logs/{id}`**

Returns single entry with full `log_data`, `summary`, and `context`.

**`GET /admin/api/client-events`**

Query params: `type`, `room`, `days` (default 30), `limit` (default 50, max 200), `offset`

Response: same pattern as feedback list.

**`GET /admin/api/client-events/{id}`**

Returns single event with full meta.

---

## Admin Page Changes

### Sync Logs tab

Rewired to `GET /admin/api/session-logs`. Display:
- Grouped by room/match_id
- Each row shows: slot, player name, mode, summary stats (desyncs/stalls/reconnects), duration, ended_by, time ago
- Click to view full structured log in the viewer panel (fetches from detail endpoint)
- "Copy Room JSON" copies all session logs for that game as JSON

Remove: pin/unpin UI, file-based cleanup button, source badges (beacon/recovery).

### Client Events tab

Rewired to `GET /admin/api/client-events`. Same UI pattern, different data source. Remove file-based deletion.

### Stats row

Update stats endpoint to report counts from DB instead of file counts:
- "Session Logs" count from `SELECT COUNT(*) FROM session_logs`
- "Client Events" count from `SELECT COUNT(*) FROM client_events`

Remove: "Log Files", "Log Size" stats (no more files).

---

## PostHog Integration

### Dependency

`posthog-python` added to `pyproject.toml`. Optional — all PostHog calls are no-ops if `POSTHOG_API_KEY` env var is unset.

### Initialization

In `db.py` or a new `analytics.py` module:

```python
import posthog

def init_posthog():
    key = os.environ.get("POSTHOG_API_KEY")
    if not key:
        log.info("PostHog disabled (POSTHOG_API_KEY not set)")
        return
    posthog.project_api_key = key
    posthog.host = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com")

def capture_session_ended(persistent_id, properties):
    if not posthog.project_api_key: return
    posthog.capture(distinct_id=persistent_id, event="session_ended", properties=properties)
```

### Event

Fired when `ended_by` is set on a session log. Properties:

```python
{
    "room": room_id,
    "mode": mode,
    "duration_sec": summary.get("duration_sec", 0),
    "desyncs": summary.get("desyncs", 0),
    "stalls": summary.get("stalls", 0),
    "reconnects": summary.get("reconnects", 0),
    "peers": summary.get("peers", 0),
    "ended_by": ended_by,
    "frames": summary.get("frames", 0),
}
```

`distinct_id` uses the player's `persistentId` (already tracked in the Room/Player objects from the join flow). For `end-game` (which marks all players), iterate `room.players` and fire one PostHog event per player with their individual `persistentId`.

---

## File Changes

### New Files

| File | Purpose |
|---|---|
| `server/alembic/versions/0002_session_logging.py` | Migration: recreate session_logs, create client_events |
| `server/src/analytics.py` | PostHog wrapper (init + capture helpers) |

### Modified Files

| File | Change |
|---|---|
| `server/src/db.py` | Add `upsert_session_log()`, `set_session_ended()`, `insert_client_event()`. Remove `insert_session_log()`. |
| `server/src/api/signaling.py` | Add `session-log` handler, `match_id` on Room, set `ended_by` on disconnect/leave/end-game |
| `server/src/api/app.py` | Replace `/api/client-event` file write with DB insert. Remove `/api/sync-logs`. Remove file-based admin endpoints. Add new DB-backed admin endpoints. Remove `cleanup_old_logs()`, add `cleanup_old_data()`. |
| `server/src/main.py` | Import analytics, call `init_posthog()` in lifespan |
| `server/src/ratelimit.py` | Add `"session-log": (2, 30)` rate limit |
| `server/pyproject.toml` | Add `posthog` dependency |
| `web/static/netplay-lockstep.js` | Increase buffer to 10K, add `_flushSyncLog()` + interval |
| `web/static/play.js` | Remove `uploadSyncLogs()`, remove pagehide log capture, remove log recovery, store `matchId` |
| `web/static/kn-state.js` | Add `matchId: null` |
| `web/static/lobby.js` | Remove pending log recovery |
| `web/static/admin.js` | Rewire Sync Logs + Client Events tabs to DB endpoints |
| `web/admin.html` | Update tab content structure, remove pin/cleanup UI |
| `docker-compose.prod.yml` | Add `POSTHOG_API_KEY` env var |

### Removed

| What | Where |
|---|---|
| `/api/sync-logs` endpoint | `app.py` |
| `_SYNC_LOG_DIR`, `_SYNC_LOG_MAX_SIZE` | `app.py` |
| File-based admin log endpoints | `app.py` |
| `_pinned_set()`, `_save_pinned()` | `app.py` |
| `cleanup_old_logs()` | `app.py` |
| `uploadSyncLogs()` | `play.js` |
| `pagehide` sync log capture | `play.js` |
| Pending log recovery | `play.js`, `lobby.js` |
| `logs/sync/` directory usage | server-wide |
| `logs/errors/` directory usage | server-wide |

---

## Security

| Threat | Mitigation |
|---|---|
| Oversized log payloads | `_SESSION_LOG_MAX` caps `log_data` at 2MB (within 4MB Socket.IO buffer). Rate limit 2/30s. |
| Spoofed game IDs | Server validates `matchId` matches `room.match_id` |
| Flood attacks | Per-socket rate limiting on `session-log` event |
| SQL injection | Parameterized queries via aiosqlite |
| Stale flushes after game end | Handler checks `room.match_id` is set and matches |

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `posthog` | pin exact | PostHog Python SDK (optional, no-op without API key) |

---

## What This Spec Does NOT Cover

- Streaming mode session logs (different code path, can reuse same infrastructure later)
- Log export/download from admin UI (can be added — data is in DB)
- PostHog per-event tracking (summary only for now)
- Migration of historical file-based logs to DB (clean break — old files can be archived manually)
