# Deployment Readiness Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare kaillera-next for production deployment with configurable env vars, reliable log capture on browser close, log management admin page, and automated log cleanup.

**Architecture:** Server-side changes extract hardcoded values to env vars and add admin API endpoints for log management. Client-side adds `navigator.sendBeacon()` + localStorage fallback to capture logs on unexpected tab close. A simple admin page at `/admin` provides log viewing, pinning, and deletion. Background task handles log retention.

**Tech Stack:** Python FastAPI (server), vanilla JS/HTML/CSS (admin page), `navigator.sendBeacon` (browser API)

---

## File Structure

**Modified files:**
- `server/src/main.py` — Read PORT env var, start log cleanup task
- `server/src/api/signaling.py` — Read MAX_ROOMS, MAX_SPECTATORS from env vars
- `server/src/ratelimit.py` — Add rate limits for debug-sync, debug-logs, sync-logs
- `server/src/api/app.py` — Admin API endpoints, auth, log management helpers
- `web/static/play.js` — sendBeacon + localStorage on pagehide, pending log upload on load
- `web/static/lobby.js` — Pending log upload on page load
- `web/index.html` — Add note about admin page (no functional change)
- `Dockerfile` — Add PORT/ADMIN_KEY/LOG_RETENTION_DAYS env vars, update healthcheck, add logs volume

**New files:**
- `web/admin.html` — Admin page HTML
- `web/static/admin.js` — Admin page logic (auth, log list, viewer, pin/delete)
- `web/static/admin.css` — Admin page styling (matches existing dark theme)

---

## Chunk 1: Server Configuration

### Task 1: Extract PORT, MAX_ROOMS, MAX_SPECTATORS to env vars

**Files:**
- Modify: `server/src/main.py:92-96`
- Modify: `server/src/api/signaling.py:56-57`
- Modify: `Dockerfile:22-28`

- [ ] **Step 1: Add PORT env var to main.py**

In `server/src/main.py`, replace the hardcoded port:

```python
# Line 92 — change the log line and uvicorn.run call:
    port = int(os.environ.get("PORT", "27888"))
    log.info("kaillera-next · continuing the legacy of Kaillera by Christophe Thibault")
    log.info("Listening on :%d (loop=%s)", port, loop_setting)
    uvicorn.run(
        socket_app,
        host="0.0.0.0",
        port=port,
```

- [ ] **Step 2: Add MAX_ROOMS and MAX_SPECTATORS env vars to signaling.py**

In `server/src/api/signaling.py`, replace lines 56-57:

```python
MAX_ROOMS = int(os.environ.get("MAX_ROOMS", "100"))
MAX_SPECTATORS = int(os.environ.get("MAX_SPECTATORS", "20"))
```

