"""
FastAPI application — frontend WebSocket protocol + REST matchmaking API.

V1 endpoints:
  GET  /health
  GET  /list?game_id=...  EmulatorJS-Netplay room listing
  GET  /room/{room_id}    minimal room info (rate-limited)
  POST /api/sync-logs     upload sync diagnostic logs

Admin endpoints (auth via ADMIN_KEY env var):
  GET    /admin/api/stats              server stats
  GET    /admin/api/logs               list sync log files
  GET    /admin/api/logs/{filename}    view log content
  POST   /admin/api/logs/{filename}/pin    pin log
  DELETE /admin/api/logs/{filename}/pin    unpin log
  DELETE /admin/api/logs/{filename}    delete log
  POST   /admin/api/cleanup            run manual log cleanup
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

from src.api.signaling import MAX_ROOMS, rooms
from src.ratelimit import check_ip

log = logging.getLogger(__name__)

_SYNC_LOG_DIR = Path(os.environ.get("SYNC_LOG_DIR", "logs/sync"))
_SYNC_LOG_MAX_SIZE = 5 * 1024 * 1024  # 5MB max per upload


def _pinned_set() -> set[str]:
    """Read pinned log filenames from disk."""
    pinned_file = _SYNC_LOG_DIR / ".pinned.json"
    if pinned_file.exists():
        try:
            return set(json.loads(pinned_file.read_text()))
        except (json.JSONDecodeError, TypeError):
            pass
    return set()


def _save_pinned(pinned: set[str]) -> None:
    """Write pinned log filenames to disk."""
    _SYNC_LOG_DIR.mkdir(parents=True, exist_ok=True)
    (_SYNC_LOG_DIR / ".pinned.json").write_text(json.dumps(sorted(pinned)))


async def cleanup_old_logs() -> None:
    """Background task: delete non-pinned logs older than LOG_RETENTION_DAYS.

    Also enforces a max file count (LOG_MAX_FILES, default 500) to prevent
    disk exhaustion from high-volume sessions.
    """
    while True:
        await asyncio.sleep(3600)
        try:
            retention = int(os.environ.get("LOG_RETENTION_DAYS", "14"))
            max_files = int(os.environ.get("LOG_MAX_FILES", "500"))
            if not _SYNC_LOG_DIR.exists():
                continue
            pinned = _pinned_set()
            cutoff = time.time() - (retention * 86400)
            cleaned = 0
            # Time-based: remove logs older than retention period
            for f in _SYNC_LOG_DIR.glob("sync-*.log"):
                if f.name in pinned:
                    continue
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    cleaned += 1
            # Count-based: if still over limit, remove oldest non-pinned first
            logs = sorted(_SYNC_LOG_DIR.glob("sync-*.log"), key=lambda f: f.stat().st_mtime)
            unpinned = [f for f in logs if f.name not in pinned]
            while len(logs) > max_files and unpinned:
                unpinned[0].unlink()
                unpinned.pop(0)
                logs = [f for f in logs if f.exists()]
                cleaned += 1
            if cleaned:
                log.info("Log cleanup: removed %d log(s)", cleaned)
        except Exception as e:
            log.warning("Log cleanup error: %s", e)


def _client_ip(request: Request) -> str:
    """Extract the real client IP from X-Forwarded-For or fall back to direct connection."""
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
        "style-src 'self' 'unsafe-inline'; "
        "connect-src 'self' wss: ws: blob:; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "worker-src 'self' blob:; "
        "font-src 'self' data:"
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
                    (b"cross-origin-opener-policy", b"same-origin"),
                    (b"cross-origin-embedder-policy", b"require-corp"),
                    (b"x-frame-options", b"SAMEORIGIN"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"strict-transport-security", b"max-age=63072000; includeSubDomains"),
                    (b"referrer-policy", b"strict-origin-when-cross-origin"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"cache-control", self._cache_control(path).encode()),
                ]
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
    app.add_middleware(SecurityHeadersMiddleware, allow_cache=production)

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/ice-servers")
    def ice_servers() -> list:
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

    @app.get("/api/cached-state/{rom_hash}")
    async def get_cached_state(rom_hash: str) -> Response:
        if rom_hash not in _state_cache:
            raise HTTPException(status_code=404, detail="No cached state")
        return Response(
            content=_state_cache[rom_hash],
            media_type="application/octet-stream",
        )

    _MAX_CACHE_ENTRIES = 50

    @app.post("/api/cache-state/{rom_hash}")
    async def cache_state(rom_hash: str, request: Request) -> dict:
        if not check_ip(_client_ip(request), "cache-state"):
            raise HTTPException(status_code=429, detail="Rate limited")
        body = await request.body()
        if len(body) > _STATE_MAX_SIZE:
            raise HTTPException(status_code=413, detail="State too large")
        if len(_state_cache) >= _MAX_CACHE_ENTRIES and rom_hash not in _state_cache:
            raise HTTPException(status_code=507, detail="Cache full")
        _state_cache[rom_hash] = body
        log.info("Cached save state for ROM %s (%d KB)", rom_hash[:16], len(body) // 1024)
        return {"status": "cached", "size": len(body)}

    # ── Sync log upload ────────────────────────────────────────────────────

    @app.post("/api/sync-logs")
    async def upload_sync_logs(request: Request) -> dict:
        if not check_ip(_client_ip(request), "sync-logs"):
            raise HTTPException(status_code=429, detail="Rate limited")
        body = await request.body()
        if len(body) > _SYNC_LOG_MAX_SIZE:
            raise HTTPException(status_code=413, detail="Log too large")
        if len(body) == 0:
            raise HTTPException(status_code=400, detail="Empty log")
        # Extract metadata from query params
        room = request.query_params.get("room", "unknown")[:32]
        slot = request.query_params.get("slot", "x")[:4]
        src = request.query_params.get("src", "")
        ts = int(time.time())
        # Sanitize room name for filename
        safe_room = "".join(c if c.isalnum() or c in "-_" else "_" for c in room)
        src_suffix = f"-{src}" if src in ("beacon", "recovery") else ""
        filename = f"sync-p{slot}-{safe_room}-{ts}{src_suffix}.log"
        _SYNC_LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = _SYNC_LOG_DIR / filename
        path.write_bytes(body)
        log.info("Sync log saved: %s (%d KB)", filename, len(body) // 1024)
        return {"status": "saved", "filename": filename, "size": len(body)}

    # ── Admin API ─────────────────────────────────────────────────────────

    def _admin_auth(request: Request) -> None:
        """Check admin key if ADMIN_KEY is set. Empty/unset = no auth required."""
        admin_key = os.environ.get("ADMIN_KEY")
        if not admin_key:
            return
        key = request.headers.get("x-admin-key") or request.query_params.get("key")
        if not key or not hmac.compare_digest(admin_key, key):
            raise HTTPException(status_code=401, detail="Invalid admin key")

    def _safe_log_filename(filename: str) -> Path:
        """Validate filename to prevent directory traversal."""
        if "/" in filename or "\\" in filename or ".." in filename:
            raise HTTPException(status_code=400, detail="Invalid filename")
        if not filename.startswith("sync-") or not filename.endswith(".log"):
            raise HTTPException(status_code=400, detail="Invalid log filename")
        path = _SYNC_LOG_DIR / filename
        if not path.exists():
            raise HTTPException(status_code=404, detail="Log not found")
        return path

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
            "max_rooms": MAX_ROOMS,
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
            parts = f.stem.split("-")
            slot = parts[1][1:] if len(parts) > 1 and parts[1].startswith("p") else "?"
            room_code = parts[2] if len(parts) > 2 else "?"
            src = parts[4] if len(parts) > 4 else "normal"
            result.append(
                {
                    "filename": f.name,
                    "size": stat.st_size,
                    "created": int(stat.st_mtime),
                    "slot": slot,
                    "room": room_code,
                    "source": src,
                    "pinned": f.name in pinned,
                }
            )
        return result

    @app.get("/admin/api/logs/{filename}")
    def admin_get_log(filename: str, request: Request) -> Response:
        _admin_auth(request)
        path = _safe_log_filename(filename)
        return Response(content=path.read_text(errors="replace"), media_type="text/plain")

    @app.post("/admin/api/logs/{filename}/pin")
    def admin_pin_log(filename: str, request: Request) -> dict:
        _admin_auth(request)
        _safe_log_filename(filename)
        pinned = _pinned_set()
        pinned.add(filename)
        _save_pinned(pinned)
        return {"status": "pinned"}

    @app.delete("/admin/api/logs/{filename}/pin")
    def admin_unpin_log(filename: str, request: Request) -> dict:
        _admin_auth(request)
        _safe_log_filename(filename)
        pinned = _pinned_set()
        pinned.discard(filename)
        _save_pinned(pinned)
        return {"status": "unpinned"}

    @app.delete("/admin/api/logs/{filename}")
    def admin_delete_log(filename: str, request: Request) -> dict:
        _admin_auth(request)
        path = _safe_log_filename(filename)
        pinned = _pinned_set()
        pinned.discard(filename)
        _save_pinned(pinned)
        path.unlink()
        return {"status": "deleted"}

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
        if deleted:
            log.info("Manual cleanup: removed %d expired log(s)", deleted)
        return {"deleted": deleted}

    return app
