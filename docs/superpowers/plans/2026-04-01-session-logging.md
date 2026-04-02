# Session Logging System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unreliable end-of-session log dumps with continuous Socket.IO streaming to SQLite, migrate client events from files to DB, add PostHog session summaries, and remove all file-based logging.

**Architecture:** Client flushes full 10K sync log ring buffer as structured JSON every 30s via Socket.IO. Server upserts into SQLite by (match_id, slot). On disconnect/leave/game-end, server marks `ended_by` and fires PostHog event. Admin page reads from DB instead of files. File-based logging removed entirely.

**Tech Stack:** Python (FastAPI, aiosqlite, Alembic, posthog-python), vanilla JS (IIFE), SQLite

**Spec:** `docs/superpowers/specs/2026-04-01-session-logging-design.md`

---

## Chunk 1: Database + Dependencies

### Task 1: Add posthog dependency

**Files:**
- Modify: `server/pyproject.toml`

- [ ] **Step 1: Add posthog to dependencies**

In `server/pyproject.toml`, add to the `dependencies` list after the existing `sqlalchemy` entry:

```toml
    "posthog==3.11.0",
```

- [ ] **Step 2: Install**

Run: `cd /Users/kazon/kaillera-next/server && pip install -e .`

- [ ] **Step 3: Commit**

```bash
git add server/pyproject.toml
git commit -m "feat(session-logging): add posthog dependency"
```

---

### Task 2: Alembic migration for new schema

**Files:**
- Create: `server/alembic/versions/0002_session_logging.py`

- [ ] **Step 1: Create migration**

Create `server/alembic/versions/0002_session_logging.py`:

```python
"""Session logging schema — recreate session_logs with structured JSON, add client_events.

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-01
"""

from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("session_logs")
    op.create_table(
        "session_logs",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("match_id", sa.Text, nullable=False),
        sa.Column("room", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer),
        sa.Column("player_name", sa.Text),
        sa.Column("mode", sa.Text),
        sa.Column("log_data", sa.Text),       # JSON
        sa.Column("summary", sa.Text),         # JSON
        sa.Column("context", sa.Text),         # JSON
        sa.Column("ended_by", sa.Text),
        sa.Column("ip_hash", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
        sa.Column("updated_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_index("idx_session_logs_game_slot", "session_logs", ["match_id", "slot"], unique=True)
    op.create_table(
        "client_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("type", sa.Text, nullable=False),
        sa.Column("message", sa.Text),
        sa.Column("meta", sa.Text),            # JSON
        sa.Column("room", sa.Text),
        sa.Column("slot", sa.Integer),
        sa.Column("ip_hash", sa.Text),
        sa.Column("user_agent", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )


def downgrade() -> None:
    op.drop_table("client_events")
    op.drop_index("idx_session_logs_game_slot", "session_logs")
    op.drop_table("session_logs")
    # Recreate old schema
    op.create_table(
        "session_logs",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("room", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer),
        sa.Column("player_name", sa.Text),
        sa.Column("mode", sa.Text),
        sa.Column("source", sa.Text),
        sa.Column("sync_log", sa.Text),
        sa.Column("context", sa.Text),
        sa.Column("ip_hash", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
```

- [ ] **Step 2: Verify migration runs**

Run: `cd /Users/kazon/kaillera-next/server && python -c "from src.db import _run_migrations; import tempfile, os; d=tempfile.mkdtemp(); p=os.path.join(d,'t.db'); _run_migrations(p); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add server/alembic/versions/0002_session_logging.py
git commit -m "feat(session-logging): add migration for structured session_logs and client_events tables"
```

---

### Task 3: Update db.py with new functions

**Files:**
- Modify: `server/src/db.py`

- [ ] **Step 1: Replace `insert_session_log()` with new functions**

In `server/src/db.py`, replace the `insert_session_log()` function (lines 78-96) with:

```python
async def upsert_session_log(data: dict) -> int:
    """Insert or update a session log by (match_id, slot). Returns row ID."""
    assert _db is not None, "Database not initialized — call init_db() first"
    cursor = await _db.execute(
        """INSERT INTO session_logs (match_id, room, slot, player_name, mode, log_data, summary, context, ip_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(match_id, slot) DO UPDATE SET
             log_data=excluded.log_data, summary=excluded.summary,
             context=excluded.context, updated_at=datetime('now')""",
        (
            data["match_id"],
            data["room"],
            data.get("slot"),
            data.get("player_name"),
            data.get("mode"),
            data.get("log_data"),
            data.get("summary"),
            data.get("context"),
            data.get("ip_hash"),
        ),
    )
    await _db.commit()
    return cursor.lastrowid


async def set_session_ended(match_id: str, slot: int | None, ended_by: str) -> None:
    """Mark how a session ended."""
    assert _db is not None, "Database not initialized — call init_db() first"
    if slot is not None:
        await _db.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND slot=?",
            (ended_by, match_id, slot),
        )
    else:
        await _db.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=?",
            (ended_by, match_id),
        )
    await _db.commit()


async def insert_client_event(data: dict) -> int:
    """Insert a client event and return row ID."""
    assert _db is not None, "Database not initialized — call init_db() first"
    cursor = await _db.execute(
        """INSERT INTO client_events (type, message, meta, room, slot, ip_hash, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            data["type"],
            data.get("message"),
            data.get("meta"),
            data.get("room"),
            data.get("slot"),
            data.get("ip_hash"),
            data.get("user_agent"),
        ),
    )
    await _db.commit()
    return cursor.lastrowid


async def execute_write(sql: str, params: tuple) -> None:
    """Run a write query (DELETE, UPDATE) and commit."""
    assert _db is not None, "Database not initialized — call init_db() first"
    await _db.execute(sql, params)
    await _db.commit()
```

