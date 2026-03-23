"""
FastAPI application — frontend WebSocket protocol + REST matchmaking API.

V1 endpoints:
  GET  /health
  GET  /list?game_id=...  EmulatorJS-Netplay room listing
  GET  /room/{room_id}    minimal room info (rate-limited)
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from src.api.signaling import rooms
from src.ratelimit import check_ip


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
        # Disable caching for dev — prevents stale JS/CSS in incognito sessions
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        return response


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
        import json, os
        custom = os.environ.get("ICE_SERVERS")
        if custom:
            try:
                return json.loads(custom)
            except json.JSONDecodeError:
                pass
        return [{"urls": "stun:stun.cloudflare.com:3478"}]

    @app.get("/room/{room_id}")
    def get_room(room_id: str, request: Request) -> dict:
        client_ip = request.headers.get(
            "x-forwarded-for",
            request.client.host if request.client else "unknown",
        ).split(",")[0].strip()
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
            "rom_hash": room.rom_hash,
            "rom_sharing": room.rom_sharing,
        }

    @app.get("/list")
    def list_rooms(game_id: str | None = None, request: Request = None) -> list:
        client_ip = request.headers.get(
            "x-forwarded-for",
            request.client.host if request.client else "unknown",
        ).split(",")[0].strip()
        if not check_ip(client_ip, "room-lookup"):
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

    return app