Add `import os` at the top of signaling.py (it's not currently imported there — the existing `os` usages in debug-sync/debug-logs use inline imports).

```python
# Add after line 4 (after "import asyncio"):
import os
```

Remove the inline `import os` from `debug_sync` (line 646) and `debug_logs` (line 686) since os is now imported at module level.

- [ ] **Step 3: Update Dockerfile**

```dockerfile
# Replace lines 22-28:
# Default env — override in production
ENV ALLOWED_ORIGIN="" \
    PORT=27888 \
    MAX_ROOMS=100 \
    MAX_SPECTATORS=20 \
    ADMIN_KEY="" \
    LOG_RETENTION_DAYS=14

EXPOSE 27888

# Create logs directory with correct ownership before switching to non-root
RUN mkdir -p /app/server/logs/sync && chown -R appuser:appuser /app/server/logs

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','27888')+'/health')"
```

Note: The `RUN mkdir` must come before `USER appuser` but after `chown -R appuser:appuser /app`. Looking at the existing Dockerfile, the `chown` is on line 19 and `USER appuser` is on line 20. Insert the `mkdir` + logs `chown` between the existing `chown` and `USER` lines:

```dockerfile
RUN groupadd -r appuser && useradd -r -g appuser -s /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app \
    && mkdir -p /app/server/logs/sync
USER appuser
```

- [ ] **Step 4: Verify server starts with defaults**

```bash
cd /Users/kazon/kaillera-next/server && python -c "from src.main import run; print('imports ok')"
```

- [ ] **Step 5: Commit**

```bash
git add server/src/main.py server/src/api/signaling.py Dockerfile
git commit -m "feat: extract PORT, MAX_ROOMS, MAX_SPECTATORS to env vars with defaults"
```

---

### Task 2: Add rate limits for debug-sync, debug-logs, sync-logs

**Files:**
- Modify: `server/src/ratelimit.py:11-22`
- Modify: `server/src/api/signaling.py:649,667`

- [ ] **Step 1: Add rate limit entries**

In `server/src/ratelimit.py`, add three entries to `_LIMITS`:

```python
_LIMITS: dict[str, tuple[int, float]] = {
    "connect": (30, 60),
    "open-room": (5, 60),
    "join-room": (20, 60),
    "snapshot": (2, 1),
    "data-message": (60, 1),
    "room-lookup": (10, 60),
    "webrtc-signal": (60, 1),
    "input": (120, 1),
    "rom-signal": (60, 1),
    "cache-state": (5, 60),
    "sync-logs": (10, 60),        # log uploads (normal + beacon + recovery)
    "debug-sync": (5, 1),         # real-time sync status (DEBUG_MODE only)
    "debug-logs": (5, 60),        # debug console dump
}
```

- [ ] **Step 2: Use dedicated rate limit keys in signaling.py**

In `server/src/api/signaling.py`, change the debug event handlers to use their own rate limit keys instead of borrowing `data-message`:

Line 649 — change `check(sid, "data-message")` to `check(sid, "debug-sync")`:
```python
    if not check(sid, "debug-sync"):
```

Line 667 — change `check(sid, "data-message")` to `check(sid, "debug-logs")`:
```python
    if not check(sid, "debug-logs"):
```

- [ ] **Step 3: Commit**

```bash
git add server/src/ratelimit.py server/src/api/signaling.py
git commit -m "feat: add dedicated rate limits for debug-sync, debug-logs, sync-logs"
```

---

## Chunk 2: Reliable Log Capture

### Task 3: Add sendBeacon + localStorage log capture on browser close

**Files:**
- Modify: `web/static/play.js:78-89` (pagehide handler)

- [ ] **Step 1: Expand the existing pagehide handler**

The existing pagehide handler at line 80 only notifies peers. Add log capture after the peer notification:

```javascript
  window.addEventListener('pagehide', () => {
    // Notify peers this is intentional so they skip the 15s reconnect wait
    if (engine && KNState.peers) {
      for (const p of Object.values(KNState.peers)) {
        if (p.dc?.readyState === 'open') {
          try { p.dc.send('leaving'); } catch (_) {}
        }
      }
    }

    // Capture sync logs before page unloads
    if (!engine) return;
    const logs = engine.exportSyncLog?.();
    if (!logs) return;
    const room = roomCode ?? 'unknown';
    const slot = window._playerSlot ?? 'x';

    // Store full log in localStorage for reliable recovery on next visit
    try {
      localStorage.setItem('kn-pending-log', JSON.stringify({ room, slot, logs, ts: Date.now() }));
    } catch (_) {}

    // Also fire sendBeacon with truncated log (browsers cap at ~64KB)
    const MAX_BEACON = 60000;
    const beaconLog = logs.length > MAX_BEACON
      ? logs.slice(logs.indexOf('\n', logs.length - MAX_BEACON) + 1)
      : logs;
    const url = `/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}&src=beacon`;
    try { navigator.sendBeacon(url, new Blob([beaconLog], { type: 'text/plain' })); } catch (_) {}
  });
```

