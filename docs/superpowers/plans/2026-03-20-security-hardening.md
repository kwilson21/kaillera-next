# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden kaillera-next for public deployment — restrict ROM access, lock down endpoints, prevent XSS/injection, add rate limiting, produce a Docker image.

**Architecture:** Server-side changes in Python (signaling.py, app.py, main.py) for validation/rate-limiting/CORS. Client-side changes in JS (play.js, lobby.js) for XSS prevention and ROM drag-and-drop. New Dockerfile for production deployment.

**Tech Stack:** Python 3.11+, FastAPI, python-socketio, vanilla JS, Docker

**Spec:** `docs/superpowers/specs/2026-03-20-security-hardening-design.md`

---

## Chunk 1: Server-Side Hardening (signaling.py)

### Task 1: Input validation helpers + Room dataclass cleanup

**Files:**
- Modify: `server/src/api/signaling.py`

- [ ] **Step 1: Add validation helpers and update Room dataclass**

Add at top of signaling.py after imports:

```python
import hmac
import re
import sys
import time

_ALNUM_RE = re.compile(r"^[A-Za-z0-9]+$")
_ALNUM_HYPHEN_RE = re.compile(r"^[A-Za-z0-9\-]+$")
_VALID_MODES = {"lockstep", "streaming"}


def _sanitize_str(value: str, max_len: int) -> str:
    """Strip angle brackets and truncate."""
    return re.sub(r"[<>]", "", str(value))[:max_len]
```

Remove `domain` field from `Room` dataclass (line 43). Update constructor calls in `open_room` to remove `domain=domain`.

- [ ] **Step 2: Apply validation to open-room handler**

In `open_room()`, after extracting fields, add:

```python
if not _ALNUM_RE.match(session_id) or not (3 <= len(session_id) <= 16):
    return "Invalid room code"
player_name = _sanitize_str(player_name, 32)
room_name = _sanitize_str(room_name, 64)
if not _ALNUM_HYPHEN_RE.match(game_id) or len(game_id) > 32:
    game_id = "unknown"
max_players = max(1, min(4, max_players))
```

Remove `domain` extraction line. Remove `domain=domain` from Room constructor.

- [ ] **Step 3: Apply validation to join-room handler**

In `join_room()`, add:

```python
player_name = _sanitize_str(player_name, 32)
```

Change password comparison to constant-time:

```python
if room.password and not hmac.compare_digest(room.password, password or ""):
    return ("Wrong password", None)
```

- [ ] **Step 4: Apply validation to start-game handler**

In `start_game()`, validate mode:

```python
mode = data.get("mode", "lockstep")
if mode not in _VALID_MODES:
    mode = "lockstep"
room.mode = mode
```

- [ ] **Step 5: Apply validation to claim-slot handler**

In `claim_slot()`, validate slot field:

```python
requested_slot = data.get("slot")
if requested_slot is not None:
    if not isinstance(requested_slot, int) or requested_slot < 0 or requested_slot > 3:
        return "Invalid slot"
    if requested_slot in room.slots:
        return "Slot already taken"
    slot = requested_slot
```

- [ ] **Step 6: Commit**

```
git add server/src/api/signaling.py
git commit -m "feat: add input validation and sanitization to signaling handlers"
```

### Task 2: WebRTC same-room validation + payload limits

**Files:**
- Modify: `server/src/api/signaling.py`

- [ ] **Step 1: Add room validation to webrtc_signal**

Replace `webrtc_signal` handler:

```python
@sio.on("webrtc-signal")
async def webrtc_signal(sid: str, data: dict) -> None:
    target: str | None = data.get("target")
    if not target:
        return
    # Validate sender and target are in the same room
    sender_entry = _sid_to_room.get(sid)
    target_entry = _sid_to_room.get(target)
    if not sender_entry or not target_entry:
        return
    if sender_entry[0] != target_entry[0]:
        return
    await sio.emit("webrtc-signal", {"sender": sid, **data}, to=target)
```

- [ ] **Step 2: Add payload size checks to data-message and snapshot**

```python
_MAX_RELAY_SIZE = 2 * 1024 * 1024  # 2MB

@sio.on("data-message")
async def data_message(sid: str, data: dict) -> None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return
    if sys.getsizeof(str(data)) > _MAX_RELAY_SIZE:
        return
    session_id = entry[0]
    await sio.emit("data-message", data, room=session_id, skip_sid=sid)

@sio.on("snapshot")
async def snapshot(sid: str, data: dict) -> None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return
    if sys.getsizeof(str(data)) > _MAX_RELAY_SIZE:
        return
    session_id = entry[0]
    await sio.emit("snapshot", data, room=session_id, skip_sid=sid)
```

