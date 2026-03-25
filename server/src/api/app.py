"""
FastAPI application — frontend WebSocket protocol + REST matchmaking API.

V1 endpoints:
  GET  /health
  GET  /list?game_id=...  EmulatorJS-Netplay room listing
  GET  /room/{room_id}    minimal room info (rate-limited)
  POST /api/sync-logs     upload sync diagnostic logs
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from src.api.signaling import rooms
from src.ratelimit import check_ip

log = logging.getLogger(__name__)


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

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:  # type: ignore[override]
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' https://cdn.emulatorjs.org https://cdn.socket.io 'unsafe-eval' 'unsafe-inline' blob:; "
            "style-src 'self' 'unsafe-inline' https://cdn.emulatorjs.org; "
            "connect-src 'self' wss: ws: https://cdn.emulatorjs.org https://cdn.socket.io blob:; "
            "img-src 'self' data: blob:; "
            "media-src 'self' blob:; "
            "worker-src 'self' blob: https://cdn.emulatorjs.org; "
            "font-src 'self' https://cdn.emulatorjs.org data:"
        )
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Cache-Control"] = self._cache_control(request.url.path)
        return response

    @staticmethod
    def _cache_control(path: str) -> str:
        production = os.environ.get("ALLOWED_ORIGIN", "*") != "*"
        if not production:
            return "no-store, no-cache, must-revalidate, max-age=0"
        # WASM core + data — versioned, cache aggressively (7 days)
        if path.startswith("/static/ejs/cores/"):
            return "public, max-age=604800, immutable"
        # JS/CSS — cache 1 hour, revalidate via ETag after that
        if path.endswith((".js", ".css")):
            return "public, max-age=3600, must-revalidate"
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
    app.add_middleware(SecurityHeadersMiddleware)

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
                pass
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
    _SYNC_LOG_DIR = Path(os.environ.get("SYNC_LOG_DIR", "logs/sync"))
    _SYNC_LOG_MAX_SIZE = 5 * 1024 * 1024  # 5MB max per upload

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
        ts = int(time.time())
        # Sanitize room name for filename
        safe_room = "".join(c if c.isalnum() or c in "-_" else "_" for c in room)
        filename = f"sync-p{slot}-{safe_room}-{ts}.log"
        _SYNC_LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = _SYNC_LOG_DIR / filename
        path.write_bytes(body)
        log.info("Sync log saved: %s (%d KB)", filename, len(body) // 1024)
        return {"status": "saved", "filename": filename, "size": len(body)}

    return app