- [ ] **Step 2: Update test_db.py for new schema**

Update `tests/test_db.py` — replace the `test_insert_feedback` helper's sibling test with a test for the new upsert:

Add after existing tests:

```python
def test_upsert_session_log(tmp_db):
    """upsert_session_log inserts then updates on conflict."""
    asyncio.run(_run_upsert_session_log(tmp_db))


async def _run_upsert_session_log(tmp_db):
    from src.db import close_db, init_db, query, upsert_session_log

    await init_db(tmp_db)
    # First insert
    row_id = await upsert_session_log({
        "match_id": "test-match-1",
        "room": "ABC123",
        "slot": 0,
        "player_name": "Player 1",
        "mode": "lockstep",
        "log_data": '[{"seq":0,"t":1.0,"f":1,"msg":"test"}]',
        "summary": '{"desyncs":0}',
        "context": '{"ua":"test"}',
        "ip_hash": "abc",
    })
    assert row_id >= 1

    # Upsert same (match_id, slot) — should update
    await upsert_session_log({
        "match_id": "test-match-1",
        "room": "ABC123",
        "slot": 0,
        "player_name": "Player 1",
        "mode": "lockstep",
        "log_data": '[{"seq":0,"t":1.0,"f":1,"msg":"updated"}]',
        "summary": '{"desyncs":1}',
        "context": '{"ua":"test"}',
        "ip_hash": "abc",
    })

    rows = await query("SELECT * FROM session_logs WHERE match_id='test-match-1' AND slot=0", ())
    assert len(rows) == 1  # still one row, not two
    assert '"updated"' in rows[0]["log_data"]
    assert '"desyncs": 1' in rows[0]["summary"] or '"desyncs":1' in rows[0]["summary"]
    await close_db()


def test_insert_client_event(tmp_db):
    """insert_client_event stores a row."""
    asyncio.run(_run_insert_client_event(tmp_db))


async def _run_insert_client_event(tmp_db):
    from src.db import close_db, init_db, insert_client_event, query

    await init_db(tmp_db)
    row_id = await insert_client_event({
        "type": "desync",
        "message": "test desync",
        "meta": '{"frame":100}',
        "room": "ABC123",
        "slot": 0,
        "ip_hash": "def",
        "user_agent": "TestBrowser/1.0",
    })
    assert row_id >= 1
    rows = await query("SELECT * FROM client_events WHERE id=?", (row_id,))
    assert rows[0]["type"] == "desync"
    await close_db()


def test_set_session_ended(tmp_db):
    """set_session_ended updates the ended_by field."""
    asyncio.run(_run_set_session_ended(tmp_db))


async def _run_set_session_ended(tmp_db):
    from src.db import close_db, init_db, query, set_session_ended, upsert_session_log

    await init_db(tmp_db)
    await upsert_session_log({
        "match_id": "end-test-1",
        "room": "XYZ",
        "slot": 0,
        "player_name": "P1",
        "mode": "lockstep",
        "log_data": "[]",
        "summary": "{}",
        "context": "{}",
        "ip_hash": "abc",
    })
    # Mark single slot ended
    await set_session_ended("end-test-1", 0, "disconnect")
    rows = await query("SELECT ended_by FROM session_logs WHERE match_id='end-test-1' AND slot=0", ())
    assert rows[0]["ended_by"] == "disconnect"

    # Mark all slots ended (slot=None)
    await upsert_session_log({
        "match_id": "end-test-1",
        "room": "XYZ",
        "slot": 1,
        "player_name": "P2",
        "mode": "lockstep",
        "log_data": "[]",
        "summary": "{}",
        "context": "{}",
        "ip_hash": "def",
    })
    await set_session_ended("end-test-1", None, "game-end")
    rows = await query("SELECT ended_by FROM session_logs WHERE match_id='end-test-1'", ())
    assert all(r["ended_by"] == "game-end" for r in rows)
    await close_db()
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/kazon/kaillera-next && python -m pytest tests/test_db.py -v`
Expected: All tests PASS (including new upsert + client_event tests)

- [ ] **Step 4: Commit**

```bash
git add server/src/db.py tests/test_db.py
git commit -m "feat(session-logging): update db.py with upsert, set_session_ended, insert_client_event, execute_write"
```

---

### Task 4: Create analytics.py (PostHog wrapper)

**Files:**
- Create: `server/src/analytics.py`

- [ ] **Step 1: Create analytics module**

Create `server/src/analytics.py`:

```python
"""PostHog analytics wrapper — optional, no-op if POSTHOG_API_KEY is unset."""

from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

_enabled = False


def init_posthog() -> None:
    """Initialize PostHog SDK. No-op if POSTHOG_API_KEY env var is not set."""
    global _enabled
    key = os.environ.get("POSTHOG_API_KEY")
    if not key:
        log.info("PostHog disabled (POSTHOG_API_KEY not set)")
        return
    import posthog

    posthog.project_api_key = key
    posthog.host = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com")
    _enabled = True
    log.info("PostHog enabled (host: %s)", posthog.host)


def capture_session_ended(persistent_id: str, properties: dict) -> None:
    """Fire a session_ended event to PostHog. No-op if disabled."""
    if not _enabled:
        return
    import posthog

    posthog.capture(distinct_id=persistent_id, event="session_ended", properties=properties)
```

- [ ] **Step 2: Add PostHog init to main.py lifespan**

In `server/src/main.py`, add import:

```python
from src import analytics
```

In the `lifespan()` function, add `analytics.init_posthog()` after `await db.init_db()`:

```python
    await db.init_db()
    analytics.init_posthog()
```

- [ ] **Step 3: Commit**

```bash
git add server/src/analytics.py server/src/main.py
git commit -m "feat(session-logging): add PostHog analytics wrapper"
```

---

### Task 5: Move IP hash to ratelimit.py

**Files:**
- Modify: `server/src/ratelimit.py`
- Modify: `server/src/api/app.py`

- [ ] **Step 1: Add IP hash functions to ratelimit.py**

At the top of `server/src/ratelimit.py`, add `hashlib` import:

```python
import hashlib
```

Add after the existing `_WARN_INTERVAL` constant:

```python
_IP_HASH_SALT = os.environ.get("IP_HASH_SALT", "")
if not _IP_HASH_SALT:
    import secrets as _secrets

    _IP_HASH_SALT = _secrets.token_hex(16)
    log.warning("IP_HASH_SALT not set — using random salt (rate correlation won't survive restarts)")


def ip_hash(ip: str) -> str:
    """Hash an IP address for storage. Does not store raw IPs."""
    return hashlib.sha256(f"{ip}{_IP_HASH_SALT}".encode()).hexdigest()[:16]


def ip_hash_for_sid(sid: str) -> str:
    """Hash the IP address associated with a Socket.IO sid."""
    ip = _sid_ip.get(sid, "unknown")
    return ip_hash(ip)
```

- [ ] **Step 2: Update app.py to use ratelimit.ip_hash**

In `server/src/api/app.py`:

1. Remove the `_IP_HASH_SALT` block (the module-level constant + secrets import + warning). This was around line 75-80.

2. Add `ip_hash` to the existing ratelimit import:

Change from:
```python
from src.ratelimit import check_ip
```
to:
```python
from src.ratelimit import check_ip, ip_hash
```

3. In the `submit_feedback` endpoint, replace the inline hash:
```python
        ip_hash = hashlib.sha256(f"{ip}{_IP_HASH_SALT}".encode()).hexdigest()[:16]
```
with:
```python
        hashed_ip = ip_hash(_client_ip(request))
```

And update the `insert_feedback` call to use `"ip_hash": hashed_ip`.

- [ ] **Step 3: Verify ruff passes**

Run: `cd /Users/kazon/kaillera-next/server && python -m ruff check src/ratelimit.py src/api/app.py`

- [ ] **Step 4: Commit**

```bash
git add server/src/ratelimit.py server/src/api/app.py
git commit -m "refactor: move IP hashing to ratelimit.py for shared use"
```

---

## Chunk 2: Server-Side Session Log Streaming

### Task 6: Add session-log Socket.IO handler + match_id to Room

**Files:**
- Modify: `server/src/api/signaling.py`
- Modify: `server/src/ratelimit.py`

- [ ] **Step 1: Add rate limit for session-log**

In `server/src/ratelimit.py`, add to `_LIMITS` dict:

```python
"session-log": (2, 30),  # 2 per 30 seconds per socket
```

Also remove the now-obsolete `"sync-logs"` entry from `_LIMITS`:

```python
"sync-logs": (10, 60),  # DELETE THIS LINE
```

- [ ] **Step 2: Add match_id to Room dataclass**

In `server/src/api/signaling.py`, add to the `Room` dataclass (after `device_types` field, around line 145):

```python
    match_id: str | None = None  # per-match UUID, set on start-game, cleared on end-game
```

- [ ] **Step 3: Add imports to signaling.py**

Add at the top of `server/src/api/signaling.py`:

```python
import json
import uuid

from src import db
from src import analytics
from src.ratelimit import ip_hash_for_sid
```

Note: `json` may already be imported — check first. `hashlib` is already imported.

- [ ] **Step 4: Add session-log handler**

Add after the existing `debug_logs` handler (around line 829), before the end of the file:

```python
_SESSION_LOG_MAX = 2 * 1024 * 1024  # 2MB cap for log_data


@sio.on("session-log")
async def session_log_handler(sid: str, data: dict) -> None:
    """Receive periodic sync log flush from client. Upserts into session_logs table."""
    if not check(sid, "session-log"):
        return
    entry = _sid_to_room.get(sid)
    if not entry:
        return
    session_id, player_id, is_spectator = entry
    if is_spectator:
        return

    room = rooms.get(session_id)
    if not room or not room.match_id:
        return

    match_id = data.get("matchId")
    if not match_id or match_id != room.match_id:
        return  # reject stale or spoofed flushes

    log_data_str = json.dumps(data.get("entries", []))
    if len(log_data_str) > _SESSION_LOG_MAX:
        log_data_str = log_data_str[:_SESSION_LOG_MAX]

    await db.upsert_session_log({
        "match_id": match_id,
        "room": session_id,
        "slot": data.get("slot"),
        "player_name": str(data.get("playerName", ""))[:32],
        "mode": data.get("mode"),
        "log_data": log_data_str,
        "summary": json.dumps(data.get("summary", {})),
        "context": json.dumps(data.get("context", {})),
        "ip_hash": ip_hash_for_sid(sid),
    })
```