- [ ] **Step 3: Reduce max_http_buffer_size**

Change Socket.IO server init:

```python
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",  # updated in Task 4
    max_http_buffer_size=4 * 1024 * 1024,  # 4MB (was 16MB)
)
```

- [ ] **Step 4: Commit**

```
git add server/src/api/signaling.py
git commit -m "feat: WebRTC same-room validation and payload size limits"
```

### Task 3: Rate limiting

**Files:**
- Create: `server/src/ratelimit.py`
- Modify: `server/src/api/signaling.py`

- [ ] **Step 1: Create rate limiter module**

```python
"""In-memory per-IP rate limiting with rolling window."""

from __future__ import annotations

import time
from collections import defaultdict

# {ip: {event: [timestamps]}}
_counters: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))

# {ip: count}
_connections: dict[str, int] = defaultdict(int)

# sid -> ip
_sid_ip: dict[str, str] = {}

_LIMITS: dict[str, tuple[int, float]] = {
    # event: (max_count, window_seconds)
    "connect": (30, 60),
    "open-room": (5, 60),
    "join-room": (20, 60),
    "snapshot": (2, 1),
    "data-message": (60, 1),
}

MAX_CONNECTIONS_PER_IP = 20


def register_sid(sid: str, ip: str) -> None:
    _sid_ip[sid] = ip
    _connections[ip] += 1


def unregister_sid(sid: str) -> None:
    ip = _sid_ip.pop(sid, None)
    if ip and _connections[ip] > 0:
        _connections[ip] -= 1


def check(sid: str, event: str) -> bool:
    """Return True if allowed, False if rate-limited."""
    ip = _sid_ip.get(sid, "unknown")
    limit = _LIMITS.get(event)
    if not limit:
        return True
    max_count, window = limit
    now = time.monotonic()
    timestamps = _counters[ip][event]
    # Prune old entries
    cutoff = now - window
    while timestamps and timestamps[0] < cutoff:
        timestamps.pop(0)
    if len(timestamps) >= max_count:
        return False
    timestamps.append(now)
    return True


def check_ip(ip: str, event: str) -> bool:
    """Rate-limit by IP directly (for HTTP endpoints)."""
    limit = _LIMITS.get(event)
    if not limit:
        return True
    max_count, window = limit
    now = time.monotonic()
    timestamps = _counters[ip][event]
    cutoff = now - window
    while timestamps and timestamps[0] < cutoff:
        timestamps.pop(0)
    if len(timestamps) >= max_count:
        return False
    timestamps.append(now)
    return True


def connection_allowed(ip: str) -> bool:
    return _connections.get(ip, 0) < MAX_CONNECTIONS_PER_IP


def cleanup() -> None:
    """Remove stale entries. Call periodically."""
    now = time.monotonic()
    stale_ips = []
    for ip, events in list(_counters.items()):
        for event, timestamps in list(events.items()):
            events[event] = [t for t in timestamps if now - t < 120]
            if not events[event]:
                del events[event]
        if not events:
            stale_ips.append(ip)
    for ip in stale_ips:
        del _counters[ip]
```

- [ ] **Step 2: Wire rate limiting into signaling.py**

In `connect` handler, extract IP and register:

```python
@sio.event
async def connect(sid: str, environ: dict) -> None:
    from src.ratelimit import register_sid, connection_allowed, check_ip
    # Extract IP (X-Forwarded-For from Cloudflare, or direct)
    forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
    ip = forwarded.split(",")[0].strip() if forwarded else environ.get("REMOTE_ADDR", "unknown")
    if not connection_allowed(ip):
        raise socketio.exceptions.ConnectionRefusedError("Too many connections")
    if not check_ip(ip, "connect"):
        raise socketio.exceptions.ConnectionRefusedError("Rate limited")
    register_sid(sid, ip)
    log.info("SIO connect %s (ip=%s)", sid, ip)
```

In `disconnect` handler, unregister:

```python
@sio.event
async def disconnect(sid: str) -> None:
    from src.ratelimit import unregister_sid
    log.info("SIO disconnect %s", sid)
    unregister_sid(sid)
    await _leave(sid)
```