Note the `logs.indexOf('\n', logs.length - MAX_BEACON) + 1` — this finds the nearest newline boundary so we don't cut a log entry in half.

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "feat: capture sync logs on browser close via sendBeacon + localStorage"
```

---

### Task 4: Upload pending logs on page load

**Files:**
- Modify: `web/static/play.js` (add at top of IIFE, before socket connect)
- Modify: `web/static/lobby.js` (add pending log upload)

- [ ] **Step 1: Add pending log recovery to play.js**

Add this right after the IIFE opening and variable declarations (around line 75, before the pagehide handler):

```javascript
  // ── Recover pending logs from previous session ───────────────────────
  try {
    const pending = localStorage.getItem('kn-pending-log');
    if (pending) {
      localStorage.removeItem('kn-pending-log');
      const { room, slot, logs } = JSON.parse(pending);
      if (logs) {
        fetch(`/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}&src=recovery`, {
          method: 'POST', body: logs, headers: { 'Content-Type': 'text/plain' },
        }).then(() => console.log('[play] recovered pending sync log'))
          .catch(() => {});
      }
    }
  } catch (_) {}
```

- [ ] **Step 2: Add pending log recovery to lobby.js**

Add at the top of lobby.js (the lobby page is the most common landing page after a browser close):

```javascript
  // Recover pending sync logs from a previous game session that closed unexpectedly
  try {
    const pending = localStorage.getItem('kn-pending-log');
    if (pending) {
      localStorage.removeItem('kn-pending-log');
      const { room, slot, logs } = JSON.parse(pending);
      if (logs) {
        fetch(`/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}&src=recovery`, {
          method: 'POST', body: logs, headers: { 'Content-Type': 'text/plain' },
        }).then(() => console.log('[lobby] recovered pending sync log'))
          .catch(() => {});
      }
    }
  } catch (_) {}
```

- [ ] **Step 3: Clear pending log on successful normal upload**

In play.js `uploadSyncLogs` function (line 1821), add localStorage cleanup after successful upload so the pagehide handler doesn't re-upload stale data:

```javascript
  const uploadSyncLogs = (trigger) => {
    const logs = engine?.exportSyncLog?.();
    if (!logs) return;
    const slot = window._playerSlot ?? 'x';
    const room = roomCode ?? 'unknown';
    const url = `/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}`;
    fetch(url, { method: 'POST', body: logs, headers: { 'Content-Type': 'text/plain' } })
      .then((res) => {
        if (res.ok) {
          console.log(`[play] sync logs uploaded (${trigger}, ${Math.round(logs.length / 1024)}KB)`);
          showToast?.('Logs uploaded');
          // Clear any pending log since we just uploaded successfully
          try { localStorage.removeItem('kn-pending-log'); } catch (_) {}
        } else {
          console.log(`[play] sync log upload failed: ${res.status}`);
          showToast?.(`Log upload failed: ${res.status}`);
        }
      })
      .catch((err) => {
        console.log('[play] sync log upload error:', err);
        showToast?.('Log upload failed');
      });
  };
```

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js web/static/lobby.js
git commit -m "feat: recover and upload pending sync logs on page load"
```

---

## Chunk 3: Admin Page + Log Management

### Task 5: Add admin API endpoints + log cleanup

**Files:**
- Modify: `server/src/api/app.py` — Add admin API endpoints, auth helper, cleanup task, pin helpers
- Modify: `server/src/main.py` — Start cleanup task in lifespan

Admin API endpoints:
- `GET /admin/api/stats` — Server stats (rooms, players, log count/size)
- `GET /admin/api/logs` — List all sync log files with metadata
- `GET /admin/api/logs/{filename}` — Get log file content
- `POST /admin/api/logs/{filename}/pin` — Pin a log file
- `DELETE /admin/api/logs/{filename}/pin` — Unpin a log file
- `DELETE /admin/api/logs/{filename}` — Delete a log file

Auth: If `ADMIN_KEY` env var is set, all `/admin/api/*` endpoints require `X-Admin-Key` header matching the key. If not set, admin is open (home server friendly).

- [ ] **Step 1: Add admin auth dependency and pin helpers to app.py**

Add these imports at the top of `server/src/api/app.py`:

```python
import hmac
```

Add these helpers inside `create_app()`, after the sync-logs endpoint:

```python
    # ── Admin helpers ─────────────────────────────────────────────────

    def _admin_auth(request: Request) -> None:
        admin_key = os.environ.get("ADMIN_KEY")
        if not admin_key:
            return
        key = request.headers.get("x-admin-key") or request.query_params.get("key")
        if not key or not hmac.compare_digest(admin_key, key):
            raise HTTPException(status_code=401, detail="Invalid admin key")

    def _pinned_set() -> set[str]:
        pinned_file = _SYNC_LOG_DIR / ".pinned.json"
        if pinned_file.exists():
            try:
                return set(json.loads(pinned_file.read_text()))
            except (json.JSONDecodeError, TypeError):
                pass
        return set()

    def _save_pinned(pinned: set[str]) -> None:
        _SYNC_LOG_DIR.mkdir(parents=True, exist_ok=True)
        (_SYNC_LOG_DIR / ".pinned.json").write_text(json.dumps(sorted(pinned)))

    def _safe_filename(filename: str) -> Path:
        """Validate filename to prevent directory traversal."""
        if "/" in filename or "\\" in filename or ".." in filename:
            raise HTTPException(status_code=400, detail="Invalid filename")
        if not filename.startswith("sync-") or not filename.endswith(".log"):
            raise HTTPException(status_code=400, detail="Invalid log filename")
        path = _SYNC_LOG_DIR / filename
        if not path.exists():
            raise HTTPException(status_code=404, detail="Log not found")
        return path
```

- [ ] **Step 2: Add admin API endpoints to app.py**

Add these routes inside `create_app()`, after the admin helpers:

```python
    # ── Admin API ─────────────────────────────────────────────────────

    @app.get("/admin/api/stats")
    def admin_stats(request: Request) -> dict:
        _admin_auth(request)
        total_players = sum(len(r.players) for r in rooms.values())
        total_spectators = sum(len(r.spectators) for r in rooms.values())
        log_files = list(_SYNC_LOG_DIR.glob("sync-*.log")) if _SYNC_LOG_DIR.exists() else []
        total_size = sum(f.stat().st_size for f in log_files)
        return {
            "rooms": len(rooms),
            "players": total_players,
            "spectators": total_spectators,
            "max_rooms": int(os.environ.get("MAX_ROOMS", "100")),
            "log_count": len(log_files),
            "log_size_bytes": total_size,
            "retention_days": int(os.environ.get("LOG_RETENTION_DAYS", "14")),
            "auth_required": bool(os.environ.get("ADMIN_KEY")),
        }

    @app.get("/admin/api/logs")
    def admin_list_logs(request: Request) -> list:
        _admin_auth(request)
        if not _SYNC_LOG_DIR.exists():
            return []
        pinned = _pinned_set()
        result = []
        for f in sorted(_SYNC_LOG_DIR.glob("sync-*.log"), key=lambda p: p.stat().st_mtime, reverse=True):
            stat = f.stat()
            # Parse filename: sync-p{slot}-{room}-{ts}[-{src}].log
            parts = f.stem.split("-")  # ['sync', 'p0', 'ROOM', 'TIMESTAMP', ...]
            slot = parts[1][1:] if len(parts) > 1 else "?"
            room_code = parts[2] if len(parts) > 2 else "?"
            ts = parts[3] if len(parts) > 3 else "0"
            src = parts[4] if len(parts) > 4 else "normal"
            result.append({
                "filename": f.name,
                "size": stat.st_size,
                "created": int(stat.st_mtime),
                "slot": slot,
                "room": room_code,
                "source": src,
                "pinned": f.name in pinned,
            })
        return result

    @app.get("/admin/api/logs/{filename}")
    def admin_get_log(filename: str, request: Request) -> Response:
        _admin_auth(request)
        path = _safe_filename(filename)
        return Response(content=path.read_text(errors="replace"), media_type="text/plain")

    @app.post("/admin/api/logs/{filename}/pin")
    def admin_pin_log(filename: str, request: Request) -> dict:
        _admin_auth(request)
        _safe_filename(filename)
        pinned = _pinned_set()
        pinned.add(filename)
        _save_pinned(pinned)
        return {"status": "pinned"}

    @app.delete("/admin/api/logs/{filename}/pin")
    def admin_unpin_log(filename: str, request: Request) -> dict:
        _admin_auth(request)
        _safe_filename(filename)
        pinned = _pinned_set()
        pinned.discard(filename)
        _save_pinned(pinned)
        return {"status": "unpinned"}

    @app.delete("/admin/api/logs/{filename}")
    def admin_delete_log(filename: str, request: Request) -> dict:
        _admin_auth(request)
        path = _safe_filename(filename)
        pinned = _pinned_set()
        pinned.discard(filename)
        _save_pinned(pinned)
        path.unlink()
        return {"status": "deleted"}
```