- [ ] **Step 5: Modify start-game handler to generate match_id**

In the `start_game` function (around line 570), after `room.mode = mode`, add:

```python
    room.match_id = str(uuid.uuid4())
```

And update the `game-started` emit payload to include `matchId`:

```python
    await sio.emit(
        "game-started",
        {
            "mode": room.mode,
            "resyncEnabled": payload.resyncEnabled,
            "romHash": room.rom_hash,
            "matchId": room.match_id,
        },
        room=session_id,
    )
```

- [ ] **Step 6: Modify end-game handler to mark sessions ended**

In the `end_game` function (around line 590), before `room.status = "lobby"`, add:

```python
    if room.match_id:
        await db.set_session_ended(room.match_id, None, "game-end")
        # Fire PostHog event for each player
        for pid in room.players:
            analytics.capture_session_ended(pid, {
                "room": session_id,
                "mode": room.mode,
                "ended_by": "game-end",
            })
        room.match_id = None
```

- [ ] **Step 7: Modify _leave() to mark session ended with reason**

In the `_leave()` function (line 223), add a `reason` parameter:

Change the signature from:
```python
async def _leave(sid: str) -> None:
```
to:
```python
async def _leave(sid: str, reason: str = "disconnect") -> None:
```

BEFORE `room.players.pop(player_id, None)` (line 237), add the session-ended block. This must go before the pop so the player data is still accessible:

```python
    if not is_spectator:
        # Mark session log ended before removing the player
        rm_slot_for_log = None
        for s, pid in room.slots.items():
            if pid == player_id:
                rm_slot_for_log = s
                break
        if room.match_id and rm_slot_for_log is not None:
            await db.set_session_ended(room.match_id, rm_slot_for_log, reason)
            analytics.capture_session_ended(player_id, {
                "room": session_id,
                "mode": room.mode,
                "ended_by": reason,
            })
```

