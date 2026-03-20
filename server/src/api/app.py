"""
FastAPI application — frontend WebSocket protocol + REST matchmaking API.

V1 endpoints:
  GET  /health
  GET  /list?game_id=...  EmulatorJS-Netplay room listing
  GET  /room/{room_id}    minimal room info (rate-limited)
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

from src.api.signaling import rooms


# ── App factory ───────────────────────────────────────────────────────────────

def create_app() -> FastAPI:
    """Create and return the FastAPI app."""
    app = FastAPI(title="kaillera-next")

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/room/{room_id}")
    def get_room(room_id: str, request: Request) -> dict:
        from src.ratelimit import check_ip
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
        }

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

    return app
