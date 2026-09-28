# Off-box logs, Plan B: match registration and upload validation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every match in a `match_retention` row when it starts, refuse HTTP-fallback log uploads for matches that don't exist, belong to another room, or have closed, stop screenshots overwriting another player's slot, and make the old cleanup task run soon after boot.

**Architecture:** Migration `0004` creates `match_retention` with every column the spec defines (later PRs fill the retention/archive ones, so the table isn't altered again). `db.register_match` runs in `start-game` before the match is announced; `db.set_session_ended(match_id, None, …)` (game end) also stamps `ended_at`. `db.match_accepts_uploads(match_id, room)` is one indexed query with a 60 s in-process cache. The HTTP fallback calls it; the Socket.IO handlers already require the room's live match id and are unchanged except screenshots, which must now carry the sender's own slot.

**Tech Stack:** Python 3.11, FastAPI, python-socketio, aiosqlite / Cloudflare D1, pytest.

**Spec:** `docs/superpowers/specs/2026-09-25-offbox-log-storage-design.md` (§2 "Match registration and the retention record", §5 "Ingest validation", §8 item 2). This plan covers item 2 *except* the daily budgets, which are Plan C (they need `D1Backend` to surface `meta.rows_written`).

## Global Constraints

- Run Python from `server/`: `cd server && uv run --extra dev pytest ../tests/<file> -q -p no:cacheprovider`.
- New test files override the Playwright session fixture `_patch_browser_ssl` (see `tests/test_db_backends.py`) and run async code through `run_async` from `tests/db_test_support.py`.
- Upload window (spec §5), verbatim: accepted "within 30 min of `ended_at`, or within 4 h of `created_at` if `ended_at` is NULL", and never once `deleting_at` is set.
- Logging must never block a game: a failed `register_match` is logged at WARNING and `start-game` continues.
- Never edit an existing migration; `0004_match_retention.sql` is new.
- Conventional commit, PR title `feat(logs): register matches and validate log uploads against them`. End commits with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After opening the PR: Greptile has been silent since #38, so run the fallback review (`/code-review` high + an independent Opus reviewer), post it as "Fallback review (Greptile unavailable)", fix real findings, then merge with `gh pr merge N --squash` and check the Render deploy.

## Review Focus

1. **A match starts while D1 is down.** Expected: the game starts anyway; only HTTP-fallback uploads for that match are refused. Pinned in Task 2 (`test_start_game_survives_register_failure`).
2. **The HTTP fallback's last flush arrives after `end-game`** (the reason the fallback exists). Expected: accepted for 30 min after the end. Pinned in Task 1 (`test_uploads_accepted_until_30_min_after_end`).
3. **A match that never ended** (server restart, room closed without end-game). Expected: accepted for 4 h after start, then refused. Pinned in Task 1 (`test_unended_match_accepted_for_4_hours`).
4. **Spam with random match ids.** Expected: each (match, room) pair costs at most one D1 query per 60 s. Pinned in Task 1 (`test_upload_check_is_cached`).
5. **Players whose slot changes mid-match** (host handover moves a player to slot 0). Expected: still accepted, because validation checks the room, not a per-match slot list. Covered by design (Ruling below); the screenshot own-slot check reads the live `room.slots`.

**Ruling (deviation from spec §2/§5):** the spec's `match_retention.slots` column and "`slot` is in `slots`" check are dropped. Keeping a per-match slot list correct needs hooks at start-game, mid-game join, claim-slot and host handover, and it only stops a player in the room writing under a different slot of the same match. The HTTP fallback instead requires an integer slot in 0–3, and Socket.IO screenshots must use the sender's current slot. Task 5 updates the spec.

---

## File structure

| Path | Change |
|---|---|
| `server/migrations/0004_match_retention.sql` | Create: the retention table (all spec columns except `slots`) |
| `server/src/db.py` | Add `register_match`, `match_accepts_uploads`; `set_session_ended(…, None, …)` also sets `ended_at` |
| `server/src/api/signaling.py` | Register in `_start_game_locked`; screenshot own-slot check |
| `server/src/api/app.py` | HTTP fallback: integer slot 0–3 and `match_accepts_uploads`; `cleanup_old_data` first runs 60 s after boot |
| `tests/test_match_registration.py` | Create: db-level tests (SQLite and fake D1) |
| `tests/test_room_logic.py` | Add start-game and screenshot tests |
| `tests/test_session_log_http.py` | Create: HTTP fallback validation tests |
| `tests/test_migrate.py`, `tests/test_db.py`, `tests/test_d1_backend.py` | Expected migration lists gain `"0004"` |
| `docs/superpowers/specs/2026-09-25-offbox-log-storage-design.md` | Drop the `slots` column and check (Ruling) |

---

### Task 1: `match_retention` table and db functions

**Files:** create `server/migrations/0004_match_retention.sql`, `tests/test_match_registration.py`; modify `server/src/db.py`, `tests/test_migrate.py`, `tests/test_db.py`, `tests/test_d1_backend.py`.

**Interfaces — produces:**
- `async db.register_match(match_id: str, room: str) -> None` (idempotent: `INSERT OR IGNORE`)
- `async db.match_accepts_uploads(match_id: str, room: str) -> bool`
- `db._upload_check_cache: dict[tuple[str, str], tuple[bool, float]]` (tests clear it)
- `db.set_session_ended(match_id, None, ended_by)` now also sets `match_retention.ended_at` if unset.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_match_registration.py`:

```python
"""match_retention: registration at start-game and the upload window.

Run: cd server && uv run --extra dev pytest ../tests/test_match_registration.py -q
"""

from unittest.mock import patch

import pytest
from db_test_support import FAKE_TOKEN, FakeD1, run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


@pytest.fixture(autouse=True)
def _clear_cache():
    import src.db as db

    db._upload_check_cache.clear()
    yield
    db._upload_check_cache.clear()


async def _open(tmp_path, d1):
    import src.db as db
    from src.blobstore import LocalBlobStore
    from src.dbbackend.d1 import D1Backend

    backend = D1Backend("acct", "db", FAKE_TOKEN, transport=FakeD1().transport()) if d1 else None
    await db.init_db(None if d1 else str(tmp_path / "kn.db"), backend=backend, blobs=LocalBlobStore(tmp_path / "b"))
    return db


BACKENDS = pytest.mark.parametrize("d1", [False, True], ids=["sqlite", "d1"])


@BACKENDS
def test_registered_match_accepts_uploads_from_its_room_only(tmp_path, d1):
    async def scenario():
        db = await _open(tmp_path, d1)
        try:
            await db.register_match("m1", "ROOM1")
            await db.register_match("m1", "ROOM1")  # idempotent
            return (
                await db.match_accepts_uploads("m1", "ROOM1"),
                await db.match_accepts_uploads("m1", "OTHER"),
                await db.match_accepts_uploads("unknown", "ROOM1"),
            )
        finally:
            await db.close_db()

    assert run_async(scenario()) == (True, False, False)


@BACKENDS
def test_uploads_accepted_until_30_min_after_end(tmp_path, d1):
    async def scenario():
        db = await _open(tmp_path, d1)
        try:
            await db.register_match("m1", "ROOM1")
            await db.set_session_ended("m1", None, "game-end")
            ended = await db.query("SELECT ended_at FROM match_retention WHERE match_id = 'm1'", ())
            just_ended = await db.match_accepts_uploads("m1", "ROOM1")
            await db.execute_write(
                "UPDATE match_retention SET ended_at = datetime('now', '-31 minutes') WHERE match_id = 'm1'", ()
            )
            db._upload_check_cache.clear()
            return ended[0]["ended_at"] is not None, just_ended, await db.match_accepts_uploads("m1", "ROOM1")
        finally:
            await db.close_db()

    assert run_async(scenario()) == (True, True, False)


@BACKENDS
def test_unended_match_accepted_for_4_hours(tmp_path, d1):
    async def scenario():
        db = await _open(tmp_path, d1)
        try:
            await db.register_match("m1", "ROOM1")
            await db.execute_write(
                "UPDATE match_retention SET created_at = datetime('now', '-3 hours') WHERE match_id = 'm1'", ()
            )
            within = await db.match_accepts_uploads("m1", "ROOM1")
            await db.execute_write(
                "UPDATE match_retention SET created_at = datetime('now', '-5 hours') WHERE match_id = 'm1'", ()
            )
            db._upload_check_cache.clear()
            return within, await db.match_accepts_uploads("m1", "ROOM1")
        finally:
            await db.close_db()

    assert run_async(scenario()) == (True, False)


def test_tombstoned_match_refuses_uploads(tmp_path):
    async def scenario():
        db = await _open(tmp_path, False)
        try:
            await db.register_match("m1", "ROOM1")
            await db.execute_write(
                "UPDATE match_retention SET deleting_at = datetime('now') WHERE match_id = 'm1'", ()
            )
            return await db.match_accepts_uploads("m1", "ROOM1")
        finally:
            await db.close_db()

    assert run_async(scenario()) is False


def test_player_leaving_does_not_end_the_match(tmp_path):
    """Only game-end (slot None) stamps ended_at; one player leaving doesn't."""

    async def scenario():
        db = await _open(tmp_path, False)
        try:
            await db.register_match("m1", "ROOM1")
            await db.set_session_ended("m1", 2, "leave")
            rows = await db.query("SELECT ended_at FROM match_retention WHERE match_id = 'm1'", ())
            return rows[0]["ended_at"]
        finally:
            await db.close_db()

    assert run_async(scenario()) is None


def test_upload_check_is_cached(tmp_path):
    async def scenario():
        db = await _open(tmp_path, False)
        try:
            calls = []
            real_query = db._require().query

            async def counting_query(sql, params=()):
                calls.append(sql)
                return await real_query(sql, params)

            with patch.object(db._require(), "query", side_effect=counting_query):
                for _ in range(5):
                    await db.match_accepts_uploads("bogus", "ROOM1")
            return len(calls)
        finally:
            await db.close_db()

    assert run_async(scenario()) == 1
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run --extra dev pytest ../tests/test_match_registration.py -q -p no:cacheprovider`
Expected: FAIL — `AttributeError: module 'src.db' has no attribute '_upload_check_cache'`.

- [ ] **Step 3: Add the migration**

Create `server/migrations/0004_match_retention.sql`:

```sql
-- One row per match, created at start-game (db.register_match). The HTTP
-- log-upload fallback checks it now; the retention, archive and eviction
-- columns are filled by later work (spec §1 "Archive and eviction", §2).
-- All spec columns are created here so the table isn't altered later.

CREATE TABLE IF NOT EXISTS match_retention (
    match_id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    tier TEXT NOT NULL DEFAULT 'normal',
    flag_reasons TEXT NOT NULL DEFAULT '[]',
    auto_flag_capped INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    resolved_note TEXT,
    last_touched_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleting_at TEXT,
    archived_at TEXT,
    archived_max_chunk_id INTEGER,
    archived_updated_at TEXT,
    archive_bytes INTEGER,
    evicted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_match_retention_created_at ON match_retention (created_at);
```

- [ ] **Step 4: Add the db functions**

In `server/src/db.py`, add `import time` to the imports, then add after `get_full_log_entries`:

```python
# Log uploads for a match are accepted until 30 min after game-end, or 4 h
# after start when no end was recorded (crash, restart, room closed): spec §5.
_UPLOAD_GRACE_AFTER_END = "-30 minutes"
_UPLOAD_WINDOW_WITHOUT_END = "-4 hours"
_UPLOAD_CHECK_TTL_SEC = 60.0
_UPLOAD_CHECK_CACHE_MAX = 10_000
_upload_check_cache: dict[tuple[str, str], tuple[bool, float]] = {}


async def register_match(match_id: str, room: str) -> None:
    """Record a match at start-game. Idempotent."""
    await _require().execute(
        "INSERT OR IGNORE INTO match_retention (match_id, room) VALUES (?, ?)",
        (match_id, room),
    )


async def match_accepts_uploads(match_id: str, room: str) -> bool:
    """Whether log uploads for `match_id` from `room` are still accepted.

    Cached per (match, room) for 60 s, hits and misses alike, so uploads
    quoting made-up match ids cost at most one query a minute each.
    """
    key = (match_id, room)
    now = time.monotonic()
    cached = _upload_check_cache.get(key)
    if cached and cached[1] > now:
        return cached[0]
    rows = await _require().query(
        """SELECT 1 AS ok FROM match_retention
           WHERE match_id = ? AND room = ? AND deleting_at IS NULL
             AND ((ended_at IS NOT NULL AND ended_at > datetime('now', ?))
                  OR (ended_at IS NULL AND created_at > datetime('now', ?)))""",
        (match_id, room, _UPLOAD_GRACE_AFTER_END, _UPLOAD_WINDOW_WITHOUT_END),
    )
    accepted = bool(rows)
    if len(_upload_check_cache) >= _UPLOAD_CHECK_CACHE_MAX:
        _upload_check_cache.clear()
    _upload_check_cache[key] = (accepted, now + _UPLOAD_CHECK_TTL_SEC)
    return accepted
```

In `set_session_ended`, replace the `else:` branch (the game-end path) so it also stamps the match:

```python
    else:
        # Game end: mark sessions without an existing ended_by (don't overwrite
        # leave/disconnect) and record when the match ended.
        await backend.batch(
            [
                (
                    "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND ended_by IS NULL",
                    (ended_by, match_id),
                ),
                (
                    "UPDATE match_retention SET ended_at=datetime('now') WHERE match_id=? AND ended_at IS NULL",
                    (match_id,),
                ),
            ]
        )
```

- [ ] **Step 5: Update the expected migration lists**

In `tests/test_migrate.py`: add `"match_retention"` to `EXPECTED_COLUMNS`:

```python
    "match_retention": [
        "match_id", "room", "created_at", "ended_at", "tier", "flag_reasons", "auto_flag_capped",
        "resolved_at", "resolved_note", "last_touched_at", "deleting_at", "archived_at",
        "archived_max_chunk_id", "archived_updated_at", "archive_bytes", "evicted_at",
    ],
```

and `"idx_match_retention_created_at": ("match_retention", 0),` to `EXPECTED_INDEXES`. Change the applied-version lists: `["0001", "0002", "0003"]` → `["0001", "0002", "0003", "0004"]` (baseline-over-Alembic test), `applied == ["0001", "0003"]` / `recorded == ["0001", "0002", "0003"]` → add `"0004"` to both (Alembic 0008 test), and in `test_screenshot_rows_keep_their_bytes_through_0003` change `assert applied == ["0003"]` → `["0003", "0004"]`. In `tests/test_db.py` and `tests/test_d1_backend.py`, the lists ending `"0003"]` gain `"0004"`.

- [ ] **Step 6: Run to verify they pass**

Run: `cd server && uv run --extra dev pytest ../tests/test_match_registration.py ../tests/test_migrate.py ../tests/test_db.py ../tests/test_d1_backend.py ../tests/test_session_logging.py -q -p no:cacheprovider`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/migrations/0004_match_retention.sql server/src/db.py tests/test_match_registration.py tests/test_migrate.py tests/test_db.py tests/test_d1_backend.py
git commit -m "feat(logs): add match_retention and the log-upload window check"
```

---

### Task 2: Register at start-game; screenshots use the sender's slot

**Files:** modify `server/src/api/signaling.py`, `tests/test_room_logic.py`.

**Interfaces — consumes:** `db.register_match` (Task 1).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_room_logic.py`:

```python
# ── match registration and screenshot slots ─────────────────────────────────


def _patched_start(extra=None):
    patches = [
        patch.object(signaling.sio, "emit", new=AsyncMock()),
        patch.object(signaling.state, "save_room", new=AsyncMock()),
        patch.object(signaling.db, "insert_client_event", new=AsyncMock()),
        patch.object(signaling.stats, "record_match", new=AsyncMock()),
    ]
    return patches + (extra or [])


def _host_room(code="ROOM1"):
    room = _make_room(owner="sid-host")
    room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
    room.slots[0] = "pid-host"
    room.rom_ready.add("sid-host")
    rooms[code] = room
    _sid_to_room["sid-host"] = (code, "pid-host", False)
    return room


def _run_with(patches, coro):
    from contextlib import ExitStack

    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        return _run_async(coro)


def test_start_game_registers_the_match_before_announcing_it():
    from src.api.payloads import StartGamePayload
    from src.api.signaling import _start_game_locked

    room = _host_room()
    order = []
    register = AsyncMock(side_effect=lambda mid, code: order.append(("register", mid, code)))
    emit = AsyncMock(side_effect=lambda event, *a, **k: order.append(("emit", event)))
    patches = _patched_start([patch.object(signaling.db, "register_match", new=register)])
    patches[0] = patch.object(signaling.sio, "emit", new=emit)

    assert _run_with(patches, _start_game_locked("sid-host", StartGamePayload(mode="rollback"))) is None
    assert order[0] == ("register", room.match_id, "ROOM1")
    assert ("emit", "game-started") in order


def test_start_game_survives_register_failure():
    from src.api.payloads import StartGamePayload
    from src.api.signaling import _start_game_locked

    room = _host_room()
    failing = AsyncMock(side_effect=RuntimeError("D1 down"))
    patches = _patched_start([patch.object(signaling.db, "register_match", new=failing)])

    assert _run_with(patches, _start_game_locked("sid-host", StartGamePayload(mode="rollback"))) is None
    assert room.status == "playing" and room.match_id


def _screenshot_room():
    room = _host_room()
    room.match_id = "match-1"
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.slots[1] = "pid-guest"
    _sid_to_room["sid-guest"] = ("ROOM1", "pid-guest", False)
    return room


def _send_screenshot(sid, slot):
    import base64

    from src.api.signaling import game_screenshot

    insert = AsyncMock()
    data = {"matchId": "match-1", "slot": slot, "frame": 300, "data": base64.b64encode(b"\xff\xd8jpeg").decode()}
    patches = [
        patch.object(signaling, "check", new=lambda sid, event: True),
        patch.object(signaling.db, "insert_screenshot", new=insert),
    ]
    _run_with(patches, game_screenshot(sid, data))
    return insert


def test_screenshot_with_own_slot_is_stored():
    _screenshot_room()
    insert = _send_screenshot("sid-guest", 1)
    insert.assert_awaited_once_with("match-1", 1, 300, b"\xff\xd8jpeg")


def test_screenshot_claiming_another_players_slot_is_dropped():
    _screenshot_room()
    insert = _send_screenshot("sid-guest", 0)
    insert.assert_not_awaited()
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run --extra dev pytest ../tests/test_room_logic.py -q -p no:cacheprovider -k "register or screenshot"`
Expected: FAIL — `register_match` never awaited / `AttributeError` for `register_match`, and the other-slot screenshot is stored.

- [ ] **Step 3: Implement**

In `server/src/api/signaling.py`, `_start_game_locked`, directly after `room.match_id = str(uuid.uuid4())`:

```python
    # Register before announcing the match, so log uploads quoting this id
    # are accepted. Logging never blocks a game: a failed write is logged and
    # only HTTP-fallback uploads for this match will be refused.
    try:
        await db.register_match(room.match_id, session_id)
    except Exception as exc:
        log.warning("Match %s not registered; its HTTP log uploads will be refused: %s", room.match_id[:8], exc)
```

In `game_screenshot`, after the `room.match_id != match_id` check:

```python
    # Screenshot keys are per slot: a player may only upload their own.
    own_slot = next((s for s, pid in room.slots.items() if pid == player_id), None)
    if own_slot is None or slot != own_slot:
        return
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && uv run --extra dev pytest ../tests/test_room_logic.py ../tests/test_landing_board.py -q -p no:cacheprovider`
Expected: PASS (the landing-board tests exercise screenshots and must stay green).

- [ ] **Step 5: Commit**

```bash
git add server/src/api/signaling.py tests/test_room_logic.py
git commit -m "feat(logs): register matches at start-game; screenshots use the sender's slot"
```

---

### Task 3: Validate the HTTP fallback

**Files:** modify `server/src/api/app.py`; create `tests/test_session_log_http.py`.

**Interfaces — consumes:** `db.match_accepts_uploads` (Task 1).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_session_log_http.py`:

```python
"""POST /api/session-log (the HTTP fallback) only accepts registered, open matches.

Run: cd server && uv run --extra dev pytest ../tests/test_session_log_http.py -q
"""

from unittest.mock import AsyncMock

import pytest


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    import src.db as db
    from src.api import app as appmod

    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    append = AsyncMock(return_value=7)
    accepts = AsyncMock(return_value=True)
    monkeypatch.setattr(db, "append_session_log", append)
    monkeypatch.setattr(db, "match_accepts_uploads", accepts)
    return TestClient(appmod.create_app()), append, accepts


def _post(client, body, room="ROOM1"):
    from src.api.signaling import make_upload_token

    return client.post(f"/api/session-log?room={room}&token={make_upload_token(room)}", json=body)


BODY = {"matchId": "m1", "slot": 1, "playerName": "P", "mode": "rollback", "entries": [{"seq": 0, "msg": "a"}]}


def test_registered_open_match_is_stored(client):
    http, append, accepts = client
    r = _post(http, BODY)
    assert r.status_code == 200 and r.json()["lastSeq"] == 7
    accepts.assert_awaited_once_with("m1", "ROOM1")
    assert append.await_args.args[0]["slot"] == 1


def test_unknown_or_closed_match_is_refused(client):
    http, append, accepts = client
    accepts.return_value = False
    r = _post(http, BODY)
    assert r.status_code == 403
    append.assert_not_awaited()


@pytest.mark.parametrize("slot", [None, "1; DROP", "x", -1, 4, 1.5])
def test_slot_must_be_an_integer_0_to_3(client, slot):
    http, append, _ = client
    r = _post(http, {**BODY, "slot": slot})
    assert r.status_code == 400
    append.assert_not_awaited()
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run --extra dev pytest ../tests/test_session_log_http.py -q -p no:cacheprovider`
Expected: FAIL — unknown match returns 200 and invalid slots are stored.

(The endpoint returns `{"status": "saved", "lastSeq": …}`; that shape must not change.)

- [ ] **Step 3: Implement**

In `session_log_http`, replace `slot = data.get("slot")` and add the match check after `room_id` is read:

```python
        # Rooms hold at most 4 players (OpenRoomPayload.maxPlayers), slots 0-3.
        slot = data.get("slot")
        if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot <= 3:
            raise HTTPException(status_code=400, detail="Invalid slot")
        if not await db.match_accepts_uploads(match_id, room_id):
            raise HTTPException(status_code=403, detail="Unknown or closed match")
```

(`1.5` and strings fail the `isinstance(slot, int)` check; `True` is excluded explicitly.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && uv run --extra dev pytest ../tests/test_session_log_http.py ../tests/test_input_clamping.py -q -p no:cacheprovider`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/app.py tests/test_session_log_http.py
git commit -m "feat(logs): refuse HTTP log uploads for unknown or closed matches"
```

---

### Task 4: Cleanup runs soon after boot

**Files:** modify `server/src/api/app.py`, `tests/test_db.py`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_db.py`:

```python
def test_cleanup_old_data_first_runs_a_minute_after_boot():
    """Render restarts and naps long before 24 h, so waiting a day first meant
    cleanup never ran."""
    _run_async(_run_cleanup_sleep_order())


async def _run_cleanup_sleep_order():
    import asyncio
    from unittest.mock import AsyncMock, patch

    from src.api.app import cleanup_old_data

    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= 2:
            raise asyncio.CancelledError

    with (
        patch("src.api.app.asyncio.sleep", new=fake_sleep),
        patch("src.api.app.db.execute_write", new=AsyncMock()),
        patch("src.api.app.db.delete_old_screenshots", new=AsyncMock()) as delete_shots,
    ):
        try:
            await cleanup_old_data()
        except asyncio.CancelledError:
            pass
    assert sleeps == [60, 86400]
    delete_shots.assert_awaited_once()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && uv run --extra dev pytest ../tests/test_db.py -q -p no:cacheprovider -k first_runs`
Expected: FAIL — `assert [86400, 86400] == [60, 86400]`.

- [ ] **Step 3: Implement**

In `cleanup_old_data`, change the loop so the first run comes a minute after boot:

```python
    await asyncio.sleep(60)  # Render restarts and naps long before 24 h
    while True:
        try:
            ...  # unchanged body
        except Exception as e:
            log.warning("DB cleanup error: %s", e)
        await asyncio.sleep(86400)  # daily
```

(Move the existing `await asyncio.sleep(86400)` from the top of the loop to the bottom; the try/except body is unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && uv run --extra dev pytest ../tests/test_db.py -q -p no:cacheprovider`
Expected: PASS, including the existing `test_cleanup_old_data_also_cleans_session_log_chunks`.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/app.py tests/test_db.py
git commit -m "fix(logs): run DB cleanup a minute after boot instead of after 24 h"
```

---

### Task 5: Spec update, full check, PR

- [ ] **Step 1: Update the spec for the Ruling**

In `docs/superpowers/specs/2026-09-25-offbox-log-storage-design.md`:
- §2 schema: delete the `slots TEXT NOT NULL, -- JSON array …` line and the "`slots` grows when a late joiner …" bullet.
- §5 "Ingest validation": replace the "`slot` is in `slots`;" bullet with "`slot` is an integer 0–3 (HTTP fallback); Socket.IO screenshots must use the sender's current slot;" and add one sentence: "A per-match slot list was dropped: keeping it correct needs hooks at every slot change (mid-game join, claim-slot, host handover) and it only stops a room member writing under another slot of the same match."
- §8 item 2: append "(budgets split out to the next PR)".

- [ ] **Step 2: Full check**

Run: `cd server && uv run --extra dev pytest ../tests/test_match_registration.py ../tests/test_session_log_http.py ../tests/test_room_logic.py ../tests/test_landing_board.py ../tests/test_db.py ../tests/test_migrate.py ../tests/test_d1_backend.py ../tests/test_db_backends.py ../tests/test_session_logging.py ../tests/test_screenshots.py ../tests/test_blobstore.py ../tests/test_session_log_entries.py ../tests/test_input_clamping.py -q -p no:cacheprovider`
Expected: all pass (live tests skipped).

Then boot the server locally once and confirm `Database connected: sqlite (migrations applied: 0001, 0002, 0003, 0004; blobs: local)` and `/health` OK (start with `run_in_background`, `DB_PATH` in the scratchpad, `PORT=27999`; stop it after).

- [ ] **Step 3: Commit, push, open the PR, fallback review, merge**

```bash
git add docs/superpowers/specs/2026-09-25-offbox-log-storage-design.md
git commit -m "docs: drop the per-match slot list from the retention spec"
git diff --stat origin/main...HEAD
git push -u origin HEAD
gh pr create --base main --title "feat(logs): register matches and validate log uploads against them" --body-file <body>
```

Then run the fallback review (Global Constraints), post it, fix real findings with a failing test first, merge with `gh pr merge N --squash`, and check the Render logs for `migrations applied: 0004`.