Note: `player_id` IS the persistent ID (it's the dict key in `room.players`). No need to look up a nested field.

- [ ] **Step 8: Update leave-room handler to pass reason**

Find the `leave_room` handler (search for `@sio.on("leave-room")`). It calls `_leave(sid)`. Change to `_leave(sid, reason="leave")`.

- [ ] **Step 9: Commit**

```bash
git add server/src/api/signaling.py server/src/ratelimit.py
git commit -m "feat(session-logging): add session-log Socket.IO handler, match_id, ended_by tracking, PostHog events"
```

---

## Chunk 3: Client-Side Changes

### Task 7: Update kn-state.js and lobby.js

**Files:**
- Modify: `web/static/kn-state.js`
- Modify: `web/static/lobby.js`

- [ ] **Step 1: Add matchId to KNState**

In `web/static/kn-state.js`, add after the `sessionStats` line (line 26):

```javascript
    matchId: null, // signaling.js game-started → lockstep.js flush interval
```

- [ ] **Step 2: Remove pending log recovery from lobby.js**

In `web/static/lobby.js`, remove lines 6-26 (the entire `try` block that checks `kn-pending-log` from localStorage and sends to `/api/sync-logs`). The `_sg`, `_ss`, `_sr` destructuring on line 4 can stay if other code uses it.

- [ ] **Step 3: Commit**

```bash
git add web/static/kn-state.js web/static/lobby.js
git commit -m "feat(session-logging): add matchId to KNState, remove lobby log recovery"
```

---

### Task 8: Add flush interval to netplay-lockstep.js

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Increase SYNC_LOG_MAX**

In `web/static/netplay-lockstep.js`, change line 431:

From: `const SYNC_LOG_MAX = 5000;`
To: `const SYNC_LOG_MAX = 10000;`

- [ ] **Step 2: Add _startTime variable and set it when game starts**

Add near the other lockstep state variables (around line 430, near `_syncLogHead`):

```javascript
  let _startTime = 0;
```

Set it when the game starts. Find the line `setStatus('Connected -- game on!');` (around line 3140) and add after it:

```javascript
    _startTime = performance.now();
```

Also reset it in the `stop()` function alongside other state resets:

```javascript
    _startTime = 0;
```

- [ ] **Step 3: Add _getStructuredEntries() and _flushSyncLog()**

After the `exportSyncLog` function (around line 452), add:

```javascript
  const _getStructuredEntries = () => {
    const entries = [];
    const start = _syncLogCount < SYNC_LOG_MAX ? 0 : _syncLogHead;
    for (let i = 0; i < _syncLogCount; i++) {
      const e = _syncLogRing[(start + i) % SYNC_LOG_MAX];
      entries.push({ seq: e.seq, t: e.t, f: e.f, msg: e.msg });
    }
    return entries;
  };

  let _flushInterval = null;

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

- [ ] **Step 4: Start flush interval when lockstep starts**

Find where lockstep begins (search for where `_startTime` is set or where `Connected -- game on!` is logged). Add after that point:

```javascript
    _flushInterval = setInterval(_flushSyncLog, 30000);
```

- [ ] **Step 5: Final flush + cleanup in stop()**

Find the `stop()` function in the lockstep engine. At the top of `stop()`, before any cleanup:

```javascript
    _flushSyncLog();  // final flush
    if (_flushInterval) { clearInterval(_flushInterval); _flushInterval = null; }
```

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(session-logging): add 30s flush interval to lockstep engine"
```

---

### Task 9: Update play.js — remove old logging, store matchId

**Files:**
- Modify: `web/static/play.js`

- [ ] **Step 1: Store matchId from game-started event**

Find the `game-started` event handler in play.js (search for `socket.on('game-started'`). Add inside the handler:

```javascript
    KNState.matchId = data.matchId || null;
```

Also clear it in the `game-ended` handler:

```javascript
    KNState.matchId = null;
```

- [ ] **Step 2: Remove uploadSyncLogs() function**

Remove the entire `uploadSyncLogs` function (around lines 2441-2463 — the `const uploadSyncLogs = async (trigger) => { ... }` block).

- [ ] **Step 3: Remove all uploadSyncLogs() call sites**

Search for `uploadSyncLogs(` and remove all calls:
- In the `game-ended` handler: remove `uploadSyncLogs('game-ended')`
- In `leaveGame()`: remove `uploadSyncLogs('leave')`
- In the toolbar manual button: remove `uploadSyncLogs('manual')`

- [ ] **Step 4: Remove pagehide sync log capture**

In the `pagehide` handler (around line 181), remove the sync log capture section — everything from `// Capture sync logs before page unloads` through the `sendBeacon` call and the `KNEvent('session-end', ...)` call. Keep ONLY the peer `'leaving'` notification at the top of the handler.

The `pagehide` handler should look like:

```javascript
  window.addEventListener('pagehide', () => {
    // Notify peers this is intentional so they skip the 15s reconnect wait
    if (engine && KNState.peers) {
      for (const p of Object.values(KNState.peers)) {
        if (p.dc?.readyState === 'open') {
          try {
            p.dc.send('leaving');
          } catch (_) {}
        }
      }
    }
  });
```

- [ ] **Step 5: Remove pending log recovery**

Remove the pending log recovery block near the top of play.js (around lines 150-170 — the `try { const pending = _safeGet('localStorage', 'kn-pending-log'); ... }` block).

- [ ] **Step 6: Commit**

```bash
git add web/static/play.js
git commit -m "feat(session-logging): remove old sync log upload system, store matchId"
```

---

## Chunk 4: Server Cleanup + Admin Page

### Task 10: Remove file-based logging from app.py, migrate client-event to DB

**Files:**
- Modify: `server/src/api/app.py`
- Modify: `server/src/main.py`

- [ ] **Step 1: Remove file-based constants and functions**

In `server/src/api/app.py`, remove:
- `_SYNC_LOG_DIR` constant (line 64)
- `_SYNC_LOG_MAX_SIZE` constant (line 65)
- `_ERROR_LOG_DIR` constant (line 66)
- `_pinned_set()` function
- `_save_pinned()` function
- `cleanup_old_logs()` async function

- [ ] **Step 2: Remove /api/sync-logs endpoint**

Inside `create_app()`, remove the entire sync log upload section (`@app.post("/api/sync-logs")` and the `upload_sync_logs` function).

- [ ] **Step 3: Modify /api/client-event to write to DB**

In the `client_event` endpoint inside `create_app()`, replace the file write logic:

Remove:
```python
        _ERROR_LOG_DIR.mkdir(parents=True, exist_ok=True)
        (_ERROR_LOG_DIR / filename).write_text(json.dumps(data, indent=2))
```

Replace with:
```python
        hashed_ip = ip_hash(_client_ip(request))
        await db.insert_client_event({
            "type": evt_type,
            "message": msg,
            "meta": json.dumps(meta),
            "room": room,
            "slot": data.get("slot"),
            "ip_hash": hashed_ip,
            "user_agent": data.get("ua", ""),
        })
```

Remove the `filename` generation and `_rand4()` helper if no other code uses it. Keep rate limiting, HMAC validation, type validation, and size limits.

- [ ] **Step 4: Remove file-based admin endpoints**

Remove ALL of these endpoints from inside `create_app()`:
- `_safe_log_filename()` helper
- `_safe_error_filename()` helper
- `GET /admin/api/logs` (list)
- `GET /admin/api/logs/{filename}` (view)
- `POST /admin/api/logs/{filename}/pin` (pin)
- `DELETE /admin/api/logs/{filename}/pin` (unpin)
- `DELETE /admin/api/logs/{filename}` (delete)
- `POST /admin/api/cleanup`
- `GET /admin/api/errors` (list)
- `GET /admin/api/errors/{filename}` (view)
- `DELETE /admin/api/errors/{filename}` (delete)

- [ ] **Step 5: Add DB-backed admin endpoints**

Add inside `create_app()`, in the admin section:

```python
    # ── Admin session logs API ───────────────────────────────────────────

    @app.get("/admin/api/session-logs")
    async def admin_session_logs_list(request: Request) -> dict:
        _admin_auth(request)
        room = request.query_params.get("room")
        match_id = request.query_params.get("match_id")
        mode = request.query_params.get("mode")
        has_desyncs = request.query_params.get("has_desyncs")
        days = int(request.query_params.get("days", "30"))
        limit = min(int(request.query_params.get("limit", "50")), 200)
        offset = int(request.query_params.get("offset", "0"))

        conditions = ["created_at > datetime('now', ?)"]
        params: list = [f"-{days} days"]
        if room:
            conditions.append("room = ?")
            params.append(room)
        if match_id:
            conditions.append("match_id = ?")
            params.append(match_id)
        if mode and mode in ("lockstep", "streaming"):
            conditions.append("mode = ?")
            params.append(mode)
        if has_desyncs == "true":
            conditions.append("json_extract(summary, '$.desyncs') > 0")

        where = " AND ".join(conditions)
        total_rows = await db.query(f"SELECT COUNT(*) as cnt FROM session_logs WHERE {where}", tuple(params))
        total = total_rows[0]["cnt"] if total_rows else 0

        # List returns summary but NOT log_data (which can be large)
        params_with_paging = params + [limit, offset]
        entries = await db.query(
            f"SELECT id, match_id, room, slot, player_name, mode, summary, ended_by, created_at, updated_at FROM session_logs WHERE {where} ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            tuple(params_with_paging),
        )
        for entry in entries:
            if entry.get("summary") and isinstance(entry["summary"], str):
                try:
                    entry["summary"] = json.loads(entry["summary"])
                except (json.JSONDecodeError, TypeError):
                    pass
        return {"total": total, "entries": entries}

    @app.get("/admin/api/session-logs/{log_id}")
    async def admin_session_log_detail(request: Request, log_id: int) -> dict:
        _admin_auth(request)
        rows = await db.query("SELECT * FROM session_logs WHERE id = ?", (log_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Session log not found")
        entry = rows[0]
        for field in ("log_data", "summary", "context"):
            if entry.get(field) and isinstance(entry[field], str):
                try:
                    entry[field] = json.loads(entry[field])
                except (json.JSONDecodeError, TypeError):
                    pass
        return entry

    # ── Admin client events API ──────────────────────────────────────────

    @app.get("/admin/api/client-events")
    async def admin_client_events_list(request: Request) -> dict:
        _admin_auth(request)
        evt_type = request.query_params.get("type")
        room = request.query_params.get("room")
        days = int(request.query_params.get("days", "30"))
        limit = min(int(request.query_params.get("limit", "50")), 200)
        offset = int(request.query_params.get("offset", "0"))

        conditions = ["created_at > datetime('now', ?)"]
        params: list = [f"-{days} days"]
        if evt_type and evt_type in _VALID_EVENT_TYPES:
            conditions.append("type = ?")
            params.append(evt_type)
        if room:
            conditions.append("room = ?")
            params.append(room)

        where = " AND ".join(conditions)
        total_rows = await db.query(f"SELECT COUNT(*) as cnt FROM client_events WHERE {where}", tuple(params))
        total = total_rows[0]["cnt"] if total_rows else 0

        params_with_paging = params + [limit, offset]
        entries = await db.query(
            f"SELECT * FROM client_events WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            tuple(params_with_paging),
        )
        for entry in entries:
            if entry.get("meta") and isinstance(entry["meta"], str):
                try:
                    entry["meta"] = json.loads(entry["meta"])
                except (json.JSONDecodeError, TypeError):
                    pass
        return {"total": total, "entries": entries}

    @app.get("/admin/api/client-events/{event_id}")
    async def admin_client_event_detail(request: Request, event_id: int) -> dict:
        _admin_auth(request)
        rows = await db.query("SELECT * FROM client_events WHERE id = ?", (event_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Client event not found")
        entry = rows[0]
        if entry.get("meta") and isinstance(entry["meta"], str):
            try:
                entry["meta"] = json.loads(entry["meta"])
            except (json.JSONDecodeError, TypeError):
                pass
        return entry
```

- [ ] **Step 6: Update admin_stats endpoint**

Update the `admin_stats` function to query DB instead of files:

Replace the file-based stats with:
```python
        session_log_count = await db.query("SELECT COUNT(*) as cnt FROM session_logs", ())
        client_event_count = await db.query("SELECT COUNT(*) as cnt FROM client_events", ())
        feedback_count = await db.query("SELECT COUNT(*) as cnt FROM feedback", ())
```

Update the returned dict to use these DB counts instead of `log_files` and `error_files`. Remove `log_size_bytes`. The function also needs to be `async` if it isn't already.

- [ ] **Step 7: Add cleanup_old_data() background task**

Add to `app.py` (replacing the removed `cleanup_old_logs`):

```python
async def cleanup_old_data() -> None:
    """Background task: delete session logs and client events older than retention period."""
    while True:
        await asyncio.sleep(86400)  # daily
        try:
            days = int(os.environ.get("LOG_RETENTION_DAYS", "14"))
            await db.execute_write(
                "DELETE FROM session_logs WHERE created_at < datetime('now', ?)",
                (f"-{days} days",),
            )
            await db.execute_write(
                "DELETE FROM client_events WHERE created_at < datetime('now', ?)",
                (f"-{days} days",),
            )
            log.info("DB cleanup complete (retention: %d days)", days)
        except Exception as e:
            log.warning("DB cleanup error: %s", e)
```

- [ ] **Step 8: Update main.py to use new cleanup task**

In `server/src/main.py`, update the import:

Change: `from src.api.app import cleanup_old_logs, create_app`
To: `from src.api.app import cleanup_old_data, create_app`

In the lifespan, change:
`log_task = asyncio.create_task(cleanup_old_logs())`
to:
`log_task = asyncio.create_task(cleanup_old_data())`

- [ ] **Step 9: Update module docstring**

Update the docstring at the top of `app.py` to reflect the new endpoints and removed ones.

- [ ] **Step 10: Commit**

```bash
git add server/src/api/app.py server/src/main.py
git commit -m "feat(session-logging): migrate to DB-backed logging, remove file-based system"
```

---

### Task 11: Rewire admin page

**Files:**
- Modify: `web/admin.html`
- Modify: `web/static/admin.js`

- [ ] **Step 1: Update admin.html**

In `web/admin.html`:
- Remove the cleanup button (`#cleanup-btn`) from the Sync Logs tab header
- Rename `#log-groups` to `#session-log-list` for clarity
- Remove the `#no-logs` paragraph (replaced by `#no-session-logs`)
- Keep `#error-list` and `#no-errors` as-is (same IDs, new data source)

The tab-logs section should look like:
```html
      <div class="log-section" id="tab-logs">
        <div class="log-header">
          <h2>Session Logs</h2>
        </div>
        <div id="session-log-list"></div>
        <p id="no-session-logs" class="dim hidden">No session logs found.</p>
      </div>
```

- [ ] **Step 2: Rewrite admin.js — replace loadLogs and rendering**

Remove these functions entirely: `loadLogs`, `groupByRoom`, `renderLogs`, `viewLog`, `parseDiagStart`, `parseGameEvents`, `formatUserAgent`, `fetchLogContent`, `copyOneLog`, `copyRoomJson`, `pinLog`, `deleteLog`, `logContentCache`, `currentLogs`, `_currentViewerFilename`.

Replace with:

```javascript
  let currentSessionLogs = [];

  const loadSessionLogs = async () => {
    const res = await fetch('/admin/api/session-logs?days=30&limit=100', { headers: headers() });
    if (!res.ok) return;
    const data = await res.json();
    currentSessionLogs = data.entries || [];
    renderSessionLogs();
  };

  const renderSessionLogs = () => {
    const container = $('#session-log-list');
    const noLogs = $('#no-session-logs');
    if (!currentSessionLogs.length) {
      container.innerHTML = '';
      noLogs.classList.remove('hidden');
      return;
    }
    noLogs.classList.add('hidden');

    // Group by match_id
    const groups = {};
    for (const log of currentSessionLogs) {
      const key = log.match_id || 'unknown';
      if (!groups[key]) groups[key] = { room: log.room, logs: [] };
      groups[key].logs.push(log);
    }

    container.innerHTML = Object.entries(groups)
      .map(([matchId, { room, logs }]) => {
        const rows = logs.map((l) => {
          const s = l.summary || {};
          const duration = s.duration_sec ? `${Math.floor(s.duration_sec / 60)}m${s.duration_sec % 60}s` : '-';
          const issues = [
            s.desyncs ? `${s.desyncs} desync${s.desyncs > 1 ? 's' : ''}` : '',
            s.stalls ? `${s.stalls} stall${s.stalls > 1 ? 's' : ''}` : '',
            s.reconnects ? `${s.reconnects} reconnect${s.reconnects > 1 ? 's' : ''}` : '',
          ].filter(Boolean).join(', ') || 'clean';
          const endedColor = { 'game-end': '#2ecc71', disconnect: '#e74c3c', leave: '#f39c12' }[l.ended_by] || '#888';
          return `<tr data-session-log-id="${l.id}">
            <td>P${l.slot ?? '?'}</td>
            <td>${escapeHtml(l.player_name || '-')}</td>
            <td>${duration}</td>
            <td>${issues}</td>
            <td><span style="color:${endedColor}">${l.ended_by || 'active'}</span></td>
            <td title="${l.updated_at}">${l.updated_at ? timeAgo(new Date(l.updated_at + 'Z').getTime() / 1000) : '-'}</td>
          </tr>`;
        }).join('');

        return `<div class="room-group">
          <div class="room-header">
            <div class="room-info">
              <span class="room-code">${escapeHtml(room)}</span>
              <span class="room-meta">${logs.length} player${logs.length > 1 ? 's' : ''} &middot; ${logs[0].mode || 'unknown'}</span>
            </div>
          </div>
          <table>
            <thead><tr><th>Slot</th><th>Player</th><th>Duration</th><th>Issues</th><th>Ended</th><th>Updated</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      }).join('');
  };

  const viewSessionLog = async (id) => {
    const viewer = $('#log-viewer');
    const content = $('#viewer-content');
    const title = $('#viewer-title');
    const meta = $('#viewer-meta');
    title.textContent = `Session Log #${id}`;
    meta.innerHTML = '';
    content.textContent = 'Loading...';
    viewer.classList.remove('hidden');

    const res = await fetch(`/admin/api/session-logs/${id}`, { headers: headers() });
    if (!res.ok) { content.textContent = 'Error loading log'; return; }
    const data = await res.json();
    content.textContent = JSON.stringify(data, null, 2);
    viewer.scrollIntoView({ behavior: 'smooth' });
  };
