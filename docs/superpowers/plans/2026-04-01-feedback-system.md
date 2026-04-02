# Feedback System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-facing feedback form (bug reports, feature requests, general feedback) with SQLite storage and admin API for Claude-assisted triage.

**Architecture:** Single `feedback.js` IIFE on all pages provides a FAB button + modal form. Submissions POST to `/api/feedback`, validated by Pydantic, stored in SQLite via aiosqlite. Admin endpoints expose feedback for remote triage. Alembic manages schema migrations.

**Tech Stack:** Python (FastAPI, aiosqlite, Alembic, Pydantic), vanilla JS (IIFE pattern), SQLite

**Spec:** `docs/superpowers/specs/2026-04-01-feedback-system-design.md`

---

## Chunk 1: Database Layer

### Task 1: Add dependencies

**Files:**
- Modify: `server/pyproject.toml`

- [ ] **Step 1: Add aiosqlite and alembic to dependencies**

In `server/pyproject.toml`, add to the `dependencies` list:

```toml
dependencies = [
    "fastapi>=0.110.0",
    "uvicorn[standard]>=0.29.0",
    "python-socketio>=5.11.0",
    "python-dotenv>=1.0.0",
    "redis[hiredis]>=5.0.0",
    "playwright>=1.40.0",
    "aiosqlite==0.20.0",
    "alembic==1.15.2",
    "sqlalchemy>=2.0.0",
]
```

- [ ] **Step 2: Install dependencies**

Run: `cd /Users/kazon/kaillera-next/server && pip install -e .`
Expected: Successfully installed aiosqlite, alembic, and sqlalchemy

- [ ] **Step 3: Commit**

```bash
git add server/pyproject.toml
git commit -m "feat(feedback): add aiosqlite and alembic dependencies"
```

---

### Task 2: Create db.py module

**Files:**
- Create: `server/src/db.py`

- [ ] **Step 1: Write test for db module**

Create `tests/test_db.py`:

```python
"""Tests for the database module.

Run: pytest tests/test_db.py -v
"""

import asyncio
import os
import tempfile

import pytest


@pytest.fixture()
def tmp_db(tmp_path):
    """Provide a temporary DB path and set env var."""
    db_path = str(tmp_path / "test.db")
    os.environ["DB_PATH"] = db_path
    yield db_path
    os.environ.pop("DB_PATH", None)


def test_init_creates_tables(tmp_db):
    """init_db creates feedback and session_logs tables."""
    from src.db import close_db, init_db, query

    asyncio.run(_run_init_and_query(tmp_db))


async def _run_init_and_query(tmp_db):
    from src.db import close_db, init_db, query

    await init_db(tmp_db)
    tables = await query(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", ()
    )
    table_names = [t["name"] for t in tables]
    assert "feedback" in table_names
    assert "session_logs" in table_names
    await close_db()


def test_insert_feedback(tmp_db):
    """insert_feedback stores a row and returns its ID."""
    asyncio.run(_run_insert_feedback(tmp_db))


async def _run_insert_feedback(tmp_db):
    from src.db import close_db, init_db, insert_feedback, query

    await init_db(tmp_db)
    row_id = await insert_feedback({
        "category": "bug",
        "message": "Test bug report",
        "email": "test@example.com",
        "page": "game",
        "context": '{"mode": "lockstep"}',
        "ip_hash": "abc123",
    })
    assert row_id == 1
    rows = await query("SELECT * FROM feedback WHERE id = ?", (row_id,))
    assert len(rows) == 1
    assert rows[0]["category"] == "bug"
    assert rows[0]["message"] == "Test bug report"
    await close_db()


def test_query_returns_dicts(tmp_db):
    """query() returns list of dicts with column names as keys."""
    asyncio.run(_run_query_dicts(tmp_db))


async def _run_query_dicts(tmp_db):
    from src.db import close_db, init_db, insert_feedback, query

    await init_db(tmp_db)
    await insert_feedback({
        "category": "feature",
        "message": "Add dark mode",
        "email": None,
        "page": "home",
        "context": None,
        "ip_hash": "def456",
    })
    rows = await query("SELECT id, category, message FROM feedback", ())
    assert isinstance(rows[0], dict)
    assert "id" in rows[0]
    assert "category" in rows[0]
    await close_db()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kazon/kaillera-next/server && python -m pytest tests/test_db.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.db'`

- [ ] **Step 3: Create db.py**

Create `server/src/db.py`:

```python
"""SQLite database module — aiosqlite connection, Alembic migrations, query helpers.

Owns the single kn.db connection. Call init_db() on startup, close_db() on shutdown.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import aiosqlite

log = logging.getLogger(__name__)

_db: aiosqlite.Connection | None = None

_DEFAULT_DB_PATH = os.path.join("data", "kn.db")


async def init_db(db_path: str | None = None) -> None:
    """Run Alembic migrations and open the aiosqlite connection."""
    global _db
    path = db_path or os.environ.get("DB_PATH", _DEFAULT_DB_PATH)
    Path(path).parent.mkdir(parents=True, exist_ok=True)

    # Run Alembic migrations synchronously (they use their own connection)
    _run_migrations(path)

    _db = await aiosqlite.connect(path)
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA journal_mode=WAL")
    log.info("Database connected: %s", path)


def _run_migrations(db_path: str) -> None:
    """Run Alembic upgrade head against the given database path."""
    from alembic import command
    from alembic.config import Config

    alembic_dir = Path(__file__).parent.parent / "alembic"
    ini_path = Path(__file__).parent.parent / "alembic.ini"

    cfg = Config(str(ini_path))
    cfg.set_main_option("script_location", str(alembic_dir))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    command.upgrade(cfg, "head")


async def close_db() -> None:
    """Close the aiosqlite connection."""
    global _db
    if _db:
        await _db.close()
        _db = None
        log.info("Database connection closed")


async def insert_feedback(data: dict) -> int:
    """Insert a feedback row and return the new row ID."""
    assert _db is not None, "Database not initialized — call init_db() first"
    cursor = await _db.execute(
        """INSERT INTO feedback (category, message, email, page, context, ip_hash)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            data["category"],
            data["message"],
            data.get("email"),
            data.get("page"),
            data.get("context"),
            data.get("ip_hash"),
        ),
    )
    await _db.commit()
    return cursor.lastrowid


async def insert_session_log(data: dict) -> int:
    """Insert a session log row and return the new row ID."""
    assert _db is not None, "Database not initialized — call init_db() first"
    cursor = await _db.execute(
        """INSERT INTO session_logs (room, slot, player_name, mode, source, sync_log, context, ip_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data["room"],
            data.get("slot"),
            data.get("player_name"),
            data.get("mode"),
            data.get("source"),
            data.get("sync_log"),
            data.get("context"),
            data.get("ip_hash"),
        ),
    )
    await _db.commit()
    return cursor.lastrowid


async def query(sql: str, params: tuple) -> list[dict]:
    """Run a read query and return results as a list of dicts."""
    assert _db is not None, "Database not initialized — call init_db() first"
    cursor = await _db.execute(sql, params)
    rows = await cursor.fetchall()
    if not rows:
        return []
    columns = [desc[0] for desc in cursor.description]
    return [dict(zip(columns, row)) for row in rows]
```

- [ ] **Step 4: Run test to verify it fails (Alembic not configured yet)**

Run: `cd /Users/kazon/kaillera-next/server && python -m pytest tests/test_db.py::test_init_creates_tables -v`
Expected: FAIL — Alembic config/migration files missing

- [ ] **Step 5: Set up Alembic**

Create `server/alembic.ini`:

```ini
[alembic]
script_location = alembic
sqlalchemy.url = sqlite:///data/kn.db

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
```

Create `server/alembic/env.py`:

```python
"""Alembic environment — runs migrations against SQLite."""

from alembic import context

target_metadata = None


def run_migrations_offline() -> None:
    url = context.config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    from sqlalchemy import create_engine

    url = context.config.get_main_option("sqlalchemy.url")
    connectable = create_engine(url)

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

Create `server/alembic/script.py.mako` (Alembic template):

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""
from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

Create `server/alembic/versions/0001_initial_schema.py`:

```python
"""Initial schema — feedback and session_logs tables.

Revision ID: 0001
Revises:
Create Date: 2026-04-01
"""