Add rate checks to `open_room`, `join_room`, `data_message`, `snapshot`:

```python
# At top of open_room:
from src.ratelimit import check
if not check(sid, "open-room"):
    return "Rate limited"

# At top of join_room:
if not check(sid, "join-room"):
    return ("Rate limited", None)

# At top of data_message (before room lookup):
if not check(sid, "data-message"):
    return

# At top of snapshot (before room lookup):
if not check(sid, "snapshot"):
    return
```

Add periodic cleanup to `_cleanup_empty_rooms`:

```python
async def _cleanup_empty_rooms() -> None:
    while True:
        await asyncio.sleep(60)
        empty = [sid for sid, r in list(rooms.items()) if not r.players and not r.spectators]
        for sid in empty:
            del rooms[sid]
            log.debug("Cleanup: deleted empty room %s", sid)
        # Clean up rate limit counters
        from src.ratelimit import cleanup
        cleanup()
```

- [ ] **Step 3: Commit**

```
git add server/src/ratelimit.py server/src/api/signaling.py
git commit -m "feat: add in-memory rate limiting for Socket.IO events"
```

### Task 4: CORS lockdown

**Files:**
- Modify: `server/src/main.py`
- Modify: `server/src/api/signaling.py`

- [ ] **Step 1: Read ALLOWED_ORIGIN env var in main.py**

In `run()`, before creating the app:

```python
allowed_origin = os.environ.get("ALLOWED_ORIGIN", "*")
log.info("CORS allowed origin: %s", allowed_origin)
```

Pass it to signaling and app:

```python
from src.api.signaling import sio, _cleanup_empty_rooms, configure_cors
configure_cors(allowed_origin)
```

- [ ] **Step 2: Add configure_cors to signaling.py**

Replace the hardcoded `cors_allowed_origins="*"` with a function:

```python
def configure_cors(origin: str) -> None:
    sio.cors_allowed_origins = origin if origin != "*" else "*"
```

And set default in sio init:

```python
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",  # overridden by configure_cors()
    max_http_buffer_size=4 * 1024 * 1024,
)
```

- [ ] **Step 3: Commit**

```
git add server/src/main.py server/src/api/signaling.py
git commit -m "feat: configurable CORS via ALLOWED_ORIGIN env var"
```

## Chunk 2: Endpoint Hardening (app.py)

### Task 5: Strip join codes from /list, minimal /room response, remove /sessions

**Files:**
- Modify: `server/src/api/app.py`

- [ ] **Step 1: Rewrite /list to strip session IDs**

```python
@app.get("/list")
def list_rooms(game_id: str | None = None) -> list:
    result = []
    for session_id, room in rooms.items():
        if game_id and room.game_id != game_id:
            continue
        first_player = next(iter(room.players.values()), {})
        result.append({
            "room_name": room.room_name,
            "host_name": first_player.get("playerName", ""),
            "game_id": room.game_id,
            "player_count": len(room.players),
            "max_players": room.max_players,
            "status": room.status,
            "has_password": room.password is not None,
        })
    return result
```

- [ ] **Step 2: Minimize /room/{room_id} response + add rate limiting**

```python
from fastapi import Request

@app.get("/room/{room_id}")
def get_room(room_id: str, request: Request) -> dict:
    from src.ratelimit import check_ip
    client_ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "unknown").split(",")[0].strip()
    if not check_ip(client_ip, "room-lookup"):
        raise HTTPException(status_code=429, detail="Rate limited")
    room = rooms.get(room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return {
        "status": room.status,
        "player_count": len(room.players),
        "max_players": room.max_players,
        "has_password": room.password is not None,
    }
```

Add "room-lookup" to ratelimit `_LIMITS`:

```python
"room-lookup": (10, 60),
```

- [ ] **Step 3: Remove /sessions endpoints and related models**

Delete `CreateSessionRequest`, `PlayerInfo`, `SessionResponse`, `PlayerDetail`, `SessionDetail` models.

Delete `create_session` and `get_session` route handlers.

Remove `SessionManager` import and `session_mgr` parameter from `create_app`. Update signature to `def create_app() -> FastAPI:`.

Update `main.py` to call `create_app()` without args. Remove `SessionManager` import.

- [ ] **Step 4: Commit**

```
git add server/src/api/app.py server/src/main.py server/src/ratelimit.py
git commit -m "feat: strip join codes from /list, minimize /room response, remove /sessions"
```