```

- [ ] **Step 3: Rewrite admin.js — replace Client Events section**

Remove: `loadErrors`, `renderErrors`, `viewError`, `deleteError`, `copyError`, `copyRoomErrors`, `currentErrors`, `errorContentCache`.

Replace with:

```javascript
  let currentClientEvents = [];

  const loadClientEvents = async () => {
    const filterType = $('#error-type-filter')?.value || '';
    const params = new URLSearchParams({ days: '30', limit: '100' });
    if (filterType) params.set('type', filterType);
    const res = await fetch(`/admin/api/client-events?${params}`, { headers: headers() });
    if (!res.ok) return;
    const data = await res.json();
    currentClientEvents = data.entries || [];
    renderClientEvents();
  };

  const renderClientEvents = () => {
    const container = $('#error-list');
    const noErrors = $('#no-errors');
    if (!currentClientEvents.length) {
      container.innerHTML = '';
      noErrors.classList.remove('hidden');
      return;
    }
    noErrors.classList.add('hidden');

    container.innerHTML = currentClientEvents.map((e) => {
      const color = _typeColors[e.type] || '#999';
      return `<div class="feedback-card" data-event-id="${e.id}">
        <div class="feedback-header">
          <span class="source-badge" style="border-color:${color};color:${color}">${escapeHtml(e.type)}</span>
          <span class="feedback-date">${e.created_at ? timeAgo(new Date(e.created_at + 'Z').getTime() / 1000) : ''}</span>
        </div>
        <div class="feedback-message">${escapeHtml(e.message || '')}</div>
        ${e.room ? `<div class="feedback-meta">Room: ${escapeHtml(e.room)}</div>` : ''}
      </div>`;
    }).join('');
  };

  if ($('#error-type-filter')) {
    $('#error-type-filter').addEventListener('change', loadClientEvents);
  }
