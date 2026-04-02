# Feedback System — Design Spec

**Date:** 2026-04-01
**Scope:** User-facing feedback form (bug reports, feature requests, general feedback) with server-side storage and Claude-assisted triage.

---

## Overview

A lightweight feedback collection system present on all pages (homepage, lobby, game). Users submit categorized feedback via a floating action button and modal form. Submissions are stored in a SQLite database (`kn.db`) with auto-captured session context. Designed for solo-developer maintenance and Claude-assisted triage.

## Goals

- Collect actionable feedback from real users with minimal friction
- Auto-capture session context (room state, peer info, connection stats) for bug reports
- Resist abuse from bots and bad actors without adding user friction
- Store feedback in a format optimized for Claude-assisted triage (structured SQL)
- Minimal maintenance burden — no external service dependencies

## Non-Goals

- Real-time notifications for new feedback
- User-facing feedback tracking or status updates
- Automated GitHub Issue creation (Claude creates issues on request)
- PostHog integration for feedback (may add lightweight event later)

---

## Architecture

```
User clicks FAB → Modal opens → Fills form → Submit
                                                 ↓
                              POST /api/feedback (JSON body)
                                                 ↓
                              Server validates:
                                1. Rate limit (5/hr per IP)
                                2. Honeypot check (silent 200 if bot)
                                3. Pydantic validation
                                                 ↓
                              INSERT into kn.db → feedback table
                                                 ↓
                              Return {status: "saved", id: N}
                                                 ↓
                              Client shows toast: "Thanks for your feedback!"
```

### Triage Workflow

When the developer asks Claude to review feedback:

1. Claude queries feedback via `GET /admin/api/feedback` (production) or `sqlite3` CLI (local dev)
2. Summarizes submissions by category, frequency, common themes
3. Suggests next actions with technical context (e.g., "5 reports about audio cutting out in lockstep — likely the AudioWorklet fallback path, want me to investigate?")
4. Developer decides which to escalate → Claude creates GitHub Issues with full context

---

## Database

### Engine

- **SQLite** via `aiosqlite` (async wrapper around stdlib `sqlite3`)
- Single `kn.db` file (configurable via `DB_PATH` env var, default `./data/kn.db`)
- Connection managed by FastAPI lifespan (open on startup, close on shutdown)
- **Docker:** The `data/` directory must be a volume mount to persist across container replacements. Add to `docker-compose.prod.yml` and document in README.

### Migrations

- **Alembic** — standard Python migration framework, actively maintained
- Migration directory: `server/alembic/versions/`
- Config: `server/alembic.ini` + `server/alembic/env.py`
- Migrations run on app startup before serving requests — call `alembic.command.upgrade(config, "head")` synchronously before the async event loop starts (in the FastAPI lifespan, wrapped in `asyncio.to_thread()`, or called before `uvicorn.run()`)
- Pin exact version in `pyproject.toml`

### Schema

```sql
-- alembic/versions/0001_initial.py

CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,          -- 'bug' | 'feature' | 'general'
    message TEXT NOT NULL,
    email TEXT,
    page TEXT,                       -- 'home' | 'lobby' | 'game'
    context JSON,                    -- auto-captured session state blob
    ip_hash TEXT,                    -- SHA256(IP) for rate correlation
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE session_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    slot INTEGER,
    player_name TEXT,
    mode TEXT,                       -- 'lockstep' | 'streaming'
    source TEXT,                     -- 'end-game' | 'beacon' | 'recovery' | 'leave' | 'manual'
    sync_log TEXT,                   -- the CSV sync log content
    context JSON,                    -- session stats, peer info, duration, etc.
    ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
```

The `session_logs` table is created in the initial migration for schema cohesion. It will be populated by the separate session logging feature (second spec). If the second spec requires schema changes, those will be a new Alembic migration — not a modification to this one.

### Module: `server/src/db.py`

Owns the `aiosqlite` connection and exposes async helpers:

- `init_db()` — run Alembic migrations (`upgrade head`), open connection. Called from FastAPI lifespan.
- `close_db()` — close connection. Called from FastAPI lifespan.
- `insert_feedback(data: dict) -> int` — insert row, return ID.
- `insert_session_log(data: dict) -> int` — insert row, return ID.
- `query(sql: str, params: tuple) -> list[dict]` — generic read helper for triage queries.

---

## Server Endpoint

### `POST /api/feedback`

**Location:** `server/src/api/app.py`

