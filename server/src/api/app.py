"""
FastAPI application — frontend WebSocket protocol + REST matchmaking API.

V1 endpoints:
  GET  /health
  GET  /list?game_id=...        EmulatorJS-Netplay room listing
  GET  /room/{room_id}          minimal room info (rate-limited)
  GET  /ice-servers             WebRTC ICE server config
  GET  /og-image/{room_id}.png  dynamic OG card image (Playwright screenshot)
  GET  /play.html               play page with injected OG meta tags
  GET  /                        homepage with injected OG meta tags
  GET  /api/cached-state/{h}    download cached save state
  POST /api/cache-state/{h}     upload save state to cache
  POST /api/client-event        submit client error/diagnostic event
  POST /api/feedback            submit user feedback

Admin endpoints (auth via ADMIN_KEY env var):
  GET  /admin/api/stats                    server stats (DB-backed counts)
  GET  /admin/api/session-logs             list session logs (filtered, paged)
  GET  /admin/api/session-logs/{id}        session log detail
  GET  /admin/api/client-events            list client events (filtered, paged)
  GET  /admin/api/client-events/{id}       client event detail
  GET  /admin/api/feedback                 list feedback entries
  GET  /admin/api/feedback/{id}            single feedback entry
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import subprocess as _sp
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse, Response

from src import db, state
from src.api.og import (
    _GAME_IMAGES_RAW,
    _ROM_SHARING_RAW,
    _inject_kn_config,
    build_og_tags,
    feature_enabled_for_host,
    generate_og_image,
    inject_og_tags,
)
from src.api.payloads import FeedbackPayload
from src.api.signaling import MAX_ROOMS, rooms, verify_upload_token
from src.ratelimit import check_ip, ip_hash

log = logging.getLogger(__name__)

_CLIENT_EVENT_MAX_SIZE = 4 * 1024  # 4KB max per event
_VALID_EVENT_TYPES = {
    "webrtc-fail",
    "wasm-fail",
    "desync",
    "stall",
    "reconnect",
    "audio-fail",
    "unhandled",
    "compat",
    "session-end",
}

_FEEDBACK_CONTEXT_MAX = 4096  # 4KB max for context JSON


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


def _client_ip(request: Request) -> str:
    """Extract the real client IP, checking Cloudflare headers first."""
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# In-memory save state cache: rom_hash -> raw state bytes.
# Eliminates host/guest asymmetry — all players load the same cached state.
# Persists across games but not server restarts.
_state_cache: dict[str, bytes] = {}
_STATE_MAX_SIZE = 20 * 1024 * 1024  # 20MB raw save state


# ── Security headers middleware ───────────────────────────────────────────────


class SecurityHeadersMiddleware:
    """Pure ASGI middleware that injects security and cache-control headers."""

    _CSP = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "connect-src 'self' blob:; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "worker-src 'self' blob:; "
        "font-src 'self' data: https://fonts.gstatic.com; "
        "object-src 'none'"
    )

    def __init__(self, app, allow_cache: bool = False) -> None:  # noqa: FBT001, FBT002
        self.app = app
        self._allow_cache = allow_cache

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Extract the request path for cache-control decisions.
        path: str = scope.get("path", "/")

        async def send_with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                extra: list[tuple[bytes, bytes]] = [
                    (b"content-security-policy", self._CSP.encode()),
                    (b"x-frame-options", b"SAMEORIGIN"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"strict-transport-security", b"max-age=63072000; includeSubDomains"),
                    (b"referrer-policy", b"strict-origin-when-cross-origin"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"cache-control", self._cache_control(path).encode()),
                ]
                # COOP/COEP breaks OG image fetches by crawlers
                if not path.startswith(("/og-image/", "/static/og/")):
                    extra.append((b"cross-origin-opener-policy", b"same-origin"))
                    extra.append((b"cross-origin-embedder-policy", b"require-corp"))
                message["headers"] = list(message.get("headers", [])) + extra
            await send(message)

        await self.app(scope, receive, send_with_headers)

    def _cache_control(self, path: str) -> str:
        if not self._allow_cache:
            return "no-store, no-cache, must-revalidate, max-age=0"
        # WASM core + data — versioned, cache aggressively (7 days)
        if path.startswith("/static/ejs/cores/"):
            return "public, max-age=604800, immutable"
        # JS/CSS — always revalidate via ETag (304 if unchanged)
        if path.endswith((".js", ".css")):
            return "no-cache"
        # HTML pages — always revalidate (ETag still avoids re-download)
        if path.endswith(".html") or path == "/":
            return "no-cache"
        # API responses and everything else
        return "no-store"


# ── Cache busting middleware ──────────────────────────────────────────────────


def _asset_version() -> str:
    """Derive a version string for cache busting static assets.

    Resolution order:
      1. GIT_VERSION env var (explicit override)
      2. git rev-parse --short HEAD (local dev with .git)
      3. SHA-256 of static JS/CSS file contents (Docker without .git)
      4. "dev" fallback
    """
    v = os.environ.get("GIT_VERSION", "").strip()
    if v:
        return v
    try:
        result = _sp.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=os.path.dirname(__file__),
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    # Hash static file contents — works in Docker without .git
    static_dir = os.path.join(os.path.dirname(__file__), "..", "..", "..", "web", "static")
    try:
        h = hashlib.sha256()
        for root, _, files in sorted(os.walk(static_dir)):
            for f in sorted(files):
                if f.endswith((".js", ".css")):
                    with open(os.path.join(root, f), "rb") as fh:
                        h.update(fh.read())
        return h.hexdigest()[:8]
    except Exception:
        pass
    return "dev"


class CacheBustMiddleware:
    """Appends ?v=<git-hash> to /static/ asset references in HTML responses."""

    _STATIC_REF = re.compile(rb'((?:src|href)=["\'])(/static/[^"\'?\s]+)(["\'])')

    def __init__(self, app, version: str) -> None:  # noqa: ANN001
        self.app = app
        self._version = version.encode()

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "/")
        if path.startswith(("/static/", "/api/", "/socket.io/", "/admin/api/", "/og-image/")):
            await self.app(scope, receive, send)
            return

        start_message = None
        body_chunks: list[bytes] = []
        is_html = False

        async def capture_send(message: dict) -> None:
            nonlocal start_message, is_html
            if message["type"] == "http.response.start":
                headers = dict(message.get("headers", []))
                is_html = b"text/html" in headers.get(b"content-type", b"")
                if is_html:
                    start_message = message
                else:
                    await send(message)
            elif message["type"] == "http.response.body":
                if not is_html:
                    await send(message)
                else:
                    body_chunks.append(message.get("body", b""))
                    if not message.get("more_body", False):
                        body = b"".join(body_chunks)
                        body = self._STATIC_REF.sub(
                            lambda m: m.group(1) + m.group(2) + b"?v=" + self._version + m.group(3),
                            body,
                        )
                        new_headers = [
                            (k, str(len(body)).encode()) if k == b"content-length" else (k, v)
                            for k, v in start_message.get("headers", [])
                        ]
                        start_message["headers"] = new_headers
                        await send(start_message)
                        await send({"type": "http.response.body", "body": body})

        await self.app(scope, receive, capture_send)


# ── Error page middleware ─────────────────────────────────────────────────────


class ErrorPageMiddleware:
    """ASGI middleware that serves custom HTML error pages for browser requests.

    Intercepts 404/500/429 responses for requests that accept text/html and
    are not on API paths. Injects the status code into the HTML template.
    """

    _API_PREFIXES = ("/api/", "/admin/api/", "/socket.io/", "/health", "/list", "/room/", "/ice-servers", "/og-image/")

    def __init__(self, app, error_html: str) -> None:  # noqa: ANN001
        self.app = app
        self._error_html = error_html

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")
        # Skip API paths — they return JSON
        if any(path.startswith(p) for p in self._API_PREFIXES):
            await self.app(scope, receive, send)
            return

        # Only intercept browser navigation (Accept: text/html)
        headers = dict(scope.get("headers", []))
        accept = headers.get(b"accept", b"").decode()
        if "text/html" not in accept:
            await self.app(scope, receive, send)
            return

        # Capture response; replace error status with custom page
        intercepted = False

        async def capture_send(message: dict) -> None:
            nonlocal intercepted
            if message["type"] == "http.response.start":
                status = message["status"]
                if status in (404, 500, 429):
                    intercepted = True
                    html = self._error_html.replace("{{CODE}}", str(status))
                    body = html.encode()
                    await send(
                        {
                            "type": "http.response.start",
                            "status": status,
                            "headers": [
                                (b"content-type", b"text/html; charset=utf-8"),
                                (b"content-length", str(len(body)).encode()),
                            ],
                        }
                    )
                    await send({"type": "http.response.body", "body": body})
                    return
                await send(message)
            elif message["type"] == "http.response.body":
                if not intercepted:
                    await send(message)

        await self.app(scope, receive, capture_send)


# ── App factory ───────────────────────────────────────────────────────────────


def create_app(lifespan=None) -> FastAPI:
    """Create and return the FastAPI app."""
    app = FastAPI(
        title="kaillera-next",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    production = os.environ.get("ALLOWED_ORIGIN", "*") != "*"
    version = _asset_version()
    app.add_middleware(CacheBustMiddleware, version=version)
    app.add_middleware(SecurityHeadersMiddleware, allow_cache=production)

    # Load error page template
    _error_html_path = Path(os.path.dirname(__file__)).parent.parent.parent / "web" / "error.html"
    if _error_html_path.exists():
        _error_html = _error_html_path.read_text()
        app.add_middleware(ErrorPageMiddleware, error_html=_error_html)
        log.info("Custom error pages loaded")
    else:
        log.warning("web/error.html not found — using default error responses")

    log.info("Cache bust version: %s", version)

    @app.get("/favicon.ico", include_in_schema=False)
    @app.get("/apple-touch-icon.png", include_in_schema=False)
    @app.get("/apple-touch-icon-precomposed.png", include_in_schema=False)
    async def favicon_redirect() -> RedirectResponse:
        return RedirectResponse(url="/static/favicon.svg", status_code=302)

    @app.get("/health")
    async def health() -> dict:
        redis_ok = await state.ping()
        return {
            "status": "ok" if redis_ok else "degraded",
            "redis": redis_ok,
            "rooms": len(rooms),
            "players": sum(len(r.players) for r in rooms.values()),
        }

    @app.get("/ice-servers")
    def ice_servers(request: Request) -> list:
        if not check_ip(_client_ip(request), "ice-servers"):
            raise HTTPException(status_code=429, detail="Rate limited")
        custom = os.environ.get("ICE_SERVERS")
        if custom:
            try:
                return json.loads(custom)
            except json.JSONDecodeError:
                log.warning("ICE_SERVERS env var contains invalid JSON, using default STUN server")
        return [{"urls": "stun:stun.cloudflare.com:3478"}]

    @app.get("/room/{room_id}")
    def get_room(room_id: str, request: Request) -> dict:
        if not check_ip(_client_ip(request), "room-lookup"):
            raise HTTPException(status_code=429, detail="Rate limited")
        room = rooms.get(room_id)
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")
        return {
            "status": room.status,
            "player_count": len(room.players),
            "max_players": room.max_players,
            "has_password": room.password is not None,
            "rom_hash": room.rom_hash,
            "rom_sharing": room.rom_sharing,
            "mode": room.mode,
        }

    @app.get("/list")
    def list_rooms(request: Request, game_id: str | None = None) -> list:
        if not check_ip(_client_ip(request), "room-lookup"):
            raise HTTPException(status_code=429, detail="Rate limited")
        result = []
        for room in rooms.values():
            if game_id and room.game_id != game_id:
                continue
            first_player = next(iter(room.players.values()), {})
            result.append(
                {
                    "room_name": room.room_name,
                    "host_name": first_player.get("playerName", ""),
                    "game_id": room.game_id,
                    "player_count": len(room.players),
                    "max_players": room.max_players,
                    "status": room.status,
                    "has_password": room.password is not None,
                }
            )
        return result

    _ROM_HASH_RE = re.compile(r"^[SF]?[0-9a-fA-F]{16,64}$")
    _MAX_CACHE_ENTRIES = 50

    def _validate_rom_hash(rom_hash: str) -> None:
        """Ensure rom_hash is a valid hex string, optionally prefixed with S (SHA-256) or F (FNV)."""
        if not _ROM_HASH_RE.match(rom_hash):
            raise HTTPException(status_code=400, detail="Invalid ROM hash format")

    def _rom_hash_in_active_room(rom_hash: str) -> bool:
        """Check if any active room references this ROM hash."""
        return any(r.rom_hash == rom_hash for r in rooms.values())

    @app.get("/api/cached-state/{rom_hash}")
    async def get_cached_state(rom_hash: str, request: Request) -> Response:
        if not check_ip(_client_ip(request), "cache-state"):
            raise HTTPException(status_code=429, detail="Rate limited")
        _validate_rom_hash(rom_hash)
        if rom_hash not in _state_cache:
            raise HTTPException(status_code=404, detail="No cached state")
        return Response(
            content=_state_cache[rom_hash],
            media_type="application/octet-stream",
        )

    @app.post("/api/cache-state/{rom_hash}")
    async def cache_state(rom_hash: str, request: Request) -> dict:
        if not check_ip(_client_ip(request), "cache-state"):
            raise HTTPException(status_code=429, detail="Rate limited")
        _validate_rom_hash(rom_hash)
        token = request.query_params.get("token", "")
        room_id = request.query_params.get("room", "")
        if not room_id or not verify_upload_token(room_id, token):
            raise HTTPException(status_code=403, detail="Invalid upload token")
        if not _rom_hash_in_active_room(rom_hash):
            raise HTTPException(status_code=403, detail="ROM hash not associated with any active room")
        body = await request.body()
        if len(body) > _STATE_MAX_SIZE:
            raise HTTPException(status_code=413, detail="State too large")
        if len(_state_cache) >= _MAX_CACHE_ENTRIES and rom_hash not in _state_cache:
            log.warning("State cache full (%d entries)", _MAX_CACHE_ENTRIES)
            raise HTTPException(status_code=507, detail="Cache full")
        _state_cache[rom_hash] = body
        log.info("Cached save state for ROM %s (%d KB)", rom_hash[:16], len(body) // 1024)
        return {"status": "cached", "size": len(body)}

    # ── Client event beacon ─────────────────────────────────────────────

    @app.post("/api/client-event")
    async def client_event(request: Request) -> dict:
        if not check_ip(_client_ip(request), "client-event"):
            raise HTTPException(status_code=429, detail="Rate limited")
        token = request.query_params.get("token", "")
        if not token or not any(verify_upload_token(sid, token) for sid in rooms):
            raise HTTPException(status_code=403, detail="Invalid token")
        body = await request.body()
        if len(body) > _CLIENT_EVENT_MAX_SIZE:
            raise HTTPException(status_code=413, detail="Event too large")
        if len(body) == 0:
            raise HTTPException(status_code=400, detail="Empty event")
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc
        evt_type = data.get("type", "")
        if evt_type not in _VALID_EVENT_TYPES:
            raise HTTPException(status_code=400, detail="Invalid event type")
        msg = str(data.get("msg", ""))[:500]
        meta = data.get("meta", {})
        if not isinstance(meta, dict) or len(json.dumps(meta)) > 2048:
            raise HTTPException(status_code=400, detail="Meta too large")
        room = str(data.get("room", ""))[:32]
        hashed_ip = ip_hash(_client_ip(request))
        row_id = await db.insert_client_event(
            {
                "type": evt_type,
                "message": msg,
                "meta": json.dumps(meta),
                "room": room,
                "slot": data.get("slot"),
                "ip_hash": hashed_ip,
                "user_agent": data.get("ua", ""),
            }
        )
        log.info("Client event: %s room=%s msg=%s id=%d", evt_type, room, msg[:100], row_id)
        return {"status": "saved", "id": row_id}

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
        hashed_ip = ip_hash(_client_ip(request))

        row_id = await db.insert_feedback(
            {
                "category": payload.category,
                "message": payload.message,
                "email": payload.email,
                "page": payload.page,
                "context": context_str,
                "ip_hash": hashed_ip,
            }
        )
        log.info("Feedback saved: id=%d category=%s page=%s", row_id, payload.category, payload.page)
        return {"status": "saved", "id": row_id}

    # ── Admin API ─────────────────────────────────────────────────────────

    def _admin_auth(request: Request) -> None:
        """Check admin key. ADMIN_KEY must be set — blocks all access if unset."""
        admin_key = os.environ.get("ADMIN_KEY")
        if not admin_key:
            raise HTTPException(status_code=403, detail="Admin access disabled (ADMIN_KEY not configured)")
        key = request.headers.get("x-admin-key")
        if not key or not hmac.compare_digest(admin_key, key):
            raise HTTPException(status_code=401, detail="Invalid admin key")

    @app.get("/admin/api/stats")
    async def admin_stats(request: Request) -> dict:
        _admin_auth(request)
        session_log_rows = await db.query("SELECT COUNT(*) as cnt FROM session_logs", ())
        client_event_rows = await db.query("SELECT COUNT(*) as cnt FROM client_events", ())
        feedback_rows = await db.query("SELECT COUNT(*) as cnt FROM feedback", ())
        return {
            "rooms": len(rooms),
            "max_rooms": MAX_ROOMS,
            "players": sum(len(r.players) for r in rooms.values()),
            "spectators": sum(len(r.spectators) for r in rooms.values()),
            "session_log_count": session_log_rows[0]["cnt"] if session_log_rows else 0,
            "client_event_count": client_event_rows[0]["cnt"] if client_event_rows else 0,
            "feedback_count": feedback_rows[0]["cnt"] if feedback_rows else 0,
            "retention_days": int(os.environ.get("LOG_RETENTION_DAYS", "14")),
        }

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

        params_with_paging = params + [limit, offset]
        entries = await db.query(
            f"SELECT id, match_id, room, slot, player_name, mode, summary, ended_by, created_at, updated_at FROM session_logs WHERE {where} ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            tuple(params_with_paging),
        )
        for entry in entries:
            if entry.get("summary") and isinstance(entry["summary"], str):
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    entry["summary"] = json.loads(entry["summary"])
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
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    entry[field] = json.loads(entry[field])
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
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    entry["meta"] = json.loads(entry["meta"])
        return {"total": total, "entries": entries}

    @app.get("/admin/api/client-events/{event_id}")
    async def admin_client_event_detail(request: Request, event_id: int) -> dict:
        _admin_auth(request)
        rows = await db.query("SELECT * FROM client_events WHERE id = ?", (event_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Client event not found")
        entry = rows[0]
        if entry.get("meta") and isinstance(entry["meta"], str):
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                entry["meta"] = json.loads(entry["meta"])
        return entry

    # ── Admin feedback API ───────────────────────────────────────────────

    @app.get("/admin/api/feedback")
    async def admin_feedback_list(request: Request) -> dict:
        _admin_auth(request)
        category = request.query_params.get("category")
        days = int(request.query_params.get("days", "30"))
        limit = min(int(request.query_params.get("limit", "50")), 200)
        offset = int(request.query_params.get("offset", "0"))

        conditions = ["created_at > datetime('now', ?)"]
        params: list = [f"-{days} days"]

        if category and category in ("bug", "feature", "general"):
            conditions.append("category = ?")
            params.append(category)

        where = " AND ".join(conditions)

        total_rows = await db.query(f"SELECT COUNT(*) as cnt FROM feedback WHERE {where}", tuple(params))
        total = total_rows[0]["cnt"] if total_rows else 0

        params_with_paging = params + [limit, offset]
        entries = await db.query(
            f"SELECT * FROM feedback WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            tuple(params_with_paging),
        )
        # Parse context JSON strings back to dicts for the response
        for entry in entries:
            if entry.get("context") and isinstance(entry["context"], str):
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    entry["context"] = json.loads(entry["context"])
        return {"total": total, "entries": entries}

    @app.get("/admin/api/feedback/{feedback_id}")
    async def admin_feedback_single(request: Request, feedback_id: int) -> dict:
        _admin_auth(request)
        rows = await db.query("SELECT * FROM feedback WHERE id = ?", (feedback_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Feedback not found")
        entry = rows[0]
        if entry.get("context") and isinstance(entry["context"], str):
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                entry["context"] = json.loads(entry["context"])
        return entry

    # ── OG card routes ────────────────────────────────────────────────────

    _web_dir = Path(os.path.dirname(__file__)).parent.parent.parent / "web"
    _play_html: str | None = None
    _index_html: str | None = None

    def _get_play_html() -> str:
        nonlocal _play_html
        if _play_html is None:
            _play_html = (_web_dir / "play.html").read_text()
        return _play_html

    def _get_index_html() -> str:
        nonlocal _index_html
        if _index_html is None:
            _index_html = (_web_dir / "index.html").read_text()
        return _index_html

    def _owner_name(room) -> str:  # noqa: ANN001
        """Get room owner's display name."""
        for p in room.players.values():
            if p.get("socketId") == room.owner:
                return p.get("playerName", room.room_name)
        return room.room_name

    def _player_names(room) -> list[str]:  # noqa: ANN001
        """Get list of player display names in the room."""
        return [p.get("playerName", "?") for p in room.players.values()]

    _fallback_png = _web_dir / "static" / "og" / "fallback.png"

    @app.get("/og-image/{room_id}.png")
    async def og_image(room_id: str, request: Request) -> Response:
        try:
            room = rooms.get(room_id)
            spectate = request.query_params.get("spectate") == "1"
            game_hint = request.query_params.get("game")  # fallback from URL param
            game_images = feature_enabled_for_host(_GAME_IMAGES_RAW, request.headers.get("host", ""))
            if room:
                names = _player_names(room) if spectate else None
                game_id = room.game_id or game_hint
                img = await generate_og_image(
                    _owner_name(room), game_id, spectate, player_names=names, game_images_enabled=game_images
                )
            else:
                img = await generate_og_image(room_id, game_hint, spectate, game_images_enabled=game_images)
        except Exception:
            log.warning("OG image generation failed for room %s", room_id, exc_info=True)
            if _fallback_png.exists():
                img = _fallback_png.read_bytes()
            else:
                log.warning("OG fallback image missing at %s", _fallback_png)
                raise HTTPException(status_code=500, detail="OG image unavailable") from None
        return Response(
            content=img,
            media_type="image/png",
            headers={"cache-control": "public, max-age=300"},
        )

    @app.get("/play.html")
    def play_page(request: Request) -> Response:
        room_id = request.query_params.get("room")
        spectate = request.query_params.get("spectate") == "1"
        host = request.headers.get("host", "localhost")
        game_hint = request.query_params.get("game")
        room = rooms.get(room_id) if room_id else None
        if room:
            game_id = room.game_id or game_hint
            tags = build_og_tags(host, room_id, _owner_name(room), game_id, spectate)
        elif room_id:
            tags = build_og_tags(host, room_id, room_id, game_hint, spectate)
        else:
            tags = build_og_tags(host)
        html = inject_og_tags(_get_play_html(), tags)
        html = _inject_kn_config(html, rom_sharing_enabled=feature_enabled_for_host(_ROM_SHARING_RAW, host))
        return Response(content=html, media_type="text/html")

    @app.get("/")
    def index_page(request: Request) -> Response:
        host = request.headers.get("host", "localhost")
        tags = build_og_tags(host)
        html = inject_og_tags(_get_index_html(), tags)
        return Response(content=html, media_type="text/html")

    return app