```

- [ ] **Step 4: Update loadStats and loadAll**

Replace `loadStats` content to use DB counts (the admin_stats endpoint will return DB counts after Task 10 updates it).

Update `loadAll`:
```javascript
  const loadAll = async () => {
    await loadStats();
    await loadSessionLogs();
    await loadClientEvents();
    await loadFeedback();
  };
```

- [ ] **Step 5: Update event delegation**

Replace `#log-groups` click handler with `#session-log-list`:

```javascript
  $('#session-log-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-session-log-id]');
    if (row) viewSessionLog(row.dataset.sessionLogId);
  });

  $('#error-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-event-id]');
    if (card) {
      const id = card.dataset.eventId;
      const viewer = $('#log-viewer');
      const evt = currentClientEvents.find((ev) => String(ev.id) === id);
      if (!evt) return;
      $('#viewer-title').textContent = `Event #${id} — ${evt.type}`;
      $('#viewer-meta').innerHTML = '';
      $('#viewer-content').textContent = JSON.stringify(evt, null, 2);
      viewer.classList.remove('hidden');
      viewer.scrollIntoView({ behavior: 'smooth' });
    }
  });
```

Remove the old `#log-groups` and `#error-list` click handlers, pin/cleanup button handlers.

- [ ] **Step 6: Commit**