### Task 6: Security headers middleware

**Files:**
- Modify: `server/src/api/app.py`

- [ ] **Step 1: Add security headers middleware**

In `create_app()`, after creating the FastAPI instance:

```python
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from starlette.responses import Response

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response: Response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' https://cdn.emulatorjs.org https://cdn.socket.io 'unsafe-eval' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "connect-src 'self' wss: ws: https://cdn.emulatorjs.org; "
            "img-src 'self' data: blob:; "
            "media-src 'self' blob:; "
            "worker-src 'self' blob: https://cdn.emulatorjs.org; "
            "font-src 'self' https://cdn.emulatorjs.org data:"
        )
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

app.add_middleware(SecurityHeadersMiddleware)
```

- [ ] **Step 2: Commit**

```
git add server/src/api/app.py
git commit -m "feat: add security headers middleware (CSP, X-Frame-Options, etc.)"
```

## Chunk 3: Client-Side Security

### Task 7: XSS prevention in play.js

**Files:**
- Modify: `web/static/play.js`

- [ ] **Step 1: Add escapeHtml helper**

Add near the top of the IIFE, after state variables:

```javascript
function escapeHtml(s) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(s));
  return div.innerHTML;
}
```

- [ ] **Step 2: Escape player names in diffForToasts**

Change all `showToast` calls in `diffForToasts` to escape names:

```javascript
showToast(escapeHtml(players[pid].playerName) + ' joined');
// ...
showToast(escapeHtml(previousPlayers[pid].playerName) + ' left');
// ...
showToast(escapeHtml(spectators[pid].playerName) + ' is watching');
// ...
showToast(escapeHtml(previousSpectators[pid].playerName) + ' left');
```

Note: `showToast` already uses `textContent` so it's safe, but escaping the input is defense-in-depth.

- [ ] **Step 3: Fix showError to avoid innerHTML XSS**

Replace `showError`:

```javascript
function showError(msg) {
  var el = document.getElementById('error-msg');
  if (!el) return;
  el.classList.remove('hidden');
  var card = el.querySelector('.error-card');
  if (!card) return;
  card.innerHTML = '';
  var h3 = document.createElement('h3');
  h3.textContent = 'Error';
  var p = document.createElement('p');
  p.textContent = msg;
  var a = document.createElement('a');
  a.href = '/';
  a.className = 'error-back';
  a.textContent = 'Back to Lobby';
  card.appendChild(h3);
  card.appendChild(p);
  card.appendChild(a);
}
```

Remove the `<a>` tag from inline `showError` call on line 82:

```javascript
showError('Room not found');
```

(The "Back to Lobby" link is now always added by `showError` itself.)

- [ ] **Step 4: Remove domain from open-room emit**

In `onConnect`, remove `domain: window.location.hostname` from the `open-room` emit payload.

- [ ] **Step 5: Commit**

```
git add web/static/play.js
git commit -m "feat: XSS prevention — escapeHtml, safe showError, remove domain field"
```

### Task 8: Room code entropy

**Files:**
- Modify: `web/static/lobby.js`

- [ ] **Step 1: Replace Math.random with crypto.getRandomValues**

Replace `randomCode()`:

```javascript
function randomCode() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  var code = '';
  for (var i = 0; i < 8; i++) {
    code += chars[arr[i] % chars.length];
  }
  return code;
}
```

Also update the room code regex in `getCode` to handle 8-char codes:

```javascript
var match = val.match(/room=([A-Za-z0-9]+)/);
```

(Already handles variable-length codes — no change needed.)

- [ ] **Step 2: Commit**

```
git add web/static/lobby.js
git commit -m "feat: use crypto.getRandomValues for 8-char room codes"
```

## Chunk 4: ROM Removal + Drag-and-Drop

### Task 9: Remove ROM from server, add drag-and-drop UI

**Files:**
- Delete: `web/static/rom/` (entire directory)
- Modify: `web/play.html`
- Modify: `web/static/play.js`
- Modify: `web/static/play.css`

- [ ] **Step 1: Delete ROM directory**

```bash
rm -rf web/static/rom/
```

- [ ] **Step 2: Update play.html — remove static EJS_gameUrl, add drop zone**

Replace the EmulatorJS config block:

```html
<!-- EmulatorJS — ROM supplied by user drag-and-drop -->
<div id="game"></div>
<script>
  var EJS_player     = '#game';
  var EJS_core       = 'n64';
  // EJS_gameUrl set by play.js when user drops a ROM file
  var EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
</script>
```

Add drop zone inside the overlay card, before the host-controls div:

```html
<div id="rom-drop" class="rom-drop">
  <p>Drop your ROM file here</p>
  <p class="rom-hint">.z64 / .n64 / .v64</p>
  <p id="rom-status" class="rom-status"></p>
</div>
```

- [ ] **Step 3: Add drop zone CSS**

Append to `play.css`:

```css
/* ROM drop zone */
.rom-drop {
  border: 2px dashed #333;
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
  margin-bottom: 1rem;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}

.rom-drop.dragover {
  border-color: #6af;
  background: rgba(102, 170, 255, 0.05);
}

.rom-drop.loaded {
  border-color: #4a4;
  background: rgba(68, 170, 68, 0.05);
}

.rom-hint {
  font-size: 12px;
  color: #555;
  margin-top: 4px;
}

.rom-status {
  font-size: 12px;
  color: #6af;
  margin-top: 8px;
}
```

- [ ] **Step 4: Add ROM handler in play.js**

Add a `_romBlobUrl` state variable and ROM handling functions:

```javascript
var _romBlobUrl = null;

function setupRomDrop() {
  var drop = document.getElementById('rom-drop');
  if (!drop) return;

  // Check localStorage for previously used ROM name
  var savedRom = localStorage.getItem('kaillera-rom-name');
  var statusEl = document.getElementById('rom-status');

  // File input fallback (click to browse)
  var fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.z64,.n64,.v64,.zip';
  fileInput.style.display = 'none';
  drop.appendChild(fileInput);

  drop.addEventListener('click', function () {
    if (!_romBlobUrl) fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    if (fileInput.files.length > 0) handleRomFile(fileInput.files[0]);
  });

  drop.addEventListener('dragover', function (e) {
    e.preventDefault();
    drop.classList.add('dragover');
  });

  drop.addEventListener('dragleave', function () {
    drop.classList.remove('dragover');
  });

  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleRomFile(e.dataTransfer.files[0]);
  });

  if (savedRom && statusEl) {
    statusEl.textContent = 'Last used: ' + savedRom + ' (drop new file to change)';
  }
}

function handleRomFile(file) {
  _romBlobUrl = URL.createObjectURL(file);
  window.EJS_gameUrl = _romBlobUrl;
  localStorage.setItem('kaillera-rom-name', file.name);

  var drop = document.getElementById('rom-drop');
  if (drop) drop.classList.add('loaded');
  var statusEl = document.getElementById('rom-status');
  if (statusEl) statusEl.textContent = 'Loaded: ' + file.name;
}
```

Call `setupRomDrop()` in the DOMContentLoaded handler.

Update `bootEmulator()` to only boot if a ROM is loaded:

```javascript
function bootEmulator() {
  if (window.EJS_emulator) return;
  if (!_romBlobUrl) {
    showToast('Please load a ROM file first');
    return;
  }
  window.EJS_gameUrl = _romBlobUrl;
  var script = document.createElement('script');
  script.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
  document.body.appendChild(script);
}
```

Update `startGame()` to check ROM is loaded before starting:

```javascript
function startGame() {
  if (!_romBlobUrl) {
    showToast('Load a ROM file before starting');
    return;
  }
  // ... existing code
}
```

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat: remove server-hosted ROM, add drag-and-drop ROM loading"
```

## Chunk 5: Dockerfile

### Task 10: Production Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create .dockerignore**

```
.git
.pytest_cache
__pycache__
*.pyc
docs/
tests/
*.cht
web/static/rom/
web/static/ejs/cores/*.backup
web/static/ejs/cores/*.forked
```

- [ ] **Step 2: Create Dockerfile**

```dockerfile
FROM python:3.13-slim

WORKDIR /app

# Install dependencies
COPY server/pyproject.toml server/
RUN pip install --no-cache-dir -e server/

# Copy application
COPY server/ server/
COPY web/ web/

# Default env
ENV ALLOWED_ORIGIN="*"

EXPOSE 8000

CMD ["python", "-c", "from src.main import run; run()"]
WORKDIR /app/server
```

- [ ] **Step 3: Commit**

```
git add Dockerfile .dockerignore
git commit -m "feat: add Dockerfile for production deployment"
```