- [ ] **Step 3: Add log cleanup task to app.py**

Add this async function inside `create_app()` (or at module level — module level is cleaner since main.py needs to import it):

Actually, add it at **module level** in `app.py`, after the imports:

```python
async def cleanup_old_logs() -> None:
    """Background task: delete non-pinned logs older than LOG_RETENTION_DAYS."""
    while True:
        await asyncio.sleep(3600)
        try:
            retention = int(os.environ.get("LOG_RETENTION_DAYS", "14"))
            log_dir = Path(os.environ.get("SYNC_LOG_DIR", "logs/sync"))
            if not log_dir.exists():
                continue
            pinned: set[str] = set()
            pinned_file = log_dir / ".pinned.json"
            if pinned_file.exists():
                try:
                    pinned = set(json.loads(pinned_file.read_text()))
                except (json.JSONDecodeError, TypeError):
                    pass
            cutoff = time.time() - (retention * 86400)
            cleaned = 0
            for f in log_dir.glob("sync-*.log"):
                if f.name in pinned:
                    continue
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    cleaned += 1
            if cleaned:
                log.info("Log cleanup: removed %d expired log(s)", cleaned)
        except Exception as e:
            log.warning("Log cleanup error: %s", e)
```

Add `import asyncio` to the imports at the top of app.py.

- [ ] **Step 4: Start cleanup task in main.py lifespan**

In `server/src/main.py`, add the cleanup task to the lifespan:

```python
from src.api.app import create_app, cleanup_old_logs

@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(_cleanup_empty_rooms())
    log_task = asyncio.create_task(cleanup_old_logs())
    yield
    task.cancel()
    log_task.cancel()
    # ... rest of shutdown logic unchanged
```

- [ ] **Step 5: Verify server starts and admin endpoints respond**

```bash
cd /Users/kazon/kaillera-next/server && python -c "
from src.api.app import create_app
app = create_app()
print('Admin endpoints registered:', [r.path for r in app.routes if hasattr(r, 'path') and '/admin/' in r.path])
"
```

- [ ] **Step 6: Commit**

```bash
git add server/src/api/app.py server/src/main.py
git commit -m "feat: add admin API endpoints for log management with pin/cleanup"
```

---

### Task 6: Admin page UI

**Files:**
- Create: `web/admin.html`
- Create: `web/static/admin.css`
- Create: `web/static/admin.js`

The admin page matches the existing dark theme (colors from lobby.css) and provides:
- Server stats panel (rooms, players, log count/size)
- Log list table with sortable columns
- Inline log viewer (click to expand)
- Pin/unpin toggle per log
- Delete with confirmation
- Auth prompt if ADMIN_KEY is configured

- [ ] **Step 1: Create admin.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>kaillera-next admin</title>
  <link rel="stylesheet" href="/static/admin.css">
</head>
<body>
  <div id="auth-prompt" class="card hidden">
    <h1>kaillera-next admin</h1>
    <input id="admin-key-input" type="password" placeholder="Admin key" autocomplete="off">
    <button id="auth-btn">Authenticate</button>
    <p id="auth-error" class="error hidden">Invalid key</p>
  </div>

  <div id="admin-panel" class="hidden">
    <header>
      <h1><a href="/">kaillera-next</a> <span class="dim">admin</span></h1>
      <button id="refresh-btn" title="Refresh">Refresh</button>
    </header>

    <div class="stats-row" id="stats-row"></div>

    <div class="log-section">
      <div class="log-header">
        <h2>Sync Logs</h2>
        <div class="log-actions">
          <button id="cleanup-btn" class="btn-danger" title="Delete all unpinned logs past retention">Run Cleanup Now</button>
        </div>
      </div>
      <table id="log-table">
        <thead>
          <tr>
            <th>Pin</th>
            <th>Room</th>
            <th>Slot</th>
            <th>Source</th>
            <th>Size</th>
            <th>Date</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="log-body"></tbody>
      </table>
      <p id="no-logs" class="dim hidden">No sync logs found.</p>
    </div>

    <div id="log-viewer" class="hidden">
      <div class="viewer-header">
        <h3 id="viewer-title"></h3>
        <button id="viewer-close">Close</button>
      </div>
      <pre id="viewer-content"></pre>
    </div>
  </div>

  <script src="/static/admin.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create admin.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: #111;
  color: #eee;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  padding: 20px;
  max-width: 1000px;
  margin: 0 auto;
}