```bash
git add web/admin.html web/static/admin.js
git commit -m "feat(session-logging): rewire admin page to read from SQLite"
```

---

### Task 12: Docker compose update

**Files:**
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add POSTHOG env vars and remove obsolete config**

Add to the `kaillera-next` service environment section:

```yaml
      - POSTHOG_API_KEY=${POSTHOG_API_KEY}
      - POSTHOG_HOST=${POSTHOG_HOST:-https://us.i.posthog.com}
```

Remove these now-obsolete env vars (file-based logging is gone):
- `SYNC_LOG_DIR=${SYNC_LOG_DIR}`
- `LOG_MAX_FILES=${LOG_MAX_FILES}`

Note: Keep `LOG_RETENTION_DAYS` — it's still used by the DB cleanup task.

- [ ] **Step 2: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(session-logging): add PostHog env vars, remove obsolete file-logging config"
```

---

### Task 13: End-to-end verification

- [ ] **Step 1: Run all db tests**

Run: `cd /Users/kazon/kaillera-next && python -m pytest tests/test_db.py -v`
Expected: All tests PASS

- [ ] **Step 2: Start server and verify**

Start dev server. Create a room, start a lockstep game. Wait 30+ seconds. Check server logs for `session-log` handler activity. Check the database:

```bash
sqlite3 data/kn.db "SELECT match_id, room, slot, json_extract(summary, '$.frames') as frames FROM session_logs"
```

- [ ] **Step 3: Verify admin page**

Visit `/admin.html`, check that:
- Sync Logs tab shows session logs from DB
- Client Events tab shows events from DB
- Feedback tab still works
- Stats row shows correct DB counts

- [ ] **Step 4: Verify game end marks sessions**

End the game and check:
```bash
sqlite3 data/kn.db "SELECT match_id, slot, ended_by FROM session_logs"
```
Expected: All rows show `ended_by = 'game-end'`
