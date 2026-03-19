"""
FastAPI application — frontend WebSocket protocol + REST matchmaking API.

V1 endpoints:
  GET  /health
  GET  /list?game_id=...  EmulatorJS-Netplay room listing
  POST /sessions          create session, pre-assign reg_ids
  GET  /sessions/{id}     inspect session state
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

from src.api.signaling import rooms
from src.session import SessionManager


# ── Request / response models ─────────────────────────────────────────────────

class CreateSessionRequest(BaseModel):
    player_count: int = Field(..., ge=1, le=4)


class PlayerInfo(BaseModel):
    slot: int
    reg_id: int


class SessionResponse(BaseModel):
    session_id: str
    players: list[PlayerInfo]


class PlayerDetail(BaseModel):
    slot: int
    reg_id: int
    registered: bool


class SessionDetail(BaseModel):
    session_id: str
    players: list[PlayerDetail]


# ── App factory ───────────────────────────────────────────────────────────────

def create_app(session_mgr: SessionManager) -> FastAPI:
    """Create and return the FastAPI app with session_mgr in scope."""
    app = FastAPI(title="kaillera-next")

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/room/{room_id}")
    def get_room(room_id: str) -> dict:
        room = rooms.get(room_id)
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")
        pid_to_slot = {pid: slot for slot, pid in room.slots.items()}
        return {
            "status": room.status,
            "mode": room.mode,
            "players": {
                pid: {"playerName": info["playerName"], "slot": pid_to_slot.get(pid)}
                for pid, info in room.players.items()
            },
            "spectators": {
                pid: {"playerName": info["playerName"]}
                for pid, info in room.spectators.items()
            },
        }

    @app.get("/list")
    def list_rooms(game_id: str | None = None) -> dict:
        result = {}
        for session_id, room in rooms.items():
            if game_id and room.game_id != game_id:
                continue
            first_player = next(iter(room.players.values()), {})
            result[session_id] = {
                "room_name": room.room_name,
                "current": len(room.players),
                "max": room.max_players,
                "player_name": first_player.get("playerName", ""),
                "hasPassword": room.password is not None,
            }
        return result

    @app.post("/sessions", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
    def create_session(body: CreateSessionRequest) -> SessionResponse:
        session_id = session_mgr.create_session()
        players = [
            PlayerInfo(slot=slot, reg_id=session_mgr.add_player(session_id, slot))
            for slot in range(body.player_count)
        ]
        return SessionResponse(session_id=session_id, players=players)

    @app.get("/sessions/{session_id}", response_model=SessionDetail)
    def get_session(session_id: str) -> SessionDetail:
        session = session_mgr.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="session not found")
        players = [
            PlayerDetail(slot=p.slot, reg_id=p.reg_id, registered=p.registered)
            for p in session.slots
            if p is not None
        ]
        return SessionDetail(session_id=session_id, players=players)

    return app