.hidden { display: none !important; }
.dim { color: #666; }
.error { color: #e55; font-size: 13px; margin-top: 8px; }

/* Auth prompt */
.card {
  background: #1a1a2e;
  border: 1px solid #2a2a40;
  border-radius: 12px;
  padding: 2rem;
  max-width: 360px;
  margin: 20vh auto;
  text-align: center;
}

.card input {
  display: block;
  width: 100%;
  padding: 12px;
  margin: 16px 0;
  background: #0d0d1a;
  border: 1px solid #333;
  border-radius: 6px;
  color: #eee;
  font-size: 14px;
}

.card input:focus { outline: none; border-color: #4a6fa5; }

/* Header */
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid #2a2a40;
}

header h1 { font-size: 1.3rem; letter-spacing: 0.05em; }
header h1 a { color: #6af; text-decoration: none; }
header h1 .dim { font-weight: normal; }

/* Buttons */
button {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: #3a5a8a;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

button:hover { background: #4a6fa5; }
button.btn-danger { background: #6a2a2a; }
button.btn-danger:hover { background: #8a3a3a; }
button.btn-small { padding: 4px 10px; font-size: 12px; }
button.btn-pin { background: transparent; border: 1px solid #555; font-size: 16px; padding: 2px 8px; }
button.btn-pin.pinned { border-color: #fa0; color: #fa0; }

/* Stats */
.stats-row {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.stat-card {
  background: #1a1a2e;
  border: 1px solid #2a2a40;
  border-radius: 8px;
  padding: 14px 20px;
  flex: 1;
  min-width: 120px;
}

.stat-card .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
.stat-card .value { font-size: 1.4rem; font-weight: bold; color: #6af; margin-top: 4px; }

/* Log table */
.log-section { background: #1a1a2e; border: 1px solid #2a2a40; border-radius: 8px; padding: 16px; }
.log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.log-header h2 { font-size: 1rem; }
.log-actions { display: flex; gap: 8px; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th { text-align: left; padding: 8px; border-bottom: 1px solid #333; color: #888; font-weight: normal; font-size: 11px; text-transform: uppercase; }
tbody td { padding: 8px; border-bottom: 1px solid #1e1e30; }
tbody tr:hover { background: #222240; }
tbody tr { cursor: pointer; }

.source-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  background: #2a2a40;
}
.source-badge.beacon { background: #3a3a20; color: #fa0; }
.source-badge.recovery { background: #2a3a2a; color: #6f6; }

/* Log viewer */
#log-viewer {
  margin-top: 16px;
  background: #0d0d1a;
  border: 1px solid #2a2a40;
  border-radius: 8px;
  overflow: hidden;
}

.viewer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #1a1a2e;
  border-bottom: 1px solid #2a2a40;
}

.viewer-header h3 { font-size: 13px; font-weight: normal; }

#viewer-content {
  padding: 16px;
  max-height: 60vh;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  tab-size: 4;
}
```

- [ ] **Step 3: Create admin.js**

```javascript
(function () {
  'use strict';

  let adminKey = localStorage.getItem('kn-admin-key') || '';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Auth ──────────────────────────────────────────────────────────────

  const headers = () => adminKey ? { 'X-Admin-Key': adminKey } : {};

  const checkAuth = async () => {
    const res = await fetch('/admin/api/stats', { headers: headers() });
    if (res.status === 401) {
      $('#auth-prompt').classList.remove('hidden');
      $('#admin-panel').classList.add('hidden');
      return false;
    }
    const data = await res.json();
    if (data.auth_required && !adminKey) {
      $('#auth-prompt').classList.remove('hidden');
      $('#admin-panel').classList.add('hidden');
      return false;
    }
    $('#auth-prompt').classList.add('hidden');
    $('#admin-panel').classList.remove('hidden');
    return true;
  };

  $('#auth-btn').addEventListener('click', async () => {
    adminKey = $('#admin-key-input').value.trim();
    localStorage.setItem('kn-admin-key', adminKey);
    const ok = await checkAuth();
    if (!ok) {
      $('#auth-error').classList.remove('hidden');
      localStorage.removeItem('kn-admin-key');
      adminKey = '';
    } else {
      $('#auth-error').classList.add('hidden');
      loadAll();
    }
  });

  $('#admin-key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#auth-btn').click();
  });

  // ── Stats ─────────────────────────────────────────────────────────────

  const formatBytes = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const loadStats = async () => {
    const res = await fetch('/admin/api/stats', { headers: headers() });
    if (!res.ok) return;
    const s = await res.json();
    $('#stats-row').innerHTML = [
      { label: 'Active Rooms', value: `${s.rooms} / ${s.max_rooms}` },
      { label: 'Players', value: s.players },
      { label: 'Spectators', value: s.spectators },
      { label: 'Log Files', value: s.log_count },
      { label: 'Log Size', value: formatBytes(s.log_size_bytes) },
      { label: 'Retention', value: `${s.retention_days}d` },
    ].map((c) => `<div class="stat-card"><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`).join('');
  };

  // ── Logs ──────────────────────────────────────────────────────────────

  const timeAgo = (ts) => {
    const diff = (Date.now() / 1000) - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  };

  let currentLogs = [];

  const loadLogs = async () => {
    const res = await fetch('/admin/api/logs', { headers: headers() });
    if (!res.ok) return;
    currentLogs = await res.json();
    renderLogs();
  };

  const renderLogs = () => {
    const tbody = $('#log-body');
    const noLogs = $('#no-logs');

    if (currentLogs.length === 0) {
      tbody.innerHTML = '';
      noLogs.classList.remove('hidden');
      return;
    }
    noLogs.classList.add('hidden');

    tbody.innerHTML = currentLogs.map((l) => {
      const srcClass = l.source !== 'normal' ? ` ${l.source}` : '';
      return `<tr data-filename="${l.filename}">
        <td><button class="btn-pin${l.pinned ? ' pinned' : ''}" data-action="pin" data-file="${l.filename}" title="${l.pinned ? 'Unpin' : 'Pin'}">${l.pinned ? '\u2605' : '\u2606'}</button></td>
        <td>${l.room}</td>
        <td>P${l.slot}</td>
        <td><span class="source-badge${srcClass}">${l.source}</span></td>
        <td>${formatBytes(l.size)}</td>
        <td title="${new Date(l.created * 1000).toLocaleString()}">${timeAgo(l.created)}</td>
        <td><button class="btn-small btn-danger" data-action="delete" data-file="${l.filename}">Delete</button></td>
      </tr>`;
    }).join('');
  };

  // ── Log viewer ────────────────────────────────────────────────────────

  const viewLog = async (filename) => {
    const viewer = $('#log-viewer');
    const content = $('#viewer-content');
    const title = $('#viewer-title');

    title.textContent = filename;
    content.textContent = 'Loading...';
    viewer.classList.remove('hidden');

    const res = await fetch(`/admin/api/logs/${encodeURIComponent(filename)}`, { headers: headers() });
    if (!res.ok) {
      content.textContent = `Error: ${res.status} ${res.statusText}`;
      return;
    }
    content.textContent = await res.text();
    viewer.scrollIntoView({ behavior: 'smooth' });
  };

  $('#viewer-close').addEventListener('click', () => {
    $('#log-viewer').classList.add('hidden');
  });

  // ── Actions ───────────────────────────────────────────────────────────

  const pinLog = async (filename, currentlyPinned) => {
    const method = currentlyPinned ? 'DELETE' : 'POST';
    await fetch(`/admin/api/logs/${encodeURIComponent(filename)}/pin`, { method, headers: headers() });
    await loadLogs();
  };

  const deleteLog = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return;
    await fetch(`/admin/api/logs/${encodeURIComponent(filename)}`, { method: 'DELETE', headers: headers() });
    // Close viewer if viewing this file
    if ($('#viewer-title').textContent === filename) {
      $('#log-viewer').classList.add('hidden');
    }
    await loadLogs();
  };

  // ── Event delegation ──────────────────────────────────────────────────

  $('#log-table').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) {
      e.stopPropagation();
      const file = btn.dataset.file;
      if (btn.dataset.action === 'pin') {
        const log = currentLogs.find((l) => l.filename === file);
        pinLog(file, log?.pinned);
      } else if (btn.dataset.action === 'delete') {
        deleteLog(file);
      }
      return;
    }
    // Click on row = view log
    const row = e.target.closest('tr[data-filename]');
    if (row) viewLog(row.dataset.filename);
  });

  $('#refresh-btn').addEventListener('click', loadAll);

  $('#cleanup-btn').addEventListener('click', async () => {
    if (!confirm('Delete all unpinned logs older than the retention period?')) return;
    // Trigger cleanup by calling the stats endpoint with a cleanup param
    await fetch('/admin/api/cleanup', { method: 'POST', headers: headers() });
    await loadAll();
  });

  // ── Init ──────────────────────────────────────────────────────────────

  const loadAll = async () => {
    await loadStats();
    await loadLogs();
  };

  const init = async () => {
    const ok = await checkAuth();
    if (ok) loadAll();
  };

  init();
})();
```

- [ ] **Step 4: Add the manual cleanup endpoint to app.py**

The admin.js `cleanup-btn` calls `POST /admin/api/cleanup`. Add this endpoint in app.py:

```python
    @app.post("/admin/api/cleanup")
    def admin_run_cleanup(request: Request) -> dict:
        _admin_auth(request)
        retention = int(os.environ.get("LOG_RETENTION_DAYS", "14"))
        if not _SYNC_LOG_DIR.exists():
            return {"deleted": 0}
        pinned = _pinned_set()
        cutoff = time.time() - (retention * 86400)
        deleted = 0
        for f in _SYNC_LOG_DIR.glob("sync-*.log"):
            if f.name in pinned:
                continue
            if f.stat().st_mtime < cutoff:
                f.unlink()
                deleted += 1
        log.info("Manual cleanup: removed %d expired log(s)", deleted)
        return {"deleted": deleted}
```

- [ ] **Step 5: Commit**

```bash
git add web/admin.html web/static/admin.js web/static/admin.css server/src/api/app.py
git commit -m "feat: add admin page for sync log management with pin/view/delete"
```

---

### Task 7: Final Dockerfile + integration verification

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Final Dockerfile**

The full updated Dockerfile:

```dockerfile
FROM python:3.13-slim-bookworm

# Prevent .pyc files and enable unbuffered output for logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first (layer caching)
COPY server/pyproject.toml server/
RUN pip install --no-cache-dir server/

# Copy application code
COPY server/ server/
COPY web/ web/

# Create non-root user and logs directory
RUN groupadd -r appuser && useradd -r -g appuser -s /usr/sbin/nologin appuser \
    && mkdir -p /app/server/logs/sync \
    && chown -R appuser:appuser /app
USER appuser

# Default env — override in production
ENV ALLOWED_ORIGIN="" \
    PORT=27888 \
    MAX_ROOMS=100 \
    MAX_SPECTATORS=20 \
    ADMIN_KEY="" \
    LOG_RETENTION_DAYS=14

EXPOSE 27888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','27888')+'/health')"

WORKDIR /app/server
CMD ["python", "-c", "from src.main import run; run()"]
```

- [ ] **Step 2: Manual verification checklist**

1. Start server: `cd server && python -c "from src.main import run; run()"`
2. Visit `http://localhost:27888/admin` — should see admin page
3. Check stats panel shows correct data
4. Open a game, play briefly, close tab — check that logs appear in admin
5. Pin a log, verify it shows star icon
6. Delete a log, verify it disappears
7. Check `logs/sync/.pinned.json` persists pinned files

- [ ] **Step 3: Final commit**

```bash
git add Dockerfile
git commit -m "feat: update Dockerfile with configurable env vars and logs directory"
```