from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "feedback",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("category", sa.Text, nullable=False),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("email", sa.Text),
        sa.Column("page", sa.Text),
        sa.Column("context", sa.Text),  # JSON stored as text
        sa.Column("ip_hash", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_table(
        "session_logs",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("room", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer),
        sa.Column("player_name", sa.Text),
        sa.Column("mode", sa.Text),
        sa.Column("source", sa.Text),
        sa.Column("sync_log", sa.Text),
        sa.Column("context", sa.Text),  # JSON stored as text
        sa.Column("ip_hash", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )


def downgrade() -> None:
    op.drop_table("session_logs")
    op.drop_table("feedback")
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/kazon/kaillera-next/server && python -m pytest tests/test_db.py -v`
Expected: All 3 tests PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/db.py server/alembic.ini server/alembic/ tests/test_db.py
git commit -m "feat(feedback): add SQLite database module with Alembic migrations"
```

---

## Chunk 2: Server Endpoints

### Task 3: Add FeedbackPayload and rate limit

**Files:**
- Modify: `server/src/api/payloads.py`
- Modify: `server/src/ratelimit.py`

- [ ] **Step 1: Add FeedbackPayload to payloads.py**

First, update the existing import at line 11 of `server/src/api/payloads.py` from `from typing import Any` to:

```python
from typing import Any, Literal
```

Then at the end of the file, add:

```python
# ── feedback ────────────────────────────────────────────────────────────────


class FeedbackPayload(BaseModel):
    category: Literal["bug", "feature", "general"]
    message: str = Field(min_length=1, max_length=2000)
    email: str | None = Field(default=None, max_length=254)
    company_fax: str | None = None  # honeypot — non-empty = bot
    page: str | None = Field(default=None, max_length=20)
    context: dict | None = None
```

- [ ] **Step 2: Add feedback rate limit and fix cleanup window**

In `server/src/ratelimit.py`, add to `_LIMITS` dict:

```python
"feedback": (5, 3600),  # 5 per hour per IP
```

In the `cleanup()` function, change the hardcoded `120` to derive from max window:

```python
def cleanup() -> None:
    now = time.monotonic()
    max_window = max(w for _, w in _LIMITS.values())
    stale_ips = []
    for ip, events in list(_counters.items()):
        for event, timestamps in list(events.items()):
            fresh = deque(t for t in timestamps if now - t < max_window)
```

This changes line 98 from `if now - t < 120` to `if now - t < max_window`.

- [ ] **Step 3: Commit**

```bash
git add server/src/api/payloads.py server/src/ratelimit.py
git commit -m "feat(feedback): add FeedbackPayload model and rate limit"
```

---

### Task 4: Add POST /api/feedback endpoint

**Files:**
- Modify: `server/src/api/app.py`
- Modify: `server/src/main.py`

- [ ] **Step 1: Write test for feedback endpoint**

Add to `tests/test_error_pages.py` (which already tests API rejection paths):

```python
def test_feedback_accepts_valid_submission(server_url):
    """Valid feedback submission returns 200 with saved status."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={
            "category": "bug",
            "message": "Test bug report from automated test",
            "page": "home",
        },
        timeout=5,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "saved"
    assert data["id"] >= 1


def test_feedback_rejects_missing_category(server_url):
    """Feedback without required category field is rejected."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={"message": "No category"},
        timeout=5,
    )
    assert r.status_code == 422


def test_feedback_rejects_empty_message(server_url):
    """Feedback with empty message is rejected."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={"category": "bug", "message": ""},
        timeout=5,
    )
    assert r.status_code == 422


def test_feedback_honeypot_silently_discards(server_url):
    """Feedback with honeypot field filled returns 200 but id=0 (discarded)."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={
            "category": "bug",
            "message": "I am a bot",
            "company_fax": "555-1234",
        },
        timeout=5,
    )
    assert r.status_code == 200
    assert r.json()["id"] == 0


def test_feedback_rejects_invalid_category(server_url):
    """Feedback with unknown category is rejected."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={"category": "spam", "message": "Bad category"},
        timeout=5,
    )
    assert r.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kazon/kaillera-next && python -m pytest tests/test_error_pages.py::test_feedback_accepts_valid_submission -v`
Expected: FAIL — 404 (endpoint doesn't exist yet)

- [ ] **Step 3: Add feedback endpoint to app.py**

At the top of `server/src/api/app.py`, add to imports:

```python
from src.api.payloads import FeedbackPayload
from src import db
```

Add the IP hash salt and feedback constant near the other module-level constants (after `_VALID_EVENT_TYPES` around line 73):

```python
_FEEDBACK_CONTEXT_MAX = 4096  # 4KB max for context JSON

_IP_HASH_SALT = os.environ.get("IP_HASH_SALT", "")
if not _IP_HASH_SALT:
    import secrets
    _IP_HASH_SALT = secrets.token_hex(16)
    log.warning("IP_HASH_SALT not set — using random salt (rate correlation won't survive restarts)")
```

Inside `create_app()`, after the existing `client_event` endpoint (around line 579), add:

```python
    # ── Feedback submission ──────────────────────────────────────────────

    @app.post("/api/feedback")
    async def submit_feedback(request: Request) -> dict:
        if not check_ip(_client_ip(request), "feedback"):
            raise HTTPException(status_code=429, detail="Rate limited")
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc
        try:
            payload = FeedbackPayload.model_validate(body)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        # Honeypot check — silent discard
        if payload.company_fax:
            return {"status": "saved", "id": 0}

        # Context size check — drop if over 4KB
        context_str = None
        if payload.context is not None:
            context_str = json.dumps(payload.context)
            if len(context_str) > _FEEDBACK_CONTEXT_MAX:
                context_str = None

        # Hash IP for correlation without tracking
        ip = _client_ip(request)
        ip_hash = hashlib.sha256(f"{ip}{_IP_HASH_SALT}".encode()).hexdigest()[:16]

        row_id = await db.insert_feedback({
            "category": payload.category,
            "message": payload.message,
            "email": payload.email,
            "page": payload.page,
            "context": context_str,
            "ip_hash": ip_hash,
        })
        log.info("Feedback saved: id=%d category=%s page=%s", row_id, payload.category, payload.page)
        return {"status": "saved", "id": row_id}
```

- [ ] **Step 4: Integrate db init/close into FastAPI lifespan**

In `server/src/main.py`, update the lifespan to init and close the DB:

Add import at top:

```python
from src import db
```

In `server/src/main.py`, make two precise insertions in the `lifespan()` function:

1. Add `await db.init_db()` on a new line directly after `await state.init()` (line 36):

```python
    await state.init()
    await db.init_db()  # <-- add this line
    restored = await state.load_all_rooms()
```

2. Add `await db.close_db()` on a new line directly before `await state.close()` (line 56):

```python
    await db.close_db()  # <-- add this line
    await state.close()
```

Do NOT modify any other lines in the lifespan function — the Playwright warmup, task creation, and shutdown logic remain unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/kazon/kaillera-next && python -m pytest tests/test_error_pages.py -v -k feedback`
Expected: All 5 feedback tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/api/app.py server/src/main.py tests/test_error_pages.py
git commit -m "feat(feedback): add POST /api/feedback endpoint with honeypot and rate limiting"
```

---

### Task 5: Add admin feedback endpoints

**Files:**
- Modify: `server/src/api/app.py`

- [ ] **Step 1: Write tests for admin feedback endpoints**

Add to `tests/test_error_pages.py`:

```python
def test_admin_feedback_list_requires_auth(server_url):
    """Admin feedback list requires ADMIN_KEY."""
    r = requests.get(f"{server_url}/admin/api/feedback", timeout=5)
    # Returns 401 or 403 depending on whether ADMIN_KEY is configured
    assert r.status_code in (401, 403)


def test_admin_feedback_single_requires_auth(server_url):
    """Admin feedback single entry requires ADMIN_KEY."""
    r = requests.get(f"{server_url}/admin/api/feedback/1", timeout=5)
    assert r.status_code in (401, 403)
```

- [ ] **Step 2: Add admin feedback endpoints to app.py**

Inside `create_app()`, in the admin API section (after the existing admin endpoints), add:

```python
    # ── Admin feedback API ───────────────────────────────────────────────

    @app.get("/admin/api/feedback")
    async def admin_feedback_list(request: Request) -> dict:
        _admin_auth(request)
        category = request.query_params.get("category")
        days = int(request.query_params.get("days", "30"))
        limit = min(int(request.query_params.get("limit", "50")), 200)
        offset = int(request.query_params.get("offset", "0"))

        conditions = ["created_at > datetime('now', ?)", ]
        params: list = [f"-{days} days"]

        if category and category in ("bug", "feature", "general"):
            conditions.append("category = ?")
            params.append(category)

        where = " AND ".join(conditions)

        total_rows = await db.query(
            f"SELECT COUNT(*) as cnt FROM feedback WHERE {where}", tuple(params)
        )
        total = total_rows[0]["cnt"] if total_rows else 0

        params_with_paging = params + [limit, offset]
        entries = await db.query(
            f"SELECT * FROM feedback WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            tuple(params_with_paging),
        )
        # Parse context JSON strings back to dicts for the response
        for entry in entries:
            if entry.get("context") and isinstance(entry["context"], str):
                try:
                    entry["context"] = json.loads(entry["context"])
                except (json.JSONDecodeError, TypeError):
                    pass
        return {"total": total, "entries": entries}

    @app.get("/admin/api/feedback/{feedback_id}")
    async def admin_feedback_single(request: Request, feedback_id: int) -> dict:
        _admin_auth(request)
        rows = await db.query("SELECT * FROM feedback WHERE id = ?", (feedback_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Feedback not found")
        entry = rows[0]
        if entry.get("context") and isinstance(entry["context"], str):
            try:
                entry["context"] = json.loads(entry["context"])
            except (json.JSONDecodeError, TypeError):
                pass
        return entry
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kazon/kaillera-next && python -m pytest tests/test_error_pages.py -v -k admin_feedback`
Expected: Both admin feedback tests PASS

- [ ] **Step 4: Update app.py module docstring**

Add to the docstring at the top of `server/src/api/app.py`:

```
  POST /api/feedback            submit user feedback
```

And in the admin section:

```
  GET    /admin/api/feedback          list feedback entries
  GET    /admin/api/feedback/{id}     single feedback entry
```

- [ ] **Step 5: Commit**

```bash
git add server/src/api/app.py tests/test_error_pages.py
git commit -m "feat(feedback): add admin feedback list and detail endpoints"
```

---

## Chunk 3: Client-Side Feedback Form

### Task 6: Create feedback.js

**Files:**
- Create: `web/static/feedback.js`

- [ ] **Step 1: Create the feedback.js IIFE**

Create `web/static/feedback.js` with the complete FAB + modal implementation:

```javascript
/* feedback.js — Floating feedback button + modal form.
   Loaded on all pages. IIFE pattern (no ES modules). */
(() => {
  'use strict';

  // ── Configuration ───────────────────────────────────────────────────
  const CATEGORY_LABELS = {
    bug: { emoji: '🐛', label: 'Bug Report', placeholder: 'What happened? Steps to reproduce if possible...' },
    feature: { emoji: '💡', label: 'Feature', placeholder: 'What would you like to see?' },
    general: { emoji: '💬', label: 'General', placeholder: "What's on your mind?" },
  };

  let _selectedCategory = null;
  let _modal = null;
  let _fab = null;
  let _toolbarItem = null;
  let _isGamePage = window.location.pathname.includes('play.html');

  // ── Context gathering ───────────────────────────────────────────────
  const _gatherContext = () => {
    const ctx = {
      url: window.location.href,
      page: _detectPage(),
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
    };
    // Player name from localStorage
    try {
      const name = localStorage.getItem('kaillera-name');
      if (name) ctx.playerName = name;
    } catch (_) {}

    // Game-page context from KNState (if available)
    const ks = window.KNState;
    if (ks) {
      if (ks.room) ctx.roomCode = ks.room;
      if (ks.slot != null) ctx.playerSlot = ks.slot;
      if (ks.peers) {
        const peers = Object.values(ks.peers);
        ctx.peerCount = peers.length;
        const states = {};
        for (const p of peers) {
          if (p.pc) states[p.sid || 'unknown'] = p.pc.connectionState || 'unknown';
        }
        if (Object.keys(states).length) ctx.peerStates = states;
      }
      if (ks.sessionStats) ctx.sessionStats = { ...ks.sessionStats };
    }
    // Mode from URL params
    const mode = new URLSearchParams(window.location.search).get('mode');
    if (mode) ctx.mode = mode;

    return ctx;
  };

  const _detectPage = () => {
    const path = window.location.pathname;
    if (path.includes('play.html')) return 'game';
    // index.html with room code in URL = lobby context
    const params = new URLSearchParams(window.location.search);
    if (params.get('room')) return 'lobby';
    return 'home';
  };

  // ── DOM creation ────────────────────────────────────────────────────
  const _injectStyles = () => {
    const style = document.createElement('style');
    style.textContent = `
      .kn-feedback-fab {
        position: fixed; bottom: 20px; right: 20px; z-index: 99999;
        width: 48px; height: 48px; border-radius: 50%;
        background: #e94560; color: #fff; border: none; cursor: pointer;
        font-size: 20px; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 16px rgba(233,69,96,0.4);
        transition: transform 0.15s, box-shadow 0.15s;
      }
      .kn-feedback-fab:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 20px rgba(233,69,96,0.5);
      }
      .kn-feedback-fab[hidden] { display: none; }
      .kn-feedback-fab-tooltip {
        position: absolute; bottom: 56px; right: 0;
        background: #0f0f23; border: 1px solid #333; border-radius: 8px;
        padding: 6px 10px; color: #aaa; font-size: 11px; white-space: nowrap;
        pointer-events: none; opacity: 0; transition: opacity 0.15s;
      }
      .kn-feedback-fab:hover .kn-feedback-fab-tooltip { opacity: 1; }

      .kn-feedback-backdrop {
        position: fixed; inset: 0; z-index: 100000;
        background: rgba(0,0,0,0.6); display: flex;
        align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.15s;
      }
      .kn-feedback-backdrop.open { opacity: 1; }
      .kn-feedback-backdrop[hidden] { display: none; }

      .kn-feedback-modal {
        background: #0f0f23; border: 1px solid #333; border-radius: 12px;
        width: 90%; max-width: 440px; padding: 24px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        max-height: 90vh; overflow-y: auto;
      }
      .kn-feedback-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 20px;
      }
      .kn-feedback-header h3 { color: #fff; font-size: 18px; margin: 0; }
      .kn-feedback-close {
        background: none; border: none; color: #666; font-size: 20px;
        cursor: pointer; padding: 4px 8px;
      }
      .kn-feedback-close:hover { color: #fff; }

      .kn-feedback-categories {
        display: flex; gap: 8px; margin-bottom: 16px;
      }
      .kn-feedback-cat {
        flex: 1; padding: 10px; text-align: center; border-radius: 8px;
        font-size: 13px; font-weight: 500; cursor: pointer;
        background: #16213e; color: #aaa; border: 1px solid #333;
        transition: background 0.1s, color 0.1s;
      }
      .kn-feedback-cat:hover { border-color: #e94560; }
      .kn-feedback-cat.active {
        background: #e94560; color: #fff; border-color: #e94560;
      }

      .kn-feedback-label {
        display: block; color: #888; font-size: 12px; margin-bottom: 4px;
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .kn-feedback-textarea {
        width: 100%; min-height: 100px; padding: 12px;
        background: #16213e; border: 1px solid #333; border-radius: 8px;
        color: #eee; font-size: 14px; resize: vertical;
        font-family: inherit; margin-bottom: 16px; box-sizing: border-box;
      }
      .kn-feedback-textarea:focus { outline: none; border-color: #e94560; }

      .kn-feedback-email {
        width: 100%; padding: 10px 12px;
        background: #16213e; border: 1px solid #333; border-radius: 8px;
        color: #eee; font-size: 14px; margin-bottom: 16px;
        font-family: inherit; box-sizing: border-box;
      }
      .kn-feedback-email:focus { outline: none; border-color: #e94560; }

      .kn-feedback-context-hint {
        background: #16213e; border-radius: 6px; padding: 8px 12px;
        margin-bottom: 16px; display: flex; align-items: center; gap: 8px;
      }
      .kn-feedback-context-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #4ecca3;
        flex-shrink: 0;
      }
      .kn-feedback-context-text { color: #888; font-size: 12px; }

      .kn-feedback-submit {
        width: 100%; padding: 12px; border-radius: 8px; border: none;
        background: #e94560; color: #fff; font-weight: 600; font-size: 14px;
        cursor: pointer; transition: opacity 0.15s;
      }
      .kn-feedback-submit:disabled {
        opacity: 0.4; cursor: not-allowed;
      }
      .kn-feedback-submit:not(:disabled):hover { opacity: 0.9; }

      /* Honeypot — must be invisible but not display:none (bots detect that) */
      .kn-feedback-hp {
        position: absolute; left: -9999px; width: 1px; height: 1px;
        overflow: hidden; opacity: 0;
      }

      /* Toolbar menu item */
      .kn-feedback-toolbar-item {
        width: 100%; text-align: left; padding: 10px 16px;
        background: none; border: none; color: #ccc;
        cursor: pointer; font-size: 14px;
      }
      .kn-feedback-toolbar-item:hover { background: #1a1a3e; }
    `;
    document.head.appendChild(style);
  };

  const _createFAB = () => {
    _fab = document.createElement('button');
    _fab.className = 'kn-feedback-fab';
    _fab.setAttribute('aria-label', 'Send feedback');
    _fab.innerHTML = '💬<span class="kn-feedback-fab-tooltip">Send Feedback</span>';
    _fab.addEventListener('click', _openModal);
    document.body.appendChild(_fab);
  };

  const _createModal = () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'kn-feedback-backdrop';
    backdrop.hidden = true;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) _closeModal();
    });

    const categoryButtons = Object.entries(CATEGORY_LABELS)
      .map(([key, { emoji, label }]) =>
        `<button type="button" class="kn-feedback-cat" data-cat="${key}">${emoji} ${label}</button>`)
      .join('');

    backdrop.innerHTML = `
      <div class="kn-feedback-modal" role="dialog" aria-label="Send Feedback">
        <div class="kn-feedback-header">
          <h3>Send Feedback</h3>
          <button class="kn-feedback-close" aria-label="Close">&times;</button>
        </div>
        <div class="kn-feedback-categories">${categoryButtons}</div>
        <label class="kn-feedback-label" for="kn-fb-message">Message</label>
        <textarea class="kn-feedback-textarea" id="kn-fb-message"
          placeholder="Select a category above..."></textarea>
        <input class="kn-feedback-email" id="kn-fb-email" type="email"
          placeholder="Email (optional, for follow-up)" />
        <input class="kn-feedback-hp" name="company_fax" tabindex="-1"
          autocomplete="off" aria-hidden="true" />
        <div class="kn-feedback-context-hint">
          <span class="kn-feedback-context-dot"></span>
          <span class="kn-feedback-context-text">Session context will be attached automatically</span>
        </div>
        <button class="kn-feedback-submit" disabled>Send Feedback</button>
      </div>
    `;

    // Wire up events
    backdrop.querySelector('.kn-feedback-close').addEventListener('click', _closeModal);

    for (const btn of backdrop.querySelectorAll('.kn-feedback-cat')) {
      btn.addEventListener('click', () => {
        _selectedCategory = btn.dataset.cat;
        for (const b of backdrop.querySelectorAll('.kn-feedback-cat')) {
          b.classList.toggle('active', b === btn);
        }
        const ta = backdrop.querySelector('.kn-feedback-textarea');
        ta.placeholder = CATEGORY_LABELS[_selectedCategory].placeholder;
        _updateSubmitState(backdrop);
      });
    }

    const textarea = backdrop.querySelector('.kn-feedback-textarea');
    textarea.addEventListener('input', () => _updateSubmitState(backdrop));

    backdrop.querySelector('.kn-feedback-submit').addEventListener('click', () => _submit(backdrop));

    document.body.appendChild(backdrop);
    _modal = backdrop;
  };

  const _updateSubmitState = (modal) => {
    const msg = modal.querySelector('.kn-feedback-textarea').value.trim();
    modal.querySelector('.kn-feedback-submit').disabled = !_selectedCategory || !msg;
  };

  // ── Modal open/close ────────────────────────────────────────────────
  const _openModal = () => {
    if (!_modal) return;
    _modal.hidden = false;
    requestAnimationFrame(() => _modal.classList.add('open'));
    _modal.querySelector('.kn-feedback-textarea').focus();
  };

  const _closeModal = () => {
    if (!_modal) return;
    _modal.classList.remove('open');
    setTimeout(() => { _modal.hidden = true; }, 150);
  };

  // ── Submission ──────────────────────────────────────────────────────
  const _submit = async (modal) => {
    const btn = modal.querySelector('.kn-feedback-submit');
    const msg = modal.querySelector('.kn-feedback-textarea').value.trim();
    if (!_selectedCategory || !msg) return;

    btn.disabled = true;
    btn.textContent = 'Sending...';

    const payload = {
      category: _selectedCategory,
      message: msg,
      email: modal.querySelector('.kn-feedback-email').value.trim() || null,
      company_fax: modal.querySelector('[name="company_fax"]').value,
      page: _detectPage(),
      context: _gatherContext(),
    };

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        _closeModal();
        _showToast('Thanks for your feedback!');
        // Reset form
        _selectedCategory = null;
        modal.querySelector('.kn-feedback-textarea').value = '';
        modal.querySelector('.kn-feedback-email').value = '';
        modal.querySelector('[name="company_fax"]').value = '';
        for (const b of modal.querySelectorAll('.kn-feedback-cat')) b.classList.remove('active');
        modal.querySelector('.kn-feedback-textarea').placeholder = 'Select a category above...';
        _updateSubmitState(modal);
      } else if (res.status === 429) {
        _showToast('Please wait before submitting again');
      } else {
        _showToast('Submission failed, please try again');
      }
    } catch (_) {
      _showToast('Submission failed, please try again');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Feedback';
      _updateSubmitState(modal);
    }
  };

  // ── Toast ───────────────────────────────────────────────────────────
  const _showToast = (msg) => {
    // Use existing showToast if available (play.js), otherwise create minimal one
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
      return;
    }
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
      background: '#0f0f23', border: '1px solid #333', borderRadius: '8px',
      padding: '10px 20px', color: '#eee', fontSize: '14px', zIndex: '100001',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  };

  // ── Game page: toolbar integration ──────────────────────────────────
  const _setupToolbarItem = () => {
    if (!_isGamePage) return;

    const dropdown = document.getElementById('more-dropdown');
    if (!dropdown) return;

    // Create menu item
    _toolbarItem = document.createElement('button');
    _toolbarItem.className = 'more-option kn-feedback-toolbar-item';
    _toolbarItem.setAttribute('role', 'menuitem');
    _toolbarItem.textContent = 'Feedback';
    _toolbarItem.style.display = 'none';
    _toolbarItem.addEventListener('click', () => {
      // Close the dropdown menu, then open feedback modal
      dropdown.classList.add('hidden');
      _openModal();
    });

    // Insert before End Game button
    const endBtn = document.getElementById('toolbar-end');
    if (endBtn) {
      dropdown.insertBefore(_toolbarItem, endBtn);
    } else {
      dropdown.appendChild(_toolbarItem);
    }
  };

  const _updateFABVisibility = () => {
    if (!_isGamePage || !_fab) return;
    const toolbar = document.getElementById('toolbar');
    const gameActive = toolbar && !toolbar.classList.contains('hidden');
    _fab.hidden = gameActive;
    if (_toolbarItem) _toolbarItem.style.display = gameActive ? '' : 'none';
  };

  // ── Init ────────────────────────────────────────────────────────────
  const _init = () => {
    _injectStyles();
    _createFAB();
    _createModal();
    _setupToolbarItem();

    // Observe toolbar visibility changes on game page
    if (_isGamePage) {
      _updateFABVisibility();
      // Use MutationObserver on toolbar to detect show/hide
      const toolbar = document.getElementById('toolbar');
      if (toolbar) {
        const observer = new MutationObserver(_updateFABVisibility);
        observer.observe(toolbar, { attributes: true, attributeFilter: ['class'] });
      }
      // Also check periodically as a fallback (toolbar may not exist at load time)
      setInterval(_updateFABVisibility, 1000);
    }

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _modal && !_modal.hidden) _closeModal();
    });
  };

  // Run on DOMContentLoaded or immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
```

- [ ] **Step 2: Commit**

```bash
git add web/static/feedback.js
git commit -m "feat(feedback): add feedback.js with FAB button, modal form, and context capture"
```

---

### Task 7: Add feedback.js to HTML pages

**Files:**
- Modify: `web/index.html`
- Modify: `web/play.html`

- [ ] **Step 1: Add script tag to index.html**

In `web/index.html`, add before `</body>` (after the existing `lobby.js` script tag at line 104):

```html
    <script src="/static/feedback.js"></script>
```

- [ ] **Step 2: Add script tag to play.html**

In `web/play.html`, add before `</body>` (after the existing `version.js` script tag at line 390):

```html
    <script src="/static/feedback.js"></script>
```

- [ ] **Step 3: Commit**

```bash
git add web/index.html web/play.html
git commit -m "feat(feedback): load feedback.js on all pages"
```

---

## Chunk 4: Docker & Final Verification

### Task 8: Update Docker compose for SQLite persistence

**Files:**
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add data volume and DB_PATH env var**

In `docker-compose.prod.yml`, add to the `kaillera-next` service environment:

```yaml
      - DB_PATH=${DB_PATH:-/app/server/data/kn.db}
      - IP_HASH_SALT=${IP_HASH_SALT}
```

Add a volume mount after the existing `kaillera-logs` volume:

```yaml
      - kaillera-data:/app/server/data
```

Add to the `volumes:` section at the bottom:

```yaml
  kaillera-data:
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(feedback): add SQLite data volume mount for Docker persistence"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Run all existing tests to ensure no regressions**

Run: `cd /Users/kazon/kaillera-next && python -m pytest tests/test_error_pages.py tests/test_server_rest.py -v`
Expected: All tests PASS

- [ ] **Step 2: Visual verification with Playwright**

Start the dev server and open a browser to verify:
1. FAB button visible on homepage (bottom-right)
2. Clicking FAB opens the modal
3. Selecting a category changes the placeholder text
4. Submit disabled until category + message filled
5. Submitting shows success toast
6. Modal closes after success

- [ ] **Step 3: Verify database was populated**

Run: `sqlite3 /Users/kazon/kaillera-next/server/data/kn.db "SELECT id, category, message, created_at FROM feedback ORDER BY id DESC LIMIT 5"`
Expected: Shows the submitted feedback entry

- [ ] **Step 4: Final commit if any cleanup needed**

Only if there are uncommitted changes from cleanup. Stage specific files — do not use `git add -A`.