**Request body** (JSON):

```json
{
  "category": "bug",
  "message": "Audio cuts out after 5 minutes in lockstep mode",
  "email": "user@example.com",
  "company_fax": "",
  "page": "game",
  "context": {
    "url": "/play.html?room=ABC123",
    "roomCode": "ABC123",
    "playerSlot": 0,
    "mode": "lockstep",
    "peerCount": 2,
    "peerStates": {"sid1": "connected", "sid2": "connected"},
    "sessionStats": {"reconnects": 0, "desyncs": 1, "stalls": 0},
    "playerName": "Agent 21",
    "userAgent": "Mozilla/5.0 ...",
    "timestamp": 1712000000
  }
}
```

**Validation** (Pydantic model in `payloads.py`):

```python
class FeedbackPayload(BaseModel):
    category: Literal["bug", "feature", "general"]
    message: str = Field(min_length=1, max_length=2000)
    email: str | None = Field(default=None, max_length=254)
    company_fax: str | None = None  # honeypot
    page: str | None = Field(default=None, max_length=20)
    context: dict | None = None
```

**Endpoint logic:**

1. Rate limit check — `check_ip(ip, "feedback")` with limit `(5, 3600)` (5 per hour per IP)
2. Parse and validate body with `FeedbackPayload`
3. Honeypot check — if `company_fax` field is non-empty, return `{"status": "saved", "id": 0}` (200 OK, silent discard)
4. Context size check — serialize `context` to JSON; if over 4KB, drop the `context` field entirely (set to `null`) rather than truncating (truncated JSON is invalid)
5. Hash IP — `SHA256(ip + salt)` stored as `ip_hash` for rate correlation without tracking. Salt is read from `IP_HASH_SALT` env var; if unset, generate a random salt on startup and log a warning (rate correlation won't survive restarts, which is acceptable)
6. Insert into `feedback` table via `db.insert_feedback()`
7. Return `{"status": "saved", "id": <row_id>}`

**Rate limit addition** to `ratelimit.py`:

```python
"feedback": (5, 3600),  # 5 submissions per hour per IP
```

**Note:** The existing `cleanup()` function in `ratelimit.py` prunes entries older than 120 seconds, which would prematurely evict feedback timestamps. The cleanup threshold must be updated to respect the longest configured window (3600s for feedback).

### `GET /admin/api/feedback`

**Auth:** `x-admin-key` header (existing `_admin_auth()` pattern)

**Query parameters:**

| Param | Default | Description |
|---|---|---|
| `category` | all | Filter by `bug`, `feature`, or `general` |
| `days` | 30 | Only return entries from the last N days |
| `limit` | 50 | Max entries to return (cap at 200) |
| `offset` | 0 | Pagination offset |

**Response:**

```json
{
  "total": 42,
  "entries": [
    {
      "id": 1,
      "category": "bug",
      "message": "Audio cuts out after 5 minutes",
      "email": "user@example.com",
      "page": "game",
      "context": { ... },
      "created_at": "2026-04-01 12:00:00"
    }
  ]
}
```

### `GET /admin/api/feedback/{id}`

**Auth:** `x-admin-key` header

Returns a single feedback entry with full context. 404 if not found.

---

## Client: `feedback.js`

### Pattern

IIFE wrapping (matches existing codebase convention — no ES modules). Loaded via `<script>` tag on all pages.

### Floating Action Button (FAB)

- Circular button, fixed position bottom-right corner
- Icon: 💬 with "Send Feedback" tooltip on hover
- Styled to match kaillera-next dark theme (background `#e94560`, shadow glow)
- **Game page behavior:** During active gameplay (detected via presence of `#toolbar` and emulator canvas), the FAB is hidden. A "Feedback" menu item is added to the `#more-dropdown` menu (after "Dump Logs", before "End Game"). When the game ends and the toolbar is removed, the FAB reappears.
- **All other pages:** FAB is always visible

### Modal Form

Opens when FAB (or toolbar menu item) is clicked. Contains:

1. **Header** — "Send Feedback" with close button (✕)
2. **Category selector** — three toggle buttons: "🐛 Bug Report" / "💡 Feature" / "💬 General". One active at a time, default none (required).
3. **Message textarea** — placeholder text changes based on category:
   - Bug: "What happened? Steps to reproduce if possible..."
   - Feature: "What would you like to see?"
   - General: "What's on your mind?"
4. **Email field** — optional, placeholder "Email (optional, for follow-up)"
5. **Honeypot field** — `<input name="company_fax" tabindex="-1" autocomplete="off" aria-hidden="true">` positioned off-screen via CSS (using obscure name to avoid browser autofill false positives)
6. **Context indicator** — small green dot + "Session context will be attached automatically" (informational, not editable)
7. **Submit button** — "Send Feedback", disabled until category selected and message non-empty

### Auto-Captured Context

Silently attached to submission. Reads from `KNState` and DOM:

| Field | Source | Available on |
|---|---|---|
| `url` | `window.location.href` | all pages |
| `page` | detected from URL path | all pages |
| `roomCode` | `KNState.room` | lobby, game |
| `playerSlot` | `KNState.slot` | game |
| `mode` | `new URLSearchParams(location.search).get('mode')` | game |
| `peerCount` | `Object.keys(KNState.peers).length` | game |
| `peerStates` | peer connection states | game |
| `sessionStats` | `KNState.sessionStats` | game |
| `playerName` | localStorage `kaillera-name` | all pages |
| `userAgent` | `navigator.userAgent` | all pages |
| `timestamp` | `Date.now()` | all pages |

Fields that aren't available on a given page are simply omitted from the context object.

### Submission Flow

1. Validate client-side (category required, message non-empty)
2. Build JSON payload with form data + auto-captured context
3. `POST /api/feedback` with `Content-Type: application/json`
4. On success (200): close modal, show toast "Thanks for your feedback!"
5. On rate limit (429): show toast "Please wait before submitting again"
6. On error: show toast "Submission failed, please try again"

### Styling

- All CSS scoped via a wrapper class (e.g., `.kn-feedback`) to avoid conflicts
- Dark theme consistent with existing kaillera-next aesthetic
- Modal uses backdrop overlay with click-outside-to-close
- Responsive — works on mobile (modal goes full-width on small screens)
- No external CSS dependencies

---

## File Changes

### New Files

| File | Purpose |
|---|---|
| `server/src/db.py` | aiosqlite connection management, migration runner, query helpers |
| `server/alembic.ini` | Alembic configuration |
| `server/alembic/env.py` | Alembic environment (SQLite connection) |
| `server/alembic/versions/0001_initial.py` | Initial schema: feedback + session_logs tables |
| `web/static/feedback.js` | FAB button + modal form + submission logic |

### Modified Files

| File | Change |
|---|---|
| `server/src/api/app.py` | Add `POST /api/feedback` endpoint, integrate FastAPI lifespan with db init/close |
| `server/src/api/payloads.py` | Add `FeedbackPayload` Pydantic model |
| `server/src/ratelimit.py` | Add `"feedback": (5, 3600)` rate limit; adjust `cleanup()` to respect longer windows |
| `server/pyproject.toml` | Add `aiosqlite` and `alembic` dependencies |
| `docker-compose.prod.yml` | Add `data/` volume mount for SQLite persistence |
| `web/index.html` | Add `<script src="/static/feedback.js"></script>` |
| `web/play.html` | Add `<script src="/static/feedback.js"></script>` |

---

## Security

| Threat | Mitigation |
|---|---|
| Spam bots | Honeypot field (hidden input, silent discard if filled) |
| Flood attacks | Per-IP rate limiting (5/hr) via existing ratelimit.py |
| Oversized payloads | Pydantic validation (message max 2000 chars), context JSON capped at 4KB |
| SQL injection | Parameterized queries via aiosqlite (never string interpolation) |
| XSS in stored feedback | Feedback is stored as data, never rendered as HTML. Claude reads it as text. |
| IP tracking | IPs are SHA256-hashed with a salt before storage. Raw IPs are never persisted. |
| Directory traversal | N/A — SQLite database, no user-controlled file paths |

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `aiosqlite` | pin exact | Async SQLite for FastAPI |
| `alembic` | pin exact | Database schema migrations |
| `sqlalchemy` | `>=2.0.0` | Required by Alembic for migration execution |

All are well-established PyPI packages. Pin exact versions where practical in `pyproject.toml` to mitigate supply chain risk.

---

## What This Spec Does NOT Cover

- **Session log capture improvements** — separate spec (designs the `session_logs` table usage, guaranteed capture via beacon/visibilitychange, PostHog integration)
- **Admin UI for feedback** — not needed; Claude queries via admin API endpoints
- **PostHog feedback events** — may add a lightweight event (category + timestamp) later
- **Email notifications** — not in scope
